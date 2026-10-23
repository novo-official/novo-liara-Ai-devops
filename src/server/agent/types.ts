import type { DiagnosticReport } from "../diagnostics/report";
import type { SimScenario } from "../deploy/params";
import type { PlanRecommendation, Traffic } from "../deploy/recommend";
import type { DeploymentSimDetail } from "../deploy/simulator";
import type { ReadinessReport, SourceAnalysis, UserDecisions } from "../deploy/types";
import type { Intent as EngineIntent, SourceKey } from "../diagnostics/types";

/** The only requests the deterministic Persian parser can resolve. */
export const AGENT_INTENTS = [
  "inspect_health",
  "investigate_restarts",
  "investigate_http500",
  "investigate_slow",
  "investigate_deployments",
  "explain_finding",
  "review_remediation",
  "simulate_remediation_plan",
  // Phase 1E — first-deployment journey (operates on an uploaded project)
  "start_deployment",
  "check_compatibility",
  "recommend_plan",
  "predeploy_checklist",
] as const;
export type AgentIntent = (typeof AGENT_INTENTS)[number];

/** Mapping onto the existing diagnostic engine intents (no second engine). inspect_health uses the general restart-oriented detector set. */
export const ENGINE_INTENT: Partial<Record<AgentIntent, EngineIntent>> = {
  inspect_health: "why_restarting",
  investigate_restarts: "why_restarting",
  investigate_http500: "investigate_http_500",
  investigate_slow: "why_slow",
  investigate_deployments: "recent_deployment_failures",
};

export const TOOL_IDS = [
  "list_apps",
  "get_app_details",
  "get_runtime_status",
  "get_recent_releases",
  "get_recent_events",
  "get_application_logs",
  "get_cpu_metrics",
  "get_memory_metrics",
  "diagnose_application",
] as const;
export type ToolId = (typeof TOOL_IDS)[number];

/** Operations the FUTURE execution plane may support. In Phase 1D they exist only as simulated proposals. */
export const OPERATIONS = ["restart_app", "start_app", "stop_app", "change_plan", "update_env", "deploy_release", "delete_resource", "first_deploy"] as const;
export type OperationKind = (typeof OPERATIONS)[number];

export type Risk = "R0" | "R1" | "R2" | "R3";

export interface PlanStep {
  id: string;
  tool: ToolId;
  args: Record<string, unknown>;
  reasonFa: string;
  expectedEvidence: SourceKey | null;
  risk: "R0";
  /** optional deep-dive steps may be skipped when the timeline (logs+events) turned out unusable */
  optional: boolean;
}

export interface SkippedStep {
  tool: ToolId;
  reasonFa: string;
  code: "reused_evidence" | "capability_unavailable" | "budget" | "timeline_unavailable" | "not_authorized";
}

export interface AgentPlan {
  id: string;
  intent: AgentIntent;
  engineIntent: EngineIntent | null;
  app: string;
  windowMinutes: number;
  steps: PlanStep[];
  skipped: SkippedStep[];
  risk: "R0";
  expectedEvidence: SourceKey[];
  prerequisitesFa: string[];
  missingInformationFa: string[];
  verificationCriteriaFa: string[];
  budget: { maxToolCalls: number };
  createdAt: string;
}

export type ToolOutcome = "succeeded" | "failed" | "skipped";
export interface ToolCallRecord {
  stepId: string;
  tool: ToolId;
  reasonFa: string;
  status: "pending" | "running" | "succeeded" | "failed" | "skipped";
  startedAt?: string;
  endedAt?: string;
  durationMs?: number;
  /** evidence availability for evidence-bearing tools */
  availability?: string;
  evidenceId?: string;
  errorCode?: string;
  /** sanitised, bounded summary of the output (counts / labels) */
  summary?: Record<string, string | number | boolean | null>;
}

export type AgentPhase =
  | "REQUEST_RECEIVED"
  | "INTENT_RESOLVED"
  | "PLAN_CREATED"
  | "COLLECTING_EVIDENCE"
  | "ANALYZING"
  | "REPORT_READY"
  | "ACTION_PROPOSED"
  | "AWAITING_APPROVAL"
  | "APPROVED"
  | "REJECTED"
  | "EXPIRED"
  | "SIMULATION_COMPLETED"
  // Phase 1E — deployment runs
  | "SOURCE_RECEIVED"
  | "SOURCE_ANALYZING"
  | "READINESS_REVIEW"
  | "PLAN_PREPARED"
  | "SIMULATION_RUNNING"
  | "SIMULATION_VERIFICATION";
export type AgentStatus = "RUNNING" | "READY" | "FAILED" | "CANCELLED" | "TIMED_OUT";
export const AGENT_TERMINAL: AgentStatus[] = ["READY", "FAILED", "CANCELLED", "TIMED_OUT"];

