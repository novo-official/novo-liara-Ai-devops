import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it, vi } from "vitest";
import { AbandonConfirmBox, LiveDeploymentView } from "@/components/live-deployment";
import { liveUi } from "@/i18n/live-fa";
import { AgentRunManager } from "@/server/agent/manager";
import { MockDiagnosticLLMProvider } from "@/server/diagnostics/llm";
import { SqliteLiveStore } from "@/server/live/store";
import { isLiveError } from "@/server/live/types";
import { findNestingViolations } from "../helpers/html-nesting";
import { liveEnv, harness, OTHER, OWNER, settle } from "../helpers/live-exec";
import { makeConfig } from "../helpers/live";
import { mockSvc } from "../helpers/scenario-runner";

vi.mock("next/navigation", () => ({ useRouter: () => ({ push: () => undefined, refresh: () => undefined }) }));

const APP = "liara-agent-demo";
const code = async (p: Promise<unknown>) => {
  try {
    await p;
    return null;
  } catch (e) {
    return isLiveError(e) ? e.code : "other";
  }
};
type H = Awaited<ReturnType<typeof harness>>;

/** The real incident: attempt #1 ends in NEEDS_OPERATOR_REVIEW; the operator then re-uploads the project, which creates a NEW run (#2). */
async function twoRuns(store?: SqliteLiveStore) {
  const h = await harness({ store });
  h.fake.apps.add(APP);
  h.fake.releaseIds.push("rel_old_1");
  h.fake.upload = "malformed";
  const v = await h.svc.createExistingProposal(OWNER, { runId: h.runId, appName: APP, backend: "api", zip: h.zip });
  await h.svc.decide(v.proposal.id, OWNER, { decision: "approve", digest: v.proposal.digest, confirmAppName: APP });
  const first = await settle(h, (await h.svc.execute(v.proposal.id, OWNER, h.zip)).id);
  expect(first.state).toBe("NEEDS_OPERATOR_REVIEW");
  const agent = new AgentRunManager({ svc: mockSvc(), store: h.store, provider: new MockDiagnosticLLMProvider("ok"), now: h.clk.now, quotaPerWindow: 99 });
  const run2 = (await agent.receiveProject({ sessionId: OWNER, archive: h.zip, filename: "demo.zip" })).runId;
  h.fake.upload = "ok";
  return { h, v, first, run2 };
}
const view = async (h: H, runId: string) => renderToStaticMarkup(<LiveDeploymentView status={await h.svc.status(OWNER, runId)} runId={runId} defaultApp="" readiness={{ verdict: "READY", frameworkFa: "Next.js" }} onChanged={() => undefined} />);

