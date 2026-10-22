import { describe, expect, it } from "vitest";
import { isLiveError } from "@/server/live/types";
import { assertNoCanary, CANARY } from "../helpers/canaries";
import { FakeProcessRunner, makeCliBackend, makeFakeCliPackage } from "../helpers/fake-cli";
import { FakeLiara, harness, OWNER, settle, TEAM } from "../helpers/live-exec";

const APP = "liara-agent-demo";
const code = async (p: Promise<unknown>) => {
  try {
    await p;
    return null;
  } catch (e) {
    return isLiveError(e) ? `${e.code}${e.detail.length ? ":" + e.detail.join(",") : ""}` : "other";
  }
};
type H = Awaited<ReturnType<typeof harness>>;

async function setup(backend: "api" | "cli", o: { env?: Record<string, string | undefined>; noTransport?: boolean; withCli?: boolean } = {}) {
  const runner = new FakeProcessRunner();
  const pkg = makeFakeCliPackage();
  const cli = o.withCli === false ? null : makeCliBackend(runner, pkg).backend;
  const h = await harness({ env: o.env, noTransport: o.noTransport ?? backend === "cli", cli });
  h.fake.apps.add(APP); // created by hand in the console
  h.fake.releaseIds.push("rel_old_1"); // the app already has a release
  runner.onRun = () => void h.fake.releaseIds.push("rel_cli_new_1"); // what the real CLI would do remotely
  return { h, runner, pkg };
}
const propose = (h: H, backend: "api" | "cli", over: Partial<{ appName: string; zip: Buffer }> = {}) => h.svc.createExistingProposal(OWNER, { runId: h.runId, appName: over.appName ?? APP, backend, zip: over.zip ?? h.zip });
const approve = (h: H, v: { proposal: { id: string; digest: string; appName: string } }, extra: Record<string, unknown> = {}) => h.svc.decide(v.proposal.id, OWNER, { decision: "approve", digest: v.proposal.digest, confirmAppName: v.proposal.appName, ...extra });
async function deployExisting(h: H, backend: "api" | "cli") {
  const v = await propose(h, backend);
  await approve(h, v);
  const op = await h.svc.execute(v.proposal.id, OWNER, h.zip);
  return { v, final: await settle(h, op.id) };
}
const ops = (f: FakeLiara) => f.calls.map((c) => c.op);

