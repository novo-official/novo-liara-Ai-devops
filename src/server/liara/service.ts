import "server-only";
import { APP_NAME_REGEX, getConfig, type AppConfig } from "../config/env";
import type {
  AppDetail,
  AppSummary,
  Applet,
  DataMode,
  EventsResult,
  LogsResult,
  MetricResult,
  ReleaseList,
  Section,
} from "../domain/models";
import { redactDeep } from "../security/redact";
import { log } from "../security/logger";
import { capabilityReport, lastSuccessAt, NOT_AVAILABLE, recordOutcome, type CapabilityReport } from "./capabilities";
import { assessRuntime, type RuntimeAssessment } from "../domain/runtime";
import { isLiaraError, LiaraError } from "./errors";
import { FixtureTransport, MOCK_APP_NAMES } from "./fixture-transport";
import { LiaraHttpClient } from "./http";
import { LiaraReadClient, WINDOWS_MINUTES, type Listing, type WindowMinutes } from "./read-client";
import type { PlanProjection } from "./plans";
import { bootstrappedScopeLookup } from "./scope-db";

/**
 * Application-facing, read-only facade. Responsibilities:
 *  - enforce the explicit app allowlist BEFORE any upstream call (all app-scoped methods)
 *  - filter the account-wide app list down to the allowlist before anything leaves this layer
 *  - record per-capability outcomes (for the diagnostics screen)
 *  - convert failures into `Section` results so one failing panel does not break a page
 *  - deep-redact everything returned (defence in depth on top of schema projections)
 */
export class LiaraService {
  constructor(
    private readonly client: LiaraReadClient,
    private readonly cfg: AppConfig,
    private readonly now: () => number = Date.now,
  ) {}

  get mode(): DataMode {
    return this.client.mode;
  }

  /** Exact-match allowlist. Unknown, malformed and non-allowlisted names are indistinguishable to callers. */
  isAllowed(name: string): boolean {
    if (typeof name !== "string" || !APP_NAME_REGEX.test(name)) return false;
    // Apps created by a VERIFIED live deployment operation may be added to the operator's scope (live/bootstrap); the allowlist is never disabled.
    if (this.scopeExtension?.(name)) return true;
    const list = this.cfg.allowedApps;
    if (list) return list.has(name);
    return this.mode === "mock" && MOCK_APP_NAMES.includes(name);
  }

  private scopeExtension: ((name: string) => boolean) | null = null;
  /** Installs the (read-only) predicate for transactionally bootstrapped apps. It can only ADD exact names; it cannot remove or widen anything else. */
  setScopeExtension(fn: ((name: string) => boolean) | null): void {
    this.scopeExtension = fn;
  }

  /**
   * Existence of an application NAME in the configured team scope (names only; no details). Deliberately NOT filtered by the allowlist: it is how the live
   * deployment layer checks "does this new name already exist?" and reconciles after a timeout. Only a boolean (or an error code) leaves this method.
   */
  async appNameExists(name: string): Promise<{ ok: true; exists: boolean } | { ok: false; code: string }> {
    if (typeof name !== "string" || !APP_NAME_REGEX.test(name)) return { ok: false, code: "invalid_input" };
    try {
      const r = await this.client.listApps();
      if (r.skipped > 0 || r.items.length >= 500) return { ok: false, code: "list_incomplete" }; // an unreadable/truncated list proves nothing
      return { ok: true, exists: r.items.some((a) => a.name === name) };
    } catch (e) {
      return { ok: false, code: isLiaraError(e) ? e.code : "internal" };
    }
  }

