import type { ProbeFailure, ProbeOutcome } from "./probe";
/**
 * Live deployment types (Phase 2A). Everything in `src/server/live/` is SEPARATE from the mock simulator (`deploy/simulator.ts`), from the read-only
 * Liara client (`liara/*`) and from the Phase 1D/1E proposal engine: live proposals and approvals have their own types, tables and digests.
 */

export const LIVE_STATES = [
  "PREFLIGHT",
  "AWAITING_LIVE_APPROVAL",
  "APPROVED",
  "CREATING_APPLICATION",
  "APPLICATION_CREATED",
  "UPLOADING_SOURCE",
  "SOURCE_UPLOADED",
  "CREATING_RELEASE",
  "RELEASE_CREATED",
  "VERIFYING_DEPLOYMENT",
  "DEPLOYED",
  "FAILED",
  "NEEDS_OPERATOR_REVIEW",
  "CANCELLED",
] as const;
export type LiveState = (typeof LIVE_STATES)[number];

/** Allowed transitions. Anything else is refused by the store's compare-and-set. */
export const LIVE_NEXT: Record<LiveState, readonly LiveState[]> = {
  PREFLIGHT: ["AWAITING_LIVE_APPROVAL", "FAILED", "CANCELLED"],
  AWAITING_LIVE_APPROVAL: ["APPROVED", "CANCELLED", "FAILED"],
  // APPROVED → APPLICATION_CREATED exists ONLY for `deploy_existing_app` operations (identity of the EXISTING app verified; no create request is ever sent)
  APPROVED: ["CREATING_APPLICATION", "APPLICATION_CREATED", "CANCELLED", "FAILED", "NEEDS_OPERATOR_REVIEW"], // review: an unexpected error right after the claim (never a retry)
  CREATING_APPLICATION: ["APPLICATION_CREATED", "FAILED", "NEEDS_OPERATOR_REVIEW"],
  APPLICATION_CREATED: ["UPLOADING_SOURCE", "NEEDS_OPERATOR_REVIEW", "FAILED"],
  UPLOADING_SOURCE: ["SOURCE_UPLOADED", "NEEDS_OPERATOR_REVIEW", "FAILED"],
  SOURCE_UPLOADED: ["CREATING_RELEASE", "NEEDS_OPERATOR_REVIEW", "FAILED"],
  CREATING_RELEASE: ["RELEASE_CREATED", "NEEDS_OPERATOR_REVIEW", "FAILED"],
  RELEASE_CREATED: ["VERIFYING_DEPLOYMENT", "NEEDS_OPERATOR_REVIEW", "FAILED"],
  VERIFYING_DEPLOYMENT: ["DEPLOYED", "NEEDS_OPERATOR_REVIEW", "FAILED"],
  DEPLOYED: [],
  FAILED: [],
  NEEDS_OPERATOR_REVIEW: ["FAILED", "DEPLOYED", "CANCELLED"], // only through an explicit, audited operator resolution
  CANCELLED: [],
};
export const LIVE_TERMINAL: readonly LiveState[] = ["DEPLOYED", "FAILED", "CANCELLED"];

export type LiveProposalStatus = "PENDING" | "APPROVED" | "REJECTED" | "EXPIRED" | "CANCELLED" | "BLOCKED" | "CONSUMED";

export interface FinancialImpact {
  /** the operator has supplied verified units AND billing semantics (LIARA_PLAN_UNITS_JSON) */
  unitsVerified: boolean;
  planId: string;
  /** raw catalogue figures, shown with the operator-declared units only when verified */
  resource: { ramAmount: number | null; cpuAmount: number | null; volume: number | null; price: number | null; ramUnit: string | null; cpuUnit: string | null; priceUnit: string | null };
  /** estimate for a STATED duration; null unless billing semantics are verified */
  estimate: { durationHours: number; amount: number; currency: string; basis: string } | null;
  requiredBalance: number | null;
  knownOtherCosts: string[];
  unknownCostComponents: string[];
}

