import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { afterAll, describe, expect, it } from "vitest";
import { LIVE_APPROVAL_TTL_MS } from "@/server/live/service";
import { SqliteLiveStore } from "@/server/live/store";
import { isLiveError } from "@/server/live/types";
import type { LiveStore as Store } from "@/server/live/store";
import { liveEnv, harness, OWNER, settle } from "../helpers/live-exec";
import { makeConfig } from "../helpers/live";

const APP = "liara-agent-demo";
const TTL = LIVE_APPROVAL_TTL_MS;
type H = Awaited<ReturnType<typeof harness>>;

const dirs: string[] = [];
afterAll(() => dirs.forEach((d) => rmSync(d, { recursive: true, force: true })));
const backends: [string, () => Store | undefined][] = [
  ["in-memory store", () => undefined],
  ["SQLite store (temporary file)", () => {
    const d = mkdtempSync(path.join(tmpdir(), "live-expiry-"));
    dirs.push(d);
    return new SqliteLiveStore(path.join(d, "a.db"));
  }],
];

const code = async (p: Promise<unknown>) => {
  try {
    await p;
    return "ok";
  } catch (e) {
    return isLiveError(e) ? e.code : "other";
  }
};
async function newRun(h: H) {
  const { AgentRunManager } = await import("@/server/agent/manager");
  const { MockDiagnosticLLMProvider } = await import("@/server/diagnostics/llm");
  const { mockSvc } = await import("../helpers/scenario-runner");
  const agent = new AgentRunManager({ svc: mockSvc(), store: h.store, provider: new MockDiagnosticLLMProvider("ok"), now: h.clk.now, quotaPerWindow: 99 });
  return (await agent.receiveProject({ sessionId: OWNER, archive: h.zip, filename: "demo.zip" })).runId;
}
const propose = (h: H, runId = h.runId, app = APP) => h.svc.createExistingProposal(OWNER, { runId, appName: app, backend: "api", zip: h.zip });
async function approve(h: H, v: Awaited<ReturnType<typeof propose>>) {
  await h.svc.decide(v.proposal.id, OWNER, { decision: "approve", digest: v.proposal.digest, confirmAppName: v.proposal.appName });
}
const audit = async (h: H, event: string) => (await h.store.readAudit(5000)).filter((r) => r.event === event);
async function world(store?: Store, o: Parameters<typeof harness>[0] = {}) {
  const h = await harness({ store, ...o });
  h.fake.apps.add(APP);
  h.fake.releaseIds.push("rel_old_1");
  return h;
}
const state = async (h: H, v: { proposal: { id: string; operationId: string } }) => ({ proposal: (await h.store.getLiveProposal(v.proposal.id))!.status, op: (await h.store.getOperation(v.proposal.operationId))! });
const wait = async (cond: () => Promise<boolean>) => {
  for (let i = 0; i < 100; i++) {
    if (await cond()) return true;
    await new Promise((r) => setTimeout(r, 10));
  }
  return false;
};

