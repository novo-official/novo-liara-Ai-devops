import { APP_NAME_REGEX } from "../config/env";

/**
 * STRICT argument parser of `npm run preflight:liara` (pure; no I/O). Fail-closed: anything it does not explicitly understand is an ERROR, never silently ignored.
 *
 *   (no --app)              account preflight          (list apps, plan catalogue, billing, optional networks)
 *   --app=<name>            EXISTING-application preflight (identity, instance, plan, platform, network, default domain, release baseline of THAT app)
 *   --new-app=<name>        preflight for CREATING a new app (the pre-Phase-2E meaning of --app); may add --plan / --bundle
 */
export type PreflightMode = "account" | "existing_app" | "new_app";
export interface PreflightArgs {
  mode: PreflightMode;
  /** the EXISTING application (mode existing_app) */
  app: string | null;
  /** the NEW application name (mode new_app) */
  newApp: string | null;
  plan: string | null;
  bundle: string | null;
  includeNetworks: boolean;
  approve: boolean;
  budget: number;
}
export type ParseResult = { ok: true; args: PreflightArgs } | { ok: false; errors: string[] };

export const VALUE_FLAGS = ["app", "new-app", "plan", "bundle", "budget"] as const;
export const BOOLEAN_FLAGS = ["include-networks", "approve-live-readonly"] as const;
export const SUPPORTED_FLAGS = [...VALUE_FLAGS, ...BOOLEAN_FLAGS] as const;
const PLAN_ID = /^[A-Za-z0-9][A-Za-z0-9_.-]{0,59}$/;

export function parsePreflightArgs(argv: readonly string[]): ParseResult {
  const errors: string[] = [];
  const seen = new Map<string, string | true>();
  for (const raw of argv) {
    const m = /^--([a-z0-9-]{1,30})(?:=(.*))?$/.exec(raw);
    if (!m) {
      errors.push(`unexpected argument "${raw.slice(0, 40)}" (only --flag or --flag=value are accepted)`);
      continue;
    }
    const name = m[1]!;
    const value = m[2];
    if (!(SUPPORTED_FLAGS as readonly string[]).includes(name)) {
      errors.push(`unsupported flag --${name} (supported: ${SUPPORTED_FLAGS.map((f) => "--" + f).join(", ")})`);
      continue;
    }
    if (seen.has(name)) {
      errors.push(`--${name} was given more than once`);
      continue;
    }
    if ((BOOLEAN_FLAGS as readonly string[]).includes(name)) {
      if (value !== undefined) errors.push(`--${name} takes no value`);
      seen.set(name, true);
    } else {
      if (value === undefined || value === "") errors.push(`--${name} needs a value (--${name}=<value>)`);
      seen.set(name, value ?? "");
    }
  }
  const str = (k: string): string | null => (typeof seen.get(k) === "string" && seen.get(k) !== "" ? (seen.get(k) as string) : null);
  const app = str("app");
  const newApp = str("new-app");
  const plan = str("plan");
  const bundle = str("bundle");
  if (app !== null && !APP_NAME_REGEX.test(app)) errors.push("--app is not a valid application name (lowercase letters, digits and dashes)");
  if (newApp !== null && !APP_NAME_REGEX.test(newApp)) errors.push("--new-app is not a valid application name");
  if (app !== null && newApp !== null) errors.push("--app (existing application) and --new-app (application to be created) cannot be combined");
  if ((plan !== null || bundle !== null) && newApp === null) errors.push("--plan/--bundle only apply to --new-app (an existing application keeps its own plan; --app now targets an EXISTING application)");
  if (plan !== null && !PLAN_ID.test(plan)) errors.push("--plan is not a valid plan id");
  if (bundle !== null && !PLAN_ID.test(bundle)) errors.push("--bundle is not a valid bundle plan id");
  let budget = 8;
  const rawBudget = seen.get("budget");
  if (typeof rawBudget === "string" && rawBudget !== "") {
    if (!/^\d{1,2}$/.test(rawBudget) || Number(rawBudget) < 4 || Number(rawBudget) > 12) errors.push("--budget must be an integer between 4 and 12");
    else budget = Number(rawBudget);
  }
  if (errors.length) return { ok: false, errors };
  return { ok: true, args: { mode: app !== null ? "existing_app" : newApp !== null ? "new_app" : "account", app, newApp, plan, bundle, includeNetworks: seen.has("include-networks"), approve: seen.has("approve-live-readonly"), budget } };
}

export interface PlannedRequest {
  method: "GET";
  path: string;
  contract: "documented" | "observed";
  /** what the request is for (shown in the dry run) */
  purpose: string;
  /** `false` = the dry run already knows this request will NOT be sent, and why */
  willSend: boolean;
  skipReason?: string;
}

/** The EXACT list of requests the approved run may send (never more). Pure: it only needs the parsed arguments and non-secret configuration facts. */
export function plannedRequests(args: PreflightArgs, ctx: { teamScoped: boolean; allowUndocumented: boolean; appInScope: boolean | null }): PlannedRequest[] {
  const out: PlannedRequest[] = [];
  const get = (path: string, contract: PlannedRequest["contract"], purpose: string, willSend = true, skipReason?: string) => out.push({ method: "GET", path, contract, purpose, willSend, ...(skipReason ? { skipReason } : {}) });
  if (args.mode === "existing_app") {
    const a = args.app!;
    get("/v1/projects", "documented", "team-scoped application list: is the EXACT name present in this team? (names are never recorded)");
    get("/v1/me", "documented", "does the account answer show the configured team? (profile and plans are dropped)");
    const inScope = ctx.appInScope === true;
    const why = "the application is not in LIARA_ALLOWED_APPS (the tool never adds it)";
    get(`/v1/projects/${a}`, "documented", "identity of the instance: instance id, creation time, plan, platform, network, default domain flag, scale", inScope, inScope ? undefined : why);
    get(`/v1/projects/${a}/releases?page=1&count=10`, "documented", "release baseline: current release and release count", inScope, inScope ? undefined : why);
    if (args.includeNetworks) get("/v1/networks", "observed", "UNDOCUMENTED (CLI-observed): does the application's network id exist? (ids/names never recorded)", ctx.allowUndocumented, ctx.allowUndocumented ? undefined : "needs LIARA_ALLOW_UNDOCUMENTED_ENDPOINTS=true");
    return out;
  }
  get("/v1/projects", "documented", "application count" + (args.mode === "new_app" ? " + name collision for the NEW name" : ""));
  get("/v1/me", "documented", "plan catalogue, team presence/balance (profile data dropped)");
  if (!ctx.teamScoped) get("/v1/billing", "documented", "balance (amount never recorded; only a class)");
  if (args.includeNetworks) get("/v1/networks", "observed", "UNDOCUMENTED (CLI-observed): ids and names never recorded", ctx.allowUndocumented, ctx.allowUndocumented ? undefined : "needs LIARA_ALLOW_UNDOCUMENTED_ENDPOINTS=true");
  return out;
}
