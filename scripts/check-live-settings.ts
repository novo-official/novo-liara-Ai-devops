/*
 * npm run check:live-settings -- [--app=liara-agent-demo]
 * OFFLINE validation of the deployment-health settings (LIARA_APP_DOMAIN_SUFFIXES, LIARA_LIVE_HEALTH_PATH, LIARA_LIVE_HEALTH_MARKER) and of the live/CLI flags.
 * It sends NO request, writes NO file and NEVER modifies .env.local (it only reads it, like every other script). Values that are not secrets are shown; the marker is shown
 * only as length + specificity; the token is never touched.
 */
import { ConfigError, loadConfig } from "../src/server/config/env";
import { validateHealthSettings } from "../src/server/live/existing";

try {
  process.loadEnvFile(".env.local");
} catch {
  /* optional */
}
const out = (s = "") => process.stdout.write(s + "\n");
const app = (process.argv.find((a) => a.startsWith("--app=")) ?? "--app=liara-agent-demo").slice(6);
let cfg;
try {
  cfg = loadConfig(process.env, { verification: true });
} catch (e) {
  out(`Invalid configuration: ${e instanceof ConfigError ? e.problems.join("; ") : "error"}`);
  process.exit(2);
}
const v = validateHealthSettings({ appName: app, suffixes: cfg.live.appDomainSuffixes, healthPath: cfg.live.healthPath, healthMarker: cfg.live.healthMarker });
const mark = (ok: boolean) => (ok ? "✓" : "✗");
out("Live deployment settings (offline check — nothing is sent, nothing is modified)");
out("=============================================================================");
out(`live deployment flag      : ${cfg.live.enabled ? "ENABLED (a real write path may exist)" : "disabled (expected until the separate approval)"}`);
out(`CLI fallback              : ${cfg.cli.enabled ? "ENABLED in config" : "disabled (never enabled automatically)"}`);
out(`contract attestation      : ${cfg.live.contractAttested ? "set" : "NOT set (REST release fields are CLI-only)"}`);
out("");
out(`${mark(v.appNameValid)} application name valid: ${app}`);
out(`${mark(v.configuredSuffixes.length > 0)} LIARA_APP_DOMAIN_SUFFIXES: ${v.configuredSuffixes.length ? v.configuredSuffixes.join(", ") : "(empty)"}`);
out(`${mark(v.firstSuffixIsKnownDefault)} first suffix is a known Liara default domain (liara.run | iran.liara.run)`);
out(`${mark(v.probeHost !== null)} health probe host: ${v.probeHost ?? "(cannot be built)"}   [HTTPS, GET, no redirects, only this host]`);
out(`${mark(v.pathValid)} health path: ${v.healthPath}`);
out(`${mark(v.markerSpecific)} health marker: ${v.markerConfigured ? `${v.markerLength} characters, ${v.markerSpecific ? "specific" : "TOO GENERIC/SHORT (≥ 8 characters, not 'ok'/'healthy'/…)"}` : "NOT configured"}`);
out("");
out("The correct default suffix depends on the application's network (official CLI rule):");
out(`  application WITH a network    → ${v.expectedSuffixWithNetwork}`);
out(`  application WITHOUT a network → ${v.expectedSuffixWithoutNetwork}`);
out("`npm run preflight:liara` (read-only, needs your approval) shows which one applies to the target.");
out("Set the values yourself in .env.local; this tool will not edit it.");
const ok = v.appNameValid && v.firstSuffixIsKnownDefault && v.probeHost !== null && v.pathValid && v.markerSpecific;
process.exit(ok ? 0 : 1);
