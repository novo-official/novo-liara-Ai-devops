import "server-only";
import { z } from "zod";
import { registerSecret, Secret } from "../security/secret";
import { parsePlanUnits, type PlanUnits } from "../live/units";

/**
 * The ONLY module allowed to read process.env (enforced by ESLint).
 * Fails closed: invalid configuration throws a ConfigError whose message never contains values.
 */

/** Hosts the adapter may ever talk to. api.iran.liara.ir appears only in the CLI source (unverified) so it is NOT trusted. */
export const TRUSTED_LIARA_HOSTS: readonly string[] = ["api.liara.ir"];
/** BoxAPI (official docs: https://boxapi.ir/docs/ai/): the OpenAI-style AI gateway. Only this host is ever accepted for model requests. */
export const BOXAPI_DEFAULT_BASE_URL = "https://ai.boxapi.ir/ai/v1";
export const TRUSTED_BOXAPI_HOSTS: readonly string[] = ["ai.boxapi.ir"];

/** Liara app names (matches the official CLI rule, plus a length cap). */
export const APP_NAME_REGEX = /^[a-z0-9][a-z0-9-]{1,61}[a-z0-9]$/;

export class ConfigError extends Error {
  constructor(public readonly problems: string[]) {
    super(`Invalid configuration: ${problems.join("; ")}`);
    this.name = "ConfigError";
  }
}

const bool = z
  .enum(["true", "false", "1", "0", ""])
  .optional()
  .transform((v) => v === "true" || v === "1");

const intRange = (min: number, max: number, dflt: number) =>
  z
    .string()
    .optional()
    .transform((v) => (v === undefined || v === "" ? dflt : Number(v)))
    .pipe(z.number().int().min(min).max(max));

const RawEnv = z.object({
  NODE_ENV: z.string().optional(),
  LIARA_DATA_SOURCE: z.enum(["mock", "live"]).optional().default("mock"),
  LIARA_API_BASE_URL: z.string().optional(),
  LIARA_API_TOKEN: z.string().optional(),
  LIARA_TEAM_ID: z.string().optional(),
  LIARA_ALLOWED_APPS: z.string().optional(),
  LIARA_REQUEST_TIMEOUT_MS: intRange(1000, 30000, 10000),
  LIARA_MAX_CONCURRENCY: intRange(1, 8, 4),
  LIARA_MAX_RPS: intRange(1, 20, 5),
  LIARA_REQUEST_BUDGET_PER_MINUTE: intRange(10, 600, 120),
  LIARA_LOGS_API: z.enum(["v1", "v2", "auto"]).optional().default("v1"),
  LIARA_ALLOW_UNDOCUMENTED_ENDPOINTS: bool,
  APP_ACCESS_PASSWORD_HASH: z.string().optional(),
  SESSION_IDLE_TIMEOUT_MINUTES: intRange(1, 1440, 30),
  SESSION_ABSOLUTE_TIMEOUT_HOURS: intRange(1, 72, 8),
  TRUST_PROXY_HEADERS: bool,
  ENABLE_MUTATIONS: z.string().optional(),
  // AI text generation. "mock" (simulated, offline) and "disabled" never touch the network. "boxapi" is the ONLY real provider and needs an explicit opt-in:
  // AI_PROVIDER=boxapi AND AI_LIVE_REQUESTS_ENABLED=true (neither alone does anything). This is independent of Liara live execution (LIARA_LIVE_DEPLOY_ENABLED).
  AI_PROVIDER: z.enum(["mock", "disabled", "boxapi"]).optional().default("mock"),
  AI_LIVE_REQUESTS_ENABLED: z.string().optional(),
  BOXAPI_API_KEY: z.string().optional(),
  BOXAPI_BASE_URL: z.string().optional(),
  BOXAPI_MODEL: z.string().optional(),
  BOXAPI_MAX_OUTPUT_TOKENS: intRange(64, 4000, 600), // includes any hidden reasoning tokens of the model; deliberately small to protect a limited credit
  BOXAPI_TIMEOUT_MS: intRange(2000, 60000, 25000),
  /** optional lifetime cap on real requests per server process (e.g. 1 for a one-shot demo); unset = only the hourly guards apply */
  BOXAPI_MAX_REQUESTS_TOTAL: z.string().optional(),
  // Phase 2A: live deployment execution. OFF by default; a flag alone never authorises anything (see live/service.ts).
  LIARA_LIVE_DEPLOY_ENABLED: bool,
  LIARA_PLAN_UNITS_JSON: z.string().optional(),
  LIARA_APP_DOMAIN_SUFFIXES: z.string().optional(),
  LIARA_LIVE_CONTRACT_ATTESTED: bool,
  /** Phase 2B: allow an EMPTY allowlist with live data (account with zero apps). The effective scope is then ONLY the exact apps this tool created and verified. Never a wildcard. */
  LIARA_FIRST_APP_BOOTSTRAP: bool,
  LIARA_NETWORK_ID: z.string().optional(),
  /** Phase 2D: the OFFICIAL Liara CLI as an optional, restricted deployment backend. Default OFF; useless without LIARA_LIVE_DEPLOY_ENABLED and a live approval. */
  LIARA_CLI_ENABLED: bool,
  LIARA_CLI_ENTRY: z.string().optional(),
  LIARA_CLI_ENTRY_SHA256: z.string().optional(),
  LIARA_CLI_VERSION: z.string().optional(),
  LIARA_CLI_TIMEOUT_SECONDS: intRange(10, 600, 120),
  LIARA_LIVE_HEALTH_PATH: z.string().optional(),
  LIARA_LIVE_HEALTH_MARKER: z.string().optional(),
  DIAGNOSTICS_DB_PATH: z.string().optional(),
  DIAGNOSTICS_RUN_TIMEOUT_SECONDS: intRange(5, 120, 30),
  DIAGNOSTICS_MAX_CONCURRENT_RUNS: intRange(1, 5, 2),
});

