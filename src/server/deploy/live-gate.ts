import type { ActionProposal, ApprovalRecord } from "../agent/types";

/**
 * LIVE-EXECUTION GATE. Phase 1E has no live execution, and this gate says so explicitly:
 *  - an approval carries `scope: "simulation"` and is NEVER valid for a live-target action (no replay across environments)
 *  - any live request is denied while live execution is disabled
 * A future real executor must use a separate live policy with a FRESH approval (see docs/DEPLOYMENT_EXECUTION_CONTRACT.md).
 */
export type LiveGateCode = "live_execution_disabled" | "simulation_approval_not_valid_for_live";

export function authorizeLiveExecution(req: { proposal: Pick<ActionProposal, "executionMode"> & { id?: string }; approval: Pick<ApprovalRecord, "scope" | "outcome"> | null }): { ok: false; code: LiveGateCode } {
  if (req.approval && req.approval.scope === "simulation") return { ok: false, code: "simulation_approval_not_valid_for_live" };
  return { ok: false, code: "live_execution_disabled" };
}
