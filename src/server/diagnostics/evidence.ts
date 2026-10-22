import type { LiaraService } from "../liara/service";
import { capabilityReport } from "../liara/capabilities";
import { isStaleMeasurement } from "@/lib/metrics";
import { type AnyEvidence, type Availability, type EvidenceItem, type Freshness, type Intent, type MetricEvidenceData, type SourceKey } from "./types";
import { EvidenceSet } from "./evidence-set";
import { assessRuntime } from "../domain/runtime";
import type { MetricResult, Section } from "../domain/models";
import type { WindowMinutes } from "../liara/read-client";

/** Which sources each supported intent needs. Everything is bounded: one fetch per source, fixed limits. */
export const SOURCES_BY_INTENT: Record<Intent, SourceKey[]> = {
  why_restarting: ["app", "runtime", "events", "logs", "releases", "memory"],
  why_slow: ["app", "runtime", "cpu", "memory", "logs", "events", "releases"],
  investigate_http_500: ["app", "runtime", "logs", "events", "releases", "memory"],
  recent_deployment_failures: ["app", "runtime", "releases", "events", "logs"],
};

const CAPABILITY: Record<SourceKey, string> = {
  app: "getApp",
  runtime: "getApplets",
  releases: "getReleases",
  events: "getEvents",
  logs: "getLogsV1",
  cpu: "getMetricsCpu",
  memory: "getMetricsMemory",
};

export interface CollectOptions {
  runId: string;
  app: string;
  intent: Intent;
  windowMinutes: WindowMinutes;
  now: () => number;
  /** Per-source timeout (ms). The underlying HTTP layer has its own bounded timeouts/retries. */
  sourceTimeoutMs: number;
  /** Hard cap on source fetches for this run (request budget). */
  maxSources: number;
  signal?: AbortSignal;
  onProgress?: (source: SourceKey, phase: "start" | "done", item?: AnyEvidence) => void;
}

const MAX_CONCURRENT_SOURCES = 3;
const LOG_LIMIT = 200;

function withTimeout<T>(p: Promise<T>, ms: number, signal?: AbortSignal): Promise<T> {
  return new Promise<T>((resolve, reject) => {
    const t = setTimeout(() => reject(Object.assign(new Error("timeout"), { code: "timeout" })), ms);
    const onAbort = () => reject(Object.assign(new Error("aborted"), { code: "cancelled" }));
    signal?.addEventListener("abort", onAbort, { once: true });
    p.then(
      (v) => {
        clearTimeout(t);
        signal?.removeEventListener("abort", onAbort);
        resolve(v);
      },
      (e) => {
        clearTimeout(t);
        signal?.removeEventListener("abort", onAbort);
        reject(e);
      },
    );
  });
}

export function availabilityForError(code: string): Availability {
  switch (code) {
    case "unauthorized":
    case "forbidden":
      return "access_denied";
    case "not_found":
    case "unsupported":
      return "unsupported";
    case "contract_mismatch":
      return "contract_mismatch";
    case "no_content":
      return "no_content";
    default:
      return "collection_failed"; // timeout, network, upstream_error, rate_limited, response_too_large, cancelled, internal
  }
}

const ageSec = (nowMs: number, iso: string | null) => (iso ? Math.max(0, Math.round((nowMs - Date.parse(iso)) / 1000)) : null);
const unknownFresh: Freshness = { state: "unknown", newestObservation: null, ageSec: null };

function metricData(r: MetricResult): MetricEvidenceData {
  return {
    unit: r.unit,
    schema: r.schema,
    windowStart: r.windowStart,
    windowEnd: r.windowEnd,
    series: r.series.map((s) => ({
      applet: s.applet,
      count: s.points.length,
      stepSeconds: s.stepSeconds,
      gaps: s.gapsAfter.length,
      first: s.points[0] ?? null,
      lastObservation: s.lastObservation,
      min: s.points.length ? Math.min(...s.points.map((p) => p.v)) : null,
      max: s.points.length ? Math.max(...s.points.map((p) => p.v)) : null,
      points: s.points,
    })),
  };
}