/** What an operation does. `create_new_app` (Phase 2A/2B) creates a NEW application; `deploy_existing_app` (Phase 2D) releases new code to an application that ALREADY exists. */
export type LiveKind = "create_new_app" | "deploy_existing_app";
/** Who performs the two write calls of a release. `api` = this project's typed REST client; `cli` = the official Liara CLI behind a restricted, allowlisted runner. */
export type LiveBackend = "api" | "cli";
/** Everything about a CLI-backed deployment that the approval binds: the exact tool (version + entry hash), the exact flags, the exact source tree. */
export interface LiveCliBinding {
  version: string;
  entrySha256: string;
  /** digest of the argv template (executable-independent; paths replaced by placeholders) */
  argvDigest: string;
  /** digest of the exact file set (path + sha256 of every file) that the CLI will package */
  manifestDigest: string;
}

/** Phase 2E: what an EXISTING-app approval binds about the application INSTANCE and its release baseline (any change ⇒ the approval is void). */
export interface LiveExistingBinding {
  instanceId: string | null;
  createdAt: string | null;
  networkId: string | null;
  baselineRelease: string | null;
  releaseTotal: number | null;
  defaultSubdomain: boolean | null;
}

export interface LiveProposalContent {
  id: string;
  /** Phase 2D discriminator (default `create_new_app`, so Phase 2A/2B proposals keep their meaning) */
  kind: LiveKind;
  backend: LiveBackend;
  /** `deploy_existing_app` + `cli` only */
  cli: LiveCliBinding | null;
  /** `deploy_existing_app` only */
  existing: LiveExistingBinding | null;
  /** unique per deployment attempt; the unit of idempotency */
  operationId: string;
  runId: string;
  conversationId: string;
  ownerHash: string;
  /** exact team identity this operation is bound to (null = personal account) */
  teamId: string | null;
  appName: string;
  planId: string;
  /** [CLI-observed, always sent] */
  bundlePlanId: string;
  /** [CLI-observed, always sent] network `_id` supplied by the operator (LIARA_NETWORK_ID); never invented */
  networkId: string;
  platform: "next" | "static";
  artifact: {
    /** SHA-256 (hex) of the ORIGINAL uploaded ZIP */
    zipSha256: string;
    /** digest of the analysis report the operator reviewed */
    analysisDigest: string;
    /** digest of the generated deployment archive */
    artifactDigest: string;
    artifactBytes: number;
    fileCount: number;
    format: string;
  };
  config: { port: number; output: "server" | "standalone" | "export"; nodeRange: string | null; buildInvocation: string | null; startInvocation: string | null };
  /** NAMES only; values are entered by the operator out-of-band and never reach this system */
  envKeys: string[];
  financial: FinancialImpact;
  executionMode: "live";
  environment: "live";
  confirmation: "type_app_name";
  stateFingerprint: string;
  createdAt: string;
  expiresAt: string;
}
export interface LiveProposal extends LiveProposalContent {
  digest: string;
  status: LiveProposalStatus;
}

export interface LiveApprovalRecord {
  id: string;
  proposalId: string;
  operationId: string;
  decision: "approve" | "reject";
  actorHash: string;
  decidedAt: string;
  digest12: string;
  outcome: "accepted" | "rejected" | "blocked_drift" | "blocked_policy" | "expired" | "blocked_binding";
  scope: "live";
}

export type StepName = "create_application" | "upload_source" | "create_release" | "verify_deployment";
export type StepStatus = "pending" | "started" | "done" | "failed" | "unknown";
export interface StepRecord {
  name: StepName;
  status: StepStatus;
  startedAt: string | null;
  endedAt: string | null;
  /** machine code, never a raw upstream message */
  outcome: string | null;
}

/** Separate, explicit acceptance levels: nothing implies the next one. */
export type Level = "unknown" | "ok" | "failed";
export interface VerificationLadder {
  apiAcceptedRequest: Level;
  sourceUploaded: Level;
  releaseCreated: Level;
  buildCompleted: Level;
  runtimeStarted: Level;
  httpHealthVerified: Level;
}
export const EMPTY_LADDER: VerificationLadder = { apiAcceptedRequest: "unknown", sourceUploaded: "unknown", releaseCreated: "unknown", buildCompleted: "unknown", runtimeStarted: "unknown", httpHealthVerified: "unknown" };

/** One HTTP health observation, exactly as made — with WHEN and by WHAT. Contains no header, body text, address or certificate detail. */
export interface HealthObservation {
  source: "http_probe";
  /** ISO time of the observation (never back-filled for records that do not have it) */
  observedAt: string;
  outcome: ProbeOutcome;
  status: number | null;
  markerRequired: boolean;
  /** null = no marker configured or no body inspected */
  markerMatched: boolean | null;
  /** coarse reason when the probe did not verify (dns / tls / connection / timeout / http_status / marker_mismatch …) */
  failure: ProbeFailure | null;
  durationMs: number | null;
}

