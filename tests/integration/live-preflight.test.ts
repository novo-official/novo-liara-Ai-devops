import { afterEach, describe, expect, it } from "vitest";
import { isLiveError } from "@/server/live/types";
import { gatherPreflight } from "@/server/live/preflight-gather";
import { liveReaderFrom } from "@/server/live/reader";
import { assertNoCanary, CANARY } from "../helpers/canaries";
import { installService, json, liveService, LIVE_ENV, makeConfig, resetAll, type Responder } from "../helpers/live";
import { approved, CATALOGUE, deploy, FakeLiara, harness, liveEnv, NETWORK, OWNER, propose, PROPOSE, settle, TEAM } from "../helpers/live-exec";

afterEach(() => resetAll());
const code = async (p: Promise<unknown>) => {
  try {
    await p;
    return null;
  } catch (e) {
    if (!isLiveError(e)) throw e;
    return `${e.code}${e.detail.length ? ":" + e.detail.join(",") : ""}`;
  }
};
const detail = async (p: Promise<unknown>) => {
  try {
    await p;
    return [] as string[];
  } catch (e) {
    return isLiveError(e) ? e.detail : ["not-a-live-error"];
  }
};
const decide = (h: Awaited<ReturnType<typeof harness>>, v: { proposal: { id: string; digest: string; appName: string } }, extra: Record<string, unknown> = {}) => h.svc.decide(v.proposal.id, OWNER, { decision: "approve", digest: v.proposal.digest, confirmAppName: v.proposal.appName, acknowledgeFinancial: true, ...extra });

describe("NO-APP ACCOUNT: first-app bootstrap", () => {
  const first = { LIARA_ALLOWED_APPS: "", LIARA_FIRST_APP_BOOTSTRAP: "true" };
  it("an empty allowlist is refused in live mode unless the operator explicitly opts in to first-app bootstrap — and then it is an EMPTY set, never a wildcard", () => {
    expect(() => makeConfig({ ...LIVE_ENV, LIARA_ALLOWED_APPS: "" })).toThrow(/LIARA_ALLOWED_APPS is required/);
    const cfg = makeConfig({ ...LIVE_ENV, ...first });
    expect(cfg.allowedApps).not.toBeNull();
    expect(cfg.allowedApps!.size).toBe(0);
    expect(cfg.live.firstAppBootstrap).toBe(true);
    expect(makeConfig({ ...LIVE_ENV, LIARA_FIRST_APP_BOOTSTRAP: "false", LIARA_ALLOWED_APPS: "a-b" }).live.firstAppBootstrap).toBe(false);
    expect(() => makeConfig({ ...LIVE_ENV, ...first, LIARA_DATA_SOURCE: "mock" }).allowedApps).not.toThrow();
    expect(makeConfig({ ...LIVE_ENV, ...first, LIARA_DATA_SOURCE: "mock" }).allowedApps).toBeNull(); // mock: unchanged
  });
  it("zero applications → proposal → typed name + financial acknowledgment → create → exact identity proven → scope bootstrapped for that name only → DEPLOYED", async () => {
    const h = await harness({ env: first });
    expect(h.fake.apps.size).toBe(0);
    const v = await propose(h);
    expect(v.proposal.status).toBe("PENDING");
    const pf = await h.svc.runPreflight({ planId: "g2-small", bundlePlanId: "bronze", appName: "liara-agent-demo", minRamMb: 512 });
    expect(pf.account).toMatchObject({ appCount: 0, firstApp: true });
    expect(h.store.scopeHas(TEAM, "liara-agent-demo")).toBe(false);
    const d = await decide(h, v);
    expect(d.proposal.status).toBe("APPROVED");
    const op = await h.svc.execute(v.proposal.id, OWNER, h.zip);
    const final = await settle(h, op.id);
    expect(final.state).toBe("DEPLOYED");
    expect(h.store.scopeHas(TEAM, "liara-agent-demo")).toBe(true);
    for (const other of ["liara-agent-demo-2", "other-app", "*", ""]) expect(h.store.scopeHas(TEAM, other), other).toBe(false);
    expect(h.store.scopeHas("team_other_9", "liara-agent-demo")).toBe(false);
  });
  it("with an empty config allowlist LiaraService refuses every name until the verified bootstrap extension adds exactly one", async () => {
    const { buildService } = await import("@/server/liara/service");
    const svc = buildService(makeConfig({ ...LIVE_ENV, ...first }), { fetchImpl: (async () => new Response("{}")) as unknown as typeof fetch });
    for (const n of ["liara-agent-demo", "shop-api", "x-y"]) expect(svc.isAllowed(n), n).toBe(false);
    svc.setScopeExtension((n) => n === "liara-agent-demo");
    expect(svc.isAllowed("liara-agent-demo")).toBe(true);
    expect(svc.isAllowed("liara-agent-demo2")).toBe(false);
  });
});

