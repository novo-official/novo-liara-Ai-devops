import { z } from "zod";
import type { AppConfig } from "../config/env";
import { redactText } from "../security/redact";
import { Pseudonymizer } from "../security/pseudonym";
import { baselineVerification, verificationForError, type VerificationStatus } from "./capabilities";
import type { EndpointId } from "./endpoints";
import { ENDPOINTS } from "./endpoints";
import { LiaraError, type ErrorShape } from "./errors";
import { LiaraHttpClient } from "./http";
import {
  AppDetailResponse,
  AppListSchema,
  AppletsSchema,
  BillingProjectionSchema,
  EventsSchema,
  LogsV1Schema,
  LogsV2Schema,
  MeFreeCreditSchema,
  MeProjectionSchema,
  MeSubscriptionSchema,
  MetricsSchema,
  NetworksSchema,
  ReleasesSchema,
  issuesOf,
} from "./schemas";
import { projectPlanCatalogue } from "./plans";

/**
 * Controlled, bounded, GET-only verification of the live contract. It records STRUCTURE (types, vocabularies,
 * formats, orderings, counts) — never payload content — and never prints names, ids or secrets.
 * Verification results are evidence for docs/API_CAPABILITY_MATRIX.md and for vocabulary.ts; nothing is applied automatically.
 */

export interface VerifyOptions {
  /** the single allowlisted app to inspect; `null` = ACCOUNT-ONLY mode (apps list + account endpoints, no app-scoped call at all) */
  app: string | null;
  probeFormats: boolean;
  probeTeam: boolean;
  includeV2: boolean;
  /** Phase 2B: also read the CLI-observed `GET /v1/networks` (account-only mode; needs LIARA_ALLOW_UNDOCUMENTED_ENDPOINTS=true) */
  includeNetworks?: boolean;
  /** Phase 2C: narrowly scoped re-check — ONE documented GET of the events endpoint for the selected allowlisted app (no list, no other endpoint). */
  only?: "getEvents";
  budget: number;
}

export interface PlanItem {
  id: EndpointId | "listApps(no-team)" | "getReleases(page2)" | "getLogsV1(since=iso)" | "getLogsV1(since=ms)";
  endpoint: string;
  contract: "documented" | "observed";
  required: boolean;
  note?: string;
}

export function buildPlan(cfg: AppConfig, o: VerifyOptions): PlanItem[] {
  if (o.app === null) {
    const items: PlanItem[] = [
      { id: "listApps", endpoint: "GET /v1/projects", contract: "documented", required: true, note: "account scope: counts and structure only; names are never recorded" },
      { id: "getMe", endpoint: "GET /v1/me", contract: "documented", required: true, note: "projected inside the adapter: only the plan catalogue structure is examined; profile data is dropped" },
      { id: "getMeSubscription", endpoint: "GET /v1/me/subscription", contract: "documented", required: true, note: "presence and field types only" },
      { id: "getMeFreeCredit", endpoint: "GET /v1/me/free-credit", contract: "documented", required: false, note: "amount is never recorded; omitted for teams (documented)" },
      { id: "getBilling", endpoint: "GET /v1/billing", contract: "documented", required: false, note: "documented in the pinned billing.yaml; the balance is never recorded (only its type and sign)" },
    ];
    if (o.includeNetworks) items.push({ id: "listNetworks", endpoint: "GET /v1/networks (UNDOCUMENTED, CLI-observed)", contract: "observed", required: false, note: "explicit opt-in; ids and names are never recorded — only the count and the id shape" });
    if (o.probeTeam && cfg.liara.teamId) items.push({ id: "listApps(no-team)", endpoint: "GET /v1/projects (without teamID)", contract: "documented", required: false, note: "team-scope probe; COUNT only — shows whether applications live in the personal scope instead of the team" });
    return items;
  }
  if (o.only === "getEvents") return [{ id: "getEvents", endpoint: "GET /v1/projects/{app}/events?start&end (unix seconds) — the ONLY request of this run", contract: "documented", required: true, note: "events-only re-check: exactly one GET; verdict INCONCLUSIVE if the endpoint answers 204" }];
  const plan: PlanItem[] = [
    { id: "listApps", endpoint: "GET /v1/projects", contract: "documented", required: true },
    { id: "getApp", endpoint: "GET /v1/projects/{app}", contract: "documented", required: true },
    { id: "getApplets", endpoint: "GET /v1/projects/{app}/applets", contract: "documented", required: true },
    { id: "getReleases", endpoint: "GET /v1/projects/{app}/releases?page=1&count=10", contract: "documented", required: true },
    { id: "getEvents", endpoint: "GET /v1/projects/{app}/events?start&end (unix seconds)", contract: "documented", required: true },
    { id: "getLogsV1", endpoint: "GET /v1/projects/{app}/logs?since=<unix seconds>", contract: "documented", required: true },
    { id: "getMetricsCpu", endpoint: "GET /v1/projects/{app}/metrics/cpu?since", contract: "documented", required: true },
    { id: "getMetricsMemory", endpoint: "GET /v1/projects/{app}/metrics/memory?since", contract: "documented", required: true },
  ];
  plan.push({ id: "getReleases(page2)", endpoint: "GET …/releases?page=2 (only if total > count)", contract: "documented", required: false, note: "pagination check" });
  if (o.probeFormats) {
    plan.push({ id: "getLogsV1(since=iso)", endpoint: "GET …/logs?since=<ISO-8601>", contract: "documented", required: false, note: "accepted-format probe" });
    plan.push({ id: "getLogsV1(since=ms)", endpoint: "GET …/logs?since=<unix ms>", contract: "documented", required: false, note: "accepted-format probe" });
  }
  if (o.probeTeam && cfg.liara.teamId) {
    plan.push({ id: "listApps(no-team)", endpoint: "GET /v1/projects (without teamID)", contract: "documented", required: false, note: "team-scope probe; counts only" });
  }
  if (o.includeV2) {
    plan.push({ id: "getLogsV2", endpoint: "GET /v2/projects/{app}/logs (UNDOCUMENTED, CLI-observed)", contract: "observed", required: false, note: "explicit opt-in" });
  }
  return plan;
}

