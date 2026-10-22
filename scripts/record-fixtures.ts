/*
 * Operator-only: records SANITISED structural fixtures from a live READ-ONLY connection.
 *   npm run record-fixtures -- --app=<allowlisted app> --approve-recording
 * Opt-in is double-keyed: the --approve-recording flag AND LIARA_ALLOW_RECORDING=true in .env.local.
 *  - allowlisted app only; GET-only client; budgeted; raw payloads stay in memory and are reduced by an explicit field allowlist
 *  - output is pseudonymised and validated FAIL-CLOSED (any sensitive-looking leaf aborts the whole recording)
 *  - writes to fixtures/recorded/ (git-ignored) plus REVIEW.md. NOTHING is promoted automatically.
 */
import { mkdirSync, writeFileSync } from "node:fs";
import path from "node:path";
import { z } from "zod";
import { ConfigError, loadConfig } from "../src/server/config/env";
import type { EndpointId } from "../src/server/liara/endpoints";
import { LiaraHttpClient } from "../src/server/liara/http";
import { assertSafeToWrite, Pseudonymizer, recordPayload, RecordingRefused, reviewManifest, validateRecordedSample } from "../src/server/liara/recorder";

try {
  process.loadEnvFile(".env.local");
} catch {
  /* optional */
}

const args = new Map<string, string | true>();
for (const a of process.argv.slice(2)) {
  const m = /^--([a-z0-9-]+)(?:=(.*))?$/.exec(a);
  if (m) args.set(m[1]!, m[2] ?? true);
}
const out = (s: string) => process.stdout.write(s + "\n");

async function main() {
  let cfg;
  try {
    cfg = loadConfig(process.env);
  } catch (e) {
    out(e instanceof ConfigError ? `Invalid configuration: ${e.problems.join("; ")}` : "Invalid configuration");
    process.exit(2);
  }
  if (cfg.dataSource !== "live" || !cfg.liara.token || !cfg.allowedApps) {
    out("BLOCKED: recording needs LIARA_DATA_SOURCE=live, a token and LIARA_ALLOWED_APPS in .env.local (never switched automatically).");
    process.exit(3);
  }
  if (args.get("approve-recording") !== true || process.env.LIARA_ALLOW_RECORDING !== "true") {
    out("NOT APPROVED: recording requires BOTH the --approve-recording flag AND LIARA_ALLOW_RECORDING=true. No request was sent.");
    process.exit(4);
  }
  const app = typeof args.get("app") === "string" ? (args.get("app") as string) : "";
  if (!app || !cfg.allowedApps.has(app)) {
    out("--app=<name> is required and must be in LIARA_ALLOWED_APPS.");
    process.exit(2);
  }

  const http = new LiaraHttpClient({ ...cfg.liara, token: cfg.liara.token, maxConcurrency: 2, maxRps: 2, maxTotalRequests: 20 });
  const pseudo = new Pseudonymizer();
  const now = Date.now();
  const outDir = path.resolve("fixtures/recorded");
  mkdirSync(outDir, { recursive: true });
  const secrets = [cfg.liara.token.reveal()];
  const since = Math.floor(now / 1000) - 3600;
  const plan: Array<[EndpointId, { name?: string; query?: Record<string, string | number> }]> = [
    ["listApps", {}],
    ["getApp", { name: app }],
    ["getApplets", { name: app }],
    ["getReleases", { name: app, query: { page: 1, count: 5 } }],
    ["getEvents", { name: app, query: { start: since, end: Math.floor(now / 1000) } }],
    ["getLogsV1", { name: app, query: { since: String(since) } }],
    ["getMetricsCpu", { name: app, query: { since } }],
    ["getMetricsMemory", { name: app, query: { since } }],
  ];

  // Phase 1: sanitise + validate EVERYTHING in memory first; write only if every sample passes (all-or-nothing).
  const staged: { id: EndpointId; body: string; keys: string[] }[] = [];
  for (const [id, a] of plan) {
    try {
      const raw = await http.get(id, a, z.unknown());
      const sample = recordPayload(id, raw, { now, pseudo });
      validateRecordedSample(sample);
      const body = JSON.stringify({ _recorded: { endpoint: id, at: new Date(now).toISOString(), note: "approved fields only; pseudonymised; no raw payload" }, sample }, null, 2);
      assertSafeToWrite(body, secrets);
      staged.push({ id, body, keys: sample && typeof sample === "object" && !Array.isArray(sample) ? Object.keys(sample) : [] });
      out(`sanitised ${id}`);
    } catch (e) {
      if (e instanceof RecordingRefused) {
        out(`REFUSED ${id}: ${e.message}. Nothing was written.`);
        process.exit(1);
      }
      out(`skipped ${id}: ${(e as { code?: string }).code ?? "error"}`);
    }
  }
  for (const s of staged) writeFileSync(path.join(outDir, `${s.id}.json`), s.body + "\n", { mode: 0o600 });
  writeFileSync(path.join(outDir, "REVIEW.md"), reviewManifest(staged.map((s) => ({ id: s.id, keys: s.keys, bytes: s.body.length })), new Date(now).toISOString()), { mode: 0o600 });
  out(`wrote ${staged.length} sanitised files to fixtures/recorded/ — review REVIEW.md before promoting anything.`);
}

main().catch(() => {
  out("Unexpected error (details withheld).");
  process.exit(2);
});