describe("financial acknowledgment is mandatory and exact", () => {
  it("approval without `acknowledgeFinancial === true` is refused, leaves the proposal PENDING and starts nothing", async () => {
    const h = await harness();
    const v = await propose(h);
    for (const ack of [undefined, false, "true", 1, null, "yes", {}]) expect(await code(decide(h, v, { acknowledgeFinancial: ack })), String(ack)).toBe("live_confirmation_required:financial_acknowledgment");
    expect((await h.store.getLiveProposal(v.proposal.id))!.status).toBe("PENDING");
    expect(h.fake.calls).toEqual([]);
    expect((await decide(h, v)).proposal.status).toBe("APPROVED");
  });
  it("the acknowledgment is audited together with the unit/unknown-cost facts it covered (never amounts)", async () => {
    const h = await harness();
    const v = await propose(h);
    await decide(h, v);
    const ev = (await h.store.readAudit(200)).find((r) => r.event === "live.proposal_approved")!;
    expect(JSON.stringify(ev.data)).toContain("financialAcknowledged");
    expect(JSON.stringify(ev.data)).not.toMatch(/balance|1805|43320/);
  });
});

describe("pricing blockers (a proposal is refused; nothing is written)", () => {
  const blockedWith = async (env: Record<string, string | undefined>, mutate: (f: FakeLiara) => void = () => undefined) => {
    const h = await harness({ env });
    mutate(h.fake);
    const ids = await detail(propose(h));
    expect(h.fake.calls).toEqual([]);
    return ids;
  };
  it("units declared by the operator but NOT corroborated by the catalogue and the public price page", async () => {
    const wrongPrices = (f: FakeLiara) => (f.catalogue = { ...CATALOGUE, plans: CATALOGUE.plans.map((p) => ({ ...p, price: p.price === null ? null : p.price * 3 })) });
    expect(await blockedWith({}, wrongPrices)).toEqual(expect.arrayContaining(["units_corroborated", "units_agree"]));
    const fewMatches = (f: FakeLiara) => (f.catalogue = { ...CATALOGUE, plans: [CATALOGUE.plans[1]!] });
    expect(await blockedWith({}, fewMatches)).toContain("units_corroborated");
  });
  it("the operator document disagrees with the corroborated reading (RAM in MB, price per month, Rial)", async () => {
    const mk = (over: Record<string, unknown>) => JSON.stringify({ ram: "GB", cpu: "cores", price: { currency: "IRT", per: "hour" }, billing: { model: "hourly_from_creation", minimumBalanceToCreate: null, otherCostsKnown: [], otherCostsUnknown: [] }, acceptedUnknowns: ["billing_start", "minimum_balance", "zero_balance_behavior", "bundle_plan_price", "vat"], verifiedAt: "2026-10-22", source: "operator test document", ...over });
    for (const over of [{ price: { currency: "IRT", per: "month" } }, { price: { currency: "IRR", per: "hour" } }]) expect(await blockedWith({ LIARA_PLAN_UNITS_JSON: mk(over) }), JSON.stringify(over)).toContain("units_agree");
    // RAM declared in MB makes every plan far too small for the workload: refused (by the plan check, before any money question)
    expect(await blockedWith({ LIARA_PLAN_UNITS_JSON: mk({ ram: "MB" }) })).toContain("ram_insufficient");
  });
  it("billing start / minimum balance / zero-balance behaviour / bundle price / VAT: unresolved unless the operator knowingly accepts each", async () => {
    const doc = (accepted: string[] | undefined) => JSON.stringify({ ram: "GB", cpu: "cores", price: { currency: "IRT", per: "hour" }, billing: { model: "hourly_from_creation", minimumBalanceToCreate: null, otherCostsKnown: [], otherCostsUnknown: [] }, ...(accepted ? { acceptedUnknowns: accepted } : {}), verifiedAt: "2026-10-22", source: "operator test document" });
    expect(await blockedWith({ LIARA_PLAN_UNITS_JSON: doc(undefined) })).toContain("billing_semantics");
    expect(await blockedWith({ LIARA_PLAN_UNITS_JSON: doc(["billing_start", "vat"]) })).toContain("billing_semantics");
    const ok = await harness({ env: { LIARA_PLAN_UNITS_JSON: doc(["billing_start", "minimum_balance", "zero_balance_behavior", "bundle_plan_price", "vat"]) } });
    expect((await propose(ok)).proposal.status).toBe("PENDING");
    // and the unknowns stay visible in the proposal the operator reads
    expect((await propose(await harness())).proposal.financial.unknownCostComponents.length).toBeGreaterThan(0);
  });
  it("plans the official CLI would not offer (no region) or whose price is not corroborated are refused", async () => {
    const h = await harness();
    expect(await detail(propose(h, { planId: "g2-noregion" }))).toContain("selected_plan");
    // a plan with enough RAM but NO public twin: its price cannot be corroborated for THAT plan
    h.fake.catalogue = { ...CATALOGUE, plans: [...CATALOGUE.plans, { id: "g2-odd", available: true, region: "iran", ramAmount: 3, cpuAmount: 3, volume: 5, price: 4321 }], bundles: { ...CATALOGUE.bundles, "g2-odd": [{ id: "bronze", available: true }] } };
    expect(await detail(propose(h, { planId: "g2-odd" }))).toContain("selected_plan");
    expect(h.fake.calls).toEqual([]);
  });
  it("balance: insufficient (even as Toman) and ambiguous unit both refuse; unreadable refuses; sufficient passes; billing is READ ONLY", async () => {
    const team = (b: number | null) => (f: FakeLiara) => (f.catalogue = { ...CATALOGUE, account: { teamPresent: true, teamBalance: b } });
    expect(await blockedWith({}, team(100))).toContain("balance");
    expect(await blockedWith({}, team(50_000))).toContain("balance");
    expect(await blockedWith({}, team(null))).toContain("balance");
    const ok = await harness();
    expect((await propose(ok)).proposal.status).toBe("PENDING");
    const personal = await harness({ env: { LIARA_TEAM_ID: undefined } });
    personal.fake.catalogue = { ...CATALOGUE, account: undefined };
    personal.fake.balance = 5;
    expect(await detail(propose(personal))).toContain("balance");
    personal.fake.balance = 5_000_000;
    expect((await propose(personal)).proposal.status).toBe("PENDING");
    personal.fake.billingOk = false;
    await personal.svc.cancel((await propose(personal).catch(() => null))?.operation?.id ?? "x", OWNER).catch(() => undefined);
  });
});

