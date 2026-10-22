"use client";

import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { Bot, Loader2, RotateCcw, Send, ShieldAlert, TriangleAlert, User } from "lucide-react";
import { ApprovalCard } from "@/components/approval-card";
import { DeploymentPanel, UploadCard } from "@/components/deploy-journey";
import { DiagnosticReportView } from "@/components/diagnostic-report";
import { ToolTimeline } from "@/components/tool-timeline";
import { Button } from "@/components/ui/button";
import { SIM_BANNER, SIM_BANNER_LONG, ui } from "@/i18n/agent-fa";
import { liveUi } from "@/i18n/live-fa";
import { faTime } from "@/lib/format";
import { cn } from "@/lib/utils";
import type { ProposalView } from "@/server/agent/manager";
import type { AgentRunRecord, ConversationMessage } from "@/server/agent/types";

interface View {
  conversation: { id: string };
  messages: ConversationMessage[];
  runs: { id: string; status: string }[];
  activeRun: AgentRunRecord | null;
  proposals: ProposalView[];
}

const DEFAULT_SUGGESTIONS = ["چرا برنامه‌ام مدام ری‌استارت می‌شود؟", "برنامه‌ام خطای ۵۰۰ می‌دهد، بررسی کن", "چرا وب‌سایتم کند است؟", "استقرار اخیر چرا شکست خورد؟", "وضعیت سلامت برنامه را بررسی کن", "می‌خوام پروژه‌ام رو دیپلوی کنم", "قبل از انتشار چه چیزهایی کم دارم؟"];

