import { describe, expect, it } from "vitest";
import { parseOperationResponse } from "@/lib/live-result";
import { redactDeep } from "@/server/security/redact";
import { liveEnv, harness, OTHER, OWNER, settle } from "../helpers/live-exec";
import { makeConfig } from "../helpers/live";

const APP = "liara-agent-demo";
type H = Awaited<ReturnType<typeof harness>>;

async function release(h: H, session = OWNER, runId = h.runId) {
  const v = await h.svc.createExistingProposal(session, { runId, appName: APP, backend: "api", zip: h.zip });
  await h.svc.decide(v.proposal.id, session, { decision: "approve", digest: v.proposal.digest, confirmAppName: APP });
  return settle(h, (await h.svc.execute(v.proposal.id, session, h.zip)).id, session);
}
async function newRun(h: H, session = OWNER) {
  const { AgentRunManager } = await import("@/server/agent/manager");
  const { MockDiagnosticLLMProvider } = await import("@/server/diagnostics/llm");
  const { mockSvc } = await import("../helpers/scenario-runner");
  const agent = new AgentRunManager({ svc: mockSvc(), store: h.store, provider: new MockDiagnosticLLMProvider("ok"), now: h.clk.now, quotaPerWindow: 99 });
  return (await agent.receiveProject({ sessionId: session, archive: h.zip, filename: "demo.zip" })).runId;
}
const setup = async (o: Parameters<typeof harness>[0] = {}) => {
  const h = await harness(o);
  h.fake.apps.add(APP);
  h.fake.releaseIds.push("rel_old_1");
  return h;
};

describe("verification provenance is recorded with the ladder (typed, no migration: optional member of the JSON record)", () => {
  it("applets readable and running ⇒ runtime 'observed'", async () => {
    const h = await setup();
    const op = await release(h);
    expect(op.state).toBe("DEPLOYED");
    expect(op.evidence).toMatchObject({ runtime: "observed", appletsReadable: true });
  });
  it("applets endpoint errors (HTTP 500) + marker-verified health ⇒ DEPLOYED with runtime 'inferred' and appletsReadable=false (never 'observed')", async () => {
    const h = await setup();
    h.fake.runtimeOk = false;
    const op = await release(h);
    expect(op.state).toBe("DEPLOYED");
    expect(op.ladder).toMatchObject({ runtimeStarted: "ok", httpHealthVerified: "ok" });
    expect(op.evidence).toMatchObject({ runtime: "inferred", appletsReadable: false });
  });
  it("applets error AND no health proof ⇒ runtime stays unknown, evidence 'unknown', the operation is NOT deployed", async () => {
    const h = await setup({ probe: async () => ({ outcome: "network", status: null, markerFound: null }), poll: { verifyBudgetMs: 3000, pollIntervalMs: 1000 } });
    h.fake.runtimeOk = false;
    const op = await release(h);
    expect(op.state).toBe("NEEDS_OPERATOR_REVIEW");
    expect(op.ladder.runtimeStarted).toBe("unknown");
    expect(op.evidence).toMatchObject({ runtime: "unknown", appletsReadable: false });
  });
  it("the record that crosses the API (redacted JSON) is accepted by the browser's validator with the same facts — the contract between /resolve and the page", async () => {
    const h = await setup({ probe: async () => ({ outcome: "network", status: null, markerFound: null }), poll: { verifyBudgetMs: 3000, pollIntervalMs: 1000, reverifyBudgetMs: 3000 } });
    h.fake.runtimeOk = false;
    const review = await release(h);
    expect(review.state).toBe("NEEDS_OPERATOR_REVIEW");
    const ok = h.rebuild({ probe: async () => ({ outcome: "ok", status: 200, markerFound: true }) });
    const again = await ok.resolve(review.id, OWNER, "reverify");
    const wire = redactDeep(JSON.parse(JSON.stringify(again)));
    expect(parseOperationResponse(wire, review.id)).toMatchObject({ state: "DEPLOYED", runtimeEvidence: "inferred", appletsReadable: false, failureCode: null, releaseId: again.remote.releaseId });
    // and a still-unverified answer is parsed as the warning it is
    const stuck = parseOperationResponse(redactDeep(JSON.parse(JSON.stringify(review))), review.id);
    expect(stuck?.state).toBe("NEEDS_OPERATOR_REVIEW");
  });
});

