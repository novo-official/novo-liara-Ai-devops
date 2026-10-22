import { readFileSync } from "node:fs";
import path from "node:path";
import { describe, expect, it } from "vitest";
import { ConfigError, loadConfig } from "@/server/config/env";
import { ENDPOINTS } from "@/server/liara/endpoints";
import { projectPlanCatalogue } from "@/server/liara/plans";
import { APPROVED_FIELDS, Pseudonymizer, sanitizeForFixture } from "@/server/liara/recorder";
import { MeFreeCreditSchema, MeProjectionSchema, MeSubscriptionSchema } from "@/server/liara/schemas";
import { buildPlan, observeFreeCredit, observeMe, observeSubscription, runVerification, type VerifyOptions } from "@/server/liara/verify";
import { assertNoCanary, CANARY } from "../helpers/canaries";
import { defaultResponder, json, LIVE_ENV, makeConfig, recordingFetch, type Responder } from "../helpers/live";

const NOW = Date.UTC(2026, 0, 2, 4, 0, 0);
const acct: VerifyOptions = { app: null, probeFormats: false, probeTeam: false, includeV2: false, budget: 25 };
const ME = {
  user: { _id: "u1", fullname: "CANARY Person", email: CANARY.email, phone: "09120000000", nationalCode: "0012345678", storage: { namespace: "ns", accessKey: CANARY.apiToken, secretKey: CANARY.sshKey }, contactInfo: { address: CANARY.remote } },
  team: { _id: "t1", balance: 123456, teamMemberRole: { name: "owner", permissions: ["x"] } },
  databaseVersions: { mysql: [{ label: "8", value: "8" }], postgres: [{ label: "16", value: "16" }] },
  featureFlags: [{ key: "a", value: true }, { key: "b", value: "x" }],
  plans: {
    projects: {
      standard: { available: true, region: "iran", RAM: { amount: 512 }, CPU: { amount: 1 }, volume: 10, price: 0.5, secretish: CANARY.token },
      big: { available: false, region: "iran", RAM: { amount: 2048 }, CPU: { amount: 2 }, volume: 20, price: 2 },
      weird: "not-an-object",
      "bad id with spaces": { available: true },
    },
    projectBundlePlans: { standard: { "1": { displayPrice: 1 } } },
    mail: { x: 1 },
  },
};
const accountResponder = (over: Record<string, () => Response> = {}): Responder => (url, call) => {
  const p = url.pathname;
  if (over[p]) return over[p]!();
  if (p === "/v1/me") return json(ME);
  if (p === "/v1/me/subscription") return json({ currentSubscriptionPlan: { _id: "s", type: "subscription", subscriptionPlanID: "free", subscriptionDurationType: "monthly", userID: "u1" } });
  if (p === "/v1/me/free-credit") return json({ remainingFreeCredit: 4.2 });
  if (p === "/v1/billing") return json({ user: { balance: 123456.5, accountType: "CANARY-ACCOUNT", minCreditAmount: 20000, isManualMinCredit: false, minCreditLastNotifiedAt: null } });
  if (p === "/v1/networks") return json({ networks: [{ _id: "net_canary_01", name: "canary-network", createdAt: "2026-01-01T00:00:00.000Z" }] });
  return defaultResponder()(url, call);
};
const cfg = (env: Record<string, string | undefined> = {}) => makeConfig({ ...LIVE_ENV, LIARA_ALLOWED_APPS: "", APP_ACCESS_PASSWORD_HASH: "", ...env });
// the account-only loader (what the script uses)
const vcfg = (env: Record<string, string | undefined> = {}) => loadConfig({ NODE_ENV: "test", ...LIVE_ENV, LIARA_ALLOWED_APPS: "", APP_ACCESS_PASSWORD_HASH: "", ...env }, { verification: true });
const run = (responder: Responder = accountResponder(), o: Partial<VerifyOptions> = {}, env: Record<string, string | undefined> = {}) => {
  const rec = recordingFetch(responder);
  const p = runVerification(vcfg(env), { ...acct, ...o }, { fetchImpl: rec.impl, now: () => NOW, sleep: async () => undefined });
  return { p, ...rec };
};
const byId = (r: Awaited<ReturnType<typeof runVerification>>, id: string) => r.checks.find((c) => c.id === id)!;

