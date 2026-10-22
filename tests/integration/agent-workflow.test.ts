import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { afterAll, describe, expect, it } from "vitest";
import { AGENT_NEXT, AgentRunManager } from "@/server/agent/manager";
import { SimulatedExecutionBackend, type ExecutionBackend } from "@/server/agent/simulation/backend";
import { MAX_MESSAGES_PER_CONVERSATION, MemoryAgentStore, SqliteAgentStore } from "@/server/agent/store";
import type { ActionProposal } from "@/server/agent/types";
import { MockDiagnosticLLMProvider } from "@/server/diagnostics/llm";
import { assertNoCanary } from "../helpers/canaries";
import { A, ask, B, mkAgent, toProposal } from "../helpers/agent";
import { NOW } from "../helpers/evidence-builder";
import { mockSvc } from "../helpers/scenario-runner";

const tmp = mkdtempSync(path.join(tmpdir(), "liara-agent-"));
afterAll(() => rmSync(tmp, { recursive: true, force: true }));

class SpyBackend implements ExecutionBackend {
  readonly kind = "simulation" as const;
  calls: ActionProposal[] = [];
  inner = new SimulatedExecutionBackend();
  async execute(p: ActionProposal, nowIso: string) {
    this.calls.push(p);
    return this.inner.execute(p, nowIso);
  }
}
const phases = (run: { transitions: { to: string }[] }) => run.transitions.map((t) => t.to);

describe("state machine definition", () => {
  it("only documented forward transitions exist", () => {
    expect(AGENT_NEXT.REQUEST_RECEIVED).toEqual(["INTENT_RESOLVED"]);
    expect(AGENT_NEXT.AWAITING_APPROVAL).toEqual(["APPROVED", "REJECTED", "EXPIRED"]);
    expect(AGENT_NEXT.APPROVED).toEqual(["SIMULATION_COMPLETED", "SIMULATION_RUNNING"]);
    // no phase leads directly from a report to execution
    expect(AGENT_NEXT.REPORT_READY).toEqual(["ACTION_PROPOSED"]);
    expect(AGENT_NEXT.ACTION_PROPOSED).toEqual(["AWAITING_APPROVAL"]);
  });
});

describe("Scenario A — HTTP 500: grounded diagnosis and evidence inspection", () => {
  it("walks the audited phases, cites evidence, and explains a finding without new tool calls", async () => {
    const { m } = mkAgent();
    const r = await ask(m, "برنامه demo-http500 خطای ۵۰۰ می‌دهد، بررسی کن");
    expect(r.messages.map((x) => x.kind)).toEqual(["user", "ack"]);
    const { run } = await m.getRun(r.runId!, A);
    expect(run).toMatchObject({ status: "READY", phase: "REPORT_READY", intent: "investigate_http500", app: "demo-http500", mode: "mock" });
    expect(phases(run)).toEqual(["REQUEST_RECEIVED", "INTENT_RESOLVED", "PLAN_CREATED", "COLLECTING_EVIDENCE", "ANALYZING", "REPORT_READY", "READY"]);
    expect(run.plan!.steps.length).toBeGreaterThan(3);
    expect(run.toolCalls.every((t) => t.status === "succeeded")).toBe(true);
    expect(run.report!.summary.primaryKey).toBe("http_500");
    expect(run.report!.hypotheses[0]!.evidenceIds.length).toBeGreaterThan(0);

    const callsBefore = run.toolCalls.length;
    const x = await ask(m, "علت اول را توضیح بده", A, r.conversationId);
    expect(x.messages.at(-1)).toMatchObject({ kind: "explanation", runId: run.id });
    expect((await m.getRun(run.id, A)).run.toolCalls.length).toBe(callsBefore);
  });

  it("there is nothing to remediate for HTTP 500, and the agent says so instead of inventing an action", async () => {
    const { m } = mkAgent();
    const r = await ask(m, "demo-http500 خطای ۵۰۰ می‌دهد");
    const s = await ask(m, "یک طرح اصلاحی شبیه‌سازی‌شده بساز", A, r.conversationId);
    expect(s.proposalId).toBeNull();
    expect(s.messages.at(-1)).toMatchObject({ kind: "refusal" });
  });
});