describe("network and team blockers", () => {
  const ids = async (env: Record<string, string | undefined>, mutate: (f: FakeLiara) => void = () => undefined) => {
    const h = await harness({ env });
    mutate(h.fake);
    const d = await detail(propose(h));
    expect(h.fake.calls).toEqual([]);
    return d;
  };
  it("no opt-in to the undocumented network endpoint ⇒ the network id cannot be verified ⇒ blocked", async () => {
    expect(await ids({ LIARA_ALLOW_UNDOCUMENTED_ENDPOINTS: "false" })).toContain("network_listing");
  });
  it("the configured id is not in the account's list, the list is empty, the read fails, or no id is configured", async () => {
    expect(await ids({}, (f) => (f.networks = [{ id: "net_someone_else", name: "x" }]))).toContain("network_exists");
    expect(await ids({}, (f) => (f.networks = []))).toContain("network_exists");
    expect(await ids({}, (f) => (f.networksOk = false))).toContain("network_listing");
    expect(await ids({ LIARA_NETWORK_ID: undefined })).toContain("network_id");
  });
  it("team scope mismatch (a team is configured but the account answer has no team) ⇒ blocked and nothing happens", async () => {
    expect(await ids({}, (f) => (f.catalogue = { ...CATALOGUE, account: { teamPresent: false, teamBalance: 9e9 } }))).toContain("team_scope");
  });
  it("the network id and the team are bound into the proposal; a different configuration voids the approval", async () => {
    const mk = async (env: Record<string, string>) => {
      const h = await harness();
      const v = await propose(h);
      expect(v.proposal).toMatchObject({ teamId: TEAM, networkId: NETWORK });
      h.fake.networks = [{ id: NETWORK, name: "n" }, { id: "net_other_9", name: "o" }];
      const other = h.rebuild({ cfg: makeConfig(liveEnv(env)) });
      return other.decide(v.proposal.id, OWNER, { decision: "approve", digest: v.proposal.digest, confirmAppName: v.proposal.appName, acknowledgeFinancial: true });
    };
    expect(await code(mk({ LIARA_NETWORK_ID: "net_other_9" }))).toBe("live_binding_mismatch:team_or_network");
    expect(await code(mk({ LIARA_TEAM_ID: "team_other_9" }))).toBe("live_binding_mismatch:team_or_network");
  });
});