/** What the applets endpoint gave: kept SEPARATE from the health probe — an unreadable applets list is "no information", never "the app is down". */
export interface AppletsObservation {
  observedAt: string;
  readable: boolean;
  runtimeClass: string | null;
  appletCount: number | null;
  /** error code class of the read when it was not readable (e.g. upstream_error for an HTTP 500) */
  failure: string | null;
}

/**
 * Provenance of the runtime fact and of the evidence behind the verification, recorded WITH the ladder (optional ⇒ older records stay valid and are shown as
 * "not recorded", never reconstructed): `runtime` = observed (applets read) / inferred (applets unreadable + marker-verified HTTPS answer of the current READY
 * release) / unknown.
 */
export interface VerificationEvidence {
  runtime: "observed" | "inferred" | "unknown";
  /** the applets list was readable (`false` ⇒ Liara's API errored, e.g. HTTP 500) */
  appletsReadable: boolean | null;
  /** when this evidence was gathered (the verification run that produced the ladder) */
  observedAt?: string;
  /** `null` = no probe was run in that observation; absent = not recorded */
  health?: HealthObservation | null;
  applets?: AppletsObservation | null;
}

/**
 * A FRESH, read-only runtime check of a finished deployment. It never changes the operation's state, ladder or `evidence` (the historical record of the
 * deployment) — it sits next to them. A failed check is a failed CHECK, not a failed deployment.
 */
export interface RuntimeCheck {
  observedAt: string;
  /** http_ok = the health endpoint answered as expected at `observedAt` · http_failed = it answered wrongly (non-2xx / marker mismatch) · unknown = no usable answer */
  verdict: "http_ok" | "http_failed" | "unknown";
  runtime: VerificationEvidence["runtime"];
  currentReleaseMatches: boolean | null;
  health: HealthObservation | null;
  applets: AppletsObservation | null;
}

export interface LiveOperationRecord {
  id: string;
  kind: LiveKind;
  backend: LiveBackend;
  proposalId: string;
  ownerHash: string;
  teamId: string | null;
  appName: string;
  planId: string;
  platform: "next" | "static";
  state: LiveState;
  createdAt: string;
  updatedAt: string;
  steps: StepRecord[];
  remote: { appConfirmed: boolean | null; sourceId: string | null; releaseId: string | null };
  ladder: VerificationLadder;
  /** where the "runtime started" fact came from; absent on records written before provenance existed (never guessed afterwards) */
  evidence?: VerificationEvidence;
  /** latest FRESH read-only check of a DEPLOYED operation (separate from the historical `evidence`) */
  latestCheck?: RuntimeCheck;
  /** WHO is executing it: stamped when execution is claimed (optional ⇒ no migration). Start-up recovery uses it to leave an operation that another LIVE service instance is running alone. */
  runner?: { instance: string; pid: number };
  failure: { code: string; step: StepName | "preflight" | "approval"; messageFa: string } | null;
  recoveryFa: string[];
  transitions: { at: string; from: LiveState | null; to: LiveState; note: string | null }[];
}

export type LiveErrorCode =
  | "live_execution_disabled"
  | "live_prerequisite_missing"
  | "live_not_found"
  | "live_proposal_pending"
  | "live_digest_mismatch"
  | "live_confirmation_required"
  | "live_expired"
  | "live_already_decided"
  | "live_blocked_policy"
  | "live_blocked_drift"
  | "live_tampered"
  | "live_binding_mismatch"
  | "live_operation_in_progress"
  | "live_duplicate_app"
  | "live_invalid_state"
  | "live_artifact_rejected"
  | "live_artifact_mismatch"
  | "live_plan_blocked"
  | "live_not_approved"
  | "live_simulation_approval_rejected";

export class LiveError extends Error {
  override readonly name = "LiveError";
  constructor(public readonly code: LiveErrorCode, public readonly detail: string[] = []) {
    super(code);
  }
}
export const isLiveError = (e: unknown): e is LiveError => e instanceof LiveError || (typeof e === "object" && e !== null && (e as { name?: unknown }).name === "LiveError" && typeof (e as { code?: unknown }).code === "string");