describe.each(backends)("expiry lifecycle — %s", (_n, mk) => {
  it("a valid (unexpired) PENDING proposal keeps its lock; a conflicting proposal from another run is refused", async () => {
    const h = await world(mk());
    const v = await propose(h);
    h.clk.advance(TTL - 1_000);
    const run2 = await newRun(h);
    expect(await code(propose(h, run2))).toBe("live_proposal_pending");
    expect((await state(h, v)).proposal).toBe("PENDING");
    expect((await state(h, v)).op.state).toBe("AWAITING_LIVE_APPROVAL");
    expect(await audit(h, "live.proposal_expired")).toHaveLength(0);
  });

  it("an EXPIRED pending proposal stops blocking WITHOUT anybody opening it: a new proposal through the normal path succeeds; record, history and audit stay", async () => {
    const h = await world(mk());
    const v = await propose(h);
    h.clk.advance(TTL + 1_000);
    const run2 = await newRun(h); // the old run is never read
    const fresh = await propose(h, run2);
    expect(fresh.proposal.status).toBe("PENDING");
    const old = await state(h, v);
    expect(old.proposal).toBe("EXPIRED"); // the record is kept, not deleted
    expect(old.op.state).toBe("CANCELLED");
    expect(old.op.transitions.map((t) => t.to)).toEqual(["PREFLIGHT", "AWAITING_LIVE_APPROVAL", "CANCELLED"]);
    expect(old.op.transitions.at(-1)).toMatchObject({ from: "AWAITING_LIVE_APPROVAL", to: "CANCELLED", note: "approval_expired" });
    expect((await audit(h, "live.proposal_expired")).map((r) => JSON.parse(r.data))).toEqual([{ proposalId: v.proposal.id, from: "PENDING" }]);
  });

  it("an EXPIRED APPROVED proposal (approved, never executed) is finalised through the legal transition, consistently, and releases the slot", async () => {
    const h = await world(mk());
    const v = await propose(h);
    await approve(h, v);
    expect((await state(h, v)).proposal).toBe("APPROVED");
    h.clk.advance(TTL + 1_000);
    // …the stale pair is still "valid-looking" in the store until the lifecycle runs: nothing has read it
    const run2 = await newRun(h);
    const fresh = await propose(h, run2); // creating a conflicting proposal triggers the shared lifecycle step for THIS slot
    expect(fresh.proposal.status).toBe("PENDING");
    const old = await state(h, v);
    expect(old.proposal).toBe("EXPIRED");
    expect(old.op.state).toBe("CANCELLED");
    expect(old.op.transitions.at(-1)).toMatchObject({ from: "AWAITING_LIVE_APPROVAL", to: "CANCELLED", note: "approval_expired" });
    expect(await h.store.listLiveApprovals(v.proposal.id)).toHaveLength(1); // the human decision stays on record
    expect((await h.svc.status(OWNER, run2)).locks).toEqual([]);
    expect((await audit(h, "live.proposal_expired")).map((r) => JSON.parse(r.data))).toEqual([{ proposalId: v.proposal.id, from: "APPROVED" }]);
    // the same expired approval can never be executed afterwards
    expect(await code(h.svc.execute(v.proposal.id, OWNER, h.zip))).toBe("live_expired");
    expect(h.fake.calls).toEqual([]);
  });

  it("the new-application path uses the same lifecycle: an expired pending create-proposal does not block the next one", async () => {
    const h = await harness({ store: mk() });
    const first = await h.svc.createProposal(OWNER, { runId: h.runId, planId: "g2-small", appName: "brand-new-app", zip: h.zip });
    h.clk.advance(TTL + 1);
    const run2 = await newRun(h);
    const second = await h.svc.createProposal(OWNER, { runId: run2, planId: "g2-small", appName: "brand-new-app", zip: h.zip });
    expect(second.proposal.status).toBe("PENDING");
    expect((await state(h, first)).proposal).toBe("EXPIRED");
    expect((await state(h, first)).op.state).toBe("CANCELLED");
  });

  it("an unexpired APPROVED proposal remains valid and executes normally", async () => {
    const h = await world(mk());
    const v = await propose(h);
    await approve(h, v);
    h.clk.advance(TTL - 5_000);
    await h.svc.status(OWNER, h.runId); // lifecycle runs: nothing is due
    expect((await state(h, v)).proposal).toBe("APPROVED");
    const done = await settle(h, (await h.svc.execute(v.proposal.id, OWNER, h.zip)).id);
    expect(done.state).toBe("DEPLOYED");
    expect(await audit(h, "live.proposal_expired")).toHaveLength(0);
  });

  it("repeated expiration checks (status polls, direct calls, recovery) never duplicate a transition or an audit row; a proposal is finalised exactly once even when checked concurrently", async () => {
    const h = await world(mk());
    const v = await propose(h);
    await approve(h, v);
    h.clk.advance(TTL + 1);
    const results = await Promise.all([h.svc.expireIfDue(v.proposal.id), h.svc.expireIfDue(v.proposal.id), h.rebuild().expireIfDue(v.proposal.id), h.svc.expireIfDue(v.proposal.id)]);
    expect(results.filter(Boolean)).toHaveLength(1);
    for (let i = 0; i < 3; i++) await h.svc.status(OWNER, h.runId);
    expect(await h.svc.expireIfDue(v.proposal.id)).toBe(false);
    const op = (await state(h, v)).op;
    expect(op.transitions.filter((t) => t.to === "CANCELLED")).toHaveLength(1);
    expect(await audit(h, "live.proposal_expired")).toHaveLength(1);
  });

  it("start-up recovery finalises expired awaiting-approval operations (PENDING and APPROVED), and repeating it is idempotent", async () => {
    const h = await world(mk());
    const a = await propose(h);
    const h2 = await harness({ store: h.store, owner: OWNER, fake: h.fake });
    h2.fake.apps.add("second-existing-app");
    h2.fake.scope.add("second-existing-app");
    const b = await propose(h2, h2.runId, "second-existing-app");
    await h2.svc.decide(b.proposal.id, OWNER, { decision: "approve", digest: b.proposal.digest, confirmAppName: "second-existing-app" });
    h.clk.advance(TTL + 1);
    h2.clk.advance(TTL + 1);
    // a restarted process: only the constructor's recovery runs — nobody reads either proposal
    h.rebuild();
    expect(await wait(async () => (await state(h, a)).op.state === "CANCELLED" && (await state(h, b)).op.state === "CANCELLED")).toBe(true);
    expect([(await state(h, a)).proposal, (await state(h, b)).proposal]).toEqual(["EXPIRED", "EXPIRED"]);
    const before = JSON.stringify([await state(h, a), await state(h, b)]);
    const auditBefore = (await h.store.readAudit(5000)).length;
    h.rebuild();
    h.rebuild();
    await new Promise((r) => setTimeout(r, 60));
    expect(JSON.stringify([await state(h, a), await state(h, b)])).toBe(before);
    expect((await h.store.readAudit(5000)).length).toBe(auditBefore);
    expect(await audit(h, "live.proposal_expired")).toHaveLength(2);
  });

  it("an operation whose EXECUTION has started is never cancelled by proposal expiry (the proposal is CONSUMED); it completes", async () => {
    const h = await world(mk());
    let open!: () => void;
    const gate = new Promise<void>((r) => (open = r));
    const orig = h.fake.transport.uploadSource;
    h.fake.transport.uploadSource = async (...a) => (await gate, orig(...a));
    const v = await propose(h);
    await approve(h, v);
    const claimed = await h.svc.execute(v.proposal.id, OWNER, h.zip);
    expect(await wait(async () => (await h.store.getOperation(claimed.id))?.state === "UPLOADING_SOURCE")).toBe(true);
    h.clk.advance(TTL * 3); // far past the approval deadline, while the upload is in flight
    await h.svc.status(OWNER, h.runId);
    expect(await h.svc.expireIfDue(v.proposal.id)).toBe(false);
    expect((await state(h, v)).proposal).toBe("CONSUMED");
    expect((await h.store.getOperation(claimed.id))?.state).toBe("UPLOADING_SOURCE");
    open();
    expect((await settle(h, claimed.id)).state).toBe("DEPLOYED");
    expect(await audit(h, "live.proposal_expired")).toHaveLength(0);
  });

  it("terminal operations (DEPLOYED, FAILED, CANCELLED) are never rewritten by expiry, status polls or recovery", async () => {
    const h = await world(mk());
    // DEPLOYED
    const v1 = await propose(h);
    await approve(h, v1);
    const deployed = await settle(h, (await h.svc.execute(v1.proposal.id, OWNER, h.zip)).id);
    expect(deployed.state).toBe("DEPLOYED");
    // FAILED (abandoned after a review)
    h.fake.upload = "malformed";
    const v2 = await propose(h);
    await approve(h, v2);
    const review = await settle(h, (await h.svc.execute(v2.proposal.id, OWNER, h.zip)).id);
    await h.svc.resolve(review.id, OWNER, "abandon");
    // CANCELLED (manual)
    const v3 = await propose(h);
    await h.svc.cancel(v3.proposal.operationId, OWNER);
    const snap = async () => JSON.stringify(await Promise.all([deployed.id, review.id, v3.proposal.operationId].map((id) => h.store.getOperation(id))));
    const before = await snap();
    const liveAudit = async () => (await h.store.readAudit(5000)).filter((r) => r.event.startsWith("live.")).length;
    const auditBefore = await liveAudit();
    h.clk.advance(30 * 24 * 3600_000);
    const run2 = await newRun(h);
    await h.svc.status(OWNER, run2);
    h.rebuild();
    await new Promise((r) => setTimeout(r, 60));
    expect(await snap()).toBe(before);
    expect((await h.store.getOperation(deployed.id))?.state).toBe("DEPLOYED");
    expect((await h.store.getOperation(review.id))?.state).toBe("FAILED");
    expect((await h.store.getOperation(v3.proposal.operationId))?.state).toBe("CANCELLED");
    expect((await audit(h, "live.proposal_expired"))).toHaveLength(0);
    expect(await liveAudit()).toBe(auditBefore); // no live.* audit row was added by the sweep/recovery (the agent run created for the poll is not a live event)
  });

  it("manual cancellation of a pending proposal still works and frees the slot at once", async () => {
    const h = await world(mk());
    const v = await propose(h);
    await h.svc.cancel(v.proposal.operationId, OWNER);
    expect((await state(h, v)).proposal).toBe("CANCELLED");
    expect((await state(h, v)).op.state).toBe("CANCELLED");
    expect((await propose(h, await newRun(h))).proposal.status).toBe("PENDING");
  });
});

