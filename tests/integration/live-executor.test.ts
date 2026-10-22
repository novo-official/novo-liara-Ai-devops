import { describe, expect, it } from "vitest";
import { buildDeploymentArtifact } from "@/server/live/artifact";
import { assertStepAuthorized, contentOfLive, liveDigest } from "@/server/live/authorize";
import { MemoryLiveStore } from "@/server/live/store";
import { isLiveError, LIVE_NEXT, LIVE_STATES } from "@/server/live/types";
import { assertNoCanary, CANARY } from "../helpers/canaries";
import { approved, deploy, demoZip, FakeLiara, harness, liveEnv, NETWORK, OTHER, OWNER, propose, PROPOSE, settle, TEAM, UNITS } from "../helpers/live-exec";

const code = async (p: Promise<unknown>) => {
  try {
    await p;
    return null;
  } catch (e) {
    if (!isLiveError(e)) throw e;
    return e.code;
  }
};
const states = (op: { transitions: { to: string }[] }) => op.transitions.map((t) => t.to);

describe("DISABLED BY DEFAULT: a flag alone, or its absence, never allows a write", () => {
  it("with the default configuration no write transport exists and every live operation fails closed", async () => {
    const h = await harness({ env: { LIARA_LIVE_DEPLOY_ENABLED: "false" }, noTransport: true });
    expect(h.svc.executor).toBeNull();
    expect(h.svc.gate().enabled).toBe(false);
    expect(await code(propose(h))).toBe("live_execution_disabled");
    expect(await code(h.svc.decide("lprop_20260102040000_aabbccdd", OWNER, { decision: "approve", digest: "a".repeat(64) }))).toBe("live_not_found");
    expect(await code(h.svc.execute("lprop_20260102040000_aabbccdd", OWNER, h.zip))).toBe("live_execution_disabled");
    expect(h.fake.calls).toEqual([]);
    const st = await h.svc.status(OWNER, h.runId);
    expect(st.uiState).toBe("BLOCKED");
    expect(st.prerequisites.find((p) => p.id === "live_flag")!.ok).toBe(false);
  });
  it("the flag without a transport, or a transport without the flag, is still disabled", async () => {
    expect((await harness({ noTransport: true })).svc.gate().enabled).toBe(false);
    expect((await harness({ env: { LIARA_LIVE_DEPLOY_ENABLED: "false" } })).svc.gate().enabled).toBe(false);
  });
  it("the flag alone is NOT enough: each remaining prerequisite independently blocks a proposal", async () => {
    const cases: [Record<string, string | undefined>, string][] = [
      [{ LIARA_LIVE_CONTRACT_ATTESTED: "false" }, "contract_attested"],
      [{ LIARA_PLAN_UNITS_JSON: undefined }, "plan_units_verified"],
      [{ LIARA_NETWORK_ID: undefined }, "network_id"],
      [{ LIARA_APP_DOMAIN_SUFFIXES: undefined }, "app_domain_suffix"],
    ];
    for (const [env, missing] of cases) {
      const h = await harness({ env });
      const e = await propose(h).catch((x) => x);
      expect(isLiveError(e) && e.code, missing).toBe("live_prerequisite_missing");
      expect(e.detail).toContain(missing);
      expect(h.fake.calls).toEqual([]);
    }
  });
  it("live mode cannot be enabled with mock data (configuration refuses the mix)", async () => {
    const { makeConfig, LIVE_ENV } = await import("../helpers/live");
    expect(() => makeConfig({ ...LIVE_ENV, ...liveEnv(), LIARA_DATA_SOURCE: "mock" })).toThrow(/requires LIARA_DATA_SOURCE=live/);
  });
  it("a missing token or invalid operator documents are configuration errors (fail closed)", async () => {
    const { makeConfig } = await import("../helpers/live");
    expect(() => makeConfig(liveEnv({ LIARA_API_TOKEN: "" }))).toThrow();
    expect(() => makeConfig(liveEnv({ LIARA_PLAN_UNITS_JSON: "{bad" }))).toThrow(/LIARA_PLAN_UNITS_JSON/);
    expect(() => makeConfig(liveEnv({ LIARA_APP_DOMAIN_SUFFIXES: "bad_suffix!" }))).toThrow(/LIARA_APP_DOMAIN_SUFFIXES/);
    expect(() => makeConfig(liveEnv({ LIARA_NETWORK_ID: "x y" }))).toThrow(/LIARA_NETWORK_ID/);
    expect(() => makeConfig(liveEnv({ LIARA_LIVE_HEALTH_PATH: "/a/../b" }))).toThrow(/LIARA_LIVE_HEALTH_PATH/);
  });
  it("the defaults of the real configuration are all OFF", async () => {
    const { makeConfig } = await import("../helpers/live");
    const c = makeConfig();
    expect(c.live).toEqual({ enabled: false, planUnits: null, appDomainSuffixes: [], contractAttested: false, networkId: null, healthPath: "/health", healthMarker: null, firstAppBootstrap: false });
    const { createLiveWriteClient } = await import("@/server/live/write-client");
    expect(createLiveWriteClient(c)).toBeNull();
    expect(createLiveWriteClient(makeConfig(liveEnv({ LIARA_LIVE_DEPLOY_ENABLED: "false" })))).toBeNull();
    expect(createLiveWriteClient(makeConfig(liveEnv()))).not.toBeNull(); // constructed only when explicitly configured (still unusable without an approval)
  });
});

