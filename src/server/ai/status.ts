import type { AppConfig } from "../config/env";
import type { LLMErrorCode, LLMUsage } from "../diagnostics/llm/provider";

/**
 * What the operator may be told about the AI provider WITHOUT proving anything: configuration status (a label is not evidence of a working call) and the
 * outcome of the LAST real request (time, model, tokens, failure category). Process-local; contains no prompt, no answer and no credential.
 */
export interface AiCallRecord {
  at: string;
  ok: boolean;
  model: string | null;
  error: LLMErrorCode | null;
  httpStatus: number | null;
  usage: LLMUsage | null;
  durationMs: number;
}
export interface AiStatus {
  provider: "mock" | "disabled" | "boxapi";
  /** both opt-ins given (AI_PROVIDER=boxapi + AI_LIVE_REQUESTS_ENABLED=true) */
  enabled: boolean;
  /** key and model present (the key itself is never exposed) */
  configured: boolean;
  model: string | null;
  missing: ("api_key" | "model")[];
  last: AiCallRecord | null;
  requestCount: number;
  /** the configured lifetime cap on real requests for this process (null = none) */
  maxTotal: number | null;
}

const g = globalThis as unknown as { __aiLast?: AiCallRecord; __aiCount?: number; __aiSent?: number };

/** Process-wide count of requests actually SENT (shared by every provider instance). Returns false — and sends nothing — once the configured lifetime cap is reached. */
export function reserveRequest(maxTotal: number | null): boolean {
  if (maxTotal !== null && (g.__aiSent ?? 0) >= maxTotal) return false;
  g.__aiSent = (g.__aiSent ?? 0) + 1;
  return true;
}

export function recordAiCall(r: AiCallRecord): void {
  g.__aiLast = r;
  g.__aiCount = (g.__aiCount ?? 0) + 1;
}
export function __resetAiStatusForTests(): void {
  g.__aiLast = undefined;
  g.__aiCount = undefined;
  g.__aiSent = undefined;
}

export function getAiStatus(cfg: Pick<AppConfig, "ai">): AiStatus {
  const b = cfg.ai.boxapi;
  const missing: AiStatus["missing"] = [...(b.apiKey ? [] : (["api_key"] as const)), ...(b.model ? [] : (["model"] as const))];
  const enabled = cfg.ai.provider === "boxapi" && cfg.ai.liveRequestsEnabled;
  return { provider: cfg.ai.provider, enabled, configured: enabled && missing.length === 0, model: enabled ? b.model : null, missing: enabled ? missing : [], last: enabled ? (g.__aiLast ?? null) : null, requestCount: enabled ? (g.__aiSent ?? 0) : 0, maxTotal: enabled ? b.maxTotalRequests : null };
}
