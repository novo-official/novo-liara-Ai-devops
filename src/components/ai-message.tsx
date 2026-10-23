import { Loader2, RotateCcw } from "lucide-react";
import { Button } from "@/components/ui/button";
import { ai as t } from "@/i18n/agent-fa";
import type { ConversationMessage } from "@/server/agent/types";

/** Footer of a REAL-model answer: says who wrote it, which model, how many tokens, and that it is advice rather than a verified result. */
export function AiAttribution({ m }: { m: ConversationMessage }) {
  if (m.kind !== "ai_answer") return null;
  return (
    <p className="border-t border-border/40 pt-2 text-[11px] leading-5 text-muted-foreground" data-testid="ai-attribution" data-source={m.ai?.source ?? "unknown"}>
      {t.answerNote}
      {m.ai?.truncated && <> {t.truncatedNote}</>}
      {m.ai?.model && (
        <>
          {" "}
          · {t.provider.modelLabel}: <bdi className="ltr-isolate font-mono">{m.ai.model}</bdi>
        </>
      )}
      {m.ai?.usage?.totalTokens != null && (
        <>
          {" "}
          · {m.ai.usage.totalTokens} {t.provider.tokens}
        </>
      )}
    </p>
  );
}

/** Explicit retry for a failed real-model request (never automatic: every attempt is a paid request the operator chooses to make). */
export function AiRetry({ m, question, disabled, onRetry }: { m: ConversationMessage; question: string; disabled: boolean; onRetry: (q: string) => void }) {
  if (m.kind !== "ai_error" || !question || m.ai?.error === "request_cap_reached") return null; // a retry cannot succeed once the lifetime cap is used up
  return (
    <Button type="button" variant="outline" size="sm" className="mt-1 min-h-11 self-start px-3 text-xs" disabled={disabled} onClick={() => onRetry(question)} data-testid="ai-retry">
      <RotateCcw className="size-3.5" aria-hidden />
      {t.retry}
    </Button>
  );
}

/** Shown while the single, non-streamed request to the model is in flight. */
export function ModelPending() {
  return (
    <li className="me-auto flex max-w-[88%] items-center gap-2 rounded-2xl border border-primary/30 bg-primary/5 p-4 text-xs text-muted-foreground" data-testid="ai-loading" role="status">
      <Loader2 className="size-3.5 animate-spin motion-reduce:animate-none text-primary" aria-hidden />
      {t.modelTyping}
    </li>
  );
}