describe("the happy path (recording fake transport)", () => {
  it("proposal → typed approval → single execution → verified DEPLOYED, with exactly three writes derived from the approved proposal", async () => {
    const h = await harness();
    const v = await propose(h);
    const p = v.proposal;
    expect(p).toMatchObject({ status: "PENDING", executionMode: "live", environment: "live", confirmation: "type_app_name", teamId: TEAM, networkId: NETWORK, appName: "liara-agent-demo", planId: "g2-small", bundlePlanId: "bronze", platform: "next", envKeys: [] });
    expect(p.artifact.zipSha256).toMatch(/^[0-9a-f]{64}$/);
    expect(p.artifact.analysisDigest).toMatch(/^[0-9a-f]{64}$/);
    expect(p.artifact.artifactDigest).toMatch(/^[0-9a-f]{64}$/);
    expect(Date.parse(p.expiresAt) - Date.parse(p.createdAt)).toBe(10 * 60_000);
    expect(p.financial).toMatchObject({ unitsVerified: true, planId: "g2-small" });
    expect(p.financial.estimate).toMatchObject({ currency: "IRT" });
    expect(v.operation!.state).toBe("AWAITING_LIVE_APPROVAL");
    expect(h.fake.calls).toEqual([]); // proposing writes nothing

    const d = await h.svc.decide(p.id, OWNER, { decision: "approve", digest: p.digest, confirmAppName: p.appName, acknowledgeFinancial: true });
    expect(d.proposal.status).toBe("APPROVED");
    expect(d.approvals).toEqual([expect.objectContaining({ outcome: "accepted", scope: "live", operationId: p.operationId })]);
    expect(h.fake.calls).toEqual([]); // approving writes nothing either

    const op = await h.svc.execute(p.id, OWNER, h.zip);
    expect(op.state).toBe("APPROVED");
    const final = await settle(h, op.id);
    expect(final.state).toBe("DEPLOYED");
    expect(final.failure).toBeNull();
    expect(Object.values(final.ladder)).toEqual(["ok", "ok", "ok", "ok", "ok", "ok"]);
    expect(states(final)).toEqual(["PREFLIGHT", "AWAITING_LIVE_APPROVAL", "APPROVED", "CREATING_APPLICATION", "APPLICATION_CREATED", "UPLOADING_SOURCE", "SOURCE_UPLOADED", "CREATING_RELEASE", "RELEASE_CREATED", "VERIFYING_DEPLOYMENT", "DEPLOYED"]);
    expect(final.steps.map((s) => s.status)).toEqual(["done", "done", "done", "done"]);

    expect(h.fake.calls.map((c) => c.op)).toEqual(["createApp", "uploadSource", "createRelease"]);
    expect(h.fake.calls[0]!.body).toEqual({ name: "liara-agent-demo", planID: "g2-small", platform: "next", bundlePlanID: "bronze", network: NETWORK });
    expect(h.fake.calls[2]!.body).toEqual({ sourceID: "src_0001_demo", port: 3000, type: "next", platformConfig: {}, build: { cache: true }, gitInfo: { branch: null, message: null, commit: null, committedAt: null, remote: null, author: { email: null, name: null }, tags: [] } });
    const art = await buildDeploymentArtifact(h.zip);
    expect(h.fake.calls[1]!.bytes).toBe(art.size); // the approved artifact, byte for byte
    expect((await h.store.getLiveProposal(p.id))!.status).toBe("CONSUMED");
    expect((await h.store.listLiveApprovals(p.id)).filter((a) => a.outcome === "accepted")).toHaveLength(1);
    const audit = (await h.store.readAudit(500)).map((r) => r.event);
    for (const e of ["live.proposal_created", "live.proposal_approved", "live.execution_claimed", "live.create_application_attempt", "live.upload_attempt", "live.release_attempt", "live.operation_deployed", "live.scope_bootstrap"]) expect(audit).toContain(e);
    expect(await h.store.verifyAudit()).toMatchObject({ ok: true });
  });
  it("every state transition of the operation is a documented edge of the state machine", async () => {
    const h = await harness();
    const { final } = await deploy(h);
    for (const t of final.transitions) if (t.from) expect(LIVE_NEXT[t.from], `${t.from}->${t.to}`).toContain(t.to);
    expect(LIVE_STATES).toContain("NEEDS_OPERATOR_REVIEW");
    expect(LIVE_NEXT.DEPLOYED).toEqual([]);
    expect(LIVE_NEXT.FAILED).toEqual([]);
    expect(LIVE_NEXT.CANCELLED).toEqual([]);
  });
  it("secrets never reach records, audit, errors or the fake's view: the token canary is nowhere", async () => {
    const h = await harness();
    const { v, final } = await deploy(h);
    assertNoCanary(JSON.stringify([v, final, await h.store.readAudit(500), await h.svc.status(OWNER, h.runId), h.fake.calls]));
    expect(JSON.stringify(final)).not.toContain(OWNER);
  });
});

describe("exact-target approval binding", () => {
  it("any modification of the stored proposal is detected and blocks approval (nothing executes)", async () => {
    const patches: Record<string, unknown>[] = [
      { appName: "other-name" }, { planId: "g2-big" }, { bundlePlanId: "silver" }, { teamId: "team_other_9" }, { networkId: "net_other_9" }, { platform: "static" },
      { envKeys: ["API_KEY"] }, { expiresAt: "2099-01-01T00:00:00.000Z" }, { config: { port: 9999, output: "server", nodeRange: null, buildInvocation: null, startInvocation: null } },
      { artifact: { zipSha256: "0".repeat(64), analysisDigest: "1".repeat(64), artifactDigest: "2".repeat(64), artifactBytes: 5, fileCount: 1, format: "x" } },
      { financial: { unitsVerified: true, planId: "g2-small", resource: { ramAmount: 1, cpuAmount: 1, volume: 1, price: 1, ramUnit: "GB", cpuUnit: "cores", priceUnit: "IRT/hour" }, estimate: null, requiredBalance: 0, knownOtherCosts: [], unknownCostComponents: [] } },
    ];
    for (const patch of patches) {
      const store = new MemoryLiveStore();
      const h = await harness({ store });
      const v = await propose(h);
      store.__tamperLiveProposal(v.proposal.id, patch);
      const c = await code(h.svc.decide(v.proposal.id, OWNER, { decision: "approve", digest: v.proposal.digest, confirmAppName: v.proposal.appName, acknowledgeFinancial: true }));
      expect(["live_tampered", "live_not_found"], JSON.stringify(Object.keys(patch))).toContain(c ?? "none");
      expect(h.fake.calls).toEqual([]);
    }
  });
  it("a tampered row cannot even be loaded: the store validates strictly on read", async () => {
    const store = new MemoryLiveStore();
    const h = await harness({ store });
    const v = await propose(h);
    store.__tamperLiveProposal(v.proposal.id, { executionMode: "simulation" });
    await expect(store.getLiveProposal(v.proposal.id)).rejects.toThrow();
    store.__tamperLiveProposal(v.proposal.id, { executionMode: "live", extra: "x" });
    await expect(store.getLiveProposal(v.proposal.id)).rejects.toThrow();
  });
  it("wrong, malformed or stale digests are refused and leave the proposal pending", async () => {
    const h = await harness();
    const v = await propose(h);
    const good = v.proposal.digest;
    for (const digest of ["0".repeat(64), good.slice(0, 63) + (good.endsWith("0") ? "1" : "0"), good.toUpperCase().replace(/[0-9]/g, "a"), "", null, 7, {}, good + "0"]) expect(await code(h.svc.decide(v.proposal.id, OWNER, { decision: "approve", digest, confirmAppName: PROPOSE.appName, acknowledgeFinancial: true })), String(digest)).toBe("live_digest_mismatch");
    expect((await h.store.getLiveProposal(v.proposal.id))!.status).toBe("PENDING");
  });
  it("the typed application name is mandatory and exact", async () => {
    const h = await harness();
    const v = await propose(h);
    for (const typed of [undefined, "", "liara-agent-dem", "LIARA-AGENT-DEMO", " liara-agent-demo", "liara-agent-demo ", 5, null]) expect(await code(h.svc.decide(v.proposal.id, OWNER, { decision: "approve", digest: v.proposal.digest, confirmAppName: typed, acknowledgeFinancial: true })), String(typed)).toBe("live_confirmation_required");
    expect((await h.store.getLiveProposal(v.proposal.id))!.status).toBe("PENDING");
  });
  it("invalid decisions are refused (no 'approved' flag exists)", async () => {
    const h = await harness();
    const v = await propose(h);
    for (const decision of [true, "approved", "APPROVE", "yes", 1, null, undefined, {}]) expect(await code(h.svc.decide(v.proposal.id, OWNER, { decision, digest: v.proposal.digest, confirmAppName: PROPOSE.appName, acknowledgeFinancial: true })), String(decision)).toBe("live_binding_mismatch");
  });
  it("only the owning session can decide, execute or read; others get 'not found'", async () => {
    const h = await harness();
    const v = await propose(h);
    expect(await code(h.svc.decide(v.proposal.id, OTHER, { decision: "approve", digest: v.proposal.digest, confirmAppName: PROPOSE.appName, acknowledgeFinancial: true }))).toBe("live_not_found");
    expect(await code(h.svc.getProposalView(v.proposal.id, OTHER))).toBe("live_not_found");
    expect(await code(h.svc.getOperation(v.operation!.id, OTHER))).toBe("live_not_found");
    expect(await code(h.svc.cancel(v.operation!.id, OTHER))).toBe("live_not_found");
    expect(await code(propose(h, {}, OTHER))).toBe("live_not_found"); // the run belongs to someone else
    await h.svc.decide(v.proposal.id, OWNER, { decision: "approve", digest: v.proposal.digest, confirmAppName: PROPOSE.appName, acknowledgeFinancial: true });
    expect(await code(h.svc.execute(v.proposal.id, OTHER, h.zip))).toBe("live_not_found");
    expect(h.fake.calls).toEqual([]);
  });
  it("execution refuses anything that is not an approved, unexpired proposal", async () => {
    const h = await harness();
    const v = await propose(h);
    expect(await code(h.svc.execute(v.proposal.id, OWNER, h.zip))).toBe("live_not_approved"); // still PENDING
    await h.svc.decide(v.proposal.id, OWNER, { decision: "reject", digest: v.proposal.digest });
    expect(await code(h.svc.execute(v.proposal.id, OWNER, h.zip))).toBe("live_not_approved");
    expect(h.fake.calls).toEqual([]);
  });
});

