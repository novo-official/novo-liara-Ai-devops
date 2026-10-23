import { EMPTY_LADDER, type HealthObservation, type Level, type VerificationEvidence, type VerificationLadder } from "./types";

/**
 * VERIFICATION LADDER. Six separate facts; none implies the next:
 *   API accepted the request → source uploaded → release created → build completed → runtime started → HTTP health verified
 * DEPLOYED requires ALL SIX to be "ok". Anything "unknown" (unknown release state, no applets, no health evidence, probe disabled) is NEVER success.
 * Release states are the CLI-observed vocabulary (READY, DEPLOYING, UNHEALTHY, FAILED, CANCELED, TIMEDOUT); unrecognised values stay "unknown".
 */

export type ReleaseStateClass = "ready" | "deploying" | "unhealthy" | "failed" | "unknown";
export function classifyReleaseState(state: string | null): ReleaseStateClass {
  const s = (state ?? "").trim().toUpperCase();
  if (s === "READY") return "ready";
  if (s === "DEPLOYING") return "deploying";
  if (s === "UNHEALTHY") return "unhealthy";
  if (s === "FAILED" || s === "CANCELED" || s === "CANCELLED" || s === "TIMEDOUT") return "failed";
  return "unknown";
}

export interface Snapshot {
  apiAcceptedRequest: boolean;
  sourceUploaded: boolean;
  releaseId: string | null;
  /** `null` = the releases read failed or the release is not listed yet */
  releaseState: string | null;
  currentReleaseMatches: boolean | null;
  runtime: { runtime: string; heuristic: boolean; appletCount: number } | null;
  health: { outcome: string; status: number | null; markerFound: boolean | null; /** a response marker was configured: it MUST be found */ markerRequired: boolean; failure?: string | null; durationMs?: number | null } | null;
  /** when this snapshot was taken (ISO); recorded as the observation time of the evidence */
  observedAt?: string;
  /** the applets read: `failure` = the error code class when it was not readable */
  applets?: { readable: boolean; failure: string | null };
  /** the operator configured at least one trusted application-domain suffix */
  probeConfigured: boolean;
}

const lv = (ok: boolean | null, failed = false): Level => (failed ? "failed" : ok ? "ok" : "unknown");

export function evaluateLadder(s: Snapshot): VerificationLadder {
  return assess(s).ladder;
}

/** Same judgement plus the PROVENANCE of the runtime fact (one code path, so the two can never disagree). */
export function assess(s: Snapshot): { ladder: VerificationLadder; evidence: VerificationEvidence } {
  const rel = classifyReleaseState(s.releaseState);
  const buildCompleted: Level = rel === "ready" || rel === "deploying" || rel === "unhealthy" ? "ok" : rel === "failed" ? "failed" : "unknown";
  // runtime: READY alone is not enough — an applet must be observed in a running class (heuristic vocabulary ⇒ stays labelled elsewhere)
  const runtimeFailed = rel === "unhealthy" || (rel === "ready" && s.runtime !== null && ["restarting", "stopped"].includes(s.runtime.runtime));
  const runtimeObserved = rel === "ready" && s.runtime !== null && s.runtime.runtime === "running" && s.runtime.appletCount > 0;
  const healthFailed = s.health ? s.health.outcome === "http_error" || (s.health.outcome === "ok" && s.health.markerFound === false) : false;
  const healthOk = s.health ? s.health.outcome === "ok" && (s.health.markerRequired ? s.health.markerFound === true : s.health.markerFound !== false) : false;
  // The applets endpoint can be unavailable (the real API answered HTTP 500 for it): then the runtime cannot be OBSERVED. A process that answers over HTTPS with the
  // operator's SPECIFIC marker, for a release that is READY *and the current one*, is running — that is stronger proof than the applet list. Used ONLY when the
  // applet read failed (null); a readable "stopped / restarting / unknown" answer is never overridden.
  const runtimeInferred = rel === "ready" && s.runtime === null && s.currentReleaseMatches === true && s.health?.outcome === "ok" && s.health.markerRequired && s.health.markerFound === true;
  const runtimeOk = runtimeObserved || runtimeInferred;
  const ladder: VerificationLadder = {
    apiAcceptedRequest: lv(s.apiAcceptedRequest),
    sourceUploaded: lv(s.sourceUploaded),
    releaseCreated: lv(s.releaseId !== null),
    buildCompleted,
    runtimeStarted: lv(runtimeOk, runtimeFailed),
    httpHealthVerified: lv(healthOk, healthFailed),
  };
  const runtime: VerificationEvidence["runtime"] = runtimeObserved || (runtimeFailed && s.runtime !== null) ? "observed" : runtimeInferred ? "inferred" : "unknown";
  const at = s.observedAt;
  const evidence: VerificationEvidence = { runtime, appletsReadable: s.runtime !== null };
  if (at) {
    evidence.observedAt = at;
    evidence.health = s.health
      ? { source: "http_probe", observedAt: at, outcome: s.health.outcome as HealthObservation["outcome"], status: s.health.status, markerRequired: s.health.markerRequired, markerMatched: s.health.markerFound, failure: (s.health.failure ?? null) as HealthObservation["failure"], durationMs: s.health.durationMs ?? null }
      : null; // no probe ran in this observation (not configured / release not READY yet): distinct from "not recorded"
    evidence.applets = { observedAt: at, readable: s.runtime !== null, runtimeClass: s.runtime ? s.runtime.runtime : null, appletCount: s.runtime ? s.runtime.appletCount : null, failure: s.runtime !== null ? null : (s.applets?.failure ?? "unavailable") };
  }
  return { ladder, evidence };
}

export type Verdict = "deployed" | "failed" | "pending" | "needs_review";
/** deployed ⇔ all six "ok"; failed ⇔ any "failed"; pending while a bounded poll may still resolve; otherwise needs_review (never success). */
export function verdictOf(l: VerificationLadder, opts: { stillPolling: boolean }): Verdict {
  const all = Object.values(l);
  if (all.every((x) => x === "ok")) return "deployed";
  if (all.some((x) => x === "failed")) return "failed";
  return opts.stillPolling ? "pending" : "needs_review";
}
export { EMPTY_LADDER };