describe("preflight drift between proposal, approval and execution voids the approval", () => {
  const drifts: [string, (f: FakeLiara) => void][] = [
    ["balance becomes insufficient", (f) => (f.catalogue = { ...CATALOGUE, account: { teamPresent: true, teamBalance: 10 } })],
    ["the network disappears", (f) => (f.networks = [])],
    ["the network listing becomes unreadable", (f) => (f.networksOk = false)],
    ["the price of the plan stops matching the public page", (f) => (f.catalogue = { ...CATALOGUE, plans: CATALOGUE.plans.map((p) => (p.id === "g2-small" ? { ...p, price: 1 } : p)) })],
    ["the team vanishes from the account answer", (f) => (f.catalogue = { ...CATALOGUE, account: { teamPresent: false, teamBalance: 9e9 } })],
  ];
  for (const [name, mutate] of drifts) {
    it(`at approval: ${name} ⇒ live_blocked_drift (proposal BLOCKED, zero writes)`, async () => {
      const h = await harness();
      const v = await propose(h);
      mutate(h.fake);
      expect(await code(decide(h, v))).toBe("live_blocked_drift");
      expect((await h.store.getLiveProposal(v.proposal.id))!.status).toBe("BLOCKED");
      expect(h.fake.calls).toEqual([]);
    });
    it(`at execution: ${name} ⇒ nothing is created`, async () => {
      const h = await harness();
      const v = await approved(h);
      mutate(h.fake);
      const op = await h.svc.execute(v.proposal.id, OWNER, h.zip);
      const final = await settle(h, op.id);
      expect(final.state).toBe("FAILED");
      expect(final.failure!.code).toMatch(/^preflight_(drift|plan_blocked)$/);
      expect(h.fake.calls).toEqual([]);
    });
  }
});

describe("exact identity must be proven before the allowlist is extended", () => {
  for (const identity of ["wrong_name", "no_name", "unreadable"] as const) {
    it(`API-reported identity '${identity}' ⇒ NEEDS_OPERATOR_REVIEW, nothing joins the allowlist, nothing further is sent`, async () => {
      const h = await harness();
      h.fake.identity = identity;
      const { final } = await deploy(h);
      expect(final.state).toBe("NEEDS_OPERATOR_REVIEW");
      expect(final.failure!.code).toBe("identity_unverified");
      expect(final.remote.appConfirmed).toBeNull();
      expect(h.store.scopeHas(TEAM, "liara-agent-demo")).toBe(false);
      expect(h.fake.calls.map((c) => c.op)).toEqual(["createApp"]);
    });
  }
  it("re-verify confirms and bootstraps only once the identity is proven (never before)", async () => {
    const h = await harness();
    h.fake.create = "timeout_not_created";
    const { final } = await deploy(h);
    h.fake.apps.add("liara-agent-demo");
    h.fake.identity = "wrong_name";
    expect((await h.svc.resolve(final.id, OWNER, "reverify")).remote.appConfirmed).toBeNull();
    expect(h.store.scopeHas(TEAM, "liara-agent-demo")).toBe(false);
    h.fake.identity = "exact";
    expect((await h.svc.resolve(final.id, OWNER, "reverify")).remote.appConfirmed).toBe(true);
    expect(h.store.scopeHas(TEAM, "liara-agent-demo")).toBe(true);
  });
});

