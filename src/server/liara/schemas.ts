import { z } from "zod";
import { redactText } from "../security/redact";
import { registerSecret } from "../security/secret";
import type {
  Applet,
  AppDetail,
  AppSummary,
  EventRow,
  LogLine,
  MetricSeries,
  Release,
} from "../domain/models";

/**
 * Raw-response schemas that double as the safe-field projection.
 * Rules:
 *  - zod objects here are STRIP mode (default): unknown upstream fields are dropped, so a new
 *    sensitive field added upstream cannot reach the browser/LLM/fixtures by schema evolution.
 *  - No `.passthrough()`, `.loose()`, `z.record(z.unknown())` pass-throughs into outputs.
 *  - Every string that survives is redacted + length-bounded.
 */

// ---------- helpers ----------
const optText = (max: number) =>
  z
    .string()
    .nullish()
    .transform((s) => (s == null || s === "" ? null : redactText(s, { maxLength: max })));
const optBool = z.boolean().nullish().transform((v) => (typeof v === "boolean" ? v : null));
const optNum = z.number().finite().nullish().transform((v) => (typeof v === "number" ? v : null));

/** Normalises an epoch given in s/ms/µs/ns to seconds. */
export function epochToSeconds(n: number): number {
  const a = Math.abs(n);
  if (a >= 1e17) return n / 1e9; // ns
  if (a >= 1e14) return n / 1e6; // µs
  if (a >= 1e11) return n / 1e3; // ms
  return n; // s
}

const MIN_SEC = Date.UTC(2000, 0, 1) / 1000;
const MAX_SEC = Date.UTC(2100, 0, 1) / 1000;

export function toIso(v: unknown): string | null {
  let ms: number;
  if (typeof v === "number" && Number.isFinite(v)) ms = epochToSeconds(v) * 1000;
  else if (typeof v === "string" && /^\d{9,19}$/.test(v)) ms = epochToSeconds(Number(v)) * 1000;
  else if (typeof v === "string" && v.length < 64) ms = Date.parse(v);
  else return null;
  if (!Number.isFinite(ms) || ms / 1000 < MIN_SEC || ms / 1000 > MAX_SEC) return null;
  return new Date(ms).toISOString();
}
// `.optional()` so that an ABSENT key is accepted (zod treats bare transforms of unknown as required).
const iso = z.unknown().optional().transform((v) => toIso(v));

/** Parses an array leniently: bad items are skipped and counted, not fatal. */
export function lenientItems<S extends z.ZodType>(item: S) {
  return z.array(z.unknown()).transform((arr) => {
    const items: z.output<S>[] = [];
    let skipped = 0;
    for (const raw of arr) {
      const r = item.safeParse(raw);
      if (r.success) items.push(r.data);
      else skipped++;
    }
    return { items, skipped };
  });
}

// ---------- apps ----------
const AppSummaryItem = z
  .object({
    project_id: z.string().min(1).max(100),
    type: optText(40),
    status: optText(60),
    scale: optNum,
    planID: optText(60),
    created_at: iso,
    isDeployed: optBool,
  })
  .transform(
    (p): AppSummary => ({
      name: p.project_id,
      platform: p.type,
      status: p.status,
      scale: p.scale,
      planId: p.planID,
      createdAt: p.created_at,
      isDeployed: p.isDeployed,
    }),
  );

export const AppListSchema = z.object({ projects: lenientItems(AppSummaryItem) });

const ENV_KEY = /^[A-Za-z_][A-Za-z0-9_]{0,127}$/;

// NOTE: `value` is intentionally absent from this schema.
const EnvEntry = z.object({ key: z.string(), encrypted: optBool });

