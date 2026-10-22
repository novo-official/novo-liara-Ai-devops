import type { PlanProjection, RawPlan } from "../liara/plans";
import type { PlanUnits } from "./units";

/**
 * PRICING EVIDENCE (Phase 2B). Operator configuration alone must never "attest" pricing facts, so the operator's unit declaration is CROSS-CHECKED against two
 * independent sources before it is believed:
 *   1. the live plan catalogue (`GET /v1/me` → `plans.projects`, raw numbers with NO units stated by the API), and
 *   2. a dated snapshot of the PUBLIC pricing page (below).
 * A unit hypothesis (RAM in GB|MB × price per hour|month, price in Toman) is "corroborated" only when at least two catalogue plans match a published plan on
 * RAM, CPU AND exact price under that single hypothesis and no resource-compatible plan contradicts it. This corroborates the UNITS only.
 * It NEVER maps a public plan name to an API plan id ("resources match" is not an identity), and it says nothing about billing semantics.
 */
export const PUBLIC_PRICING_SNAPSHOT = {
  source: "https://liara.ir/pricing/ — PaaS table (fetched 2026-10-22)",
  capturedAt: "2026-10-22",
  currency: "IRT" as const,
  ramUnit: "GB" as const,
  cpuUnit: "cores" as const,
  /** the PaaS section states nothing about VAT, billing start, minimum balance, or bundle-plan prices */
  statedNothingAbout: ["vat", "billing_start", "minimum_balance", "zero_balance_behavior", "bundle_plan_price"] as const,
  plans: [
    { name: "Earth", ramGb: 0.512, cpu: 0.5, diskGb: 5, monthly: 750_000, hourly: 1_041 },
    { name: "Mars", ramGb: 1, cpu: 1, diskGb: 10, monthly: 1_300_000, hourly: 1_805 },
    { name: "Jupiter", ramGb: 2, cpu: 1, diskGb: 20, monthly: 2_300_000, hourly: 3_194 },
    { name: "Saturn", ramGb: 4, cpu: 2, diskGb: 40, monthly: 4_125_000, hourly: 5_729 },
    { name: "Uranus", ramGb: 8, cpu: 4, diskGb: 80, monthly: 7_250_000, hourly: 10_069 },
    { name: "Neptune", ramGb: 16, cpu: 8, diskGb: 160, monthly: 12_600_000, hourly: 17_500 },
    { name: "Pluto", ramGb: 32, cpu: 16, diskGb: 320, monthly: 22_000_000, hourly: 30_555 },
  ],
} as const;
export type PricingSnapshot = typeof PUBLIC_PRICING_SNAPSHOT;

export type UnitHypothesis = { ram: "GB" | "MB"; per: "hour" | "month" };
export interface UnitsCorroboration {
  status: "corroborated" | "contradicted" | "insufficient" | "no_catalogue";
  hypothesis: UnitHypothesis | null;
  /** catalogue plan ids (public catalogue data, not account data) whose RAM+CPU+price matched a published plan under the hypothesis */
  matchedPlanIds: string[];
  contradictedPlanIds: string[];
  compared: number;
  snapshot: { source: string; capturedAt: string };
}

const HYPOTHESES: UnitHypothesis[] = [
  { ram: "GB", per: "hour" },
  { ram: "GB", per: "month" },
  { ram: "MB", per: "hour" },
  { ram: "MB", per: "month" },
];
const near = (a: number, b: number, tol: number) => Math.abs(a - b) <= Math.max(1e-9, Math.abs(b) * tol);