// ---------- structure helpers (pure, exported for tests) ----------
export type FormatClass =
  | "epoch-seconds" | "epoch-seconds-fractional" | "epoch-milliseconds" | "epoch-microseconds" | "epoch-nanoseconds"
  | "epoch-seconds-string" | "epoch-milliseconds-string" | "epoch-microseconds-string" | "epoch-nanoseconds-string"
  | "iso8601-utc" | "iso8601-offset" | "iso8601-no-zone" | "other" | "missing";

export function timeFormatClass(v: unknown): FormatClass {
  if (v === undefined || v === null) return "missing";
  const mag = (n: number) => {
    const a = Math.abs(n);
    return a >= 1e17 ? "nanoseconds" : a >= 1e14 ? "microseconds" : a >= 1e11 ? "milliseconds" : "seconds";
  };
  if (typeof v === "number" && Number.isFinite(v)) {
    const m = mag(v);
    if (m === "seconds") return Number.isInteger(v) ? "epoch-seconds" : "epoch-seconds-fractional";
    return `epoch-${m}` as FormatClass;
  }
  if (typeof v === "string") {
    if (/^\d{9,20}$/.test(v)) return `epoch-${mag(Number(v))}-string` as FormatClass;
    if (/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(\.\d+)?Z$/.test(v)) return "iso8601-utc";
    if (/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(\.\d+)?[+-]\d{2}:?\d{2}$/.test(v)) return "iso8601-offset";
    if (/^\d{4}-\d{2}-\d{2}[T ]\d{2}:\d{2}:\d{2}(\.\d+)?$/.test(v)) return "iso8601-no-zone";
  }
  return "other";
}

export function typeName(v: unknown): string {
  if (v === null) return "null";
  if (Array.isArray(v)) return "array";
  return typeof v;
}

/** Field → set of observed JSON types across items (names are fixed identifiers from the contract, not data). */
export function fieldTypes(items: unknown[], fields: string[]): Record<string, string[]> {
  const out: Record<string, string[]> = {};
  for (const f of fields) {
    const t = new Set<string>();
    for (const it of items) t.add(it && typeof it === "object" ? (f in it ? typeName((it as Record<string, unknown>)[f]) : "absent") : "absent");
    out[f] = [...t].sort();
  }
  return out;
}

/** Distinct short string values of an enum-like field, sanitised and capped. Counts of anything else are summarised. */
export function vocabulary(values: unknown[], max = 20): { values: Record<string, number>; other: number } {
  const counts = new Map<string, number>();
  let other = 0;
  for (const v of values) {
    if (typeof v !== "string" || v.length === 0 || v.length > 40) {
      other++;
      continue;
    }
    const k = redactText(v, { shareable: true, maxLength: 40 });
    counts.set(k, (counts.get(k) ?? 0) + 1);
  }
  const entries = [...counts.entries()].sort((a, b) => b[1] - a[1]);
  const kept = entries.slice(0, max);
  other += entries.slice(max).reduce((n, [, c]) => n + c, 0);
  return { values: Object.fromEntries(kept), other };
}

export function ordering(times: (number | null)[]): "ascending" | "descending" | "unsorted" | "constant" | "insufficient-data" {
  const t = times.filter((x): x is number => x !== null);
  if (t.length < 2) return "insufficient-data";
  let asc = true;
  let desc = true;
  for (let i = 1; i < t.length; i++) {
    if (t[i]! < t[i - 1]!) asc = false;
    if (t[i]! > t[i - 1]!) desc = false;
  }
  if (asc && desc) return "constant";
  return asc ? "ascending" : desc ? "descending" : "unsorted";
}

const toMs = (v: unknown): number | null => {
  if (typeof v === "number" && Number.isFinite(v)) {
    const a = Math.abs(v);
    return a >= 1e17 ? v / 1e6 : a >= 1e14 ? v / 1e3 : a >= 1e11 ? v : v * 1000;
  }
  if (typeof v === "string") {
    if (/^\d{9,20}$/.test(v)) return toMs(Number(v));
    const p = Date.parse(v);
    return Number.isFinite(p) ? p : null;
  }
  return null;
};

function arr(v: unknown): unknown[] {
  return Array.isArray(v) ? v : [];
}
function obj(v: unknown): Record<string, unknown> {
  return v && typeof v === "object" && !Array.isArray(v) ? (v as Record<string, unknown>) : {};
}
const safeKeys = (o: Record<string, unknown>, max = 25) => Object.keys(o).filter((k) => /^[A-Za-z_][A-Za-z0-9_-]{0,40}$/.test(k)).sort().slice(0, max);
const MASKED = /^(\*+|•+|x+|\[?redacted\]?|<hidden>|hidden|secret)$/i;

export type Observations = Record<string, unknown>;

export function observeApps(raw: unknown, appName: string): Observations {
  const items = arr(obj(raw).projects);
  const mine = items.find((i) => obj(i).project_id === appName);
  return {
    topLevelKeys: safeKeys(obj(raw)),
    itemCount: items.length,
    allowlistedAppPresent: !!mine,
    fieldTypes: fieldTypes(items, ["project_id", "type", "status", "scale", "planID", "created_at", "isDeployed"]),
    statusVocabulary: vocabulary(items.map((i) => obj(i).status)),
    platformVocabulary: vocabulary(items.map((i) => obj(i).type)),
    scaleValues: vocabulary(items.map((i) => String(obj(i).scale))),
    createdAtFormat: [...new Set(items.map((i) => timeFormatClass(obj(i).created_at)))].sort(),
  };
}