const AppDetailItem = z
  .object({
    project_id: z.string().min(1).max(100),
    _id: z.string().min(1).max(100).nullish(),
    network: z.object({ _id: z.string().max(128).nullish() }).nullish(),
    type: optText(40),
    status: optText(60),
    scale: optNum,
    planID: optText(60),
    created_at: iso,
    isDeployed: optBool,
    defaultSubdomain: optBool,
    zeroDowntime: optBool,
    readOnlyRootFilesystem: optBool,
    fixedIPStatus: optText(40),
    envs: z.array(z.unknown()).nullish(),
  })
  .transform((p): AppDetail => {
    const envKeys: AppDetail["envKeys"] = [];
    for (const e of (p.envs ?? []).slice(0, 200)) {
      const r = EnvEntry.safeParse(e);
      if (r.success && ENV_KEY.test(r.data.key)) envKeys.push({ key: r.data.key, encrypted: r.data.encrypted });
    }
    return {
      name: p.project_id,
      platform: p.type,
      status: p.status,
      scale: p.scale,
      planId: p.planID,
      createdAt: p.created_at,
      isDeployed: p.isDeployed,
      instanceId: p._id ?? null,
      networkId: p.network?._id ?? null,
      defaultSubdomain: p.defaultSubdomain,
      zeroDowntime: p.zeroDowntime,
      readOnlyRootFilesystem: p.readOnlyRootFilesystem,
      fixedIpStatus: p.fixedIPStatus,
      envKeys,
    };
  });

export const AppDetailSchema = z.object({ project: AppDetailItem });

/**
 * Separate, minimal extraction of env VALUES used solely to register digests with the redactor
 * (so a value echoed into a log line gets masked). Output type is `string[]`; callers must pass
 * it straight to registerSecret() and must not store, log or return it.
 */
export const EnvValuesSchema = z
  .object({
    project: z.object({
      envs: z.array(z.object({ value: z.string().nullish() })).nullish(),
    }),
  })
  .transform((r) => (r.project.envs ?? []).map((e) => e.value ?? "").filter((v) => v.length > 0));

/**
 * Response schema for GET /v1/projects/{name}: projects the safe detail AND (as a contained side
 * effect) registers digests of env values with the redactor. Values themselves are discarded.
 */
export const AppDetailResponse = z.unknown().transform((raw, ctx) => {
  const detail = AppDetailSchema.safeParse(raw);
  if (!detail.success) {
    for (const i of detail.error.issues) ctx.addIssue({ code: "custom", path: i.path, message: i.code });
    return z.NEVER;
  }
  const values = EnvValuesSchema.safeParse(raw);
  if (values.success) for (const v of values.data) registerSecret(v);
  return detail.data.project;
});

// ---------- applets ----------
const AppletItem = z
  .object({
    id: z.string().min(1).max(120),
    name: optText(120),
    timestamp: iso,
    state: optText(60),
    reason: optText(300),
    release: z.object({ tag: optText(60) }).nullish(),
  })
  .transform(
    (a): Applet => ({
      id: redactText(a.id, { maxLength: 120 }),
      name: a.name,
      since: a.timestamp,
      state: a.state,
      reason: a.reason,
      releaseTag: a.release?.tag ?? null,
    }),
  );
export const AppletsSchema = z.object({ applets: lenientItems(AppletItem) });

// ---------- releases ----------
const ReleaseItem = z
  .object({
    _id: z.string().min(1).max(100),
    type: optText(40),
    state: optText(40),
    port: optNum,
    tag: optText(60),
    createdAt: iso,
    finishedAt: iso,
    sourceAvailable: optBool,
    gitInfo: z
      .object({
        branch: optText(100),
        commit: optText(64),
        message: optText(200),
      })
      .nullish(), // author name/email, remote URL, tags are deliberately NOT projected
  })
  .transform(
    (r): Release => ({
      id: redactText(r._id, { maxLength: 100 }),
      type: r.type,
      state: r.state,
      port: r.port,
      tag: r.tag,
      createdAt: r.createdAt,
      finishedAt: r.finishedAt,
      sourceAvailable: r.sourceAvailable,
      branch: r.gitInfo?.branch ?? null,
      commit: r.gitInfo?.commit ? r.gitInfo.commit.slice(0, 12) : null,
      message: r.gitInfo?.message ?? null,
    }),
  );

export const ReleasesSchema = z.object({
  total: optNum,
  currentRelease: optText(100),
  releases: lenientItems(ReleaseItem).nullish(),
});

// ---------- events ----------
const EventGroup = z.object({
  values: z.array(z.array(z.union([z.string(), z.number()]))),
});
export const EventsSchema = z.object({
  data: z.array(z.unknown()),
});
export function projectEvents(data: unknown[], limit: number): { rows: EventRow[]; truncated: boolean } {
  const rows: EventRow[] = [];
  for (const g of data) {
    const r = EventGroup.safeParse(g);
    if (!r.success) continue;
    for (const cells of r.data.values) {
      const strs = cells.map(String);
      const first = strs[0];
      const t = first !== undefined && /^\d{9,19}$/.test(first) ? toIso(first) : null;
      const rest = t ? strs.slice(1) : strs;
      rows.push({
        time: t,
        timeInferred: t !== null,
        text: redactText(rest.join(" · "), { maxLength: 500 }),
      });
    }
  }
  rows.sort((a, b) => (b.time ?? "").localeCompare(a.time ?? ""));
  return { rows: rows.slice(0, limit), truncated: rows.length > limit };
}

