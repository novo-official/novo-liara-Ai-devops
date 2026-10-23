import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { __setLiveServiceForTests } from "@/server/live/runtime";
import { __resetApiLimiterForTests } from "@/server/security/guard";
import { __clearSessionsForTests, createSession, destroySession, hasActiveSession } from "@/server/security/session";
import { ownerHashOf } from "@/server/diagnostics/store";
import { assertNoCanary } from "../helpers/canaries";
import { AgentRunManager } from "@/server/agent/manager";
import { MockDiagnosticLLMProvider } from "@/server/diagnostics/llm";
import { harness, settle, TEAM, type Harness } from "../helpers/live-exec";
import { mockSvc } from "../helpers/scenario-runner";
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
  it("data minimisation: no response carries ownerHash / actorHash / the raw team id — only the coarse teamScope", async () => {
    const { h, api } = await setup();
    const bodies: string[] = [];
    const keep = async (r: Response) => { const t = await r.text(); bodies.push(t); return JSON.parse(t); };
    const view = await keep(await api.propose());
    const p = view.proposal;
    expect(p.teamScope).toBe("team");
    await keep(await api.decide(p.id, { decision: "approve", digest: p.digest, confirmAppName: p.appName, acknowledgeFinancial: true }));
    await keep(await api.execute(p.id));
    let op = await keep(await api.op(p.operationId));
    for (let i = 0; i < 200 && !["DEPLOYED", "FAILED", "NEEDS_OPERATOR_REVIEW"].includes(op.state); i++) {
      await new Promise((r) => setTimeout(r, 5));
      op = await keep(await api.op(p.operationId));
    }
    await keep(await api.status(h.runId));
    expect(op.teamScope).toBe("team");
    const all = bodies.join("\n");
    for (const key of ["ownerHash", "actorHash", "teamId"]) expect(all, key).not.toContain(`"${key}"`);
    expect(all).not.toContain(TEAM);
    expect(all).not.toMatch(/"(?:owner|actor)_?hash"/i);
  });
  it("the offline preview has its own per-session budget, charged before the body is read; other kinds and other sessions are unaffected", async () => {
    const { h, hdr } = await setup();
    let pulls = 0;
    const streamBody = () => new ReadableStream<Uint8Array>({ pull(c) { pulls++; c.enqueue(new Uint8Array(h.zip)); c.close(); } }, { highWaterMark: 0 }); // highWaterMark 0: pull() runs only when something actually reads
    const preview = (extra: Record<string, string> = {}, cookieHdr = hdr()) =>
      proposals.POST(new Request(`${ORIGIN}/api/agent/live/proposals`, { method: "POST", headers: { ...cookieHdr, "content-type": "application/zip", "x-live-kind": "preview_existing_app", "x-live-run": h.runId, "x-live-app": "liara-agent-demo", ...extra }, body: streamBody(), duplex: "half" } as RequestInit));
    for (let i = 0; i < 12; i++) expect((await preview()).status, `preview ${i + 1}`).not.toBe(429);
    const pullsBefore = pulls;
    const limited = await preview();
    expect(limited.status).toBe(429);
    expect(Number(limited.headers.get("retry-after"))).toBeGreaterThan(0);
    expect((await j(limited)).error.code).toBe("rate_limited");
    expect(pulls, "the rejected request's body was never read").toBe(pullsBefore);
    // a different live kind on the same session is not charged to the preview budget
    expect((await proposals.POST(new Request(`${ORIGIN}/api/agent/live/proposals`, { method: "POST", headers: hdr({ "content-type": "application/zip", "x-live-run": h.runId, "x-live-plan": "g2-small", "x-live-app": "liara-agent-demo" }), body: new Uint8Array(h.zip) }))).status).not.toBe(429);
    // another session has its own budget
    const other = createSession();
    expect((await preview({}, { cookie: `liara_agent_session=${other.id}`, origin: ORIGIN })).status).not.toBe(429);
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

describe("recovery over HTTP: an operation left in review by an EARLIER run can be abandoned from the new run, then a fresh proposal works", () => {
  it("status lists the lock; POST resolve {abandon} closes it (200, FAILED, local only); the next proposal is accepted; the old row and audit remain", async () => {
    const { h, api, cookie } = await setup();
    h.fake.apps.add("liara-agent-demo");
    h.fake.releaseIds.push("rel_old_1");
    h.fake.upload = "malformed";
    const existing = { "x-live-kind": "deploy_existing_app", "x-live-backend": "api" };
    const p1 = await j(await api.propose(existing));
    await api.decide(p1.proposal.id, { decision: "approve", digest: p1.proposal.digest, confirmAppName: "liara-agent-demo" });
    const ex = await j(await api.execute(p1.proposal.id));
    const first = await settle(h, ex.id, cookie.split("=")[1]!);
    expect(first.state).toBe("NEEDS_OPERATOR_REVIEW");
    // the operator re-uploads the project: a NEW run
    const agent = new AgentRunManager({ svc: mockSvc(), store: h.store, provider: new MockDiagnosticLLMProvider("ok"), now: h.clk.now, quotaPerWindow: 99 });
    const run2 = (await agent.receiveProject({ sessionId: cookie.split("=")[1]!, archive: h.zip, filename: "demo.zip" })).runId;
    h.fake.upload = "ok";
    // 1. the new proposal is refused (the lock is the OPERATION, not the consumed proposal)
    const refused = await api.propose({ ...existing, "x-live-run": run2 });
    expect(refused.status).toBe(409);
    expect((await j(refused)).error.code).toBe("live_operation_in_progress");
    // 2. the status of the new run now exposes it
    const st = await j(await api.status(run2));
    expect(st.locks.map((l: { operation: { id: string } | null; state: string }) => `${l.operation?.id}:${l.state}`)).toEqual([`${first.id}:NEEDS_OPERATOR_REVIEW`]);
    // 3. abandon: local only
    const calls = [...h.fake.calls];
    const ab = await api.resolve(first.id, { action: "abandon" });
    expect(ab.status).toBe(200);
    expect((await j(ab)).state).toBe("FAILED");
    expect(h.fake.calls).toEqual(calls);
    expect((await j(await api.status(run2))).locks).toEqual([]);
    // 4. replay of the old operation is refused
    expect((await api.resolve(first.id, { action: "abandon" })).status).toBe(409);
    expect((await api.execute(p1.proposal.id)).status).toBe(409);
    // 5. a fresh proposal now works and is a different one
    const fresh = await api.propose({ ...existing, "x-live-run": run2 });
    expect(fresh.status).toBe(200);
    expect((await j(fresh)).proposal.id).not.toBe(p1.proposal.id);
    expect((await h.store.getOperation(first.id))?.state).toBe("FAILED");
    assertNoCanary(JSON.stringify(await h.store.readAudit(1000)));
  });
});

describe("recovery over HTTP after a NEW LOGIN (the real incident): ownership follows the login session", () => {
  it("while the old login lives the lock is a stub and untouchable; once it is gone the new login can close it — only with the explicit flag; approve/execute never transfer", async () => {
    const { h, api, cookie } = await setup();
    const sessionA = cookie.split("=")[1]!;
    h.fake.apps.add("liara-agent-demo");
    h.fake.releaseIds.push("rel_old_1");
    h.fake.upload = "malformed";
    const existing = { "x-live-kind": "deploy_existing_app", "x-live-backend": "api" };
    const p1 = await j(await api.propose(existing));
    await api.decide(p1.proposal.id, { decision: "approve", digest: p1.proposal.digest, confirmAppName: "liara-agent-demo" });
    const first = await settle(h, (await j(await api.execute(p1.proposal.id))).id, sessionA);
    expect(first.state).toBe("NEEDS_OPERATOR_REVIEW");
    // the production wiring: "is the owner's login still alive?" asks the real in-memory session store
    const svc = h.rebuild({ isOwnerActive: (o) => hasActiveSession((id) => ownerHashOf(id) === o) });
    __setLiveServiceForTests(svc);
    // a NEW login (session B) uploads the project again → run #2 owned by B
    const B = createSession();
    const cookieB = `liara_agent_session=${B.id}`;
    const hdrB = (extra: Record<string, string> = {}) => ({ cookie: cookieB, origin: ORIGIN, ...extra });
    const agent = new AgentRunManager({ svc: mockSvc(), store: h.store, provider: new MockDiagnosticLLMProvider("ok"), now: h.clk.now, quotaPerWindow: 99 });
    const run2 = (await agent.receiveProject({ sessionId: B.id, archive: h.zip, filename: "demo.zip" })).runId;
    const statusB = async () => j(await status.GET(new Request(`${ORIGIN}/api/agent/live/status?runId=${run2}`, { headers: { cookie: cookieB } })));
    const resolveB = (body: unknown) => (resolve as unknown as Route).POST(new Request(`${ORIGIN}/api/agent/live/operations/${first.id}/resolve`, { method: "POST", headers: hdrB({ "content-type": "application/json" }), body: JSON.stringify(body) }), { params: Promise.resolve({ id: first.id }) });
    // A is still logged in → B sees a stub only and gets 404 whatever it sends
    const stub = await statusB();
    expect(stub.locks).toMatchObject([{ access: "other_session", appName: "liara-agent-demo", state: "NEEDS_OPERATOR_REVIEW", operation: null }]);
    expect(JSON.stringify(stub.locks)).not.toContain(first.id);
    expect((await resolveB({ action: "abandon", adoptOrphan: true })).status).toBe(404);
    // A logs out / restarts → B sees the full record and the recovery controls become available, still behind the explicit flag
    destroySession(sessionA);
    expect((await statusB()).locks).toMatchObject([{ access: "orphan", operation: { id: first.id, state: "NEEDS_OPERATOR_REVIEW" } }]);
    expect((await resolveB({ action: "abandon" })).status).toBe(404);
    const executeB = (execute as unknown as Route).POST(new Request(`${ORIGIN}/x`, { method: "POST", headers: hdrB({ "content-type": "application/zip" }), body: new Uint8Array(h.zip) }), { params: Promise.resolve({ id: p1.proposal.id }) });
    expect((await executeB).status).toBe(404);
    const calls = [...h.fake.calls];
    const ok = await resolveB({ action: "abandon", adoptOrphan: true });
    expect(ok.status).toBe(200);
    expect((await j(ok)).state).toBe("FAILED");
    expect(h.fake.calls).toEqual(calls);
    expect((await statusB()).locks).toEqual([]);
    const events = (await h.store.readAudit(1000)).map((r) => r.event);
    expect(events).toContain("live.operation_recovery_by_other_session");
    expect(events).toContain("live.operation_abandoned");
    expect((await h.store.getOperation(first.id))?.state).toBe("FAILED"); // kept, not deleted
  });
});
