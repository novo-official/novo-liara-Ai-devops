import { describe, expect, it } from "vitest";
import { ConfigError, loadConfig, validateBaseUrl } from "@/server/config/env";
import { CANARY } from "../helpers/canaries";
import { LIVE_ENV } from "../helpers/live";

const problems = (env: Record<string, string | undefined>): string[] => {
  try {
    loadConfig(env);
    return [];
  } catch (e) {
    if (e instanceof ConfigError) return e.problems;
    throw e;
  }
};

describe("configuration (safe defaults, fail closed)", () => {
  it("defaults to MOCK mode with no credentials at all", () => {
    const cfg = loadConfig({});
    expect(cfg.dataSource).toBe("mock");
    expect(cfg.liara.token).toBeNull();
    expect(cfg.auth.passwordHash).toBeNull(); // login disabled until a hash is configured
    expect(cfg.liara.logsApi).toBe("v1");
    expect(cfg.liara.allowUndocumented).toBe(false);
  });

  it("live mode requires token, explicit allowlist and operator password hash", () => {
    const p = problems({ LIARA_DATA_SOURCE: "live" }).join(" | ");
    expect(p).toMatch(/LIARA_API_TOKEN/);
    expect(p).toMatch(/LIARA_ALLOWED_APPS/);
    expect(p).toMatch(/APP_ACCESS_PASSWORD_HASH/);
    expect(problems(LIVE_ENV)).toEqual([]);
  });

  it.each(["*", "shop-api,*", "sh*", "UPPER", "a", "../x", "ok-app,bad app"])("rejects allowlist entry %j", (v) => {
    expect(problems({ ...LIVE_ENV, LIARA_ALLOWED_APPS: v }).length).toBeGreaterThan(0);
  });

  it.each([
    ["http://api.liara.ir", /https/],
    ["https://evil.example", /trusted/],
    ["https://api.liara.ir.evil.example", /trusted/],
    ["https://user:pw@api.liara.ir", /credentials/],
    ["https://api.liara.ir:8443", /port/],
    ["https://api.liara.ir/v1", /origin/],
    ["https://api.liara.ir/?x=1", /origin/],
    ["not a url", /valid URL/],
    ["https://api.iran.liara.ir", /trusted/], // CLI-only host: not trusted without evidence
  ])("rejects base URL %s", (url, re) => {
    expect(validateBaseUrl(url).problem).toMatch(re);
    expect(problems({ ...LIVE_ENV, LIARA_API_BASE_URL: url }).join(" ")).toMatch(re);
  });

  it("accepts only the trusted host", () => {
    expect(validateBaseUrl("https://api.liara.ir").url?.origin).toBe("https://api.liara.ir");
    expect(validateBaseUrl("https://api.liara.ir/").url?.origin).toBe("https://api.liara.ir");
  });

  it("refuses to enable mutations in Phase 1A", () => {
    for (const v of ["true", "1", "yes", "enabled"]) {
      expect(problems({ ENABLE_MUTATIONS: v }).join(" ")).toMatch(/ENABLE_MUTATIONS/);
    }
    for (const v of [undefined, "", "false", "0"]) expect(problems({ ENABLE_MUTATIONS: v })).toEqual([]);
  });

  it("requires explicit opt-in for the undocumented v2 logs endpoint", () => {
    expect(problems({ LIARA_LOGS_API: "v2" }).join(" ")).toMatch(/UNDOCUMENTED|undocumented|v2/i);
    expect(problems({ LIARA_LOGS_API: "auto" }).length).toBeGreaterThan(0);
    expect(problems({ LIARA_LOGS_API: "v2", LIARA_ALLOW_UNDOCUMENTED_ENDPOINTS: "true" })).toEqual([]);
  });

  it("validates numeric bounds and team id format", () => {
    expect(problems({ LIARA_REQUEST_TIMEOUT_MS: "5" }).length).toBeGreaterThan(0);
    expect(problems({ LIARA_MAX_CONCURRENCY: "500" }).length).toBeGreaterThan(0);
    expect(problems({ LIARA_REQUEST_BUDGET_PER_MINUTE: "5" }).length).toBeGreaterThan(0);
    expect(problems({ LIARA_REQUEST_BUDGET_PER_MINUTE: "100000" }).length).toBeGreaterThan(0);
    expect(loadConfig({}).liara.budgetPerMinute).toBe(120);
    expect(problems({ LIARA_TEAM_ID: "bad id; drop" }).length).toBeGreaterThan(0);
    expect(problems({ LIARA_TEAM_ID: "team_123" })).toEqual([]);
  });

  it("never echoes secret values in configuration errors", () => {
    const msgs = problems({ ...LIVE_ENV, LIARA_TEAM_ID: CANARY.token, LIARA_REQUEST_TIMEOUT_MS: CANARY.apiToken, LIARA_ALLOWED_APPS: CANARY.envValue });
    expect(JSON.stringify(msgs)).not.toMatch(/CANARY|ENVCANARY/);
  });

  it("holds the token in a Secret that does not serialise", () => {
    const cfg = loadConfig(LIVE_ENV);
    expect(JSON.stringify(cfg)).not.toContain("CANARY");
    expect(String(cfg.liara.token)).toBe("[REDACTED]");
  });

  it("uses secure cookies only in production", () => {
    expect(loadConfig({ NODE_ENV: "production" }).auth.secureCookies).toBe(true);
    expect(loadConfig({ NODE_ENV: "development" }).auth.secureCookies).toBe(false);
  });
});