describe("Scenario B — repeated restarts → database failure → simulated proposal", () => {
  it("produces a grounded diagnosis and a pending, immutable R1 simulated proposal", async () => {
    const { m } = mkAgent();
    const t = await toProposal(m, "چرا demo-api مدام ری‌استارت می‌شود؟");
    const { run, proposals } = await m.getRun(t.runId, A);
    expect(run.report!.summary.primaryKey).toBe("restart_loop_db_connection_refused");
    expect(run).toMatchObject({ status: "READY", phase: "AWAITING_APPROVAL" });
    expect(phases(run).slice(-3)).toEqual(["READY", "ACTION_PROPOSED", "AWAITING_APPROVAL"]);
    const p = proposals[0]!.proposal;
    expect(p).toMatchObject({ status: "PENDING", operation: "restart_app", risk: "R1", executionMode: "simulation", app: "demo-api", confirmation: "click" });
    expect(p.digest).toMatch(/^[0-9a-f]{64}$/);
    expect(p.evidenceIds.length).toBeGreaterThan(0);
    expect(Date.parse(p.expiresAt) - Date.parse(p.createdAt)).toBe(600_000);
    expect(proposals[0]!.result).toBeNull();
  });
  it("R2 proposals (plan change) require typing the app name and expire sooner", async () => {
    const { m } = mkAgent();
    const t = await toProposal(m, "demo-oom مدام ری‌استارت می‌شود");
    expect(t.view.proposal).toMatchObject({ operation: "change_plan", risk: "R2", confirmation: "type_app_name" });
    expect(Date.parse(t.view.proposal.expiresAt) - Date.parse(t.view.proposal.createdAt)).toBe(300_000);
  });
  it("only one open proposal per run, and a run can't be proposed before its report is ready", async () => {
    const { m } = mkAgent();
    const t = await toProposal(m, "چرا demo-api مدام ری‌استارت می‌شود؟");
    await expect(m.propose(t.runId, A, {})).rejects.toMatchObject({ code: "proposal_pending" });
    const s = await ask(m, "یک طرح اصلاحی شبیه‌سازی‌شده بساز", A, t.conversationId);
    expect(s.proposalId).toBeNull();
  });
});

describe("Scenario C — approve → simulated execution → simulated verification", () => {
  it("runs only the simulator and never claims a real operation", async () => {
    const spy = new SpyBackend();
    const { m } = mkAgent({ backend: spy });
    const t = await toProposal(m, "چرا demo-api مدام ری‌استارت می‌شود؟");
    const v = await m.decide(t.proposalId, A, { decision: "approve", digest: t.view.proposal.digest });
    expect(spy.calls).toHaveLength(1);
    expect(v.proposal.status).toBe("SIMULATED_OK");
    expect(v.result).toMatchObject({ simulated: true, outcome: "succeeded", verification: { outcome: "success" } });
    expect(v.approvals).toHaveLength(1);
    expect(v.approvals[0]).toMatchObject({ decision: "approve", outcome: "accepted", digest: t.view.proposal.digest });
    const { run } = await m.getRun(t.runId, A);
    expect(phases(run).slice(-5)).toEqual(["ACTION_PROPOSED", "AWAITING_APPROVAL", "APPROVED", "SIMULATION_COMPLETED", "REPORT_READY"]);
    const conv = await m.getConversationView(t.conversationId, A);
    const last = conv.messages.filter((x) => x.kind === "simulation").at(-1)!;
    expect(last.textFa).toContain("شبیه‌سازی");
    expect(last.textFa).toMatch(/واقعی/);
  });
  it("R2 approval needs the exact typed app name", async () => {
    const { m } = mkAgent();
    const t = await toProposal(m, "demo-oom مدام ری‌استارت می‌شود");
    const d = t.view.proposal.digest;
    for (const typed of [undefined, "", "demo-oom ", "DEMO-OOM", "demo-api", 5, null]) await expect(m.decide(t.proposalId, A, { decision: "approve", digest: d, confirmAppName: typed })).rejects.toMatchObject({ code: "confirmation_required" });
    expect((await m.getRun(t.runId, A)).proposals[0]!.proposal.status).toBe("PENDING"); // failed confirmation neither burns nor approves
    const v = await m.decide(t.proposalId, A, { decision: "approve", digest: d, confirmAppName: "demo-oom" });
    expect(v.result?.simulated).toBe(true);
  });
  it("a simulated operation failure is reported as failed, a verification failure as a failed verification", async () => {
    const opFail = mkAgent({ backend: new SimulatedExecutionBackend(() => "operation_failure") });
    const t1 = await toProposal(opFail.m, "چرا demo-api مدام ری‌استارت می‌شود؟");
    const v1 = await opFail.m.decide(t1.proposalId, A, { decision: "approve", digest: t1.view.proposal.digest });
    expect(v1.proposal.status).toBe("SIMULATED_FAILED");
    expect(v1.result).toMatchObject({ simulated: true, outcome: "failed", verification: { outcome: "not_run" } });

    const vFail = mkAgent({ backend: new SimulatedExecutionBackend(() => "verification_failure") });
    const t2 = await toProposal(vFail.m, "چرا demo-api مدام ری‌استارت می‌شود؟");
    const v2 = await vFail.m.decide(t2.proposalId, A, { decision: "approve", digest: t2.view.proposal.digest });
    expect(v2.proposal.status).toBe("VERIFICATION_FAILED");
    expect(v2.result?.verification?.outcome).toBe("failure");
  });
  it("after a finished simulation a new proposal may be created (bounded to 3)", async () => {
    const { m } = mkAgent();
    const t = await toProposal(m, "چرا demo-api مدام ری‌استارت می‌شود؟");
    await m.decide(t.proposalId, A, { decision: "approve", digest: t.view.proposal.digest });
    // the same recommendation is not proposed again while its simulation stands
    await expect(m.propose(t.runId, A, {})).rejects.toMatchObject({ code: "no_applicable_operation" });
  });
});

