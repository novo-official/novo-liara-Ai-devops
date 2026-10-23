/**
 * Which of the blocking prerequisites that stop the NEW-APPLICATION workflow are specific to creating a new application? Pure; reads nothing, changes nothing.
 * `plan_units_verified` (price/resource units for the cost estimate) and `network_id` (the network a NEW app is created in) are never used by a release to an
 * EXISTING application: that path keeps the app's plan and network (see `existingPrerequisites()` on the server). The explanation is shown only when the actual
 * blockers support it; it never suggests a value for any configuration variable.
 */
export const NEW_APP_ONLY_PREREQUISITES = ["plan_units_verified", "network_id"] as const;

export interface NewAppBlockerExplanation {
  /** only_new_app: every blocker is specific to creating an app · mixed: some are, others apply to both paths · none: nothing to explain */
  kind: "only_new_app" | "mixed" | "none";
  newAppOnly: string[];
  other: string[];
}

export function explainNewAppBlockers(prerequisites: readonly { id: string; ok: boolean; blocking: boolean }[], runBlockers: readonly string[]): NewAppBlockerExplanation {
  const failed = prerequisites.filter((p) => p.blocking && !p.ok).map((p) => p.id);
  const newAppOnly = failed.filter((id) => (NEW_APP_ONLY_PREREQUISITES as readonly string[]).includes(id));
  // run blockers (readiness, required secrets…) are not about "creating vs releasing": they belong to the "other" bucket, like the server's own `hardBlocked` rule
  const other = [...failed.filter((id) => !newAppOnly.includes(id)), ...runBlockers.filter((b) => !b.startsWith("sensitive_files"))];
  if (newAppOnly.length === 0) return { kind: "none", newAppOnly, other };
  return { kind: other.length === 0 ? "only_new_app" : "mixed", newAppOnly, other };
}
