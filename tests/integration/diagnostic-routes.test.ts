import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { __setConfigForTests } from "@/server/config/env";
import { MockDiagnosticLLMProvider } from "@/server/diagnostics/llm";
import { __setRunManagerForTests } from "@/server/diagnostics/runtime";
import { MemoryRunStore } from "@/server/diagnostics/store";
import { DiagnosticRunManager } from "@/server/diagnostics/workflow";
import { __resetApiLimiterForTests } from "@/server/security/guard";
import { __clearSessionsForTests, createSession } from "@/server/security/session";
import { buildService } from "@/server/liara/service";
import { assertNoCanary } from "../helpers/canaries";
import { NOW } from "../helpers/evidence-builder";
import { defaultResponder, installService, liveService, makeConfig, resetAll } from "../helpers/live";

import * as runsRoute from "@/app/api/diagnostic-runs/route";
import * as runRoute from "@/app/api/diagnostic-runs/[id]/route";
import * as cancelRoute from "@/app/api/diagnostic-runs/[id]/cancel/route";

const ORIGIN = "http://localhost:3000";
beforeEach(() => {
  __clearSessionsForTests();
  __resetApiLimiterForTests();
});
afterEach(() => {
  __setRunManagerForTests(undefined);
  resetAll();
});

function setup(opts: { live?: ReturnType<typeof liveService>; hold?: Promise<void> } = {}) {
  const cfg = opts.live?.cfg ?? makeConfig();
  const svc = opts.live?.svc ?? buildService(cfg, { now: () => NOW });
  installService(cfg, svc);
  const m = new DiagnosticRunManager({ svc, store: new MemoryRunStore(), provider: new MockDiagnosticLLMProvider("ok"), now: () => NOW, runTimeoutMs: 5000, quotaPerWindow: 50, hooks: opts.hold ? { afterCollect: async () => { await opts.hold; } } : undefined });
  __setRunManagerForTests(m);
  const mk = () => {
    const session = createSession();
    const cookie = `liara_agent_session=${session.id}`;
    const post = (body: unknown, h: Record<string, string> = {}) =>
      runsRoute.POST(new Request(`${ORIGIN}/api/diagnostic-runs`, { method: "POST", headers: { cookie, origin: ORIGIN, "content-type": "application/json", ...h }, body: typeof body === "string" ? body : JSON.stringify(body) }));
    const get = (id: string) => runRoute.GET(new Request(`${ORIGIN}/api/diagnostic-runs/${id}`, { headers: { cookie } }), { params: Promise.resolve({ id }) });
    const cancel = (id: string, h: Record<string, string> = {}) => cancelRoute.POST(new Request(`${ORIGIN}/api/diagnostic-runs/${id}/cancel`, { method: "POST", headers: { cookie, origin: ORIGIN, "content-type": "application/json", ...h }, body: "{}" }), { params: Promise.resolve({ id }) });
    const list = () => runsRoute.GET(new Request(`${ORIGIN}/api/diagnostic-runs`, { headers: { cookie } }));
    return { session, cookie, post, get, cancel, list };
  };
  return { m, mk };
}
const body = async (r: Response) => JSON.parse(await r.text());
const wait = async (m: DiagnosticRunManager, id: string) => m.waitFor(id);

describe("authentication & authorization", () => {
  it("every diagnostic-run route rejects unauthenticated requests", async () => {
    setup();
    const id = "run_20260102040000_aabbccdd";
    const post = await runsRoute.POST(new Request(`${ORIGIN}/api/diagnostic-runs`, { method: "POST", headers: { origin: ORIGIN, "content-type": "application/json" }, body: JSON.stringify({ app: "demo-shop", intent: "why_restarting" }) }));
    const list = await runsRoute.GET(new Request(`${ORIGIN}/api/diagnostic-runs`));
    const get = await runRoute.GET(new Request(`${ORIGIN}/api/diagnostic-runs/${id}`), { params: Promise.resolve({ id }) });
    const cancel = await cancelRoute.POST(new Request(`${ORIGIN}/api/diagnostic-runs/${id}/cancel`, { method: "POST", headers: { origin: ORIGIN, "content-type": "application/json" }, body: "{}" }), { params: Promise.resolve({ id }) });
    for (const r of [post, list, get, cancel]) expect(r.status).toBe(401);
  });

  it("forged / expired session cookies are rejected", async () => {
    setup();
    const r = await runsRoute.POST(new Request(`${ORIGIN}/api/diagnostic-runs`, { method: "POST", headers: { cookie: "liara_agent_session=forged", origin: ORIGIN, "content-type": "application/json" }, body: "{}" }));
    expect(r.status).toBe(401);
  });

  it("state-changing routes enforce same-origin + JSON (CSRF)", async () => {
    const { mk } = setup();
    const u = mk();
    const good = { app: "demo-shop", intent: "why_restarting" };
    expect((await u.post(good, { origin: "https://evil.example" })).status).toBe(403);
    expect((await u.post(good, { origin: "http://localhost:3000.evil.example" })).status).toBe(403);
    expect((await u.post(good, { "content-type": "text/plain" })).status).toBe(403);
    expect((await u.cancel("run_20260102040000_aabbccdd", { origin: "https://evil.example" })).status).toBe(403);
  });
});