describe("verification-mode configuration relaxes ONLY the allowlist and UI password requirements", () => {
  it("the normal loader (used by the server) still refuses a live config without them", () => {
    try {
      cfg();
      throw new Error("should have thrown");
    } catch (e) {
      expect(e).toBeInstanceOf(ConfigError);
      expect((e as ConfigError).problems.join(" ")).toMatch(/LIARA_ALLOWED_APPS is required/);
      expect((e as ConfigError).problems.join(" ")).toMatch(/APP_ACCESS_PASSWORD_HASH is required/);
    }
  });
  it("verification mode accepts them empty but nothing else", () => {
    expect(vcfg().allowedApps).toBeNull();
    const bad: [Record<string, string | undefined>, RegExp][] = [
      [{ LIARA_API_TOKEN: "" }, /LIARA_API_TOKEN is required/],
      [{ ENABLE_MUTATIONS: "true" }, /ENABLE_MUTATIONS/],
      [{ AI_LIVE_REQUESTS_ENABLED: "true" }, /AI_LIVE_REQUESTS_ENABLED/],
      [{ LIARA_ALLOWED_APPS: "*" }, /wildcards/],
      [{ LIARA_ALLOWED_APPS: "Bad_Name" }, /invalid app name/],
      [{ LIARA_API_BASE_URL: "http://api.liara.ir" }, /https/],
      [{ LIARA_API_BASE_URL: "https://evil.example" }, /trusted/],
      [{ LIARA_API_BASE_URL: "https://user:pw@api.liara.ir" }, /credentials/],
      [{ LIARA_LOGS_API: "v2" }, /UNDOCUMENTED|undocumented/i],
    ];
    for (const [env, re] of bad) {
      let msg = "";
      try {
        vcfg(env);
      } catch (e) {
        msg = (e as ConfigError).problems.join(" ");
      }
      expect(msg, JSON.stringify(Object.keys(env))).toMatch(re);
    }
  });
  it("errors never echo the token", () => {
    try {
      vcfg({ ENABLE_MUTATIONS: "true" });
    } catch (e) {
      assertNoCanary((e as ConfigError).problems.join(" "));
      expect(JSON.stringify((e as ConfigError).problems)).not.toContain(CANARY.token);
    }
  });
  it("a team id is passed through for the verifier (query parameter), and is optional", () => {
    expect(vcfg({ LIARA_TEAM_ID: "team_1" }).liara.teamId).toBe("team_1");
    expect(vcfg().liara.teamId).toBeNull();
  });
});

