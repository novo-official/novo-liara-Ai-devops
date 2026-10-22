import { createHash } from "node:crypto";
import { existsSync, readFileSync } from "node:fs";
import path from "node:path";
import { describe, expect, it } from "vitest";
import { buildExistingChecks, expectedDefaultSuffix, markerIsSpecific, validateHealthSettings, type ExistingFacts } from "@/server/live/existing";
import { isLiveError } from "@/server/live/types";
import { assertNoCanary } from "../helpers/canaries";
import { FakeProcessRunner, makeCliBackend, makeFakeCliPackage } from "../helpers/fake-cli";
import { FakeLiara, harness, OWNER, settle } from "../helpers/live-exec";

const APP = "liara-agent-demo";
type H = Awaited<ReturnType<typeof harness>>;
const code = async (p: Promise<unknown>) => {
  try {
    await p;
    return null;
  } catch (e) {
    return isLiveError(e) ? `${e.code}${e.detail.length ? ":" + e.detail.join(",") : ""}` : "other";
  }
};
async function setup(o: { env?: Record<string, string | undefined>; cli?: boolean } = {}) {
  const runner = new FakeProcessRunner();
  const cli = o.cli ? makeCliBackend(runner, makeFakeCliPackage()).backend : null;
  const h = await harness({ env: o.env, cli, noTransport: false });
  h.fake.apps.add(APP);
  h.fake.releaseIds.push("rel_old_1");
  runner.onRun = () => void h.fake.releaseIds.push("rel_cli_new_1");
  return { h, runner };
}
const propose = (h: H, backend: "api" | "cli" = "api") => h.svc.createExistingProposal(OWNER, { runId: h.runId, appName: APP, backend, zip: h.zip });
const approve = (h: H, v: { proposal: { id: string; digest: string; appName: string } }) => h.svc.decide(v.proposal.id, OWNER, { decision: "approve", digest: v.proposal.digest, confirmAppName: v.proposal.appName });
const recreate = (f: FakeLiara) => {
  f.existingInstanceId = "inst_0002_recreated";
  f.existingCreatedAt = "2026-10-22T09:30:00.000Z";
  f.releaseIds.length = 0; // a recreated app has an empty release history
};

describe("OFFLINE REHEARSAL for liara-agent-demo — nothing real is touched", () => {
  it("full REST rehearsal: status → proposal → approval → execution → DEPLOYED; the CREATE call is never made", async () => {
    const { h } = await setup();
    let createCalls = 0;
    const exec = h.svc.executor as unknown as { createApplication: (...a: unknown[]) => unknown };
    const orig = exec.createApplication.bind(exec);
    exec.createApplication = (...a) => (createCalls++, orig(...a));

    const st = await h.svc.status(OWNER, h.runId);
    expect(st.mode).toMatchObject({ kind: "live_enabled", dataSource: "live", liveFlag: true, writePathReady: true });
    expect(st.existing!.targets.map((t) => [t.name, t.ready])).toEqual([[APP, true]]);
    expect(st.existing!.backends.map((b) => [b.id, b.isDefault, b.ready])).toEqual([["api", true, true], ["cli", false, false]]);
    expect(st.existing!.targets[0]!.facts).toMatchObject({ planId: "g2-small", platform: "next", scale: 1, hasNetwork: true, defaultSubdomain: true, releaseTotal: 1 });
    expect(h.fake.calls).toEqual([]);

    const v = await propose(h);
    expect(v.proposal.existing).toMatchObject({ instanceId: "inst_0001_demo", createdAt: "2026-10-20T08:00:00.000Z", baselineRelease: "rel_old_1", releaseTotal: 1, defaultSubdomain: true });
    await approve(h, v);
    const op = await h.svc.execute(v.proposal.id, OWNER, h.zip);
    const final = await settle(h, op.id);
    expect(final.state).toBe("DEPLOYED");
    expect(createCalls).toBe(0);
    expect(h.fake.calls.map((c) => c.op)).toEqual(["uploadSource", "createRelease"]);
    const audit = (await h.store.readAudit(500)).map((r) => r.event);
    expect(audit).not.toContain("live.create_application_attempt");
    expect(audit).toContain("live.existing_app_verified");
    expect(await h.store.verifyAudit()).toMatchObject({ ok: true });
    assertNoCanary(JSON.stringify([st, v, final, await h.store.readAudit(500)]));
  });
  it("PROOF — across every REST/CLI outcome the transport never receives createApp", async () => {
    const scenarios: [string, (f: FakeLiara, r: FakeProcessRunner) => void, "api" | "cli"][] = [
      ["rest ok", () => undefined, "api"], ["rest upload timeout", (f) => (f.upload = "timeout"), "api"], ["rest upload 413", (f) => (f.upload = "rejected_413"), "api"],
      ["rest release 400", (f) => (f.release = "rejected_400"), "api"], ["rest release timeout", (f) => (f.release = "timeout_not_created"), "api"],
      ["cli ok", () => undefined, "cli"], ["cli nonzero", (_f, r) => ((r.onRun = () => undefined), (r.result = { exitCode: 1 })), "cli"], ["cli timeout", (_f, r) => (r.result = { exitCode: null, timedOut: true, signal: "SIGKILL" }), "cli"],
    ];
    for (const [name, mutate, backend] of scenarios) {
      const { h, runner } = await setup({ cli: backend === "cli" });
      mutate(h.fake, runner);
      const v = await propose(h, backend);
      await approve(h, v);
      await settle(h, (await h.svc.execute(v.proposal.id, OWNER, h.zip)).id);
      expect(h.fake.calls.map((c) => c.op), name).not.toContain("createApp");
      expect((await h.store.readAudit(500)).map((r) => r.event), name).not.toContain("live.create_application_attempt");
    }
  });
  it("full CLI rehearsal (fake process runner): REST write client unused, CLI runs once, outcome verified by reading", async () => {
    const { h, runner } = await setup({ cli: true, env: undefined });
    const st = await h.svc.status(OWNER, h.runId);
    expect(st.existing!.backends.find((b) => b.id === "cli")).toMatchObject({ ready: true, isDefault: false, cliVersion: null });
    const v = await propose(h, "cli");
    await approve(h, v);
    const final = await settle(h, (await h.svc.execute(v.proposal.id, OWNER, h.zip)).id);
    expect(final.state).toBe("DEPLOYED");
    expect(runner.calls).toHaveLength(1);
    expect(h.fake.calls).toEqual([]);
  });
  it("the CLI fallback is never selected automatically: the default backend is api, and a cli proposal needs an explicit request", async () => {
    const { h } = await setup({ cli: true });
    const st = await h.svc.status(OWNER, h.runId);
    expect(st.existing!.backends.filter((b) => b.isDefault).map((b) => b.id)).toEqual(["api"]);
    expect((await propose(h)).proposal.backend).toBe("api");
  });
});