describe("starting runs", () => {
  it("accepts an allowlisted app + supported intent (202) and the run completes with a report", async () => {
    const { m, mk } = setup();
    const u = mk();
    const res = await u.post({ app: "demo-api", intent: "why_restarting", windowMinutes: 60 });
    expect(res.status).toBe(202);
    const { run } = await body(res);
    expect(run).toMatchObject({ status: "RUNNING", app: "demo-api", intent: "why_restarting", mode: "mock" });
    await wait(m, run.id);
    const done = await body(await u.get(run.id));
    expect(done.run).toMatchObject({ status: "COMPLETED" });
    expect(done.run.report.summary.primaryKey).toBe("restart_loop_db_connection_refused");
    expect((await u.get(run.id)).headers.get("cache-control")).toBe("no-store");
  });

  it("validates input: strict body, unknown intent, invalid window", async () => {
    const { mk } = setup();
    const u = mk();
    expect((await u.post("{not json")).status).toBe(400);
    expect((await u.post({ app: "demo-shop", intent: "why_restarting", extra: 1 })).status).toBe(400);
    expect((await u.post({ intent: "why_restarting" })).status).toBe(400);
    expect((await u.post({ app: 5, intent: "why_restarting" })).status).toBe(400);
    const unknown = await u.post({ app: "demo-shop", intent: "restart the app and delete the database" });
    expect(unknown.status).toBe(400);
    const j = await body(unknown);
    expect(j.error.code).toBe("unknown_intent");
    expect(j.error.message).toMatch(/پشتیبانی نمی‌شود/);
    expect((await u.post({ app: "demo-shop", intent: "why_slow", windowMinutes: 7 })).status).toBe(400);
    expect((await u.post("x".repeat(5000))).status).toBe(400);
  });

  it("allowlist bypass attempts get the same 404 as a nonexistent app, and create no run", async () => {
    const l = liveService();
    const { m, mk } = setup({ live: l });
    const u = mk();
    const ref = await u.post({ app: "does-not-exist", intent: "why_restarting" });
    expect(ref.status).toBe(404);
    const refBody = await ref.text();
    for (const app of ["secret-internal-app", "SHOP-API", "shop-api/../secret-internal-app", "shop-api%2f..", "shop-api;x", "../etc/passwd", "shop-api\u0000"]) {
      const r = await u.post({ app, intent: "why_restarting" });
      expect(r.status, app).toBe(404);
      expect(await r.text(), app).toBe(refBody);
    }
    expect(l.calls).toHaveLength(0);
    expect(await m.list(u.session.id)).toEqual([]);
  });

  it("duplicate runs for one app are rejected with 409 and a pointer to the existing run", async () => {
    let release!: () => void;
    const hold = new Promise<void>((r) => (release = r));
    const { m, mk } = setup({ hold });
    const u = mk();
    const first = await body(await u.post({ app: "demo-api", intent: "why_restarting" }));
    const dup = await u.post({ app: "demo-api", intent: "why_slow" });
    expect(dup.status).toBe(409);
    expect(dup.headers.get("x-existing-run")).toBe(first.run.id);
    expect((await body(dup)).error.code).toBe("run_in_progress");
    release();
    await wait(m, first.run.id);
  });
});