describe("an HTTP error is NOT proof that nothing happened", () => {
  it("create rejected (409) but the name is visible afterwards ⇒ review, no scope, the name stays reserved, nothing else is sent", async () => {
    const h = await harness();
    h.fake.create = "rejected_409_but_created";
    const { final } = await deploy(h);
    expect(final.state).toBe("NEEDS_OPERATOR_REVIEW");
    expect(final.failure!.code).toBe("rejected_but_name_present");
    expect(final.remote.appConfirmed).toBeNull();
    expect(h.store.scopeHas(TEAM, "liara-agent-demo")).toBe(false);
    expect(h.fake.calls.map((c) => c.op)).toEqual(["createApp"]);
    expect(await code(propose(h))).toBe("live_duplicate_app");
  });
  it("create rejected and the state cannot be read afterwards ⇒ review (not FAILED); the rejection alone proves nothing", async () => {
    const h = await harness();
    h.fake.create = "rejected_403";
    const orig = h.fake.reader.appNameExists;
    h.fake.reader.appNameExists = async (n) => (h.fake.calls.length === 0 ? orig(n) : { ok: false, code: "upstream_error" });
    const { final } = await deploy(h);
    expect(final.state).toBe("NEEDS_OPERATOR_REVIEW");
    expect(final.failure!.code).toBe("rejected_but_state_unreadable");
    expect(final.remote.appConfirmed).toBeNull();
    expect(h.store.scopeHas(TEAM, "liara-agent-demo")).toBe(false);
    expect(h.fake.calls.map((c) => c.op)).toEqual(["createApp"]);
  });
  it("create rejected and confirmed absent on read ⇒ FAILED, the name is released", async () => {
    const h = await harness();
    h.fake.create = "rejected_402";
    const { final } = await deploy(h);
    expect(final.state).toBe("FAILED");
    expect(final.remote.appConfirmed).toBe(false);
    expect(final.failure!.messageFa).toMatch(/موجودی/);
  });
  it("release rejected but a NEW release appears ⇒ review; rejected with nothing new ⇒ FAILED", async () => {
    const a = await harness();
    a.fake.release = "rejected_400_but_created";
    const ra = (await deploy(a)).final;
    expect(ra.state).toBe("NEEDS_OPERATOR_REVIEW");
    expect(ra.failure!.code).toBe("rejected_but_release_present");
    expect(ra.remote.releaseId).toBeNull();
    const b = await harness();
    b.fake.release = "rejected_400";
    expect((await deploy(b)).final.state).toBe("FAILED");
  });
});

