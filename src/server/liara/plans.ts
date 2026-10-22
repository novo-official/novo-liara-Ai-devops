/**
 * Structural projection of the plan catalogue from `GET /v1/me` (`plans.projects`).
 * The API documents `plans.*` as free-form (`additionalProperties: true`); the field names below (`available`, `region`, `RAM.amount`, `CPU.amount`,
 * `volume`, `price`) come from the official CLI source, NOT from the OpenAPI. This function therefore never decides what a number MEANS:
 * it reports raw values with their JSON type, and a catalogue built from it stays `verified: false` until a human confirms units.
 */
export interface RawPlan {
  id: string;
  available: boolean | null;
  region: string | null;
  ramAmount: number | null;
  cpuAmount: number | null;
  volume: number | null;
  price: number | null;
}
export interface PlanProjection {
  plans: RawPlan[];
  /** per plan id: the bundle ("feature") plan ids and their `available` flag, as the CLI reads them (`plans.projectBundlePlans[planID]`). Structure is CLI-observed. */
  bundles: Record<string, { id: string; available: boolean | null }[]>;
  /** plan entries that were not objects or had an unusable id */
  skipped: number;
  /** a verified catalogue needs a human decision on units; this projection can never claim it */
  verified: false;
  unitsVerified: false;
  /** from the same `/v1/me` response: team mode only (`team` object present) and the team balance (raw number, UNIT NOT STATED by the API) */
  account?: { teamPresent: boolean; teamBalance: number | null };
}

const isObj = (v: unknown): v is Record<string, unknown> => typeof v === "object" && v !== null && !Array.isArray(v);
const num = (v: unknown) => (typeof v === "number" && Number.isFinite(v) ? v : null);
const PLAN_ID = /^[A-Za-z0-9][A-Za-z0-9_.-]{0,59}$/;

export function projectPlanCatalogue(projects: Record<string, unknown>, bundlePlans: Record<string, unknown> = {}, max = 200, account?: { teamPresent: boolean; teamBalance: number | null }): PlanProjection {
  const plans: RawPlan[] = [];
  let skipped = 0;
  for (const [id, v] of Object.entries(projects).slice(0, max)) {
    if (!PLAN_ID.test(id) || !isObj(v)) {
      skipped++;
      continue;
    }
    const ram = isObj(v.RAM) ? num(v.RAM.amount) : null;
    const cpu = isObj(v.CPU) ? num(v.CPU.amount) : null;
    plans.push({
      id,
      available: typeof v.available === "boolean" ? v.available : null,
      region: typeof v.region === "string" && v.region.length <= 40 ? v.region : null,
      ramAmount: ram,
      cpuAmount: cpu,
      volume: num(v.volume),
      price: num(v.price),
    });
  }
  const bundles: PlanProjection["bundles"] = {};
  for (const [planId, v] of Object.entries(bundlePlans).slice(0, max)) {
    if (!PLAN_ID.test(planId) || !isObj(v)) continue;
    bundles[planId] = Object.entries(v)
      .slice(0, 50)
      .filter(([id, b]) => PLAN_ID.test(id) && isObj(b))
      .map(([id, b]) => ({ id, available: typeof (b as Record<string, unknown>).available === "boolean" ? ((b as Record<string, unknown>).available as boolean) : null }));
  }
  return { plans, bundles, skipped: skipped + Math.max(0, Object.keys(projects).length - max), verified: false, unitsVerified: false, ...(account ? { account } : {}) };
}