export function observeApp(raw: unknown): Observations {
  const p = obj(obj(raw).project);
  const envs = arr(p.envs).map(obj);
  const enc = envs.filter((e) => e.encrypted === true);
  const kind = (v: unknown) => (typeof v !== "string" ? "non-string" : v === "" ? "empty" : MASKED.test(v) ? "masked-looking" : "non-empty-unmasked");
  return {
    topLevelKeys: safeKeys(obj(raw)),
    projectKeys: safeKeys(p, 40),
    fieldTypes: fieldTypes([p], ["status", "scale", "planID", "isDeployed", "defaultSubdomain", "zeroDowntime", "readOnlyRootFilesystem", "fixedIPStatus", "created_at", "envs"]),
    status: vocabulary([p.status]),
    scale: typeof p.scale === "number" ? p.scale : typeof p.scale,
    createdAtFormat: timeFormatClass(p.created_at),
    envCount: envs.length,
    envEntryKeys: [...new Set(envs.flatMap((e) => safeKeys(e)))].sort(),
    encryptedEnvCount: enc.length,
    // Answers "are encrypted env values masked upstream?" without recording any value.
    encryptedValueKinds: vocabulary(enc.map((e) => kind(e.value))),
    plainValueKinds: vocabulary(envs.filter((e) => e.encrypted !== true).map((e) => kind(e.value))),
  };
}

export function observeApplets(raw: unknown): Observations {
  const items = arr(obj(raw).applets);
  return {
    topLevelKeys: safeKeys(obj(raw)),
    count: items.length,
    fieldTypes: fieldTypes(items, ["id", "name", "timestamp", "state", "reason", "release"]),
    stateVocabulary: vocabulary(items.map((i) => obj(i).state)),
    reasonPresentCount: items.filter((i) => typeof obj(i).reason === "string" && (obj(i).reason as string).length > 0).length,
    reasonVocabularyShort: vocabulary(items.map((i) => obj(i).reason), 10), // only <=40 chars, sanitised
    timestampFormat: [...new Set(items.map((i) => timeFormatClass(obj(i).timestamp)))].sort(),
    releaseKeys: [...new Set(items.flatMap((i) => safeKeys(obj(obj(i).release))))].sort(),
  };
}

export function observeReleases(raw: unknown, requestedCount: number): Observations {
  const o = obj(raw);
  const rel = arr(o.releases);
  const created = rel.map((r) => toMs(obj(r).createdAt));
  const cur = o.currentRelease;
  return {
    topLevelKeys: safeKeys(o),
    total: typeof o.total === "number" ? o.total : typeof o.total,
    returned: rel.length,
    requestedCount,
    totalVsReturned: typeof o.total === "number" ? (o.total > rel.length ? "more-pages-available" : o.total === rel.length ? "complete" : "total-smaller-than-returned") : "total-missing",
    ordering: ordering(created),
    fieldTypes: fieldTypes(rel, ["_id", "type", "state", "port", "tag", "createdAt", "finishedAt", "sourceAvailable", "gitInfo"]),
    stateVocabulary: vocabulary(rel.map((r) => obj(r).state)),
    typeVocabulary: vocabulary(rel.map((r) => obj(r).type)),
    createdAtFormat: [...new Set(rel.map((r) => timeFormatClass(obj(r).createdAt)))].sort(),
    finishedAtFormat: [...new Set(rel.map((r) => timeFormatClass(obj(r).finishedAt)))].sort(),
    currentReleaseKind: typeof cur !== "string" ? typeName(cur) : rel.some((r) => obj(r).tag === cur) ? "matches-a-release-tag" : rel.some((r) => obj(r)._id === cur) ? "matches-a-release-id" : "matches-neither-in-returned-page",
    gitInfoKeys: [...new Set(rel.flatMap((r) => safeKeys(obj(obj(r).gitInfo))))].sort(),
  };
}

export function observeEvents(raw: unknown, windowStartMs: number, windowEndMs: number): Observations {
  const groups = arr(obj(raw).data);
  const rows = groups.flatMap((g) => arr(obj(g).values));
  const firstCells = rows.map((r) => (Array.isArray(r) ? r[0] : undefined));
  const ms = firstCells.map(toMs);
  const inWindow = ms.filter((m) => m !== null && m >= windowStartMs - 60_000 && m <= windowEndMs + 60_000).length;
  return {
    topLevelKeys: safeKeys(obj(raw)),
    groupCount: groups.length,
    groupKeys: [...new Set(groups.flatMap((g) => safeKeys(obj(g))))].sort(),
    metaDataKeys: [...new Set(groups.flatMap((g) => safeKeys(obj(obj(g).metaData))))].sort(),
    rowCount: rows.length,
    columnCounts: [...new Set(rows.map((r) => (Array.isArray(r) ? r.length : -1)))].sort((a, b) => a - b),
    cellTypes: [...new Set(rows.flatMap((r) => (Array.isArray(r) ? r.map(typeName) : [])))].sort(),
    firstCellFormat: [...new Set(firstCells.map(timeFormatClass))].sort(),
    // Evidence for the unit of `start`/`end` (we send unix SECONDS): if rows fall inside the window, seconds were understood.
    rowsInsideRequestedWindow: rows.length ? `${inWindow}/${rows.length}` : "no-rows",
    orderingWithinFirstGroup: ordering(arr(obj(groups[0]).values).map((r) => (Array.isArray(r) ? toMs(r[0]) : null))),
  };
}

