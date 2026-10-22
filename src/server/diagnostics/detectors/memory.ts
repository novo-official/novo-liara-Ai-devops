import type { Detector, Finding, MetricSeriesData } from "../types";
import { classifyOom, lineMs } from "../signals";
import { excerpts, finding } from "./util";

const MIN_GROWTH_POINTS = 10;
const SUSTAINED_POINTS = 5;
const PRESSURE_RATIO = 0.9;

function growth(series: MetricSeriesData[]): { ratio: number; monotonicShare: number; applet: string | null } | null {
  let best: { ratio: number; monotonicShare: number; applet: string | null } | null = null;
  for (const s of series) {
    const p = s.points;
    if (p.length < MIN_GROWTH_POINTS || !s.first || !s.lastObservation || s.first.v <= 0) continue;
    let nonDecreasing = 0;
    for (let i = 1; i < p.length; i++) if (p[i]!.v >= p[i - 1]!.v) nonDecreasing++;
    const share = nonDecreasing / (p.length - 1);
    const ratio = s.lastObservation.v / s.first.v;
    if (!best || ratio > best.ratio) best = { ratio, monotonicShare: share, applet: s.applet };
  }
  return best;
}

/**
 * D. Memory pressure. Strongest evidence is an EXPLICIT OOM signal (event, applet reason, log). A raw metric alone can never
 * prove exhaustion: without a verified unit AND a known capacity limit only "raw growth" is reported, as a weak observation.
 */
export const memory: Detector = {
  id: "memory",
  run({ evidence, semantics }) {
    const findings: Finding[] = [];
    const limitations: string[] = [];

    // ---- explicit signals ----
    const sources: { text: string; ms: number | null; id: string | null }[] = [
      ...(evidence.data("runtime")?.applets ?? []).filter((a) => a.reason).map((a) => ({ text: a.reason!, ms: a.since ? Date.parse(a.since) : null, id: evidence.idOf("runtime") })),
      ...(evidence.data("events")?.rows ?? []).map((r) => ({ text: r.text, ms: r.time ? Date.parse(r.time) : null, id: evidence.idOf("events") })),
      ...(evidence.data("logs")?.lines ?? []).map((l) => ({ text: l.message, ms: lineMs(l), id: evidence.idOf("logs") })),
    ];
    const by = { explicit: [] as typeof sources, process_heap: [] as typeof sources, exit137: [] as typeof sources };
    for (const s of sources) {
      const k = classifyOom(s.text);
      if (k) by[k].push(s);
    }
    const ids = (xs: typeof sources) => [...new Set(xs.map((x) => x.id).filter((x): x is string => !!x))];
    const times = (xs: typeof sources) => xs.map((x) => x.ms).filter((x): x is number => x !== null);
    if (by.explicit.length) {
      findings.push(finding({ detector: "memory", hypothesis: "oom_kill", kind: "observation", strength: "strong", evidenceIds: ids(by.explicit), excerpts: excerpts(by.explicit.map((x) => x.text)), data: { count: by.explicit.length, via: "explicit_oom_signal" }, limitations: [], times: times(by.explicit) }));
    } else if (by.exit137.length) {
      findings.push(finding({ detector: "memory", hypothesis: "oom_kill", kind: "inference", strength: "moderate", evidenceIds: ids(by.exit137), excerpts: excerpts(by.exit137.map((x) => x.text)), data: { count: by.exit137.length, via: "exit_code_137" }, limitations: ["exit137_not_proof_of_oom"], times: times(by.exit137) }));
    }
    if (by.process_heap.length) {
      findings.push(finding({ detector: "memory", hypothesis: "memory_exhaustion_in_process", kind: "observation", strength: "strong", evidenceIds: ids(by.process_heap), excerpts: excerpts(by.process_heap.map((x) => x.text)), data: { count: by.process_heap.length }, limitations: ["process_heap_limit_not_container_limit"], times: times(by.process_heap) }));
    }

    // ---- metric-based evidence ----
    const item = evidence.item("memory");
    if (!item || item.availability === "missing") {
      if (item) limitations.push("memory_metrics_missing");
    } else if (item.availability === "stale") {
      limitations.push("memory_metrics_stale");
    } else if (item.availability === "available" && item.data) {
      const sem = semantics.memory;
      if (!sem) {
        limitations.push("memory_units_unverified");
        const g = growth(item.data.series);
        if (g && g.ratio >= 1.5 && g.monotonicShare >= 0.8) {
          findings.push(finding({ detector: "memory", hypothesis: "memory_growth_unverified", kind: "observation", strength: "weak", evidenceIds: [item.id], data: { growthRatio: Number(g.ratio.toFixed(2)), monotonicShare: Number(g.monotonicShare.toFixed(2)), applet: g.applet }, limitations: ["memory_units_unverified", "raw_values_only"] }));
        }
      } else if (sem.limit === undefined) {
        limitations.push("memory_limit_unknown");
      } else {
        for (const s of item.data.series) {
          const tail = s.points.slice(-SUSTAINED_POINTS);
          if (tail.length >= SUSTAINED_POINTS && tail.every((p) => p.v / sem.limit! >= PRESSURE_RATIO)) {
            findings.push(finding({ detector: "memory", hypothesis: "memory_pressure", kind: "observation", strength: "moderate", evidenceIds: [item.id], data: { ratioLast: Number((tail[tail.length - 1]!.v / sem.limit).toFixed(3)), unit: sem.unit, limit: sem.limit, samples: tail.length, semanticsOrigin: sem.origin, applet: s.applet }, limitations: sem.origin === "verified" ? [] : ["simulated_semantics"], suffix: s.applet ?? "0" }));
            break;
          }
        }
      }
    } else if (item.availability !== "available") {
      limitations.push(`memory_metrics_${item.availability}`);
    }
    return { findings, limitations };
  },
};
