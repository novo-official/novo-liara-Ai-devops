"use client";

import { useRouter } from "next/navigation";
import { useCallback, useEffect, useState } from "react";
import { CheckCircle2, CircleDashed, Loader2, MinusCircle, OctagonX, TriangleAlert, RotateCcw } from "lucide-react";
import { Button } from "@/components/ui/button";
import { DiagnosticReportView } from "@/components/diagnostic-report";
import { Freshness } from "@/components/freshness";
import { errorMessage, fa } from "@/i18n/fa";
import { cn } from "@/lib/utils";
import type { RunRecord } from "@/server/diagnostics/store";

const TERMINAL = ["COMPLETED", "COMPLETED_WITH_GAPS", "FAILED", "CANCELLED", "TIMED_OUT"];
const a = fa.assistant;

const stepIcon = { pending: CircleDashed, running: Loader2, done: CheckCircle2, skipped: MinusCircle, failed: OctagonX } as const;

/** Polls the run (GET only) until it reaches a terminal status, showing a live timeline and then the report. */
export function RunView({ initial }: { initial: RunRecord }) {
  const router = useRouter();
  const [run, setRun] = useState<RunRecord>(initial);
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState<"cancel" | "retry" | null>(null);
  const terminal = TERMINAL.includes(run.status);

  const poll = useCallback(async () => {
    try {
      const res = await fetch(`/api/diagnostic-runs/${run.id}`, { cache: "no-store" });
      if (res.status === 401) return setError(a.sessionLost);
      if (!res.ok) return setError(a.pollError);
      setError(null);
      setRun(((await res.json()) as { run: RunRecord }).run);
    } catch {
      setError(a.pollError);
    }
  }, [run.id]);

  useEffect(() => {
    if (terminal) return;
    const started = Date.now(); // pure at effect time
    const id = setInterval(() => {
      if (document.hidden) return;
      if (Date.now() - started > 180_000) return clearInterval(id); // hard stop: the server enforces its own run timeout
      void poll();
    }, 700);
    return () => clearInterval(id);
  }, [terminal, poll]);

  async function post(url: string, body: unknown) {
    return fetch(url, { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify(body) });
  }

  async function cancel() {
    setBusy("cancel");
    try {
      const res = await post(`/api/diagnostic-runs/${run.id}/cancel`, {});
      if (res.ok) setRun(((await res.json()) as { run: RunRecord }).run);
    } finally {
      setBusy(null);
    }
  }

  async function retry() {
    setBusy("retry");
    try {
      const res = await post("/api/diagnostic-runs", { app: run.app, intent: run.intent, windowMinutes: run.windowMinutes, retryOf: run.id });
      if (res.ok) {
        const next = ((await res.json()) as { run: RunRecord }).run;
        router.push(`/assistant/runs/${next.id}`);
      } else setError(((await res.json()) as { error?: { message?: string } }).error?.message ?? a.pollError);
    } finally {
      setBusy(null);
    }
  }

  const failedStatus = run.status === "FAILED" || run.status === "TIMED_OUT" || run.status === "CANCELLED";
  return (
    <div className="flex flex-col gap-6">
      <div className="flex flex-wrap items-center justify-between gap-3">
        <div className="flex flex-wrap items-center gap-3">
          <span data-testid="run-status" data-status={run.status} data-phase={run.phase} className={cn("inline-flex items-center gap-2 rounded-full border px-3 py-1 text-sm", failedStatus ? "border-destructive/50 text-destructive" : run.status === "RUNNING" ? "border-primary/50 text-primary" : run.status === "COMPLETED_WITH_GAPS" ? "border-warning/50 text-warning" : "border-success/50 text-success")}>
            {run.status === "RUNNING" && <Loader2 className="size-4 animate-spin motion-reduce:animate-none" aria-hidden />}
            {a.runStatus[run.status]}
          </span>
          <Freshness fetchedAt={run.updatedAt} staleAfterSec={3600} />
        </div>
        <div className="flex gap-2">
          {run.status === "RUNNING" && (
            <Button variant="outline" className="min-h-11 px-3" onClick={cancel} disabled={busy !== null} data-testid="cancel-run">
              {busy === "cancel" ? a.cancelling : a.cancel}
            </Button>
          )}
          {(run.status === "FAILED" || run.status === "TIMED_OUT" || run.status === "COMPLETED_WITH_GAPS") && (
            <Button variant="outline" className="min-h-11 px-3" onClick={retry} disabled={busy !== null} data-testid="retry-run">
              <RotateCcw aria-hidden /> {a.retry}
            </Button>
          )}
        </div>
      </div>

      {run.errorCode && (
        <div role="alert" data-testid="run-error" data-code={run.errorCode} className="flex items-start gap-2 rounded-lg border border-destructive/40 bg-destructive/10 p-3 text-sm">
          <TriangleAlert className="mt-0.5 size-4 shrink-0 text-destructive" aria-hidden />
          {a.runError[run.errorCode] ?? errorMessage("internal")}
        </div>
      )}
      {error && (
        <p role="alert" className="rounded-lg border border-warning/40 bg-warning/10 p-3 text-sm text-warning">
          {error}
        </p>
      )}

      <section aria-labelledby="timeline-title" className="rounded-xl border p-4">
        <h2 id="timeline-title" className="mb-3 font-semibold">
          {a.timelineTitle}
        </h2>
        <ol className="flex flex-col gap-2" data-testid="timeline" aria-live="polite">
          {run.steps.map((s) => {
            const Icon = stepIcon[s.status];
            return (
              <li key={s.key} data-step={s.key} data-status={s.status} className={cn("flex items-center gap-3 rounded-lg px-2 py-1.5 text-sm", s.status === "running" && "bg-primary/10", s.status === "skipped" && "text-muted-foreground")}>
                <Icon className={cn("size-4 shrink-0", s.status === "running" && "animate-spin text-primary motion-reduce:animate-none", s.status === "done" && "text-success", s.status === "failed" && "text-destructive")} aria-hidden />
                <span>{a.steps[s.key]}</span>
                <span className="ms-auto text-xs text-muted-foreground">{a.stepStatus[s.status]}</span>
              </li>
            );
          })}
        </ol>
      </section>

      {run.report ? (
        <DiagnosticReportView report={run.report} />
      ) : terminal ? (
        <p className="rounded-lg border border-dashed p-4 text-sm text-muted-foreground" data-testid="no-report">
          {a.runError[run.errorCode ?? ""] ?? errorMessage("internal")}
        </p>
      ) : (
        <p className="text-sm text-muted-foreground" aria-live="polite">
          {fa.state.loading}
        </p>
      )}
    </div>
  );
}
