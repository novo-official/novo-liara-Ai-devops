import { describe, expect, it } from "vitest";
import type { PlanProjection } from "@/server/liara/plans";
import { balanceStatus, cliOffersPlan, corroborateUnits, PUBLIC_PRICING_SNAPSHOT, unitsAgreement } from "@/server/live/pricing";
import { buildPreflight, VERDICT_PRIORITY, type PreflightInput } from "@/server/live/preflight";
import { ladderVerdict, LADDER_EVIDENCE, LADDER_KEYS, type Ladder } from "@/lib/live-ladder";
import { PlanUnitsSchema } from "@/server/live/units";
import { CATALOGUE, NETWORK, TEAM, UNITS } from "../helpers/live-exec";

const plan = (id: string, ram: number | null, cpu: number | null, price: number | null, over: Record<string, unknown> = {}) => ({ id, available: true, region: "iran", ramAmount: ram, cpuAmount: cpu, volume: 1, price, ...over });
const proj = (plans: ReturnType<typeof plan>[]): PlanProjection => ({ plans, bundles: {}, skipped: 0, verified: false, unitsVerified: false });

describe("public pricing snapshot (liara.ir/pricing, 2026-10-22)", () => {
  it("has the seven PaaS plans and internally consistent hourly/monthly prices (hourly ≈ monthly / 720)", () => {
    expect(PUBLIC_PRICING_SNAPSHOT.plans.map((p) => p.name)).toEqual(["Earth", "Mars", "Jupiter", "Saturn", "Uranus", "Neptune", "Pluto"]);
    for (const p of PUBLIC_PRICING_SNAPSHOT.plans) expect(Math.abs(p.monthly / 720 - p.hourly)).toBeLessThan(1);
    expect(PUBLIC_PRICING_SNAPSHOT.currency).toBe("IRT");
    expect(PUBLIC_PRICING_SNAPSHOT.statedNothingAbout).toEqual(expect.arrayContaining(["billing_start", "minimum_balance", "bundle_plan_price", "vat"]));
  });
});

describe("units corroboration — operator configuration alone can never attest pricing", () => {
  it("GB × Toman/hour is corroborated by ≥2 catalogue plans whose RAM, CPU and exact price match published plans", () => {
    const c = corroborateUnits(CATALOGUE);
    expect(c.status).toBe("corroborated");
    expect(c.hypothesis).toEqual({ ram: "GB", per: "hour" });
    expect(c.matchedPlanIds).toEqual(expect.arrayContaining(["g2-small", "g2-medium", "g2-big"]));
    expect(c.contradictedPlanIds).toEqual([]);
  });
  it("the monthly reading and the MB reading are recognised too (and only the right one wins)", () => {
    const monthly = corroborateUnits(proj([plan("a", 1, 1, 1_300_000), plan("b", 2, 1, 2_300_000)]));
    expect(monthly).toMatchObject({ status: "corroborated", hypothesis: { ram: "GB", per: "month" } });
    const mb = corroborateUnits(proj([plan("a", 1024, 1, 1805), plan("b", 2048, 1, 3194)]));
    expect(mb).toMatchObject({ status: "corroborated", hypothesis: { ram: "MB", per: "hour" } });
  });
  it("one match is not enough; no resource-compatible plan is 'insufficient'; a different price is 'contradicted'", () => {
    expect(corroborateUnits(proj([plan("a", 1, 1, 1805)])).status).toBe("insufficient");
    expect(corroborateUnits(proj([plan("a", 0.25, 0.25, 500), plan("b", 3, 3, 9999)])).status).toBe("insufficient");
    expect(corroborateUnits(proj([plan("a", 1, 1, 1805), plan("b", 2, 1, 3194), plan("c", 4, 2, 7777)])).status).toBe("contradicted");
    expect(corroborateUnits(proj([plan("a", 1, 1, 999), plan("b", 2, 1, 999)])).status).toBe("contradicted");
    expect(corroborateUnits(null).status).toBe("no_catalogue");
  });
  it("plans without RAM, CPU or price never take part, and a public plan NAME is never mapped to an id", () => {
    const c = corroborateUnits(proj([plan("a", null, 1, 1805), plan("b", 1, null, 1805), plan("c", 1, 1, null)]));
    expect(c.status).toBe("insufficient");
    expect(c.compared).toBe(0);
    expect(JSON.stringify(corroborateUnits(CATALOGUE))).not.toMatch(/Mars|Jupiter|Saturn|Earth/);
  });
  it("the operator document is believed only if it names exactly the corroborated hypothesis AND Toman", () => {
    const c = corroborateUnits(CATALOGUE);
    expect(unitsAgreement(UNITS, c)).toBe("agree");
    expect(unitsAgreement({ ...UNITS, ram: "MB" }, c)).toBe("disagree");
    expect(unitsAgreement({ ...UNITS, price: { currency: "IRT", per: "month" } }, c)).toBe("disagree");
    expect(unitsAgreement({ ...UNITS, price: { currency: "IRR", per: "hour" } }, c)).toBe("disagree");
    expect(unitsAgreement(null, c)).toBe("no_operator_units");
    expect(unitsAgreement(UNITS, corroborateUnits(proj([plan("a", 1, 1, 1805)])))).toBe("not_corroborated");
  });
  it("accepted unknowns are a closed vocabulary (a risk acceptance, not an attestation)", () => {
    expect(PlanUnitsSchema.safeParse({ ...UNITS, acceptedUnknowns: ["billing_start"] }).success).toBe(true);
    expect(PlanUnitsSchema.safeParse({ ...UNITS, acceptedUnknowns: ["everything"] }).success).toBe(false);
    expect(PlanUnitsSchema.safeParse({ ...UNITS, acceptedUnknowns: undefined }).success).toBe(true);
  });
});

