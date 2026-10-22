import type { z } from "zod";
import type { EndpointId } from "./endpoints";
import { VERIFIED_METRIC_UNITS } from "../domain/vocabulary";
import { LiaraError } from "./errors";
import { projectPlanCatalogue, type PlanProjection } from "./plans";
import {
  AppDetailResponse,
  AppListSchema,
  AppletsSchema,
  BillingProjectionSchema,
  EventsSchema,
  LogsV1Schema,
  LogsV2Schema,
  MeProjectionSchema,
  MetricsSchema,
  NetworksSchema,
  ReleasesSchema,
  projectEvents,
} from "./schemas";
import type {
  Applet,
  AppDetail,
  AppSummary,
  DataMode,
  EventsResult,
  LogsResult,
  MetricResult,
  ReleaseList,
} from "../domain/models";

/** Anything able to perform a validated GET. Implemented by the live HTTP client and the fixture transport. */
export interface Transport {
  readonly mode: DataMode;
  get<S extends z.ZodType>(
    endpointId: EndpointId,
    args: { name?: string; query?: Record<string, string | number | boolean> },
    schema: S,
  ): Promise<z.output<S>>;
}

export interface ReadClientOptions {
  logsApi: "v1" | "v2" | "auto";
  allowUndocumented: boolean;
  now?: () => number;
}

export const MAX_LIST = 500;
export const WINDOWS_MINUTES = [15, 60, 360, 1440] as const;
export type WindowMinutes = (typeof WINDOWS_MINUTES)[number];

export interface Listing<T> {
  items: T[];
  skipped: number;
}

/** Typed, read-only operations. Contains no mutation methods and no generic request method. */
export class LiaraReadClient {
  constructor(
    private readonly t: Transport,
    private readonly o: ReadClientOptions,
  ) {}

  get mode(): DataMode {
    return this.t.mode;
  }
  private nowSec() {
    return Math.floor((this.o.now ?? Date.now)() / 1000);
  }

  async listApps(): Promise<Listing<AppSummary>> {
    const r = await this.t.get("listApps", {}, AppListSchema);
    return { items: r.projects.items.slice(0, MAX_LIST), skipped: r.projects.skipped };
  }

  /** Plan catalogue: `GET /v1/me` projected inside the adapter (profile/team/storage keys never leave it). Raw values only; units are NOT interpreted here. */
  async getPlanCatalogue(): Promise<PlanProjection> {
    const r = await this.t.get("getMe", {}, MeProjectionSchema);
    return projectPlanCatalogue(r.plans.projects, r.plans.projectBundlePlans ?? {}, 200, { teamPresent: r.team != null, teamBalance: typeof r.team?.balance === "number" ? r.team.balance : null });
  }

  /** `GET /v1/billing` (documented, `billing.yaml`): only the numeric balance leaves the adapter. */
  async getBilling(): Promise<{ balance: number | null }> {
    return this.t.get("getBilling", {}, BillingProjectionSchema);
  }

  /** `GET /v1/networks` — CLI-observed, undocumented: refused unless the operator explicitly opted in. Never creates anything. */
  async listNetworks(): Promise<{ items: { id: string; name: string | null }[]; skipped: number }> {
    if (!this.o.allowUndocumented) throw new LiaraError("unsupported", "Undocumented endpoint not enabled");
    return this.t.get("listNetworks", {}, NetworksSchema);
  }

  async getApp(name: string): Promise<AppDetail> {
    return this.t.get("getApp", { name }, AppDetailResponse);
  }

  async getApplets(name: string): Promise<Listing<Applet>> {
    const r = await this.t.get("getApplets", { name }, AppletsSchema);
    return { items: r.applets.items.slice(0, 50), skipped: r.applets.skipped };
  }

  async getReleases(name: string, page = 1, count = 10): Promise<ReleaseList> {
    const p = Math.min(Math.max(1, Math.trunc(page)), 50);
    const c = Math.min(Math.max(1, Math.trunc(count)), 20);
    const r = await this.t.get("getReleases", { name, query: { page: p, count: c } }, ReleasesSchema);
    return {
      total: r.total,
      currentRelease: r.currentRelease,
      releases: (r.releases?.items ?? []).slice(0, c),
      skipped: r.releases?.skipped ?? 0,
    };
  }

  async getEvents(name: string, windowMinutes: WindowMinutes, limit = 50): Promise<EventsResult> {
    const end = this.nowSec();
    const start = end - windowMinutes * 60;
    const r = await this.t.get("getEvents", { name, query: { start, end } }, EventsSchema);
    return projectEvents(r.data, Math.min(limit, 100));
  }

  async getLogs(name: string, windowMinutes: WindowMinutes, limit = 200): Promise<LogsResult> {
    const cap = Math.min(Math.max(1, limit), 500);
    const since = this.nowSec() - windowMinutes * 60;
    const strategy = this.o.logsApi;

    const v1 = async (): Promise<LogsResult> => {
      // `since` format is unspecified upstream; unix seconds (as a string) is an UNVERIFIED assumption.
      const lines = await this.t.get("getLogsV1", { name, query: { since: String(since) } }, LogsV1Schema);
      return finish(lines, "v1", "documented");
    };
    const v2 = async (): Promise<LogsResult> => {
      if (!this.o.allowUndocumented) {
        throw new LiaraError("unsupported", "Undocumented logs endpoint is disabled");
      }
      const r = await this.t.get(
        "getLogsV2",
        { name, query: { start: since, direction: "forward", last_lines: false } },
        LogsV2Schema,
      );
      return finish(r, "v2", "observed");
    };
    const finish = (lines: LogsResult["lines"], source: "v1" | "v2", contract: "documented" | "observed"): LogsResult => ({
      lines: lines.slice(-cap),
      truncated: lines.length > cap,
      source,
      contract,
    });

    if (strategy === "v1") return v1();
    if (strategy === "v2") return v2();
    // auto: documented v1 first; fall back to observed v2 only for contract-type failures.
    try {
      return await v1();
    } catch (e) {
      if (e instanceof LiaraError && (e.code === "not_found" || e.code === "contract_mismatch" || e.status === 400)) {
        return { ...(await v2()), v1FallbackReason: e.code };
      }
      throw e;
    }
  }

  async getMetrics(name: string, kind: "cpu" | "memory", windowMinutes: WindowMinutes): Promise<MetricResult> {
    const end = this.nowSec();
    const since = end - windowMinutes * 60;
    const id: EndpointId = kind === "cpu" ? "getMetricsCpu" : "getMetricsMemory";
    const r = await this.t.get(id, { name, query: { since } }, MetricsSchema);
    const withData = r.series.filter((x) => x.points.length > 0);
    // "unsupported" = the API sent something but none of it could be interpreted; distinct from a genuine empty result.
    const schema: MetricResult["schema"] = withData.length > 0 ? "ok" : r.rawSeriesCount === 0 ? "empty" : "unsupported";
    return {
      kind,
      unit: VERIFIED_METRIC_UNITS[kind] ?? null,
      series: r.series,
      windowStart: since,
      windowEnd: end,
      schema,
      droppedSeries: r.droppedSeries,
      droppedPoints: r.droppedPoints,
    };
  }
}