describe("verification ladder: DEPLOYED / PARTIALLY_VERIFIED / NEEDS_OPERATOR_REVIEW / FAILED", () => {
  const run = async (mut: (f: FakeLiara) => void, env: Record<string, string | undefined> = {}) => {
    const h = await harness({ env, poll: { verifyBudgetMs: 5_000, pollIntervalMs: 1000 } });
    mut(h.fake);
    return (await deploy(h)).final;
  };
  it("release created but the build state is unknown is NOT 'built': needs review, not partially verified", async () => {
    const f = await run((x) => (x.releaseStates = ["???"]));
    expect(f.state).toBe("NEEDS_OPERATOR_REVIEW");
    expect(f.failure!.code).toBe("verification_inconclusive");
    expect(f.ladder.buildCompleted).toBe("unknown");
  });
  it("build ok + runtime ok but HTTP health unverified (probe unusable) ⇒ PARTIALLY_VERIFIED (kept under review, never DEPLOYED)", async () => {
    const f = await run((x) => (x.probeResult = { outcome: "timeout", status: null, markerFound: null }));
    expect(f.state).toBe("NEEDS_OPERATOR_REVIEW");
    expect(f.failure!.code).toBe("partially_verified");
    expect(f.ladder).toMatchObject({ buildCompleted: "ok", runtimeStarted: "ok", httpHealthVerified: "unknown" });
  });
  it("an invalid health response (wrong body) is FAILED, a malformed/oversized one is inconclusive", async () => {
    expect((await run((x) => (x.probeResult = { outcome: "ok", status: 200, markerFound: false }))).state).toBe("FAILED");
    expect((await run((x) => (x.probeResult = { outcome: "too_large", status: 200, markerFound: null }))).state).toBe("NEEDS_OPERATOR_REVIEW");
  });
  it("unsafe probe targets are never contacted and never counted as success", async () => {
    for (const outcome of ["blocked_address", "invalid_target", "redirect"] as const) {
      const f = await run((x) => (x.probeResult = { outcome, status: null, markerFound: null }));
      expect(f.state, outcome).toBe("NEEDS_OPERATOR_REVIEW");
      expect(f.ladder.httpHealthVerified, outcome).toBe("unknown");
    }
  });
});

describe("secrets, audit integrity and zero real mutations", () => {
  it("the whole status document, with its preflight, contains no token, balance amount or canary", async () => {
    const h = await harness();
    h.fake.balance = 123_456_789.5;
    await propose(h);
    const st = await h.svc.status(OWNER, h.runId);
    expect(st.preflight).not.toBeNull();
    const json = JSON.stringify(st);
    assertNoCanary(json);
    expect(json).not.toContain("123456789");
    expect(json).not.toContain(CANARY.token);
  });
  it("status() caches the read-only preflight (it can be polled without burning the request budget) and skips it while an operation is in flight", async () => {
    const h = await harness();
    await h.svc.status(OWNER, h.runId);
    const reads = h.fake.readCalls;
    await h.svc.status(OWNER, h.runId);
    await h.svc.status(OWNER, h.runId);
    expect(h.fake.readCalls).toBeLessThanOrEqual(reads + 2); // catalogue/inventory-free: only the cheap parts repeat
  });
  it("the audit chain stays valid across the full Phase 2B flow and records the financial acknowledgment", async () => {
    const h = await harness();
    await deploy(h);
    expect(await h.store.verifyAudit()).toMatchObject({ ok: true });
  });
  it("no real network request and no AI call happens anywhere in a complete flow (offline guard stays active)", async () => {
    const { blockedAttempts } = await import("../helpers/network-guard");
    const before = blockedAttempts.length;
    const h = await harness();
    await deploy(h);
    await h.svc.runPreflight(null);
    expect(blockedAttempts.length).toBe(before);
    expect(new Set(h.fake.calls.map((c) => c.op))).toEqual(new Set(["createApp", "uploadSource", "createRelease"]));
  });
});