describe("Scenario D — rejection", () => {
  it("rejecting executes nothing, records the decision and returns to REPORT_READY", async () => {
    const spy = new SpyBackend();
    const { m } = mkAgent({ backend: spy });
    const t = await toProposal(m, "چرا demo-api مدام ری‌استارت می‌شود؟");
    const v = await m.decide(t.proposalId, A, { decision: "reject", digest: t.view.proposal.digest });
    expect(spy.calls).toHaveLength(0);
    expect(v.proposal.status).toBe("REJECTED");
    expect(v.result).toBeNull();
    expect(v.approvals[0]).toMatchObject({ decision: "reject", outcome: "rejected" });
    const { run } = await m.getRun(t.runId, A);
    expect(phases(run).slice(-4)).toEqual(["ACTION_PROPOSED", "AWAITING_APPROVAL", "REJECTED", "REPORT_READY"]);
    await expect(m.decide(t.proposalId, A, { decision: "approve", digest: t.view.proposal.digest })).rejects.toMatchObject({ code: "already_decided" });
    expect(spy.calls).toHaveLength(0);
  });
  it("cancelling an open proposal closes the branch without executing", async () => {
    const spy = new SpyBackend();
    const { m } = mkAgent({ backend: spy });
    const t = await toProposal(m, "چرا demo-api مدام ری‌استارت می‌شود؟");
    await m.cancel(t.runId, A);
    const { proposals, run } = await m.getRun(t.runId, A);
    expect(proposals[0]!.proposal.status).toBe("CANCELLED");
    expect(run.phase).toBe("REPORT_READY");
    await expect(m.decide(t.proposalId, A, { decision: "approve", digest: t.view.proposal.digest })).rejects.toMatchObject({ code: "already_decided" });
    expect(spy.calls).toHaveLength(0);
  });
});

