import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { __setLiveServiceForTests } from "@/server/live/runtime";
import { __resetApiLimiterForTests } from "@/server/security/guard";
import { __clearSessionsForTests, createSession } from "@/server/security/session";
import { assertNoCanary } from "../helpers/canaries";
import { harness, type Harness } from "../helpers/live-exec";
import { resetAll } from "../helpers/live";

import * as status from "@/app/api/agent/live/status/route";
import * as proposals from "@/app/api/agent/live/proposals/route";
import * as decision from "@/app/api/agent/live/proposals/[id]/decision/route";
import * as execute from "@/app/api/agent/live/proposals/[id]/execute/route";
import * as operation from "@/app/api/agent/live/operations/[id]/route";
import * as resolve from "@/app/api/agent/live/operations/[id]/resolve/route";

const ORIGIN = "http://localhost:3000";
type Route = { POST: (r: Request, c: { params: Promise<{ id: string }> }) => Promise<Response> };
beforeEach(() => {
  __clearSessionsForTests();
  __resetApiLimiterForTests();
});
afterEach(() => {
  __setLiveServiceForTests(undefined);
  resetAll();
});

async function setup(env: Record<string, string | undefined> = {}, noTransport = false) {
  const s = createSession();
  const h: Harness = await harness({ env, noTransport, owner: s.id });
  __setLiveServiceForTests(h.svc);
  const cookie = `liara_agent_session=${s.id}`;
  const hdr = (extra: Record<string, string> = {}) => ({ cookie, origin: ORIGIN, ...extra });
  const api = {
    status: (runId?: string) => status.GET(new Request(`${ORIGIN}/api/agent/live/status${runId ? `?runId=${runId}` : ""}`, { headers: { cookie } })),
    propose: (over: Record<string, string> = {}, bytes: Buffer = h.zip) =>
      proposals.POST(new Request(`${ORIGIN}/api/agent/live/proposals`, { method: "POST", headers: hdr({ "content-type": "application/zip", "x-live-run": h.runId, "x-live-plan": "g2-small", "x-live-app": "liara-agent-demo", ...over }), body: new Uint8Array(bytes) })),
    decide: (id: string, body: unknown, extra: Record<string, string> = {}) =>
      (decision as unknown as Route).POST(new Request(`${ORIGIN}/api/agent/live/proposals/${id}/decision`, { method: "POST", headers: hdr({ "content-type": "application/json", ...extra }), body: typeof body === "string" ? body : JSON.stringify(body) }), { params: Promise.resolve({ id }) }),
    execute: (id: string, bytes: Buffer = h.zip) =>
      (execute as unknown as Route).POST(new Request(`${ORIGIN}/api/agent/live/proposals/${id}/execute`, { method: "POST", headers: hdr({ "content-type": "application/zip" }), body: new Uint8Array(bytes) }), { params: Promise.resolve({ id }) }),
    op: (id: string, c = cookie) => operation.GET(new Request(`${ORIGIN}/api/agent/live/operations/${id}`, { headers: { cookie: c } }), { params: Promise.resolve({ id }) }),
    resolve: (id: string, body: unknown) =>
      (resolve as unknown as Route).POST(new Request(`${ORIGIN}/api/agent/live/operations/${id}/resolve`, { method: "POST", headers: hdr({ "content-type": "application/json" }), body: JSON.stringify(body) }), { params: Promise.resolve({ id }) }),
  };
  return { h, api, cookie, hdr };
}
const j = async (r: Response) => JSON.parse(await r.text());

describe("live routes — fail-closed by default", () => {
  it("with the default (disabled) configuration every mutating route answers 403 live_execution_disabled and nothing is written", async () => {
    const { h, api } = await setup({ LIARA_LIVE_DEPLOY_ENABLED: "false" }, true);
    const r = await api.propose();
    expect(r.status).toBe(403);
    expect((await j(r)).error.code).toBe("live_execution_disabled");
    const e = await api.execute("lprop_20260102040000_aabbccdd");
    expect(e.status).toBe(403);
    expect(h.fake.calls).toEqual([]);
  });
  it("status is readable and reports BLOCKED with the failing prerequisites in Persian-ready codes", async () => {
    const { api } = await setup({ LIARA_LIVE_DEPLOY_ENABLED: "false" }, true);
    const r = await api.status();
    expect(r.status).toBe(200);
    const b = await j(r);
    expect(b.uiState).toBe("BLOCKED");
    expect(b.prerequisites.some((p: { id: string; ok: boolean }) => p.id === "live_flag" && !p.ok)).toBe(true);
  });
});

