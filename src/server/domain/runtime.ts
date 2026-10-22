import type { Applet, AppSummary } from "./models";
import { classifyAppletState, type RuntimeClass } from "./vocabulary";

/**
 * Independent state dimensions for an application. "Scaled on" is NOT "healthy":
 *  - enabled:  configuration (documented `scale` 1 / 0)
 *  - runtime:  what the applets (running instances) report, interpreted conservatively
 *  - health:   real health evidence (probes, error rates). None is collected in Phase 1B → always "unavailable".
 */
export interface RuntimeAssessment {
  enabled: "enabled" | "disabled" | "unknown";
  deployed: boolean | null;
  runtime: RuntimeClass | "no_instances" | "unavailable";
  /** True when the runtime class rests on keyword heuristics rather than verified vocabulary. */
  runtimeIsHeuristic: boolean;
  appletCount: number;
  byState: { raw: string; count: number; class: RuntimeClass }[];
  failureReasons: string[];
  health: "unavailable";
  /** True when applet data could not be obtained, so `runtime` is unknown rather than inferred. */
  appletsUnavailable: boolean;
}

export function assessRuntime(
  app: Pick<AppSummary, "scale" | "isDeployed">,
  applets: { items: Applet[] } | null,
): RuntimeAssessment {
  const enabled: RuntimeAssessment["enabled"] = app.scale === 1 ? "enabled" : app.scale === 0 ? "disabled" : "unknown";
  const base = { enabled, deployed: app.isDeployed, health: "unavailable" as const };

  if (!applets) {
    return { ...base, runtime: "unavailable", runtimeIsHeuristic: false, appletCount: 0, byState: [], failureReasons: [], appletsUnavailable: true };
  }

  const counts = new Map<string, { class: RuntimeClass; count: number }>();
  const reasons: string[] = [];
  let heuristic = false;
  const classes: RuntimeClass[] = [];
  for (const a of applets.items) {
    const c = classifyAppletState(a.state, a.reason);
    classes.push(c.state);
    if (c.basis === "heuristic") heuristic = true;
    const key = a.state ?? "(no state)";
    const cur = counts.get(key);
    counts.set(key, { class: c.state, count: (cur?.count ?? 0) + 1 });
    if (a.reason && !reasons.includes(a.reason) && reasons.length < 5) reasons.push(a.reason);
  }
  const byState = [...counts.entries()].map(([raw, v]) => ({ raw, count: v.count, class: v.class }));

  let runtime: RuntimeAssessment["runtime"];
  if (applets.items.length === 0) runtime = enabled === "disabled" ? "stopped" : "no_instances";
  else if (classes.includes("restarting")) runtime = "restarting"; // worst wins
  else if (classes.includes("unknown")) runtime = "unknown";
  else if (classes.includes("starting")) runtime = "starting";
  else if (classes.every((c) => c === "stopped")) runtime = "stopped";
  else if (classes.every((c) => c === "running")) runtime = "running";
  else runtime = "unknown"; // mixed running/stopped: do not claim anything

  return { ...base, runtime, runtimeIsHeuristic: heuristic, appletCount: applets.items.length, byState, failureReasons: reasons, appletsUnavailable: false };
}

/** The only condition under which the UI may use a positive (green) runtime indicator. */
export function isPositiveRuntime(a: RuntimeAssessment): boolean {
  return a.enabled === "enabled" && a.deployed !== false && a.runtime === "running" && a.failureReasons.length === 0;
}