describe("Scenario E — expiry, changed parameters, drift", () => {
  it("an expired proposal cannot be approved, exactly once EXPIRED, nothing executed", async () => {
    const spy = new SpyBackend();
    const { m, clk } = mkAgent({ backend: spy });
    const t = await toProposal(m, "چرا demo-api مدام ری‌استارت می‌شود؟");
    clk.advance(10 * 60_000 + 1000);
    await expect(m.decide(t.proposalId, A, { decision: "approve", digest: t.view.proposal.digest })).rejects.toMatchObject({ code: "expired" });
    expect(spy.calls).toHaveLength(0);
    const { proposals, run } = await m.getRun(t.runId, A);
    expect(proposals[0]!.proposal.status).toBe("EXPIRED");
    expect(run.phase).toBe("REPORT_READY");
    expect(phases(run)).toContain("EXPIRED");
    await expect(m.decide(t.proposalId, A, { decision: "approve", digest: t.view.proposal.digest })).rejects.toMatchObject({ code: "already_decided" });
    const msgs = (await m.getConversationView(t.conversationId, A)).messages.filter((x) => x.kind === "decision");
    expect(msgs).toHaveLength(1); // expiry announced once
  });
  it("expiry is evaluated against the server clock at the exact boundary", async () => {
    const { m, clk } = mkAgent();
    const t = await toProposal(m, "چرا demo-api مدام ری‌استارت می‌شود؟");
    clk.advance(10 * 60_000 - 1000);
    const v = await m.decide(t.proposalId, A, { decision: "approve", digest: t.view.proposal.digest });
    expect(v.proposal.status).toBe("SIMULATED_OK");
  });
  it("viewing the conversation after the deadline lazily expires the proposal", async () => {
    const { m, clk } = mkAgent();
    const t = await toProposal(m, "چرا demo-api مدام ری‌استارت می‌شود؟");
    clk.advance(11 * 60_000);
    const view = await m.getConversationView(t.conversationId, A);
    expect(view.proposals[0]!.proposal.status).toBe("EXPIRED");
  });
  it("a digest of modified parameters/app/risk is rejected and does not consume the proposal", async () => {
    const spy = new SpyBackend();
    const { m } = mkAgent({ backend: spy });
    const t = await toProposal(m, "چرا demo-api مدام ری‌استارت می‌شود؟");
    const forged = [
      "0".repeat(64), "f".repeat(64), t.view.proposal.digest.toUpperCase(), t.view.proposal.digest.slice(0, 63), t.view.proposal.digest + "0", "", undefined, null, 1, {},
    ];
    for (const digest of forged) await expect(m.decide(t.proposalId, A, { decision: "approve", digest })).rejects.toMatchObject({ code: "digest_mismatch" });
    expect(spy.calls).toHaveLength(0);
    expect((await m.getRun(t.runId, A)).proposals[0]!.proposal.status).toBe("PENDING");
    const ok = await m.decide(t.proposalId, A, { decision: "approve", digest: t.view.proposal.digest });
    expect(ok.proposal.status).toBe("SIMULATED_OK");
  });
  it("state drift between proposal and approval blocks the approval", async () => {
    const spy = new SpyBackend();
    let fp = "a".repeat(64);
    const { m } = mkAgent({ backend: spy, stateProbe: async () => fp });
    const t = await toProposal(m, "چرا demo-api مدام ری‌استارت می‌شود؟");
    fp = "b".repeat(64);
    await expect(m.decide(t.proposalId, A, { decision: "approve", digest: t.view.proposal.digest })).rejects.toMatchObject({ code: "blocked_drift" });
    expect(spy.calls).toHaveLength(0);
    const { proposals, run } = await m.getRun(t.runId, A);
    expect(proposals[0]!.proposal.status).toBe("BLOCKED");
    expect(proposals[0]!.approvals[0]).toMatchObject({ outcome: "blocked_drift" });
    expect(run.phase).toBe("REPORT_READY");
  });
  it("fails closed when the current state cannot be verified", async () => {
    let fp: string | null = "a".repeat(64);
    const { m } = mkAgent({ stateProbe: async () => fp });
    const t = await toProposal(m, "چرا demo-api مدام ری‌استارت می‌شود؟");
    fp = null;
    await expect(m.decide(t.proposalId, A, { decision: "approve", digest: t.view.proposal.digest })).rejects.toMatchObject({ code: "blocked_drift" });
  });
  it("a proposal cannot even be created when the state is unobservable", async () => {
    const { m } = mkAgent({ stateProbe: async () => null });
    const first = await ask(m, "چرا demo-api مدام ری‌استارت می‌شود؟");
    const s = await ask(m, "یک طرح اصلاحی شبیه‌سازی‌شده بساز", A, first.conversationId);
    expect(s.proposalId).toBeNull();
  });
  it("rejecting is still allowed after drift (operator may always say no)", async () => {
    let fp = "a".repeat(64);
    const { m } = mkAgent({ stateProbe: async () => fp });
    const t = await toProposal(m, "چرا demo-api مدام ری‌استارت می‌شود؟");
    fp = "c".repeat(64);
    expect((await m.decide(t.proposalId, A, { decision: "reject", digest: t.view.proposal.digest })).proposal.status).toBe("REJECTED");
  });
});

describe("Scenario G — insufficient evidence", () => {
  it("a healthy app yields no confident diagnosis, no proposal, and asks for more information", async () => {
    const { m } = mkAgent();
    const r = await ask(m, "چرا demo-shop مدام ری‌استارت می‌شود؟");
    const { run } = await m.getRun(r.runId!, A);
    expect(run.report!.summary.primaryKey).toBeNull();
    expect(run.report!.summary.overallConfidence).not.toBe("high");
    const s = await ask(m, "یک طرح اصلاحی شبیه‌سازی‌شده بساز", A, r.conversationId);
    expect(s.proposalId).toBeNull();
    expect(s.messages.at(-1)!.kind).toBe("refusal");
  });
  it("missing evidence sources are listed rather than hidden", async () => {
    const { m } = mkAgent();
    const r = await ask(m, "وضعیت سلامت demo-stale را بررسی کن");
    const { run } = await m.getRun(r.runId!, A);
    expect(run.report!.limitations.length + run.report!.missingEvidence.length + run.report!.caveats.length).toBeGreaterThan(0);
    expect(run.plan!.missingInformationFa.length).toBeGreaterThan(0);
  });
});

