import { VERIFIED_METRIC_UNITS } from "../domain/vocabulary";
import type { Semantics } from "./types";

/**
 * Metric semantics used by the detectors.
 *  - Production: ONLY what is in the verified-unit table. That table is empty and the capacity limits (plan resources)
 *    are not collected yet, so production semantics never allow a saturation or exhaustion claim.
 *  - Mock mode: a few synthetic apps carry explicitly SIMULATED semantics so the saturation logic can be demonstrated.
 *    They are tagged `simulated_fixture` and the report says so.
 */
const SIMULATED: Record<string, Semantics> = {
  "demo-cpu": { cpu: { unit: "cores", limit: 1, origin: "simulated_fixture" } },
};

export function semanticsFor(app: string, mode: "mock" | "live"): Semantics {
  const s: Semantics = {};
  // A verified unit WITHOUT a known capacity limit is not enough to claim saturation, so no `limit` is set here.
  if (VERIFIED_METRIC_UNITS.cpu) s.cpu = { unit: VERIFIED_METRIC_UNITS.cpu, origin: "verified" };
  if (VERIFIED_METRIC_UNITS.memory) s.memory = { unit: VERIFIED_METRIC_UNITS.memory, origin: "verified" };
  if (mode === "mock" && SIMULATED[app]) return { ...s, ...SIMULATED[app] };
  return s;
}