describe.each(backends)("expiry vs. execution can never produce an invalid state — %s", (_n, mk) => {
  it("around the deadline (just before / exactly at / just after) approve→execute races with several concurrent expiry checks: exactly one outcome, consistent everywhere", async () => {
    for (const offset of [-5, -1, 0, 1, 5]) {
      const h = await world(mk());
      const v = await propose(h);
      await approve(h, v);
      h.clk.advance(TTL + offset);
      const others = [h.rebuild(), h.rebuild()];
      await Promise.allSettled([h.svc.execute(v.proposal.id, OWNER, h.zip), h.svc.status(OWNER, h.runId), others[0]!.expireIfDue(v.proposal.id), others[1]!.status(OWNER, h.runId), h.svc.expireIfDue(v.proposal.id)]);
      await new Promise((r) => setTimeout(r, 30));
      const s = await state(h, v);
      const expiredEvents = await audit(h, "live.proposal_expired");
      if (offset < 0) {
        expect(s.proposal, `offset ${offset}`).toBe("CONSUMED"); // before the deadline execution wins, expiry cannot touch it
        expect(s.op.state).not.toBe("CANCELLED");
        expect(h.fake.calls.map((c) => c.op)).toContain("uploadSource");
        expect(expiredEvents).toHaveLength(0);
      } else {
        expect(s.proposal, `offset ${offset}`).toBe("EXPIRED"); // at/after the deadline expiry wins and execution cannot start
        expect(s.op.state).toBe("CANCELLED");
        expect(h.fake.calls).toEqual([]);
        expect(expiredEvents).toHaveLength(1);
      }
      expect(s.op.transitions.filter((t) => t.to === "CANCELLED").length).toBe(s.proposal === "EXPIRED" ? 1 : 0);
      if (s.proposal === "CONSUMED") await settle(h, s.op.id).catch(() => undefined);
    }
  });
});