describe("approval security", () => {
  it("invalid decision values are rejected and never treated as approval", async () => {
    const { m } = mkAgent();
    const t = await toProposal(m, "چرا demo-api مدام ری‌استارت می‌شود؟");
    for (const decision of [true, "approved", "APPROVE", "yes", "approved=true", 1, null, undefined, { approve: true }, ["approve"]]) {
      await expect(m.decide(t.proposalId, A, { decision, digest: t.view.proposal.digest })).rejects.toMatchObject({ code: "invalid_decision" });
    }
    expect((await m.getRun(t.runId, A)).proposals[0]!.proposal.status).toBe("PENDING");
  });
  it("only the owning session can decide; others see 'not found' and nothing changes", async () => {
    const spy = new SpyBackend();
    const { m } = mkAgent({ backend: spy });
    const t = await toProposal(m, "چرا demo-api مدام ری‌استارت می‌شود؟");
    await expect(m.decide(t.proposalId, B, { decision: "approve", digest: t.view.proposal.digest })).rejects.toMatchObject({ code: "not_found" });
    await expect(m.decide("prop_20260102040000_00000000", A, { decision: "approve", digest: t.view.proposal.digest })).rejects.toMatchObject({ code: "not_found" });
    await expect(m.getRun(t.runId, B)).rejects.toMatchObject({ code: "not_found" });
    await expect(m.getConversationView(t.conversationId, B)).rejects.toMatchObject({ code: "not_found" });
    await expect(m.cancel(t.runId, B)).rejects.toMatchObject({ code: "not_found" });
    expect(spy.calls).toHaveLength(0);
    expect((await m.getRun(t.runId, A)).proposals[0]!.proposal.status).toBe("PENDING");
  });
  it("replay of an approval is rejected and executes nothing a second time", async () => {
    const spy = new SpyBackend();
    const { m } = mkAgent({ backend: spy });
    const t = await toProposal(m, "چرا demo-api مدام ری‌استارت می‌شود؟");
    await m.decide(t.proposalId, A, { decision: "approve", digest: t.view.proposal.digest });
    for (let i = 0; i < 3; i++) await expect(m.decide(t.proposalId, A, { decision: "approve", digest: t.view.proposal.digest })).rejects.toMatchObject({ code: "already_decided" });
    expect(spy.calls).toHaveLength(1);
    const v = (await m.getRun(t.runId, A)).proposals[0]!;
    expect(v.approvals).toHaveLength(1);
  });
  it("concurrent approvals authorise exactly once", async () => {
    const spy = new SpyBackend();
    const { m } = mkAgent({ backend: spy });
    const t = await toProposal(m, "چرا demo-api مدام ری‌استارت می‌شود؟");
    const results = await Promise.allSettled(Array.from({ length: 8 }, () => m.decide(t.proposalId, A, { decision: "approve", digest: t.view.proposal.digest })));
    expect(results.filter((r) => r.status === "fulfilled")).toHaveLength(1);
    for (const r of results) if (r.status === "rejected") expect(r.reason).toMatchObject({ code: "already_decided" });
    expect(spy.calls).toHaveLength(1);
    expect((await m.getRun(t.runId, A)).proposals[0]!.approvals.filter((a) => a.outcome === "accepted")).toHaveLength(1);
  });
  it("concurrent approve and reject: exactly one wins, and rejection can never execute", async () => {
    const spy = new SpyBackend();
    const { m } = mkAgent({ backend: spy });
    const t = await toProposal(m, "چرا demo-api مدام ری‌استارت می‌شود؟");
    const rs = await Promise.allSettled([
      m.decide(t.proposalId, A, { decision: "approve", digest: t.view.proposal.digest }),
      m.decide(t.proposalId, A, { decision: "reject", digest: t.view.proposal.digest }),
    ]);
    expect(rs.filter((r) => r.status === "fulfilled")).toHaveLength(1);
    const st = (await m.getRun(t.runId, A)).proposals[0]!.proposal.status;
    expect(spy.calls.length).toBe(st === "REJECTED" ? 0 : 1);
  });
  it("expiry racing the approval (clock jumps while the decision is in flight) never executes", async () => {
    const spy = new SpyBackend();
    const holder: { clk?: { advance(ms: number): number } } = {};
    const { m, clk } = mkAgent({ backend: spy, hooks: { beforeDecision: () => void holder.clk?.advance(11 * 60_000) } });
    holder.clk = clk;
    const t = await toProposal(m, "چرا demo-api مدام ری‌استارت می‌شود؟");
    await expect(m.decide(t.proposalId, A, { decision: "approve", digest: t.view.proposal.digest })).rejects.toMatchObject({ code: "expired" });
    expect(spy.calls).toHaveLength(0);
  });
  it("tampering with the stored proposal (app, params, risk, mode, expiry) is detected, blocks it, and executes nothing", async () => {
    const patches: Partial<ActionProposal>[] = [{ app: "demo-oom" }, { operation: "stop_app" }, { params: { force: true } }, { risk: "R0" as never }, { executionMode: "live" as never }, { expiresAt: "2099-01-01T00:00:00.000Z" }, { descriptionFa: "rewritten" }];
    for (const patch of patches) {
      const spy = new SpyBackend();
      const store = new MemoryAgentStore();
      const { m } = mkAgent({ backend: spy, store });
      const t = await toProposal(m, "چرا demo-api مدام ری‌استارت می‌شود؟");
      store.__tamperProposal(t.proposalId, patch);
      // a retargeted app is caught even earlier (the proposal no longer matches its run): "not found"; everything else is "tampered"
      const expected = patch.app ? "not_found" : "proposal_tampered";
      await expect(m.decide(t.proposalId, A, { decision: "approve", digest: t.view.proposal.digest }), JSON.stringify(patch)).rejects.toMatchObject({ code: expected });
      expect(spy.calls).toHaveLength(0);
      expect((await store.getProposal(t.proposalId))!.proposal.status).toBe(patch.app ? "PENDING" : "BLOCKED");
    }
  });
  it("a tampered proposal that re-computes a matching digest still fails policy (risk/mode/app are re-evaluated)", async () => {
    const { proposalDigest, contentOf } = await import("@/server/agent/policy");
    const spy = new SpyBackend();
    const store = new MemoryAgentStore();
    const { m } = mkAgent({ backend: spy, store });
    const t = await toProposal(m, "چرا demo-api مدام ری‌استارت می‌شود؟");
    const forged = { ...t.view.proposal, operation: "stop_app" as const, risk: "R1" as const };
    const digest = proposalDigest(contentOf(forged));
    store.__tamperProposal(t.proposalId, { operation: "stop_app", risk: "R1", digest } as Partial<ActionProposal>);
    await expect(m.decide(t.proposalId, A, { decision: "approve", digest })).rejects.toBeTruthy();
    expect(spy.calls).toHaveLength(0);
  });
  it("the audit log records the lifecycle and its hash chain verifies", async () => {
    const { m, store } = mkAgent();
    const t = await toProposal(m, "چرا demo-api مدام ری‌استارت می‌شود؟");
    await m.decide(t.proposalId, A, { decision: "reject", digest: t.view.proposal.digest });
    const events = (await store.readAudit(500)).map((r) => r.event);
    for (const e of ["agent.conversation_created", "agent.intent_parsed", "agent.run_created", "agent.tool_call", "agent.proposal_created", "agent.proposal_rejected"]) expect(events).toContain(e);
    expect(await store.verifyAudit()).toMatchObject({ ok: true });
    assertNoCanary(JSON.stringify(await store.readAudit(500)));
  });
  it("audit rows never contain the full session id", async () => {
    const { m, store } = mkAgent();
    await toProposal(m, "چرا demo-api مدام ری‌استارت می‌شود؟");
    expect(JSON.stringify(await store.readAudit(500))).not.toContain(A);
  });
});