describe("SIMULATION APPROVALS ARE PERMANENTLY INVALID IN LIVE MODE", () => {
  it("a simulation proposal id/digest is refused outright on every live entry point", async () => {
    const h = await harness();
    for (const id of ["prop_20260102040000_aabbccdd", "prop_x"]) {
      expect(await code(h.svc.decide(id, OWNER, { decision: "approve", digest: "a".repeat(64), confirmAppName: "x", acknowledgeFinancial: true }))).toBe("live_simulation_approval_rejected");
      expect(await code(h.svc.execute(id, OWNER, h.zip))).toBe("live_simulation_approval_rejected");
    }
    expect(h.fake.calls).toEqual([]);
  });
  it("a real Phase 1E simulation approval (approved, SIMULATED_OK) grants nothing live", async () => {
    const { AgentRunManager } = await import("@/server/agent/manager");
    const { MockDiagnosticLLMProvider } = await import("@/server/diagnostics/llm");
    const { mockSvc } = await import("../helpers/scenario-runner");
    const store = new MemoryLiveStore();
    const h = await harness({ store });
    const agent = new AgentRunManager({ svc: mockSvc(), store, provider: new MockDiagnosticLLMProvider("ok"), now: h.clk.now, quotaPerWindow: 99 });
    const sim = await agent.prepareDeployment(h.runId, OWNER, { appName: "sim-only-app" });
    const done = await agent.decide(sim.proposal.id, OWNER, { decision: "approve", digest: sim.proposal.digest, confirmAppName: "sim-only-app" });
    expect(done.proposal.status).toBe("SIMULATED_OK");
    expect(done.approvals[0]).toMatchObject({ scope: "simulation" });
    // presenting its id/digest to the live engine is refused …
    expect(await code(h.svc.decide(sim.proposal.id, OWNER, { decision: "approve", digest: sim.proposal.digest, confirmAppName: "sim-only-app", acknowledgeFinancial: true }))).toBe("live_simulation_approval_rejected");
    // … and it created no live proposal, operation or scope
    expect(await store.getLiveProposal(sim.proposal.id)).toBeNull();
    expect(await store.listOperations((await import("@/server/diagnostics/store")).ownerHashOf(OWNER))).toEqual([]);
    expect(h.fake.calls).toEqual([]);
  });
  it("a live proposal is NOT a simulation proposal: the two stores and the two digest domains never mix", async () => {
    const h = await harness();
    const v = await propose(h);
    expect(await h.store.getProposal(v.proposal.id)).toBeNull(); // not in the simulation table
    const c = contentOfLive(v.proposal);
    expect(liveDigest(c)).toBe(v.proposal.digest);
    const { canonicalJson } = await import("@/server/agent/policy");
    const { createHash } = await import("node:crypto");
    expect(createHash("sha256").update(canonicalJson({ ...c, envKeys: [] })).digest("hex")).not.toBe(v.proposal.digest); // without the live domain the digest differs
  });
  it("the older Phase 1E live-gate refusal still holds", async () => {
    const { authorizeLiveExecution } = await import("@/server/deploy/live-gate");
    expect(authorizeLiveExecution({ proposal: { executionMode: "simulation" }, approval: { scope: "simulation", outcome: "accepted" } }).ok).toBe(false);
  });
});

