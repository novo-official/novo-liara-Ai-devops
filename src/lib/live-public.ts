/**
 * Public (browser-facing) shape of the live API. Internal bindings that identify WHO or WHICH TEAM an operation belongs to are never sent to the browser:
 *  - `ownerHash` / `actorHash` (session-derived hashes; the server compares them itself, the browser has no use for them)
 *  - `teamId` (the raw Liara team identifier) is replaced by the coarse `teamScope`
 * Pure and recursive, so a field added to a nested record later cannot leak by accident.
 */
const DROPPED = new Set(["ownerHash", "actorHash"]);

export type TeamScope = "team" | "personal";

export type Public<T> = T extends readonly (infer U)[]
  ? Public<U>[]
  : T extends object
    ? { [K in keyof T as K extends "ownerHash" | "actorHash" | "teamId" ? never : K]: Public<T[K]> } & ("teamId" extends keyof T ? { teamScope: TeamScope } : unknown)
    : T;

export function toPublicLive<T>(value: T): Public<T> {
  return scrub(value) as Public<T>;
}

function scrub(v: unknown): unknown {
  if (Array.isArray(v)) return v.map(scrub);
  if (v === null || typeof v !== "object") return v;
  const out: Record<string, unknown> = {};
  for (const [k, val] of Object.entries(v as Record<string, unknown>)) {
    if (DROPPED.has(k)) continue;
    if (k === "teamId") {
      out.teamScope = typeof val === "string" && val ? "team" : "personal";
      continue;
    }
    out[k] = scrub(val);
  }
  return out;
}