export interface AppConfig {
  nodeEnv: "production" | "development" | "test";
  dataSource: "mock" | "live";
  liara: {
    baseUrl: URL;
    token: Secret | null;
    teamId: string | null;
    timeoutMs: number;
    maxConcurrency: number;
    maxRps: number;
    budgetPerMinute: number;
    logsApi: "v1" | "v2" | "auto";
    allowUndocumented: boolean;
  };
  ai: {
    provider: "mock" | "disabled" | "boxapi";
    /** true ONLY when the operator explicitly opted in to real model requests (AI_PROVIDER=boxapi + AI_LIVE_REQUESTS_ENABLED=true) */
    liveRequestsEnabled: boolean;
    /** BoxAPI connection. `model` has NO default (a paid model is never chosen implicitly); `apiKey` is server-side only. */
    boxapi: { baseUrl: string; model: string | null; apiKey: Secret | null; maxOutputTokens: number; timeoutMs: number; maxTotalRequests: number | null };
  };
  /** Phase 2A. `enabled` is only ONE of many independent conditions for any live write; default false. */
  live: { enabled: boolean; planUnits: PlanUnits | null; appDomainSuffixes: readonly string[]; /** operator attests the CLI-observed write fields were verified (Phase 2B) */ contractAttested: boolean; networkId: string | null; healthPath: string; healthMarker: string | null; /** Phase 2B: empty allowlist permitted (zero-app account); scope = verified created apps only */ firstAppBootstrap: boolean };
  /** Phase 2D. The CLI backend exists only when `enabled` AND the tool is pinned (absolute entry path, SHA-256, exact version). */
  cli: { enabled: boolean; entry: string | null; entrySha256: string | null; version: string | null; timeoutMs: number };
  diagnostics: { dbPath: string; runTimeoutMs: number; maxConcurrentRuns: number };
  /** Exact-match allowlist. `null` in mock mode means "all simulated fixtures". */
  allowedApps: ReadonlySet<string> | null;
  auth: {
    passwordHash: Secret | null;
    idleTimeoutMs: number;
    absoluteTimeoutMs: number;
    trustProxyHeaders: boolean;
    secureCookies: boolean;
  };
}

export function parseAllowedApps(raw: string | undefined): { apps: string[]; problems: string[] } {
  const problems: string[] = [];
  const apps = (raw ?? "")
    .split(",")
    .map((s) => s.trim())
    .filter(Boolean);
  for (const a of apps) {
    if (a === "*" || a.includes("*")) problems.push("LIARA_ALLOWED_APPS must list explicit app names (wildcards rejected)");
    else if (!APP_NAME_REGEX.test(a)) problems.push("LIARA_ALLOWED_APPS contains an invalid app name");
  }
  return { apps: [...new Set(apps)], problems: [...new Set(problems)] };
}

