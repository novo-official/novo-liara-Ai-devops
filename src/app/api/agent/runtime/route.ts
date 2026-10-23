import { AGENT_ROUTING_VERSION } from "@/server/agent/manager";
import { getAgentManager } from "@/server/agent/runtime";
import { getConfig } from "@/server/config/env";
import { guardedRead } from "@/server/security/guard";

export const dynamic = "force-dynamic";

/**
 * Read-only, authenticated, NO network: what the RUNNING process is configured with and what the object that answers /agent requests was actually built with.
 * A mismatch (a server that outlived an edit of .env.local or of the code) is reported instead of silently producing answers from a stale setup.
 * Contains no secret: the key and token appear only as present / absent.
 */
export async function GET(req: Request) {
  return guardedRead(req, async () => {
    const cfg = getConfig();
    const names = cfg.allowedApps ? [...cfg.allowedApps].sort() : [];
    const m = getAgentManager().runtimeInfo(names);
    const wantKind = cfg.ai.provider === "boxapi" && cfg.ai.liveRequestsEnabled ? "live" : cfg.ai.provider === "mock" ? "mock" : "disabled";
    const problems: string[] = [];
    if (m.routing !== AGENT_ROUTING_VERSION) problems.push("stale_code");
    if (m.dataMode !== cfg.dataSource) problems.push("data_source_mismatch");
    if (m.allowed.length !== names.length) problems.push("allowlist_mismatch");
    if (m.provider.kind !== wantKind || (wantKind === "live" && m.provider.model !== cfg.ai.boxapi.model)) problems.push("ai_provider_mismatch");
    return {
      process: { startedAt: new Date(Date.now() - process.uptime() * 1000).toISOString() },
      routing: AGENT_ROUTING_VERSION,
      manager: { createdAt: m.createdAt, dataMode: m.dataMode, provider: m.provider, allowed: m.allowed },
      config: {
        dataSource: cfg.dataSource,
        allowedApps: cfg.allowedApps ? names : null,
        liveDeploy: cfg.live.enabled,
        tokenPresent: cfg.liara.token !== null,
        ai: { provider: cfg.ai.provider, liveRequests: cfg.ai.liveRequestsEnabled, model: cfg.ai.boxapi.model, keyPresent: cfg.ai.boxapi.apiKey !== null, maxOutputTokens: cfg.ai.boxapi.maxOutputTokens, maxTotalRequests: cfg.ai.boxapi.maxTotalRequests },
      },
      consistent: problems.length === 0,
      problems,
    };
  });
}