  /**
   * Phase 2B: ONE list read yielding the visible application COUNT and (optionally) whether a name exists. Names never leave this method. An incomplete list proves
   * nothing and is reported as an error, never as "absent".
   */
  async appInventory(name: string | null): Promise<{ ok: true; count: number; exists: boolean | null } | { ok: false; code: string }> {
    if (name !== null && (typeof name !== "string" || !APP_NAME_REGEX.test(name))) return { ok: false, code: "invalid_input" };
    try {
      const r = await this.client.listApps();
      if (r.skipped > 0 || r.items.length >= 500) return { ok: false, code: "list_incomplete" };
      return { ok: true, count: r.items.length, exists: name === null ? null : r.items.some((a) => a.name === name) };
    } catch (e) {
      return { ok: false, code: isLiaraError(e) ? e.code : "internal" };
    }
  }

  /**
   * Phase 2B: IDENTITY read for a just-created application: `GET /v1/projects/{name}` for one EXACT validated name, WITHOUT the allowlist check (the app is not in
   * scope until this very read proves its identity — that is what lets the scope bootstrap work on an account with zero applications). It returns only the name
   * the API reports and the scale; nothing else leaves this method, and it can never widen access (the allowlist is untouched).
   */
  async appIdentity(name: string): Promise<{ ok: true; name: string | null; scale: number | null; planId: string | null; platform: string | null; instanceId: string | null; createdAt: string | null; networkId: string | null; defaultSubdomain: boolean | null } | { ok: false; code: string }> {
    if (typeof name !== "string" || !APP_NAME_REGEX.test(name)) return { ok: false, code: "invalid_input" };
    try {
      const d = await this.client.getApp(name);
      return { ok: true, name: d.name ?? null, scale: d.scale ?? null, planId: d.planId ?? null, platform: d.platform ?? null, instanceId: d.instanceId ?? null, createdAt: d.createdAt ?? null, networkId: d.networkId ?? null, defaultSubdomain: d.defaultSubdomain ?? null };
    } catch (e) {
      return { ok: false, code: isLiaraError(e) ? e.code : "internal" };
    }
  }

  /** Plan catalogue (raw projected values, never verified). */
  async getPlanCatalogue(): Promise<Section<PlanProjection>> {
    return this.run("getPlanCatalogue", () => this.client.getPlanCatalogue());
  }

  /** Phase 2B: documented balance read. Account scope (no app), no allowlist involved; a number or an error code only. */
  async getBilling(): Promise<Section<{ balance: number | null }>> {
    return this.run("getBilling", () => this.client.getBilling());
  }

  /** Phase 2B: CLI-observed network list (opt-in only). Account scope. */
  async listNetworks(): Promise<Section<{ items: { id: string; name: string | null }[]; skipped: number }>> {
    return this.run("listNetworks", () => this.client.listNetworks(), { contract: "observed", source: "official CLI (network:list)" });
  }

  private assertAllowed(name: string): void {
    if (!this.isAllowed(name)) throw new LiaraError("app_not_allowed", "Application is not accessible");
  }

  private async run<T>(
    cap: string,
    fn: () => Promise<T>,
    extra?: { contract?: "documented" | "observed"; source?: string },
    probe = false,
  ): Promise<Section<T>> {
    const fetchedAt = new Date(this.now()).toISOString();
    const rec = { mode: this.mode, probe, nowIso: fetchedAt };
    try {
      const data = redactDeep(await fn());
      recordOutcome(cap, { ok: true }, rec);
      return { ok: true, data, meta: { mode: this.mode, fetchedAt, ...extra } };
    } catch (e) {
      const code = isLiaraError(e) ? e.code : "internal";
      // app_not_allowed / invalid_input are caller errors, not upstream capability failures.
      if (code !== "app_not_allowed" && code !== "invalid_input") recordOutcome(cap, { ok: false, code }, rec);
      log("warn", "liara.section_failed", { capability: cap, code, status: isLiaraError(e) ? e.status : undefined });
      if (isLiaraError(e) && (code === "app_not_allowed" || code === "invalid_input")) throw e;
      const retryAfterSec = isLiaraError(e) ? e.opts?.retryAfterSec : undefined;
      return { ok: false, error: { code, ...(retryAfterSec !== undefined ? { retryAfterSec } : {}) }, meta: { mode: this.mode, fetchedAt } };
    }
  }

