import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { renderToStaticMarkup } from "react-dom/server";
import { afterAll, afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { ServerRuntimeView, type ServerRuntimeData } from "@/components/server-runtime-panel";
import { AgentRunManager, AGENT_ROUTING_VERSION } from "@/server/agent/manager";
import { __setAgentManagerForTests, getAgentManager } from "@/server/agent/runtime";
import { MemoryAgentStore } from "@/server/agent/store";
import { __setConfigForTests, getConfig } from "@/server/config/env";
import { configFingerprint } from "@/server/config/fingerprint";
import { MockDiagnosticLLMProvider } from "@/server/diagnostics/llm";
import { buildService, getService, __setServiceForTests } from "@/server/liara/service";
import { __resetApiLimiterForTests } from "@/server/security/guard";
import { __clearSessionsForTests, createSession } from "@/server/security/session";
import { runtimeUi } from "@/i18n/agent-fa";
import { FAKE_KEY, MODEL } from "../helpers/boxapi";
import { NOW } from "../helpers/evidence-builder";
import { LIVE_ENV, makeConfig, resetAll } from "../helpers/live";

import * as runtimeRoute from "@/app/api/agent/runtime/route";

vi.mock("next/navigation", () => ({ useRouter: () => ({ push: () => undefined, refresh: () => undefined }) }));

const dir = mkdtempSync(path.join(tmpdir(), "rt-check-"));
afterAll(() => rmSync(dir, { recursive: true, force: true }));
const DB = { DIAGNOSTICS_DB_PATH: path.join(dir, "d.sqlite") };
const ORIGIN = "http://localhost:3000";
beforeEach(() => {
  __clearSessionsForTests();
  __resetApiLimiterForTests();
});
afterEach(() => {
  __setAgentManagerForTests(undefined);
  __setServiceForTests(undefined);
  resetAll();
});

const cfgLive = (extra: Record<string, string> = {}) => makeConfig({ ...LIVE_ENV, LIARA_ALLOWED_APPS: "liara-agent-demo", ...DB, ...extra });
const get = (cookie: string) => runtimeRoute.GET(new Request(`${ORIGIN}/api/agent/runtime`, { headers: { cookie } }));

describe("GET /api/agent/runtime — what the RUNNING process uses (read-only, no secrets, no network)", () => {
  it("requires a login", async () => {
    expect((await get("")).status).toBe(401);
  });
  it("live data source + the liara-agent-demo allowlist are reported as applied, and the object answering /agent really uses them", async () => {
    const cfg = cfgLive();
    __setConfigForTests(cfg);
    const m = new AgentRunManager({ svc: buildService(cfg, { now: () => NOW }), store: new MemoryAgentStore(), provider: new MockDiagnosticLLMProvider("ok"), now: () => NOW });
    __setAgentManagerForTests(m);
    const s = createSession();
    const r = await get(`liara_agent_session=${s.id}`);
    expect(r.status).toBe(200);
    const b = (await r.json()) as ServerRuntimeData;
    expect(b.config).toMatchObject({ dataSource: "live", allowedApps: ["liara-agent-demo"], liveDeploy: false, tokenPresent: true });
    expect(b.manager).toMatchObject({ dataMode: "live", allowed: ["liara-agent-demo"] });
    expect(b.routing).toBe(AGENT_ROUTING_VERSION);
    expect(b.consistent).toBe(true);
    expect(b.problems).toEqual([]);
  });
  it("a server whose answering object does NOT match the configuration is flagged (data source, allowlist, AI provider) instead of silently answering from a stale setup", async () => {
    __setConfigForTests(cfgLive({ AI_PROVIDER: "boxapi", AI_LIVE_REQUESTS_ENABLED: "true", BOXAPI_MODEL: MODEL, BOXAPI_API_KEY: FAKE_KEY }));
    // the answering object is a leftover: simulated data, no allowlist match, offline provider
    const stale = new AgentRunManager({ svc: buildService(makeConfig({ ...DB }), { now: () => NOW }), store: new MemoryAgentStore(), provider: new MockDiagnosticLLMProvider("ok"), now: () => NOW });
    __setAgentManagerForTests(stale);
    const s = createSession();
    const b = (await (await get(`liara_agent_session=${s.id}`)).json()) as ServerRuntimeData;
    expect(b.consistent).toBe(false);
    expect(b.problems).toEqual(expect.arrayContaining(["data_source_mismatch", "ai_provider_mismatch"]));
  });
  it("never contains a secret: the key and the token appear only as present/absent", async () => {
    const cfg = cfgLive({ AI_PROVIDER: "boxapi", AI_LIVE_REQUESTS_ENABLED: "true", BOXAPI_MODEL: MODEL, BOXAPI_API_KEY: FAKE_KEY });
    __setConfigForTests(cfg);
    __setAgentManagerForTests(new AgentRunManager({ svc: buildService(cfg, { now: () => NOW }), store: new MemoryAgentStore(), provider: new MockDiagnosticLLMProvider("ok"), now: () => NOW }));
    const s = createSession();
    const text = await (await get(`liara_agent_session=${s.id}`)).text();
    expect(text).not.toContain(FAKE_KEY);
    expect(text).not.toContain(cfg.liara.token!.reveal());
    expect(JSON.parse(text).config.ai).toMatchObject({ keyPresent: true, model: MODEL });
  });
});

describe("the view operators read", () => {
  const data = (over: Partial<ServerRuntimeData> = {}): ServerRuntimeData => ({
    process: { startedAt: "2026-01-02T03:00:00.000Z" }, routing: AGENT_ROUTING_VERSION,
    manager: { createdAt: "2026-01-02T03:00:01.000Z", dataMode: "live", provider: { kind: "live", id: `boxapi:${MODEL}`, model: MODEL }, allowed: ["liara-agent-demo"] },
    config: { dataSource: "live", allowedApps: ["liara-agent-demo"], liveDeploy: false, tokenPresent: true, ai: { provider: "boxapi", liveRequests: true, model: MODEL, keyPresent: true, maxOutputTokens: 600, maxTotalRequests: 1 } },
    consistent: true, problems: [], ...over,
  });
  it("shows the data source, the allowlist, the AI model/cap and the routing version — consistent", () => {
    const out = renderToStaticMarkup(<ServerRuntimeView data={data()} />);
    expect(out).toContain('data-consistent="true"');
    expect(out).toContain('data-source="live"');
    expect(out).toContain("liara-agent-demo");
    expect(out).toContain(MODEL);
    expect(out).toContain(AGENT_ROUTING_VERSION);
    expect(out).toContain(runtimeUi.ok);
    expect(out).not.toContain(FAKE_KEY);
  });
  it("an inconsistent server is an alert that says to restart", () => {
    const out = renderToStaticMarkup(<ServerRuntimeView data={data({ consistent: false, problems: ["stale_code", "data_source_mismatch"] })} />);
    expect(out).toContain('role="alert"');
    expect(out).toContain(runtimeUi.problems.stale_code);
    expect(out).toContain(runtimeUi.problems.data_source_mismatch);
  });
});

describe("a long-running server never keeps the OLD setup: singletons follow the configuration and the code", () => {
  it("configFingerprint changes with data source, allowlist, token, model and key — and is not reversible to them", () => {
    const base = configFingerprint(cfgLive());
    expect(configFingerprint(cfgLive())).toBe(base);
    for (const [name, c] of [
      ["data source", makeConfig({ ...DB, LIARA_ALLOWED_APPS: "liara-agent-demo" })],
      ["allowlist", cfgLive({ LIARA_ALLOWED_APPS: "liara-agent-demo,shop-api" })],
      ["token", cfgLive({ LIARA_API_TOKEN: "another-token-value-1234567890" })],
      ["model", cfgLive({ AI_PROVIDER: "boxapi", AI_LIVE_REQUESTS_ENABLED: "true", BOXAPI_MODEL: MODEL })],
      ["cap", cfgLive({ AI_PROVIDER: "boxapi", AI_LIVE_REQUESTS_ENABLED: "true", BOXAPI_MODEL: MODEL, BOXAPI_MAX_REQUESTS_TOTAL: "1" })],
    ] as const) expect(configFingerprint(c), name).not.toBe(base);
    expect(base).toMatch(/^[0-9a-f]{16}$/);
  });
  it("getService() and getAgentManager() are reused while the configuration is unchanged and REBUILT when it changes", () => {
    __setConfigForTests(cfgLive());
    const s1 = getService();
    const m1 = getAgentManager();
    expect(getService()).toBe(s1);
    expect(getAgentManager()).toBe(m1);
    expect(getAgentManager().runtimeInfo(["liara-agent-demo"])).toMatchObject({ dataMode: "live", allowed: ["liara-agent-demo"] });
    __setConfigForTests(makeConfig({ ...DB })); // e.g. .env.local edited to the simulated data source
    expect(getService()).not.toBe(s1);
    const m2 = getAgentManager();
    expect(m2).not.toBe(m1);
    expect(m2.runtimeInfo([])).toMatchObject({ dataMode: "mock" });
  });
  it("in development getConfig() notices an edited environment (production reads it once)", () => {
    const saved = { p: process.env.AI_PROVIDER, o: process.env.AI_LIVE_REQUESTS_ENABLED };
    try {
      __setConfigForTests(undefined);
      process.env.AI_PROVIDER = "disabled";
      expect(getConfig().ai.provider).toBe("disabled");
      process.env.AI_PROVIDER = "mock";
      expect(getConfig().ai.provider).toBe("mock");
    } finally {
      if (saved.p === undefined) delete process.env.AI_PROVIDER;
      else process.env.AI_PROVIDER = saved.p;
      if (saved.o === undefined) delete process.env.AI_LIVE_REQUESTS_ENABLED;
      else process.env.AI_LIVE_REQUESTS_ENABLED = saved.o;
      __setConfigForTests(undefined);
    }
  });
});
