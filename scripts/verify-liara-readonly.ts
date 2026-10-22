/*
 * npm run verify:liara-readonly -- --app=<allowlisted app> [--approve-live-readonly] [--probe-formats] [--probe-team] [--include-v2] [--budget=25]
 * npm run verify:liara-readonly -- --account-only [--probe-team] [--approve-live-readonly] [--budget=25]
 *     EVENTS-ONLY (Phase 2C): npm run verify:liara-readonly -- --app=<allowlisted app> --events-only [--approve-live-readonly]
 *     exactly ONE documented GET (…/events?start&end); nothing else is requested.
 *     ACCOUNT-ONLY: GET /v1/projects, /v1/me, /v1/me/subscription, /v1/me/free-credit. No app name needed, no app-scoped endpoint is called,
 *     and the app allowlist / UI password may be empty (the verifier needs neither). Every other safety rule is unchanged.
 *
 * Controlled, bounded, GET-only verification of the live Liara contract.
 *  - never switches from mock to live by itself: LIARA_DATA_SOURCE=live must already be set in .env.local
 *  - credentials are read only from .env.local / the environment, never printed, logged or written
 *  - without --approve-live-readonly it prints the plan and exits WITHOUT any network request (dry run)
 *  - app names are never printed or written (pseudonym "app-1")
 * Exit codes: 0 passed | 1 failed/inconclusive | 2 invalid config or usage | 3 BLOCKED (no live credentials) | 4 not approved (dry run)
 */
import { mkdirSync, writeFileSync } from "node:fs";
import path from "node:path";
import { ConfigError, loadConfig } from "../src/server/config/env";
import { assertSafeToWrite } from "../src/server/liara/recorder";
import { buildPlan, runVerification, type VerificationReport } from "../src/server/liara/verify";

try {
  process.loadEnvFile(".env.local");
} catch {
  /* .env.local is optional; the environment may provide the variables */
}

const args = new Map<string, string | true>();
for (const a of process.argv.slice(2)) {
  const m = /^--([a-z0-9-]+)(?:=(.*))?$/.exec(a);
  if (m) args.set(m[1]!, m[2] ?? true);
}
const out = (s = "") => process.stdout.write(s + "\n");

function blocked(reason: string, needs: string[]): never {
  out(`LIVE VERIFICATION: BLOCKED — ${reason}`);
  out("");
  out("What the operator must do (nothing is sent to chat; everything stays in .env.local):");
  needs.forEach((n, i) => out(`  ${i + 1}. ${n}`));
  out("");
  out("Mock results are NOT live evidence. This status is BLOCKED, not PASSED.");
  process.exit(3);
}

