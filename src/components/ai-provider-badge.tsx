import { Sparkles } from "lucide-react";
import { ai as t } from "@/i18n/agent-fa";
import { faTime } from "@/lib/format";
import type { AiStatus } from "@/server/ai/status";

/**
 * Shows which text generator is configured and what the LAST real request did. "Configured" is only a configuration fact; the last-request line is the
 * only evidence of a working call. Renders nothing unless the real provider (BoxAPI) is opted in. Contains no credential, prompt or answer.
 */
export function AiProviderBadge({ ai }: { ai: AiStatus }) {
  if (!ai.enabled) return null;
  const p = t.provider;
  return (
    <div data-testid="ai-provider-badge" data-provider="boxapi" data-configured={ai.configured ? "true" : "false"} className="flex flex-col gap-1.5 rounded-2xl border border-primary/30 bg-primary/10 px-4 py-3 text-xs sm:text-sm text-primary shadow-xs">
      <p className="flex flex-wrap items-center gap-2 font-semibold">
        <Sparkles className="size-4.5 shrink-0" aria-hidden />
        <span>{p.heading}</span>
        {ai.model && (
          <span className="text-foreground/80">
            · {p.modelLabel}: <bdi className="ltr-isolate font-mono" data-testid="ai-model">{ai.model}</bdi>
          </span>
        )}
      </p>
      <p className="text-foreground/80">{p.enabledNote}</p>
      <p data-testid="ai-config-status" className="text-foreground/80">
        {ai.configured ? p.configured : `${p.incomplete}: ${ai.missing.map((m) => p.missing[m] ?? m).join("، ")}`}
      </p>
      {ai.maxTotal !== null && (
        <p data-testid="ai-request-cap" className="text-foreground/80">
          {p.requestsSent}: <span className="font-mono">{ai.requestCount}</span> / <span className="font-mono">{ai.maxTotal}</span>
        </p>
      )}
      <p data-testid="ai-last-call" data-ok={ai.last ? (ai.last.ok ? "true" : "false") : "none"} className="text-foreground/80">
        {!ai.last
          ? p.lastNone
          : ai.last.ok
            ? `${p.lastOk}: ${faTime(ai.last.at)}${ai.last.usage?.totalTokens != null ? ` · ${ai.last.usage.totalTokens} ${p.tokens}` : ""}`
            : `${p.lastFail}: ${faTime(ai.last.at)} · ${t.errors[ai.last.error ?? "provider_error"] ?? t.errors.provider_error}`}
      </p>
    </div>
  );
}