describe("what the official CLI offers, and balance classes", () => {
  it("only available, region iran, id 'free' or containing 'g2'", () => {
    expect(cliOffersPlan(plan("g2-small", 1, 1, 1) as never)).toBe(true);
    expect(cliOffersPlan(plan("free", 1, 1, 1) as never)).toBe(true);
    expect(cliOffersPlan(plan("g2-small", 1, 1, 1, { region: null }) as never)).toBe(false);
    expect(cliOffersPlan(plan("g2-small", 1, 1, 1, { region: "germany" }) as never)).toBe(false);
    expect(cliOffersPlan(plan("g2-small", 1, 1, 1, { available: false }) as never)).toBe(false);
    expect(cliOffersPlan(plan("premium", 1, 1, 1) as never)).toBe(false);
  });
  it("sufficient only if enough even as Rial; insufficient only if short even as Toman; otherwise ambiguous (the unit is not stated)", () => {
    expect(balanceStatus(1_000_000, 43_320)).toBe("sufficient"); // 100k Toman if Rial ≥ 43k
    expect(balanceStatus(1_000, 43_320)).toBe("insufficient");
    expect(balanceStatus(100_000, 43_320)).toBe("ambiguous"); // enough as Toman, not as Rial
    expect(balanceStatus(null, 43_320)).toBe("unknown");
    expect(balanceStatus(5, null)).toBe("unknown");
    expect(balanceStatus(Number.NaN, 5)).toBe("unknown");
  });
});

// -------------------------------------------------------------------------------------------------------- the report
const BALANCE_CANARY = 987_654.32;
const green = (over: Partial<PreflightInput> = {}, cfg: Partial<PreflightInput["config"]> = {}): PreflightInput => ({
  config: { liveEnabled: false, dataSourceLive: true, tokenPresent: true, teamId: TEAM, planUnits: { ...UNITS }, contractAttested: true, networkId: NETWORK, appDomainSuffixes: ["liara.run"], healthMarker: "liara-agent-demo", allowUndocumented: true, mutationsEnabled: false, aiLiveEnabled: false, ...cfg },
  catalogue: { ...CATALOGUE, account: { teamPresent: true, teamBalance: BALANCE_CANARY * 10 } },
  billing: null,
  networks: { ok: true, items: [{ id: NETWORK, name: "n1" }] },
  apps: { ok: true, count: 0 },
  selection: { planId: "g2-small", bundlePlanId: "bronze", appName: "liara-agent-demo", nameExists: false, minRamMb: 512 },
  runBlockers: [],
  nowIso: "2026-10-22T00:00:00.000Z",
  ...over,
});
const blockedIds = (r: ReturnType<typeof buildPreflight>) => r.checks.filter((c) => c.status === "blocked").map((c) => c.id);

