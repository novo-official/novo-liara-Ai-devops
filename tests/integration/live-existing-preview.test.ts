import { describe, expect, it } from "vitest";
import { isLiveError } from "@/server/live/types";
import { redactDeep } from "@/server/security/redact";
import { assertNoCanary } from "../helpers/canaries";
import { demoZip, harness, OTHER, OWNER } from "../helpers/live-exec";

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
const prev = (h: H, over: Partial<{ appName: string; zip: Buffer; backend: "api" | "cli"; session: string }> = {}) => h.svc.previewExisting(over.session ?? OWNER, { runId: h.runId, appName: over.appName ?? APP, backend: over.backend ?? "api", zip: over.zip ?? h.zip });
async function setup(env: Record<string, string | undefined> = {}) {
  const h = await harness({ env: { LIARA_ALLOWED_APPS: APP, ...env } });
  h.fake.apps.add(APP);
  h.fake.releaseIds.push("rel_old_1");
  return h;
}

describe("offline preview of an existing-app release", () => {
  it("binds the fresh artifact, reads the target read-only, persists nothing and writes nothing", async () => {
    const h = await setup();
    const p = await prev(h);
    expect(p).toMatchObject({ appName: APP, backend: "api", persisted: false, note: "preview_only_not_an_approval", targetReady: true, executable: true, platform: "next" });
    expect(p.artifact.zipSha256).toMatch(/^[0-9a-f]{64}$/);
    expect(p.artifact.artifactDigest).toMatch(/^[0-9a-f]{64}$/);
    expect(p.artifact.analysisDigest).toMatch(/^[0-9a-f]{64}$/);
    expect(p.target).toMatchObject({ checked: true, blocked: [] });
    expect(h.fake.calls).toEqual([]); // no createApp / uploadSource / createRelease
    const st = await h.svc.status(OWNER, h.runId);
    expect(st.proposals).toEqual([]); // no proposal and no operation was created
  });
  it("works while live execution is DISABLED (no live flag, no attestation): target readiness and execution prerequisites are reported separately", async () => {
    const h = await setup({ LIARA_LIVE_DEPLOY_ENABLED: "false", LIARA_LIVE_CONTRACT_ATTESTED: "false" });
    const p = await prev(h);
    expect(p.targetReady).toBe(true);
    expect(p.executable).toBe(false);
    expect(p.executionBlockers).toEqual(expect.arrayContaining(["live_flag", "contract_attested"]));
    expect(h.fake.calls).toEqual([]);
    // …and the real proposal path stays closed
    expect(await code(h.svc.createExistingProposal(OWNER, { runId: h.runId, appName: APP, backend: "api", zip: h.zip }))).toBe("live_execution_disabled");
  });
  it("a preview is not an approval: nothing it returns can be used to decide or execute", async () => {
    const h = await setup();
    const p = await prev(h);
    expect(await code(h.svc.decide(p.artifact.zipSha256, OWNER, { decision: "approve", digest: p.artifact.artifactDigest, confirmAppName: APP }))).toBe("live_not_found");
    expect(await code(h.svc.execute(p.artifact.artifactDigest, OWNER, h.zip))).not.toBeNull();
    expect(h.fake.calls).toEqual([]);
  });
  it("requires the FRESH artifact: a different ZIP, a modified analysed archive and another session are all refused", async () => {
    const h = await setup();
    expect(await code(prev(h, { zip: demoZip({ "README.md": "# changed" }) }))).toMatch(/^live_artifact_mismatch/);
    expect(await code(prev(h, { zip: Buffer.from("not a zip") }))).toMatch(/^live_artifact_(mismatch|rejected)/);
    expect(await code(prev(h, { session: OTHER }))).toBe("live_not_found");
    expect(h.fake.calls).toEqual([]);
  });
  it("target problems are REPORTED (not thrown): missing app, not in scope", async () => {
    const h = await setup();
    const missing = await prev(h, { appName: "no-such-app" });
    expect(missing.targetReady).toBe(false);
    expect(missing.target.blocked).toContain("existing_app_missing");
    expect(missing.executable).toBe(false);
    const h2 = await harness();
    h2.fake.apps.add(APP);
    h2.fake.scope.delete(APP); // the operator did NOT allowlist it
    expect((await prev(h2)).target.blocked).toContain("existing_app_not_in_scope");
  });
  it("a wrong health-check domain is a target blocker the operator sees before any approval", async () => {
    const h = await setup({ LIARA_APP_DOMAIN_SUFFIXES: "iran.liara.run" }); // the demo app has a network ⇒ liara.run
    const p = await prev(h);
    expect(p.targetReady).toBe(false);
    expect(p.target.blocked).toContain("domain_suffix_expected");
  });
  it("mock data source: the target is reported as not checked (offline), the artifact is still bound", async () => {
    const h = await setup({ LIARA_DATA_SOURCE: "mock", LIARA_LIVE_DEPLOY_ENABLED: "false", LIARA_LIVE_CONTRACT_ATTESTED: "false", LIARA_ALLOW_UNDOCUMENTED_ENDPOINTS: "false" });
    const p = await prev(h);
    expect(p.target).toMatchObject({ checked: false, reason: "data_source_not_live" });
    expect(p.targetReady).toBe(false);
    expect(p.executable).toBe(false);
    expect(p.artifact.artifactDigest).toMatch(/^[0-9a-f]{64}$/);
  });
  it("is deterministic (same inputs ⇒ same digests) and leaks no secret", async () => {
    const h = await setup();
    const a = await prev(h);
    const b = await prev(h);
    expect(b.artifact).toEqual(a.artifact);
    assertNoCanary(JSON.stringify(a));
  });
  it("what the API returns to the browser keeps the content digests readable (the redaction layer used to turn them into [REDACTED])", async () => {
    const h = await setup();
    const p = await prev(h);
    expect(JSON.stringify(redactDeep(p))).not.toContain("[REDACTED]");
    expect(redactDeep(p).artifact).toEqual(p.artifact);
    const v = await h.svc.createExistingProposal(OWNER, { runId: h.runId, appName: APP, backend: "api", zip: h.zip });
    expect(redactDeep(v).proposal.artifact).toEqual(v.proposal.artifact);
    expect(redactDeep(v).proposal.digest).toBe(v.proposal.digest);
  });
});
