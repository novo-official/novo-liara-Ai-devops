/*
 * npm run ai:smoke -- [--approve-live-ai-request]
 * ONE bounded text-generation request to the configured BoxAPI model, to prove the integration end to end. Without the flag it is a DRY RUN: it prints the
 * (non-secret) configuration status and sends nothing. With the flag it sends exactly ONE short Persian question (no retry, no loop, output capped by
 * BOXAPI_MAX_OUTPUT_TOKENS) through the same provider class the app uses, and prints the sanitized outcome: HTTP status, model, token usage, the answer.
 * It reads .env.local (never writes it), never prints the key, and never touches Liara.
 * Requires: AI_PROVIDER=boxapi, AI_LIVE_REQUESTS_ENABLED=true, BOXAPI_API_KEY and BOXAPI_MODEL (see docs/BOXAPI_INTEGRATION.md).
 */
import { resolveAiProvider } from "../src/server/ai/resolve";
import { getAiStatus } from "../src/server/ai/status";
import { ConfigError, loadConfig, type AppConfig } from "../src/server/config/env";

try {
  process.loadEnvFile(".env.local");
} catch {
  /* optional */
}
const out = (s = "") => process.stdout.write(s + "\n");
const approved = process.argv.includes("--approve-live-ai-request");

let cfg: AppConfig;
try {
  cfg = loadConfig(process.env, { verification: true });
} catch (e) {
  out(`Invalid configuration: ${e instanceof ConfigError ? e.problems.join("; ") : "error"}`);
  process.exit(2);
}
const st = getAiStatus(cfg);
out("BoxAPI smoke test");
out("=================");
out(`AI provider              : ${cfg.ai.provider}${st.enabled ? " (live requests opted in)" : ""}`);
out(`model                    : ${cfg.ai.boxapi.model ?? "(not set — there is no default)"}`);
out(`API key                  : ${cfg.ai.boxapi.apiKey ? "present (hidden)" : "NOT set"}`);
out(`max output tokens        : ${cfg.ai.boxapi.maxOutputTokens}`);
if (!st.enabled) {
  out("\nBLOCKED: set AI_PROVIDER=boxapi and AI_LIVE_REQUESTS_ENABLED=true (both, in .env.local). No request was sent.");
  process.exit(3);
}
if (!st.configured) {
  out(`\nBLOCKED: missing ${st.missing.join(" and ")} (in .env.local). No request was sent.`);
  process.exit(3);
}
if (!approved) {
  out("\nDRY RUN: configuration is complete. Re-run with --approve-live-ai-request to send ONE request. No request was sent.");
  process.exit(0);
}

async function main(): Promise<never> {
  const provider = resolveAiProvider(cfg);
  const r = await provider.answer!({ questionFa: "در یک جمله فارسی بگو: قبل از استقرار یک برنامهٔ Next.js روی لیارا مهم‌ترین چیزی که باید بررسی کنم چیست؟", apps: [], dataMode: "mock" }, { timeoutMs: cfg.ai.boxapi.timeoutMs });
  const last = getAiStatus(cfg).last;
  out("\nResult (sanitized)");
  out(`HTTP status              : ${last?.httpStatus ?? "(no response)"}`);
  out(`duration                 : ${last?.durationMs ?? "?"} ms`);
  if (r.ok) {
    out("outcome                  : SUCCESS — a real model response was received");
    out(`model reported           : ${r.model}`);
    out(`usage                    : prompt=${r.usage?.promptTokens ?? "n/a"} completion=${r.usage?.completionTokens ?? "n/a"} total=${r.usage?.totalTokens ?? "n/a"}`);
    out(`answer (${r.textFa.length} chars)       :\n${r.textFa.slice(0, 800)}`);
    process.exit(0);
  }
  out(`outcome                  : FAILURE — ${r.error} (nothing was substituted)`);
  process.exit(4);
}
void main().catch(() => {
  out("unexpected error (nothing printed that could contain the key)");
  process.exit(1);
});
