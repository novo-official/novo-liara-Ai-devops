import type { Finding, Strength } from "../types";
import { excerpt } from "../signals";
import { Pseudonymizer } from "../../security/pseudonym";

/** Deterministic finding ids: `<detector>:<hypothesis>[:<suffix>]`. */
export function finding(f: Omit<Finding, "id" | "excerpts"> & { excerpts?: string[]; suffix?: string }): Finding {
  const { suffix, excerpts, ...rest } = f;
  return { ...rest, id: `${f.detector}:${f.hypothesis}${suffix ? `:${suffix}` : ""}`, excerpts: excerpts ?? [] };
}

/** Evidence-count → strength. Explicit repeated messages are strong; a single line is only a weak signal. */
export const strengthByCount = (n: number): Strength => (n >= 3 ? "strong" : n === 2 ? "moderate" : "weak");

export const MINUTE = 60_000;

/** Distinct, sanitised excerpts (max `n`), pseudonymising hosts consistently within one finding. */
export function excerpts(texts: string[], n = 3): string[] {
  const p = new Pseudonymizer();
  const out: string[] = [];
  for (const t of texts) {
    const e = excerpt(t, 200, p);
    if (!out.includes(e)) out.push(e);
    if (out.length >= n) break;
  }
  return out;
}

/** Merge timestamps closer than `gapMs` into one cycle (an "exited" line and its "restarted" event are one restart). */
export function clusterTimes(times: number[], gapMs = 30_000): number[] {
  const sorted = [...times].sort((a, b) => a - b);
  const cycles: number[] = [];
  for (const t of sorted) {
    if (cycles.length === 0 || t - cycles[cycles.length - 1]! > gapMs) cycles.push(t);
  }
  return cycles;
}
