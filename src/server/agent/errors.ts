export type AgentErrorCode =
  | "not_found"
  | "conversation_full"
  | "run_in_progress"
  | "too_many_runs"
  | "run_quota_exceeded"
  | "retry_not_allowed"
  | "proposal_pending"
  | "proposal_limit"
  | "not_ready"
  | "no_applicable_operation"
  | "confirmation_required"
  | "digest_mismatch"
  | "already_decided"
  | "expired"
  | "blocked_policy"
  | "blocked_drift"
  | "proposal_tampered"
  | "invalid_decision"
  // Phase 1E
  | "upload_rejected"
  | "upload_quota_exceeded"
  | "no_project"
  | "plan_refused"
  | "app_name_taken"
  | "invalid_input"
  | "live_execution_disabled"
  | "simulation_approval_not_valid_for_live";

export class AgentError extends Error {
  constructor(
    public readonly code: AgentErrorCode,
    public readonly extra: { existingRunId?: string; reason?: string } = {},
  ) {
    super(code);
    this.name = "AgentError";
  }
}
/** Duck-typed (Next.js may bundle this module more than once; see isLiaraError). */
export function isAgentError(e: unknown): e is AgentError {
  return e instanceof AgentError || (typeof e === "object" && e !== null && (e as { name?: unknown }).name === "AgentError" && typeof (e as { code?: unknown }).code === "string");
}