describe("deploy to an EXISTING application — REST backend (recording fake transport)", () => {
  it("proposal binds the existing app's real identity; no create request is ever sent; DEPLOYED only after full verification", async () => {
    const { h } = await setup("api");
    const v = await propose(h, "api");
    expect(v.proposal).toMatchObject({ kind: "deploy_existing_app", backend: "api", cli: null, appName: APP, planId: "g2-small", bundlePlanId: "existing", networkId: "existing", teamId: TEAM, status: "PENDING", environment: "live", executionMode: "live" });
    expect(v.operation).toMatchObject({ kind: "deploy_existing_app", backend: "api", state: "AWAITING_LIVE_APPROVAL" });
    expect(h.fake.calls).toEqual([]);
    const d = await approve(h, v); // no financial acknowledgment is required: nothing new is created
    expect(d.proposal.status).toBe("APPROVED");
    const op = await h.svc.execute(v.proposal.id, OWNER, h.zip);
    const final = await settle(h, op.id);
    expect(final.state).toBe("DEPLOYED");
    expect(ops(h.fake)).toEqual(["uploadSource", "createRelease"]); // NEVER createApp
    expect(final.steps[0]).toMatchObject({ name: "create_application", status: "done", outcome: "existing_app_verified" });
    expect(final.transitions.map((t) => t.to)).toEqual(["PREFLIGHT", "AWAITING_LIVE_APPROVAL", "APPROVED", "APPLICATION_CREATED", "UPLOADING_SOURCE", "SOURCE_UPLOADED", "CREATING_RELEASE", "RELEASE_CREATED", "VERIFYING_DEPLOYMENT", "DEPLOYED"]);
    expect(Object.values(final.ladder)).toEqual(["ok", "ok", "ok", "ok", "ok", "ok"]);
    expect(h.store.scopeHas(TEAM, APP)).toBe(false); // a release never extends the scope: the operator allowlisted the app
    expect((await h.store.bootstrapScope(final.id, "2026-01-02T00:00:00.000Z"))).toEqual({ ok: false, reason: "not_a_creation" });
  });
  it("the typed application name is still mandatory", async () => {
    const { h } = await setup("api");
    const v = await propose(h, "api");
    expect(await code(approve(h, v, { confirmAppName: "wrong" }))).toBe("live_confirmation_required");
    expect(h.fake.calls).toEqual([]);
  });
  it("proposal is refused (zero writes) when the target is missing, out of scope, stopped, unidentifiable, or the list cannot be read", async () => {
    const cases: [string, (f: FakeLiara) => void, string][] = [
      ["missing", (f) => f.apps.delete(APP), "existing_app_missing"],
      ["not in scope (the operator did not allowlist it)", (f) => f.scope.delete(APP), "existing_app_not_in_scope"],
      ["stopped (scale 0)", (f) => (f.appScale = 0), "existing_app_not_running"],
      ["wrong reported name", (f) => (f.identity = "wrong_name"), "existing_identity_unverified"],
      ["no reported name", (f) => (f.identity = "no_name"), "existing_identity_unverified"],
      ["unreadable identity", (f) => (f.identity = "unreadable"), "existing_identity_unverified"],
      ["plan unknown", (f) => (f.existingPlanId = null), "existing_plan_unknown"],
      ["platform mismatch (the app is not a Next.js app)", (f) => (f.existingPlatform = "node"), "existing_platform_mismatch"],
      ["inventory unreadable", (f) => (f.nameListOk = false), "name_unverifiable"],
    ];
    for (const [name, mutate, expected] of cases) {
      const { h } = await setup("api");
      mutate(h.fake);
      expect(await code(propose(h, "api")), name).toBe(`live_prerequisite_missing:${expected}`);
      expect(h.fake.calls, name).toEqual([]);
    }
  });
  it("prerequisites: live flag, attestation of the CLI-only release fields, health domain/marker and the REST transport — each independently blocks", async () => {
    const env: [Record<string, string | undefined>, string][] = [
      [{ LIARA_LIVE_CONTRACT_ATTESTED: "false" }, "contract_attested"],
      [{ LIARA_APP_DOMAIN_SUFFIXES: undefined }, "app_domain_suffix"],
      [{ LIARA_LIVE_HEALTH_MARKER: undefined }, "health_marker"],
    ];
    for (const [e, id] of env) {
      const { h } = await setup("api", { env: e });
      expect(await code(propose(h, "api")), id).toContain(id);
      expect(h.fake.calls).toEqual([]);
    }
    const noTransport = await setup("api", { noTransport: true, withCli: false });
    expect(await code(propose(noTransport.h, "api"))).toBe("live_execution_disabled");
    // NOT needed for an existing app: plan units, network id (nothing is created and the plan is untouched)
    const lean = await setup("api", { env: { LIARA_PLAN_UNITS_JSON: undefined, LIARA_NETWORK_ID: undefined, LIARA_ALLOW_UNDOCUMENTED_ENDPOINTS: "false" } });
    expect((await propose(lean.h, "api")).proposal.status).toBe("PENDING");
  });
  it("drift between proposal and approval (app stopped, plan changed, app gone, identity changed, out of scope) voids the approval", async () => {
    const drifts: [string, (f: FakeLiara) => void][] = [["stopped", (f) => (f.appScale = 0)], ["plan changed", (f) => (f.existingPlanId = "g2-big")], ["gone", (f) => f.apps.delete(APP)], ["identity changed", (f) => (f.identity = "wrong_name")], ["left the scope", (f) => f.scope.delete(APP)], ["platform changed", (f) => (f.existingPlatform = "node")]];
    for (const [name, mutate] of drifts) {
      const { h } = await setup("api");
      const v = await propose(h, "api");
      mutate(h.fake);
      expect(await code(approve(h, v)), name).toBe("live_blocked_drift");
      expect(h.fake.calls, name).toEqual([]);
    }
  });
  it("drift between approval and execution fails BEFORE any write (identity re-proven at the first step)", async () => {
    for (const [name, mutate, failure] of [["stopped", (f: FakeLiara) => (f.appScale = 0), /preflight_drift|existing_app_not_running/], ["plan changed", (f: FakeLiara) => (f.existingPlanId = "g2-big"), /preflight_drift|preflight_plan_blocked|existing_identity_mismatch/], ["gone", (f: FakeLiara) => f.apps.delete(APP), /existing_app_missing/]] as const) {
      const { h } = await setup("api");
      const v = await propose(h, "api");
      await approve(h, v);
      mutate(h.fake);
      const final = await settle(h, (await h.svc.execute(v.proposal.id, OWNER, h.zip)).id);
      expect(final.state, name).toBe("FAILED");
      expect(final.failure!.code, name).toMatch(failure);
      expect(h.fake.calls, name).toEqual([]);
    }
  });
  it("an existing-app operation does not own the app name after it ended: a second release can be proposed; an unresolved review still holds the slot", async () => {
    const { h } = await setup("api");
    expect((await deployExisting(h, "api")).final.state).toBe("DEPLOYED");
    expect((await propose(h, "api")).proposal.status).toBe("PENDING");
    const b = await setup("api");
    b.h.fake.upload = "timeout";
    expect((await deployExisting(b.h, "api")).final.state).toBe("NEEDS_OPERATOR_REVIEW");
    expect(await code(propose(b.h, "api"))).toBe("live_operation_in_progress"); // unresolved review keeps the slot
  });
  it("unknown outcomes keep the Phase 2A/2B rules: a timed-out upload is never repeated, the app is preserved", async () => {
    const { h } = await setup("api");
    h.fake.upload = "timeout";
    const { final } = await deployExisting(h, "api");
    expect(final.state).toBe("NEEDS_OPERATOR_REVIEW");
    expect(ops(h.fake)).toEqual(["uploadSource"]);
    expect(h.fake.apps.has(APP)).toBe(true);
  });
  it("replay of an approved/consumed proposal and a simulation id are refused; another session cannot use the approval", async () => {
    const { h } = await setup("api");
    const { v } = await deployExisting(h, "api");
    const n = h.fake.calls.length;
    expect(await code(approve(h, v))).toBe("live_already_decided");
    expect(await code(h.svc.execute(v.proposal.id, OWNER, h.zip))).toBe("live_not_approved");
    expect(h.fake.calls.length).toBe(n);
    const other = await setup("api");
    const v2 = await propose(other.h, "api");
    await approve(other.h, v2);
    expect(await code(other.h.svc.execute(v2.proposal.id, "someone-else", other.h.zip))).toBe("live_not_found");
  });
  it("tampering with the kind or backend of a stored proposal is detected", async () => {
    for (const patch of [{ kind: "create_new_app" }, { backend: "cli" }, { cli: { version: "9.6.0", entrySha256: "a".repeat(64), argvDigest: "b".repeat(64), manifestDigest: "c".repeat(64) } }]) {
      const { h } = await setup("api");
      const v = await propose(h, "api");
      (h.store as unknown as { __tamperLiveProposal: (id: string, p: Record<string, unknown>) => void }).__tamperLiveProposal(v.proposal.id, patch);
      expect(["live_tampered", "live_not_found"]).toContain((await code(approve(h, v))) ?? "none");
      expect(h.fake.calls).toEqual([]);
    }
  });
  it("the create flow is untouched: it still refuses an existing name", async () => {
    const { h } = await setup("api");
    expect(await code(h.svc.createProposal(OWNER, { runId: h.runId, planId: "g2-small", bundlePlanId: null, appName: APP, zip: h.zip }))).toBe("live_duplicate_app");
  });
});

