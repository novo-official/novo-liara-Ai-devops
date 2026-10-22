import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { AgentRunManager } from "@/server/agent/manager";
import { __setAgentManagerForTests } from "@/server/agent/runtime";
import { MemoryAgentStore } from "@/server/agent/store";
import { MockDiagnosticLLMProvider } from "@/server/diagnostics/llm";
import { buildService } from "@/server/liara/service";
import { __resetApiLimiterForTests } from "@/server/security/guard";
import { __clearSessionsForTests, createSession } from "@/server/security/session";
import { NOW } from "../helpers/evidence-builder";
import { installService, makeConfig, resetAll } from "../helpers/live";
import { SimulatedExecutionBackend } from "@/server/agent/simulation/backend";

import * as messages from "@/app/api/agent/messages/route";
import * as conversation from "@/app/api/agent/conversations/[id]/route";
import * as runRoute from "@/app/api/agent/runs/[id]/route";
import * as cancelRoute from "@/app/api/agent/runs/[id]/cancel/route";
import * as retryRoute from "@/app/api/agent/runs/[id]/retry/route";
import * as decision from "@/app/api/agent/proposals/[id]/decision/route";

const ORIGIN = "http://localhost:3000";
beforeEach(() => {
  __clearSessionsForTests();
  __resetApiLimiterForTests();
});
afterEach(() => {
  __setAgentManagerForTests(undefined);
  resetAll();
});

function setup() {
  const cfg = makeConfig();
  const svc = buildService(cfg, { now: () => NOW });
  installService(cfg, svc);
  const calls: string[] = [];
  const backend = new SimulatedExecutionBackend();
  const spy = { kind: "simulation" as const, execute: async (...a: Parameters<typeof backend.execute>) => (calls.push(a[0].id), backend.execute(...a)) };
  const m = new AgentRunManager({ svc, store: new MemoryAgentStore(), provider: new MockDiagnosticLLMProvider("ok"), now: () => NOW, runTimeoutMs: 8000, quotaPerWindow: 99, backend: spy });
  __setAgentManagerForTests(m);
  const user = () => {
    const s = createSession();
    const cookie = `liara_agent_session=${s.id}`;
    const hdr = (h: Record<string, string> = {}) => ({ cookie, origin: ORIGIN, "content-type": "application/json", ...h });
    const post = (r: typeof messages, url: string, body: unknown, h: Record<string, string> = {}, ctx?: { id: string }) =>
      (r.POST as (req: Request, c?: unknown) => Promise<Response>)(new Request(`${ORIGIN}${url}`, { method: "POST", headers: hdr(h), body: typeof body === "string" ? body : JSON.stringify(body) }), ctx ? { params: Promise.resolve(ctx) } : undefined);
    return {
      cookie,
      say: (text: string, conversationId?: string, h: Record<string, string> = {}) => post(messages, "/api/agent/messages", { text, ...(conversationId ? { conversationId } : {}) }, h),
      conv: (id: string) => conversation.GET(new Request(`${ORIGIN}/api/agent/conversations/${id}`, { headers: { cookie } }), { params: Promise.resolve({ id }) }),
      run: (id: string) => runRoute.GET(new Request(`${ORIGIN}/api/agent/runs/${id}`, { headers: { cookie } }), { params: Promise.resolve({ id }) }),
      cancel: (id: string, h: Record<string, string> = {}) => post(cancelRoute as unknown as typeof messages, `/api/agent/runs/${id}/cancel`, {}, h, { id }),
      retry: (id: string) => post(retryRoute as unknown as typeof messages, `/api/agent/runs/${id}/retry`, {}, {}, { id }),
      decide: (id: string, body: unknown, h: Record<string, string> = {}) => post(decision as unknown as typeof messages, `/api/agent/proposals/${id}/decision`, body, h, { id }),
    };
  };
  return { m, user, calls };
}
const body = async (r: Response) => JSON.parse(await r.text());