describe("endpoint registry", () => {
  const me = readFileSync(path.resolve(__dirname, "../../docs/reference/openapi/me.yaml"), "utf8");
  it("the account endpoints are GET-only, documented in the pinned me.yaml, and well bounded", () => {
    for (const id of ["getMe", "getMeSubscription", "getMeFreeCredit"] as const) {
      const d = ENDPOINTS[id];
      expect(d.method).toBe("GET");
      expect(d.contract).toBe("documented");
      expect(me, d.path).toContain(`  ${d.path}:`);
      expect(d.maxBytes).toBeLessThanOrEqual(2 * 1024 * 1024);
      expect(d.path).not.toMatch(/\{/);
    }
  });
  it("the registry still contains only GET operations", () => {
    expect(Object.values(ENDPOINTS).every((e) => e.method === "GET")).toBe(true);
  });
});

describe("account-only plan", () => {
  it("lists exactly five GET checks (Phase 2B adds the documented billing read), none app-scoped", () => {
    const plan = buildPlan(vcfg(), acct);
    expect(plan.map((p) => p.id)).toEqual(["listApps", "getMe", "getMeSubscription", "getMeFreeCredit", "getBilling"]);
    expect(buildPlan(vcfg(), { ...acct, includeNetworks: true }).map((p) => p.id)).toEqual(["listApps", "getMe", "getMeSubscription", "getMeFreeCredit", "getBilling", "listNetworks"]);
    for (const p of plan) {
      expect(p.endpoint).toMatch(/^GET \//);
      expect(p.endpoint).not.toMatch(/\{app\}|\{name\}|\/projects\/[^/]/);
      expect(p.contract).toBe("documented");
    }
    expect(plan.filter((p) => p.required).map((p) => p.id)).toEqual(["listApps", "getMe", "getMeSubscription"]);
  });
});

describe("account-only run (synthetic upstream)", () => {
  it("passes using only the five GETs, no body, token only in the header, and records STRUCTURE only", async () => {
    const { p, calls } = run();
    const r = await p;
    expect(r).toMatchObject({ scope: "account", app: null, overall: "PASSED", mode: "live" });
    expect(calls.map((c) => `${c.method} ${c.url.pathname}`)).toEqual(["GET /v1/projects", "GET /v1/me", "GET /v1/me/subscription", "GET /v1/me/free-credit", "GET /v1/billing"]);
    expect(r.requestsMade).toBe(5);
    for (const c of calls) {
      expect(c.body).toBeNull();
      expect(c.url.hostname).toBe("api.liara.ir");
      expect(c.url.search).not.toMatch(/token|key|secret/i);
      expect(c.headers.authorization).toBe(`Bearer ${CANARY.token}`);
    }
    // the report never contains the token, profile data, storage keys, contact data or amounts
    const json = JSON.stringify(r);
    assertNoCanary(json);
    for (const leak of ["CANARY Person", "09120000000", "0012345678", "123456", "4.2", "not-an-object"]) expect(json, leak).not.toContain(leak);
    const me = byId(r, "getMe");
    expect(me.verdict).toBe("LIVE_VERIFIED");
    expect(me.observations).toMatchObject({ teamBalanceType: "number", teamFieldNames: ["_id", "balance", "teamMemberRole"] });
    expect(me.observations).toMatchObject({ userPresent: true, teamPresent: true, projectPlans: { count: 4 }, projection: { projectedPlanCount: 2, skipped: 2, withRam: 2, withCpu: 2, withPrice: 2, catalogueVerified: false, unitsVerified: false } });
    expect((me.observations as { unit: string }).unit).toMatch(/NOT STATED/);
    expect(byId(r, "getMeFreeCredit").observations).toEqual({ topLevelKeys: ["remainingFreeCredit"], fieldPresent: true, fieldType: "number", nonNegative: true });
    expect(byId(r, "getMeSubscription").observations).toMatchObject({ hasCurrentSubscriptionPlan: true });
    expect(r.findings.appScopedChecks).toMatch(/NOT_TESTED/);
  });
  it("LIVE FINDING: an empty application list is INCONCLUSIVE (envelope proven, item contract NOT), never a clean pass", async () => {
    const r = await run(accountResponder({ "/v1/projects": () => json({ projects: [] }) })).p;
    const l = byId(r, "listApps");
    expect(l).toMatchObject({ verdict: "INCONCLUSIVE", outcome: "ok" });
    expect(l.notes.join(" ")).toMatch(/ZERO applications/);
    expect(l.observations).toMatchObject({ visibleApplicationCount: 0 });
    expect(r.findings.visibleApplicationCount).toBe(0);
    expect(r.overall).toBe("INCONCLUSIVE");
    expect(byId(r, "getMe").verdict).toBe("LIVE_VERIFIED"); // the credentials and the account endpoints are still proven
  });
  it("the team id is sent as a query parameter only when configured", async () => {
    const { p, calls } = run(accountResponder(), {}, { LIARA_TEAM_ID: "team_1" });
    const r = await p;
    expect(r.teamScoped).toBe(true);
    for (const c of calls) expect(c.url.searchParams.get("teamID")).toBe("team_1");
  });
  it("--probe-team adds ONE extra GET /v1/projects without teamID and records COUNTS only", async () => {
    const plan = buildPlan(vcfg({ LIARA_TEAM_ID: "team_1" }), { ...acct, probeTeam: true });
    expect(plan.map((p) => p.id)).toEqual(["listApps", "getMe", "getMeSubscription", "getMeFreeCredit", "getBilling", "listApps(no-team)"]);
    expect(buildPlan(vcfg(), { ...acct, probeTeam: true }).length).toBe(5); // no team configured: nothing to probe
    const rec = run(accountResponder(), { probeTeam: true }, { LIARA_TEAM_ID: "team_1" });
    const r = await rec.p;
    const noTeam = rec.calls.filter((c) => !c.url.searchParams.has("teamID"));
    expect(noTeam.map((c) => c.url.pathname)).toEqual(["/v1/projects"]);
    expect(r.requestsMade).toBe(6);
    expect(byId(r, "listApps(no-team)").observations).toEqual({ visibleApplicationCountWithoutTeamId: 4, visibleApplicationCountWithTeamId: 4 });
    assertNoCanary(JSON.stringify(r));
  });
  it("never calls an app-scoped endpoint, even when an allowlist exists", async () => {
    const { p, calls } = run(accountResponder(), {}, { LIARA_ALLOWED_APPS: "shop-api" });
    await p;
    expect(calls.every((c) => !/\/projects\/[^/]/.test(c.url.pathname))).toBe(true);
  });
  it("401 on an account endpoint is ACCESS_DENIED (never 'unavailable') and fails the run", async () => {
    const { p } = run(accountResponder({ "/v1/me": () => new Response("", { status: 401 }) }));
    const r = await p;
    expect(byId(r, "getMe")).toMatchObject({ verdict: "ACCESS_DENIED", httpStatus: 401 });
    expect(r.overall).toBe("FAILED");
  });
  it("403 is ACCESS_DENIED; 404 is UNAVAILABLE", async () => {
    const r1 = await run(accountResponder({ "/v1/me/subscription": () => new Response("{}", { status: 403 }) })).p;
    expect(byId(r1, "getMeSubscription").verdict).toBe("ACCESS_DENIED");
    const r2 = await run(accountResponder({ "/v1/me/subscription": () => new Response("", { status: 404 }) })).p;
    expect(byId(r2, "getMeSubscription").verdict).toBe("UNAVAILABLE");
  });
  it("a response without the plan catalogue is CONTRACT_MISMATCH, not success", async () => {
    const r = await run(accountResponder({ "/v1/me": () => json({ user: { email: CANARY.email } }) })).p;
    const me = byId(r, "getMe");
    expect(me.verdict).toBe("CONTRACT_MISMATCH");
    expect(me.contractIssues!.length).toBeGreaterThan(0);
    expect(r.overall).toBe("FAILED");
    assertNoCanary(JSON.stringify(r));
  });
  it("HTTP 200 with non-JSON is a contract mismatch; a redirect is never followed", async () => {
    const r1 = await run(accountResponder({ "/v1/me": () => new Response("<html>login</html>", { status: 200, headers: { "content-type": "text/html" } }) })).p;
    expect(byId(r1, "getMe").verdict).toBe("CONTRACT_MISMATCH");
    const rec = run(accountResponder({ "/v1/me": () => new Response(null, { status: 302, headers: { location: "https://evil.example/steal" } }) }));
    const r2 = await rec.p;
    expect(byId(r2, "getMe").verdict).toBe("INCONCLUSIVE");
    expect(rec.calls.every((c) => c.url.hostname === "api.liara.ir")).toBe(true);
  });
  it("transport failures are INCONCLUSIVE and the request budget (including retries) is respected", async () => {
    const rec = run(() => new Response("boom", { status: 500 }), { budget: 8 });
    const r = await rec.p;
    expect(r.requestsMade).toBeLessThanOrEqual(8);
    expect(rec.calls.length).toBeLessThanOrEqual(8);
    expect(r.checks.every((c) => c.verdict === "INCONCLUSIVE")).toBe(true);
    expect(r.overall).toBe("INCONCLUSIVE");
  });
  it("a tiny budget stops the run locally instead of sending more", async () => {
    const rec = run(accountResponder(), { budget: 2 });
    const r = await rec.p;
    expect(rec.calls.length).toBeLessThanOrEqual(2);
    expect(r.checks.some((c) => c.outcome === "rate_limited")).toBe(true);
  });
  it("the optional free-credit endpoint failing does not fail the run", async () => {
    const r = await run(accountResponder({ "/v1/me/free-credit": () => new Response("", { status: 403 }) })).p;
    expect(byId(r, "getMeFreeCredit").verdict).toBe("ACCESS_DENIED");
    expect(r.overall).toBe("PASSED"); // free credit is optional (it is omitted for teams)
  });
});

describe("account projections (nothing sensitive survives)", () => {
  it("MeProjectionSchema keeps only the plan catalogue; profile, team and storage keys are stripped", () => {
    const out = MeProjectionSchema.parse(ME);
    expect(Object.keys(out).sort()).toEqual(["plans", "team"]);
    expect(Object.keys(out.team ?? {})).toEqual(["balance"]); // Phase 2B: ONLY the team balance is kept; role, permissions, profile keys are stripped
    expect(Object.keys(out.plans).sort()).toEqual(["projectBundlePlans", "projects"]);
    assertNoCanary(JSON.stringify(Object.keys(out)));
    expect(JSON.stringify({ k: Object.keys(out) })).not.toMatch(/user|storage/);
  });
  it("requires plans.projects (a response without it is a mismatch)", () => {
    expect(MeProjectionSchema.safeParse({ user: {} }).success).toBe(false);
    expect(MeProjectionSchema.safeParse({ plans: {} }).success).toBe(false);
    expect(MeProjectionSchema.safeParse({ plans: { projects: [] } }).success).toBe(false);
  });
  it("subscription: LIVE FINDING — no active plan is `{currentSubscriptionPlan: {}}` (key present, empty object); null and absent also mean inactive", () => {
    const none = { hasActivePlan: false, planId: null, durationType: null };
    for (const raw of [{}, { currentSubscriptionPlan: {} }, { currentSubscriptionPlan: null }, { currentSubscriptionPlan: { userID: "x" } }]) expect(MeSubscriptionSchema.parse(raw), JSON.stringify(raw)).toEqual(none);
    expect(observeSubscription({ currentSubscriptionPlan: {} })).toMatchObject({ currentSubscriptionPlanKind: "empty-object", hasCurrentSubscriptionPlan: false });
    expect(observeSubscription({ currentSubscriptionPlan: null })).toMatchObject({ currentSubscriptionPlanKind: "null" });
    expect(observeSubscription({})).toMatchObject({ currentSubscriptionPlanKind: "absent" });
    expect(observeSubscription({ currentSubscriptionPlan: { subscriptionPlanID: "x" } })).toMatchObject({ currentSubscriptionPlanKind: "object", hasCurrentSubscriptionPlan: true });
    expect(MeSubscriptionSchema.parse({ currentSubscriptionPlan: { subscriptionPlanID: "free" } }).hasActivePlan).toBe(true);
    const s = MeSubscriptionSchema.parse({ currentSubscriptionPlan: { subscriptionPlanID: "free", userID: "SHOULD_NOT_APPEAR", _id: "x", subscriptionDurationType: "monthly" } });
    expect(JSON.stringify(s)).not.toContain("SHOULD_NOT_APPEAR");
    expect(s).toMatchObject({ hasActivePlan: true, planId: "free" });
  });
  it("free credit: absent for teams is fine; non-numbers are rejected", () => {
    expect(MeFreeCreditSchema.parse({})).toEqual({ present: false, amount: null });
    expect(MeFreeCreditSchema.safeParse({ remainingFreeCredit: "12" }).success).toBe(false);
  });
  it("projectPlanCatalogue reports raw values and can never claim verification", () => {
    const p = projectPlanCatalogue(ME.plans.projects);
    expect(p).toMatchObject({ verified: false, unitsVerified: false, skipped: 2 });
    expect(p.plans.map((x) => x.id)).toEqual(["standard", "big"]);
    expect(p.plans[0]).toEqual({ id: "standard", available: true, region: "iran", ramAmount: 512, cpuAmount: 1, volume: 10, price: 0.5 });
    expect(JSON.stringify(p)).not.toContain(CANARY.token);
    const odd = projectPlanCatalogue({ a1: { RAM: { amount: "512" }, CPU: 5, price: Infinity, region: "x".repeat(99) } });
    expect(odd.plans[0]).toMatchObject({ ramAmount: null, cpuAmount: null, price: null, region: null });
  });
  it("observers do not echo values", () => {
    const j = JSON.stringify([observeMe(ME), observeSubscription({ currentSubscriptionPlan: { subscriptionPlanID: "free", userID: "u" } }), observeFreeCredit({ remainingFreeCredit: 99.5 })]);
    assertNoCanary(j);
    for (const leak of ["CANARY Person", "09120000000", "99.5", "u1"]) expect(j).not.toContain(leak);
  });
  it("fixture recording approves NOTHING for account endpoints", () => {
    for (const id of ["getMe", "getMeSubscription", "getMeFreeCredit"] as const) {
      expect(APPROVED_FIELDS[id]).toEqual({});
      expect(sanitizeForFixture(ME, APPROVED_FIELDS[id], { now: NOW, pseudo: new Pseudonymizer() })).toEqual({});
    }
  });
});