  async listApps(o: Opts = {}): Promise<Section<Listing<AppSummary> & { allowlistedMissing: number }>> {
    return this.run("listApps", async () => {
      const r = await this.client.listApps();
      const items = r.items.filter((a) => this.isAllowed(a.name));
      const present = new Set(items.map((a) => a.name));
      const allowlistedMissing = this.cfg.allowedApps ? [...this.cfg.allowedApps].filter((n) => !present.has(n)).length : 0;
      return { items, skipped: r.skipped, allowlistedMissing };
    }, undefined, o.probe);
  }

  /**
   * Applications plus an independent runtime assessment (from applets). At most `max` lookups are made
   * per call (bounded fan-out); apps beyond that, or whose applets fail, are reported as "unavailable".
   */
  async listAppsWithRuntime(max = 12): Promise<Section<{ items: AppWithRuntime[]; skipped: number; allowlistedMissing: number }>> {
    const list = await this.listApps();
    if (!list.ok) return list;
    const items = await Promise.all(
      list.data.items.map(async (app, i): Promise<AppWithRuntime> => {
        if (i >= max) return { ...app, runtime: assessRuntime(app, null) };
        const applets = await this.getApplets(app.name);
        return { ...app, runtime: assessRuntime(app, applets.ok ? applets.data : null) };
      }),
    );
    return { ...list, data: { ...list.data, items } };
  }

  async getApp(name: string, o: Opts = {}): Promise<Section<AppDetail>> {
    this.assertAllowed(name);
    return this.run("getApp", () => this.client.getApp(name), undefined, o.probe);
  }

  async getApplets(name: string, o: Opts = {}): Promise<Section<Listing<Applet>>> {
    this.assertAllowed(name);
    return this.run("getApplets", () => this.client.getApplets(name), undefined, o.probe);
  }

  async getReleases(name: string, page = 1, count = 10, o: Opts = {}): Promise<Section<ReleaseList>> {
    this.assertAllowed(name);
    return this.run("getReleases", () => this.client.getReleases(name, page, count), undefined, o.probe);
  }

  async getEvents(name: string, windowMinutes: WindowMinutes = 60, o: Opts = {}): Promise<Section<EventsResult>> {
    this.assertAllowed(name);
    assertWindow(windowMinutes);
    return this.run("getEvents", () => this.client.getEvents(name, windowMinutes), undefined, o.probe);
  }

  async getLogs(name: string, windowMinutes: WindowMinutes = 60, limit = 200, o: Opts = {}): Promise<Section<LogsResult>> {
    this.assertAllowed(name);
    assertWindow(windowMinutes);
    const primary = this.cfg.liara.logsApi === "v2" ? "getLogsV2" : "getLogsV1";
    const section = await this.run(primary, () => this.client.getLogs(name, windowMinutes, limit), undefined, o.probe);
    if (section.ok) {
      // Attribute the success to the endpoint that actually served it.
      const id = section.data.source === "v2" ? "getLogsV2" : "getLogsV1";
      const rec = { mode: this.mode, probe: o.probe, nowIso: section.meta.fetchedAt };
      recordOutcome(id, { ok: true }, rec);
      if (section.data.v1FallbackReason) recordOutcome("getLogsV1", { ok: false, code: section.data.v1FallbackReason }, rec);
      return { ...section, meta: { ...section.meta, contract: section.data.contract, source: section.data.source } };
    }
    return section;
  }

  async getMetrics(name: string, kind: "cpu" | "memory", windowMinutes: WindowMinutes = 60, o: Opts = {}): Promise<Section<MetricResult>> {
    this.assertAllowed(name);
    assertWindow(windowMinutes);
    return this.run(kind === "cpu" ? "getMetricsCpu" : "getMetricsMemory", () => this.client.getMetrics(name, kind, windowMinutes), undefined, o.probe);
  }