export function observeLogsV1(raw: unknown, windowStartMs: number, windowEndMs: number): Observations {
  const items = arr(raw);
  const ms = items.map((i) => toMs(obj(i).datetime));
  const inWin = ms.filter((m) => m !== null && m >= windowStartMs - 60_000 && m <= windowEndMs + 60_000).length;
  const lens = items.map((i) => (typeof obj(i).message === "string" ? (obj(i).message as string).length : 0));
  return {
    topLevelType: typeName(raw),
    count: items.length,
    itemKeys: [...new Set(items.flatMap((i) => safeKeys(obj(i))))].sort(),
    fieldTypes: fieldTypes(items, ["type", "datetime", "message"]),
    typeVocabulary: vocabulary(items.map((i) => obj(i).type)),
    datetimeFormat: [...new Set(items.map((i) => timeFormatClass(obj(i).datetime)))].sort(),
    ordering: ordering(ms),
    rowsInsideRequestedWindow: items.length ? `${inWin}/${items.length}` : "no-rows",
    messageLength: lens.length ? { min: Math.min(...lens), max: Math.max(...lens) } : null,
  };
}

export function observeLogsV2(raw: unknown): Observations {
  const groups = arr(obj(raw).data);
  const rows = groups.flatMap((g) => arr(obj(g).values));
  return {
    topLevelKeys: safeKeys(obj(raw)),
    groupCount: groups.length,
    metaDataKeys: [...new Set(groups.flatMap((g) => safeKeys(obj(obj(g).metaData))))].sort(),
    rowCount: rows.length,
    columnCounts: [...new Set(rows.map((r) => (Array.isArray(r) ? r.length : -1)))].sort((a, b) => a - b),
    firstCellFormat: [...new Set(rows.map((r) => timeFormatClass(Array.isArray(r) ? r[0] : undefined)))].sort(),
  };
}

function scanKeys(v: unknown, re: RegExp, depth = 0, found = new Set<string>()): string[] {
  if (depth > 6 || found.size > 10) return [...found];
  if (Array.isArray(v)) v.slice(0, 20).forEach((x) => scanKeys(x, re, depth + 1, found));
  else if (v && typeof v === "object") {
    for (const [k, x] of Object.entries(v)) {
      if (re.test(k) && /^[A-Za-z_][A-Za-z0-9_-]{0,40}$/.test(k)) found.add(k);
      scanKeys(x, re, depth + 1, found);
    }
  }
  return [...found];
}

export function observeMetrics(raw: unknown, nowMs: number, windowSec: number, appletNames: string[]): Observations {
  const o = obj(raw);
  const series = arr(o.result);
  const pairs = series.flatMap((s) => arr(obj(s).values));
  const tsTypes = new Set<string>();
  const valTypes = new Set<string>();
  const lens = new Set<number>();
  const secs: number[] = [];
  const vals: number[] = [];
  for (const p of pairs) {
    if (!Array.isArray(p)) { lens.add(-1); continue; }
    lens.add(p.length);
    tsTypes.add(timeFormatClass(p[0]));
    valTypes.add(typeName(p[1]));
    const ms = toMs(p[0]);
    if (ms !== null) secs.push(ms / 1000);
    const n = typeof p[1] === "number" ? p[1] : typeof p[1] === "string" ? Number(p[1]) : NaN;
    if (Number.isFinite(n)) vals.push(n);
  }
  secs.sort((a, b) => a - b);
  const deltas = secs.slice(1).map((t, i) => t - secs[i]!).filter((d) => d > 0).sort((a, b) => a - b);
  const labels = series.map((s) => obj(s).applet).filter((x): x is string => typeof x === "string");
  const fmt = (n: number) => Number(n.toPrecision(4));
  return {
    topLevelKeys: safeKeys(o),
    endFormat: timeFormatClass(o.end),
    seriesCount: series.length,
    seriesKeys: [...new Set(series.flatMap((s) => safeKeys(obj(s))))].sort(),
    pointCount: pairs.length,
    pairLengths: [...lens].sort((a, b) => a - b),
    timestampFormats: [...tsTypes].sort(),
    valueTypes: [...valTypes].sort(),
    stepSeconds: deltas.length ? { min: fmt(deltas[0]!), median: fmt(deltas[Math.floor(deltas.length / 2)]!), max: fmt(deltas[deltas.length - 1]!) } : null,
    lastObservationAgeSeconds: secs.length ? Math.round(nowMs / 1000 - secs[secs.length - 1]!) : null,
    firstObservationAgeSeconds: secs.length ? Math.round(nowMs / 1000 - secs[0]!) : null,
    requestedWindowSeconds: windowSec,
    valueRange: vals.length ? { min: fmt(Math.min(...vals)), max: fmt(Math.max(...vals)) } : null,
    // The API documents no unit. Any unit-like key found in the response is reported; none is ever assumed.
    unitKeysFoundInResponse: scanKeys(raw, /unit|uom|measure/i),
    unit: "NOT STATED BY API — do not assume; add to VERIFIED_METRIC_UNITS only after human confirmation",
    seriesLabelsMatchAppletNames: labels.length ? `${labels.filter((l) => appletNames.includes(l)).length}/${labels.length}` : "no-labels",
  };
}

// ---------- account-scope observers (STRUCTURE ONLY: no names, no profile data, no money amounts) ----------
export function observeAccountApps(raw: unknown): Observations {
  const items = arr(obj(raw).projects);
  return {
    topLevelKeys: safeKeys(obj(raw)),
    visibleApplicationCount: items.length,
    fieldTypes: fieldTypes(items, ["project_id", "type", "status", "scale", "planID", "created_at", "isDeployed"]),
    statusVocabulary: vocabulary(items.map((i) => obj(i).status)),
    platformVocabulary: vocabulary(items.map((i) => obj(i).type)),
    createdAtFormat: [...new Set(items.map((i) => timeFormatClass(obj(i).created_at)))].sort(),
  };
}

const range = (xs: number[]) => (xs.length ? { min: Number(Math.min(...xs).toPrecision(6)), max: Number(Math.max(...xs).toPrecision(6)) } : null);