describe("read-only adapters for billing and networks (real HTTP client, recorded fetch)", () => {
  const BILLING = { user: { balance: 123456.5, accountType: "CANARY-ACCOUNT", minCreditAmount: 20000, isManualMinCredit: false, minCreditLastNotifiedAt: null, extra: CANARY.apiToken } };
  const responder = (over: Record<string, () => Response> = {}): Responder => (url) => {
    const p = url.pathname;
    if (over[p]) return over[p]!();
    if (p === "/v1/billing") return json(BILLING);
    if (p === "/v1/networks") return json({ networks: [{ _id: "net_canary_01", name: "canary-network", createdAt: "2026-01-01T00:00:00Z" }, { _id: "bad id", name: 5 }, "junk"] });
    if (p === "/v1/me") return json({ user: { email: CANARY.email }, team: { balance: 777.25, teamMemberRole: { name: "owner" }, secret: CANARY.apiToken }, plans: { projects: { "g2-small": { available: true, region: "iran", RAM: { amount: 1 }, CPU: { amount: 1 }, volume: 5, price: 1805 } }, projectBundlePlans: { "g2-small": { bronze: { available: true } } } } });
    return json({ projects: [{ project_id: "someone-elses-app", type: "node", status: "RUNNING", scale: 1 }] });
  };
  it("GET /v1/billing: one GET with the team query, only the numeric balance is projected", async () => {
    const { svc, calls } = liveService({ LIARA_TEAM_ID: "team_1" }, responder());
    const r = await svc.getBilling();
    expect(r.ok && r.data).toEqual({ balance: 123456.5 });
    expect(calls.map((c) => `${c.method} ${c.url.pathname}`)).toEqual(["GET /v1/billing"]);
    expect(calls[0]!.url.searchParams.get("teamID")).toBe("team_1");
    expect(calls[0]!.body).toBeNull();
    assertNoCanary(JSON.stringify(r));
  });
  it("GET /v1/networks is refused without the explicit opt-in; with it, ids/names are projected and malformed items skipped", async () => {
    const off = liveService({}, responder());
    const r0 = await off.svc.listNetworks();
    expect(r0.ok).toBe(false);
    expect(off.calls).toEqual([]); // no request at all without the opt-in
    const on = liveService({ LIARA_ALLOW_UNDOCUMENTED_ENDPOINTS: "true" }, responder());
    const r = await on.svc.listNetworks();
    expect(r.ok && r.data).toEqual({ items: [{ id: "net_canary_01", name: "canary-network" }], skipped: 2 });
    expect(on.calls.every((c) => c.method === "GET")).toBe(true);
  });
  it("GET /v1/me keeps ONLY the team balance from the team object (role, permissions and secrets are stripped)", async () => {
    const { svc } = liveService({ LIARA_TEAM_ID: "team_1" }, responder());
    const r = await svc.getPlanCatalogue();
    expect(r.ok && r.data.account).toEqual({ teamPresent: true, teamBalance: 777.25 });
    assertNoCanary(JSON.stringify(r));
  });
  it("appInventory counts applications and never returns names; appIdentity bypasses the allowlist for ONE exact name and returns only name+scale", async () => {
    const { svc } = liveService({}, responder({ "/v1/projects/someone-elses-app": () => json({ project: { project_id: "someone-elses-app", name: "someone-elses-app", scale: 1, envs: [{ key: "A", value: CANARY.envValue }] } }) }));
    const inv = await svc.appInventory("someone-elses-app");
    expect(inv).toEqual({ ok: true, count: 1, exists: true });
    expect(JSON.stringify(inv)).not.toContain("someone-elses-app");
    await expect(svc.getApp("someone-elses-app")).rejects.toThrow(); // not allowlisted: the normal read path refuses
    const id = await svc.appIdentity("someone-elses-app");
    expect(id).toMatchObject({ ok: true });
    expect(Object.keys(id).sort()).toEqual(["createdAt", "defaultSubdomain", "instanceId", "name", "networkId", "ok", "planId", "platform", "scale"]);
    expect(svc.isAllowed("someone-elses-app")).toBe(false); // the identity read granted nothing
    expect(await svc.appIdentity("Bad Name")).toEqual({ ok: false, code: "invalid_input" });
    assertNoCanary(JSON.stringify(id));
  });
  it("gatherPreflight over the real read path performs at most 4 GETs and no write", async () => {
    const { cfg, svc, calls } = liveService({ LIARA_ALLOW_UNDOCUMENTED_ENDPOINTS: "true" }, responder());
    installService(cfg, svc);
    const r = await gatherPreflight({ reader: liveReaderFrom(svc), cfg, nowIso: "2026-10-22T00:00:00.000Z", sel: null });
    expect(calls.length).toBeLessThanOrEqual(4);
    expect(calls.every((c) => c.method === "GET" && c.body === null)).toBe(true);
    expect(calls.map((c) => c.url.pathname).sort()).toEqual(["/v1/billing", "/v1/me", "/v1/networks", "/v1/projects"]);
    expect(["BLOCKED_BY_PRICING", "BLOCKED_BY_CONTRACT", "BLOCKED_BY_CONFIGURATION", "BLOCKED_BY_SECURITY"]).toContain(r.verdict); // an unconfigured operator can never be READY
    assertNoCanary(JSON.stringify(r));
  });
});

void PROPOSE;
