import type { DataMode } from "../domain/models";

/** What this build can read, and what it knows the API cannot provide. Mirrors docs/API_CAPABILITY_MATRIX.md. */
export interface CapabilityDef {
  id: string;
  endpoint: string;
  contract: "documented" | "observed";
  /** Needs LIARA_ALLOW_UNDOCUMENTED_ENDPOINTS=true */
  optIn?: boolean;
}

export const CAPABILITIES: readonly CapabilityDef[] = [
  { id: "listApps", endpoint: "GET /v1/projects", contract: "documented" },
  { id: "getApp", endpoint: "GET /v1/projects/{name}", contract: "documented" },
  { id: "getApplets", endpoint: "GET /v1/projects/{name}/applets", contract: "documented" },
  { id: "getReleases", endpoint: "GET /v1/projects/{name}/releases", contract: "documented" },
  { id: "getEvents", endpoint: "GET /v1/projects/{name}/events", contract: "documented" },
  { id: "getLogsV1", endpoint: "GET /v1/projects/{name}/logs", contract: "documented" },
  { id: "getLogsV2", endpoint: "GET /v2/projects/{name}/logs", contract: "observed", optIn: true },
  { id: "getMetricsCpu", endpoint: "GET /v1/projects/{name}/metrics/cpu", contract: "documented" },
  { id: "getMetricsMemory", endpoint: "GET /v1/projects/{name}/metrics/memory", contract: "documented" },
];

/** Things the user may expect but that the API (per the pinned spec) does not offer, or that this phase excludes by design. */
export const NOT_AVAILABLE: readonly { id: string; reason: "not_in_api" | "disabled_by_design" | "unknown_unit" }[] = [
  { id: "horizontalScaling", reason: "not_in_api" },
  { id: "rollback", reason: "not_in_api" },
  { id: "httpStatusMetrics", reason: "not_in_api" },
  { id: "metricUnits", reason: "unknown_unit" },
  { id: "healthEvidence", reason: "not_in_api" },
  { id: "mutations", reason: "disabled_by_design" },
];

/**
 * Evidence level of each capability.
 *  LIVE_VERIFIED          an explicit read-only probe against the real API succeeded and the response matched our schema
 *  DOCUMENTED_UNVERIFIED  in the pinned OpenAPI, never confirmed live
 *  CLI_ONLY_UNVERIFIED    not in the OpenAPI; seen only in the official CLI; never confirmed live
 *  UNAVAILABLE            probe got 404 (endpoint/resource not there). NOT used for 401/403.
 *  ACCESS_DENIED          probe got 401/403: the endpoint may exist but our token cannot use it
 *  CONTRACT_MISMATCH      probe got a response that does not match our schema
 * Transport failures (timeout, network, 5xx, 429) are INCONCLUSIVE and never change this value.
 */
export type VerificationStatus =
  | "LIVE_VERIFIED"
  | "DOCUMENTED_UNVERIFIED"
  | "CLI_ONLY_UNVERIFIED"
  | "UNAVAILABLE"
  | "ACCESS_DENIED"
  | "CONTRACT_MISMATCH";

/** Most recent observed behaviour (from probes and ordinary page loads). */
export type CapabilityHealth = "ok" | "failing" | "not_probed" | "simulated" | "disabled" | "no_content";

interface State {
  lastOkAt?: string;
  lastErrorAt?: string;
  lastErrorCode?: string;
  lastOutcome?: "ok" | "error";
  verification?: VerificationStatus;
  verifiedAt?: string;
}

const g = globalThis as unknown as { __capState?: Map<string, State>; __lastSuccess?: string };
const states: Map<string, State> = (g.__capState ??= new Map());

export function verificationForError(code: string): VerificationStatus | null {
  switch (code) {
    case "unauthorized":
    case "forbidden":
      return "ACCESS_DENIED";
    case "not_found":
    case "unsupported":
      return "UNAVAILABLE";
    case "contract_mismatch":
      return "CONTRACT_MISMATCH";
    case "no_content":
      return null; // reachable but unverifiable: the verification status NEVER changes (neither LIVE_VERIFIED nor CONTRACT_MISMATCH)
    default:
      return null; // timeout / network / 5xx / 429 / too large: inconclusive
  }
}

/**
 * Records an observation. Mock-mode observations are ignored entirely: simulation can never produce evidence.
 * Only explicit probes (`probe: true`) may change the verification status.
 */
export function recordOutcome(
  id: string,
  outcome: { ok: true } | { ok: false; code: string },
  opts: { mode: DataMode; probe?: boolean; nowIso?: string },
): void {
  if (opts.mode === "mock") return;
  const nowIso = opts.nowIso ?? new Date().toISOString();
  const s = states.get(id) ?? {};
  if (outcome.ok) {
    s.lastOkAt = nowIso;
    s.lastOutcome = "ok";
    g.__lastSuccess = nowIso;
    if (opts.probe) {
      s.verification = "LIVE_VERIFIED";
      s.verifiedAt = nowIso;
    }
  } else {
    s.lastErrorAt = nowIso;
    s.lastErrorCode = outcome.code;
    s.lastOutcome = "error";
    if (opts.probe) {
      const v = verificationForError(outcome.code);
      if (v) {
        s.verification = v;
        s.verifiedAt = nowIso;
      }
    }
  }
  states.set(id, s);
}

export function lastSuccessAt(): string | null {
  return g.__lastSuccess ?? null;
}

export function resetCapabilityState(): void {
  states.clear();
  g.__lastSuccess = undefined;
}

export interface CapabilityReport {
  id: string;
  endpoint: string;
  contract: "documented" | "observed";
  verification: VerificationStatus;
  health: CapabilityHealth;
  lastOkAt: string | null;
  lastErrorCode: string | null;
  verifiedAt: string | null;
}

export function baselineVerification(contract: "documented" | "observed"): VerificationStatus {
  return contract === "documented" ? "DOCUMENTED_UNVERIFIED" : "CLI_ONLY_UNVERIFIED";
}

export function capabilityReport(mode: DataMode, allowUndocumented: boolean): CapabilityReport[] {
  return CAPABILITIES.map((c) => {
    const s = mode === "live" ? states.get(c.id) : undefined;
    let health: CapabilityHealth;
    if (c.optIn && !allowUndocumented) health = "disabled";
    else if (mode === "mock") health = "simulated";
    else if (!s?.lastOutcome) health = "not_probed";
    else health = s.lastOutcome === "ok" ? "ok" : s.lastErrorCode === "no_content" ? "no_content" : "failing"; // 204: reachable, payload unverifiable (NOT failing, NOT ok)
    return {
      id: c.id,
      endpoint: c.endpoint,
      contract: c.contract,
      verification: s?.verification ?? baselineVerification(c.contract),
      health,
      lastOkAt: s?.lastOkAt ?? null,
      lastErrorCode: s?.lastOutcome === "error" ? (s.lastErrorCode ?? null) : null,
      verifiedAt: s?.verifiedAt ?? null,
    };
  });
}
