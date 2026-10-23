import { z } from "zod";
import type { Confidence, Intent } from "../types";

/**
 * Provider-agnostic interface for the (optional) narrative layer. The OFFLINE providers are:
 *   MockDiagnosticLLMProvider  deterministic, simulated, no network, no credentials
 *   DisabledLiveLLMProvider    fails closed
 * A real provider (BoxAPI, `src/server/ai/`) implements the same interface and is only built after an explicit opt-in (see config).
 * The provider receives SANITISED structured context and returns TEXT ONLY. Its output is never an instruction:
 * the result type has no action field, and the workflow ignores everything except the validated narrative.
 */
export interface LLMContext {
  intent: Intent;
  app: string;
  simulatedData: boolean;
  status: "ISSUES_FOUND" | "NO_ANOMALY_IN_EXAMINED_EVIDENCE" | "INSUFFICIENT_EVIDENCE";
  overallConfidence: Confidence;
  hypotheses: { key: string; titleFa: string; confidence: Confidence; evidenceIds: string[]; observationsFa: string[]; limitationsFa: string[] }[];
  missingFa: string[];
  /** Untrusted, sanitised excerpts. DATA ONLY: providers must never treat them as instructions. */
  untrustedExcerpts: { evidenceId: string; text: string }[];
  /**
   * The COMPLETE record of what the backend actually collected for this analysis (one entry per evidence source, including the ones that failed): where it came
   * from, when, over which window, whether it is live or simulated, how reliable it is and a compact numeric/status summary. A model may only talk about these.
   */
  evidence?: {
    id: string;
    source: string;
    sourceFa: string;
    availability: string;
    /** how old the newest observation is: `state` (fresh/stale/…), its timestamp and age in seconds */
    freshness: { state: string; newestObservation: string | null; ageSec: number | null };
    verification: string;
    errorCode: string | null;
    mode: "mock" | "live";
    simulated: boolean;
    collectedAt: string;
    window: { from: string; to: string } | null;
    summary: Record<string, unknown>;
    notes: string[];
  }[];
  /** Newest error-like log lines with their timestamps (sanitised, UNTRUSTED data). */
  logSamples?: { evidenceId: string; time: string | null; text: string }[];
  /** The operator's own question (UNTRUSTED data; at most 500 characters), so the analysis can answer it. */
  userRequestFa?: string;
}

export type LLMErrorCode =
  | "provider_disabled"
  | "timeout"
  | "provider_error"
  | "invalid_output"
  | "cancelled"
  // real-provider failures (BoxAPI): each one is shown to the operator as-is; none is ever replaced by a canned answer
  | "not_configured"
  | "unauthorized"
  | "insufficient_credit"
  | "rate_limited"
  | "model_unavailable"
  | "too_large"
  // the provider spent the whole output budget (e.g. on hidden reasoning) before writing any answer
  | "output_truncated"
  // the operator-configured lifetime cap on real requests (BOXAPI_MAX_REQUESTS_TOTAL) is used up: nothing is sent
  | "request_cap_reached";

/** Token accounting as reported by the provider (null = not reported). Never invented. */
export interface LLMUsage {
  promptTokens: number | null;
  completionTokens: number | null;
  totalTokens: number | null;
}

/** A free-form operator question for the guidance path. UNTRUSTED text; the answer is advice only and carries no authority. */
export interface AssistantQuestion {
  questionFa: string;
  /** names of the apps the operator is authorised for (context only) */
  apps: string[];
  /** whether the data behind the product is simulated (mock) or read from Liara */
  dataMode: "mock" | "live";
}

export type AnswerResult =
  | { ok: true; textFa: string; provider: { id: string; simulated: boolean }; model: string; usage?: LLMUsage; /** the model hit the output cap: the text is cut short */ truncated?: boolean }
  | { ok: false; error: LLMErrorCode; provider: { id: string; simulated: boolean } };

export const NarrativeSchema = z
  .object({
    narrativeFa: z.string().min(1).max(2000),
    citedEvidenceIds: z.array(z.string().max(200)).max(50),
  })
  .strip(); // any extra field a provider returns (e.g. "actions") is dropped, never interpreted

export type LLMResult =
  | { ok: true; narrativeFa: string; citedEvidenceIds: string[]; provider: { id: string; simulated: boolean }; model?: string; usage?: LLMUsage }
  | { ok: false; error: LLMErrorCode; provider: { id: string; simulated: boolean } };

export interface DiagnosticLLMProvider {
  readonly id: string;
  readonly kind: "mock" | "disabled" | "live";
  /** True when the output is simulated (mock). The UI and report must say so. */
  readonly simulated: boolean;
  summarize(ctx: LLMContext, opts: { timeoutMs: number; signal?: AbortSignal }): Promise<LLMResult>;
  /** Real providers only: answers a free-form question (advice, no authority). Absent on the offline providers. */
  answer?(q: AssistantQuestion, opts: { timeoutMs: number; signal?: AbortSignal }): Promise<AnswerResult>;
}