export interface AgentTransition {
  at: string;
  from: AgentPhase | null;
  to: AgentPhase | AgentStatus;
  actor: string;
  outcome: "ok" | "error" | "blocked";
  note?: string;
  meta?: Record<string, string | number | boolean | null>;
}

/** Phase 1E: everything persisted about an uploaded project. Sanitised; no archive bytes, no env values, no secrets. */
export interface DeploymentRunData {
  project: SourceAnalysis["project"] & { filename: string | null; receivedAt: string };
  analysis: SourceAnalysis;
  readiness: ReadinessReport;
  recommendation: PlanRecommendation | null;
  options: { appName: string; traffic: Traffic; scenario: SimScenario };
  decisions: UserDecisions;
  /** the plan proposal currently under review (if any) */
  proposalId: string | null;
}

export interface AgentRunRecord {
  /** absent = diagnostic run (Phase 1D) */
  kind?: "diagnostic" | "deployment";
  deployment?: DeploymentRunData;
  id: string;
  conversationId: string;
  app: string;
  intent: AgentIntent;
  windowMinutes: number;
  mode: "mock" | "live";
  status: AgentStatus;
  phase: AgentPhase;
  createdAt: string;
  updatedAt: string;
  finishedAt: string | null;
  retryOf: string | null;
  plan: AgentPlan | null;
  toolCalls: ToolCallRecord[];
  transitions: AgentTransition[];
  errorCode: string | null;
  report: DiagnosticReport | null;
  proposalIds: string[];
}

export type MessageKind = "user" | "ack" | "clarification" | "refusal" | "plan" | "report" | "explanation" | "remediation_review" | "proposal" | "decision" | "simulation" | "system" | "ai_answer" | "ai_error";
export interface ConversationMessage {
  id: string;
  conversationId: string;
  role: "user" | "agent" | "system";
  kind: MessageKind;
  textFa: string;
  at: string;
  intent?: AgentIntent | "unsupported" | "ambiguous";
  runId?: string;
  proposalId?: string;
  /** suggested follow-up prompts offered with this message */
  suggestions?: string[];
  /** UI cue: this message asks the operator to upload a project */
  action?: "upload_project";
  /** attribution of a REAL model answer (kind ai_answer / ai_error). Absent on every deterministic or simulated message. */
  ai?: { source: "boxapi"; model?: string; usage?: { promptTokens: number | null; completionTokens: number | null; totalTokens: number | null }; truncated?: boolean; error?: string };
}

export interface ConversationRecord {
  id: string;
  app: string | null;
  createdAt: string;
  updatedAt: string;
  messageCount: number;
}

// ---------- proposals / approvals ----------
export type ProposalStatus = "PENDING" | "APPROVED" | "SIMULATED_OK" | "SIMULATED_FAILED" | "VERIFICATION_FAILED" | "REJECTED" | "EXPIRED" | "BLOCKED" | "CANCELLED";
export const PROPOSAL_OPEN: ProposalStatus[] = ["PENDING"];

export interface ActionProposal {
  id: string;
  runId: string;
  conversationId: string;
  app: string;
  operation: OperationKind;
  /** sanitised parameters (schema-validated per operation). Never contains secret values. */
  params: Record<string, unknown>;
  risk: Risk;
  /** "simulation" is the ONLY execution mode in Phase 1D */
  executionMode: "simulation";
  recommendationId: string;
  relatedDiagnosis: string;
  evidenceIds: string[];
  /** hash of the app state observed when the proposal was created (drift detection) */
  stateFingerprint: string;
  descriptionFa: string;
  impactFa: string;
  downtimeFa: string;
  preconditionsFa: string[];
  verificationPlanFa: string[];
  confirmation: "click" | "type_app_name";
  createdAt: string;
  expiresAt: string;
  /** SHA-256 over the canonical immutable fields above */
  digest: string;
  status: ProposalStatus;
}

export interface ApprovalRecord {
  id: string;
  proposalId: string;
  decision: "approve" | "reject";
  actorHash: string;
  decidedAt: string;
  digest: string;
  outcome: "accepted" | "rejected" | "blocked_drift" | "blocked_policy" | "expired";
  /** an approval is only ever valid inside the simulation environment; it can never authorise a live action */
  scope: "simulation";
}

export interface SimulationResult {
  simulated: true;
  proposalId: string;
  operation: OperationKind;
  outcome: "succeeded" | "failed";
  steps: { labelFa: string; status: "ok" | "failed" }[];
  verification: { outcome: "success" | "failure" | "not_run"; criteria: { textFa: string; passed: boolean }[] } | null;
  noteFa: string;
  completedAt: string;
  /** Phase 1E: staged deployment timeline (only for `first_deploy`) */
  deployment?: DeploymentSimDetail;
}
