import { spawnSync } from "node:child_process";
import { mkdtempSync, readdirSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { describe, expect, it, afterAll } from "vitest";
import { CANARY } from "../helpers/canaries";
import { LIVE_ENV } from "../helpers/live";

/**
 * Runs the real operator scripts in a clean temp cwd (so no developer .env.local can leak in) and with a minimal
 * environment. None of these invocations may reach the network: they exercise the BLOCKED / not-approved paths.
 */
const ROOT = path.resolve(__dirname, "../..");
const work = mkdtempSync(path.join(tmpdir(), "liara-script-test-"));
afterAll(() => rmSync(work, { recursive: true, force: true }));

function run(script: string, args: string[], env: Record<string, string> = {}) {
  const r = spawnSync(path.join(ROOT, "node_modules/.bin/tsx"), ["--conditions=react-server", path.join(ROOT, "scripts", script), ...args], {
    cwd: work,
    env: { PATH: process.env.PATH ?? "", HOME: work, ...env } as unknown as NodeJS.ProcessEnv,
    encoding: "utf8",
    timeout: 60_000,
  });
  return { code: r.status, out: (r.stdout ?? "") + (r.stderr ?? "") };
}

const liveEnv = { ...LIVE_ENV, LIARA_API_TOKEN: CANARY.token } as Record<string, string>;

describe("npm run verify:liara-readonly (no network paths)", () => {
  it("is BLOCKED (exit 3, never PASSED) when not in live mode or without credentials", () => {
    const r = run("verify-liara-readonly.ts", ["--app=x"]);
    expect(r.code).toBe(3);
    expect(r.out).toMatch(/BLOCKED/);
    expect(r.out).not.toMatch(/overall\s*:\s*PASSED|VERIFICATION: PASSED/);
    expect(r.out).toMatch(/never switches from mock to live/);
  });

  it("is BLOCKED when live mode is requested but the configuration is incomplete", () => {
    const r = run("verify-liara-readonly.ts", ["--app=x"], { LIARA_DATA_SOURCE: "live" });
    expect(r.code).toBe(3);
    expect(r.out).toMatch(/BLOCKED/);
    expect(r.out).toMatch(/LIARA_API_TOKEN/);
  });

  it("requires an explicitly selected allowlisted app", () => {
    expect(run("verify-liara-readonly.ts", [], liveEnv).code).toBe(2);
    const bad = run("verify-liara-readonly.ts", ["--app=not-allowed-app"], liveEnv);
    expect(bad.code).toBe(2);
    expect(bad.out).toMatch(/not in LIARA_ALLOWED_APPS/);
  });

  it("without approval it prints the plan and sends NOTHING (dry run, exit 4), never printing secrets or app names", () => {
    const r = run("verify-liara-readonly.ts", ["--app=shop-api"], liveEnv);
    expect(r.code).toBe(4);
    expect(r.out).toMatch(/NOT APPROVED/);
    expect(r.out).toMatch(/no request was sent/);
    expect(r.out).toMatch(/GET \/v1\/projects/);
    expect(r.out).not.toContain(CANARY.token);
    expect(r.out).not.toMatch(/shop-api|shop-web/);
    expect(r.out).not.toMatch(/\bPOST|PUT|PATCH|DELETE\b/);
    expect(readdirSync(work)).not.toContain("fixtures"); // nothing was written
  });

  it("the undocumented v2 endpoint needs BOTH the flag and the environment opt-in", () => {
    const r = run("verify-liara-readonly.ts", ["--app=shop-api", "--include-v2", "--approve-live-readonly"], liveEnv);
    expect(r.code).toBe(2);
    expect(r.out).toMatch(/LIARA_ALLOW_UNDOCUMENTED_ENDPOINTS/);
    const planOnly = run("verify-liara-readonly.ts", ["--app=shop-api", "--include-v2"], { ...liveEnv, LIARA_ALLOW_UNDOCUMENTED_ENDPOINTS: "true" });
    expect(planOnly.code).toBe(4);
    expect(planOnly.out).toMatch(/UNDOCUMENTED/);
  });
});

describe("npm run verify:liara-readonly -- --account-only (no network paths)", () => {
  const acct = { ...liveEnv, LIARA_ALLOWED_APPS: "", APP_ACCESS_PASSWORD_HASH: "" } as Record<string, string>;
  it("works without an app allowlist or UI password: dry run prints the four GET checks and sends NOTHING (exit 4)", () => {
    const r = run("verify-liara-readonly.ts", ["--account-only"], acct);
    expect(r.code).toBe(4);
    expect(r.out).toMatch(/NOT APPROVED/);
    for (const e of ["GET /v1/projects", "GET /v1/me ", "GET /v1/me/subscription", "GET /v1/me/free-credit"]) expect(r.out).toContain(e);
    expect(r.out).toMatch(/allowlist size\s*: 0/);
    expect(r.out).not.toContain(CANARY.token);
    expect(r.out).not.toMatch(/\bPOST|PUT|PATCH|DELETE\b/);
    expect(r.out).not.toMatch(/\/projects\/\{app\}/); // no app-scoped endpoint is planned
    expect(readdirSync(work)).not.toContain("fixtures");
  });
  it("the normal app mode is still BLOCKED without an allowlist (the relaxation is account-only)", () => {
    const r = run("verify-liara-readonly.ts", ["--app=x"], acct);
    expect(r.code).toBe(3);
    expect(r.out).toMatch(/LIARA_ALLOWED_APPS is required/);
  });
  it("is still BLOCKED without a token and still refuses mutation/AI flags and untrusted hosts", () => {
    expect(run("verify-liara-readonly.ts", ["--account-only"], { ...acct, LIARA_API_TOKEN: "" }).code).toBe(3);
    const mut = run("verify-liara-readonly.ts", ["--account-only"], { ...acct, ENABLE_MUTATIONS: "true" });
    expect(mut.code).toBe(3);
    expect(mut.out).toMatch(/ENABLE_MUTATIONS/);
    expect(run("verify-liara-readonly.ts", ["--account-only"], { ...acct, AI_LIVE_REQUESTS_ENABLED: "true" }).code).toBe(3);
    expect(run("verify-liara-readonly.ts", ["--account-only"], { ...acct, LIARA_API_BASE_URL: "https://evil.example" }).code).toBe(3);
  });
  it("cannot be combined with an app or the format/v2 probes; --probe-team is allowed and adds one counts-only check", () => {
    for (const extra of [["--app=shop-api"], ["--probe-formats"], ["--include-v2"]]) expect(run("verify-liara-readonly.ts", ["--account-only", ...extra], acct).code, extra.join(" ")).toBe(2);
    const t = run("verify-liara-readonly.ts", ["--account-only", "--probe-team"], { ...acct, LIARA_TEAM_ID: "team_1" });
    expect(t.code).toBe(4);
    expect(t.out).toMatch(/without teamID/);
  });
  it("does not leak the team id", () => {
    expect(run("verify-liara-readonly.ts", ["--account-only"], { ...acct, LIARA_TEAM_ID: "team_secretish_1" }).out).not.toContain("team_secretish_1");
  });
});

describe("npm run record-fixtures (opt-in gates)", () => {
  it("is blocked in mock mode", () => {
    expect(run("record-fixtures.ts", ["--app=x", "--approve-recording"]).code).toBe(3);
  });
  it("needs BOTH the flag and LIARA_ALLOW_RECORDING=true", () => {
    expect(run("record-fixtures.ts", ["--app=shop-api"], { ...liveEnv, LIARA_ALLOW_RECORDING: "true" }).code).toBe(4);
    expect(run("record-fixtures.ts", ["--app=shop-api", "--approve-recording"], liveEnv).code).toBe(4);
  });
  it("only records an allowlisted app", () => {
    expect(run("record-fixtures.ts", ["--app=nope", "--approve-recording"], { ...liveEnv, LIARA_ALLOW_RECORDING: "true" }).code).toBe(2);
  });
});

describe("npm run preflight:liara (arguments, dry run — no network paths)", () => {
  const env = { ...liveEnv, LIARA_ALLOWED_APPS: "shop-api", LIARA_TEAM_ID: "team_secretish_1" } as Record<string, string>;
  it("--app=<name> is explicit: the dry run lists EVERY planned GET (including identity and release baseline), sends nothing (exit 4) and never prints secrets or the team id", () => {
    const r = run("preflight-liara.ts", ["--app=shop-api"], env);
    expect(r.code).toBe(4);
    expect(r.out).toMatch(/mode\s*: EXISTING application/);
    for (const e of ["GET /v1/projects\n", "GET /v1/me\n", "GET /v1/projects/shop-api\n", "GET /v1/projects/shop-api/releases?page=1&count=10"]) expect(r.out).toContain(e);
    expect(r.out).toMatch(/total that WILL be sent: 4/);
    expect(r.out).toMatch(/NOT APPROVED/);
    expect(r.out).toMatch(/no request was sent/);
    expect(r.out).toMatch(/Nothing captured earlier/);
    expect(r.out).not.toContain(CANARY.token);
    expect(r.out).not.toContain("team_secretish_1");
    expect(r.out).not.toMatch(/\bPOST|PUT|PATCH|DELETE\b/);
    expect(readdirSync(work)).not.toContain("fixtures");
  });
  it("an application outside LIARA_ALLOWED_APPS shows its identity/release GETs as SKIPPED", () => {
    const r = run("preflight-liara.ts", ["--app=not-allowed-app"], env);
    expect(r.code).toBe(4);
    expect(r.out).toMatch(/SKIPPED: the application is not in LIARA_ALLOWED_APPS/);
    expect(r.out).toMatch(/total that WILL be sent: 2/);
    expect(r.out).toMatch(/NO — identity and release reads are skipped/);
  });
  it("unknown flags, positional arguments, bad values and duplicates FAIL CLOSED (exit 2) before any configuration is even needed", () => {
    for (const args of [["--app=shop-api", "--surprise"], ["shop-api"], ["--app"], ["--app="], ["--app=Bad_Name"], ["--app=aa-bb", "--app=cc-dd"], ["--app=shop-api", "--plan=g2-small"], ["--approve-live-readonly=yes"], ["--budget=99"], ["-app=shop-api"]]) {
      const r = run("preflight-liara.ts", args, env);
      expect(r.code, args.join(" ")).toBe(2);
      expect(r.out, args.join(" ")).toMatch(/Invalid arguments \(nothing was sent\)/);
      expect(r.out).toMatch(/Usage:/);
    }
    expect(run("preflight-liara.ts", ["--zzz"], {}).code).toBe(2); // even without any live configuration
  });
  it("the account-only flow is preserved (no --app) and --new-app keeps the old creation semantics", () => {
    const acct = run("preflight-liara.ts", [], { ...env, LIARA_TEAM_ID: "" });
    expect(acct.code).toBe(4);
    expect(acct.out).toMatch(/mode\s*: account/);
    for (const e of ["GET /v1/projects\n", "GET /v1/me\n", "GET /v1/billing\n"]) expect(acct.out).toContain(e);
    expect(acct.out).not.toMatch(/\/v1\/projects\/shop-api/);
    const created = run("preflight-liara.ts", ["--new-app=my-new-app", "--plan=g2-small"], env);
    expect(created.code).toBe(4);
    expect(created.out).toMatch(/NEW application \(creation preflight\)/);
  });
  it("--include-networks needs the opt-in; mock mode is BLOCKED (exit 3), never mistaken for live evidence", () => {
    expect(run("preflight-liara.ts", ["--app=shop-api", "--include-networks"], env).code).toBe(2);
    const withOptIn = run("preflight-liara.ts", ["--app=shop-api", "--include-networks"], { ...env, LIARA_ALLOW_UNDOCUMENTED_ENDPOINTS: "true" });
    expect(withOptIn.code).toBe(4);
    expect(withOptIn.out).toMatch(/GET \/v1\/networks\s+\[UNDOCUMENTED\]/);
    expect(run("preflight-liara.ts", ["--app=shop-api"], {}).code).toBe(3);
  });
});

describe("npm run ai:smoke (never sends a request in these tests)", () => {
  const KEY = "box-ai-FAKEKEY0000000000000000000000000000000000000000";
  it("without the real-AI opt-ins it is BLOCKED (exit 3) and says no request was sent", () => {
    const r = run("ai-smoke.ts", ["--approve-live-ai-request"]);
    expect(r.code).toBe(3);
    expect(r.out).toMatch(/No request was sent/);
  });
  it("opted in but without a key or model it is BLOCKED (exit 3), even with the approval flag, and never prints the key", () => {
    const a = run("ai-smoke.ts", ["--approve-live-ai-request"], { AI_PROVIDER: "boxapi", AI_LIVE_REQUESTS_ENABLED: "true", BOXAPI_MODEL: "some-model" });
    expect(a.code).toBe(3);
    expect(a.out).toMatch(/missing api_key/);
    const b = run("ai-smoke.ts", ["--approve-live-ai-request"], { AI_PROVIDER: "boxapi", AI_LIVE_REQUESTS_ENABLED: "true", BOXAPI_API_KEY: KEY });
    expect(b.code).toBe(3);
    expect(b.out).toMatch(/missing model/);
    expect(a.out + b.out).not.toContain(KEY);
  });
  it("fully configured but WITHOUT --approve-live-ai-request it is a dry run (exit 0, no request) and hides the key", () => {
    const r = run("ai-smoke.ts", [], { AI_PROVIDER: "boxapi", AI_LIVE_REQUESTS_ENABLED: "true", BOXAPI_API_KEY: KEY, BOXAPI_MODEL: "some-model" });
    expect(r.code).toBe(0);
    expect(r.out).toMatch(/DRY RUN/);
    expect(r.out).toMatch(/No request was sent/);
    expect(r.out).not.toContain(KEY);
  });
  it("a bad base URL is a configuration error (exit 2)", () => {
    expect(run("ai-smoke.ts", [], { AI_PROVIDER: "boxapi", AI_LIVE_REQUESTS_ENABLED: "true", BOXAPI_BASE_URL: "https://evil.example/v1" }).code).toBe(2);
  });
});
