import { z } from "zod";
import type { Confidence, Intent } from "../types";

/**
 * Provider-agnostic interface for the (optional) narrative layer. In Phase 1C only OFFLINE providers exist:
 *   MockDiagnosticLLMProvider  deterministic, simulated, no network, no credentials
 *   DisabledLiveLLMProvider    fails closed
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
}

export type LLMErrorCode = "provider_disabled" | "timeout" | "provider_error" | "invalid_output" | "cancelled";

export const NarrativeSchema = z
  .object({
    narrativeFa: z.string().min(1).max(2000),
    citedEvidenceIds: z.array(z.string().max(200)).max(50),
  })
  .strip(); // any extra field a provider returns (e.g. "actions") is dropped, never interpreted

export type LLMResult =
  | { ok: true; narrativeFa: string; citedEvidenceIds: string[]; provider: { id: string; simulated: boolean } }
  | { ok: false; error: LLMErrorCode; provider: { id: string; simulated: boolean } };

export interface DiagnosticLLMProvider {
  readonly id: string;
  readonly kind: "mock" | "disabled" | "live";
  /** True when the output is simulated (mock). The UI and report must say so. */
  readonly simulated: boolean;
  summarize(ctx: LLMContext, opts: { timeoutMs: number; signal?: AbortSignal }): Promise<LLMResult>;
}
