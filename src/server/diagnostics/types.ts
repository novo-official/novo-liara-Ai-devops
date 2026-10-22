import type { Applet, EventRow, LogLine, Release } from "../domain/models";
import type { RuntimeAssessment } from "../domain/runtime";
import type { VerificationStatus } from "../liara/capabilities";

/** The only diagnostic requests Phase 1C supports. There is no free-text reasoning: unknown intents are rejected. */
export const INTENTS = ["why_restarting", "why_slow", "investigate_http_500", "recent_deployment_failures"] as const;
export type Intent = (typeof INTENTS)[number];
export const isIntent = (v: unknown): v is Intent => typeof v === "string" && (INTENTS as readonly string[]).includes(v);

export type SourceKey = "app" | "runtime" | "releases" | "events" | "logs" | "cpu" | "memory";

/** Why a piece of evidence can (not) be used. Never collapsed: each state has a different diagnostic meaning. */
export type Availability =
  | "available"
  | "missing" // the API answered successfully but returned no observations
  | "unsupported" // endpoint/capability unavailable (404, disabled opt-in, schema we cannot interpret)
  | "access_denied" // 401/403
  | "stale" // data present, but its newest observation is too old to describe the present
  | "contract_mismatch" // response did not match the expected contract
  | "no_content" // HTTP 204: the endpoint answered WITHOUT a payload — content unverifiable; NOT "missing" (empty success) and NOT evidence of zero observations
  | "collection_failed"; // timeout / network / 5xx / budget / cancelled

export interface Freshness {
  state: "fresh" | "stale" | "unknown";
  newestObservation: string | null;
  ageSec: number | null;
}

export interface MetricSeriesData {
  applet: string | null;
  count: number;
  stepSeconds: number | null;
  gaps: number;
  first: { t: number; v: number } | null;
  lastObservation: { t: number; v: number } | null;
  min: number | null;
  max: number | null;
  points: { t: number; v: number }[];
}

export interface MetricEvidenceData {
  /** Verified unit only; null = unknown (the API documents none). */
  unit: string | null;
  schema: "ok" | "empty" | "unsupported";
  windowStart: number;
  windowEnd: number;
  series: MetricSeriesData[];
}

export interface EvidenceDataMap {
  app: { name: string; platform: string | null; status: string | null; scale: number | null; planId: string | null; isDeployed: boolean | null; envKeys: string[] };
  runtime: { assessment: RuntimeAssessment; applets: Applet[] };
  releases: { total: number | null; currentRelease: string | null; releases: Release[] };
  events: { rows: EventRow[]; truncated: boolean };
  logs: { lines: LogLine[]; truncated: boolean; source: "v1" | "v2" };
  cpu: MetricEvidenceData;
  memory: MetricEvidenceData;
}

export interface EvidenceItem<K extends SourceKey = SourceKey> {
  id: string;
  source: K;
  /** Liara capability id that produced it (matches the diagnostics screen). */
  capability: string;
  app: string;
  runId: string;
  mode: "mock" | "live";
  /** True for mock mode: the evidence is SIMULATED and must be labelled so everywhere. */
  simulated: boolean;
  collectedAt: string;
  window: { from: string; to: string } | null;
  availability: Availability;
  freshness: Freshness;
  /** Contract verification status of the capability at collection time (mock never exceeds the unverified baseline). */
  verification: VerificationStatus;
  data: EvidenceDataMap[K] | null;
  errorCode?: string;
  notes: string[];
}

export type AnyEvidence = { [K in SourceKey]: EvidenceItem<K> }[SourceKey];

/** Metric semantics that were VERIFIED (or are explicitly simulated test fixtures). Empty in production today. */
export interface MetricSemantics {
  unit: string;
  /** Capacity in the same unit as the raw values. Absent = no relevant limit is known. */
  limit?: number;
  origin: "verified" | "simulated_fixture" | "test";
}
export interface Semantics {
  cpu?: MetricSemantics;
  memory?: MetricSemantics;
}

// ---------- findings ----------
export type HypothesisKey =
  | "crash_loop"
  | "isolated_restart"
  | "db_connection_refused"
  | "db_connection_timeout"
  | "db_dns_failure"
  | "db_authentication_failure"
  | "missing_configuration"
  | "oom_kill"
  | "memory_exhaustion_in_process"
  | "memory_growth_unverified"
  | "memory_pressure"
  | "cpu_saturation"
  | "release_regression"
  | "release_failed"
  | "http_500"
  | "insufficient_evidence";

export type Strength = "strong" | "moderate" | "weak";

export interface Finding {
  id: string;
  detector: string;
  hypothesis: HypothesisKey;
  /** observation = directly seen in evidence; inference = reasoned from observations */
  kind: "observation" | "inference";
  strength: Strength;
  evidenceIds: string[];
  /** Sanitised (shareable-redacted), length-capped excerpts of untrusted text. Display only. */
  excerpts: string[];
  /** Machine-readable facts for the aggregator and the Persian text builder (never free text from logs). */
  data: Record<string, string | number | boolean | null | string[]>;
  limitations: string[]; // limitation codes
  /** Timestamps (ms) of the underlying events, for correlation. */
  times?: number[];
}

export interface DetectorResult {
  findings: Finding[];
  limitations: string[];
}

export interface DetectorContext {
  runId: string;
  now: number;
  intent: Intent;
  evidence: import("./evidence-set").EvidenceSet;
  semantics: Semantics;
}

export interface Detector {
  id: string;
  run(ctx: DetectorContext): DetectorResult;
}

// ---------- diagnosis ----------
export type Confidence = "HIGH" | "MEDIUM" | "LOW" | "INSUFFICIENT_EVIDENCE";

export interface Contradiction {
  withKey: HypothesisKey | "runtime_state";
  evidenceIds: string[];
  code: string;
}

export interface Hypothesis {
  key: HypothesisKey | string; // merged keys like restart_loop_db_connection_refused
  confidence: Confidence;
  ruleIds: string[];
  observations: Finding[];
  inferences: Finding[];
  evidenceIds: string[];
  contradictions: Contradiction[];
  missing: string[];
  limitations: string[];
  /** Hypotheses merged into this one (for transparency). */
  merged: string[];
}

export interface Diagnosis {
  status: "ISSUES_FOUND" | "NO_ANOMALY_IN_EXAMINED_EVIDENCE" | "INSUFFICIENT_EVIDENCE";
  hypotheses: Hypothesis[];
  overallConfidence: Confidence;
  missingEvidence: { source: SourceKey; availability: Availability; evidenceId: string }[];
  limitations: string[];
  caveats: string[];
}

// ---------- recommendations ----------
export type Risk = "R0" | "R1" | "R2" | "R3";

export interface Recommendation {
  id: string;
  relatedDiagnosis: string;
  evidenceIds: string[];
  descriptionFa: string;
  expectedImpactFa: string;
  risk: Risk;
  prerequisitesFa: string[];
  verificationPlanFa: string[];
  requiresApproval: boolean;
  /** Always false in Phase 1C: nothing is executed, there is no mutation tool. */
  executableNow: false;
  /** A manual step the operator performs outside this tool (e.g. check the DB) vs. a Liara operation that Phase 1D may offer. */
  actor: "operator_manual" | "liara_operation_future";
  /** Machine-readable operation for FUTURE operations (drives simulated proposals). Never executed by the engine. */
  operation?: { kind: "restart_app" | "change_plan" | "update_env" | "deploy_release"; params: Record<string, unknown> };
}
