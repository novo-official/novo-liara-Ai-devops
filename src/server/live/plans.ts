import type { PlanProjection, RawPlan } from "../liara/plans";
import type { PlanUnits } from "./units";
import { PLAN_ID } from "./contract";
import type { FinancialImpact } from "./types";

/**
 * VERIFIED PLAN SELECTION. The catalogue comes from the real `GET /v1/me` (Phase 1F: 42 project plans, 15 available), projected field by field.
 * What is NOT known and is therefore never guessed: the unit of RAM/CPU/price, when billing starts, the minimum balance, and whether a plan fits a platform
 * (the API exposes no platform per plan). Consequences, all enforced here:
 *   - only plans with `available === true` can ever be chosen; the operator chooses — the smallest plan is never assumed sufficient
 *   - without operator-verified units (LIARA_PLAN_UNITS_JSON) there is NO cost estimate, no resource comparison, and live creation is BLOCKED
 *   - an estimate exists only for a stated duration and only when billing semantics were declared, and it is labelled with those semantics
 *   - nothing here charges, buys or changes a plan
 */

export type PlanBlocker =
  | "plan_id_invalid"
  | "plan_not_found"
  | "plan_unavailable"
  | "bundle_plan_unavailable"
  | "bundle_plan_ambiguous"
  | "units_unverified"
  | "price_missing"
  | "ram_unknown"
  | "ram_insufficient";

export interface PlanSelection {
  ok: boolean;
  blockers: PlanBlocker[];
  /** non-blocking things the operator must know */
  notes: string[];
  plan: RawPlan | null;
  bundlePlanId: string | null;
  financial: FinancialImpact;
}

export const DEFAULT_ESTIMATE_HOURS = 24 * 30;
const HOURS_PER_MONTH = 720; // used ONLY for a per-month ↔ per-hour conversion when the operator declared the price unit

/** Always-present cost caveats, regardless of what is verified. */
export const ALWAYS_UNKNOWN_COSTS = ["هزینهٔ ترافیک خروجی (دانلود)", "هزینهٔ IP ثابت (در صورت فعال‌سازی)", "هزینهٔ دیسک (در صورت افزودن)"];

function mb(ram: number, unit: "GB" | "MB"): number {
  return unit === "GB" ? ram * 1024 : ram;
}

export function financialFor(plan: RawPlan | null, planId: string, units: PlanUnits | null, durationHours = DEFAULT_ESTIMATE_HOURS): FinancialImpact {
  const unknown = [...ALWAYS_UNKNOWN_COSTS];
  if (!units) {
    unknown.unshift("واحد قیمت و منابع پلن (تأییدنشده)", "زمان شروع صورتحساب", "حداقل موجودی لازم برای ساخت");
    return {
      unitsVerified: false,
      planId,
      resource: { ramAmount: plan?.ramAmount ?? null, cpuAmount: plan?.cpuAmount ?? null, volume: plan?.volume ?? null, price: plan?.price ?? null, ramUnit: null, cpuUnit: null, priceUnit: null },
      estimate: null,
      requiredBalance: null,
      knownOtherCosts: [],
      unknownCostComponents: unknown,
    };
  }
  const priceUnit = `${units.price.currency}/${units.price.per}`;
  let estimate: FinancialImpact["estimate"] = null;
  if (plan?.price !== null && plan?.price !== undefined) {
    if (units.billing.model === "monthly_prepaid") {
      const monthly = units.price.per === "month" ? plan.price : plan.price * HOURS_PER_MONTH;
      estimate = { durationHours, amount: round(monthly * Math.ceil(durationHours / HOURS_PER_MONTH)), currency: units.price.currency, basis: `monthly_prepaid; price per ${units.price.per}${units.price.per === "hour" ? "×720h" : ""}; verified ${units.verifiedAt}` };
    } else {
      const hourly = units.price.per === "hour" ? plan.price : plan.price / HOURS_PER_MONTH;
      estimate = { durationHours, amount: round(hourly * durationHours), currency: units.price.currency, basis: `hourly_from_creation; price per ${units.price.per}${units.price.per === "month" ? "/720h" : ""}; verified ${units.verifiedAt}` };
    }
  }
  return {
    unitsVerified: true,
    planId,
    resource: { ramAmount: plan?.ramAmount ?? null, cpuAmount: plan?.cpuAmount ?? null, volume: plan?.volume ?? null, price: plan?.price ?? null, ramUnit: units.ram, cpuUnit: units.cpu, priceUnit },
    estimate,
    requiredBalance: units.billing.minimumBalanceToCreate,
    knownOtherCosts: [...units.billing.otherCostsKnown],
    unknownCostComponents: [...units.billing.otherCostsUnknown, ...unknown],
  };
}
const round = (n: number) => Math.round(n * 100) / 100;

