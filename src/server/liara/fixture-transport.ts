import type { z } from "zod";
import apps from "../../../fixtures/mock/apps.json";
import details from "../../../fixtures/mock/details.json";
import applets from "../../../fixtures/mock/applets.json";
import releases from "../../../fixtures/mock/releases.json";
import events from "../../../fixtures/mock/events.json";
import logs from "../../../fixtures/mock/logs.json";
import metrics from "../../../fixtures/mock/metrics.json";
import type { EndpointId } from "./endpoints";
import { LiaraError } from "./errors";
import { issuesOf } from "./schemas";
import type { Transport } from "./read-client";

/**
 * MOCK transport: serves SIMULATED, sanitized fixtures in the documented raw response shapes and
 * runs them through the exact same schemas/projections as live responses.
 * Nothing here is real Liara data; the UI labels it as simulated.
 */

type Json = null | boolean | number | string | Json[] | { [k: string]: Json };

/** Replaces `$ago:S` (ISO), `$agoNs:S` (ns epoch string) markers with times relative to `nowMs`. */
export function materialize(value: Json, nowMs: number): Json {
  if (typeof value === "string") {
    const m = /^\$(ago|agoNs):(\d+)$/.exec(value);
    if (!m) return value;
    const ms = nowMs - Number(m[2]) * 1000;
    return m[1] === "ago" ? new Date(ms).toISOString() : String(BigInt(Math.floor(ms)) * 1_000_000n);
  }
  if (Array.isArray(value)) return value.map((v) => materialize(v, nowMs));
  if (value && typeof value === "object") {
    return Object.fromEntries(Object.entries(value).filter(([k]) => k !== "_simulated").map(([k, v]) => [k, materialize(v, nowMs)]));
  }
  return value;
}

export const MOCK_APP_NAMES: readonly string[] = Object.keys(details).filter((k) => !k.startsWith("_"));

interface Profile {
  base: number;
  amp: number;
  period: number;
  trend: number;
  /** Seconds-ago ranges [from, to] with NO samples (simulates scrape gaps). */
  gaps?: [number, number][];
  /** The series stops this many seconds before "now" (simulates a stale measurement). */
  endAgo?: number;
}

/** Deterministic Prometheus-style series: [[unixSeconds, "value"], ...] every 60 s. */
export function synthSeries(p: Profile, since: number, end: number): [number, string][] {
  const out: [number, string][] = [];
  const first = Math.ceil(since / 60) * 60;
  const last = end - (p.endAgo ?? 0);
  for (let t = first; t <= last; t += 60) {
    if (p.gaps?.some(([from, to]) => t >= end - from && t <= end - to)) continue;
    const v = p.base + p.amp * Math.sin((2 * Math.PI * t) / p.period) + p.trend * ((t - first) / 60);
    out.push([t, Math.max(0, v).toFixed(4)]);
  }
  return out;
}

/** SYNTHETIC plan catalogue for mock mode (ids are obviously fake; nothing here comes from Liara). Same shape as the live `/v1/me` plans. */
const SIMULATED_ME = {
  _simulated: true,
  plans: {
    projects: {
      "sim-plan-a": { available: true, region: "sim", RAM: { amount: 0.5, shared: true }, CPU: { amount: 0.25, shared: true }, volume: 1, price: 1 },
      "sim-plan-b": { available: true, region: "sim", RAM: { amount: 1, shared: false }, CPU: { amount: 1, shared: false }, volume: 5, price: 2 },
      "sim-plan-c": { available: false, region: "sim", RAM: { amount: 4, shared: false }, CPU: { amount: 2, shared: false }, volume: 10, price: 8 },
    },
    projectBundlePlans: {},
  },
} as const;

export class FixtureTransport implements Transport {
  readonly mode = "mock" as const;
  constructor(private readonly now: () => number = Date.now) {}

  async get<S extends z.ZodType>(
    endpointId: EndpointId,
    args: { name?: string; query?: Record<string, string | number | boolean> },
    schema: S,
  ): Promise<z.output<S>> {
    const nowMs = this.now();
    const raw = this.raw(endpointId, args, nowMs);
    const parsed = schema.safeParse(materialize(raw as Json, nowMs));
    if (!parsed.success) {
      throw new LiaraError("contract_mismatch", "Fixture did not match the expected contract", {
        issues: issuesOf(parsed.error),
        endpoint: endpointId,
      });
    }
    return parsed.data;
  }

  private raw(id: EndpointId, args: { name?: string; query?: Record<string, string | number | boolean> }, nowMs: number): unknown {
    if (id === "listApps") return apps;
    if (id === "getMe") return SIMULATED_ME;
    if (id === "getBilling") return { user: { balance: 0, accountType: "SIMULATED" } };
    if (id === "listNetworks") return { networks: [{ _id: "net-sim-0001", name: "simulated-network", createdAt: "time" }] };
    const name = args.name ?? "";
    const pick = <T,>(table: Record<string, T>): T => {
      const v = table[name];
      if (!name || name.startsWith("_") || v === undefined) throw new LiaraError("not_found", "Application not found", { status: 404, endpoint: id });
      return v;
    };
    switch (id) {
      case "getApp":
        return pick(details as Record<string, unknown>);
      case "getApplets":
        return pick(applets as Record<string, unknown>);
      case "getReleases":
        return pick(releases as Record<string, unknown>);
      case "getEvents":
        return pick(events as Record<string, unknown>);
      case "getLogsV1":
        return pick(logs as Record<string, unknown>);
      case "getLogsV2":
        throw new LiaraError("unsupported", "Mock transport only simulates the documented v1 logs endpoint", { endpoint: id });
      case "getMetricsCpu":
      case "getMetricsMemory": {
        const prof = pick(metrics as unknown as Record<string, { cpu: Profile | null; memory: Profile | null }>);
        const p = id === "getMetricsCpu" ? prof.cpu : prof.memory;
        const end = Math.floor(nowMs / 1000);
        const since = Number(args.query?.since ?? end - 3600);
        if (!p) return { end, result: [] }; // stopped app: no series (empty-metrics case)
        const appletList = (applets as unknown as Record<string, { applets: { name: string }[] }>)[name]?.applets ?? [];
        const names = appletList.length ? appletList.map((a) => a.name) : [name];
        return {
          end,
          result: names.map((n, i) => ({
            applet: n,
            values: synthSeries({ ...p, base: p.base * (1 + i * 0.06) }, since, end),
          })),
        };
      }
      default:
        throw new LiaraError("unsupported", "Endpoint not available", { endpoint: id });
    }
  }
}
