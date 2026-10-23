import type { AppConfig } from "../config/env";
import { resolveProvider } from "../diagnostics/llm";
import type { DiagnosticLLMProvider } from "../diagnostics/llm/provider";
import { BoxApiLLMProvider } from "./boxapi";

/**
 * The single place that may build a REAL model client. It requires BOTH explicit opt-ins (AI_PROVIDER=boxapi and AI_LIVE_REQUESTS_ENABLED=true — config
 * validation rejects either one alone); anything else resolves to the offline mock or the disabled provider exactly as before. A missing key or model does not
 * fall back to anything: the provider is returned unconfigured and every call reports `not_configured`.
 */
export function resolveAiProvider(cfg: Pick<AppConfig, "ai">): DiagnosticLLMProvider {
  if (cfg.ai.provider === "boxapi" && cfg.ai.liveRequestsEnabled === true) return new BoxApiLLMProvider(cfg.ai.boxapi);
  return resolveProvider(cfg);
}
