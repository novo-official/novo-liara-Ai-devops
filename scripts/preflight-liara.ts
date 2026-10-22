/*
 * npm run preflight:liara -- [--app=<EXISTING app> | --new-app=<name to create> [--plan=<id>] [--bundle=<id>]] [--include-networks] [--approve-live-readonly] [--budget=8]
 *
 * READ-ONLY. It never creates, uploads, releases, deletes, charges or changes anything, and it NEVER edits .env.local.
 *   (no --app)        account preflight: GET /v1/projects, /v1/me, /v1/billing (personal accounts), optional /v1/networks
 *   --app=<name>      EXISTING-application preflight: GET /v1/projects, /v1/me, /v1/projects/<name>, /v1/projects/<name>/releases?page=1&count=10, optional /v1/networks
 *                     (identity of the instance, plan, platform, network, default domain, release baseline; nothing captured earlier is trusted)
 *   --new-app=<name>  the pre-Phase-2E meaning of --app: preflight for CREATING a new app
 *  - ANY unknown flag, positional argument, duplicate, missing value or invalid value is an ERROR (exit 2): arguments are never silently ignored
 *  - without --approve-live-readonly it prints EVERY planned GET (and every GET it already knows it will skip) and exits WITHOUT any network request (dry run)
 *  - the report holds classes/hints only: no balance, no full ids, no names, no team id, no token; written to fixtures/recorded (git-ignored)
 * Exit codes: 0 READY_FOR_OPERATOR_APPROVAL | 1 blocked | 2 invalid usage or config | 3 not live | 4 not approved (dry run)
 */
import { mkdirSync, writeFileSync } from "node:fs";
import path from "node:path";
import { ConfigError, loadConfig } from "../src/server/config/env";
import { LiaraHttpClient } from "../src/server/liara/http";
import { LiaraReadClient } from "../src/server/liara/read-client";
import { assertSafeToWrite } from "../src/server/liara/recorder";
import { LiaraService } from "../src/server/liara/service";
import { runExistingPreflight } from "../src/server/live/existing-preflight";
import { parsePreflightArgs, plannedRequests } from "../src/server/live/preflight-args";
import { gatherPreflight } from "../src/server/live/preflight-gather";
import { liveReaderFrom } from "../src/server/live/reader";

try {
  process.loadEnvFile(".env.local");
} catch {
  /* optional */
}
const out = (s = "") => process.stdout.write(s + "\n");

