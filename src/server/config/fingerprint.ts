import { createHash } from "node:crypto";
import type { AppConfig } from "./env";

/**
 * A stable fingerprint of everything that decides WHAT a long-lived service object does (data source, scope, credentials, AI provider/model/limits, live flags).
 * Process-wide singletons (Liara service, agent manager, live service) are rebuilt when it changes, so a server that outlives an edit of .env.local — or of the code,
 * see the class-identity check in the runtimes — never keeps serving with the old behaviour. Secrets enter only as hashes and the result is a hash.
 */
export function configFingerprint(cfg: AppConfig): string {
  const h = (v: string | null | undefined) => (v ? createHash("sha256").update(v).digest("hex").slice(0, 12) : null);
  const material = {
    dataSource: cfg.dataSource,
    base: cfg.liara.baseUrl.href,
    token: h(cfg.liara.token?.reveal()),
    team: cfg.liara.teamId,
    apps: cfg.allowedApps ? [...cfg.allowedApps].sort() : null,
    liveDeploy: cfg.live.enabled,
    liveSuffixes: [...cfg.live.appDomainSuffixes],
    cli: cfg.cli.enabled,
    ai: { provider: cfg.ai.provider, live: cfg.ai.liveRequestsEnabled, model: cfg.ai.boxapi.model, base: cfg.ai.boxapi.baseUrl, key: h(cfg.ai.boxapi.apiKey?.reveal()), out: cfg.ai.boxapi.maxOutputTokens, timeout: cfg.ai.boxapi.timeoutMs, cap: cfg.ai.boxapi.maxTotalRequests },
  };
  return createHash("sha256").update(JSON.stringify(material)).digest("hex").slice(0, 16);
}
