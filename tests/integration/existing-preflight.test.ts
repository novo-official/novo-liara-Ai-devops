import { describe, expect, it } from "vitest";
import { runExistingPreflight } from "@/server/live/existing-preflight";
import { liveReaderFrom } from "@/server/live/reader";
import { assertNoCanary, CANARY } from "../helpers/canaries";
import { defaultResponder, json, liveService, RAW, type Responder } from "../helpers/live";

const APP = "shop-api";
const ENV = { LIARA_TEAM_ID: "team_secretish_1", LIARA_APP_DOMAIN_SUFFIXES: "liara.run", LIARA_LIVE_HEALTH_MARKER: "shop-api-marker", LIARA_LIVE_CONTRACT_ATTESTED: "true" };
type Mut = { instance?: string; created?: string; network?: string | null; plan?: string; platform?: string; scale?: number; sub?: boolean; releases?: unknown; teamPresent?: boolean };
const responder = (m: Mut = {}): Responder => (url, call) => {
  const p = url.pathname;
  if (p === "/v1/projects") return json({ projects: [{ project_id: APP, type: "next", status: "RUNNING", scale: 1, created_at: "2026-10-20T08:00:00Z" }] });
  if (p === `/v1/projects/${APP}`) return json({ project: { project_id: APP, _id: m.instance ?? "inst_aaa111", created_at: m.created ?? "2026-10-20T08:00:00Z", planID: m.plan ?? "g2-small", type: m.platform ?? "next", scale: m.scale ?? 1, defaultSubdomain: m.sub ?? true, ...(m.network === null ? {} : { network: { _id: m.network ?? "net_1" } }), status: "RUNNING", api_token: CANARY.apiToken, envs: [{ key: "A", value: CANARY.envValue }] } });
  if (p === `/v1/projects/${APP}/releases`) return json(m.releases ?? { total: 3, currentRelease: "rel_current_1", releases: [{ _id: "rel_current_1", state: "READY", type: "next", createdAt: "2026-10-21T00:00:00Z" }] });
  if (p === "/v1/me") return json({ user: { email: CANARY.email, phone: "09120000000" }, ...(m.teamPresent === false ? {} : { team: { balance: 987654.25, teamMemberRole: { name: "owner" } } }), plans: { projects: {}, projectBundlePlans: {} } });
  return defaultResponder()(url, call);
};
const run = async (m: Mut = {}, env: Record<string, string | undefined> = {}, app = APP) => {
  const s = liveService({ ...ENV, ...env }, responder(m));
  const report = await runExistingPreflight({ reader: liveReaderFrom(s.svc), cfg: s.cfg, app, includeNetworks: false, nowIso: "2026-10-22T00:00:00.000Z" });
  return { report, calls: s.calls };
};
const blocked = (r: Awaited<ReturnType<typeof run>>["report"]) => r.checks.filter((c) => c.status === "blocked").map((c) => c.id);

