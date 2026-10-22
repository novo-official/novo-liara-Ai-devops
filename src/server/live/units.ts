import { z } from "zod";

/**
 * OPERATOR-VERIFIED plan units and billing semantics.
 * The API states no unit for plan RAM/CPU/price (Phase 1F live finding), so this project never guesses: live creation stays BLOCKED until the
 * operator supplies this document (LIARA_PLAN_UNITS_JSON) after checking the official Liara pricing pages, and every figure derived from it is
 * labelled with the units and source the operator declared. Without it there is no cost estimate and no creation.
 */
export const PlanUnitsSchema = z
  .object({
    ram: z.enum(["GB", "MB"]),
    cpu: z.literal("cores"),
    price: z.object({ currency: z.enum(["IRT", "IRR", "USD"]), per: z.enum(["hour", "month"]) }).strict(),
    billing: z
      .object({
        model: z.enum(["hourly_from_creation", "monthly_prepaid"]),
        /** the minimum account balance Liara requires to create an app, when documented; null = documented as none / unknown to the operator */
        minimumBalanceToCreate: z.number().finite().nonnegative().nullable(),
        otherCostsKnown: z.array(z.string().max(120)).max(10),
        otherCostsUnknown: z.array(z.string().max(120)).max(10),
      })
      .strict(),
    /**
     * Facts the official sources do NOT state, which the operator knowingly accepts as unresolved (a RISK ACCEPTANCE, never an attestation: they stay labelled
     * "unknown" everywhere). Anything not listed here keeps live creation BLOCKED.
     */
    acceptedUnknowns: z.array(z.enum(["billing_start", "minimum_balance", "zero_balance_behavior", "bundle_plan_price", "vat"])).max(5).optional(),
    verifiedAt: z.string().regex(/^\d{4}-\d{2}-\d{2}(T[\d:.]+Z)?$/),
    source: z.string().min(8).max(200),
  })
  .strict();
export type PlanUnits = z.infer<typeof PlanUnitsSchema>;

export function parsePlanUnits(raw: string | undefined): { units: PlanUnits | null; problem?: string } {
  if (raw === undefined || raw.trim() === "") return { units: null };
  try {
    const parsed = PlanUnitsSchema.safeParse(JSON.parse(raw));
    return parsed.success ? { units: parsed.data } : { units: null, problem: "LIARA_PLAN_UNITS_JSON does not match the required schema" };
  } catch {
    return { units: null, problem: "LIARA_PLAN_UNITS_JSON is not valid JSON" };
  }
}
