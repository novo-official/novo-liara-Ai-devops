/**
 * The single "what do I do now?" answer for the EXISTING-APP path, and its stage stepper. Pure and deterministic: everything derives from facts the page already
 * has. It never starts anything — it only names the next human action and, when the blocker is configuration, which operator step is missing (this tool never
 * changes configuration itself).
 */
import type { ArtifactState } from "./artifact-binding";

export interface NextActionInput {
  mode: "simulation" | "live_disabled" | "live_enabled";
  readinessOk: boolean;
  runBlockers: string[];
  artifact: ArtifactState;
  hasTargets: boolean;
  targetName: string | null;
  targetReady: boolean;
  targetBlocked: string[];
  backendReady: boolean;
  backendBlockers: string[];
  preview: "none" | "busy" | "ok" | "stale";
  /** execution prerequisites reported by the last preview (empty until a preview exists) */
  previewExecutionBlockers: string[];
  proposal: "PENDING" | "APPROVED" | null;
  opState: string | null;
}

export type NextActionId =
  | "wait_in_progress"
  | "done_verified"
  | "review_failure"
  | "execute_approved"
  | "approve_pending"
  | "fix_source"
  | "choose_zip"
  | "wait_hash"
  | "fix_zip"
  | "choose_target"
  | "fix_target"
  | "run_preview"
  | "operator_enable_live"
  | "create_request";

export interface NextAction {
  id: NextActionId;
  tone: "action" | "wait" | "blocked" | "done";
  /** execution prerequisite ids the OPERATOR must resolve outside this page (empty unless id = operator_enable_live) */
  operatorBlockers: string[];
}

const IN_FLIGHT = ["APPROVED", "CREATING_APPLICATION", "APPLICATION_CREATED", "UPLOADING_SOURCE", "SOURCE_UPLOADED", "CREATING_RELEASE", "RELEASE_CREATED", "VERIFYING_DEPLOYMENT"];

export function nextAction(i: NextActionInput): NextAction {
  const a = (id: NextActionId, tone: NextAction["tone"], operatorBlockers: string[] = []): NextAction => ({ id, tone, operatorBlockers });
  if (i.opState && IN_FLIGHT.includes(i.opState)) return a("wait_in_progress", "wait");
  if (i.opState === "DEPLOYED") return a("done_verified", "done");
  if (i.opState === "FAILED" || i.opState === "NEEDS_OPERATOR_REVIEW") return a("review_failure", "blocked");
  if (i.proposal === "APPROVED") return i.artifact === "none" || i.artifact === "mismatch" || i.artifact === "hashing" ? a(i.artifact === "mismatch" ? "fix_zip" : "choose_zip", "blocked") : a("execute_approved", "action");
  if (i.proposal === "PENDING") return a("approve_pending", "action");
  if (!i.readinessOk || i.runBlockers.length) return a("fix_source", "blocked");
  if (i.artifact === "none") return a("choose_zip", "action");
  if (i.artifact === "hashing") return a("wait_hash", "wait");
  if (i.artifact === "mismatch") return a("fix_zip", "blocked");
  if (!i.hasTargets || !i.targetName) return a("choose_target", "blocked");
  if (!i.targetReady) return a("fix_target", "blocked", i.targetBlocked);
  if (i.preview === "none" || i.preview === "stale") return a("run_preview", "action");
  if (i.preview === "busy") return a("wait_hash", "wait");
  if (i.mode !== "live_enabled" || !i.backendReady || i.previewExecutionBlockers.length) return a("operator_enable_live", "blocked", [...new Set([...(i.mode === "live_enabled" ? [] : ["live_flag"]), ...i.backendBlockers, ...i.previewExecutionBlockers])]);
  return a("create_request", "action");
}

export type StageId = "analysis" | "source_target" | "preview" | "approval" | "execution";
export type StageState = "done" | "current" | "todo" | "blocked";

/** A stage is "blocked" only when it is the first unfinished one and something specific stops it. */
export function stages(i: NextActionInput): { id: StageId; state: StageState }[] {
  const analysisDone = i.readinessOk && i.runBlockers.length === 0;
  const sourceTargetDone = analysisDone && (i.artifact === "match" || i.artifact === "unverifiable") && !!i.targetName && i.targetReady;
  const previewDone = i.preview === "ok" || !!i.proposal || !!i.opState;
  const approvalDone = i.proposal === "APPROVED" || (!!i.opState && i.opState !== "AWAITING_LIVE_APPROVAL" && i.opState !== "CANCELLED");
  const executionDone = i.opState === "DEPLOYED";
  const flags: [StageId, boolean][] = [["analysis", analysisDone], ["source_target", sourceTargetDone], ["preview", previewDone], ["approval", approvalDone], ["execution", executionDone]];
  const firstOpen = flags.findIndex(([, d]) => !d);
  return flags.map(([id, done], idx) => {
    if (done) return { id, state: "done" };
    if (idx !== firstOpen) return { id, state: "todo" };
    const stuck = (id === "analysis") || (id === "source_target" && (i.artifact === "mismatch" || (!!i.targetName && !i.targetReady))) || (id === "execution" && (i.opState === "FAILED" || i.opState === "NEEDS_OPERATOR_REVIEW"));
    return { id, state: stuck ? "blocked" : "current" };
  });
}