export function observeMe(raw: unknown): Observations {
  const o = obj(raw);
  const plans = obj(o.plans);
  const projects = obj(plans.projects);
  const entries = Object.values(projects).map(obj);
  const proj = projectPlanCatalogue(projects);
  const bundles = obj(plans.projectBundlePlans);
  return {
    topLevelKeys: safeKeys(o),
    // the profile is only acknowledged by NAME of its fields, never read: it holds personal data and storage keys
    userPresent: typeof o.user === "object" && o.user !== null,
    userFieldNames: safeKeys(obj(o.user), 40),
    teamPresent: typeof o.team === "object" && o.team !== null,
    teamFieldNames: safeKeys(obj(o.team), 40),
    // the documented billing field (`team.balance`): only its JSON TYPE is recorded, never the amount
    teamBalanceType: typeName(obj(o.team).balance),
    plansKeys: safeKeys(plans, 20),
    projectPlans: {
      count: entries.length,
      objectEntries: entries.filter((e) => Object.keys(e).length > 0).length,
      entryFieldTypes: fieldTypes(entries, ["available", "region", "RAM", "CPU", "volume", "price"]),
      ramKeys: [...new Set(entries.flatMap((e) => safeKeys(obj(e.RAM))))].sort(),
      cpuKeys: [...new Set(entries.flatMap((e) => safeKeys(obj(e.CPU))))].sort(),
      availableVocabulary: vocabulary(entries.map((e) => String(e.available))),
      regionVocabulary: vocabulary(entries.map((e) => e.region)),
    },
    projection: {
      projectedPlanCount: proj.plans.length,
      skipped: proj.skipped,
      withRam: proj.plans.filter((p) => p.ramAmount !== null).length,
      withCpu: proj.plans.filter((p) => p.cpuAmount !== null).length,
      withPrice: proj.plans.filter((p) => p.price !== null).length,
      withAvailableFlag: proj.plans.filter((p) => p.available !== null).length,
      // numbers are reported as RANGES only to help a human decide units; the API states none
      ramAmountRange: range(proj.plans.flatMap((p) => (p.ramAmount === null ? [] : [p.ramAmount]))),
      cpuAmountRange: range(proj.plans.flatMap((p) => (p.cpuAmount === null ? [] : [p.cpuAmount]))),
      catalogueVerified: proj.verified,
      unitsVerified: proj.unitsVerified,
    },
    projectBundlePlans: { present: "projectBundlePlans" in plans, count: Object.keys(bundles).length },
    databaseVersionEngines: safeKeys(obj(o.databaseVersions), 20),
    featureFlagCount: arr(o.featureFlags).length,
    unit: "NOT STATED BY API — plan RAM/CPU/price units are unverified; the catalogue stays verified:false",
  };
}

export function observeSubscription(raw: unknown): Observations {
  const o = obj(raw);
  const plan = obj(o.currentSubscriptionPlan);
  return {
    topLevelKeys: safeKeys(o),
    // LIVE FINDING: "no active plan" is `{currentSubscriptionPlan: {}}` — key present, EMPTY object — so presence of the key proves nothing
    currentSubscriptionPlanKind: o.currentSubscriptionPlan === undefined ? "absent" : o.currentSubscriptionPlan === null ? "null" : Object.keys(plan).length === 0 ? "empty-object" : "object",
    hasCurrentSubscriptionPlan: Object.keys(plan).length > 0,
    planKeys: safeKeys(plan, 20),
    fieldTypes: fieldTypes(Object.keys(plan).length ? [plan] : [], ["subscriptionPlanID", "subscriptionPlanExpiration", "subscriptionDurationType", "maxTechnicalTicketsPerMonth", "technicalTicketsCount"]),
  };
}

export function observeBilling(raw: unknown): Observations {
  const o = obj(raw);
  const user = obj(o.user);
  const b = user.balance;
  // the balance AMOUNT is never recorded: only its JSON type and whether it is negative
  return { topLevelKeys: safeKeys(o), userKeys: safeKeys(user, 12), balanceType: typeName(b), balanceNegative: typeof b === "number" ? b < 0 : null, minCreditAmountType: typeName(user.minCreditAmount) };
}

export function observeNetworks(raw: unknown): Observations {
  const o = obj(raw);
  const items = arr(o.networks).map(obj);
  return {
    topLevelKeys: safeKeys(o),
    networkCount: items.length,
    itemKeys: items.length ? safeKeys(items[0]!, 12) : [],
    idsLookLikeOpaqueStrings: items.length ? items.every((n) => typeof n._id === "string" && /^[A-Za-z0-9_-]{3,128}$/.test(n._id)) : null,
    namesPresent: items.length ? items.every((n) => typeof n.name === "string") : null,
  }; // ids and names are NEVER recorded
}

export function observeFreeCredit(raw: unknown): Observations {
  const o = obj(raw);
  const v = o.remainingFreeCredit;
  return { topLevelKeys: safeKeys(o), fieldPresent: "remainingFreeCredit" in o, fieldType: typeName(v), nonNegative: typeof v === "number" ? v >= 0 : null }; // the amount is NEVER recorded
}

// ---------- runner ----------
export type CheckVerdict = VerificationStatus | "INCONCLUSIVE";

export interface EndpointCheck {
  id: string;
  endpoint: string;
  contract: "documented" | "observed";
  required: boolean;
  verdict: CheckVerdict;
  outcome: "ok" | string; // "ok" or an error code
  httpStatus?: number;
  durationMs: number;
  errorShape?: ErrorShape;
  contractIssues?: { path: string; code: string }[];
  observations?: Observations;
  notes: string[];
  /**
   * Phase 2C: ENDPOINT REACHABILITY and SCHEMA VERIFICATION are different facts (optional: reports written before this field existed stay valid).
   *  reachability  reached = an HTTP response arrived · not_reached = no HTTP response (timeout/network/budget) · unknown
   *  schema        verified = the documented 200 body validated · mismatch = a body arrived and did not match · unverified = no body to validate
   *                (denied, missing, no content, transport failure)
   */
  reachability?: "reached" | "not_reached";
  schemaVerification?: "verified" | "mismatch" | "unverified";
  /** an HTTP status the pinned OpenAPI does not document for this operation (e.g. 204 on events) — observed behaviour, never a verified contract */
  undocumentedStatus?: number;
}