export function validateBaseUrl(raw: string): { url: URL | null; problem?: string } {
  let url: URL;
  try {
    url = new URL(raw);
  } catch {
    return { url: null, problem: "LIARA_API_BASE_URL is not a valid URL" };
  }
  if (url.protocol !== "https:") return { url: null, problem: "LIARA_API_BASE_URL must use https" };
  if (url.username || url.password) return { url: null, problem: "LIARA_API_BASE_URL must not contain credentials" };
  if (url.port && url.port !== "443") return { url: null, problem: "LIARA_API_BASE_URL must use the default port" };
  if (!TRUSTED_LIARA_HOSTS.includes(url.hostname)) {
    return { url: null, problem: "LIARA_API_BASE_URL host is not a trusted Liara host" };
  }
  if ((url.pathname !== "/" && url.pathname !== "") || url.search || url.hash) {
    return { url: null, problem: "LIARA_API_BASE_URL must be an origin only" };
  }
  return { url: new URL(url.origin) };
}

/**
 * `verification: true` is used ONLY by `scripts/verify-liara-readonly.ts --account-only`. It relaxes exactly two live requirements that
 * concern the web app and not the verifier (a non-empty app allowlist and the UI password hash). Every safety check — https and trusted host,
 * token present, mutations/AI flags, wildcard rejection — still applies, and the running server never passes this option.
 */