describe("recreated-app identity drift invalidates stale proposals and approvals", () => {
  it("a proposal made before the app was recreated cannot be approved (same name, new instance)", async () => {
    const { h } = await setup();
    const v = await propose(h);
    recreate(h.fake);
    expect(await code(approve(h, v))).toBe("live_blocked_drift");
    expect((await h.store.getLiveProposal(v.proposal.id))!.status).toBe("BLOCKED");
    expect(h.fake.calls).toEqual([]);
  });
  it("an APPROVED proposal is void if the app is recreated before execution: nothing is sent", async () => {
    const { h } = await setup();
    const v = await propose(h);
    await approve(h, v);
    recreate(h.fake);
    const final = await settle(h, (await h.svc.execute(v.proposal.id, OWNER, h.zip)).id);
    expect(final.state).toBe("FAILED");
    expect(final.failure!.code).toMatch(/preflight_drift|existing_instance_changed/);
    expect(h.fake.calls).toEqual([]);
  });
  it("each identity facet is bound on its own: instance id, creation time, network, current release, release count, default subdomain, plan, platform", async () => {
    const facets: [string, (f: FakeLiara) => void][] = [
      ["instance id", (f) => (f.existingInstanceId = "inst_other")], ["creation time", (f) => (f.existingCreatedAt = "2026-10-22T10:00:00.000Z")],
      ["network", (f) => (f.existingNetworkId = null)], ["new release by someone else", (f) => f.releaseIds.push("rel_someone_else")],
      ["release removed", (f) => f.releaseIds.pop()], ["default subdomain", (f) => (f.existingDefaultSubdomain = false)], ["plan", (f) => (f.existingPlanId = "g2-big")], ["platform", (f) => (f.existingPlatform = "node")],
    ];
    for (const [name, mutate] of facets) {
      const { h } = await setup();
      const v = await propose(h);
      mutate(h.fake);
      expect(await code(approve(h, v)), name).toBe("live_blocked_drift");
      expect(h.fake.calls, name).toEqual([]);
    }
  });
  it("a fresh proposal after the recreation binds the NEW instance and works; the old proposal id stays dead", async () => {
    const { h } = await setup();
    const old = await propose(h);
    recreate(h.fake);
    h.fake.releaseIds.push("rel_first_on_new_app");
    expect(await code(approve(h, old))).toBe("live_blocked_drift");
    const fresh = await propose(h);
    expect(fresh.proposal.existing).toMatchObject({ instanceId: "inst_0002_recreated", releaseTotal: 1 });
    expect(fresh.proposal.digest).not.toBe(old.proposal.digest);
    await approve(h, fresh);
    expect((await settle(h, (await h.svc.execute(fresh.proposal.id, OWNER, h.zip)).id)).state).toBe("DEPLOYED");
    expect(await code(approve(h, old))).toBe("live_already_decided");
  });
  it("a baseline change between approval and execution (someone else deployed) stops the run before any write", async () => {
    const { h } = await setup();
    const v = await propose(h);
    await approve(h, v);
    h.fake.releaseIds.push("rel_someone_else");
    const final = await settle(h, (await h.svc.execute(v.proposal.id, OWNER, h.zip)).id);
    expect(final.state).toBe("FAILED");
    expect(final.failure!.code).toMatch(/preflight_drift|existing_baseline_changed/);
    expect(h.fake.calls).toEqual([]);
  });
  it("an application that reports NO instance id and NO creation time cannot be bound: blocked", async () => {
    const { h } = await setup();
    h.fake.existingInstanceId = null;
    h.fake.existingCreatedAt = null;
    expect(await code(propose(h))).toBe("live_prerequisite_missing:instance_identifiable");
    expect(h.fake.calls).toEqual([]);
  });
  it("baseline unreadable ⇒ no proposal", async () => {
    const { h } = await setup();
    h.fake.baselineOk = false;
    expect(await code(propose(h))).toBe("live_prerequisite_missing:release_baseline_unreadable");
  });
  it("tampering with the stored instance binding is detected", async () => {
    const { h } = await setup();
    const v = await propose(h);
    (h.store as unknown as { __tamperLiveProposal: (id: string, p: Record<string, unknown>) => void }).__tamperLiveProposal(v.proposal.id, { existing: { ...v.proposal.existing, instanceId: "inst_forged" } });
    expect(["live_tampered", "live_not_found"]).toContain((await code(approve(h, v))) ?? "none");
    expect(h.fake.calls).toEqual([]);
  });
});

