/** Pure helper shared by UI and diagnostics.
 * A measurement is stale when its last observation is older than 5 sampling steps (min 5 minutes). */
export function isStaleMeasurement(ageSec: number, stepSeconds: number | null): boolean {
  return ageSec > Math.max(300, (stepSeconds ?? 60) * 5);
}
