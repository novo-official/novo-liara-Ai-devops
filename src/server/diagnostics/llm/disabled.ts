import type { DiagnosticLLMProvider, LLMContext, LLMResult } from "./provider";

/**
 * Fail-closed placeholder for any future live provider. It performs NO I/O and never reads credentials: every call is refused.
 * Phase 1C has no live AI client at all; this class is what `AI_PROVIDER=disabled` (and any attempt to reach "live") resolves to.
 */
export class DisabledLiveLLMProvider implements DiagnosticLLMProvider {
  readonly id = "disabled";
  readonly kind = "disabled" as const;
  readonly simulated = false;
  async summarize(...args: [LLMContext, { timeoutMs: number; signal?: AbortSignal }]): Promise<LLMResult> {
    void args; // intentionally ignored: no I/O, no use of the context
    return { ok: false, error: "provider_disabled", provider: { id: this.id, simulated: false } };
  }
}