async function main() {
  let cfg;
  try {
    cfg = loadConfig(process.env, { verification: args.get("account-only") === true });
  } catch (e) {
    if (e instanceof ConfigError) {
      if (process.env.LIARA_DATA_SOURCE === "live") {
        blocked("live configuration is incomplete or invalid", e.problems.map((p) => `Fix: ${p}`));
      }
      out(`Invalid configuration: ${e.problems.join("; ")}`);
      process.exit(2);
    }
    throw e;
  }

  out("Liara read-only verification");
  out("============================");
  out(`mode            : ${cfg.dataSource}`);
  if (cfg.dataSource !== "live") {
    blocked("LIARA_DATA_SOURCE is not 'live' (the tool never switches from mock to live on its own)", [
      "Copy .env.example to .env.local",
      "Set LIARA_DATA_SOURCE=live, LIARA_API_TOKEN=<your token>, LIARA_ALLOWED_APPS=<explicit app names>, APP_ACCESS_PASSWORD_HASH (npm run hash-password)",
      "Set LIARA_TEAM_ID only if the apps belong to a team",
      "Re-run:  npm run verify:liara-readonly -- --app=<one allowlisted app>   (dry run), then add --approve-live-readonly",
    ]);
  }
  const accountOnly = args.get("account-only") === true;
  const allowed = cfg.allowedApps ?? new Set<string>();
  out(`host            : ${cfg.liara.baseUrl.hostname} (trusted-host list enforced, redirects never followed)`);
  out(`team scoped     : ${cfg.liara.teamId ? "yes (teamID query parameter)" : "no (personal account)"}`);
  out(`allowlist size  : ${allowed.size}`);
  out(`token           : configured (never displayed)`);

  const app = typeof args.get("app") === "string" ? (args.get("app") as string) : "";
  const eventsOnly = args.get("events-only") === true;
  if (eventsOnly && (accountOnly || !app || args.get("probe-formats") === true || args.get("include-v2") === true || args.get("probe-team") === true)) {
    out("--events-only needs --app=<allowlisted app> and cannot be combined with --account-only, --probe-formats, --probe-team or --include-v2.");
    process.exit(2);
  }
  if (accountOnly && (app || args.get("probe-formats") === true || args.get("include-v2") === true)) {
    out("--account-only cannot be combined with --app, --probe-formats or --include-v2 (--probe-team is allowed).");
    process.exit(2);
  }
  if (!accountOnly && !app) {
    out("");
    out(`Select exactly one allowlisted app:  --app=<name>   (${allowed.size} configured; names are not echoed)`);
    process.exit(2);
  }
  if (!accountOnly && !allowed.has(app)) {
    out("The selected app is not in LIARA_ALLOWED_APPS. Refusing.");
    process.exit(2);
  }
  const budget = Math.min(Math.max(Number(args.get("budget") ?? 25) || 25, 8), 60);
  const opts = {
    app: accountOnly ? null : app,
    probeFormats: args.get("probe-formats") === true,
    probeTeam: args.get("probe-team") === true,
    includeV2: args.get("include-v2") === true,
    ...(eventsOnly ? { only: "getEvents" as const } : {}),
    budget,
  };
  if (opts.includeV2 && !cfg.liara.allowUndocumented) {
    out("--include-v2 also requires LIARA_ALLOW_UNDOCUMENTED_ENDPOINTS=true (explicit opt-in to an undocumented endpoint).");
    process.exit(2);
  }

  out("");
  out(`Planned checks (GET only, request budget ${budget} including retries, ≤2 concurrent, ≤2 req/s):`);
  for (const p of buildPlan(cfg, opts)) out(`  ${p.required ? "•" : "○"} ${p.endpoint}${p.contract === "observed" ? "  [UNDOCUMENTED]" : ""}${p.note ? `  — ${p.note}` : ""}`);

  if (args.get("approve-live-readonly") !== true) {
    out("");
    out("NOT APPROVED — dry run only; no request was sent.");
    out("Re-run with --approve-live-readonly to authorise these read-only requests against the live API.");
    process.exit(4);
  }

  out("");
  out("Approved by operator flag. Running…");
  let report: VerificationReport;
  try {
    report = await runVerification(cfg, opts);
  } catch (e) {
    out(`Verification aborted: ${(e as { code?: string }).code ?? "error"}`);
    process.exit(2);
  }

  const body = JSON.stringify(report, null, 2);
  assertSafeToWrite(body, [cfg.liara.token!.reveal()]);
  const dir = path.resolve("fixtures/recorded");
  mkdirSync(dir, { recursive: true });
  const file = path.join(dir, `verification-${report.scope === "account" ? "account-" : ""}${report.generatedAt.replace(/[:.]/g, "-")}.json`);
  writeFileSync(file, body + "\n", { mode: 0o600 });

  out("");
  out("Endpoint                               Verdict                 Outcome");
  out("-------------------------------------  ----------------------  -------------");
  for (const c of report.checks) out(`${c.id.padEnd(37)}  ${c.verdict.padEnd(22)}  ${c.outcome}${c.httpStatus ? ` (${c.httpStatus})` : ""}`);
  const reached = report.checks.filter((c) => c.reachability === "reached");
  const verified = report.checks.filter((c) => c.schemaVerification === "verified");
  out("");
  out(`reachability    : ${reached.length}/${report.checks.length} endpoints answered; ${verified.length} with a VERIFIED schema`);
  for (const c of reached.filter((x) => x.schemaVerification !== "verified")) out(`  ! ${c.id}: reached but schema NOT verified (${c.outcome}${c.httpStatus ? ` ${c.httpStatus}` : ""})${c.undocumentedStatus ? " — status undocumented in the pinned OpenAPI" : ""}`);
  out("");
  out(`requests made   : ${report.requestsMade}/${report.requestBudget}`);
  out(`overall         : ${report.overall}`);
  out(`report written  : ${path.relative(process.cwd(), file)}  (structure only; git-ignored; review before sharing)`);
  process.exit(report.overall === "PASSED" ? 0 : 1);
}

main().catch(() => {
  out("Unexpected error (details withheld to avoid leaking data).");
  process.exit(2);
});
