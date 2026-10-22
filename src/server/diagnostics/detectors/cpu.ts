import type { Detector } from "../types";
import { finding } from "./util";

const SUSTAINED = 5;
const RATIO = 0.9;

/**
 * E. CPU saturation. Only with a verified unit AND a known limit in the same unit. Raw numbers are never turned into a
 * percentage. Even then the result is "moderate": utilisation is not the same as measured slowness.
 */
export const cpu: Detector = {
  id: "cpu",
  run({ evidence, semantics }) {
    const item = evidence.item("cpu");
    if (!item) return { findings: [], limitations: [] };
    if (item.availability === "missing") return { findings: [], limitations: ["cpu_metrics_missing"] };
    if (item.availability === "stale") return { findings: [], limitations: ["cpu_metrics_stale"] };
    if (item.availability !== "available" || !item.data) return { findings: [], limitations: [`cpu_metrics_${item.availability}`] };
    const sem = semantics.cpu;
    if (!sem) return { findings: [], limitations: ["cpu_units_unverified"] };
    if (sem.limit === undefined) return { findings: [], limitations: ["cpu_limit_unknown"] };
    for (const s of item.data.series) {
      const tail = s.points.slice(-SUSTAINED);
      if (tail.length >= SUSTAINED && tail.every((p) => p.v / sem.limit! >= RATIO)) {
        const ratios = tail.map((p) => p.v / sem.limit!);
        return {
          findings: [
            finding({
              detector: "cpu",
              hypothesis: "cpu_saturation",
              kind: "inference",
              strength: "moderate",
              evidenceIds: [item.id],
              data: { ratioLast: Number(ratios[ratios.length - 1]!.toFixed(3)), ratioMin: Number(Math.min(...ratios).toFixed(3)), samples: tail.length, unit: sem.unit, limit: sem.limit, semanticsOrigin: sem.origin, applet: s.applet },
              limitations: ["utilisation_not_latency", ...(sem.origin === "verified" ? [] : ["simulated_semantics"])],
            }),
          ],
          limitations: [],
        };
      }
    }
    return { findings: [], limitations: [] };
  },
};
