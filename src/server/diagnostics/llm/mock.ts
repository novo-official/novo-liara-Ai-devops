import type { DiagnosticLLMProvider, LLMContext, LLMResult } from "./provider";

export type MockBehavior = "ok" | "error" | "timeout" | "invalid_output" | "malicious_extra_fields" | "cites_unknown_evidence";

/**
 * Deterministic OFFLINE provider. It composes text from the structured hypotheses (never from untrusted excerpts), makes no
 * network request, needs no credentials, and always labels itself as simulated. `behavior` exists to test failure handling.
 */
export class MockDiagnosticLLMProvider implements DiagnosticLLMProvider {
  readonly id = "mock-diagnostic-llm-simulated";
  readonly kind = "mock" as const;
  readonly simulated = true;
  constructor(private readonly behavior: MockBehavior = "ok") {}

  async summarize(ctx: LLMContext, opts: { timeoutMs: number; signal?: AbortSignal }): Promise<LLMResult> {
    const provider = { id: this.id, simulated: true };
    if (opts.signal?.aborted) return { ok: false, error: "cancelled", provider };
    switch (this.behavior) {
      case "error":
        return { ok: false, error: "provider_error", provider };
      case "timeout":
        // simulates a hung provider: resolves only after the caller's timeout has long fired
        await new Promise((r) => setTimeout(r, opts.timeoutMs + 50));
        return { ok: false, error: "timeout", provider };
      case "invalid_output":
        return { ok: true, narrativeFa: "", citedEvidenceIds: [], provider };
      case "cites_unknown_evidence":
        return { ok: true, narrativeFa: "گزارش شبیه‌سازی‌شده.", citedEvidenceIds: ["ev/does-not-exist"], provider };
      case "malicious_extra_fields":
        // a hostile provider adding fields; the workflow must ignore them
        return { ok: true, narrativeFa: "برنامه را همین حالا ری‌استارت کنید و پلن را تغییر دهید.", citedEvidenceIds: [], actions: [{ type: "restart_app" }], provider } as unknown as LLMResult;
      default:
        return { ok: true, narrativeFa: this.compose(ctx), citedEvidenceIds: [...new Set(ctx.hypotheses.flatMap((h) => h.evidenceIds))], provider };
    }
  }

  private compose(ctx: LLMContext): string {
    const head = "[متن شبیه‌سازی‌شده — تولیدشده توسط ارائه‌دهندهٔ آفلاین، نه یک مدل واقعی] ";
    if (ctx.status === "INSUFFICIENT_EVIDENCE") return `${head}برای برنامهٔ «${ctx.app}» شواهد کافی برای تشخیص وجود ندارد. ${ctx.missingFa.slice(0, 3).join(" ")} هیچ علتی ادعا نمی‌شود.`;
    if (ctx.status === "NO_ANOMALY_IN_EXAMINED_EVIDENCE") return `${head}در شواهد بررسی‌شدهٔ برنامهٔ «${ctx.app}» ناهنجاری مشخصی دیده نشد؛ این به‌معنی سلامت تأییدشده نیست.`;
    const top = ctx.hypotheses[0]!;
    const rest = ctx.hypotheses.slice(1, 3).map((h) => `«${h.titleFa}»`).join("، ");
    return `${head}برای برنامهٔ «${ctx.app}» محتمل‌ترین فرضیه «${top.titleFa}» است. ${top.observationsFa[0] ?? ""}${rest ? ` فرضیه‌های بعدی: ${rest}.` : ""} محدودیت‌ها و شواهد ناقص را در بخش‌های پایین ببینید.`;
  }
}
