import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it, vi } from "vitest";
import { ApprovalCard } from "@/components/approval-card";
import { SimulationResultView } from "@/components/simulation-result";
import { ToolTimeline } from "@/components/tool-timeline";
import { SIM_BANNER, SIM_BANNER_LONG, ui } from "@/i18n/agent-fa";
import { contentOf, proposalDigest } from "@/server/agent/policy";
import { simulate } from "@/server/agent/simulation/simulator";
import type { ActionProposal, AgentRunRecord, ApprovalRecord } from "@/server/agent/types";
import { NOW } from "../helpers/evidence-builder";

vi.mock("next/navigation", () => ({ useRouter: () => ({ push: () => undefined, refresh: () => undefined }) }));

const iso = new Date(NOW).toISOString();
const exp = new Date(NOW + 600_000).toISOString();
const mkProposal = (o: Partial<ActionProposal> = {}): ActionProposal => {
  const base: ActionProposal = {
    id: "prop_20260102040000_aabbccdd", runId: "arun_x", conversationId: "conv_x", app: "demo-api", operation: "restart_app", params: {}, risk: "R1", executionMode: "simulation", recommendationId: "rec_1", relatedDiagnosis: "d",
    evidenceIds: ["e1"], stateFingerprint: "a".repeat(64), descriptionFa: "ری‌استارت برنامه: پس از رفع علت", impactFa: "اثر مورد انتظار", downtimeFa: "قطعی کوتاه", preconditionsFa: ["پیش‌شرط یک"], verificationPlanFa: ["معیار یک"],
    confirmation: "click", createdAt: iso, expiresAt: exp, digest: "", status: "PENDING", ...o,
  };
  return { ...base, digest: proposalDigest(contentOf(base)) };
};
const approval = (p: ActionProposal, outcome: ApprovalRecord["outcome"] = "accepted"): ApprovalRecord => ({ id: "aprv_1", proposalId: p.id, decision: "approve", actorHash: "h", decidedAt: iso, digest: p.digest, outcome, scope: "simulation" });
const html = (n: React.ReactElement) => renderToStaticMarkup(n);

describe("simulation banner copy", () => {
  it("says no real operation is performed", () => {
    expect(SIM_BANNER).toContain("شبیه‌سازی");
    expect(SIM_BANNER).toContain("هیچ عملیات واقعی");
    expect(SIM_BANNER_LONG.length).toBeGreaterThan(40);
  });
});

describe("SimulationResultView", () => {
  it("pending: shows 'plan created' and 'real operation not executed' only", () => {
    const p = mkProposal();
    const out = html(<SimulationResultView proposal={p} result={null} approvals={[]} />);
    expect(out).toContain('data-testid="stage-created"');
    expect(out).toContain('data-testid="stage-not-real"');
    expect(out).not.toContain('data-testid="stage-approved"');
    expect(out).not.toContain('data-testid="stage-simulation"');
  });
  it("approved + simulated success: distinguishes approved / simulation / verification and still says not real", () => {
    const p = mkProposal({ status: "SIMULATED_OK" });
    const out = html(<SimulationResultView proposal={p} result={simulate(p, "ok", iso)} approvals={[approval(p)]} />);
    for (const id of ["stage-created", "stage-approved", "stage-simulation", "stage-verification", "stage-not-real", "sim-note", "criteria"]) expect(out, id).toContain(`data-testid="${id}"`);
    expect(out).toContain('data-outcome="succeeded"');
  });
  it("simulated failure is amber (warning), never green/success-coloured", () => {
    const p = mkProposal({ status: "SIMULATED_FAILED" });
    const out = html(<SimulationResultView proposal={p} result={simulate(p, "operation_failure", iso)} approvals={[approval(p)]} />);
    expect(out).toContain('data-outcome="failed"');
    expect(out).toContain(ui.outcome.simFailed);
    expect(out).not.toMatch(/text-green|bg-green|text-emerald|bg-emerald|success/);
  });
  it("verification failure lists the unmet criterion", () => {
    const p = mkProposal({ status: "VERIFICATION_FAILED" });
    const out = html(<SimulationResultView proposal={p} result={simulate(p, "verification_failure", iso)} approvals={[approval(p)]} />);
    expect(out).toContain('data-passed="false"');
    expect(out).toContain(ui.outcome.verifyFail);
  });
  it.each([["REJECTED", ui.outcome.rejected], ["EXPIRED", ui.outcome.expired], ["CANCELLED", ui.outcome.cancelled], ["BLOCKED", ui.outcome.blocked]] as const)("%s shows a terminal label and no simulation result", (status, label) => {
    const out = html(<SimulationResultView proposal={mkProposal({ status })} result={null} approvals={[]} />);
    expect(out).toContain('data-testid="stage-terminal"');
    expect(out).toContain(label);
    expect(out).not.toContain('data-testid="stage-simulation"');
  });
});