  // ---- diagnostics ----
  async diagnostics(opts: { probe: boolean }): Promise<DiagnosticsReport> {
    const live = this.mode === "live";
    if (live && opts.probe) await this.probeAll();
    const caps = capabilityReport(this.mode, this.cfg.liara.allowUndocumented);
    const nowMs = this.now();
    const lastOk = live ? lastSuccessAt() : null;
    const ageSec = lastOk ? Math.max(0, Math.round((nowMs - Date.parse(lastOk)) / 1000)) : null;
    const { connectivity, issues } = computeConnectivity(this.mode, caps, ageSec);
    return {
      mode: this.mode,
      generatedAt: new Date(nowMs).toISOString(),
      connectivity,
      issues,
      lastSuccessAt: lastOk,
      lastSuccessAgeSec: ageSec,
      staleAfterSec: STALE_AFTER_SEC,
      host: live ? this.cfg.liara.baseUrl.hostname : null,
      tokenConfigured: this.cfg.liara.token !== null,
      teamScoped: this.cfg.liara.teamId !== null,
      allowlistSize: this.cfg.allowedApps?.size ?? MOCK_APP_NAMES.length,
      logsStrategy: this.cfg.liara.logsApi,
      undocumentedEnabled: this.cfg.liara.allowUndocumented,
      capabilities: caps,
      notAvailable: [...NOT_AVAILABLE],
      verifiedCount: caps.filter((c) => c.verification === "LIVE_VERIFIED").length,
    };
  }

  private probeInFlight?: Promise<void>;
  private lastProbe = 0;

  /** Read-only probes of every capability against the first reachable allowlisted app. Cached for 20 s. */
  private probeAll(): Promise<void> {
    if (this.probeInFlight) return this.probeInFlight;
    if (this.now() - this.lastProbe < 20_000) return Promise.resolve();
    this.probeInFlight = (async () => {
      try {
        const list = await this.listApps({ probe: true });
        const first = list.ok ? list.data.items[0] : undefined;
        if (!first) return;
        const p = { probe: true };
        await Promise.all([
          this.getApp(first.name, p),
          this.getApplets(first.name, p),
          this.getReleases(first.name, 1, 1, p),
          this.getEvents(first.name, 15, p),
          this.getLogs(first.name, 15, 5, p),
          this.getMetrics(first.name, "cpu", 15, p),
          this.getMetrics(first.name, "memory", 15, p),
        ]);
      } finally {
        this.lastProbe = this.now();
        this.probeInFlight = undefined;
      }
    })();
    return this.probeInFlight;
  }
}

/** A capability counts as stale-data evidence after this long without any successful upstream read. */
export const STALE_AFTER_SEC = 300;

type Opts = { probe?: boolean };
export type AppWithRuntime = AppSummary & { runtime: RuntimeAssessment };

export type Connectivity =
  | "simulated"
  | "connected"
  | "degraded"
  | "auth_failure"
  | "endpoint_unavailable"
  | "contract_mismatch"
  | "unreachable"
  | "stale"
  | "unknown";

export interface ConnectivityIssue {
  capability: string;
  kind: "auth_failure" | "endpoint_unavailable" | "contract_mismatch" | "unreachable" | "no_content";
  code: string;
}

export interface DiagnosticsReport {
  mode: DataMode;
  generatedAt: string;
  connectivity: Connectivity;
  issues: ConnectivityIssue[];
  lastSuccessAt: string | null;
  lastSuccessAgeSec: number | null;
  staleAfterSec: number;
  host: string | null;
  tokenConfigured: boolean;
  teamScoped: boolean;
  allowlistSize: number;
  logsStrategy: "v1" | "v2" | "auto";
  undocumentedEnabled: boolean;
  capabilities: CapabilityReport[];
  notAvailable: { id: string; reason: string }[];
  verifiedCount: number;
}