describe("status.lastResults — latest terminal result per application, read-only and securely scoped", () => {
  it("returns the persisted data of the latest DEPLOYED operation, from a NEW run, and it is not a lock", async () => {
    const h = await setup();
    h.fake.runtimeOk = false;
    const op = await release(h);
    const run2 = await newRun(h);
    const st = await h.svc.status(OWNER, run2);
    expect(st.locks).toEqual([]);
    expect(st.proposals).toEqual([]);
    expect(st.lastResults).toMatchObject([{ operationId: op.id, appName: APP, kind: "deploy_existing_app", state: "DEPLOYED", completedAt: op.transitions.at(-1)!.at, releaseId: op.remote.releaseId, ladder: op.ladder, failureCode: null, failureFa: null, recoveryFa: [], abandoned: false, runtimeEvidence: "inferred", appletsReadable: false, latestCheck: null, access: "owner" }]);
    // the slot is free: a new proposal is possible (history never blocks)
    expect((await h.svc.createExistingProposal(OWNER, { runId: run2, appName: APP, backend: "api", zip: h.zip })).proposal.status).toBe("PENDING");
  });
  it("a FAILED operation is reported truthfully (incl. an abandoned one); the NEWEST attempt wins, an older DEPLOYED/FAILED never overrides it", async () => {
    const h = await setup();
    h.fake.upload = "malformed";
    const review = await release(h);
    expect(review.state).toBe("NEEDS_OPERATOR_REVIEW");
    await h.svc.resolve(review.id, OWNER, "abandon");
    const run2 = await newRun(h);
    let st = await h.svc.status(OWNER, run2);
    expect(st.lastResults).toMatchObject([{ operationId: review.id, state: "FAILED", abandoned: true, failureCode: "abandoned_by_operator" }]);
    h.clk.advance(60_000);
    h.fake.upload = "ok";
    const good = await release(h, OWNER, run2);
    expect(good.state).toBe("DEPLOYED");
    st = await h.svc.status(OWNER, await newRun(h));
    expect(st.lastResults.map((r) => [r.operationId, r.state])).toEqual([[good.id, "DEPLOYED"]]);
  });
  it("tenant and application scoping: another team's operation, an application outside the operator's scope, and another LIVE session's operation are never exposed", async () => {
    const h = await setup();
    const op = await release(h);
    const run2 = await newRun(h);
    // another team ⇒ nothing
    expect((await h.rebuild({ isOwnerActive: () => false, cfg: makeConfig(liveEnv({ LIARA_TEAM_ID: "team_someone_else" })) }).status(OWNER, run2)).lastResults).toEqual([]);
    // application no longer in the operator's scope ⇒ nothing
    h.fake.scope.delete(APP);
    expect((await h.svc.status(OWNER, run2)).lastResults).toEqual([]);
    h.fake.scope.add(APP);
    expect((await h.svc.status(OWNER, run2)).lastResults).toHaveLength(1);
    // the owner's login is still ALIVE somewhere else ⇒ a different session gets nothing (and not even a hint)
    const stranger = "another-operator-session-secret";
    const strangerRun = await newRun(h, stranger);
    const alive = h.rebuild({ isOwnerActive: () => true });
    const hidden = await alive.status(stranger, strangerRun);
    expect(hidden.lastResults).toEqual([]);
    expect(JSON.stringify(hidden)).not.toContain(op.id);
    // the owner's login is GONE (restart / new login) ⇒ the same operator may read the finished result
    const gone = h.rebuild({ isOwnerActive: () => false });
    expect((await gone.status(stranger, strangerRun)).lastResults.map((r) => r.operationId)).toEqual([op.id]);
    expect(OTHER).not.toBe(stranger);
  });
  it("an inaccessible NEWER result never makes an older one look current", async () => {
    const h = await setup();
    const older = await release(h);
    const h2 = await harness({ store: h.store, owner: OTHER, fake: h.fake });
    h2.clk.advance(3_600_000);
    const newer = await release(h2, OTHER, h2.runId);
    expect(newer.state).toBe("DEPLOYED");
    expect(newer.createdAt > older.createdAt).toBe(true);
    const run = await newRun(h);
    const alive = h.rebuild({ isOwnerActive: () => true }); // OTHER's login is alive: its newer result is not ours to see …
    expect((await alive.status(OWNER, run)).lastResults).toEqual([]); // … and the older one must NOT be shown as "the latest"
  });
  it("it is READ-ONLY: building the status writes nothing, verifies nothing, polls nothing and appends no audit row", async () => {
    const h = await setup();
    await release(h);
    const run2 = await newRun(h);
    const before = { calls: [...h.fake.calls], polls: h.fake.pollsSeen, audit: (await h.store.readAudit(2000)).length };
    for (let i = 0; i < 3; i++) await h.svc.status(OWNER, run2);
    expect(h.fake.calls).toEqual(before.calls);
    expect(h.fake.pollsSeen).toBe(before.polls); // no getRuntime / verification triggered by a status read
    expect((await h.store.readAudit(2000)).length).toBe(before.audit);
  });
});