describe("a previous run's operation holds the (team, app) lock — and used to be unreachable from the new run", () => {
  it("root cause reproduced: the new run lists no proposals, yet a new proposal is refused as 'already started'", async () => {
    const { h, first, run2 } = await twoRuns();
    const st = await h.svc.status(OWNER, run2);
    expect(st.proposals).toEqual([]); // the old operation is NOT among this run's proposals (so no buttons were rendered)
    expect(await code(h.svc.createExistingProposal(OWNER, { runId: run2, appName: APP, backend: "api", zip: h.zip }))).toBe("live_operation_in_progress");
    expect((await h.store.getOperation(first.id))?.state).toBe("NEEDS_OPERATOR_REVIEW"); // it is the OPERATION (active=1), not the consumed proposal, that owns the lock
  });
  it("the fix: the new run's status lists the locking operation, the page shows it with re-verify / abandon, and says what to do", async () => {
    const { h, first, run2 } = await twoRuns();
    const st = await h.svc.status(OWNER, run2);
    expect(st.locks.map((l) => l.operation?.id)).toEqual([first.id]);
    expect(st.locks[0]).toMatchObject({ access: "owner", appName: APP, state: "NEEDS_OPERATOR_REVIEW" });
    const html = await view(h, run2);
    expect(html).toContain('data-testid="live-locks"');
    expect(findNestingViolations(html)).toEqual([]);
    expect(findNestingViolations(renderToStaticMarkup(<AbandonConfirmBox opId="lop_20261022184638_3db4352a" busy={false} disabled={false} onConfirm={() => undefined} onBack={() => undefined} />))).toEqual([]);
    expect(html).toContain(`data-op-id="${first.id}"`);
    expect(html).toContain('data-testid="live-abandon"');
    expect(html).toContain('data-testid="live-reverify"');
    expect(html).toMatch(/data-testid="live-next-action" data-action="resolve_previous"/);
    expect(html).toContain(liveUi.flow.next.resolve_previous!.title);
    // the confirmation panel is not shown until the button is pressed, and the request button stays closed under the lock
    expect(html).not.toContain('data-testid="live-abandon-confirm"');
    expect(html).toMatch(/<button[^>]*data-testid="live-existing-propose"[^>]*>/);
    expect(/<button[^>]*data-testid="live-existing-propose"[^>]*>/.exec(html)![0]).toMatch(/\sdisabled/);
  });
  it("only the owner sees the lock; the run's own operations are not duplicated into it; after abandon the lock list is empty", async () => {
    const { h, first, run2 } = await twoRuns();
    expect((await h.svc.status(OWNER, h.runId)).locks).toEqual([]); // from run #1 it is an ordinary proposal of that run
    expect((await h.svc.status(OWNER, h.runId)).proposals).toHaveLength(1);
    expect(await code(h.svc.resolve(first.id, OTHER, "abandon"))).toBe("live_not_found"); // another session whose owner is still considered active (strict default)
    const calls = [...h.fake.calls];
    const done = await h.svc.resolve(first.id, OWNER, "abandon"); // from the NEW run's page: the endpoint needs only the operation id and the owner
    expect(done.state).toBe("FAILED");
    expect((await h.svc.status(OWNER, run2)).locks).toEqual([]);
    expect(h.fake.calls).toEqual(calls); // nothing was sent to Liara
  });
  it("after abandoning, a FRESH proposal can be created, approved and executed from the new run; the old records and audit rows are all still there", async () => {
    const { h, v, first, run2 } = await twoRuns();
    const auditBefore = (await h.store.readAudit(1000)).length;
    await h.svc.resolve(first.id, OWNER, "abandon");
    const fresh = await h.svc.createExistingProposal(OWNER, { runId: run2, appName: APP, backend: "api", zip: h.zip });
    expect(fresh.proposal.id).not.toBe(v.proposal.id);
    expect(fresh.operation?.id).not.toBe(first.id);
    await h.svc.decide(fresh.proposal.id, OWNER, { decision: "approve", digest: fresh.proposal.digest, confirmAppName: APP });
    const final = await settle(h, (await h.svc.execute(fresh.proposal.id, OWNER, h.zip)).id);
    expect(final.state).toBe("DEPLOYED");
    // preserved history
    const old = await h.store.getOperation(first.id);
    expect(old).toMatchObject({ state: "FAILED", failure: { code: "abandoned_by_operator" }, remote: { sourceId: null } });
    expect(old!.transitions.map((t) => t.to)).toEqual(["PREFLIGHT", "AWAITING_LIVE_APPROVAL", "APPROVED", "APPLICATION_CREATED", "UPLOADING_SOURCE", "NEEDS_OPERATOR_REVIEW", "FAILED"]);
    expect((await h.store.getLiveProposal(v.proposal.id))?.status).toBe("CONSUMED");
    const events = (await h.store.readAudit(1000)).map((r) => r.event);
    expect((await h.store.readAudit(1000)).length).toBeGreaterThan(auditBefore);
    for (const e of ["live.operation_needs_review", "live.operation_abandoned", "live.upload_attempt", "live.proposal_created"]) expect(events).toContain(e);
    // exactly one upload happened before, one after: the abandon itself sent nothing
    expect(h.fake.calls.map((c) => c.op)).toEqual(["uploadSource", "uploadSource", "createRelease"]);
  });
  it("a PENDING (not yet approved) proposal of another run also holds the slot: it is listed and can be cancelled from the new run", async () => {
    const h = await harness();
    h.fake.apps.add(APP);
    h.fake.releaseIds.push("rel_old_1");
    const v = await h.svc.createExistingProposal(OWNER, { runId: h.runId, appName: APP, backend: "api", zip: h.zip });
    const agent = new AgentRunManager({ svc: mockSvc(), store: h.store, provider: new MockDiagnosticLLMProvider("ok"), now: h.clk.now, quotaPerWindow: 99 });
    const run2 = (await agent.receiveProject({ sessionId: OWNER, archive: h.zip, filename: "demo.zip" })).runId;
    expect(await code(h.svc.createExistingProposal(OWNER, { runId: run2, appName: APP, backend: "api", zip: h.zip }))).toBe("live_proposal_pending");
    const st = await h.svc.status(OWNER, run2);
    expect(st.locks.map((l) => l.state)).toEqual(["AWAITING_LIVE_APPROVAL"]);
    expect(renderToStaticMarkup(<LiveDeploymentView status={st} runId={run2} defaultApp="" readiness={{ verdict: "READY", frameworkFa: "Next.js" }} onChanged={() => undefined} />)).toContain('data-testid="live-cancel"');
    await h.svc.cancel(st.locks[0]!.operation!.id, OWNER);
    expect((await h.svc.status(OWNER, run2)).locks).toEqual([]);
    expect((await h.store.getLiveProposal(v.proposal.id))?.status).toBe("CANCELLED"); // the record stays, closed
    expect((await h.svc.createExistingProposal(OWNER, { runId: run2, appName: APP, backend: "api", zip: h.zip })).proposal.status).toBe("PENDING");
  });
  it("same flow on the real SQLite store: the row stays, active flips 1 → 0, nothing is deleted", async () => {
    const { mkdtempSync, rmSync } = await import("node:fs");
    const { tmpdir } = await import("node:os");
    const path = await import("node:path");
    const { DatabaseSync } = await import("node:sqlite");
    const dir = mkdtempSync(path.join(tmpdir(), "live-lock-"));
    try {
      const db = path.join(dir, "a.db");
      const { h, first, run2 } = await twoRuns(new SqliteLiveStore(db));
      const raw = new DatabaseSync(db, { readOnly: true });
      const q = () => raw.prepare("SELECT state, active FROM live_operations WHERE id=?").get(first.id) as { state: string; active: number };
      const count = () => (raw.prepare("SELECT (SELECT count(*) FROM live_operations) AS o, (SELECT count(*) FROM live_proposals) AS p, (SELECT count(*) FROM audit) AS a").get() as { o: number; p: number; a: number });
      expect(q()).toEqual({ state: "NEEDS_OPERATOR_REVIEW", active: 1 });
      const before = count();
      await h.svc.resolve(first.id, OWNER, "abandon");
      expect(q()).toEqual({ state: "FAILED", active: 0 });
      const after = count();
      expect(after.o).toBe(before.o);
      expect(after.p).toBe(before.p);
      expect(after.a).toBe(before.a + 1); // one audit row appended, none removed
      expect((await h.svc.status(OWNER, run2)).locks).toEqual([]);
      raw.close();
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it("the second step of abandon states plainly that it is local-only, deletes nothing and keeps the history", () => {
    const html = renderToStaticMarkup(<AbandonConfirmBox opId="lop_20261022184638_3db4352a" busy={false} disabled={false} onConfirm={() => undefined} onBack={() => undefined} />);
    for (const must of liveUi.flow.abandon.confirmBody) expect(html).toContain(must);
    expect(html).toContain('data-testid="live-abandon-confirm"');
    expect(html).toContain('data-testid="live-abandon-back"');
    expect(html).toContain('role="group"');
    expect(liveUi.flow.abandon.confirmBody.join(" ")).toMatch(/لیارا نمی‌رود/);
    expect(liveUi.flow.abandon.confirmBody.join(" ")).toMatch(/حذف نمی‌شود/);
    expect(liveUi.flow.abandon.confirmBody.join(" ")).toMatch(/حسابرسی/);
  });

  it("whose lock is it? the REAL cause of the missing button: ownership follows the login session, so after a restart / new login the old owner is gone", async () => {
    const { h, first, run2 } = await twoRuns();
    const NEW_LOGIN = "operator-new-login-session-secret";
    const calls = [...h.fake.calls];
    // (a) the owner's login is still alive elsewhere → the new session sees only a stub (no id, no record) and cannot touch it — fails securely
    const alive = h.rebuild({ isOwnerActive: () => true });
    const stub = await alive.status(OTHER, run2).catch(() => null);
    expect(stub).toBeNull(); // a session that does not own run2 cannot even read its status
    // (b) the new login owns run #2 (the page the operator is looking at); the old operation belongs to the vanished login
    const agent = new AgentRunManager({ svc: mockSvc(), store: h.store, provider: new MockDiagnosticLLMProvider("ok"), now: h.clk.now, quotaPerWindow: 99 });
    const run3 = (await agent.receiveProject({ sessionId: NEW_LOGIN, archive: h.zip, filename: "demo.zip" })).runId;
    const stubStatus = await alive.status(NEW_LOGIN, run3);
    expect(stubStatus.locks).toEqual([{ access: "other_session", appName: APP, state: "NEEDS_OPERATOR_REVIEW", createdAt: first.createdAt, operation: null }]);
    expect(JSON.stringify(stubStatus.locks)).not.toContain(first.id); // not even the id leaks
    expect(await code(alive.resolve(first.id, NEW_LOGIN, "abandon", true))).toBe("live_not_found"); // adoptOrphan is useless while the owner lives
    expect(await code(alive.cancel(first.id, NEW_LOGIN, true))).toBe("live_not_found");
    expect((await h.store.getOperation(first.id))?.state).toBe("NEEDS_OPERATOR_REVIEW");
    // the page says so instead of silently showing nothing
    const html = renderToStaticMarkup(<LiveDeploymentView status={stubStatus} runId={run3} defaultApp="" readiness={{ verdict: "READY", frameworkFa: "Next.js" }} onChanged={() => undefined} />);
    expect(html).toContain('data-testid="live-lock-elsewhere"');
    expect(html).not.toContain('data-testid="live-abandon"');
    expect(html).toMatch(/data-action="locked_elsewhere"/);
    // (c) the owner's login is gone → "orphan": visible with its record and recovery buttons, but only with the explicit flag
    const gone = h.rebuild({ isOwnerActive: () => false });
    const orphan = await gone.status(NEW_LOGIN, run3);
    expect(orphan.locks.map((l) => [l.access, l.operation?.id])).toEqual([["orphan", first.id]]);
    const orphanHtml = renderToStaticMarkup(<LiveDeploymentView status={orphan} runId={run3} defaultApp="" readiness={{ verdict: "READY", frameworkFa: "Next.js" }} onChanged={() => undefined} />);
    for (const id of ["live-locks", "live-lock-orphan-note", "live-abandon", "live-reverify"]) expect(orphanHtml, id).toContain(`data-testid="${id}"`);
    expect(orphanHtml).toMatch(/data-action="resolve_previous"/);
    expect(await code(gone.resolve(first.id, NEW_LOGIN, "abandon"))).toBe("live_not_found"); // no explicit acknowledgement → refused
    // approve / execute are never transferred
    expect(await code(gone.execute(first.proposalId, NEW_LOGIN, h.zip))).toBe("live_not_found");
    expect(await code(gone.decide(first.proposalId, NEW_LOGIN, { decision: "approve", digest: "a".repeat(64), confirmAppName: APP }))).toBe("live_not_found");
    // closing it: local only, audited with both actors, records preserved
    const done = await gone.resolve(first.id, NEW_LOGIN, "abandon", true);
    expect(done.state).toBe("FAILED");
    expect(h.fake.calls).toEqual(calls);
    const adopt = (await h.store.readAudit(1000)).find((r) => r.event === "live.operation_recovery_by_other_session");
    expect(JSON.parse(adopt!.data)).toMatchObject({ operationId: first.id, action: "abandon", state: "NEEDS_OPERATOR_REVIEW" });
    expect(adopt!.data).toMatch(/previousOwner/);
    expect((await gone.status(NEW_LOGIN, run3)).locks).toEqual([]);
    expect(run2).not.toBe(run3);
  });
  it("another TEAM's operation is never offered, even as an orphan", async () => {
    const { h, run2 } = await twoRuns();
    const otherTeam = h.rebuild({ isOwnerActive: () => false, cfg: makeConfig(liveEnv({ LIARA_TEAM_ID: "team_someone_else" })) });
    expect((await otherTeam.status(OWNER, run2)).locks).toEqual([]);
  });
});
