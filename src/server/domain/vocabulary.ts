/**
 * Vocabulary and unit knowledge. EVERYTHING here is tagged by evidence:
 *   VERIFIED_*  tables contain only values observed in a real Liara response (via `npm run verify:liara-readonly`).
 *               They are EMPTY until a live verification has been run and reviewed.
 *   heuristics  are keyword guesses used ONLY to give a cautious, clearly-labelled interpretation of raw text.
 * The raw upstream strings are always displayed alongside any interpretation.
 */

export type RuntimeClass = "running" | "starting" | "restarting" | "stopped" | "unknown";

/** Exact (case-insensitive) applet state strings confirmed from live responses. Empty: nothing verified yet. */
export const VERIFIED_APPLET_STATES: Readonly<Record<string, RuntimeClass>> = {};

/** Metric units confirmed from live responses, keyed by metric kind. Empty: the API documents no units. */
export const VERIFIED_METRIC_UNITS: Readonly<Partial<Record<"cpu" | "memory", string>>> = {};

export interface Classified {
  state: RuntimeClass;
  /** `verified` = exact match in the verified table; `heuristic` = keyword guess (unverified); `none` = no interpretation. */
  basis: "verified" | "heuristic" | "none";
}

const RESTARTING = /(restart|crash|back-?off|error|fail|oom|exited|unhealthy|evict|terminat)/i;
const STARTING = /(pending|starting|creating|init|deploying|building|waiting|container ?creating)/i;
const RUNNING = /^(running|ready|up|active|healthy|started)$/i;
const STOPPED = /^(stopped|stopping|inactive|off|scaled[- ]?down|completed|succeeded|shutdown)$/i;

export function classifyAppletState(raw: string | null | undefined, reason?: string | null): Classified {
  const s = (raw ?? "").trim();
  if (!s) return { state: "unknown", basis: "none" };
  const v = VERIFIED_APPLET_STATES[s.toLowerCase()];
  if (v) return { state: v, basis: "verified" };
  // Heuristics are deliberately pessimistic: anything failure-like wins over anything healthy-like.
  if (RESTARTING.test(s)) return { state: "restarting", basis: "heuristic" };
  if (STARTING.test(s)) return { state: "starting", basis: "heuristic" };
  if (RUNNING.test(s)) {
    // A "running" container that reports a failure reason is not healthy evidence.
    if (reason && RESTARTING.test(reason)) return { state: "restarting", basis: "heuristic" };
    return { state: "running", basis: "heuristic" };
  }
  if (STOPPED.test(s)) return { state: "stopped", basis: "heuristic" };
  return { state: "unknown", basis: "none" };
}