/** Reachability vs schema verification, side by side (ids only; no payload content). */
export function reachabilitySummary(checks: EndpointCheck[]): Observations {
  const reached = checks.filter((c) => c.reachability === "reached");
  return {
    endpointsReached: reached.map((c) => c.id),
    schemaVerified: checks.filter((c) => c.schemaVerification === "verified").map((c) => c.id),
    reachedButSchemaUnverified: reached.filter((c) => c.schemaVerification !== "verified").map((c) => ({ id: c.id, outcome: c.outcome, httpStatus: c.httpStatus ?? null })),
    undocumentedStatuses: checks.filter((c) => c.undocumentedStatus !== undefined).map((c) => ({ id: c.id, httpStatus: c.undocumentedStatus })),
    note: "reachability and schema verification are different facts: a reached endpoint with an unverified schema is NOT verified",
  };
}

export interface VerificationReport {
  schemaVersion: 1;
  generatedAt: string;
  mode: "live";
  host: string;
  teamScoped: boolean;
  /** "account" = account-only run (no app-scoped endpoint was called) */
  scope: "account" | "app";
  app: string | null; // pseudonym
  requestsMade: number;
  requestBudget: number;
  checks: EndpointCheck[];
  findings: Observations;
  overall: "PASSED" | "FAILED" | "INCONCLUSIVE";
}

export interface VerifyDeps {
  fetchImpl?: typeof fetch;
  now?: () => number;
  sleep?: (ms: number) => Promise<void>;
}

type Raw = { ok: true; raw: unknown; ms: number } | { ok: false; error: LiaraError; ms: number };