describe("agent routes — authentication, CSRF and validation", () => {
  it("every route rejects unauthenticated requests", async () => {
    setup();
    const id = "conv_20260102040000_aabbccdd";
    const rs = [
      await messages.POST(new Request(`${ORIGIN}/api/agent/messages`, { method: "POST", headers: { origin: ORIGIN, "content-type": "application/json" }, body: JSON.stringify({ text: "x" }) })),
      await conversation.GET(new Request(`${ORIGIN}/api/agent/conversations/${id}`), { params: Promise.resolve({ id }) }),
      await runRoute.GET(new Request(`${ORIGIN}/api/agent/runs/${id}`), { params: Promise.resolve({ id }) }),
      await cancelRoute.POST(new Request(`${ORIGIN}/api/agent/runs/${id}/cancel`, { method: "POST", headers: { origin: ORIGIN, "content-type": "application/json" }, body: "{}" }), { params: Promise.resolve({ id }) }),
      await retryRoute.POST(new Request(`${ORIGIN}/api/agent/runs/${id}/retry`, { method: "POST", headers: { origin: ORIGIN, "content-type": "application/json" }, body: "{}" }), { params: Promise.resolve({ id }) }),
      await decision.POST(new Request(`${ORIGIN}/api/agent/proposals/${id}/decision`, { method: "POST", headers: { origin: ORIGIN, "content-type": "application/json" }, body: "{}" }), { params: Promise.resolve({ id }) }),
    ];
    for (const r of rs) expect(r.status).toBe(401);
  });
  it("state-changing routes enforce same-origin JSON", async () => {
    const { user } = setup();
    const u = user();
    expect((await u.say("سلام", undefined, { origin: "https://evil.example" })).status).toBe(403);
    expect((await u.say("سلام", undefined, { "content-type": "text/plain" })).status).toBeGreaterThanOrEqual(400);
    expect((await u.decide("prop_20260102040000_aabbccdd", { decision: "approve", digest: "a".repeat(64) }, { origin: "https://evil.example" })).status).toBe(403);
  });
  it("message body is strict: unknown keys, wrong types, empty or oversized text and bad ids are 400", async () => {
    setup();
    for (const b of [{ text: "x", approved: true }, { text: 5 }, { text: "" }, { text: "ا".repeat(501) }, { text: "x", conversationId: "../etc/passwd" }, {}, "not json", "[]"]) {
      const res = await (async () => {
        const s = createSession();
        return messages.POST(new Request(`${ORIGIN}/api/agent/messages`, { method: "POST", headers: { cookie: `liara_agent_session=${s.id}`, origin: ORIGIN, "content-type": "application/json" }, body: typeof b === "string" ? b : JSON.stringify(b) }));
      })();
      expect(res.status, JSON.stringify(b)).toBe(400);
    }
  });
  it("decision body is strict — a client 'approved: true' flag is rejected, never honoured", async () => {
    const { user, calls, m } = setup();
    const u = user();
    const r = await body(await u.say("چرا demo-api مدام ری‌استارت می‌شود؟"));
    await m.waitFor(r.runId);
    const s = await body(await u.say("یک طرح اصلاحی شبیه‌سازی‌شده بساز", r.conversationId));
    const pid = s.proposalId as string;
    expect(pid).toMatch(/^prop_/);
    for (const b of [{ approved: true }, { decision: "approve" }, { decision: "approve", approved: true, digest: "a".repeat(64) }, { decision: "approve", digest: "short" }, { decision: "yes", digest: "a".repeat(64) }, { digest: "a".repeat(64) }]) {
      expect((await u.decide(pid, b)).status, JSON.stringify(b)).toBe(400);
    }
    expect(calls).toHaveLength(0);
  });
});

describe("agent routes — full flow over HTTP", () => {
  it("message → run → proposal → approve → simulated result; other users are blocked", async () => {
    const { user, calls, m } = setup();
    const u = user();
    const other = user();
    const r1 = await body(await u.say("چرا demo-api مدام ری‌استارت می‌شود؟"));
    expect(r1.runId).toMatch(/^arun_/);
    await m.waitFor(r1.runId);
    const s = await body(await u.say("یک طرح اصلاحی شبیه‌سازی‌شده بساز", r1.conversationId));
    const pid = s.proposalId as string;

    // other session: no read, no cancel, no decision
    expect((await other.conv(r1.conversationId)).status).toBe(404);
    expect((await other.run(r1.runId)).status).toBe(404);
    expect((await other.cancel(r1.runId)).status).toBe(404);
    const view = await body(await u.conv(r1.conversationId));
    const digest = view.proposals[0].proposal.digest as string;
    expect((await other.decide(pid, { decision: "approve", digest })).status).toBe(404);
    expect(calls).toHaveLength(0);

    const bad = await u.decide(pid, { decision: "approve", digest: "0".repeat(64) });
    expect(bad.status).toBe(409);
    expect(calls).toHaveLength(0);

    const ok = await u.decide(pid, { decision: "approve", digest });
    expect(ok.status).toBe(200);
    const done = await body(ok);
    expect(done.proposal.status).toBe("SIMULATED_OK");
    expect(done.result.simulated).toBe(true);
    expect(calls).toHaveLength(1);

    const replay = await u.decide(pid, { decision: "approve", digest });
    expect(replay.status).toBe(409);
    expect((await body(replay)).error.code).toBe("already_decided");
    expect(calls).toHaveLength(1);
  });
  it("malformed ids on path parameters are 404 and never reach the manager", async () => {
    const { user } = setup();
    const u = user();
    for (const id of ["x", "../..", "conv_1", "%00", "a".repeat(300)]) {
      expect((await u.conv(id)).status).toBe(404);
      expect((await u.run(id)).status).toBe(404);
      expect((await u.decide(id, { decision: "reject", digest: "a".repeat(64) })).status).toBe(404);
    }
  });
  it("error responses are localized Persian JSON with stable codes and no stack traces", async () => {
    const { user } = setup();
    const u = user();
    const r = await u.decide("prop_20260102040000_aabbccdd", { decision: "approve", digest: "a".repeat(64) });
    const j = await body(r);
    expect(r.status).toBe(404);
    expect(j.error.code).toBe("not_found");
    expect(JSON.stringify(j)).not.toMatch(/at \w+ \(|node_modules|\.ts:\d+/);
  });
  it("responses are never cacheable", async () => {
    const { user } = setup();
    const u = user();
    const r = await u.say("سلام");
    expect(r.headers.get("cache-control")).toMatch(/no-store/);
  });
});