describe("live routes — authentication, CSRF and strict validation", () => {
  it("every route rejects an unauthenticated caller", async () => {
    await setup();
    const id = "lprop_20260102040000_aabbccdd";
    const op = "lop_20260102040000_aabbccdd";
    const rs = [
      await status.GET(new Request(`${ORIGIN}/api/agent/live/status`)),
      await proposals.POST(new Request(`${ORIGIN}/api/agent/live/proposals`, { method: "POST", headers: { origin: ORIGIN, "content-type": "application/zip" }, body: new Uint8Array([1]) })),
      await (decision as unknown as Route).POST(new Request(`${ORIGIN}/x`, { method: "POST", headers: { origin: ORIGIN, "content-type": "application/json" }, body: "{}" }), { params: Promise.resolve({ id }) }),
      await (execute as unknown as Route).POST(new Request(`${ORIGIN}/x`, { method: "POST", headers: { origin: ORIGIN, "content-type": "application/zip" }, body: new Uint8Array([1]) }), { params: Promise.resolve({ id }) }),
      await operation.GET(new Request(`${ORIGIN}/x`), { params: Promise.resolve({ id: op }) }),
      await (resolve as unknown as Route).POST(new Request(`${ORIGIN}/x`, { method: "POST", headers: { origin: ORIGIN, "content-type": "application/json" }, body: "{}" }), { params: Promise.resolve({ id: op }) }),
    ];
    for (const r of rs) expect(r.status).toBe(401);
  });
  it("cross-origin and wrong content types are refused (CSRF)", async () => {
    const { api } = await setup();
    expect((await api.decide("lprop_20260102040000_aabbccdd", {}, { origin: "http://evil.example" })).status).toBe(403);
    expect((await api.decide("lprop_20260102040000_aabbccdd", {}, { "content-type": "text/plain" })).status).toBe(403);
  });
  it("proposal parameters are strictly validated (headers, ids, names)", async () => {
    const { api, h } = await setup();
    for (const over of <Record<string, string>[]>[{ "x-live-run": "nope" }, { "x-live-plan": "../x" }, { "x-live-app": "Bad_Name" }, { "x-live-app": "a" }, { "x-live-bundle": "bad bundle" }]) expect((await api.propose(over)).status, JSON.stringify(over)).toBe(400);
    expect(h.fake.calls).toEqual([]);
  });
  it("decision bodies are strict: unknown keys, an 'approved' flag, a bad digest or an unknown decision are 400", async () => {
    const { api } = await setup();
    const id = "lprop_20260102040000_aabbccdd";
    const d = "a".repeat(64);
    for (const body of [{ decision: "approve", digest: d, approved: true }, { decision: "approve", digest: "xyz" }, { decision: "yes", digest: d }, { digest: d }, "not json", [], { decision: "approve", digest: d, confirmAppName: "x".repeat(200), acknowledgeFinancial: true }]) expect((await api.decide(id, body)).status, JSON.stringify(body)).toBe(400);
  });
  it("a simulation proposal id (prop_…) is refused with 403 on the live decision and execute routes", async () => {
    const { api } = await setup();
    const d = await api.decide("prop_20260102040000_aabbccdd", { decision: "approve", digest: "a".repeat(64), confirmAppName: "x", acknowledgeFinancial: true });
    expect(d.status).toBe(403);
    expect((await j(d)).error.code).toBe("live_simulation_approval_rejected");
    const e = await api.execute("prop_20260102040000_aabbccdd");
    expect(e.status).toBe(403);
  });
  it("malformed ids are 404, not 500", async () => {
    const { api } = await setup();
    expect((await api.decide("../../etc", { decision: "reject", digest: "a".repeat(64) })).status).toBe(404);
    expect((await api.execute("x")).status).toBe(404);
    expect((await api.op("bad")).status).toBe(404);
    expect((await api.resolve("bad", { action: "reverify" })).status).toBe(404);
  });
  it("resolve accepts only cancel/reverify/abandon — there is no delete/restart/rollback action", async () => {
    const { api } = await setup();
    for (const action of ["delete", "restart", "rollback", "retry", "upgrade", ""]) expect((await api.resolve("lop_20260102040000_aabbccdd", { action })).status, action).toBe(400);
    expect((await api.resolve("lop_20260102040000_aabbccdd", { action: "reverify", force: true })).status).toBe(400);
  });
});

describe("live routes — the whole journey over HTTP (fake transport only)", () => {
  it("propose → decide → execute → poll → DEPLOYED; nothing leaks; another session sees nothing", async () => {
    const { h, api } = await setup();
    const pr = await api.propose();
    expect(pr.status).toBe(200);
    const view = await j(pr);
    const p = view.proposal;
    expect(p.status).toBe("PENDING");
    const dr = await api.decide(p.id, { decision: "approve", digest: p.digest, confirmAppName: p.appName, acknowledgeFinancial: true });
    expect(dr.status).toBe(200);
    const er = await api.execute(p.id);
    expect(er.status).toBe(200);
    // poll over HTTP until the background run settles
    let body = await j(await api.op(p.operationId));
    for (let i = 0; i < 200 && !["DEPLOYED", "FAILED", "NEEDS_OPERATOR_REVIEW"].includes(body.state); i++) {
      await new Promise((r) => setTimeout(r, 5));
      body = await j(await api.op(p.operationId));
    }
    expect(body.state).toBe("DEPLOYED");
    expect(h.fake.calls.map((c) => c.op)).toEqual(["createApp", "uploadSource", "createRelease"]);
    assertNoCanary(JSON.stringify([view, body]));
    const stranger = createSession();
    expect((await api.op(p.operationId, `liara_agent_session=${stranger.id}`)).status).toBe(404);
  });
  it("a wrong typed name over HTTP is 400 and executes nothing", async () => {
    const { api, h } = await setup();
    const p = (await j(await api.propose())).proposal;
    const r = await api.decide(p.id, { decision: "approve", digest: p.digest, confirmAppName: "wrong", acknowledgeFinancial: true });
    expect(r.status).toBe(400);
    expect((await j(r)).error.code).toBe("live_confirmation_required");
    expect(h.fake.calls).toEqual([]);
  });
  it("uploads that are not ZIP-typed are refused before any parsing", async () => {
    const { api } = await setup();
    const r = await api.propose({ "content-type": "application/json" });
    expect(r.status).toBe(422);
  });
});
