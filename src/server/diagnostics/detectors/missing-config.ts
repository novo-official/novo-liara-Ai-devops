import type { Detector } from "../types";
import { extractMissingConfig } from "../signals";
import { finding } from "./util";

/**
 * C. Missing required configuration. Extracts variable NAMES only (never values) and cross-checks them against the
 * app's configured env KEY list. A key that exists but still fails cannot be judged: values are never read.
 */
export const missingConfig: Detector = {
  id: "missing_config",
  run({ evidence }) {
    const texts: { text: string; id: string }[] = [
      ...(evidence.data("logs")?.lines ?? []).map((l) => ({ text: l.message, id: evidence.idOf("logs")! })),
      ...(evidence.data("events")?.rows ?? []).map((r) => ({ text: r.text, id: evidence.idOf("events")! })),
    ];
    const names = new Map<string, number>();
    let generic = 0;
    let hitCount = 0;
    const ids = new Set<string>();
    for (const { text, id } of texts) {
      const m = extractMissingConfig(text);
      if (!m) continue;
      hitCount++;
      ids.add(id);
      if (m.generic) generic++;
      for (const n of m.names) names.set(n, (names.get(n) ?? 0) + 1);
    }
    if (hitCount === 0) return { findings: [], limitations: [] };

    const limitations: string[] = [];
    const app = evidence.data("app");
    const keys = app?.envKeys ?? null;
    if (!keys) limitations.push("env_keys_unavailable");
    else if (app) ids.add(evidence.idOf("app")!);
    const list = [...names.keys()].sort();
    const absent = keys ? list.filter((n) => !keys.includes(n)) : [];
    const presentButFailing = keys ? list.filter((n) => keys.includes(n)) : [];
    const lim: string[] = [];
    if (presentButFailing.length) lim.push("env_key_present_value_unverifiable");
    if (list.length === 0) lim.push("config_error_without_variable_name");

    // strong: names are explicit AND at least one is confirmed absent from the configured keys
    const strength = absent.length > 0 ? "strong" : list.length > 0 ? "moderate" : "weak";
    return {
      findings: [
        finding({
          detector: "missing_config",
          hypothesis: "missing_configuration",
          kind: "observation",
          strength,
          evidenceIds: [...ids],
          // NO excerpts on purpose: these lines sit next to configuration values, and redaction is heuristic. Names are enough.
          data: { names: list, absent, presentButFailing, count: hitCount, genericOnly: list.length === 0 && generic > 0 },
          limitations: lim,
        }),
      ],
      limitations,
    };
  },
};