describe("run lifecycle: quotas, duplicates, cancel, retry, timeouts", () => {
  it("a second concurrent run for the same app is refused with a clear message", async () => {
    let release!: () => void;
    const gate = new Promise<void>((r) => (release = r));
    const { m } = mkAgent({ hooks: { afterTool: () => gate } });
    const first = await m.handleMessage({ sessionId: A, text: "چرا demo-api مدام ری‌استارت می‌شود؟" });
    const second = await m.handleMessage({ sessionId: A, text: "چرا demo-api مدام ری‌استارت می‌شود؟" });
    expect(second.runId).toBe(first.runId);
    expect(second.messages.at(-1)).toMatchObject({ kind: "refusal" });
    release();
    await m.waitFor(first.runId!);
  });
  it("maxConcurrentRuns is enforced across apps", async () => {
    let release!: () => void;
    const gate = new Promise<void>((r) => (release = r));
    const { m } = mkAgent({ maxConcurrentRuns: 1, hooks: { afterTool: () => gate } });
    const a = await m.handleMessage({ sessionId: A, text: "چرا demo-api مدام ری‌استارت می‌شود؟" });
    const b = await m.handleMessage({ sessionId: B, text: "چرا demo-oom مدام ری‌استارت می‌شود؟" });
    expect(b.runId).toBeNull();
    expect(b.messages.at(-1)!.kind).toBe("refusal");
    release();
    await m.waitFor(a.runId!);
  });
  it("per-session quota is enforced", async () => {
    const { m } = mkAgent({ quotaPerWindow: 2 });
    await ask(m, "چرا demo-api مدام ری‌استارت می‌شود؟");
    await ask(m, "چرا demo-oom مدام ری‌استارت می‌شود؟");
    const third = await ask(m, "چرا demo-cpu مدام ری‌استارت می‌شود؟");
    expect(third.runId).toBeNull();
    expect(third.messages.at(-1)!.kind).toBe("refusal");
    // another session has its own quota
    expect((await ask(m, "چرا demo-cpu مدام ری‌استارت می‌شود؟", B)).runId).not.toBeNull();
  });
  it("cancelling a running investigation ends it as CANCELLED and keeps the audit trail", async () => {
    let release!: () => void;
    const gate = new Promise<void>((r) => (release = r));
    const { m } = mkAgent({ hooks: { afterTool: () => gate } });
    const r = await m.handleMessage({ sessionId: A, text: "چرا demo-api مدام ری‌استارت می‌شود؟" });
    await new Promise((x) => setTimeout(x, 20));
    const cancelled = m.cancel(r.runId!, A);
    release();
    expect((await cancelled).status).toBe("CANCELLED");
    expect((await m.getRun(r.runId!, A)).run.transitions.at(-1)!.to).toBe("CANCELLED");
  });
  it("a run that exceeds its timeout is TIMED_OUT and can be retried (bounded chain)", async () => {
    const { m } = mkAgent({ runTimeoutMs: 30, hooks: { afterTool: () => new Promise((r) => setTimeout(r, 400)) } });
    const r = await ask(m, "چرا demo-api مدام ری‌استارت می‌شود؟");
    const run1 = (await m.getRun(r.runId!, A)).run;
    expect(run1.status).toBe("TIMED_OUT");
    const retry = await m.retry(run1.id, A);
    await m.waitFor(retry.id);
    const run2 = (await m.getRun(retry.id, A)).run;
    expect(run2.retryOf).toBe(run1.id);
    expect(run2.status).toBe("TIMED_OUT");
    const retry2 = await m.retry(run2.id, A);
    await m.waitFor(retry2.id);
    await expect(m.retry(retry2.id, A)).rejects.toMatchObject({ code: "retry_not_allowed" });
  });
  it("retry is refused for completed runs", async () => {
    const { m } = mkAgent();
    const r = await ask(m, "چرا demo-api مدام ری‌استارت می‌شود؟");
    await expect(m.retry(r.runId!, A)).rejects.toMatchObject({ code: "retry_not_allowed" });
  });
  it("conversation size is bounded", async () => {
    const { m } = mkAgent();
    let conv: string | null = null;
    let err: unknown;
    for (let i = 0; i < MAX_MESSAGES_PER_CONVERSATION + 5 && !err; i++) {
      try {
        conv = (await m.handleMessage({ sessionId: A, conversationId: conv, text: "سلام" })).conversationId;
      } catch (e) {
        err = e;
      }
    }
    expect(err).toMatchObject({ code: "conversation_full" });
    expect((await m.getConversationView(conv!, A)).messages.length).toBeLessThanOrEqual(MAX_MESSAGES_PER_CONVERSATION);
  });
  it("evidence reuse: a repeated question within the TTL reuses fresh evidence (fewer tool calls)", async () => {
    const { m } = mkAgent();
    const a = await ask(m, "چرا demo-api مدام ری‌استارت می‌شود؟");
    const b = await ask(m, "چرا demo-api مدام ری‌استارت می‌شود؟", A, a.conversationId);
    const ra = (await m.getRun(a.runId!, A)).run;
    const rb = (await m.getRun(b.runId!, A)).run;
    expect(rb.toolCalls.length).toBeLessThan(ra.toolCalls.length);
    expect(rb.plan!.skipped.some((s) => s.code === "reused_evidence")).toBe(true);
    expect(rb.report!.summary.primaryKey).toBe(ra.report!.summary.primaryKey);
  });
});

