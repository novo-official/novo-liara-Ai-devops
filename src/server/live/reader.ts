import type { LiaraService } from "../liara/service";
import { assessRuntime } from "../domain/runtime";

/** The read-only surface the live layer needs (reconcile + verification). A narrow interface so tests can fake it and so no write method can hide in it. */
export type ReadResult<T> = { ok: true; data: T } | { ok: false; code: string };

/** Everything the API reports that identifies ONE application instance. `instanceId`/`createdAt` change when an app is deleted and recreated under the same name. */
export interface AppIdentityFacts {
  name: string | null;
  scale: number | null;
  planId: string | null;
  platform: string | null;
  instanceId: string | null;
  createdAt: string | null;
  networkId: string | null;
  defaultSubdomain: boolean | null;
}

export interface LiveReader {
  appNameExists(name: string): Promise<ReadResult<{ exists: boolean }>>;
  getApp(name: string): Promise<ReadResult<{ name: string | null; scale: number | null; status: string | null; defaultSubdomain: boolean | null }>>;
  /** Phase 2B: identity of ONE exact application name (bypasses the allowlist by design; returns the API-reported name and scale only). */
  appIdentity(name: string): Promise<ReadResult<AppIdentityFacts>>;
  /** Phase 2E: the release baseline of an application (current release id + total count) — what an existing-app approval is bound on top of. */
  releaseBaseline(name: string): Promise<ReadResult<{ currentRelease: string | null; total: number | null; count: number }>>;
  /** Phase 2E: the application NAMES this operator is authorised to touch AND that exist in the account/team (allowlist ∩ list). Names only. */
  authorizedApps(): Promise<ReadResult<{ names: string[] }>>;
  /** Phase 2D: is this EXACT name already in the operator's scope (env allowlist ∪ verified bootstrap)? Pure, no request. */
  inScope(name: string): boolean;
  /** Phase 2B: one list read → visible application count (+ whether `name` exists). Names are never returned. */
  appInventory(name: string | null): Promise<ReadResult<{ count: number; exists: boolean | null }>>;
  /** Phase 2B: documented `GET /v1/billing` — the raw numeric balance (unit NOT stated by the API) or an error code. */
  billing(): Promise<ReadResult<{ balance: number | null }>>;
  /** Phase 2B: CLI-observed `GET /v1/networks` (only when the operator opted in to undocumented endpoints). */
  networks(): Promise<ReadResult<{ items: { id: string; name: string | null }[] }>>;
  getReleases(name: string): Promise<ReadResult<{ currentRelease: string | null; releases: { id: string; state: string | null }[] }>>;
  getRuntime(name: string): Promise<ReadResult<{ runtime: string; appletCount: number; heuristic: boolean; enabled: string }>>;
  getRecentLogs(name: string): Promise<ReadResult<{ lines: string[]; count: number }>>;
  planCatalogue(): Promise<ReadResult<import("../liara/plans").PlanProjection>>;
}

export function liveReaderFrom(svc: LiaraService): LiveReader {
  const fail = (e: { code: string }) => ({ ok: false as const, code: e.code });
  return {
    async appNameExists(name) {
      const r = await svc.appNameExists(name);
      return r.ok ? { ok: true, data: { exists: r.exists } } : { ok: false, code: r.code };
    },
    async getApp(name) {
      const r = await svc.getApp(name);
      return r.ok ? { ok: true, data: { name: r.data.name ?? null, scale: r.data.scale, status: r.data.status, defaultSubdomain: r.data.defaultSubdomain } } : fail(r.error);
    },
    async appInventory(name) {
      const r = await svc.appInventory(name);
      return r.ok ? { ok: true, data: { count: r.count, exists: r.exists } } : { ok: false, code: r.code };
    },
    async appIdentity(name) {
      const r = await svc.appIdentity(name);
      return r.ok ? { ok: true, data: { name: r.name, scale: r.scale, planId: r.planId, platform: r.platform, instanceId: r.instanceId, createdAt: r.createdAt, networkId: r.networkId, defaultSubdomain: r.defaultSubdomain } } : { ok: false, code: r.code };
    },
    async releaseBaseline(name) {
      const r = await svc.getReleases(name, 1, 10);
      return r.ok ? { ok: true, data: { currentRelease: r.data.currentRelease, total: r.data.total, count: r.data.releases.length } } : fail(r.error);
    },
    async authorizedApps() {
      const r = await svc.listApps();
      return r.ok ? { ok: true, data: { names: r.data.items.map((a) => a.name).slice(0, 20) } } : fail(r.error);
    },
    inScope(name) {
      return svc.isAllowed(name);
    },
    async billing() {
      const r = await svc.getBilling();
      return r.ok ? { ok: true, data: { balance: r.data.balance } } : fail(r.error);
    },
    async networks() {
      const r = await svc.listNetworks();
      return r.ok ? { ok: true, data: { items: r.data.items } } : fail(r.error);
    },
    async getReleases(name) {
      const r = await svc.getReleases(name, 1, 10);
      return r.ok ? { ok: true, data: { currentRelease: r.data.currentRelease, releases: r.data.releases.map((x) => ({ id: x.id, state: x.state })) } } : fail(r.error);
    },
    async getRuntime(name) {
      const app = await svc.getApp(name);
      if (!app.ok) return fail(app.error);
      const r = await svc.getApplets(name);
      if (!r.ok) return fail(r.error);
      const a = assessRuntime(app.data, r.data);
      return { ok: true, data: { runtime: a.runtime, appletCount: a.appletCount, heuristic: a.runtimeIsHeuristic, enabled: a.enabled } };
    },
    async getRecentLogs(name) {
      const r = await svc.getLogs(name, 15, 50);
      return r.ok ? { ok: true, data: { lines: r.data.lines.slice(-20).map((l) => String(l.message ?? "").slice(0, 200)), count: r.data.lines.length } } : fail(r.error);
    },
    async planCatalogue() {
      const r = await svc.getPlanCatalogue();
      return r.ok ? { ok: true, data: r.data } : fail(r.error);
    },
  };
}