/**
 * Collects structured, sanitised evidence through the read-only LiaraService (the ONLY data boundary: raw API data never
 * reaches this layer). One attempt per source — the HTTP client already performs bounded retries — so no retry multiplication.
 * Missing, unsupported, denied, stale and failed sources are represented explicitly; nothing is fabricated.
 */
export interface SourceCollectorOptions {
  runId: string;
  app: string;
  windowMinutes: WindowMinutes;
  now: () => number;
  sourceTimeoutMs: number;
  signal?: AbortSignal;
}

/**
 * Per-source collector shared by the one-shot `collectEvidence` (Phase 1C) and the agent tool registry (Phase 1D).
 * One upstream attempt per source; the app summary request is shared across sources; failures become explicit evidence items.
 */
export function createSourceCollector(svc: LiaraService, o: SourceCollectorOptions): { collect(source: SourceKey): Promise<AnyEvidence>; fail(source: SourceKey, e: unknown): AnyEvidence } {
  const win = o.windowMinutes;
  const nowMs = o.now();
  const collectedAt = new Date(nowMs).toISOString();
  const windowObj = { from: new Date(nowMs - win * 60_000).toISOString(), to: collectedAt };
  const mode = svc.mode;
  const caps = capabilityReport(mode, false);
  const verificationOf = (cap: string) => caps.find((c) => c.id === cap)!.verification;

  // runtime needs the app summary (scale/isDeployed); fetch app once and share it
  // cache the in-flight PROMISE (not the result) so concurrent sources never trigger a second upstream call
  let appPromise: Promise<Section<import("../domain/models").AppDetail>> | null = null;
  const getApp = () => (appPromise ??= svc.getApp(o.app));

  const base = <K extends SourceKey>(source: K, availability: Availability, extra: Partial<EvidenceItem<K>> = {}): EvidenceItem<K> => ({
    id: `${o.runId}/${source}`,
    source,
    capability: CAPABILITY[source],
    app: o.app,
    runId: o.runId,
    mode,
    simulated: mode === "mock",
    collectedAt,
    window: source === "app" || source === "releases" || source === "runtime" ? null : windowObj,
    availability,
    freshness: unknownFresh,
    verification: verificationOf(CAPABILITY[source]),
    data: null,
    notes: [],
    ...extra,
  });

  const fail = <K extends SourceKey>(source: K, e: unknown): EvidenceItem<K> => {
    const code = (e as { code?: string })?.code ?? "internal";
    return base(source, availabilityForError(code), { errorCode: code });
  };
  const fromSection = <K extends SourceKey, T>(source: K, s: Section<T>, build: (d: T) => Partial<EvidenceItem<K>>): EvidenceItem<K> =>
    s.ok ? base(source, "available", build(s.data)) : base(source, availabilityForError(s.error.code), { errorCode: s.error.code });

  const fetchOne = async (source: SourceKey): Promise<AnyEvidence> => {
    switch (source) {
      case "app": {
        const s = await getApp();
        return fromSection("app", s, (d) => ({ data: { name: d.name, platform: d.platform, status: d.status, scale: d.scale, planId: d.planId, isDeployed: d.isDeployed, envKeys: d.envKeys.map((k) => k.key) } }));
      }
      case "runtime": {
        const [a, ap] = await Promise.all([getApp(), svc.getApplets(o.app)]);
        if (!ap.ok) return fail("runtime", { code: ap.error.code });
        const summary = a.ok ? a.data : { scale: null, isDeployed: null };
        const assessment = assessRuntime(summary, ap.data);
        const newest = ap.data.items.map((x) => x.since).filter((x): x is string => !!x).sort().at(-1) ?? null;
        return base("runtime", "available", { data: { assessment, applets: ap.data.items }, freshness: { state: "fresh", newestObservation: newest, ageSec: ageSec(nowMs, newest) } });
      }
      case "releases": {
        const s = await svc.getReleases(o.app, 1, 10);
        return fromSection("releases", s, (d) => ({ data: { total: d.total, currentRelease: d.currentRelease, releases: d.releases } }));
      }
      case "events": {
        const s = await svc.getEvents(o.app, win);
        if (!s.ok) return fail("events", { code: s.error.code });
        if (s.data.rows.length === 0) return base("events", "missing", { notes: ["empty_response"] });
        const newest = s.data.rows.map((r) => r.time).filter((t): t is string => !!t).sort().at(-1) ?? null;
        return base("events", "available", { data: s.data, freshness: { state: newest ? "fresh" : "unknown", newestObservation: newest, ageSec: ageSec(nowMs, newest) } });
      }
      case "logs": {
        const s = await svc.getLogs(o.app, win, LOG_LIMIT);
        if (!s.ok) return fail("logs", { code: s.error.code });
        if (s.data.lines.length === 0) return base("logs", "missing", { notes: ["empty_response"] });
        const newest = s.data.lines.map((l) => l.time).filter((t): t is string => !!t).sort().at(-1) ?? null;
        return base("logs", "available", { data: { lines: s.data.lines, truncated: s.data.truncated, source: s.data.source }, freshness: { state: newest ? "fresh" : "unknown", newestObservation: newest, ageSec: ageSec(nowMs, newest) } });
      }
      case "cpu":
      case "memory": {
        const s = await svc.getMetrics(o.app, source, win);
        if (!s.ok) return fail(source, { code: s.error.code });
        if (s.data.schema === "unsupported") return base(source, "unsupported", { notes: ["metric_schema_unsupported"] });
        if (s.data.schema === "empty") return base(source, "missing", { notes: ["empty_response"] });
        const data = metricData(s.data);
        const lasts = data.series.map((x) => x.lastObservation?.t).filter((t): t is number => t !== undefined);
        const newestSec = lasts.length ? Math.max(...lasts) : null;
        const step = data.series.map((x) => x.stepSeconds).filter((x): x is number => x !== null)[0] ?? null;
        const age = newestSec === null ? null : Math.max(0, Math.round(nowMs / 1000 - newestSec));
        const stale = age !== null && isStaleMeasurement(age, step);
        const newestIso = newestSec === null ? null : new Date(newestSec * 1000).toISOString();
        const item = base(source, stale ? "stale" : "available", { data, freshness: { state: stale ? "stale" : "fresh", newestObservation: newestIso, ageSec: age } });
        if (data.unit === null) item.notes.push("unit_unverified");
        return item;
      }
    }
  };

  return {
    fail: (source, e) => fail(source, e) as AnyEvidence,
    async collect(source) {
      try {
        return await withTimeout(fetchOne(source), o.sourceTimeoutMs, o.signal);
      } catch (e) {
        return fail(source, e) as AnyEvidence;
      }
    },
  };
}

/** One-shot collection of every source an intent needs (bounded concurrency, cancellation-aware). */
export async function collectEvidence(svc: LiaraService, o: CollectOptions): Promise<EvidenceSet> {
  const sources = SOURCES_BY_INTENT[o.intent].slice(0, o.maxSources);
  const collector = createSourceCollector(svc, o);
  const results = new Map<SourceKey, AnyEvidence>();
  const queue = [...sources];
  const worker = async () => {
    for (;;) {
      if (o.signal?.aborted) return;
      const source = queue.shift();
      if (!source) return;
      o.onProgress?.(source, "start");
      const item = await collector.collect(source);
      results.set(source, item);
      o.onProgress?.(source, "done", item);
    }
  };
  await Promise.all(Array.from({ length: Math.min(MAX_CONCURRENT_SOURCES, sources.length) }, worker));
  if (o.signal?.aborted) throw Object.assign(new Error("cancelled"), { code: "cancelled" });
  return new EvidenceSet(sources.map((s) => results.get(s)!).filter(Boolean));
}