// ---------- logs ----------
const LogV1Item = z
  .object({ type: optText(20), datetime: iso, message: z.string().nullish() })
  .transform((l): LogLine => ({ time: l.datetime, stream: l.type, message: redactText(l.message ?? "", { maxLength: 1000 }) }));
export const LogsV1Schema = z.array(z.unknown()).transform((arr) => {
  const lines: LogLine[] = [];
  for (const raw of arr) {
    const r = LogV1Item.safeParse(raw);
    if (r.success) lines.push(r.data);
  }
  return lines;
});

// v2 (observed in the official CLI only): {data:[{metaData:{releaseId}, values:[[ts, line]]}]}
const LogV2Group = z.object({ values: z.array(z.tuple([z.union([z.string(), z.number()]), z.string()])) });
export const LogsV2Schema = z.object({ data: z.array(z.unknown()) }).transform((r) => {
  const lines: LogLine[] = [];
  for (const g of r.data) {
    const p = LogV2Group.safeParse(g);
    if (!p.success) continue;
    for (const [ts, line] of p.data.values) {
      lines.push({ time: toIso(ts), stream: null, message: redactText(line, { maxLength: 1000 }) });
    }
  }
  lines.sort((a, b) => (a.time ?? "").localeCompare(b.time ?? ""));
  return lines;
});

// ---------- metrics ----------
const MAX_SERIES = 10;
const MAX_POINTS = 240;
const GAP_FACTOR = 3;
const num = (v: unknown): number | null => {
  const n = typeof v === "number" ? v : typeof v === "string" && v.trim() !== "" ? Number(v) : NaN;
  return Number.isFinite(n) ? n : null;
};
const MetricsSeriesRaw = z.object({ applet: z.string().nullish(), values: z.array(z.array(z.unknown())) });

function median(xs: number[]): number | null {
  if (xs.length === 0) return null;
  const s = [...xs].sort((a, b) => a - b);
  const m = Math.floor(s.length / 2);
  return s.length % 2 ? s[m]! : (s[m - 1]! + s[m]!) / 2;
}

/** Pure analysis of already-validated points: step, gaps and last observation. No smoothing, no filling. */
export function analyzePoints(points: { t: number; v: number }[]): Pick<MetricSeries, "lastObservation" | "gapsAfter" | "stepSeconds"> {
  const deltas: number[] = [];
  for (let i = 1; i < points.length; i++) deltas.push(points[i]!.t - points[i - 1]!.t);
  const step = median(deltas.filter((d) => d > 0));
  const gapsAfter: number[] = [];
  if (step !== null) deltas.forEach((d, i) => d > step * GAP_FACTOR && gapsAfter.push(i)); // index of the point BEFORE the gap
  return { lastObservation: points.length ? points[points.length - 1]! : null, gapsAfter, stepSeconds: step };
}

export const MetricsSchema = z
  .object({ end: optNum, result: z.array(z.unknown()) })
  .transform((r) => {
    const series: MetricSeries[] = [];
    let droppedSeries = Math.max(0, r.result.length - MAX_SERIES);
    let droppedPoints = 0;
    for (const s of r.result.slice(0, MAX_SERIES)) {
      const p = MetricsSeriesRaw.safeParse(s);
      if (!p.success) {
        droppedSeries++;
        continue;
      }
      let pts = p.data.values.flatMap((pair) => {
        if (pair.length < 2) return (droppedPoints++, []);
        const t = num(pair[0]);
        const v = num(pair[1]);
        if (t === null || v === null) return (droppedPoints++, []);
        const sec = epochToSeconds(t);
        if (sec < MIN_SEC || sec > MAX_SEC) return (droppedPoints++, []);
        return [{ t: sec, v }];
      });
      pts.sort((a, b) => a.t - b.t);
      if (pts.length > MAX_POINTS) {
        const stride = Math.ceil(pts.length / MAX_POINTS);
        const keepLast = pts[pts.length - 1]!;
        pts = pts.filter((_, i) => i % stride === 0);
        if (pts[pts.length - 1] !== keepLast) pts.push(keepLast);
      }
      series.push({
        applet: p.data.applet ? redactText(p.data.applet, { maxLength: 120 }) : null,
        points: pts,
        ...analyzePoints(pts),
      });
    }
    return { series, end: r.end, droppedSeries, droppedPoints, rawSeriesCount: r.result.length };
  });