describe("preflight report", () => {
  it("fully configured, corroborated, funded: READY_FOR_OPERATOR_APPROVAL with every blocker list empty", () => {
    const r = buildPreflight(green());
    expect(blockedIds(r)).toEqual([]);
    expect(r.verdict).toBe("READY_FOR_OPERATOR_APPROVAL");
    expect(r.account).toMatchObject({ appCount: 0, firstApp: true, balance: "sufficient" });
    expect(r.pricing!.selected).toMatchObject({ planId: "g2-small", hourlyToman: 1805, estimate: { oneHour: 1805, oneDay: 43320, thirtyDays: 1_299_600, currency: "IRT" } });
    expect(r.network).toEqual({ listing: "verified", count: 1, configuredIdPresent: true });
  });
  it("the report is sanitised: no balance amount, no network/app names, no ids of the team", () => {
    const json = JSON.stringify(buildPreflight(green()));
    for (const leak of [String(BALANCE_CANARY), String(BALANCE_CANARY * 10), "n1", TEAM, "liara-agent-demo"]) expect(json, leak).not.toContain(leak);
    expect(json).not.toMatch(/Bearer|CANARY|password|secret/i);
  });
  it("every check carries evidence classes and a Persian title and detail", () => {
    for (const c of buildPreflight(green()).checks) {
      expect(c.titleFa, c.id).toMatch(/[؀-ۿ]/);
      expect(c.detailFa, c.id).toMatch(/[؀-ۿ]/);
      expect(Array.isArray(c.evidence)).toBe(true);
    }
  });
  it("verdict priority: security > contract > pricing > configuration, and ALL blocking categories are listed", () => {
    expect(VERDICT_PRIORITY).toEqual(["security", "contract", "pricing", "configuration"]);
    const cfgOnly = buildPreflight(green({}, { networkId: null }));
    expect(cfgOnly.verdict).toBe("BLOCKED_BY_CONFIGURATION");
    const price = buildPreflight(green({}, { planUnits: null }));
    expect(price.verdict).toBe("BLOCKED_BY_PRICING");
    const contract = buildPreflight(green({}, { contractAttested: false, planUnits: null, networkId: null }));
    expect(contract.verdict).toBe("BLOCKED_BY_CONTRACT");
    expect(contract.blockerCategories).toEqual(["contract", "pricing", "configuration"]);
    const sec = buildPreflight(green({ catalogue: { ...CATALOGUE, account: { teamPresent: false, teamBalance: null } } }, { contractAttested: false }));
    expect(sec.verdict).toBe("BLOCKED_BY_SECURITY");
    expect(sec.team.consistency).toBe("mismatch");
    expect(sec.blockerCategories[0]).toBe("security");
  });
  it("pricing blockers: no operator document, uncorroborated units, disagreement, unresolved billing semantics", () => {
    expect(blockedIds(buildPreflight(green({}, { planUnits: null })))).toEqual(expect.arrayContaining(["units_operator_document", "units_agree", "selected_plan"]));
    const insufficient = buildPreflight(green({ catalogue: { ...CATALOGUE, plans: [CATALOGUE.plans[1]!], account: { teamPresent: true, teamBalance: 9e9 } } }));
    expect(blockedIds(insufficient)).toEqual(expect.arrayContaining(["units_corroborated", "units_agree"]));
    expect(blockedIds(buildPreflight(green({}, { planUnits: { ...UNITS, ram: "MB" } })))).toContain("units_agree");
    const noAccept = buildPreflight(green({}, { planUnits: { ...UNITS, acceptedUnknowns: undefined } }));
    expect(blockedIds(noAccept)).toContain("billing_semantics");
    expect(noAccept.verdict).toBe("BLOCKED_BY_PRICING");
    expect(noAccept.pricing!.unresolved.length).toBe(5);
    const partial = buildPreflight(green({}, { planUnits: { ...UNITS, acceptedUnknowns: ["billing_start", "minimum_balance"] } }));
    expect(partial.pricing!.unresolved.length).toBe(3);
    expect(partial.pricing!.accepted.length).toBe(2);
  });
  it("plan problems: unavailable, not offered by the CLI (no region), price not corroborated for THAT plan, too little RAM, no unique bundle", () => {
    const withSel = (planId: string, bundle: string | null = "bronze", minRamMb = 512) => buildPreflight(green({ selection: { planId, bundlePlanId: bundle, appName: "liara-agent-demo", nameExists: false, minRamMb } }));
    expect(blockedIds(withSel("g2-off"))).toContain("selected_plan");
    expect(withSel("g2-noregion").checks.find((c) => c.id === "selected_plan")!.detailFa).toMatch(/CLI رسمی/);
    expect(withSel("g2-tiny").checks.find((c) => c.id === "selected_plan")!.detailFa).toMatch(/قیمت این پلن/);
    expect(withSel("g2-small", "bronze", 2048).checks.find((c) => c.id === "selected_plan")!.detailFa).toMatch(/حافظه/);
    expect(withSel("g2-big", null).checks.find((c) => c.id === "selected_plan")!.detailFa).toMatch(/bundle/);
    expect(blockedIds(withSel("nope"))).toContain("selected_plan");
  });
  it("balance: unknown amounts, insufficient, ambiguous unit, and the personal-account billing read", () => {
    const team = (b: number | null) => buildPreflight(green({ catalogue: { ...CATALOGUE, account: { teamPresent: true, teamBalance: b } } }));
    expect(team(1_000_000).account.balance).toBe("sufficient");
    expect(team(100).account.balance).toBe("insufficient");
    expect(blockedIds(team(100))).toContain("balance");
    expect(team(50_000).account.balance).toBe("ambiguous");
    expect(blockedIds(team(50_000))).toContain("balance");
    expect(team(null).account.balance).toBe("unknown");
    const personal = buildPreflight(green({ billing: { ok: true, balance: 2_000_000 }, catalogue: { ...CATALOGUE, account: undefined } }, { teamId: null }));
    expect(personal.account.balance).toBe("sufficient");
    expect(buildPreflight(green({ billing: { ok: false, code: "upstream_error" }, catalogue: { ...CATALOGUE, account: undefined } }, { teamId: null })).account.balance).toBe("unknown");
  });
  it("network: not opted in, unreadable, empty account list, id not in the list, id not configured — none is ever invented", () => {
    expect(buildPreflight(green({ networks: null }, { allowUndocumented: false })).network.listing).toBe("not_opted_in");
    expect(blockedIds(buildPreflight(green({ networks: null }, { allowUndocumented: false })))).toContain("network_listing");
    expect(buildPreflight(green({ networks: { ok: false, code: "upstream_error" } })).network.listing).toBe("unavailable");
    const empty = buildPreflight(green({ networks: { ok: true, items: [] } }));
    expect(blockedIds(empty)).toContain("network_exists");
    expect(empty.checks.find((c) => c.id === "network_exists")!.detailFa).toMatch(/دستی/);
    expect(buildPreflight(green({ networks: { ok: true, items: [{ id: "net_other_1", name: null }] } })).network.configuredIdPresent).toBe(false);
    expect(blockedIds(buildPreflight(green({ networks: { ok: true, items: [{ id: "net_other_1", name: null }] } })))).toContain("network_exists");
    expect(blockedIds(buildPreflight(green({}, { networkId: null })))).toContain("network_id_configured");
  });
  it("team scope: configured but absent from the account response is a SECURITY blocker; unknown without a read is info; personal account is consistent", () => {
    expect(buildPreflight(green({ catalogue: { ...CATALOGUE, account: { teamPresent: false, teamBalance: null } } })).team.consistency).toBe("mismatch");
    expect(buildPreflight(green({ catalogue: null })).team.consistency).toBe("unknown");
    expect(buildPreflight(green({ catalogue: { ...CATALOGUE, account: { teamPresent: false, teamBalance: null } }, billing: { ok: true, balance: 1e7 } }, { teamId: null })).team.consistency).toBe("consistent");
    expect(buildPreflight(green({ catalogue: { ...CATALOGUE, account: { teamPresent: true, teamBalance: 1 } } }, { teamId: null })).team.consistency).toBe("mismatch");
  });
  it("first app: a zero-app account is a normal, safe path; an unreadable list is a blocker (collisions cannot be excluded)", () => {
    const zero = buildPreflight(green());
    expect(zero.account.firstApp).toBe(true);
    expect(zero.checks.find((c) => c.id === "first_app_bootstrap")!.detailFa).toMatch(/هیچ برنامه‌ای ندارد/);
    expect(zero.checks.find((c) => c.id === "allowlist_exact")!.detailFa).toMatch(/wildcard/);
    expect(blockedIds(buildPreflight(green({ apps: { ok: false, code: "list_incomplete" } })))).toContain("apps_readable");
    expect(buildPreflight(green({ apps: { ok: true, count: 3 } })).account.firstApp).toBe(false);
  });
  it("app name: invalid, taken, or unverifiable blocks; a free valid name passes; no name is info", () => {
    const named = (appName: string, nameExists: boolean | null) => buildPreflight(green({ selection: { planId: "g2-small", bundlePlanId: "bronze", appName, nameExists, minRamMb: 512 } }));
    expect(blockedIds(named("Bad_Name", false))).toContain("app_name");
    expect(blockedIds(named("good-name", true))).toContain("app_name");
    expect(blockedIds(named("good-name", null))).toContain("app_name");
    expect(blockedIds(named("good-name", false))).not.toContain("app_name");
    expect(buildPreflight(green({ selection: null })).checks.find((c) => c.id === "app_name")!.status).toBe("info");
  });
  it("configuration: mock data, no token, no domain, no health marker, unreadable catalogue and project blockers", () => {
    expect(blockedIds(buildPreflight(green({}, { dataSourceLive: false })))).toContain("data_source_live");
    expect(blockedIds(buildPreflight(green({}, { tokenPresent: false })))).toContain("token_present");
    expect(blockedIds(buildPreflight(green({}, { appDomainSuffixes: [] })))).toContain("app_domain_suffix");
    expect(blockedIds(buildPreflight(green({}, { healthMarker: null })))).toContain("health_marker");
    for (const m of ["ok", "healthy", "true", "status", "1234567", "{}"]) expect(blockedIds(buildPreflight(green({}, { healthMarker: m }))), m).toContain("health_marker");
    expect(blockedIds(buildPreflight(green({}, { healthMarker: "liara-agent-demo" })))).not.toContain("health_marker");
    expect(blockedIds(buildPreflight(green({ catalogue: null })))).toContain("catalogue_readable");
    expect(blockedIds(buildPreflight(green({ runBlockers: ["readiness_blocked"] })))).toContain("project_ready");
    expect(blockedIds(buildPreflight(green({ runBlockers: ["sensitive_files_in_archive_will_be_excluded"] })))).not.toContain("project_ready");
  });
  it("the live flag itself is only INFO: keeping live execution disabled is the intended state before operator approval", () => {
    expect(buildPreflight(green({}, { liveEnabled: false })).checks.find((c) => c.id === "live_flag")!.status).toBe("info");
    expect(buildPreflight(green({}, { liveEnabled: true })).checks.find((c) => c.id === "live_flag")!.status).toBe("info");
  });
  it("documented vs CLI-observed vs live-verified are never conflated (contract checks)", () => {
    const r = buildPreflight(green());
    expect(r.checks.find((c) => c.id === "network_listing")!.evidence).toEqual(["live_verified", "cli_observed"]);
    expect(r.checks.find((c) => c.id === "release_state_vocabulary")!.evidence).toEqual(["cli_observed", "not_tested"]);
    expect(r.checks.find((c) => c.id === "request_conventions")!.status).toBe("info");
    expect(r.checks.find((c) => c.id === "contract_attested")!.evidence).toEqual(["cli_observed", "operator_declared"]);
  });
});