describe("deploy to an EXISTING application — official CLI backend (fake process runner, NO REST write client at all)", () => {
  it("proposal binds tool identity, exact argv template and the exact file manifest; execution runs the CLI once; the outcome is established by reading, not by the exit code", async () => {
    const { h, runner, pkg } = await setup("cli");
    expect(h.svc.gate().enabled).toBe(true);
    expect(h.svc.executor).not.toBeNull();
    const v = await propose(h, "cli");
    expect(v.proposal).toMatchObject({ kind: "deploy_existing_app", backend: "cli", appName: APP });
    expect(v.proposal.cli).toMatchObject({ version: "9.6.0", entrySha256: pkg.sha256 });
    expect(v.proposal.cli!.argvDigest).toMatch(/^[0-9a-f]{64}$/);
    expect(v.proposal.cli!.manifestDigest).toMatch(/^[0-9a-f]{64}$/);
    expect(runner.calls).toHaveLength(0); // proposing and approving never start a process
    await approve(h, v);
    expect(runner.calls).toHaveLength(0);
    const op = await h.svc.execute(v.proposal.id, OWNER, h.zip);
    const final = await settle(h, op.id);
    expect(final.state).toBe("DEPLOYED");
    expect(final.remote.releaseId).toBe("rel_cli_new_1");
    expect(runner.calls).toHaveLength(1);
    expect(h.fake.calls).toEqual([]); // zero REST writes
    const c = runner.calls[0]!;
    expect(c.spec.args.slice(1, 9)).toEqual(["deploy", "--app", APP, "--platform", "next", "--port", "3000", "--path"]);
    expect(c.spec.args).toEqual(expect.arrayContaining(["--detach", "--no-app-logs", "--team-id", TEAM, "--message", `agent-op-${op.id}`]));
    expect(c.spec.args.join(" ")).not.toMatch(/token/i);
    expect(final.transitions.map((t) => t.to)).toEqual(["PREFLIGHT", "AWAITING_LIVE_APPROVAL", "APPROVED", "APPLICATION_CREATED", "UPLOADING_SOURCE", "SOURCE_UPLOADED", "CREATING_RELEASE", "RELEASE_CREATED", "VERIFYING_DEPLOYMENT", "DEPLOYED"]);
    expect(final.steps.find((s) => s.name === "upload_source")!.outcome).toBe("uploaded_by_cli_inferred");
    expect(final.steps.find((s) => s.name === "create_release")!.outcome).toBe("release_observed_after_cli");
    expect(h.store.scopeHas(TEAM, APP)).toBe(false);
    const audit = (await h.store.readAudit(500)).filter((r) => r.event.startsWith("live.cli_deploy"));
    expect(audit.map((r) => r.event)).toEqual(["live.cli_deploy_attempt", "live.cli_deploy_result"]);
    assertNoCanary(JSON.stringify([final, audit, await h.store.readAudit(500)]));
    expect(await h.store.verifyAudit()).toMatchObject({ ok: true });
  });
  it("the token reaches the process ONLY through the private 0600 auth file: not in argv, not in env, not in the audit trail, not in the operation record", async () => {
    const { h, runner } = await setup("cli");
    runner.result = { exitCode: 0, stdout: `debug token=${CANARY.token}\n` };
    const { final } = await deployExisting(h, "cli");
    const c = runner.calls[0]!;
    expect(JSON.stringify(c.spec)).not.toContain(CANARY.token);
    expect(c.authFile).toMatchObject({ exists: true, mode: 0o600 });
    expect(JSON.stringify(c.authFile.json)).toContain(CANARY.token);
    const everything = JSON.stringify([final, await h.store.readAudit(500), await h.svc.status(OWNER, h.runId)]);
    expect(everything).not.toContain(CANARY.token);
  });
  it("CLI exit code is never proof: non-zero exit but a NEW release exists ⇒ adopted and verified; exit 0 but nothing new ⇒ review", async () => {
    const a = await setup("cli");
    a.runner.result = { exitCode: 7, stderr: "something failed after the release was created" };
    expect((await deployExisting(a.h, "cli")).final.state).toBe("DEPLOYED");
    const b = await setup("cli");
    b.runner.onRun = () => undefined;
    const { final } = await deployExisting(b.h, "cli");
    expect(final.state).toBe("NEEDS_OPERATOR_REVIEW");
    expect(final.failure!.code).toBe("cli_zero_no_release");
    expect(b.runner.calls).toHaveLength(1);
  });
  it("non-zero exit and nothing new ⇒ FAILED (an observation, with the app preserved); timeout ⇒ review (unknown); timeout but a release appeared ⇒ adopted", async () => {
    const a = await setup("cli");
    a.runner.onRun = () => undefined;
    a.runner.result = { exitCode: 1, stderr: "boom" };
    const fa = (await deployExisting(a.h, "cli")).final;
    expect(fa.state).toBe("FAILED");
    expect(fa.failure!.code).toBe("cli_nonzero_no_release");
    expect(fa.remote.appConfirmed).toBe(true);
    expect(a.h.fake.apps.has(APP)).toBe(true);
    const b = await setup("cli");
    b.runner.onRun = () => undefined;
    b.runner.result = { exitCode: null, signal: "SIGKILL", timedOut: true };
    const fb = (await deployExisting(b.h, "cli")).final;
    expect(fb.state).toBe("NEEDS_OPERATOR_REVIEW");
    expect(fb.failure!.code).toBe("cli_timeout");
    const c = await setup("cli");
    c.runner.result = { exitCode: null, signal: "SIGKILL", timedOut: true };
    expect((await deployExisting(c.h, "cli")).final.state).toBe("DEPLOYED");
  });
  it("two new releases are never guessed; an unreadable list ⇒ review; spawn failure ⇒ FAILED with nothing sent", async () => {
    const a = await setup("cli");
    a.runner.onRun = () => void a.h.fake.releaseIds.push("rel_x_1", "rel_x_2");
    const fa = (await deployExisting(a.h, "cli")).final;
    expect(fa.state).toBe("NEEDS_OPERATOR_REVIEW");
    expect(fa.failure!.code).toBe("cli_release_ambiguous");
    const b = await setup("cli");
    b.runner.result = { exitCode: null, spawnError: "ENOENT" };
    b.runner.onRun = () => undefined;
    const fb = (await deployExisting(b.h, "cli")).final;
    expect(fb.state).toBe("FAILED");
    expect(fb.failure!.code).toBe("cli_spawn_failed");
  });
  it("the CLI is never run again: re-verification is read-only and abandon keeps the app", async () => {
    const { h, runner } = await setup("cli");
    runner.onRun = () => undefined;
    const { final } = await deployExisting(h, "cli");
    expect(final.state).toBe("NEEDS_OPERATOR_REVIEW");
    await h.svc.resolve(final.id, OWNER, "reverify");
    await h.svc.resolve(final.id, OWNER, "reverify");
    expect(runner.calls).toHaveLength(1);
    const ab = await h.svc.resolve(final.id, OWNER, "abandon");
    expect(ab.state).toBe("FAILED");
    expect(runner.calls).toHaveLength(1);
    expect(h.fake.apps.has(APP)).toBe(true);
  });
  it("baseline unreadable ⇒ FAILED before the process starts; a runner that explodes ⇒ refused/cleaned, nothing else is attempted", async () => {
    const a = await setup("cli");
    const orig = a.h.fake.reader.getReleases;
    let calls = 0;
    a.h.fake.reader.getReleases = async (n) => (++calls <= 0 ? orig(n) : { ok: false, code: "upstream_error" });
    const fa = (await deployExisting(a.h, "cli")).final;
    expect(fa.state).toBe("FAILED");
    expect(fa.failure!.code).toBe("baseline_unreadable");
    expect(a.runner.calls).toHaveLength(0);
    const b = await setup("cli");
    b.runner.throwOnRun = true;
    const fb = (await deployExisting(b.h, "cli")).final;
    expect(["FAILED", "NEEDS_OPERATOR_REVIEW"]).toContain(fb.state);
    expect(b.runner.calls).toHaveLength(1);
  });
  it("without the CLI backend the cli proposal does not exist; the REST proposal still works; a flag alone is never enough", async () => {
    const { h } = await setup("cli", { withCli: false, noTransport: false });
    expect(await code(propose(h, "cli"))).toMatch(/live_prerequisite_missing:cli_backend_enabled,cli_identity_verified/);
    const off = await setup("cli", { env: { LIARA_LIVE_DEPLOY_ENABLED: "false" } });
    expect(await code(propose(off.h, "cli"))).toBe("live_execution_disabled");
    expect(off.runner.calls).toHaveLength(0);
    expect(await code(propose((await setup("cli")).h, "docker" as never))).toBe("live_binding_mismatch:backend");
  });
  it("the pinned tool changing after the proposal voids the approval; changing after approval stops the run before any process", async () => {
    const a = await setup("cli");
    const v = await propose(a.h, "cli");
    a.pkg.rewriteEntry("// tampered after the proposal");
    expect(await code(approve(a.h, v))).toMatch(/live_prerequisite_missing|live_blocked_drift/);
    expect(a.runner.calls).toHaveLength(0);
    const b = await setup("cli");
    const v2 = await propose(b.h, "cli");
    await approve(b.h, v2);
    b.pkg.rewriteEntry("// swapped after approval");
    const op = await b.h.svc.execute(v2.proposal.id, OWNER, b.h.zip);
    const final = await settle(b.h, op.id);
    expect(["FAILED", "NEEDS_OPERATOR_REVIEW"]).toContain(final.state);
    expect(b.runner.calls).toHaveLength(0);
    expect(b.h.fake.calls).toEqual([]);
  });
  it("a different ZIP at execution is refused with zero process runs (artifact digest bound)", async () => {
    const { h, runner } = await setup("cli");
    const v = await propose(h, "cli");
    await approve(h, v);
    const { demoZip } = await import("../helpers/live-exec");
    expect(await code(h.svc.execute(v.proposal.id, OWNER, demoZip({ "README.md": "different" })))).toBe("live_artifact_mismatch:zip_sha256");
    expect(runner.calls).toHaveLength(0);
  });
  it("concurrent executions start ONE process; a second approval attempt cannot double-run", async () => {
    const { h, runner } = await setup("cli");
    const v = await propose(h, "cli");
    await approve(h, v);
    const rs = await Promise.allSettled(Array.from({ length: 5 }, () => h.svc.execute(v.proposal.id, OWNER, h.zip)));
    expect(rs.filter((r) => r.status === "fulfilled")).toHaveLength(1);
    await settle(h, v.operation!.id);
    expect(runner.calls).toHaveLength(1);
  });
  it("verification after the CLI is the same ladder: a failed release state ⇒ FAILED, never DEPLOYED", async () => {
    const { h } = await setup("cli");
    h.fake.releaseStates = ["DEPLOYING", "FAILED"];
    const { final } = await deployExisting(h, "cli");
    expect(final.state).toBe("FAILED");
    expect(final.failure!.code).toBe("verification_failed");
  });
});