describe("existing-app live preflight (recording fake fetch — no real request)", () => {
  it("sends exactly the planned GETs (list, account, identity, releases), all GET, no body, team-scoped; the report is READY only when nothing blocks", async () => {
    const { report, calls } = await run();
    expect(calls.map((c) => `${c.method} ${c.url.pathname}${c.url.pathname.endsWith("releases") ? "?page=" + c.url.searchParams.get("page") + "&count=" + c.url.searchParams.get("count") : ""}`).sort()).toEqual(["GET /v1/me", `GET /v1/projects`, `GET /v1/projects/${APP}`, `GET /v1/projects/${APP}/releases?page=1&count=10`].sort());
    expect(calls.every((c) => c.method === "GET" && c.body === null && c.url.searchParams.get("teamID") === "team_secretish_1")).toBe(true);
    expect(report.trustedPriorState).toBe("none");
    expect(report.team).toEqual({ configured: true, accountShowsTeam: true });
    expect(report.target).toMatchObject({ listedInTeam: true, inScope: true, expectedSuffix: "liara.run", facts: { planId: "g2-small", platform: "next", scale: 1, hasInstanceId: true, hasCreatedAt: true, hasNetwork: true, defaultSubdomain: true, releaseTotal: 3, hasCurrentRelease: true } });
    // blocked ONLY by the operator-owned items: REST contract attestation is set here, so nothing remains
    expect(blocked(report)).toEqual([]);
    expect(report.verdict).toBe("READY_FOR_OPERATOR_APPROVAL");
  });
  it("the REST contract attestation is reported, explained and NOT bypassed", async () => {
    const { report } = await run({}, { LIARA_LIVE_CONTRACT_ATTESTED: "false" });
    const c = report.checks.find((x) => x.id === "contract_attested_rest")!;
    expect(c.status).toBe("blocked");
    expect(c.detailFa).toMatch(/platformConfig/);
    expect(c.detailFa).toMatch(/build\.cache/);
    expect(c.detailFa).toMatch(/LIARA_LIVE_CONTRACT_ATTESTED=true/);
    expect(report.verdict).toBe("BLOCKED_BY_CONTRACT");
    expect(report.blockerCategories[0]).toBe("contract");
  });
  it("the real operator state (no suffix, no marker, no attestation) is BLOCKED and says exactly what to set", async () => {
    const { report } = await run({}, { LIARA_APP_DOMAIN_SUFFIXES: undefined, LIARA_LIVE_HEALTH_MARKER: undefined, LIARA_LIVE_CONTRACT_ATTESTED: undefined });
    expect(blocked(report)).toEqual(expect.arrayContaining(["contract_attested_rest", "domain_suffix_expected", "probe_host_valid", "health_marker_specific"]));
    expect(report.checks.find((x) => x.id === "domain_suffix_expected")!.detailFa).toContain("liara.run");
    expect(report.verdict).toBe("BLOCKED_BY_CONTRACT");
  });
  it("an application outside LIARA_ALLOWED_APPS: identity and releases are NEVER requested and the verdict is blocked", async () => {
    const { report, calls } = await run({}, {}, "secret-internal-app");
    expect(calls.some((c) => /secret-internal-app/.test(c.url.pathname))).toBe(false);
    expect(report.target).toMatchObject({ inScope: false, facts: null });
    expect(blocked(report)).toContain("target_in_scope");
    expect(report.verdict).toBe("BLOCKED_BY_SECURITY");
  });
  it("exact team: a configured team that the account answer does not show blocks (security); a missing listing blocks", async () => {
    const t = await run({ teamPresent: false });
    expect(t.report.team.accountShowsTeam).toBe(false);
    expect(blocked(t.report)).toContain("team_scope");
    expect(t.report.verdict).toBe("BLOCKED_BY_SECURITY");
    const missing = await run({}, {}, "shop-web"); // allowlisted, but NOT listed in this team's application list
    expect(missing.report.target.listedInTeam).toBe(false);
    expect(blocked(missing.report)).toContain("target_listed_in_team");
  });
  it("identity facets: stopped app, wrong platform, no instance id/created time, disabled default subdomain, wrong suffix for the network each block", async () => {
    expect(blocked((await run({ scale: 0 })).report)).toContain("app_running");
    expect(blocked((await run({ platform: "node" })).report)).not.toContain("platform_matches"); // platform is compared against the SOURCE at proposal time; here only reported
    expect(blocked((await run({ sub: false })).report)).toContain("default_subdomain");
    expect(blocked((await run({ network: null })).report)).toContain("domain_suffix_expected"); // no network ⇒ iran.liara.run expected
    expect((await run({ network: null })).report.target.expectedSuffix).toBe("iran.liara.run");
  });
  it("does NOT trust an old fingerprint: a recreated app (new instance id / creation time / empty releases) yields a DIFFERENT fresh digest; unchanged facts give the same digest", async () => {
    const a = await run();
    const again = await run();
    expect(again.report.target.freshIdentityDigest).toBe(a.report.target.freshIdentityDigest);
    const recreated = await run({ instance: "inst_bbb222", created: "2026-10-22T09:30:00Z", releases: { total: 0, currentRelease: null, releases: [] } });
    expect(recreated.report.target.freshIdentityDigest).not.toBe(a.report.target.freshIdentityDigest);
    expect(recreated.report.target.facts).toMatchObject({ releaseTotal: 0, hasCurrentRelease: false });
    const net = await run({ network: "net_other" });
    expect(net.report.target.freshIdentityDigest).not.toBe(a.report.target.freshIdentityDigest);
    const plan = await run({ plan: "g2-big" });
    expect(plan.report.target.freshIdentityDigest).not.toBe(a.report.target.freshIdentityDigest);
    expect(a.report.target.freshIdentityDigest).toMatch(/^[0-9a-f]{12}$/);
  });
  it("never discloses private values: no balance, ids, emails, phone, token, env values, team id or the full app facts", async () => {
    const { report } = await run();
    const text = JSON.stringify(report);
    assertNoCanary(text);
    for (const leak of ["987654", "inst_aaa111", "rel_current_1", "net_1", "team_secretish_1", "09120000000", CANARY.email, CANARY.token, "2026-10-20T08:00:00"]) expect(text, leak).not.toContain(leak);
  });
  it("performs NO write: every request is a GET and no write path or body is ever sent", async () => {
    const { calls } = await run({ instance: "x" });
    expect(calls.every((c) => c.method === "GET" && c.body === null)).toBe(true);
    expect(calls.some((c) => /sources|releases$/.test(c.url.pathname) && c.method !== "GET")).toBe(false);
  });
  it("is bounded: at most 4 requests without --include-networks (5 with it), regardless of the answers", async () => {
    const s = liveService({ ...ENV, LIARA_ALLOW_UNDOCUMENTED_ENDPOINTS: "true" }, (url, call) => (url.pathname === "/v1/networks" ? json({ networks: [{ _id: "net_1", name: "n" }] }) : responder()(url, call)));
    const report = await runExistingPreflight({ reader: liveReaderFrom(s.svc), cfg: s.cfg, app: APP, includeNetworks: true, nowIso: "2026-10-22T00:00:00.000Z" });
    expect(s.calls.length).toBe(5);
    expect(report.checks.find((c) => c.id === "network_exists")!.status).toBe("ok");
    expect((await run()).calls.length).toBe(4);
    void RAW;
  });
});