describe("deployment health marker and domain settings are validated (without touching .env.local)", () => {
  const facts = (over: Partial<ExistingFacts> = {}): ExistingFacts => ({ name: APP, planId: "g2-small", platform: "next", scale: 1, instanceId: "i", createdAt: "2026-10-20T08:00:00.000Z", networkId: "net_1", defaultSubdomain: true, baseline: { currentRelease: "r1", total: 1 }, ...over });
  const checks = (f: ExistingFacts, cfg: { suffixes: string[]; healthPath?: string; healthMarker: string | null }) => buildExistingChecks({ facts: f, sourcePlatform: "next", config: { suffixes: cfg.suffixes, healthPath: cfg.healthPath ?? "/health", healthMarker: cfg.healthMarker } });
  const blocked = (c: ReturnType<typeof checks>) => c.filter((x) => x.status === "blocked").map((x) => x.id);
  it("expected default suffix follows the official CLI rule: network ⇒ liara.run, no network ⇒ iran.liara.run", () => {
    expect(expectedDefaultSuffix("net_1")).toBe("liara.run");
    expect(expectedDefaultSuffix(null)).toBe("iran.liara.run");
    expect(blocked(checks(facts(), { suffixes: ["liara.run"], healthMarker: "liara-agent-demo" }))).toEqual([]);
    expect(blocked(checks(facts({ networkId: null }), { suffixes: ["iran.liara.run"], healthMarker: "liara-agent-demo" }))).toEqual([]);
    expect(blocked(checks(facts({ networkId: null }), { suffixes: ["liara.run"], healthMarker: "liara-agent-demo" }))).toContain("domain_suffix_expected");
    expect(blocked(checks(facts(), { suffixes: ["iran.liara.run"], healthMarker: "liara-agent-demo" }))).toContain("domain_suffix_expected");
    expect(blocked(checks(facts(), { suffixes: [], healthMarker: "liara-agent-demo" }))).toEqual(expect.arrayContaining(["domain_suffix_expected", "probe_host_valid"]));
  });
  it("the probe only ever uses the FIRST suffix, so a wrong first suffix is a blocker even if a right one follows", () => {
    expect(blocked(checks(facts(), { suffixes: ["example.com", "liara.run"], healthMarker: "liara-agent-demo" }))).toContain("domain_suffix_expected");
  });
  it("the marker must be specific: 'ok', 'healthy', short or punctuation-only markers are refused; the demo marker passes", () => {
    for (const m of [null, "", "ok", "healthy", "true", "status", "1234567", "!!!!!!!!!", "{}"]) expect(markerIsSpecific(m), String(m)).toBe(false);
    for (const m of ["liara-agent-demo", '"app":"liara-agent-demo"']) expect(markerIsSpecific(m), m).toBe(true);
    expect(blocked(checks(facts(), { suffixes: ["liara.run"], healthMarker: "ok" }))).toContain("health_marker_specific");
    expect(blocked(checks(facts(), { suffixes: ["liara.run"], healthMarker: null }))).toContain("health_marker_specific");
  });
  it("default subdomain disabled, invalid path, stopped app, wrong platform, unidentifiable instance each block", () => {
    const good = { suffixes: ["liara.run"], healthMarker: "liara-agent-demo" };
    expect(blocked(checks(facts({ defaultSubdomain: false }), good))).toContain("default_subdomain");
    expect(blocked(checks(facts(), { ...good, healthPath: "/a/../b" }))).toContain("health_path_valid");
    expect(blocked(checks(facts({ scale: 0 }), good))).toContain("app_running");
    expect(blocked(checks(facts({ platform: "node" }), good))).toContain("platform_matches");
    expect(blocked(checks(facts({ instanceId: null, createdAt: null }), good))).toContain("instance_identifiable");
    expect(checks(facts({ baseline: { currentRelease: null, total: 0 } }), good).find((c) => c.id === "release_baseline")!.detailFa).toMatch(/هیچ نسخه/);
  });
  it("the real demo fixture's /health body contains the recommended marker; offline validation reports the exact probe host", () => {
    const route = readFileSync(path.resolve(__dirname, "../../fixtures/demo-app/app/health/route.js"), "utf8");
    const body = JSON.stringify({ status: "ok", app: "liara-agent-demo", version: "1" });
    expect(route).toContain('app: "liara-agent-demo"');
    for (const marker of ["liara-agent-demo", '"app":"liara-agent-demo"']) expect(body).toContain(marker);
    expect(validateHealthSettings({ appName: APP, suffixes: ["liara.run"], healthPath: "/health", healthMarker: "liara-agent-demo" })).toMatchObject({ probeHost: "liara-agent-demo.liara.run", firstSuffixIsKnownDefault: true, pathValid: true, markerSpecific: true });
    expect(validateHealthSettings({ appName: APP, suffixes: [], healthPath: "/health", healthMarker: null })).toMatchObject({ probeHost: null, markerSpecific: false });
  });
  it("proposal creation enforces the same checks (wrong suffix / generic marker ⇒ refused, zero writes)", async () => {
    const a = await setup({ env: { LIARA_APP_DOMAIN_SUFFIXES: "iran.liara.run" } }); // the fake app HAS a network ⇒ liara.run expected
    expect(await code(propose(a.h))).toBe("live_prerequisite_missing:domain_suffix_expected");
    const b = await setup({ env: { LIARA_LIVE_HEALTH_MARKER: "ok" } });
    expect(await code(propose(b.h))).toBe("live_prerequisite_missing:health_marker_specific");
    expect(a.h.fake.calls).toEqual([]);
  });
  it("validation reads configuration only: .env.local is never written by this code path", () => {
    const envLocal = path.resolve(__dirname, "../../.env.local");
    if (!existsSync(envLocal)) return;
    const before = createHash("sha256").update(readFileSync(envLocal)).digest("hex");
    validateHealthSettings({ appName: APP, suffixes: ["liara.run"], healthPath: "/health", healthMarker: "liara-agent-demo" });
    expect(createHash("sha256").update(readFileSync(envLocal)).digest("hex")).toBe(before);
  });
});

describe("the three modes are distinct in the status document", () => {
  it("simulation (mock data) · live disabled (real read-only) · live enabled (write path ready)", async () => {
    const live = await setup();
    expect((await live.h.svc.status(OWNER, live.h.runId)).mode.kind).toBe("live_enabled");
    const off = await harness({ env: { LIARA_LIVE_DEPLOY_ENABLED: "false" } });
    expect((await off.svc.status(OWNER, off.runId)).mode).toMatchObject({ kind: "live_disabled", liveFlag: false, writePathReady: false });
    const sim = await harness({ env: { LIARA_LIVE_DEPLOY_ENABLED: "false", LIARA_DATA_SOURCE: "mock", LIARA_ALLOWED_APPS: undefined } });
    expect((await sim.svc.status(OWNER, sim.runId)).mode).toMatchObject({ kind: "simulation", dataSource: "mock" });
  });
  it("with live execution disabled an existing-app proposal is refused and no write path is reachable", async () => {
    const off = await harness({ env: { LIARA_LIVE_DEPLOY_ENABLED: "false" }, noTransport: true });
    off.fake.apps.add(APP);
    expect(await code(propose(off))).toBe("live_execution_disabled");
    expect(off.fake.calls).toEqual([]);
  });
});