export function loadConfig(env: Record<string, string | undefined>, opts: { verification?: boolean } = {}): AppConfig {
  const parsed = RawEnv.safeParse(env);
  if (!parsed.success) {
    // Only variable names + generic codes: never echo values (they may be secrets).
    throw new ConfigError(parsed.error.issues.map((i) => `${i.path.join(".") || "env"}: invalid value`));
  }
  const e = parsed.data;
  const problems: string[] = [];

  // Phase 1A is read-only by construction: refuse any attempt to enable writes.
  // Real model requests need BOTH switches. Either one alone is rejected rather than silently ignored.
  const aiLiveRequested = e.AI_LIVE_REQUESTS_ENABLED !== undefined && !["", "false", "0"].includes(e.AI_LIVE_REQUESTS_ENABLED);
  if (aiLiveRequested && e.AI_LIVE_REQUESTS_ENABLED !== "true" && e.AI_LIVE_REQUESTS_ENABLED !== "1") problems.push("AI_LIVE_REQUESTS_ENABLED must be true or false");
  else if (aiLiveRequested && e.AI_PROVIDER !== "boxapi") problems.push("AI_LIVE_REQUESTS_ENABLED requires AI_PROVIDER=boxapi (otherwise AI is offline/mock only)");
  if (e.AI_PROVIDER === "boxapi" && !aiLiveRequested) problems.push("AI_PROVIDER=boxapi requires AI_LIVE_REQUESTS_ENABLED=true (an explicit opt-in to paid model requests)");
  const boxBase = e.BOXAPI_BASE_URL?.trim() || BOXAPI_DEFAULT_BASE_URL;
  let boxBaseOk = false;
  try {
    const u = new URL(boxBase);
    boxBaseOk = u.protocol === "https:" && TRUSTED_BOXAPI_HOSTS.includes(u.hostname) && !u.username && !u.password && !u.search && !u.hash;
  } catch {
    boxBaseOk = false;
  }
  if (!boxBaseOk) problems.push("BOXAPI_BASE_URL must be an https URL on a trusted BoxAPI host");
  const boxModel = e.BOXAPI_MODEL?.trim() || null;
  if (boxModel && !/^[A-Za-z0-9~][A-Za-z0-9._:/-]{0,99}$/.test(boxModel)) problems.push("BOXAPI_MODEL has an invalid format");
  const totalRaw = e.BOXAPI_MAX_REQUESTS_TOTAL?.trim();
  if (totalRaw && !/^[1-9][0-9]{0,3}$/.test(totalRaw)) problems.push("BOXAPI_MAX_REQUESTS_TOTAL must be a positive integer");
  const boxKey = e.BOXAPI_API_KEY?.trim() ? new Secret(e.BOXAPI_API_KEY.trim()) : null;
  if (boxKey) registerSecret(boxKey.reveal());
  if (e.ENABLE_MUTATIONS !== undefined && !["", "false", "0"].includes(e.ENABLE_MUTATIONS)) {
    problems.push("ENABLE_MUTATIONS is not supported in Phase 1A (this build has no write capability)");
  }

  const nodeEnv = e.NODE_ENV === "production" ? "production" : e.NODE_ENV === "test" ? "test" : "development";

  const base = validateBaseUrl(e.LIARA_API_BASE_URL?.trim() || "https://api.liara.ir");
  if (!base.url) problems.push(base.problem!);

  const { apps, problems: appProblems } = parseAllowedApps(e.LIARA_ALLOWED_APPS);
  problems.push(...appProblems);

  const teamId = e.LIARA_TEAM_ID?.trim() || null;
  if (teamId && !/^[A-Za-z0-9_-]{1,64}$/.test(teamId)) problems.push("LIARA_TEAM_ID has an invalid format");

  const token = e.LIARA_API_TOKEN?.trim() ? new Secret(e.LIARA_API_TOKEN.trim()) : null;

  if (e.LIARA_DATA_SOURCE === "live") {
    if (!token) problems.push("LIARA_API_TOKEN is required when LIARA_DATA_SOURCE=live");
    if (apps.length === 0 && !opts.verification && !e.LIARA_FIRST_APP_BOOTSTRAP) problems.push("LIARA_ALLOWED_APPS is required (non-empty) when LIARA_DATA_SOURCE=live (or set LIARA_FIRST_APP_BOOTSTRAP=true for an account with zero applications)");
    if (!e.APP_ACCESS_PASSWORD_HASH?.trim() && !opts.verification) problems.push("APP_ACCESS_PASSWORD_HASH is required when LIARA_DATA_SOURCE=live");
  }

  const allowUndocumented = e.LIARA_ALLOW_UNDOCUMENTED_ENDPOINTS;
  if ((e.LIARA_LOGS_API === "v2" || e.LIARA_LOGS_API === "auto") && !allowUndocumented) {
    problems.push("LIARA_LOGS_API=v2|auto requires LIARA_ALLOW_UNDOCUMENTED_ENDPOINTS=true (v2 logs are CLI-observed only)");
  }

  const units = parsePlanUnits(e.LIARA_PLAN_UNITS_JSON);
  if (units.problem) problems.push(units.problem);
  const suffixes = (e.LIARA_APP_DOMAIN_SUFFIXES ?? "").split(",").map((x) => x.trim().toLowerCase()).filter(Boolean);
  for (const sfx of suffixes) if (!/^[a-z0-9]([a-z0-9-]{0,61}[a-z0-9])?(\.[a-z0-9]([a-z0-9-]{0,61}[a-z0-9])?)+$/.test(sfx)) problems.push("LIARA_APP_DOMAIN_SUFFIXES contains an invalid domain suffix");
  const networkId = e.LIARA_NETWORK_ID?.trim() || null;
  if (networkId && !/^[A-Za-z0-9][A-Za-z0-9_-]{2,127}$/.test(networkId)) problems.push("LIARA_NETWORK_ID has an invalid format");
  const healthPath = e.LIARA_LIVE_HEALTH_PATH?.trim() || "/health";
  if (!/^\/[A-Za-z0-9._~\-/]{0,100}$/.test(healthPath) || healthPath.includes("..") || healthPath.includes("//")) problems.push("LIARA_LIVE_HEALTH_PATH is invalid");
  const healthMarker = e.LIARA_LIVE_HEALTH_MARKER?.trim() || null;
  if (healthMarker && !/^[A-Za-z0-9 _.:{}"-]{1,60}$/.test(healthMarker)) problems.push("LIARA_LIVE_HEALTH_MARKER is invalid");
  const cliEntry = e.LIARA_CLI_ENTRY?.trim() || null;
  const cliSha = e.LIARA_CLI_ENTRY_SHA256?.trim().toLowerCase() || null;
  const cliVersion = e.LIARA_CLI_VERSION?.trim() || null;
  if (cliEntry && (!/^\/[A-Za-z0-9._/@+-]{1,299}$/.test(cliEntry) || cliEntry.split("/").includes(".."))) problems.push("LIARA_CLI_ENTRY must be a clean absolute path");
  if (cliSha && !/^[0-9a-f]{64}$/.test(cliSha)) problems.push("LIARA_CLI_ENTRY_SHA256 must be 64 hex characters");
  if (cliVersion && !/^\d{1,3}\.\d{1,3}\.\d{1,3}$/.test(cliVersion)) problems.push("LIARA_CLI_VERSION must be an exact version like 9.6.0");
  if (e.LIARA_CLI_ENABLED) {
    if (e.LIARA_DATA_SOURCE !== "live") problems.push("LIARA_CLI_ENABLED=true requires LIARA_DATA_SOURCE=live");
    if (!token) problems.push("LIARA_CLI_ENABLED=true requires LIARA_API_TOKEN");
    if (!cliEntry || !cliSha || !cliVersion) problems.push("LIARA_CLI_ENABLED=true requires LIARA_CLI_ENTRY, LIARA_CLI_ENTRY_SHA256 and LIARA_CLI_VERSION (the tool must be pinned)");
  }
  if (e.LIARA_LIVE_DEPLOY_ENABLED) {
    if (e.LIARA_DATA_SOURCE !== "live") problems.push("LIARA_LIVE_DEPLOY_ENABLED=true requires LIARA_DATA_SOURCE=live (no mock-to-live mixing)");
    if (!token) problems.push("LIARA_LIVE_DEPLOY_ENABLED=true requires LIARA_API_TOKEN");
  }

  if (problems.length) throw new ConfigError([...new Set(problems)]);

  const passwordHash = e.APP_ACCESS_PASSWORD_HASH?.trim() ? new Secret(e.APP_ACCESS_PASSWORD_HASH.trim()) : null;
  if (token) registerSecret(token.reveal());
  if (passwordHash) registerSecret(passwordHash.reveal());

  return {
    nodeEnv,
    dataSource: e.LIARA_DATA_SOURCE,
    liara: {
      baseUrl: base.url!,
      token,
      teamId,
      timeoutMs: e.LIARA_REQUEST_TIMEOUT_MS,
      maxConcurrency: e.LIARA_MAX_CONCURRENCY,
      maxRps: e.LIARA_MAX_RPS,
      budgetPerMinute: e.LIARA_REQUEST_BUDGET_PER_MINUTE,
      logsApi: e.LIARA_LOGS_API,
      allowUndocumented,
    },
    ai: { provider: e.AI_PROVIDER, liveRequestsEnabled: aiLiveRequested && e.AI_PROVIDER === "boxapi", boxapi: { baseUrl: boxBase.replace(/\/+$/, ""), model: boxModel, apiKey: boxKey, maxOutputTokens: e.BOXAPI_MAX_OUTPUT_TOKENS, timeoutMs: e.BOXAPI_TIMEOUT_MS, maxTotalRequests: totalRaw && /^[1-9][0-9]{0,3}$/.test(totalRaw) ? Number(totalRaw) : null } },
    live: { enabled: e.LIARA_LIVE_DEPLOY_ENABLED, planUnits: units.units, appDomainSuffixes: suffixes, contractAttested: e.LIARA_LIVE_CONTRACT_ATTESTED, networkId, healthPath, healthMarker, firstAppBootstrap: e.LIARA_FIRST_APP_BOOTSTRAP },
    cli: { enabled: e.LIARA_CLI_ENABLED, entry: cliEntry, entrySha256: cliSha, version: cliVersion, timeoutMs: e.LIARA_CLI_TIMEOUT_SECONDS * 1000 },
    diagnostics: {
      dbPath: e.DIAGNOSTICS_DB_PATH?.trim() || "./data/diagnostics.sqlite",
      runTimeoutMs: e.DIAGNOSTICS_RUN_TIMEOUT_SECONDS * 1000,
      maxConcurrentRuns: e.DIAGNOSTICS_MAX_CONCURRENT_RUNS,
    },
    // an EMPTY (non-null) set means "nothing is allowed except apps this tool created and verified" — never a wildcard; null is only the mock/verification mode
    allowedApps: apps.length ? new Set(apps) : e.LIARA_FIRST_APP_BOOTSTRAP && e.LIARA_DATA_SOURCE === "live" && !opts.verification ? new Set<string>() : null,
    auth: {
      passwordHash,
      idleTimeoutMs: e.SESSION_IDLE_TIMEOUT_MINUTES * 60_000,
      absoluteTimeoutMs: e.SESSION_ABSOLUTE_TIMEOUT_HOURS * 3_600_000,
      trustProxyHeaders: e.TRUST_PROXY_HEADERS,
      secureCookies: nodeEnv === "production",
    },
  };
}

let cached: AppConfig | undefined;
let cachedSig = "";
let override: AppConfig | undefined;

/** The values of every variable this module understands, as one string (never logged). Used only in development to notice an edited .env.local. */
const envSignature = (): string => Object.keys(RawEnv.shape).map((k) => process.env[k] ?? "").join("\u0001");

/**
 * Lazily loads and caches the config for the running server. In production it is read once. In development Next reloads .env.local when it changes, so the cache is
 * dropped when any known variable's value changed — otherwise a long-running dev server keeps answering with the configuration it started with.
 */
export function getConfig(): AppConfig {
  if (override) return override;
  if (process.env.NODE_ENV === "production") return (cached ??= loadConfig(process.env));
  const sig = envSignature();
  if (!cached || sig !== cachedSig) {
    cached = loadConfig(process.env);
    cachedSig = sig;
  }
  return cached;
}

/** Test seam. Pass undefined to reset. */
export function __setConfigForTests(cfg: AppConfig | undefined): void {
  override = cfg;
  cached = undefined;
}