function evaluate(h: UnitHypothesis, plans: RawPlan[], snap: PricingSnapshot) {
  const matched: string[] = [];
  const contradicted: string[] = [];
  let compared = 0;
  for (const p of plans) {
    if (p.ramAmount === null || p.cpuAmount === null || p.price === null) continue;
    const ramGb = h.ram === "GB" ? p.ramAmount : p.ramAmount / 1024;
    const pub = snap.plans.find((s) => near(ramGb, s.ramGb, 0.03) && near(p.cpuAmount!, s.cpu, 1e-9));
    if (!pub) continue;
    compared++;
    const published = h.per === "hour" ? pub.hourly : pub.monthly;
    if (p.price === published) matched.push(p.id);
    else contradicted.push(p.id);
  }
  return { matched, contradicted, compared };
}

/** Pure. `plans` may include unavailable plans; only plans with raw RAM, CPU and price take part. */
export function corroborateUnits(projection: PlanProjection | null, snap: PricingSnapshot = PUBLIC_PRICING_SNAPSHOT): UnitsCorroboration {
  const meta = { source: snap.source, capturedAt: snap.capturedAt };
  if (!projection) return { status: "no_catalogue", hypothesis: null, matchedPlanIds: [], contradictedPlanIds: [], compared: 0, snapshot: meta };
  const results = HYPOTHESES.map((h) => ({ h, ...evaluate(h, projection.plans, snap) }));
  const strong = results.filter((r) => r.matched.length >= 2 && r.contradicted.length === 0);
  if (strong.length === 1) {
    const r = strong[0]!;
    return { status: "corroborated", hypothesis: r.h, matchedPlanIds: r.matched.slice(0, 20), contradictedPlanIds: [], compared: r.compared, snapshot: meta };
  }
  const best = [...results].sort((a, b) => b.matched.length - a.matched.length || b.compared - a.compared)[0]!;
  // resource-compatible plans exist but nothing (or something ambiguous) lines up ⇒ the data disagrees with the public page
  if (strong.length > 1 || (best.compared > 0 && best.matched.length < 2 && best.contradicted.length > 0) || (best.matched.length >= 2 && best.contradicted.length > 0)) {
    return { status: "contradicted", hypothesis: null, matchedPlanIds: best.matched.slice(0, 20), contradictedPlanIds: best.contradicted.slice(0, 20), compared: best.compared, snapshot: meta };
  }
  return { status: "insufficient", hypothesis: null, matchedPlanIds: best.matched.slice(0, 20), contradictedPlanIds: [], compared: best.compared, snapshot: meta };
}

export type UnitsAgreement = "agree" | "disagree" | "no_operator_units" | "not_corroborated";
/** The operator document is believed only if it names exactly the corroborated hypothesis and Toman. */
export function unitsAgreement(units: PlanUnits | null, c: UnitsCorroboration): UnitsAgreement {
  if (!units) return "no_operator_units";
  if (c.status !== "corroborated" || !c.hypothesis) return "not_corroborated";
  return units.ram === c.hypothesis.ram && units.price.per === c.hypothesis.per && units.price.currency === PUBLIC_PRICING_SNAPSHOT.currency ? "agree" : "disagree";
}

/** Plan ids the official CLI offers when creating an app (CLI-observed filter: `free` or ids containing `g2`, `available`, region `iran`). */
export function cliOffersPlan(p: RawPlan): boolean {
  return p.available === true && p.region === "iran" && (p.id === "free" || p.id.includes("g2"));
}

export type BalanceStatus = "sufficient" | "insufficient" | "ambiguous" | "unknown";
/**
 * Balance vs a cost, WITHOUT trusting a unit: the API states none and the console docs disagree (billing page: Toman, top-up page: Rial). `sufficient` only if the
 * balance covers the cost even if it is Rial (÷10 Toman); `insufficient` only if it fails even if it is Toman. Anything between is `ambiguous`.
 */
export function balanceStatus(balance: number | null, costToman: number | null): BalanceStatus {
  if (balance === null || costToman === null || !Number.isFinite(balance) || !Number.isFinite(costToman)) return "unknown";
  if (balance / 10 >= costToman) return "sufficient";
  if (balance < costToman) return "insufficient";
  return "ambiguous";
}