async function main() {
  const parsed = parsePreflightArgs(process.argv.slice(2));
  if (!parsed.ok) {
    out("Invalid arguments (nothing was sent):");
    for (const e of parsed.errors) out(`  - ${e}`);
    out("");
    out("Usage: npm run preflight:liara -- [--app=<existing app> | --new-app=<name> [--plan=<id>] [--bundle=<id>]] [--include-networks] [--approve-live-readonly] [--budget=4..12]");
    process.exit(2);
  }
  const args = parsed.args;
  let cfg;
  try {
    cfg = loadConfig(process.env, { verification: true });
  } catch (e) {
    out(`Invalid configuration: ${e instanceof ConfigError ? e.problems.join("; ") : "error"}`);
    process.exit(2);
  }
  out("Liara live-deployment preflight (READ-ONLY)");
  out("===========================================");
  out(`mode            : ${args.mode === "existing_app" ? "EXISTING application" : args.mode === "new_app" ? "NEW application (creation preflight)" : "account"}`);
  if (args.app) out(`target          : ${args.app}`);
  out(`data source     : ${cfg.dataSource}`);
  if (cfg.dataSource !== "live") {
    out("BLOCKED — LIARA_DATA_SOURCE is not 'live'; mock results are not live evidence (the tool never switches by itself).");
    process.exit(3);
  }
  out(`host            : ${cfg.liara.baseUrl.hostname}`);
  out(`team scoped     : ${cfg.liara.teamId ? "yes (every request carries the teamID query parameter; the value is not shown)" : "no (personal account)"}`);
  out(`live deployment : ${cfg.live.enabled ? "ENABLED in config (this script still performs no write)" : "disabled (expected)"}`);
  out("token           : configured (never displayed)");
  if (args.includeNetworks && !cfg.liara.allowUndocumented) {
    out("--include-networks also requires LIARA_ALLOW_UNDOCUMENTED_ENDPOINTS=true (explicit opt-in to an undocumented, CLI-observed endpoint).");
    process.exit(2);
  }
  const appInScope = args.mode === "existing_app" ? (cfg.allowedApps?.has(args.app!) ?? false) : null;
  const plan = plannedRequests(args, { teamScoped: cfg.liara.teamId !== null, allowUndocumented: cfg.liara.allowUndocumented, appInScope });
  out("");
  out(`Planned requests (GET only, budget ${args.budget} including retries, ≤2 concurrent, ≤2 req/s):`);
  for (const r of plan) out(`  ${r.willSend ? "•" : "○"} ${r.method} ${r.path}${r.contract === "observed" ? "  [UNDOCUMENTED]" : ""}${r.willSend ? "" : `  — SKIPPED: ${r.skipReason}`}\n      ${r.purpose}`);
  out(`  total that WILL be sent: ${plan.filter((r) => r.willSend).length}`);
  if (args.mode === "existing_app") {
    out("");
    out(`Application in LIARA_ALLOWED_APPS : ${appInScope ? "yes" : "NO — identity and release reads are skipped and the verdict will be BLOCKED"}`);
    out("Nothing captured earlier (fingerprints, proposals, approvals) is trusted or read: every fact is read now.");
  }
  if (!args.approve) {
    out("");
    out("NOT APPROVED — dry run only; no request was sent.");
    out("Re-run with --approve-live-readonly to authorise exactly these read-only requests.");
    process.exit(4);
  }
  out("");
  out("Approved by operator flag. Running…");
  let requests = 0;
  const http = new LiaraHttpClient({
    baseUrl: cfg.liara.baseUrl,
    token: cfg.liara.token!,
    teamId: cfg.liara.teamId,
    timeoutMs: cfg.liara.timeoutMs,
    maxConcurrency: 2,
    maxRps: Math.min(cfg.liara.maxRps, 2),
    maxTotalRequests: args.budget,
    fetchImpl: ((...a: Parameters<typeof fetch>) => {
      requests++;
      return fetch(...a);
    }) as typeof fetch,
  });
  const client = new LiaraReadClient(http, { logsApi: "v1", allowUndocumented: args.includeNetworks });
  const svc = new LiaraService(client, cfg);
  const reader = liveReaderFrom(svc);
  const scoped = { ...cfg, liara: { ...cfg.liara, allowUndocumented: args.includeNetworks } };
  const nowIso = new Date().toISOString();

  let report: { verdict: string; checks: { id: string; category: string; status: string }[]; generatedAt: string };
  if (args.mode === "existing_app") report = await runExistingPreflight({ reader, cfg: scoped, app: args.app!, includeNetworks: args.includeNetworks, nowIso });
  else report = await gatherPreflight({ reader, cfg: scoped, nowIso, sel: args.plan || args.newApp ? { planId: args.plan, bundlePlanId: args.bundle, appName: args.newApp, minRamMb: null } : null });

  const body = JSON.stringify({ ...report, requestsMade: requests, requestBudget: args.budget, app: args.mode === "existing_app" ? "target-app" : undefined, appName: args.newApp ? "app-1" : null }, null, 2);
  assertSafeToWrite(body, [cfg.liara.token!.reveal()]);
  const dir = path.resolve("fixtures/recorded");
  mkdirSync(dir, { recursive: true });
  const file = path.join(dir, `preflight-${args.mode === "existing_app" ? "existing-" : ""}${report.generatedAt.replace(/[:.]/g, "-")}.json`);
  writeFileSync(file, body + "\n", { mode: 0o600 });

  out("");
  for (const c of report.checks) out(`${c.status === "ok" ? "✓" : c.status === "blocked" ? "✗" : "·"} [${c.category}] ${c.id}`);
  if (args.mode === "existing_app") {
    const t = (report as unknown as { target: { facts: { planId: string | null; platform: string | null; scale: number | null; hasNetwork: boolean; defaultSubdomain: boolean | null; releaseTotal: number | null } | null; expectedSuffix: string | null; freshIdentityDigest: string | null } }).target;
    out("");
    out(`target facts    : ${t.facts ? `plan=${t.facts.planId} platform=${t.facts.platform} scale=${t.facts.scale} network=${t.facts.hasNetwork ? "yes" : "no"} defaultSubdomain=${t.facts.defaultSubdomain} releases=${t.facts.releaseTotal}` : "not read"}`);
    out(`expected suffix : ${t.expectedSuffix ?? "unknown"}   (set LIARA_APP_DOMAIN_SUFFIXES yourself; this tool never edits .env.local)`);
    out(`fresh identity digest: ${t.freshIdentityDigest ?? "—"}`);
  }
  out("");
  out(`requests made   : ${requests}/${args.budget}`);
  out(`VERDICT         : ${report.verdict}`);
  out(`report written  : ${path.relative(process.cwd(), file)}  (classes/hints only; git-ignored; review before sharing)`);
  process.exit(report.verdict === "READY_FOR_OPERATOR_APPROVAL" ? 0 : 1);
}
main().catch(() => {
  out("Unexpected error (details withheld to avoid leaking data).");
  process.exit(2);
});