describe("expiry never reaches into another slot", () => {
  it("an unexpired proposal of ANOTHER application or ANOTHER team keeps its lock when this slot's expired proposal is finalised", async () => {
    const h = await world();
    h.fake.apps.add("other-app");
    h.fake.scope.add("other-app");
    const a = await propose(h); // (team, liara-agent-demo): will expire
    h.clk.advance(TTL - 30_000);
    const b = await propose(h, await newRun(h), "other-app"); // another APPLICATION, created later ⇒ still valid
    const otherTeam = h.rebuild({ cfg: makeConfig(liveEnv({ LIARA_TEAM_ID: "team_other_x" })) });
    const c = await otherTeam.createExistingProposal(OWNER, { runId: await newRun(h), appName: APP, backend: "api", zip: h.zip }); // another TEAM, same app name ⇒ its own slot
    expect(c.proposal.status).toBe("PENDING");
    h.clk.advance(60_000); // A is expired now; B and C (created 30 s before the deadline of A) are not
    const a2 = await propose(h, await newRun(h)); // asks for A's slot
    expect(a2.proposal.status).toBe("PENDING");
    expect((await state(h, a)).proposal).toBe("EXPIRED");
    for (const x of [b, c]) {
      expect((await state(h, x)).proposal).toBe("PENDING");
      expect((await state(h, x)).op.state).toBe("AWAITING_LIVE_APPROVAL");
    }
    await h.svc.status(OWNER, h.runId); // a full sweep: nothing else is due, nothing else changes
    expect((await state(h, b)).proposal).toBe("PENDING");
    expect((await state(h, c)).proposal).toBe("PENDING");
    expect((await state(h, a2)).proposal).toBe("PENDING"); // the new, valid proposal is never expired by a sweep
    expect(await audit(h, "live.proposal_expired")).toHaveLength(1);
  });
  it("creating a proposal finalises ONLY its own slot's expired proposal; another application's expired one waits for its own trigger (status poll / recovery)", async () => {
    const h = await world();
    h.fake.apps.add("other-app");
    h.fake.scope.add("other-app");
    const b = await propose(h, h.runId, "other-app");
    h.clk.advance(TTL + 1);
    const runA = await newRun(h);
    const a = await propose(h, runA);
    expect(a.proposal.status).toBe("PENDING");
    expect((await state(h, b)).proposal).toBe("PENDING");
    await h.svc.status(OWNER, runA);
    expect((await state(h, b)).proposal).toBe("EXPIRED");
    expect((await state(h, a)).proposal).toBe("PENDING");
  });
});
