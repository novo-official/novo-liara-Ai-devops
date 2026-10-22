import { EMPTY_LADDER, type Level, type VerificationLadder } from "./types";

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
  health: { outcome: string; status: number | null; markerFound: boolean | null; /** a response marker was configured: it MUST be found */ markerRequired: boolean } | null;
  /** the operator configured at least one trusted application-domain suffix */
  probeConfigured: boolean;
}

const lv = (ok: boolean | null, failed = false): Level => (failed ? "failed" : ok ? "ok" : "unknown");

export function evaluateLadder(s: Snapshot): VerificationLadder {
  const rel = classifyReleaseState(s.releaseState);
  const buildCompleted: Level = rel === "ready" || rel === "deploying" || rel === "unhealthy" ? "ok" : rel === "failed" ? "failed" : "unknown";
  // runtime: READY alone is not enough — an applet must be observed in a running class (heuristic vocabulary ⇒ stays labelled elsewhere)
  const runtimeFailed = rel === "unhealthy" || (rel === "ready" && s.runtime !== null && ["restarting", "stopped"].includes(s.runtime.runtime));
  const runtimeOk = rel === "ready" && s.runtime !== null && s.runtime.runtime === "running" && s.runtime.appletCount > 0;
  const healthFailed = s.health ? s.health.outcome === "http_error" || (s.health.outcome === "ok" && s.health.markerFound === false) : false;
  const healthOk = s.health ? s.health.outcome === "ok" && (s.health.markerRequired ? s.health.markerFound === true : s.health.markerFound !== false) : false;
  return {
    apiAcceptedRequest: lv(s.apiAcceptedRequest),
    sourceUploaded: lv(s.sourceUploaded),
    releaseCreated: lv(s.releaseId !== null),
    buildCompleted,
    runtimeStarted: lv(runtimeOk, runtimeFailed),
    httpHealthVerified: lv(healthOk, healthFailed),
  };
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