describe("verification ladder verdicts and evidence", () => {
  const L = (o: Partial<Ladder>): Ladder => ({ apiAcceptedRequest: "ok", sourceUploaded: "ok", releaseCreated: "ok", buildCompleted: "unknown", runtimeStarted: "unknown", httpHealthVerified: "unknown", ...o });
  it("DEPLOYED only when all six are ok; FAILED when any failed; PARTIALLY_VERIFIED needs create/upload/release plus a later level; else review", () => {
    expect(ladderVerdict(L({ buildCompleted: "ok", runtimeStarted: "ok", httpHealthVerified: "ok" }))).toBe("DEPLOYED");
    expect(ladderVerdict(L({ buildCompleted: "ok", runtimeStarted: "failed" }))).toBe("FAILED");
    expect(ladderVerdict(L({ buildCompleted: "ok" }))).toBe("PARTIALLY_VERIFIED");
    expect(ladderVerdict(L({ buildCompleted: "ok", runtimeStarted: "ok" }))).toBe("PARTIALLY_VERIFIED");
    expect(ladderVerdict(L({}))).toBe("NEEDS_OPERATOR_REVIEW"); // a created release is NOT a completed build
    expect(ladderVerdict(L({ releaseCreated: "unknown", buildCompleted: "ok" }))).toBe("NEEDS_OPERATOR_REVIEW");
    expect(ladderVerdict(L({ apiAcceptedRequest: "unknown", buildCompleted: "ok" }))).toBe("NEEDS_OPERATOR_REVIEW");
  });
  it("every level has an explicit evidence source, references and a stated limitation; build/runtime are not 'documented'", () => {
    for (const k of LADDER_KEYS) {
      expect(LADDER_EVIDENCE[k].refs.length, k).toBeGreaterThan(0);
      expect(LADDER_EVIDENCE[k].limitationFa, k).toMatch(/[؀-ۿ]/);
    }
    expect(LADDER_EVIDENCE.apiAcceptedRequest.source).toBe("documented");
    expect(LADDER_EVIDENCE.sourceUploaded.source).toBe("documented");
    expect(LADDER_EVIDENCE.releaseCreated.source).toBe("documented");
    expect(LADDER_EVIDENCE.buildCompleted.source).toBe("cli_observed");
    expect(LADDER_EVIDENCE.runtimeStarted.source).toBe("cli_observed");
    expect(LADDER_EVIDENCE.httpHealthVerified.source).toBe("own_probe");
  });
});
