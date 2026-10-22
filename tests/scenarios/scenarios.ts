import type { Confidence, Intent, SourceKey } from "@/server/diagnostics/types";

/**
 * Nine independent SYNTHETIC scenarios. Each is backed by its own fixture data in fixtures/mock/*.json (app name below),
 * served through the real read-only service → collector → detectors → aggregator → recommendations pipeline.
 * Nothing here is real Liara data.
 */
export interface Scenario {
  id: string;
  title: string;
  app: string;
  intent: Intent;
  /** Evidence availability per collected source. */
  evidence: Partial<Record<SourceKey, string>>;
  /** Hypotheses emitted by the detectors BEFORE aggregation (finding.hypothesis). */
  detectorOutputs: string[];
  status: "ISSUES_FOUND" | "NO_ANOMALY_IN_EXAMINED_EVIDENCE" | "INSUFFICIENT_EVIDENCE";
  /** Expected ranking after aggregation: [key, confidence] in order. */
  ranking: [string, Confidence][];
  /** Recommendation risk classes expected (sorted, unique). */
  riskClasses: string[];
  /** Limitation codes that MUST be reported (uncertainty). */
  limitations: string[];
  caveats: string[];
  /** Things the report must NOT claim / recommend. */
  mustNotRecommend?: RegExp;
}

const BASE_CAVEATS = ["simulated_data", "contract_unverified", "runtime_interpretation_heuristic"];

export const SCENARIOS: Scenario[] = [
  {
    id: "healthy",
    title: "1. Healthy application",
    app: "demo-shop",
    intent: "why_restarting",
    evidence: { app: "available", runtime: "available", events: "available", logs: "available", releases: "available", memory: "available" },
    detectorOutputs: [],
    status: "NO_ANOMALY_IN_EXAMINED_EVIDENCE",
    ranking: [],
    riskClasses: ["R0"],
    limitations: ["memory_units_unverified", "release_outside_window"],
    caveats: BASE_CAVEATS,
    mustNotRecommend: /ری‌استارت|پلن/,
  },
  {
    id: "db-restart-loop",
    title: "2. Restart loop caused by DB connection failure",
    app: "demo-api",
    intent: "why_restarting",
    evidence: { app: "available", runtime: "available", events: "available", logs: "available", releases: "available", memory: "available" },
    detectorOutputs: ["crash_loop", "db_connection_refused", "release_failed"],
    status: "ISSUES_FOUND",
    ranking: [["restart_loop_db_connection_refused", "HIGH"], ["release_failed", "LOW"]],
    riskClasses: ["R0", "R1"],
    limitations: ["correlation_not_causation", "release_outside_window"],
    caveats: BASE_CAVEATS,
    mustNotRecommend: /پلن|حافظهٔ بیشتر/,
  },
  {
    id: "oom",
    title: "3. Memory-related process termination",
    app: "demo-oom",
    intent: "why_restarting",
    evidence: { app: "available", runtime: "available", events: "available", logs: "available", releases: "available", memory: "available" },
    detectorOutputs: ["crash_loop", "oom_kill", "memory_growth_unverified"],
    status: "ISSUES_FOUND",
    ranking: [["restart_loop_oom_kill", "HIGH"], ["memory_growth_unverified", "LOW"]],
    // no restart suggestion inside a restart loop (the app is already restarting); plan change is R2 with prerequisites
    riskClasses: ["R0", "R2"],
    limitations: ["memory_units_unverified", "raw_values_only"],
    caveats: BASE_CAVEATS,
  },
  {
    id: "cpu-heavy",
    title: "4. CPU-heavy service (SIMULATED verified units + limit)",
    app: "demo-cpu",
    intent: "why_slow",
    evidence: { app: "available", runtime: "available", cpu: "available", memory: "available", logs: "available", events: "missing", releases: "available" },
    detectorOutputs: ["cpu_saturation"],
    status: "ISSUES_FOUND",
    ranking: [["cpu_saturation", "MEDIUM"]],
    riskClasses: ["R0", "R2"],
    limitations: ["utilisation_not_latency", "simulated_semantics"],
    caveats: [...BASE_CAVEATS, "simulated_semantics"],
  },
  {
    id: "failed-release",
    title: "5. Failed recent release (never became current)",
    app: "demo-badrelease",
    intent: "recent_deployment_failures",
    evidence: { app: "available", runtime: "available", releases: "available", events: "available", logs: "available" },
    detectorOutputs: ["release_failed"],
    status: "ISSUES_FOUND",
    ranking: [["release_failed", "MEDIUM"]],
    riskClasses: ["R0"],
    limitations: ["failed_release_is_not_current", "release_state_vocabulary_unverified"],
    caveats: BASE_CAVEATS,
    mustNotRecommend: /ری‌استارت/,
  },
  {
    id: "http-500",
    title: "6. HTTP 500 with explicit log evidence (+ prompt-injection attempt in a log line)",
    app: "demo-http500",
    intent: "investigate_http_500",
    evidence: { app: "available", runtime: "available", logs: "available", events: "missing", releases: "available", memory: "available" },
    detectorOutputs: ["http_500"],
    status: "ISSUES_FOUND",
    ranking: [["http_500", "MEDIUM"]],
    riskClasses: ["R0"],
    limitations: ["no_http_error_rate", "no_http_probe"],
    caveats: [...BASE_CAVEATS, "injection_suspected"],
    mustNotRecommend: /ری‌استارت|حذف|پلن/,
  },
  {
    id: "stale-metrics",
    title: "7. Sparse / stale metrics",
    app: "demo-stale",
    intent: "why_slow",
    evidence: { app: "available", runtime: "available", cpu: "stale", memory: "stale", logs: "available", events: "available", releases: "available" },
    detectorOutputs: [],
    status: "NO_ANOMALY_IN_EXAMINED_EVIDENCE",
    ranking: [],
    riskClasses: ["R0"],
    limitations: ["cpu_metrics_stale", "memory_metrics_stale"],
    caveats: BASE_CAVEATS,
  },
  {
    id: "conflicting",
    title: "8. Conflicting diagnostic signals",
    app: "demo-conflict",
    intent: "why_restarting",
    evidence: { app: "available", runtime: "available", events: "available", logs: "available", releases: "available", memory: "available" },
    detectorOutputs: ["crash_loop", "db_connection_refused", "db_authentication_failure"],
    status: "ISSUES_FOUND",
    ranking: [["restart_loop_db_connection_refused", "MEDIUM"], ["db_authentication_failure", "MEDIUM"]],
    riskClasses: ["R0", "R1", "R2"],
    limitations: ["conflicting_db_categories", "runtime_running_older_than_restarts"],
    caveats: BASE_CAVEATS,
  },
  {
    id: "insufficient",
    title: "9. Completely insufficient evidence",
    app: "demo-worker",
    intent: "why_restarting",
    evidence: { app: "available", runtime: "available", events: "missing", logs: "missing", releases: "available", memory: "missing" },
    detectorOutputs: ["insufficient_evidence"],
    status: "INSUFFICIENT_EVIDENCE",
    ranking: [["insufficient_evidence", "INSUFFICIENT_EVIDENCE"]],
    riskClasses: ["R0"],
    limitations: ["no_timeline_evidence", "src_logs_missing", "src_events_missing"],
    caveats: ["simulated_data", "contract_unverified"],
  },
];
