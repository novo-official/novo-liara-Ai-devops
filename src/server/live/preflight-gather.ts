import type { AppConfig } from "../config/env";
import type { PlanProjection } from "../liara/plans";
import type { LiveReader } from "./reader";
import { buildPreflight, type PreflightReport } from "./preflight";

export interface PreflightSelection {
  planId: string | null;
  bundlePlanId: string | null;
  appName: string | null;
  minRamMb: number | null;
}

/**
 * Gathers (READ-ONLY, bounded: at most one catalogue read, one list read, one billing read and one network-list read) what the preflight needs, and builds the
 * sanitised report. Used by the live service (proposal / decision / execution drift) AND by `npm run preflight:liara`. It creates nothing.
 * `cat`/`inv` may be supplied to avoid duplicate reads.
 */
export async function gatherPreflight(o: {
  reader: LiveReader;
  cfg: AppConfig;
  nowIso: string;
  sel: PreflightSelection | null;
  runBlockers?: string[];
  cat?: PlanProjection | null;
  inv?: { count: number; exists: boolean | null } | null;
}): Promise<PreflightReport> {
  const { reader, cfg: c } = o;
  let catalogue: PlanProjection | null;
  if (o.cat !== undefined) catalogue = o.cat;
  else {
    const r = await reader.planCatalogue();
    catalogue = r.ok ? r.data : null;
  }
  let apps: { ok: true; count: number } | { ok: false; code: string };
  let nameExists: boolean | null = null;
  if (o.inv) {
    apps = { ok: true, count: o.inv.count };
    nameExists = o.inv.exists;
  } else {
    const r = await reader.appInventory(o.sel?.appName ?? null);
    apps = r.ok ? { ok: true, count: r.data.count } : { ok: false, code: r.code };
    nameExists = r.ok ? r.data.exists : null;
  }
  // team mode: the team balance comes from the same /v1/me read (catalogue.account); personal mode: the documented GET /v1/billing
  const b = c.liara.teamId ? null : await reader.billing();
  const billing = b === null ? null : b.ok ? { ok: true as const, balance: b.data.balance } : { ok: false as const, code: b.code };
  const n = c.liara.allowUndocumented ? await reader.networks() : null;
  const networks = n === null ? null : n.ok ? { ok: true as const, items: n.data.items } : { ok: false as const, code: n.code };
  return buildPreflight({
    config: {
      liveEnabled: c.live.enabled,
      dataSourceLive: c.dataSource === "live",
      tokenPresent: !!c.liara.token,
      teamId: c.liara.teamId,
      planUnits: c.live.planUnits,
      contractAttested: c.live.contractAttested,
      networkId: c.live.networkId,
      appDomainSuffixes: c.live.appDomainSuffixes,
      healthMarker: c.live.healthMarker,
      allowUndocumented: c.liara.allowUndocumented,
      mutationsEnabled: false,
      aiLiveEnabled: false,
    },
    catalogue,
    billing,
    networks,
    apps,
    selection: o.sel ? { ...o.sel, nameExists } : null,
    runBlockers: o.runBlockers ?? [],
    nowIso: o.nowIso,
  });
}