export function issuesOf(err: z.ZodError): { path: string; code: string }[] {
  // Paths and codes only — messages may embed received values.
  return err.issues.slice(0, 10).map((i) => ({
    path: i.path.map(String).join(".") || "(root)",
    code: i.code === "custom" ? i.message : i.code,
  }));
}

// ---------- account scope (GET /v1/me, /v1/me/subscription, /v1/me/free-credit) ----------
const rec = z.record(z.string(), z.unknown());

/**
 * `GET /v1/me` PROJECTION. The raw response contains the user profile (name, e-mail, phone, national code) and
 * `user.storage.{accessKey,secretKey}` — none of that is ever kept: zod STRIP mode drops `user`, `team` and every other key.
 * Only the project plan catalogue survives, and only as raw records for `projectPlanCatalogue()` to inspect field by field.
 * `plans.projects` is REQUIRED here: the plan catalogue is the only reason the agent reads this endpoint.
 */
export const MeProjectionSchema = z.object({
  plans: z.object({ projects: rec, projectBundlePlans: rec.optional() }),
  /** Phase 2B: team mode only (documented in `me.yaml`: `Team` = User + `balance` + member role/permissions). ONLY `balance` is kept; every other team key is stripped. */
  team: z.object({ balance: z.number().finite().nullish() }).nullish(),
});

/**
 * `GET /v1/billing` PROJECTION (documented in the pinned `billing.yaml`). `user` carries balance + notification-threshold settings; only the numeric
 * `balance` survives (the unit is NOT stated in the OpenAPI, and the console docs disagree: the billing page says Toman, the top-up page says Rial).
 */
export const BillingProjectionSchema = z.object({ user: z.object({ balance: z.number().finite().nullish() }) }).transform((r) => ({ balance: typeof r.user.balance === "number" ? r.user.balance : null }));

/**
 * `GET /v1/networks` PROJECTION (CLI-observed `{ networks: [{ _id, name, createdAt }] }`; undocumented). Only `_id` and a short `name` are kept; a malformed item is
 * skipped, never guessed.
 */
const NetworkItem = z.object({ _id: z.string().regex(/^[A-Za-z0-9][A-Za-z0-9_-]{2,127}$/), name: optText(60) });
export const NetworksSchema = z
  .object({ networks: z.array(z.unknown()).max(200) })
  .transform((r) => {
    const items: { id: string; name: string | null }[] = [];
    let skipped = 0;
    for (const it of r.networks) {
      const p = NetworkItem.safeParse(it);
      if (p.success) items.push({ id: p.data._id, name: p.data.name });
      else skipped++;
    }
    return { items, skipped };
  });

/**
 * Subscription. LIVE FINDING (2026-10): with no active plan the API returns `{ "currentSubscriptionPlan": {} }` — the key IS present with an EMPTY
 * object (the spec only says "returns an empty object when there is no active plan"). "Present" therefore does not mean "active": an active plan is
 * one that carries an id or type. `null` is tolerated as well. Only short labels are kept.
 */
export const MeSubscriptionSchema = z
  .object({ currentSubscriptionPlan: z.object({ type: optText(40), subscriptionPlanID: optText(60), subscriptionDurationType: optText(40) }).nullish() })
  .transform((r) => {
    const p = r.currentSubscriptionPlan;
    const active = !!p && (p.subscriptionPlanID !== null || p.type !== null);
    return { hasActivePlan: active, planId: p?.subscriptionPlanID ?? null, durationType: p?.subscriptionDurationType ?? null };
  });

/** Free credit: the amount is a number; it is omitted for teams. The VALUE is never exposed beyond this projection. */
export const MeFreeCreditSchema = z.object({ remainingFreeCredit: z.number().finite().optional() }).transform((r) => ({ present: r.remainingFreeCredit !== undefined, amount: r.remainingFreeCredit ?? null }));