function issueKind(code: string): ConnectivityIssue["kind"] {
  if (code === "unauthorized" || code === "forbidden") return "auth_failure";
  if (code === "contract_mismatch") return "contract_mismatch";
  if (code === "no_content") return "no_content";
  if (code === "not_found" || code === "unsupported") return "endpoint_unavailable";
  return "unreachable"; // timeout, network, 5xx, 429, oversize
}

/** Pure: derives the overall connection state from per-capability observations. */
export function computeConnectivity(
  mode: DataMode,
  caps: CapabilityReport[],
  lastSuccessAgeSec: number | null,
): { connectivity: Connectivity; issues: ConnectivityIssue[] } {
  if (mode === "mock") return { connectivity: "simulated", issues: [] };
  const issues: ConnectivityIssue[] = caps
    .filter((c) => (c.health === "failing" || c.health === "no_content") && c.lastErrorCode) // a 204 is a (partial) issue, never silently "connected"
    .map((c) => ({ capability: c.id, kind: issueKind(c.lastErrorCode!), code: c.lastErrorCode! }));
  const list = caps.find((c) => c.id === "listApps");
  if (!list || list.health === "not_probed") return { connectivity: "unknown", issues };
  if (list.health === "failing") return { connectivity: issueKind(list.lastErrorCode ?? "network") as Connectivity, issues };
  if (issues.length > 0) return { connectivity: "degraded", issues };
  if (lastSuccessAgeSec !== null && lastSuccessAgeSec > STALE_AFTER_SEC) return { connectivity: "stale", issues };
  return { connectivity: "connected", issues };
}

function assertWindow(w: number): asserts w is WindowMinutes {
  if (!(WINDOWS_MINUTES as readonly number[]).includes(w)) throw new LiaraError("invalid_input", "Invalid time window");
}

// ---------- wiring ----------
export function buildService(cfg: AppConfig, deps: { fetchImpl?: typeof fetch; now?: () => number; sleep?: (ms: number) => Promise<void> } = {}): LiaraService {
  const opts = { logsApi: cfg.liara.logsApi, allowUndocumented: cfg.liara.allowUndocumented, now: deps.now };
  if (cfg.dataSource === "mock") {
    return new LiaraService(new LiaraReadClient(new FixtureTransport(deps.now), { ...opts, logsApi: "v1", allowUndocumented: false }), cfg, deps.now);
  }
  if (!cfg.liara.token) throw new LiaraError("not_configured", "Missing Liara credentials");
  const http = new LiaraHttpClient({
    baseUrl: cfg.liara.baseUrl,
    token: cfg.liara.token,
    teamId: cfg.liara.teamId,
    timeoutMs: cfg.liara.timeoutMs,
    maxConcurrency: cfg.liara.maxConcurrency,
    maxRps: cfg.liara.maxRps,
    budgetPerMinute: cfg.liara.budgetPerMinute,
    fetchImpl: deps.fetchImpl,
    sleep: deps.sleep,
    now: deps.now,
  });
  return new LiaraService(new LiaraReadClient(http, opts), cfg, deps.now);
}

const g = globalThis as unknown as { __liaraService?: LiaraService };
let testService: LiaraService | undefined;
export function getService(): LiaraService {
  if (testService) return testService;
  if (g.__liaraService) return g.__liaraService;
  const cfg = getConfig();
  const svc = buildService(cfg);
  // Live mode only: apps created by a VERIFIED, approved live deployment join the operator's scope (exact team + name). The allowlist itself is never disabled.
  if (cfg.dataSource === "live") svc.setScopeExtension(bootstrappedScopeLookup(cfg.diagnostics.dbPath, cfg.liara.teamId));
  return (g.__liaraService = svc);
}
export function __setServiceForTests(s: LiaraService | undefined): void {
  testService = s;
  g.__liaraService = undefined;
}