describe("provider modes", () => {
  it("works with the disabled provider (deterministic narrative only)", async () => {
    const { DisabledLiveLLMProvider } = await import("@/server/diagnostics/llm/disabled");
    const { m } = mkAgent({ provider: new DisabledLiveLLMProvider() });
    const r = await ask(m, "چرا demo-api مدام ری‌استارت می‌شود؟");
    const { run } = await m.getRun(r.runId!, A);
    expect(run.status).toBe("READY");
    expect(run.report!.summary.primaryKey).toBe("restart_loop_db_connection_refused");
  });
});

describe("persistence (SQLite)", () => {
  const file = (n: string) => path.join(tmp, `${n}.db`);
  const mk = (f: string, over: Record<string, unknown> = {}) => new AgentRunManager({ svc: mockSvc(), store: new SqliteAgentStore(f), provider: new MockDiagnosticLLMProvider("ok"), now: () => NOW, runTimeoutMs: 8000, quotaPerWindow: 99, maxConcurrentRuns: 9, ...over });

  it("conversations, runs, proposals and approvals survive a restart; a pending proposal can still be decided by its owner", async () => {
    const f = file("restart");
    const m1 = mk(f);
    const t = await toProposal(m1, "چرا demo-api مدام ری‌استارت می‌شود؟");
    const m2 = mk(f); // "process restart": new manager, new store handle on the same file
    const view = await m2.getConversationView(t.conversationId, A);
    expect(view.messages.length).toBeGreaterThanOrEqual(5);
    expect(view.proposals[0]!.proposal).toMatchObject({ status: "PENDING", digest: t.view.proposal.digest, stateFingerprint: t.view.proposal.stateFingerprint });
    await expect(m2.decide(t.proposalId, B, { decision: "approve", digest: t.view.proposal.digest })).rejects.toMatchObject({ code: "not_found" });
    const done = await m2.decide(t.proposalId, A, { decision: "approve", digest: t.view.proposal.digest });
    expect(done.proposal.status).toBe("SIMULATED_OK");
    const m3 = mk(f);
    const again = (await m3.getRun(t.runId, A)).proposals[0]!;
    expect(again.result).toMatchObject({ simulated: true });
    expect(again.approvals).toHaveLength(1);
  });

  it("two managers on the same database cannot double-authorise", async () => {
    const f = file("double");
    const s1 = new SpyBackend();
    const s2 = new SpyBackend();
    const m1 = mk(f, { backend: s1 });
    const m2 = mk(f, { backend: s2 });
    const t = await toProposal(m1, "چرا demo-api مدام ری‌استارت می‌شود؟");
    const rs = await Promise.allSettled([
      m1.decide(t.proposalId, A, { decision: "approve", digest: t.view.proposal.digest }),
      m2.decide(t.proposalId, A, { decision: "approve", digest: t.view.proposal.digest }),
      m1.decide(t.proposalId, A, { decision: "approve", digest: t.view.proposal.digest }),
      m2.decide(t.proposalId, A, { decision: "approve", digest: t.view.proposal.digest }),
    ]);
    expect(rs.filter((r) => r.status === "fulfilled")).toHaveLength(1);
    expect(s1.calls.length + s2.calls.length).toBe(1);
  });

  it("runs interrupted by a crash are recovered as FAILED, never left RUNNING, and can be retried", async () => {
    const f = file("crash");
    let release!: () => void;
    const gate = new Promise<void>((r) => (release = r));
    const m1 = mk(f, { hooks: { afterTool: () => gate } });
    const r = await m1.handleMessage({ sessionId: A, text: "چرا demo-api مدام ری‌استارت می‌شود؟" });
    await new Promise((x) => setTimeout(x, 30));
    const m2 = mk(f); // the old process "dies": the new one recovers on start
    const run = (await m2.getRun(r.runId!, A)).run;
    expect(run).toMatchObject({ status: "FAILED", errorCode: "interrupted_by_restart" });
    const retry = await m2.retry(run.id, A);
    await m2.waitFor(retry.id);
    expect((await m2.getRun(retry.id, A)).run.status).toBe("READY");
    release();
    await m1.waitFor(r.runId!);
  });

  it("a row modified directly in the database (proposal params) is detected at decision time", async () => {
    const f = file("rowtamper");
    const store = new SqliteAgentStore(f);
    const m = new AgentRunManager({ svc: mockSvc(), store, provider: new MockDiagnosticLLMProvider("ok"), now: () => NOW, runTimeoutMs: 8000 });
    const t = await toProposal(m, "چرا demo-api مدام ری‌استارت می‌شود؟");
    const rows = store.__allAgent("SELECT * FROM proposals WHERE id=?", t.proposalId) as Record<string, unknown>[];
    const jsonCol = Object.keys(rows[0]!).find((k) => k.endsWith("json"))!;
    const patched = JSON.stringify({ ...(JSON.parse(String(rows[0]![jsonCol])) as object), descriptionFa: "rewritten" });
    store.__rawAgent(`UPDATE proposals SET ${jsonCol}=? WHERE id=?`, patched, t.proposalId);
    await expect(m.decide(t.proposalId, A, { decision: "approve", digest: t.view.proposal.digest })).rejects.toMatchObject({ code: "proposal_tampered" });
  });

  it("the audit chain verifies across restarts", async () => {
    const f = file("audit");
    const m = mk(f);
    await toProposal(m, "چرا demo-api مدام ری‌استارت می‌شود؟");
    expect(await new SqliteAgentStore(f).verifyAudit()).toMatchObject({ ok: true });
  });

  it("no raw 'approved' flag or session id is persisted", async () => {
    const f = file("noleak");
    const store = new SqliteAgentStore(f);
    const m = new AgentRunManager({ svc: mockSvc(), store, provider: new MockDiagnosticLLMProvider("ok"), now: () => NOW });
    const t = await toProposal(m, "چرا demo-api مدام ری‌استارت می‌شود؟");
    await m.decide(t.proposalId, A, { decision: "approve", digest: t.view.proposal.digest });
    for (const table of ["conversations", "messages", "agent_runs", "proposals", "approvals"]) expect(JSON.stringify(store.__allAgent(`SELECT * FROM ${table}`)), table).not.toContain(A);
  });
});
