import { CheckCircle2, CircleDashed, Loader2, MinusCircle, OctagonX } from "lucide-react";
import { toolNameFa, ui } from "@/i18n/agent-fa";
import { availabilityLabel } from "@/i18n/diagnostics-fa";
import { cn } from "@/lib/utils";
import type { AgentRunRecord } from "@/server/agent/types";
import type { Availability } from "@/server/diagnostics/types";

const icon = { pending: CircleDashed, running: Loader2, succeeded: CheckCircle2, failed: OctagonX, skipped: MinusCircle } as const;

/** Plan + tool execution timeline: which tool, WHY, outcome, evidence availability, failures. Icons never use "success green" for data quality. */
export function ToolTimeline({ run }: { run: AgentRunRecord }) {
  const plan = run.plan;
  return (
    <section aria-labelledby="timeline-h" className="rounded-xl border p-4" data-testid="agent-timeline">
      <h2 id="timeline-h" className="font-semibold">{ui.timelineTitle}</h2>
      {plan && <p className="mt-1 text-xs text-muted-foreground" data-testid="plan-note">{ui.planNote} — <span className="ltr-isolate">{plan.id}</span></p>}
      <ol className="mt-3 flex flex-col gap-2" aria-live="polite" data-testid="tool-list">
        {run.toolCalls.map((t) => {
          const Icon = icon[t.status];
          return (
            <li key={t.stepId} data-tool={t.tool} data-status={t.status} className={cn("rounded-lg border p-3 text-sm", t.status === "running" && "border-primary/40 bg-primary/10")}>
              <div className="flex flex-wrap items-center gap-2">
                <Icon className={cn("size-4 shrink-0", t.status === "running" && "animate-spin text-primary motion-reduce:animate-none", t.status === "succeeded" && "text-primary", t.status === "failed" && "text-destructive")} aria-hidden />
                <span className="font-medium">{toolNameFa[t.tool]}</span>
                <code className="ltr-isolate text-xs text-muted-foreground">{t.tool}</code>
                <span className="ms-auto text-xs text-muted-foreground">{ui.tool[t.status]}</span>
              </div>
              <p className="mt-1 text-xs text-muted-foreground">{t.reasonFa}</p>
              {(t.availability || t.errorCode) && (
                <p className="mt-1 text-xs">
                  {t.availability && <span data-testid="tool-availability" data-availability={t.availability}>{availabilityLabel[t.availability as Availability] ?? t.availability}</span>}
                  {t.errorCode && <span className="text-destructive" data-testid="tool-error"> {ui.toolError[t.errorCode] ?? t.errorCode}</span>}
                  {t.durationMs !== undefined && <span className="text-muted-foreground"> · {new Intl.NumberFormat("fa-IR").format(t.durationMs)} ms</span>}
                </p>
              )}
            </li>
          );
        })}
      </ol>
      {plan && plan.skipped.length > 0 && (
        <div className="mt-3" data-testid="skipped-steps">
          <h3 className="text-sm font-medium">{ui.skippedTitle}</h3>
          <ul className="mt-1 list-disc space-y-1 ps-5 text-xs text-muted-foreground">
            {plan.skipped.map((s, i) => (
              <li key={`${s.tool}-${i}`}>{toolNameFa[s.tool]}: {s.reasonFa}</li>
            ))}
          </ul>
        </div>
      )}
      {run.status === "READY" && <p className="mt-3 text-xs text-muted-foreground" data-testid="analysis-done">{ui.analysisDone}</p>}
    </section>
  );
}