export interface SelectInput {
  projection: PlanProjection;
  planId: string;
  /** explicit choice when a plan has several available bundle ("feature") plans */
  bundlePlanId?: string | null;
  units: PlanUnits | null;
  /** minimum RAM the workload needs, in MB (Phase 1E guidance); compared ONLY when the RAM unit is operator-verified */
  minRamMb: number;
  durationHours?: number;
}

export function selectPlan(i: SelectInput): PlanSelection {
  const blockers: PlanBlocker[] = [];
  const notes: string[] = [];
  if (typeof i.planId !== "string" || !PLAN_ID.test(i.planId)) {
    return { ok: false, blockers: ["plan_id_invalid"], notes, plan: null, bundlePlanId: null, financial: financialFor(null, "invalid", i.units, i.durationHours) };
  }
  const plan = i.projection.plans.find((p) => p.id === i.planId) ?? null;
  if (!plan) blockers.push("plan_not_found");
  else if (plan.available !== true) blockers.push("plan_unavailable"); // false AND unknown are both refused
  if (plan && plan.price === null) blockers.push("price_missing");
  if (plan && plan.region === null) notes.push("منطقهٔ این پلن در پاسخ API مشخص نیست.");
  notes.push("سازگاری پلن با پلتفرم در API مشخص نیست؛ لیارا ترکیب نامعتبر را هنگام ساخت رد می‌کند (تأییدنشده).");

  // bundle ("feature") plan: always sent by the official CLI; chosen explicitly when ambiguous
  let bundlePlanId: string | null = null;
  if (plan) {
    const avail = (i.projection.bundles[plan.id] ?? []).filter((b) => b.available === true).map((b) => b.id);
    if (i.bundlePlanId) {
      if (avail.includes(i.bundlePlanId)) bundlePlanId = i.bundlePlanId;
      else blockers.push("bundle_plan_unavailable");
    } else if (avail.length === 1) bundlePlanId = avail[0]!;
    else if (avail.length === 0) blockers.push("bundle_plan_unavailable");
    else blockers.push("bundle_plan_ambiguous");
  }

  if (!i.units) blockers.push("units_unverified");
  else if (plan) {
    if (plan.ramAmount === null) blockers.push("ram_unknown");
    else if (mb(plan.ramAmount, i.units.ram) < i.minRamMb) blockers.push("ram_insufficient");
  }
  return { ok: blockers.length === 0, blockers: [...new Set(blockers)], notes, plan, bundlePlanId, financial: financialFor(plan, i.planId, i.units, i.durationHours) };
}

/** Candidates the operator may CHOOSE from. Unverified units ⇒ no ranking and no "recommended" flag: availability only. Never auto-picks the smallest. */
export function listCandidates(projection: PlanProjection, units: PlanUnits | null, minRamMb: number): { id: string; recommended: boolean | null; ramAmount: number | null; price: number | null; region: string | null; reasonFa: string }[] {
  return projection.plans
    .filter((p) => p.available === true)
    .map((p) => ({
      id: p.id,
      recommended: units && p.ramAmount !== null ? mb(p.ramAmount, units.ram) >= minRamMb : null,
      ramAmount: p.ramAmount,
      price: p.price,
      region: p.region,
      reasonFa: units ? (p.ramAmount !== null && mb(p.ramAmount, units.ram) >= minRamMb ? "حافظهٔ کافی طبق واحدهای تأییدشده" : "حافظه کمتر از حداقل برآوردی است") : "واحدها تأیید نشده؛ فقط «در دسترس بودن» معلوم است",
    }))
    .sort((a, b) => (a.ramAmount ?? Infinity) - (b.ramAmount ?? Infinity) || a.id.localeCompare(b.id));
}