describe("reading, listing and cancelling", () => {
  it("runs are private: another session gets 404 for get and cancel, and an empty list", async () => {
    const { m, mk } = setup();
    const a = mk();
    const b = mk();
    const run = (await body(await a.post({ app: "demo-shop", intent: "why_restarting" }))).run;
    await wait(m, run.id);
    expect((await a.get(run.id)).status).toBe(200);
    const other = await b.get(run.id);
    expect(other.status).toBe(404);
    expect((await body(other)).error.code).toBe("not_found");
    expect((await b.cancel(run.id)).status).toBe(404);
    expect((await body(await b.list())).runs).toEqual([]);
    expect((await body(await a.list())).runs.map((r: { id: string }) => r.id)).toEqual([run.id]);
  });

  it("the list omits report bodies (just a flag)", async () => {
    const { m, mk } = setup();
    const a = mk();
    const run = (await body(await a.post({ app: "demo-shop", intent: "why_restarting" }))).run;
    await wait(m, run.id);
    const runs = (await body(await a.list())).runs;
    expect(runs[0]).toMatchObject({ id: run.id, hasReport: true });
    expect(runs[0]).not.toHaveProperty("report");
  });

  it("malformed run ids are 404 (no traversal, no enumeration oracle)", async () => {
    const { mk } = setup();
    const u = mk();
    for (const id of ["../etc", "run_1", "RUN_20260102040000_AABBCCDD", "run_20260102040000_aabbccdd/../x", "run_20260102040000_aabbccdd ", "", "%00"]) {
      expect((await u.get(id)).status, id).toBe(404);
      expect((await u.cancel(id)).status, id).toBe(404);
    }
    expect((await u.get("run_20260102040000_aabbccdd")).status).toBe(404);
  });

  it("cancel via the API stops an in-flight run", async () => {
    let release!: () => void;
    const hold = new Promise<void>((r) => (release = r));
    const { m, mk } = setup({ hold });
    const u = mk();
    const run = (await body(await u.post({ app: "demo-api", intent: "why_restarting" }))).run;
    await new Promise((r) => setTimeout(r, 30));
    const pending = u.cancel(run.id);
    await new Promise((r) => setTimeout(r, 30));
    release();
    const out = await body(await pending);
    expect(out.run).toMatchObject({ status: "CANCELLED", errorCode: "cancelled_by_operator", report: null });
    await wait(m, run.id);
  });
});

describe("error classification is robust to duplicated module bundles", () => {
  it("errors from a foreign copy of RunError / LiaraError (instanceof would fail) still map to the right HTTP status", async () => {
    const { m, mk } = setup();
    const u = mk();
    const foreign = (name: string, code: string) => Object.assign(new Error(code), { name, code });
    m.start = (async () => { throw foreign("RunError", "unknown_intent"); }) as never;
    expect((await u.post({ app: "demo-shop", intent: "why_slow" })).status).toBe(400);
    m.start = (async () => { throw foreign("LiaraError", "app_not_allowed"); }) as never;
    expect((await u.post({ app: "demo-shop", intent: "why_slow" })).status).toBe(404);
    m.start = (async () => { throw new Error("plain"); }) as never;
    expect((await u.post({ app: "demo-shop", intent: "why_slow" })).status).toBe(500);
  });
});

describe("read-only guarantee through the routes", () => {
  it("a full run triggered via the API performs only GET requests against allowed read endpoints, with no secrets in responses", async () => {
    const l = liveService();
    const { m, mk } = setup({ live: l });
    const u = mk();
    const res = await u.post({ app: "shop-api", intent: "why_restarting" });
    expect(res.status).toBe(202);
    const { run } = await body(res);
    await wait(m, run.id);
    const full = await u.get(run.id);
    assertNoCanary(await full.text());
    expect(l.calls.length).toBeGreaterThan(0);
    for (const c of l.calls) {
      expect(c.method).toBe("GET");
      expect(c.body).toBeNull();
      expect(c.url.pathname).toMatch(/^\/v[12]\/projects(\/[a-z0-9-]+(\/(applets|releases|events|logs|metrics\/(cpu|memory)))?)?$/);
    }
  });

  it("route modules export only the intended methods", () => {
    expect(Object.keys(runsRoute).filter((k) => /^(GET|POST|PUT|PATCH|DELETE)$/.test(k)).sort()).toEqual(["GET", "POST"]);
    expect(Object.keys(runRoute).filter((k) => /^(GET|POST|PUT|PATCH|DELETE)$/.test(k))).toEqual(["GET"]);
    expect(Object.keys(cancelRoute).filter((k) => /^(GET|POST|PUT|PATCH|DELETE)$/.test(k))).toEqual(["POST"]);
    void defaultResponder;
    __setConfigForTests(undefined);
  });
});