describe("ApprovalCard", () => {
  const view = (p: ActionProposal) => ({ proposal: p, result: null, approvals: [] });
  it("shows the exact action, app, operation, risk, params, impact, downtime, preconditions, verification, digest, expiry and the simulation notice", () => {
    const p = mkProposal({ operation: "update_env", risk: "R2", confirmation: "type_app_name", params: { keys: ["DATABASE_URL"], valuesSource: "operator_out_of_band" } });
    const out = html(<ApprovalCard view={view(p)} onChanged={() => undefined} />);
    for (const s of [p.app, "update_env", "DATABASE_URL", p.impactFa, p.downtimeFa, "پیش‌شرط یک", "معیار یک", p.digest, ui.dialog.simNotice, 'data-testid="approval-dialog"', 'data-testid="confirm-input"']) expect(out, s).toContain(s);
  });
  it("R1 needs no typed confirmation", () => {
    const out = html(<ApprovalCard view={view(mkProposal())} onChanged={() => undefined} />);
    expect(out).not.toContain('data-testid="confirm-input"');
    expect(out).toContain('data-testid="approve"');
    expect(out).toContain('data-testid="reject"');
  });
  it("the card is labelled as a simulated test and offers no 'execute for real' wording", () => {
    const out = html(<ApprovalCard view={view(mkProposal())} onChanged={() => undefined} />);
    expect(out).toContain(ui.proposalNote);
    expect(out).not.toMatch(/اجرای واقعی|Execute now|run for real/i);
  });
  it("a decided proposal has no review/approve entry point", () => {
    const p = mkProposal({ status: "REJECTED" });
    const out = html(<ApprovalCard view={view(p)} onChanged={() => undefined} />);
    expect(out).not.toContain('data-testid="open-approval"');
  });
});

describe("ToolTimeline", () => {
  const run: AgentRunRecord = {
    id: "arun_x", conversationId: "conv_x", app: "demo-api", intent: "investigate_restarts", windowMinutes: 60, mode: "mock", status: "READY", phase: "REPORT_READY", createdAt: iso, updatedAt: iso, finishedAt: iso, retryOf: null,
    plan: { id: "plan_1", intent: "investigate_restarts", engineIntent: "why_restarting", app: "demo-api", windowMinutes: 60, risk: "R0", budget: { maxToolCalls: 12 }, createdAt: iso, expectedEvidence: [], prerequisitesFa: [], missingInformationFa: [], verificationCriteriaFa: [],
      steps: [{ id: "s1", tool: "get_app_details", args: { app: "demo-api" }, reasonFa: "برای خواندن وضعیت", expectedEvidence: "app", risk: "R0", optional: false }], skipped: [{ tool: "get_cpu_metrics", code: "reused_evidence", reasonFa: "شاهد تازه موجود است" }] },
    toolCalls: [{ stepId: "s1", tool: "get_app_details", status: "succeeded", startedAt: iso, durationMs: 12, summary: { availability: "available", evidenceId: "run/app", note: null } }] as never,
    transitions: [], errorCode: null, report: null, proposalIds: [],
  };
  it("lists the plan steps, the executed tools with their status, and the skipped steps with reasons", () => {
    const out = html(<ToolTimeline run={run} />);
    for (const id of ["agent-timeline", "tool-list", "skipped-steps"]) expect(out).toContain(`data-testid="${id}"`);
    expect(out).toContain("شاهد تازه موجود است");
  });
});
