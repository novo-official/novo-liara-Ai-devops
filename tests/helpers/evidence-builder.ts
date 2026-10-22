import { EvidenceSet } from "@/server/diagnostics/evidence-set";
import { assessRuntime } from "@/server/domain/runtime";
import type { Applet, Release } from "@/server/domain/models";
import type { AnyEvidence, Availability, EvidenceItem, MetricSeriesData, SourceKey } from "@/server/diagnostics/types";
import { analyzePoints } from "@/server/liara/schemas";

export const NOW = Date.UTC(2026, 0, 2, 4, 0, 0);
const iso = (agoSec: number) => new Date(NOW - agoSec * 1000).toISOString();
export const RUN = "run_20260102040000_aabbccdd";

export interface Spec {
  window?: number;
  logs?: { ago: number; msg: string; stream?: string }[];
  events?: { ago: number; msg: string }[];
  applets?: { state: string; reason?: string | null; sinceAgo?: number }[];
  scale?: number | null;
  isDeployed?: boolean | null;
  envKeys?: string[];
  releases?: { tag: string; state: string; createdAgo: number; finishedAgo?: number }[];
  currentRelease?: string | null;
  cpu?: { points: [number, number][] }; // [agoSec, value]
  memory?: { points: [number, number][] };
  truncated?: boolean;
  /** force an availability for a source (data is then null) */
  availability?: Partial<Record<SourceKey, Availability>>;
  /** sources to omit entirely (not part of the intent) */
  omit?: SourceKey[];
  verification?: string;
}

function series(points: [number, number][]): MetricSeriesData {
  const pts = points.map(([ago, v]) => ({ t: Math.floor((NOW - ago * 1000) / 1000), v })).sort((a, b) => a.t - b.t);
  const an = analyzePoints(pts);
  return { applet: "a-1", count: pts.length, stepSeconds: an.stepSeconds, gaps: an.gapsAfter.length, first: pts[0] ?? null, lastObservation: an.lastObservation, min: pts.length ? Math.min(...pts.map((p) => p.v)) : null, max: pts.length ? Math.max(...pts.map((p) => p.v)) : null, points: pts };
}

/** Builds a fully-formed EvidenceSet from a compact spec (all items simulated, contract unverified). */
export function ev(spec: Spec = {}): EvidenceSet {
  const win = spec.window ?? 60;
  const window = { from: iso(win * 60), to: iso(0) };
  const items: AnyEvidence[] = [];
  const base = <K extends SourceKey>(source: K, capability: string, data: EvidenceItem<K>["data"], over: Partial<EvidenceItem<K>> = {}): EvidenceItem<K> => {
    const forced = spec.availability?.[source];
    return {
      id: `${RUN}/${source}`, source, capability, app: "demo-app", runId: RUN, mode: "mock", simulated: true, collectedAt: iso(0),
      window: source === "app" || source === "runtime" || source === "releases" ? null : window,
      availability: forced ?? "available", freshness: { state: "fresh", newestObservation: null, ageSec: null },
      verification: (spec.verification as never) ?? "DOCUMENTED_UNVERIFIED", data: forced && forced !== "available" && forced !== "stale" ? null : data, notes: [], ...over,
    } as EvidenceItem<K>;
  };
  const add = (i: AnyEvidence) => !spec.omit?.includes(i.source) && items.push(i);

  add(base("app", "getApp", { name: "demo-app", platform: "node", status: "running", scale: spec.scale ?? 1, planId: "p", isDeployed: spec.isDeployed ?? true, envKeys: spec.envKeys ?? ["NODE_ENV"] }));
  const applets: Applet[] = (spec.applets ?? [{ state: "running" }]).map((a, i) => ({ id: `a${i}`, name: `app-${i}`, since: iso(a.sinceAgo ?? 86400), state: a.state, reason: a.reason ?? null, releaseTag: null }));
  add(base("runtime", "getApplets", { assessment: assessRuntime({ scale: spec.scale ?? 1, isDeployed: spec.isDeployed ?? true }, { items: applets }), applets }));
  const releases: Release[] = (spec.releases ?? []).map((r) => ({ id: `r-${r.tag}`, type: "source", state: r.state, port: 3000, tag: r.tag, createdAt: iso(r.createdAgo), finishedAt: iso(r.finishedAgo ?? r.createdAgo - 60), sourceAvailable: true, branch: "main", commit: "abc123", message: "m" }));
  add(base("releases", "getReleases", { total: releases.length, currentRelease: spec.currentRelease ?? releases.find((r) => !/fail/i.test(r.state ?? ""))?.tag ?? null, releases }));
  const events = spec.events ?? [];
  add(base("events", "getEvents", { rows: events.map((e) => ({ time: iso(e.ago), timeInferred: true, text: e.msg })), truncated: false }, events.length === 0 && !spec.availability?.events ? { availability: "missing" as const, data: null } : {}));
  const logs = spec.logs ?? [];
  add(base("logs", "getLogsV1", { lines: logs.map((l) => ({ time: iso(l.ago), stream: l.stream ?? "stdout", message: l.msg })), truncated: spec.truncated ?? false, source: "v1" }, logs.length === 0 && !spec.availability?.logs ? { availability: "missing" as const, data: null } : {}));
  for (const k of ["cpu", "memory"] as const) {
    const m = spec[k];
    add(base(k, k === "cpu" ? "getMetricsCpu" : "getMetricsMemory", m ? { unit: null, schema: "ok", windowStart: 0, windowEnd: 0, series: [series(m.points)] } : null, m || spec.availability?.[k] ? {} : { availability: "missing" as const }));
  }
  return new EvidenceSet(items);
}

/** Evenly spaced points: `n` samples, `stepSec` apart, ending `endAgo` seconds ago, values from fn(i). */
export const pts = (n: number, stepSec: number, fn: (i: number) => number, endAgo = 0): [number, number][] => Array.from({ length: n }, (_, i) => [endAgo + (n - 1 - i) * stepSec, fn(i)] as [number, number]);