export async function runVerification(cfg: AppConfig, o: VerifyOptions, deps: VerifyDeps = {}): Promise<VerificationReport> {
  if (!cfg.liara.token) throw new LiaraError("not_configured", "Missing token");
  if (o.app !== null && !cfg.allowedApps?.has(o.app)) throw new LiaraError("app_not_allowed", "Application is not in the allowlist");
  const now = deps.now ?? Date.now;
  const mk = (teamId: string | null) =>
    new LiaraHttpClient({
      baseUrl: cfg.liara.baseUrl,
      token: cfg.liara.token!,
      teamId,
      timeoutMs: cfg.liara.timeoutMs,
      maxConcurrency: 2,
      maxRps: Math.min(cfg.liara.maxRps, 2),
      maxTotalRequests: o.budget,
      fetchImpl: deps.fetchImpl,
      sleep: deps.sleep,
      now: deps.now,
    });
  const http = mk(cfg.liara.teamId);
  let requests = 0;

  const call = async (id: EndpointId, args: { name?: string; query?: Record<string, string | number | boolean> }, client = http): Promise<Raw> => {
    const t0 = now();
    try {
      requests++;
      const raw = await client.get(id, args, z.unknown());
      return { ok: true, raw, ms: now() - t0 };
    } catch (e) {
      return { ok: false, error: e instanceof LiaraError ? e : new LiaraError("network", "Network error"), ms: now() - t0 };
    }
  };

  const checks: EndpointCheck[] = [];
  const plan = buildPlan(cfg, o);
  const meta = (id: string) => plan.find((p) => p.id === id)!;

  const finish = <S extends z.ZodType>(
    id: string,
    r: Raw,
    schema: S | null,
    observe: (raw: unknown) => Observations,
    notes: string[] = [],
  ): EndpointCheck => {
    const p = meta(id);
    const base = { id, endpoint: p.endpoint, contract: p.contract, required: p.required, durationMs: r.ms, notes };
    if (!r.ok) {
      const v = verificationForError(r.error.code);
      if (r.error.code === "no_content") {
        // HTTP 204/205: the endpoint was REACHED but supplied no payload. Not LIVE_VERIFIED (nothing validated), not CONTRACT_MISMATCH (no body contradicted the schema):
        // INCONCLUSIVE with the discrepancy spelled out. It must never be read as "zero items".
        return {
          ...base,
          verdict: "INCONCLUSIVE",
          outcome: "no_content",
          httpStatus: r.error.status,
          reachability: "reached",
          schemaVerification: "unverified",
          undocumentedStatus: r.error.status,
          notes: [
            ...notes,
            `HTTP ${r.error.status} No Content: the endpoint answered but supplied no payload`,
            "the documented 200 schema was NOT validated; the status is not documented for this operation in the pinned OpenAPI",
            "a 204 does NOT prove that there are zero items",
            ...(r.error.opts.noContent?.unexpectedBody ? ["a body accompanied the 204: it was ignored and never parsed"] : []),
          ],
        };
      }
      const reached = r.error.status !== undefined || ["contract_mismatch", "unauthorized", "forbidden", "not_found"].includes(r.error.code);
      return {
        ...base,
        verdict: v ?? "INCONCLUSIVE",
        outcome: r.error.code,
        httpStatus: r.error.status,
        errorShape: r.error.opts.errorShape,
        contractIssues: r.error.opts.issues,
        reachability: reached ? "reached" : "not_reached",
        schemaVerification: r.error.code === "contract_mismatch" ? "mismatch" : "unverified",
        notes: [...notes, ...(v ? [] : ["transport/server failure: no conclusion about the contract"])],
      };
    }
    let issues: { path: string; code: string }[] | undefined;
    if (schema) {
      const parsed = schema.safeParse(r.raw);
      if (!parsed.success) issues = issuesOf(parsed.error);
    }
    let observations: Observations | undefined;
    try {
      observations = observe(r.raw);
    } catch {
      notes = [...notes, "observation failed on unexpected structure"];
    }
    return {
      ...base,
      verdict: issues ? "CONTRACT_MISMATCH" : "LIVE_VERIFIED",
      outcome: "ok",
      reachability: "reached",
      schemaVerification: issues ? "mismatch" : "verified",
      contractIssues: issues,
      observations,
      notes: baselineVerification(p.contract) === "CLI_ONLY_UNVERIFIED" ? [...notes, "CLI-observed endpoint, verified only because explicitly opted in"] : notes,
    };
  };

  async function runAccountChecks(): Promise<VerificationReport> {
    const list = await call("listApps", {});
    const listCheck = finish("listApps", list, AppListSchema, observeAccountApps);
    if (listCheck.verdict === "LIVE_VERIFIED" && listCheck.observations?.visibleApplicationCount === 0) {
      // An empty list proves the envelope and the credentials, NOT the item contract (no item was ever seen).
      listCheck.verdict = "INCONCLUSIVE";
      listCheck.notes.push("HTTP 200 and envelope valid, but ZERO applications are visible: the per-item contract (fields, status vocabulary, timestamp format) is NOT verified");
    }
    checks.push(listCheck);
    const me = await call("getMe", {});
    const meCheck = finish("getMe", me, MeProjectionSchema, observeMe, ["adapter projection keeps only plans.projects (+bundle plans); user/team/storage keys are dropped"]);
    checks.push(meCheck);
    const sub = await call("getMeSubscription", {});
    checks.push(finish("getMeSubscription", sub, MeSubscriptionSchema, observeSubscription));
    const fc = await call("getMeFreeCredit", {});
    checks.push(finish("getMeFreeCredit", fc, MeFreeCreditSchema, observeFreeCredit, ["the amount is never recorded"]));
    const bill = await call("getBilling", {});
    checks.push(finish("getBilling", bill, BillingProjectionSchema as unknown as z.ZodType, observeBilling, ["the balance is never recorded", "unit is not stated by the OpenAPI"]));
    if (o.includeNetworks && cfg.liara.allowUndocumented) {
      const nets = await call("listNetworks", {});
      checks.push(finish("listNetworks", nets, NetworksSchema as unknown as z.ZodType, observeNetworks, ["undocumented endpoint, read only because explicitly opted in"]));
    }
    if (o.probeTeam && cfg.liara.teamId) {
      const noTeam = await call("listApps", {}, mk(null));
      checks.push(finish("listApps(no-team)", noTeam, AppListSchema, (raw) => ({ visibleApplicationCountWithoutTeamId: arr(obj(raw).projects).length, visibleApplicationCountWithTeamId: (listCheck.observations as Observations | undefined)?.visibleApplicationCount ?? null })));
    }
    const listObs = checks.find((c) => c.id === "listApps")?.observations;
    const findings: Observations = {
      visibleApplicationCount: listObs?.visibleApplicationCount ?? null,
      statusVocabularyFromList: listObs?.statusVocabulary ?? null,
      planCatalogue: (meCheck.observations as Observations | undefined)?.projection ?? null,
      errorBodyShapes: checks.filter((c) => c.errorShape).map((c) => ({ id: c.id, outcome: c.outcome, httpStatus: c.httpStatus, shape: c.errorShape })),
      reachability: reachabilitySummary(checks),
      appScopedChecks: "NOT_TESTED — account-only run; add one app name to LIARA_ALLOWED_APPS to verify runtime, releases, events, logs and metrics",
      nextStep: "Review this file by hand, then update docs/API_CAPABILITY_MATRIX.md and docs/LIVE_API_VERIFICATION.md. Nothing here is applied automatically.",
    };
    return { schemaVersion: 1, generatedAt: new Date(now()).toISOString(), mode: "live", host: cfg.liara.baseUrl.hostname, teamScoped: cfg.liara.teamId !== null, scope: "account", app: null, requestsMade: requests, requestBudget: o.budget, checks, findings, overall: overallOf(checks) };
  }
  function overallOf(cs: EndpointCheck[]): VerificationReport["overall"] {
    const required = cs.filter((c) => c.required);
    // A definite problem (denied / unavailable / mismatch) outranks inconclusive transport noise.
    if (required.some((c) => c.verdict !== "LIVE_VERIFIED" && c.verdict !== "INCONCLUSIVE")) return "FAILED";
    return required.every((c) => c.verdict === "LIVE_VERIFIED") ? "PASSED" : "INCONCLUSIVE";
  }
  if (o.app === null) return runAccountChecks();
  const appName: string = o.app;

  const nowMs = now();
  const endSec = Math.floor(nowMs / 1000);
  const windowSec = 3600;
  const since = endSec - windowSec;

  if (o.only === "getEvents") {
    const only = await call("getEvents", { name: appName, query: { start: since, end: endSec } });
    checks.push(finish("getEvents", only, EventsSchema, (raw) => observeEvents(raw, since * 1000, endSec * 1000)));
    return {
      schemaVersion: 1,
      generatedAt: new Date(now()).toISOString(),
      mode: "live",
      host: cfg.liara.baseUrl.hostname,
      teamScoped: cfg.liara.teamId !== null,
      scope: "app",
      app: new Pseudonymizer().name("app", appName),
      requestsMade: requests,
      requestBudget: o.budget,
      checks,
      findings: { scopeOfRun: "events-only re-check (one GET); every other capability keeps its previous status", reachability: reachabilitySummary(checks), nextStep: "Review this file by hand; update docs/API_CAPABILITY_MATRIX.md and LIVE_API_VERIFICATION.md from facts. Nothing is applied automatically." },
      overall: overallOf(checks),
    };
  }

  // 1. list
  const list = await call("listApps", {});
  const listCheck = finish("listApps", list, AppListSchema, (raw) => observeApps(raw, appName));
  checks.push(listCheck);
  const appPresent = list.ok && (listCheck.observations as Observations | undefined)?.allowlistedAppPresent === true;
  if (list.ok && !appPresent) listCheck.notes.push("the selected allowlisted app was NOT present in the account/team list (check LIARA_TEAM_ID / app name)");

  // 2. app + applets
  const appRaw = await call("getApp", { name: appName });
  checks.push(finish("getApp", appRaw, AppDetailResponse, observeApp));
  const appletsRaw = await call("getApplets", { name: appName });
  checks.push(finish("getApplets", appletsRaw, AppletsSchema, observeApplets));
  const appletNames = appletsRaw.ok ? arr(obj(appletsRaw.raw).applets).map((a) => obj(a).name).filter((n): n is string => typeof n === "string") : [];

  // 3. releases (+ pagination probe)
  const count = 10;
  const rel = await call("getReleases", { name: appName, query: { page: 1, count } });
  const relCheck = finish("getReleases", rel, ReleasesSchema, (raw) => observeReleases(raw, count));
  checks.push(relCheck);
  if (rel.ok && relCheck.observations?.totalVsReturned === "more-pages-available") {
    const p2 = await call("getReleases", { name: appName, query: { page: 2, count } });
    const ids1 = new Set(arr(obj(rel.raw).releases).map((r) => obj(r)._id));
    const c2 = finish("getReleases(page2)", p2, ReleasesSchema, (raw) => {
      const ids2 = arr(obj(raw).releases).map((r) => obj(r)._id);
      return { returned: ids2.length, disjointFromPage1: ids2.every((i) => !ids1.has(i)), ordering: ordering(arr(obj(raw).releases).map((r) => toMs(obj(r).createdAt))) };
    });
    checks.push(c2);
  } else if (rel.ok) {
    checks.push({ id: "getReleases(page2)", endpoint: meta("getReleases(page2)").endpoint, contract: "documented", required: false, verdict: "INCONCLUSIVE", outcome: "skipped", durationMs: 0, notes: ["total <= count: pagination not exercised"] });
  }

  // 4. events
  const ev = await call("getEvents", { name: appName, query: { start: since, end: endSec } });
  checks.push(finish("getEvents", ev, EventsSchema, (raw) => observeEvents(raw, since * 1000, endSec * 1000)));

  // 5. logs v1 (+ optional format probes)
  const logs = await call("getLogsV1", { name: appName, query: { since: String(since) } });
  checks.push(finish("getLogsV1", logs, LogsV1Schema, (raw) => observeLogsV1(raw, since * 1000, endSec * 1000), ["since sent as unix seconds"]));
  if (o.probeFormats) {
    for (const [id, val] of [["getLogsV1(since=iso)", new Date(since * 1000).toISOString()], ["getLogsV1(since=ms)", String(since * 1000)]] as const) {
      const r = await call("getLogsV1", { name: appName, query: { since: val } });
      checks.push(finish(id, r, LogsV1Schema, (raw) => ({ count: arr(raw).length, ordering: ordering(arr(raw).map((i) => toMs(obj(i).datetime))) }), ["format probe; compare result counts with the unix-seconds call"]));
    }
  }

  // 6. metrics
  for (const [id, kind] of [["getMetricsCpu", "cpu"], ["getMetricsMemory", "memory"]] as const) {
    const r = await call(id, { name: appName, query: { since } });
    checks.push(finish(id, r, MetricsSchema, (raw) => observeMetrics(raw, now(), windowSec, appletNames), [`${kind}; since sent as unix seconds`]));
  }

  // 7. team probe (counts only)
  if (o.probeTeam && cfg.liara.teamId) {
    const noTeam = await call("listApps", {}, mk(null));
    checks.push(
      finish("listApps(no-team)", noTeam, AppListSchema, (raw) => ({
        itemCount: arr(obj(raw).projects).length,
        allowlistedAppPresentWithoutTeamId: arr(obj(raw).projects).some((i) => obj(i).project_id === appName),
        allowlistedAppPresentWithTeamId: appPresent,
      })),
    );
  }

  // 8. optional undocumented v2
  if (o.includeV2) {
    if (!cfg.liara.allowUndocumented) throw new LiaraError("unsupported", "v2 requires LIARA_ALLOW_UNDOCUMENTED_ENDPOINTS=true");
    const r = await call("getLogsV2", { name: appName, query: { start: since, direction: "forward", last_lines: false } });
    checks.push(finish("getLogsV2", r, LogsV2Schema, observeLogsV2));
  }

  // cross-endpoint findings
  const appObs = checks.find((c) => c.id === "getApp")?.observations;
  const appletObs = checks.find((c) => c.id === "getApplets")?.observations;
  const findings: Observations = {
    scaleVsRuntime: appObs && appletObs ? { appScale: appObs.scale, appletCount: appletObs.count, appletStates: appletObs.stateVocabulary } : null,
    statusVocabularyFromList: listCheck.observations?.statusVocabulary ?? null,
    appletStateVocabulary: appletObs?.stateVocabulary ?? null,
    releaseStateVocabulary: checks.find((c) => c.id === "getReleases")?.observations?.stateVocabulary ?? null,
    errorBodyShapes: checks.filter((c) => c.errorShape).map((c) => ({ id: c.id, outcome: c.outcome, httpStatus: c.httpStatus, shape: c.errorShape })),
    reachability: reachabilitySummary(checks),
    nextStep:
      "Review this file by hand, then update docs/API_CAPABILITY_MATRIX.md and (only if justified) src/server/domain/vocabulary.ts. Nothing here is applied automatically.",
  };

  const overall = overallOf(checks);

  // Names are never emitted: the selected app appears only as a pseudonym.
  const pseudo = new Pseudonymizer();
  return {
    schemaVersion: 1,
    generatedAt: new Date(now()).toISOString(),
    mode: "live",
    host: cfg.liara.baseUrl.hostname,
    teamScoped: cfg.liara.teamId !== null,
    scope: "app",
    app: pseudo.name("app", appName),
    requestsMade: requests,
    requestBudget: o.budget,
    checks,
    findings,
    overall,
  };
}

export { ENDPOINTS };