export function AgentWorkspace({ apps, provider, mode }: { apps: string[]; provider: "mock" | "disabled"; mode: "mock" | "live" }) {
  const [convId, setConvId] = useState<string | null>(null);
  const [analysedFile, setAnalysedFile] = useState<File | null>(null); // the analysed archive, in browser memory only (never stored; the server re-verifies it at every live step)
  const [view, setView] = useState<View | null>(null);
  const [text, setText] = useState("");
  const [sending, setSending] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState<"cancel" | "retry" | null>(null);
  const listRef = useRef<HTMLOListElement>(null);

  const refresh = useCallback(async (id: string) => {
    try {
      const res = await fetch(`/api/agent/conversations/${id}`, { cache: "no-store" });
      if (res.status === 401) return setError(ui.sessionLost);
      if (!res.ok) return setError(ui.pollError);
      setError(null);
      setView((await res.json()) as View);
    } catch {
      setError(ui.pollError);
    }
  }, []);

  const run = view?.activeRun ?? null;
  const pendingProposal = view?.proposals.some((p) => p.proposal.status === "PENDING") ?? false;
  const active = run?.status === "RUNNING";

  useEffect(() => {
    if (!convId || (!active && !pendingProposal)) return;
    const id = setInterval(() => !document.hidden && void refresh(convId), active ? 700 : 3000);
    return () => clearInterval(id);
  }, [convId, active, pendingProposal, refresh]);

  useEffect(() => {
    listRef.current?.lastElementChild?.scrollIntoView({ block: "nearest" });
  }, [view?.messages.length]);

  async function send(raw: string) {
    const t = raw.trim();
    if (!t || sending) return;
    setSending(true);
    setError(null);
    try {
      const res = await fetch("/api/agent/messages", { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ text: t, ...(convId ? { conversationId: convId } : {}) }) });
      const j = (await res.json()) as { conversationId?: string; error?: { message?: string } };
      if (!res.ok || !j.conversationId) {
        setError(j.error?.message ?? ui.pollError);
        return;
      }
      setText((cur) => (cur.trim() === t ? "" : cur)); // never wipe something the operator started typing meanwhile
      setConvId(j.conversationId);
      await refresh(j.conversationId);
    } catch {
      setError(ui.pollError);
    } finally {
      setSending(false);
    }
  }

  function afterUpload(id: string, file: File) {
    setAnalysedFile(file);
    setConvId(id);
    void refresh(id);
  }

  async function control(kind: "cancel" | "retry") {
    if (!run || !convId) return;
    setBusy(kind);
    try {
      await fetch(`/api/agent/runs/${run.id}/${kind}`, { method: "POST", headers: { "Content-Type": "application/json" }, body: "{}" });
      await refresh(convId);
    } finally {
      setBusy(null);
    }
  }

  const lastAgent = useMemo(() => [...(view?.messages ?? [])].reverse().find((m) => m.role === "agent"), [view?.messages]);
  const suggestions = lastAgent?.suggestions?.length ? lastAgent.suggestions : DEFAULT_SUGGESTIONS;

  return (
    <div className="flex flex-col gap-4" data-testid="agent-workspace" data-mode={mode}>
      <div role="status" data-testid="sim-banner" className="flex flex-wrap items-start gap-2 rounded-lg border border-warning/60 bg-warning/10 p-3 text-sm text-warning">
        <ShieldAlert className="mt-0.5 size-4 shrink-0" aria-hidden />
        <div>
          <strong>{SIM_BANNER}</strong>
          <p className="mt-0.5 text-xs">{SIM_BANNER_LONG}</p>
        </div>
      </div>
      <p className="text-xs text-muted-foreground" data-testid="limits-note">{ui.limits}</p>
      <p className="text-xs text-muted-foreground" data-testid="agent-provider" data-provider={provider}>{provider === "mock" ? ui.provider.mock : ui.provider.disabled}</p>

      <div className="grid gap-4 lg:grid-cols-[minmax(0,5fr)_minmax(0,6fr)]">
        {/* ---- conversation ---- */}
        <section aria-labelledby="conv-h" className="flex min-w-0 flex-col gap-3 rounded-xl border p-4">
          <h2 id="conv-h" className="font-semibold">{ui.conversation}</h2>
          <ol ref={listRef} className="flex max-h-[28rem] min-h-40 flex-col gap-2 overflow-y-auto" aria-live="polite" data-testid="messages" tabIndex={0} aria-label={ui.conversation}>
            {(view?.messages.length ?? 0) === 0 && <li className="rounded-lg border border-dashed p-4 text-sm text-muted-foreground" data-testid="empty-conversation">{ui.empty}</li>}
            {view?.messages.map((m) => (
              <li key={m.id} data-kind={m.kind} data-role={m.role} className={cn("rounded-lg border p-3 text-sm", m.role === "user" ? "border-primary/40 bg-primary/10" : m.role === "system" ? "border-dashed text-muted-foreground" : m.kind === "refusal" ? "border-warning/40 bg-warning/5" : "bg-muted/30")}>
                <div className="mb-1 flex items-center gap-1.5 text-xs text-muted-foreground">
                  {m.role === "user" ? <User className="size-3.5" aria-hidden /> : m.kind === "refusal" ? <TriangleAlert className="size-3.5 text-warning" aria-hidden /> : <Bot className="size-3.5" aria-hidden />}
                  <span>{ui.roles[m.role]}</span>
                  <span className="ms-auto">{faTime(m.at)}</span>
                </div>
                <p className="leading-7 whitespace-pre-wrap">{m.textFa}</p>
                {m.action === "upload_project" && (
                  <Button variant="outline" className="mt-2 min-h-11 px-3" data-testid="goto-upload" onClick={() => { const el = document.getElementById("zip-m") ?? document.getElementById("zip-c"); el?.scrollIntoView({ block: "center" }); (el as HTMLInputElement | null)?.focus(); }}>رفتن به بارگذاری پروژه</Button>
                )}
              </li>
            ))}
          </ol>

          <div className="flex flex-wrap gap-2" data-testid="suggestions" aria-label={ui.suggestions}>
            {suggestions.slice(0, 7).map((s) => (
              <button key={s} type="button" disabled={sending || active} onClick={() => void send(s)} className="min-h-11 rounded-full border px-3 text-xs hover:bg-muted disabled:opacity-50" data-testid="suggestion">{s}</button>
            ))}
          </div>

          <form onSubmit={(e) => { e.preventDefault(); void send(text); }} className="flex flex-col gap-2" data-testid="composer">
            <label htmlFor="agent-text" className="text-sm font-medium">{ui.composerLabel}</label>
            <textarea
              id="agent-text" value={text} maxLength={500} rows={3} onChange={(e) => setText(e.target.value)} aria-describedby="composer-hint"
              onKeyDown={(e) => { if (e.key === "Enter" && !e.shiftKey && !e.nativeEvent.isComposing) { e.preventDefault(); void send(text); } }}
              className="min-h-24 w-full rounded-lg border border-input bg-background p-3 text-base leading-7" data-testid="agent-input"
            />
            <p id="composer-hint" className="text-xs text-muted-foreground">{ui.composerHint} · {apps.length} برنامهٔ مجاز</p>
            {error && <p role="alert" className="text-sm text-destructive" data-testid="agent-error">{error}</p>}
            <Button type="submit" size="lg" disabled={sending || !text.trim() || active} className="h-11 text-base sm:w-fit" data-testid="send">
              {sending ? <Loader2 className="animate-spin motion-reduce:animate-none" aria-hidden /> : <Send aria-hidden />}
              {sending ? ui.sending : ui.send}
            </Button>
          </form>
        </section>

        {/* ---- run panel ---- */}
        <div className="flex min-w-0 flex-col gap-4" data-testid="run-panel">
          {run ? (
            <>
              <div className="flex flex-wrap items-center gap-2">
                <span data-testid="agent-run-status" data-status={run.status} data-phase={run.phase} className={cn("inline-flex items-center gap-2 rounded-full border px-3 py-1 text-sm", run.status === "FAILED" || run.status === "TIMED_OUT" || run.status === "CANCELLED" ? "border-destructive/50 text-destructive" : "border-primary/50 text-primary")}>
                  {run.status === "RUNNING" && <Loader2 className="size-4 animate-spin motion-reduce:animate-none" aria-hidden />}
                  {ui.runStatus[run.status]} · {ui.phase[run.phase]}
                </span>
                <bdi className="ltr-isolate text-sm">{run.app}</bdi>
                <span className="ms-auto flex gap-2">
                  {run.status === "RUNNING" && <Button variant="outline" className="min-h-11 px-3" disabled={busy !== null} onClick={() => void control("cancel")} data-testid="agent-cancel">{ui.cancel}</Button>}
                  {run.kind !== "deployment" && (run.status === "FAILED" || run.status === "TIMED_OUT") && <Button variant="outline" className="min-h-11 px-3" disabled={busy !== null} onClick={() => void control("retry")} data-testid="agent-retry"><RotateCcw aria-hidden />{ui.retry}</Button>}
                </span>
              </div>
              {run.errorCode && <p role="alert" data-testid="agent-run-error" data-code={run.errorCode} className="rounded-lg border border-destructive/40 bg-destructive/10 p-3 text-sm">{ui.runError[run.errorCode] ?? run.errorCode}</p>}
              {run.kind === "deployment" && run.deployment ? (
                <>
                  <DeploymentPanel key={run.id} run={run} proposals={view?.proposals ?? []} initialFile={analysedFile} onChanged={() => convId && void refresh(convId)} />
                  <details className="rounded-xl border p-3" data-testid="upload-new-version">
                    <summary className="min-h-11 cursor-pointer py-2 text-sm font-medium">{liveUi.flow.uploadNewVersion}</summary>
                    <p className="mt-1 text-xs leading-6 text-muted-foreground">{liveUi.flow.uploadNewVersionHint}</p>
                    <div className="mt-2"><UploadCard compact conversationId={convId} onUploaded={afterUpload} /></div>
                  </details>
                </>
              ) : (
                <>
              {view && view.proposals.length > 0 && (
                <section aria-labelledby="prop-h" className="flex flex-col gap-3" data-testid="proposals">
                  <h2 id="prop-h" className="font-semibold">{ui.proposals}</h2>
                  {view.proposals.map((pv) => (
                    <ApprovalCard key={pv.proposal.id} view={pv} onChanged={() => convId && void refresh(convId)} />
                  ))}
                </section>
              )}
              <ToolTimeline run={run} />
              {run.report && <DiagnosticReportView report={run.report} />}
                  <UploadCard conversationId={convId} onUploaded={afterUpload} />
                </>
              )}
            </>
          ) : (
            <>
            <UploadCard conversationId={convId} onUploaded={afterUpload} />
            <p className="rounded-xl border border-dashed p-6 text-sm text-muted-foreground" data-testid="no-run">پس از شروع یک بررسی، برنامهٔ ابزارها، اجرای زندهٔ آن‌ها، گزارش و پیشنهادها اینجا نمایش داده می‌شوند.</p>
            </>
          )}
        </div>
      </div>
    </div>
  );
}