describe("expiry, replay and races", () => {
  it("an expired proposal cannot be approved (exactly-once EXPIRED, operation released)", async () => {
    const h = await harness();
    const v = await propose(h);
    h.clk.advance(10 * 60_000 + 1000);
    expect(await code(h.svc.decide(v.proposal.id, OWNER, { decision: "approve", digest: v.proposal.digest, confirmAppName: PROPOSE.appName, acknowledgeFinancial: true }))).toBe("live_expired");
    expect((await h.store.getLiveProposal(v.proposal.id))!.status).toBe("EXPIRED");
    expect((await h.store.getOperation(v.operation!.id))!.state).toBe("CANCELLED");
    expect(await code(h.svc.decide(v.proposal.id, OWNER, { decision: "approve", digest: v.proposal.digest, confirmAppName: PROPOSE.appName, acknowledgeFinancial: true }))).toBe("live_already_decided");
    expect(h.fake.calls).toEqual([]);
    // the slot is free again: a NEW proposal (fresh approval) is possible
    expect((await propose(h)).proposal.id).not.toBe(v.proposal.id);
  });
  it("an approval that expires BEFORE execution cannot be used", async () => {
    const h = await harness();
    const v = await approved(h);
    h.clk.advance(10 * 60_000 + 1000);
    expect(await code(h.svc.execute(v.proposal.id, OWNER, h.zip))).toBe("live_expired");
    expect(h.fake.calls).toEqual([]);
    expect((await h.store.getOperation(v.operation!.id))!.state).toBe("CANCELLED");
  });
  it("replay of an approved/consumed proposal is refused and executes nothing a second time", async () => {
    const h = await harness();
    const { v, final } = await deploy(h);
    expect(final.state).toBe("DEPLOYED");
    const n = h.fake.calls.length;
    for (let i = 0; i < 3; i++) {
      expect(await code(h.svc.decide(v.proposal.id, OWNER, { decision: "approve", digest: v.proposal.digest, confirmAppName: PROPOSE.appName, acknowledgeFinancial: true }))).toBe("live_already_decided");
      expect(await code(h.svc.execute(v.proposal.id, OWNER, h.zip))).toBe("live_not_approved");
    }
    expect(h.fake.calls.length).toBe(n);
  });
  it("concurrent approvals authorise exactly once", async () => {
    const h = await harness();
    const v = await propose(h);
    const rs = await Promise.allSettled(Array.from({ length: 8 }, () => h.svc.decide(v.proposal.id, OWNER, { decision: "approve", digest: v.proposal.digest, confirmAppName: PROPOSE.appName, acknowledgeFinancial: true })));
    expect(rs.filter((r) => r.status === "fulfilled")).toHaveLength(1);
    expect((await h.store.listLiveApprovals(v.proposal.id)).filter((a) => a.outcome === "accepted")).toHaveLength(1);
  });
  it("concurrent EXECUTIONS of one approval start exactly one deployment (single-use claim)", async () => {
    const h = await harness();
    const v = await approved(h);
    const rs = await Promise.allSettled(Array.from({ length: 6 }, () => h.svc.execute(v.proposal.id, OWNER, h.zip)));
    expect(rs.filter((r) => r.status === "fulfilled")).toHaveLength(1);
    await settle(h, v.operation!.id);
    expect(h.fake.calls.filter((c) => c.op === "createApp")).toHaveLength(1);
    expect(h.fake.calls.filter((c) => c.op === "uploadSource")).toHaveLength(1);
    expect(h.fake.calls.filter((c) => c.op === "createRelease")).toHaveLength(1);
  });
  it("approve vs reject racing: exactly one wins and a rejection can never execute", async () => {
    const h = await harness();
    const v = await propose(h);
    const rs = await Promise.allSettled([h.svc.decide(v.proposal.id, OWNER, { decision: "approve", digest: v.proposal.digest, confirmAppName: PROPOSE.appName, acknowledgeFinancial: true }), h.svc.decide(v.proposal.id, OWNER, { decision: "reject", digest: v.proposal.digest })]);
    expect(rs.filter((r) => r.status === "fulfilled")).toHaveLength(1);
    const st = (await h.store.getLiveProposal(v.proposal.id))!.status;
    if (st === "REJECTED") expect(await code(h.svc.execute(v.proposal.id, OWNER, h.zip))).toBe("live_not_approved");
  });
  it("two services over the same SQLite database cannot double-authorise or double-execute", async () => {
    const { mkdtempSync, rmSync } = await import("node:fs");
    const { tmpdir } = await import("node:os");
    const path = await import("node:path");
    const { SqliteLiveStore } = await import("@/server/live/store");
    const dir = mkdtempSync(path.join(tmpdir(), "live-sql-"));
    try {
      const h = await harness({ store: new SqliteLiveStore(path.join(dir, "a.db")) });
      const second = h.rebuild({ store: new SqliteLiveStore(path.join(dir, "a.db")) });
      const v = await propose(h);
      const dec = await Promise.allSettled([h.svc, second, h.svc, second].map((s) => s.decide(v.proposal.id, OWNER, { decision: "approve", digest: v.proposal.digest, confirmAppName: PROPOSE.appName, acknowledgeFinancial: true })));
      expect(dec.filter((r) => r.status === "fulfilled")).toHaveLength(1);
      const ex = await Promise.allSettled([h.svc, second, h.svc, second].map((s) => s.execute(v.proposal.id, OWNER, h.zip)));
      expect(ex.filter((r) => r.status === "fulfilled")).toHaveLength(1);
      await settle(h, v.operation!.id);
      expect(h.fake.calls.filter((c) => c.op === "createApp")).toHaveLength(1);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });
});

describe("drift, plan validity and duplicates", () => {
  it("plan becomes unavailable between proposal and approval ⇒ BLOCKED (drift), nothing executes", async () => {
    const h = await harness();
    const v = await propose(h);
    h.fake.catalogue = { ...h.fake.catalogue, plans: h.fake.catalogue.plans.map((p) => (p.id === "g2-small" ? { ...p, available: false } : p)) };
    expect(await code(h.svc.decide(v.proposal.id, OWNER, { decision: "approve", digest: v.proposal.digest, confirmAppName: PROPOSE.appName, acknowledgeFinancial: true }))).toBe("live_blocked_drift");
    expect((await h.store.getLiveProposal(v.proposal.id))!.status).toBe("BLOCKED");
    expect((await h.store.getOperation(v.operation!.id))!.state).toBe("CANCELLED");
    expect(h.fake.calls).toEqual([]);
  });
  it("the bundle plan vanishing, the catalogue becoming unreadable, or the app name appearing all block approval", async () => {
    for (const mutate of [
      (f: FakeLiara) => (f.catalogue = { ...f.catalogue, bundles: { ...f.catalogue.bundles, "g2-small": [] } }),
      (f: FakeLiara) => (f.catalogueOk = false),
      (f: FakeLiara) => f.apps.add("liara-agent-demo"),
      (f: FakeLiara) => (f.nameListOk = false),
    ]) {
      const h = await harness();
      const v = await propose(h);
      mutate(h.fake);
      expect(await code(h.svc.decide(v.proposal.id, OWNER, { decision: "approve", digest: v.proposal.digest, confirmAppName: PROPOSE.appName, acknowledgeFinancial: true }))).toBe("live_blocked_drift");
      expect(h.fake.calls).toEqual([]);
    }
  });
  it("changing a material parameter requires a NEW proposal with a new digest and a new approval", async () => {
    const h = await harness();
    const a = await propose(h);
    await h.svc.decide(a.proposal.id, OWNER, { decision: "reject", digest: a.proposal.digest });
    const b = await propose(h, { planId: "g2-big", bundlePlanId: "silver" });
    expect(b.proposal.digest).not.toBe(a.proposal.digest);
    expect(await code(h.svc.decide(b.proposal.id, OWNER, { decision: "approve", digest: a.proposal.digest, confirmAppName: PROPOSE.appName, acknowledgeFinancial: true }))).toBe("live_digest_mismatch");
  });
  it("invalid, unavailable, unknown and bundle-less plans are refused at proposal time", async () => {
    for (const [over, blocker] of [[{ planId: "nope" }, "plan_not_found"], [{ planId: "g2-off" }, "plan_unavailable"], [{ planId: "g2-unknown" }, "plan_unavailable"], [{ planId: "../x" }, "plan_id_invalid"], [{ planId: "g2-big" }, "bundle_plan_ambiguous"], [{ planId: "g2-tiny" }, "ram_insufficient"]] as const) {
      const h = await harness();
      const e = await propose(h, over).catch((x) => x);
      expect(isLiveError(e) && e.code, JSON.stringify(over)).toBe("live_plan_blocked");
      expect(e.detail, JSON.stringify(over)).toContain(blocker);
      expect(h.fake.calls).toEqual([]);
    }
  });
  it("UNKNOWN PRICING UNITS block live creation entirely (proposal and execution)", async () => {
    const h = await harness({ env: { LIARA_PLAN_UNITS_JSON: undefined } });
    const e = await propose(h).catch((x) => x);
    expect(e.code).toBe("live_prerequisite_missing");
    expect(e.detail).toContain("plan_units_verified");
    const st = await h.svc.status(OWNER, h.runId);
    expect(st.uiState).toBe("BLOCKED");
    expect(st.catalogue!.unitsVerified).toBe(false);
    expect(st.catalogue!.candidates.every((c) => c.recommended === null)).toBe(true);
  });
  it("an existing application name, an unverifiable name list, and a duplicate attempt are refused (never a second create)", async () => {
    const h1 = await harness();
    h1.fake.apps.add("liara-agent-demo");
    expect(await code(propose(h1))).toBe("live_duplicate_app");
    const h2 = await harness();
    h2.fake.nameListOk = false;
    expect(await code(propose(h2))).toBe("live_prerequisite_missing");
    const h3 = await harness();
    const a = await propose(h3);
    expect(await code(propose(h3))).toBe("live_proposal_pending");
    await h3.svc.decide(a.proposal.id, OWNER, { decision: "approve", digest: a.proposal.digest, confirmAppName: PROPOSE.appName, acknowledgeFinancial: true });
    expect(await code(propose(h3))).toBe("live_duplicate_app"); // approved-but-unexecuted still owns the slot
    expect(h3.fake.calls).toEqual([]);
  });
  it("a second deployment attempt for the same app is refused while the first is active, even after a restart-like rebuild", async () => {
    const h = await harness();
    const { final } = await deploy(h);
    expect(final.state).toBe("DEPLOYED");
    expect(await code(propose(h))).toBe("live_duplicate_app");
    h.fake.apps.delete("liara-agent-demo");
    expect(await code(h.rebuild().createProposal(OWNER, { runId: h.runId, planId: "g2-small", bundlePlanId: null, appName: "liara-agent-demo", zip: h.zip }))).toBe("live_duplicate_app"); // the DB, not the remote, owns the slot
  });
  it("a different (valid) name is a different deployment", async () => {
    const h = await harness();
    await deploy(h);
    expect((await propose(h, { appName: "liara-agent-demo-2" })).proposal.appName).toBe("liara-agent-demo-2");
  });
});

describe("artifact binding at proposal and at execution", () => {
  it("proposal requires the SAME zip that was analysed; the digests are bound", async () => {
    const h = await harness();
    expect(await code(propose(h, { zip: demoZip({ "README.md": "changed" }) }))).toBe("live_artifact_mismatch");
    const v = await propose(h);
    const { createHash } = await import("node:crypto");
    expect(v.proposal.artifact.zipSha256).toBe(createHash("sha256").update(h.zip).digest("hex"));
  });
  it("execution with a different or modified ZIP is refused with ZERO writes", async () => {
    const h = await harness();
    const v = await approved(h);
    const other = demoZip({ "README.md": "different" });
    expect(await code(h.svc.execute(v.proposal.id, OWNER, other))).toBe("live_artifact_mismatch");
    const flipped = Buffer.from(h.zip);
    const at = flipped.length - 30;
    flipped[at] = (flipped[at] ?? 0) ^ 0xff;
    expect(["live_artifact_mismatch", "live_artifact_rejected"]).toContain((await code(h.svc.execute(v.proposal.id, OWNER, flipped))) ?? "none");
    expect(h.fake.calls).toEqual([]);
    // the approval is still usable with the right file (a refused attempt does not consume it)
    const op = await h.svc.execute(v.proposal.id, OWNER, h.zip);
    expect((await settle(h, op.id)).state).toBe("DEPLOYED");
  });
  it("hostile archives are rejected at both points", async () => {
    const { buildZip } = await import("../helpers/zip");
    const h = await harness();
    const evil = buildZip([{ name: "../x", data: "x" }, { name: "package.json", data: "{}" }]);
    expect(["live_artifact_mismatch", "live_artifact_rejected"]).toContain((await code(propose(h, { zip: evil }))) ?? "none");
    const v = await approved(h);
    expect(["live_artifact_mismatch", "live_artifact_rejected"]).toContain((await code(h.svc.execute(v.proposal.id, OWNER, evil))) ?? "none");
    expect(h.fake.calls).toEqual([]);
  });
  it("a project that needs environment values cannot go live in this phase", async () => {
    const h = await harness({ zip: demoZip({ ".env.example": "API_KEY=\n" }) });
    const e = await propose(h).catch((x) => x);
    expect(e.code).toBe("live_prerequisite_missing");
    expect(JSON.stringify(e.detail)).toMatch(/readiness_needs_configuration|environment_values_entry_not_supported/);
  });
  it("secret files in the archive are excluded from what is uploaded", async () => {
    const h = await harness({ zip: demoZip({ ".env": `SECRET=${CANARY.envValue}`, "server.pem": CANARY.sshKey }) });
    const v = await approved(h);
    const op = await h.svc.execute(v.proposal.id, OWNER, h.zip);
    expect((await settle(h, op.id)).state).toBe("DEPLOYED");
    const art = await buildDeploymentArtifact(h.zip);
    expect(art.paths).not.toContain(".env");
    expect(h.fake.calls[1]!.bytes).toBe(art.size);
  });
});

describe("per-step authorization is re-checked from storage", () => {
  it("assertStepAuthorized refuses without live flag, attestation, units, network, approval, binding or digest", async () => {
    const h = await harness();
    const v = await approved(h);
    const claimed = await h.svc.execute(v.proposal.id, OWNER, h.zip);
    await settle(h, claimed.id);
    const op = (await h.store.getOperation(claimed.id))!;
    const gate = h.svc.gate();
    const state = "DEPLOYED" as const;
    const ok = await assertStepAuthorized(h.store, op, gate, state);
    expect(ok.id).toBe(v.proposal.id);
    const bad: [Partial<typeof gate>, string][] = [[{ enabled: false }, "live_execution_disabled"], [{ contractAttested: false }, "live_prerequisite_missing"], [{ unitsVerified: false }, "live_prerequisite_missing"], [{ networkId: null }, "live_prerequisite_missing"], [{ teamId: "team_other_9" }, "live_binding_mismatch"], [{ networkId: "net_other_9" }, "live_binding_mismatch"]];
    for (const [over, c] of bad) expect(await code(assertStepAuthorized(h.store, op, { ...gate, ...over }, state)), JSON.stringify(over)).toBe(c);
    expect(await code(assertStepAuthorized(h.store, op, gate, "APPROVED"))).toBe("live_invalid_state"); // wrong position in the state machine
  });
  it("an operation whose proposal was never approved, or whose approval is not live/accepted, is refused", async () => {
    const h = await harness();
    const v = await propose(h);
    const op = (await h.store.getOperation(v.operation!.id))!;
    expect(await code(assertStepAuthorized(h.store, op, h.svc.gate(), "AWAITING_LIVE_APPROVAL"))).toBe("live_not_approved"); // PENDING, not CONSUMED
  });
});

describe("timeouts, unknown outcomes and reconciliation (never a blind retry)", () => {
  it("create timeout but the app is visible ⇒ continues WITHOUT a second createApp", async () => {
    const h = await harness();
    h.fake.create = "timeout_created";
    const { final } = await deploy(h);
    expect(final.state).toBe("DEPLOYED");
    expect(h.fake.calls.filter((c) => c.op === "createApp")).toHaveLength(1);
    expect(final.steps[0]!.outcome).toBe("reconciled_after_unknown_outcome");
  });
  it("create 5xx but the app exists ⇒ the same reconciliation", async () => {
    const h = await harness();
    h.fake.create = "server_error_created";
    const { final } = await deploy(h);
    expect(final.state).toBe("DEPLOYED");
    expect(h.fake.calls.filter((c) => c.op === "createApp")).toHaveLength(1);
  });
  it("create timeout and the app never shows up ⇒ NEEDS_OPERATOR_REVIEW, one POST only, nothing after it, name stays reserved", async () => {
    const h = await harness();
    h.fake.create = "timeout_not_created";
    const { final } = await deploy(h);
    expect(final.state).toBe("NEEDS_OPERATOR_REVIEW");
    expect(final.failure).toMatchObject({ code: "timeout", step: "create_application" });
    expect(final.recoveryFa.join(" ")).toMatch(/هیچ‌گاه درخواست ساخت را دوباره نمی‌فرستد/);
    expect(h.fake.calls.map((c) => c.op)).toEqual(["createApp"]);
    expect(final.remote.appConfirmed).toBeNull();
    expect(await code(propose(h))).toBe("live_duplicate_app"); // possibly created late: the name is NOT released
    expect(h.store.scopeHas(TEAM, "liara-agent-demo")).toBe(false);
  });
  it("API accepted the create but the app is not visible ⇒ review (HTTP 200 alone is never success)", async () => {
    const h = await harness();
    h.fake.create = "ok_invisible";
    const { final } = await deploy(h);
    expect(final.state).toBe("NEEDS_OPERATOR_REVIEW");
    expect(final.failure!.code).toBe("accepted_but_not_visible");
    expect(final.ladder.apiAcceptedRequest).toBe("ok");
    expect(final.ladder.releaseCreated).toBe("unknown");
    expect(h.fake.calls.map((c) => c.op)).toEqual(["createApp"]);
  });
  it("an unreadable name list during reconciliation is 'unknown', never 'absent' ⇒ review", async () => {
    const h = await harness();
    h.fake.create = "timeout_created";
    const orig = h.fake.reader.appNameExists;
    const v = await approved(h);
    h.fake.reader.appNameExists = async (n) => (h.fake.calls.length === 0 ? orig(n) : { ok: false, code: "upstream_error" });
    const op = await h.svc.execute(v.proposal.id, OWNER, h.zip);
    const final = await settle(h, op.id);
    expect(final.state).toBe("NEEDS_OPERATOR_REVIEW");
    expect(h.fake.calls.filter((c) => c.op === "createApp")).toHaveLength(1);
  });
  it("upload timeout ⇒ review, the upload is NOT repeated, the application is preserved", async () => {
    const h = await harness();
    h.fake.upload = "timeout";
    const { final } = await deploy(h);
    expect(final.state).toBe("NEEDS_OPERATOR_REVIEW");
    expect(final.failure).toMatchObject({ code: "timeout", step: "upload_source" });
    expect(h.fake.calls.map((c) => c.op)).toEqual(["createApp", "uploadSource"]);
    expect(h.fake.apps.has("liara-agent-demo")).toBe(true);
    expect(final.remote.appConfirmed).toBe(true);
  });
  it("a 2xx upload answer without a usable sourceID ⇒ review, not success", async () => {
    const h = await harness();
    h.fake.upload = "malformed";
    const { final } = await deploy(h);
    expect(final.state).toBe("NEEDS_OPERATOR_REVIEW");
    expect(final.ladder.sourceUploaded).toBe("unknown");
    // the evidence survives: HTTP status + sanitised shape are in the audit trail, and the recovery text says Liara DID answer 2xx (source probably stored, id unreadable)
    const row = (await h.store.readAudit(500)).find((r) => r.event === "live.operation_needs_review");
    expect(JSON.parse(row!.data)).toMatchObject({ step: "upload_source", code: "malformed_response", httpStatus: 200, shape: { status: 200, body: "json", expected: { key: "sourceID", present: true, type: "string" } } });
    expect(final.recoveryFa.join(" ")).toContain("۲xx");
    expect(final.recoveryFa.join(" ")).toContain("sourceID");
    expect(h.fake.calls.map((c) => c.op)).toEqual(["createApp", "uploadSource"]); // upload never retried, no release attempted
  });
  it("release timeout and a NEW release id appears ⇒ adopted (one create, no repeat)", async () => {
    const h = await harness();
    h.fake.release = "timeout_created";
    const { final } = await deploy(h);
    expect(final.state).toBe("DEPLOYED");
    expect(final.steps[2]!.outcome).toBe("reconciled_after_unknown_outcome");
    expect(h.fake.calls.filter((c) => c.op === "createRelease")).toHaveLength(1);
  });
  it("release timeout with nothing new, or with AMBIGUOUS new releases ⇒ review (never guessed)", async () => {
    for (const release of ["timeout_not_created", "timeout_two_created"] as const) {
      const h = await harness();
      h.fake.release = release;
      const { final } = await deploy(h);
      expect(final.state, release).toBe("NEEDS_OPERATOR_REVIEW");
      expect(final.remote.releaseId, release).toBeNull();
      expect(h.fake.calls.filter((c) => c.op === "createRelease"), release).toHaveLength(1);
    }
  });
});

describe("definite rejections and partial failures", () => {
  it("create 409/402/403/400 ⇒ FAILED with the app confirmed ABSENT; the name is released; nothing else is sent; scope untouched", async () => {
    for (const [b, text] of [["rejected_409", /وجود دارد/], ["rejected_402", /موجودی/], ["rejected_403", /دسترسی/], ["rejected_400", /نامعتبر/]] as const) {
      const h = await harness();
      h.fake.create = b;
      const { final } = await deploy(h);
      expect(final.state, b).toBe("FAILED");
      expect(final.failure!.messageFa, b).toMatch(text);
      expect(final.remote.appConfirmed, b).toBe(false);
      expect(h.fake.calls.map((c) => c.op), b).toEqual(["createApp"]);
      expect(h.store.scopeHas(TEAM, "liara-agent-demo"), b).toBe(false);
      expect((await propose(h)).proposal.status).toBe("PENDING"); // a fresh attempt is allowed (new approval)
    }
  });
  it("insufficient balance tells the operator to top up manually and never charges", async () => {
    const h = await harness();
    h.fake.create = "rejected_402";
    const { final } = await deploy(h);
    expect(final.recoveryFa.join(" ")).toMatch(/دستی شارژ/);
    expect(JSON.stringify(h.fake.calls)).not.toMatch(/charge|balance|payment/i);
  });
  it("upload rejected ⇒ FAILED, the created application is PRESERVED (confirmed present), recovery explained, nothing deleted", async () => {
    const h = await harness();
    h.fake.upload = "rejected_413";
    const { final } = await deploy(h);
    expect(final.state).toBe("FAILED");
    expect(final.remote.appConfirmed).toBe(true);
    expect(final.failure).toMatchObject({ code: "payload_too_large", step: "upload_source" });
    expect(final.recoveryFa.join(" ")).toMatch(/حفظ شده/);
    expect(h.fake.apps.has("liara-agent-demo")).toBe(true);
    expect(h.fake.calls.map((c) => c.op)).toEqual(["createApp", "uploadSource"]);
    expect(h.store.scopeHas(TEAM, "liara-agent-demo")).toBe(true); // created + confirmed + approved ⇒ in scope so the operator can inspect it
    expect(await code(propose(h))).toBe("live_duplicate_app"); // the app exists: a new attempt needs a new name
  });
  it("release rejected ⇒ FAILED with app and source preserved", async () => {
    const h = await harness();
    h.fake.release = "rejected_400";
    const { final } = await deploy(h);
    expect(final.state).toBe("FAILED");
    expect(final.remote).toMatchObject({ appConfirmed: true, sourceId: "src_0001_demo", releaseId: null });
    expect(h.fake.calls.map((c) => c.op)).toEqual(["createApp", "uploadSource", "createRelease"]);
  });
  it("an app that is created but not running (scale 0) stops before upload: the tool never starts it automatically", async () => {
    const h = await harness();
    h.fake.appScale = 0;
    const { final } = await deploy(h);
    expect(final.state).toBe("NEEDS_OPERATOR_REVIEW");
    expect(final.failure!.code).toBe("app_not_running");
    expect(h.fake.calls.map((c) => c.op)).toEqual(["createApp"]);
  });
  it("there is no deletion, plan change, restart or rollback anywhere in a failed run", async () => {
    const h = await harness();
    h.fake.release = "rejected_400";
    await deploy(h);
    expect(new Set(h.fake.calls.map((c) => c.op))).toEqual(new Set(["createApp", "uploadSource", "createRelease"]));
    expect(Object.keys(h.fake.transport).sort()).toEqual(["createApp", "createRelease", "uploadSource"]);
  });
});

describe("post-deployment verification: only a fully verified release is DEPLOYED", () => {
  const run = async (mut: (f: FakeLiara) => void, extra: Parameters<typeof harness>[0] = {}) => {
    const h = await harness({ poll: { verifyBudgetMs: 20_000, pollIntervalMs: 1000 }, ...extra });
    mut(h.fake);
    return { h, ...(await deploy(h)) };
  };
  it("release FAILED / CANCELED / TIMEDOUT / UNHEALTHY ⇒ FAILED (resources preserved)", async () => {
    for (const st of ["FAILED", "CANCELED", "TIMEDOUT", "UNHEALTHY"]) {
      const { final } = await run((f) => (f.releaseStates = ["DEPLOYING", st]));
      expect(final.state, st).toBe("FAILED");
      expect(final.failure!.code, st).toBe("verification_failed");
      expect(final.remote.releaseId, st).not.toBeNull();
    }
  });
  it("an UNKNOWN release state is never success: after the bounded budget it needs review", async () => {
    const { final, h } = await run((f) => (f.releaseStates = ["WEIRD_NEW_STATE"]));
    expect(final.state).toBe("NEEDS_OPERATOR_REVIEW");
    expect(final.failure!.code).toBe("verification_inconclusive");
    expect(final.ladder).toMatchObject({ releaseCreated: "ok", buildCompleted: "unknown", httpHealthVerified: "unknown" });
    expect(h.sleeps.length).toBeGreaterThan(5); // it polled for the budget (virtual clock), then stopped — bounded
  });
  it("releases that never leave DEPLOYING end under review, not as success", async () => {
    const { final } = await run((f) => (f.releaseStates = ["DEPLOYING"]));
    expect(final.state).toBe("NEEDS_OPERATOR_REVIEW");
  });
  it("MISSING HEALTH EVIDENCE (no trusted domain configured) can never reach DEPLOYED", async () => {
    const { final } = await run(() => undefined, { env: { LIARA_APP_DOMAIN_SUFFIXES: undefined, LIARA_LIVE_DEPLOY_ENABLED: "true" } }).catch(() => ({ final: null as never }));
    // the proposal itself is refused without a domain suffix; assert that precondition holds
    expect(final).toBeNull();
  });
  it("health check failing or answering without the expected marker ⇒ FAILED", async () => {
    expect((await run((f) => (f.probeResult = { outcome: "http_error", status: 502, markerFound: null }))).final.state).toBe("FAILED");
    expect((await run((f) => (f.probeResult = { outcome: "ok", status: 200, markerFound: false }))).final.state).toBe("FAILED");
  });
  it("probe timeouts / blocked addresses / redirects are inconclusive ⇒ review", async () => {
    for (const outcome of ["timeout", "network", "blocked_address", "redirect", "too_large", "invalid_target"] as const) {
      const { final } = await run((f) => (f.probeResult = { outcome, status: null, markerFound: null }));
      expect(final.state, outcome).toBe("NEEDS_OPERATOR_REVIEW");
      expect(final.ladder.httpHealthVerified, outcome).toBe("unknown");
    }
  });
  it("runtime not observed running (unknown vocabulary, no applets, restarting) is not success", async () => {
    expect((await run((f) => (f.runtime = { runtime: "unknown", appletCount: 1, heuristic: true, enabled: "enabled" }))).final.state).toBe("NEEDS_OPERATOR_REVIEW");
    expect((await run((f) => (f.runtime = { runtime: "no_instances", appletCount: 0, heuristic: false, enabled: "enabled" }))).final.state).toBe("NEEDS_OPERATOR_REVIEW");
    expect((await run((f) => (f.runtime = { runtime: "restarting", appletCount: 1, heuristic: true, enabled: "enabled" }))).final.state).toBe("FAILED");
  });
  it("each acceptance level is recorded separately and in order", async () => {
    const { final } = await run((f) => (f.releaseStates = ["DEPLOYING", "READY"]));
    expect(final.ladder).toEqual({ apiAcceptedRequest: "ok", sourceUploaded: "ok", releaseCreated: "ok", buildCompleted: "ok", runtimeStarted: "ok", httpHealthVerified: "ok" });
  });
  it("RE-VERIFY (read-only) of an operation under review can reach DEPLOYED only when every fact becomes ok; ABANDON keeps the resources", async () => {
    const h = await harness({ poll: { verifyBudgetMs: 5_000, pollIntervalMs: 1000 } });
    h.fake.releaseStates = ["WEIRD"];
    const { final } = await deploy(h);
    expect(final.state).toBe("NEEDS_OPERATOR_REVIEW");
    const calls = h.fake.calls.length;
    h.fake.releaseStates = ["READY"];
    h.fake.pollsSeen = 0;
    const again = await h.svc.resolve(final.id, OWNER, "reverify");
    expect(again.state).toBe("DEPLOYED");
    expect(again.failure).toBeNull();
    expect(h.fake.calls.length).toBe(calls); // re-verification performed no write
    // abandon path on another operation
    const h2 = await harness({ poll: { verifyBudgetMs: 3_000, pollIntervalMs: 1000 } });
    h2.fake.releaseStates = ["WEIRD"];
    const r2 = (await deploy(h2)).final;
    const ab = await h2.svc.resolve(r2.id, OWNER, "abandon");
    expect(ab.state).toBe("FAILED");
    expect(ab.failure!.code).toBe("abandoned_by_operator");
    expect(h2.fake.apps.has("liara-agent-demo")).toBe(true); // nothing deleted
    expect(await code(h2.svc.resolve(r2.id, OWNER, "reverify"))).toBe("live_invalid_state");
  });
  it("re-verify of an operation without a release only refreshes whether the app exists (and bootstraps scope when it does)", async () => {
    const h = await harness();
    h.fake.create = "timeout_not_created";
    const { final } = await deploy(h);
    expect(final.state).toBe("NEEDS_OPERATOR_REVIEW");
    h.fake.apps.add("liara-agent-demo"); // it appeared late
    const r = await h.svc.resolve(final.id, OWNER, "reverify");
    expect(r.state).toBe("NEEDS_OPERATOR_REVIEW");
    expect(r.remote.appConfirmed).toBe(true);
    expect(h.store.scopeHas(TEAM, "liara-agent-demo")).toBe(true);
    expect(h.fake.calls.map((c) => c.op)).toEqual(["createApp"]); // still no second create
  });
  it("recovery actions are owner-bound and state-bound", async () => {
    const h = await harness();
    const { final } = await deploy(h);
    expect(await code(h.svc.resolve(final.id, OWNER, "abandon"))).toBe("live_invalid_state"); // DEPLOYED is not under review
    expect(await code(h.svc.resolve(final.id, OTHER, "reverify"))).toBe("live_not_found");
    expect(await code(h.svc.resolve(final.id, OWNER, "delete" as never))).toBe("live_invalid_state");
  });
});

describe("cancellation, crash recovery and the audit trail", () => {
  it("cancelling is possible only before anything remote was attempted", async () => {
    const h = await harness();
    const v = await propose(h);
    const c = await h.svc.cancel(v.operation!.id, OWNER);
    expect(c.state).toBe("CANCELLED");
    expect(await code(h.svc.cancel(v.operation!.id, OWNER))).toBe("live_invalid_state");
    expect(h.fake.calls).toEqual([]);
    const d = await harness();
    const done = await deploy(d);
    expect(await code(d.svc.cancel(done.final.id, OWNER))).toBe("live_invalid_state");
  });
  it("an approved-then-cancelled operation can no longer be executed", async () => {
    const h = await harness();
    const v = await approved(h);
    await h.svc.cancel(v.operation!.id, OWNER);
    expect(await code(h.svc.execute(v.proposal.id, OWNER, h.zip))).toBe("live_operation_in_progress");
    expect(h.fake.calls).toEqual([]);
  });
  it("after a restart, operations that were mid-flight go UNDER REVIEW and are never retried; orphaned awaiting operations are cancelled", async () => {
    const store = new MemoryLiveStore();
    const h = await harness({ store });
    const v = await approved(h);
    const claimed = { ...(await store.getOperation(v.operation!.id))!, state: "CREATING_APPLICATION" as const, updatedAt: new Date(h.clk.now()).toISOString() };
    // simulate a crash right after the claim: proposal consumed, operation in-flight, no executor running
    await store.beginExecution({ ...claimed, state: "APPROVED" }, new Date(h.clk.now()).toISOString());
    await store.updateOperation(claimed, "APPROVED");
    const svc2 = h.rebuild();
    expect(await code(svc2.status(OWNER, h.runId).then(() => svc2.getOperation(v.operation!.id, OWNER)))).toBeNull();
    const op = await svc2.getOperation(v.operation!.id, OWNER);
    expect(op.state).toBe("NEEDS_OPERATOR_REVIEW");
    expect(op.failure!.code).toBe("interrupted_by_restart");
    expect(h.fake.calls).toEqual([]);
    expect(await code(svc2.execute(v.proposal.id, OWNER, h.zip))).toBe("live_not_approved");
  });
  it("sanitised error reporting: failures expose machine codes and fixed Persian text, never upstream text or ids", async () => {
    const h = await harness();
    h.fake.create = "rejected_403";
    const { final } = await deploy(h);
    const json = JSON.stringify(final);
    expect(json).not.toMatch(/Bearer|token|authorization/i);
    assertNoCanary(json);
    expect(final.failure!.messageFa).toMatch(/[؀-ۿ]/);
  });
});

describe("allowlist bootstrap", () => {
  it("a created app joins the scope only after confirmed creation under a consumed, accepted approval — exact team and name", async () => {
    const h = await harness();
    expect(h.store.scopeHas(TEAM, "liara-agent-demo")).toBe(false);
    const v = await approved(h);
    expect(h.store.scopeHas(TEAM, "liara-agent-demo")).toBe(false); // approval alone grants nothing
    const op = await h.svc.execute(v.proposal.id, OWNER, h.zip);
    await settle(h, op.id);
    expect(h.store.scopeHas(TEAM, "liara-agent-demo")).toBe(true);
    expect(h.store.scopeHas("team_other_9", "liara-agent-demo")).toBe(false); // other team
    expect(h.store.scopeHas(null, "liara-agent-demo")).toBe(false); // personal scope
    expect(h.store.scopeHas(TEAM, "liara-agent-demo-2")).toBe(false); // other name
    expect(h.store.scopeHas(TEAM, "other-existing-app")).toBe(false); // unrelated apps are not granted
  });
  it("never bootstrapped for rejected, expired, failed-before-create or unapproved operations", async () => {
    const h = await harness();
    const v = await propose(h);
    expect((await h.store.bootstrapScope(v.operation!.id, new Date(h.clk.now()).toISOString())).ok).toBe(false);
    h.fake.create = "rejected_409";
    const { final } = await deploy(await harness({ fake: Object.assign(new FakeLiara(), { create: "rejected_409" as const }) }));
    expect(final.state).toBe("FAILED");
    expect((await h.store.bootstrapScope("lop_20260102040000_00000000", new Date(h.clk.now()).toISOString())).reason).toBe("operation_not_found");
    expect(h.store.scopeHas(TEAM, "liara-agent-demo")).toBe(false);
  });
  it("the allowlist is NOT disabled: LiaraService still refuses everything outside env allowlist ∪ bootstrapped apps", async () => {
    const { buildService } = await import("@/server/liara/service");
    const { makeConfig } = await import("../helpers/live");
    const h = await harness();
    const { final } = await deploy(h);
    expect(final.state).toBe("DEPLOYED");
    const svc = buildService(makeConfig(liveEnv()), { fetchImpl: (async () => new Response("{}")) as unknown as typeof fetch });
    expect(svc.isAllowed("liara-agent-demo")).toBe(false);
    svc.setScopeExtension((n) => h.store.scopeHas(TEAM, n));
    expect(svc.isAllowed("liara-agent-demo")).toBe(true);
    expect(svc.isAllowed("other-existing-app")).toBe(true); // env allowlist unchanged
    for (const n of ["unrelated-app", "liara-agent-demo-2", "LIARA-AGENT-DEMO", "../x", "", "*"]) expect(svc.isAllowed(n), n).toBe(false);
    svc.setScopeExtension(null);
    expect(svc.isAllowed("liara-agent-demo")).toBe(false);
  });
  it("the scope table can only be written through the transactional bootstrap (no other writer in the live layer)", async () => {
    const { readFileSync, readdirSync } = await import("node:fs");
    const path = await import("node:path");
    const dir = path.resolve(__dirname, "../../src/server");
    const hits: string[] = [];
    const walk = (d: string) => {
      for (const e of readdirSync(d, { withFileTypes: true })) {
        const p = path.join(d, e.name);
        if (e.isDirectory()) walk(p);
        else if (/\.tsx?$/.test(e.name) && /INSERT[^;]*app_scope/i.test(readFileSync(p, "utf8"))) hits.push(path.relative(dir, p));
      }
    };
    walk(dir);
    expect(hits).toEqual(["live/store.ts"]);
  });
});

describe("zero cost", () => {
  it("the whole live flow performs no network request and no AI call (recording fakes only)", async () => {
    const { blockedAttempts } = await import("../helpers/network-guard");
    const before = blockedAttempts.length;
    const h = await harness();
    await deploy(h);
    expect(blockedAttempts.length).toBe(before);
  });
});

void UNITS;
