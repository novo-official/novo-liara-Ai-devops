"use client";

import { useRouter } from "next/navigation";
import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { Bot, Loader2, MessageSquarePlus, RotateCcw, Send, ShieldAlert, Sparkles, TriangleAlert, User } from "lucide-react";
import { AiAttribution, AiRetry, ModelPending } from "@/components/ai-message";
import { AiProviderBadge } from "@/components/ai-provider-badge";
import { ServerRuntimePanel } from "@/components/server-runtime-panel";
import { ApprovalCard } from "@/components/approval-card";
import { DeploymentPanel, UploadCard } from "@/components/deploy-journey";
import { DiagnosticReportView } from "@/components/diagnostic-report";
import { ToolTimeline } from "@/components/tool-timeline";
import { Button } from "@/components/ui/button";
import { ai as aiUi, LIVE_CONTEXT_BANNER, LIVE_CONTEXT_BANNER_LONG, SIM_BANNER, SIM_BANNER_LONG, ui } from "@/i18n/agent-fa";
import { liveUi } from "@/i18n/live-fa";
import { faTime } from "@/lib/format";
import { cn } from "@/lib/utils";
import type { AiStatus } from "@/server/ai/status";
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

export function AgentWorkspace({ apps, provider, mode, ai }: { apps: string[]; provider: "mock" | "disabled" | "boxapi"; mode: "mock" | "live"; ai?: AiStatus }) {
  const router = useRouter();
  const modelOn = ai?.enabled === true;
  const canAsk = modelOn && ai?.configured === true;
  const [convId, setConvId] = useState<string | null>(null);
  const [analysedFile, setAnalysedFile] = useState<File | null>(null); // the analysed archive, in browser memory only (never stored; the server re-verifies it at every live step)
  const [view, setView] = useState<View | null>(null);
  const [text, setText] = useState("");
  const [sending, setSending] = useState(false);
  const [asking, setAsking] = useState(false); // the request in flight goes to the real model
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

  const runStatus = run?.status;
  useEffect(() => {
    if (modelOn && runStatus && runStatus !== "RUNNING") router.refresh(); // a finished investigation may have used the model for its narrative
  }, [modelOn, runStatus, router]);

  useEffect(() => {
    listRef.current?.lastElementChild?.scrollIntoView({ block: "nearest" });
  }, [view?.messages.length]);

  async function send(raw: string, askModel = false) {
    const t = raw.trim();
    if (!t || sending) return;
    setSending(true);
    setAsking(askModel);
    setError(null);
    try {
      const res = await fetch("/api/agent/messages", { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ text: t, ...(askModel ? { askModel: true } : {}), ...(convId ? { conversationId: convId } : {}) }) });
      const j = (await res.json()) as { conversationId?: string; error?: { message?: string } };
      if (!res.ok || !j.conversationId) {
        setError(j.error?.message ?? ui.pollError);
        return;
      }
      setText((cur) => (cur.trim() === t ? "" : cur)); // never wipe something the operator started typing meanwhile
      setConvId(j.conversationId);
      await refresh(j.conversationId);
      if (modelOn) router.refresh(); // re-reads the server-rendered badge: last request, token count, requests sent / cap
    } catch {
      setError(ui.pollError);
    } finally {
      setSending(false);
      setAsking(false);
    }
  }

  function newConversation() {
    setConvId(null);
    setView(null);
    setError(null);
    setText("");
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

  const lastUserText = useMemo(() => [...(view?.messages ?? [])].reverse().find((m) => m.role === "user")?.textFa ?? "", [view?.messages]);
  const lastAgent = useMemo(() => [...(view?.messages ?? [])].reverse().find((m) => m.role === "agent"), [view?.messages]);
  const suggestions = lastAgent?.suggestions?.length ? lastAgent.suggestions : DEFAULT_SUGGESTIONS;

  return (
    <div className="flex flex-col gap-5" data-testid="agent-workspace" data-mode={mode}>
      {/* Status banner */}
      <div className="flex flex-wrap items-center justify-between gap-3">
        {mode === "live" ? (
          <div role="status" data-testid="live-context-banner" data-mode="live" className="flex flex-1 min-w-[280px] items-center gap-3 rounded-2xl border border-primary/30 bg-primary/10 px-4 py-2.5 text-xs sm:text-sm text-primary backdrop-blur-md shadow-xs">
            <ShieldAlert className="size-5 shrink-0" aria-hidden />
            <div>
              <strong className="font-bold">{LIVE_CONTEXT_BANNER}</strong>
              <span className="ms-2 opacity-85 text-xs">{LIVE_CONTEXT_BANNER_LONG}</span>
            </div>
          </div>
        ) : (
          <div role="status" data-testid="sim-banner" data-mode="mock" className="flex flex-1 min-w-[280px] items-center gap-3 rounded-2xl border border-warning/30 bg-warning/10 px-4 py-2.5 text-xs sm:text-sm text-warning backdrop-blur-md shadow-xs">
            <ShieldAlert className="size-5 shrink-0" aria-hidden />
            <div>
              <strong className="font-bold">{SIM_BANNER}</strong>
              <span className="ms-2 opacity-85 text-xs">{SIM_BANNER_LONG}</span>
            </div>
          </div>
        )}

        <div className="flex items-center gap-3 text-xs text-muted-foreground bg-card/60 px-3.5 py-2 rounded-xl border border-border/60">
          <span data-testid="limits-note">{modelOn ? aiUi.provider.liveLimits : ui.limits}</span>
          <span className="opacity-40">|</span>
          <span data-testid="agent-provider" data-provider={provider} className="font-medium text-foreground/80">
            {provider === "boxapi" ? aiUi.provider.heading : provider === "mock" ? ui.provider.mock : ui.provider.disabled}
          </span>
        </div>
      </div>

      {ai && <AiProviderBadge ai={ai} />}
      <ServerRuntimePanel />

      <div className="grid gap-6 lg:grid-cols-[minmax(0,5.5fr)_minmax(0,6.5fr)] items-start">
        {/* ---- conversation ---- */}
        <section aria-labelledby="conv-h" className="flex min-w-0 flex-col rounded-2xl border border-border/80 bg-card/70 backdrop-blur-md shadow-xs overflow-hidden">
          <div className="border-b border-border/50 px-5 py-3.5 flex items-center justify-between bg-muted/20">
            <h2 id="conv-h" className="font-bold text-sm sm:text-base flex items-center gap-2">
              <Bot className="size-4.5 text-primary" aria-hidden />
              <span>{ui.conversation}</span>
            </h2>
            <div className="flex items-center gap-2">
              {view && view.messages.length > 0 && (
                <span className="text-xs font-mono text-muted-foreground bg-muted/50 px-2 py-0.5 rounded-full border border-border/40">
                  {view.messages.length} پیام
                </span>
              )}
              {view && view.messages.length > 0 && (
                <Button type="button" variant="outline" size="sm" className="min-h-11 px-3 text-xs" disabled={sending || active} onClick={newConversation} data-testid="new-conversation">
                  <MessageSquarePlus className="size-3.5" aria-hidden />
                  {aiUi.newConversation}
                </Button>
              )}
            </div>
          </div>

          <div className="flex flex-col p-4 sm:p-5 gap-4">
            <ol
              ref={listRef}
              className="flex h-[26rem] min-h-60 flex-col gap-3 overflow-y-auto pe-1.5 focus:outline-none"
              aria-live="polite"
              data-testid="messages"
              tabIndex={0}
              aria-label={ui.conversation}
            >
              {(view?.messages.length ?? 0) === 0 && (
                <li className="my-auto flex flex-col items-center justify-center gap-2 rounded-xl border border-dashed border-border/70 p-8 text-center text-sm text-muted-foreground bg-muted/10" data-testid="empty-conversation">
                  <Bot className="size-8 text-muted-foreground/50 mb-1" aria-hidden />
                  <p className="font-medium">{ui.empty}</p>
                  <p className="text-xs max-w-xs opacity-75">سؤالی بپرسید یا یکی از الگوهای پیشنهادی زیر را انتخاب کنید.</p>
                  {canAsk && (
                    <button type="button" className="mt-2 min-h-11 rounded-xl border border-primary/40 bg-primary/10 px-3 py-2 text-xs leading-6 text-primary hover:bg-primary/15" onClick={() => setText(aiUi.examplePrompt)} data-testid="example-prompt">
                      {aiUi.examplePrompt}
                    </button>
                  )}
                </li>
              )}
              {view?.messages.map((m) => {
                const isUser = m.role === "user";
                const isSystem = m.role === "system";
                const isRefusal = m.kind === "refusal";
                const isAiAnswer = m.kind === "ai_answer";
                const isAiError = m.kind === "ai_error";
                return (
                  <li
                    key={m.id}
                    data-kind={m.kind}
                    data-role={m.role}
                    className={cn(
                      "flex flex-col gap-1.5 rounded-2xl p-4 text-sm transition-all duration-200 shadow-xs",
                      isUser
                        ? "ms-auto max-w-[85%] bg-primary text-primary-foreground rounded-br-xs shadow-primary/10"
                        : isSystem
                        ? "mx-auto max-w-[90%] border border-dashed border-border text-muted-foreground text-xs py-2 px-3 bg-muted/20"
                        : isRefusal
                        ? "me-auto max-w-[88%] border border-warning/40 bg-warning/10 text-foreground rounded-bl-xs"
                        : isAiAnswer
                        ? "me-auto max-w-[92%] border border-primary/40 bg-primary/5 text-foreground rounded-bl-xs"
                        : isAiError
                        ? "me-auto max-w-[88%] border border-destructive/40 bg-destructive/10 text-foreground rounded-bl-xs"
                        : "me-auto max-w-[88%] border border-border/70 bg-secondary/50 text-foreground rounded-bl-xs",
                    )}
                  >
                    <div className={cn("flex items-center gap-1.5 text-xs font-semibold", isUser ? "text-primary-foreground" : "text-muted-foreground")}>
                      {isUser ? <User className="size-3.5" aria-hidden /> : isRefusal || isAiError ? <TriangleAlert className="size-3.5 text-warning" aria-hidden /> : isAiAnswer ? <Sparkles className="size-3.5 text-primary" aria-hidden /> : <Bot className="size-3.5 text-primary" aria-hidden />}
                      <span>{isAiAnswer ? aiUi.answerLabel : isAiError ? aiUi.errorLabel : ui.roles[m.role]}</span>
                      <span className="ms-auto font-mono text-[11px]">{faTime(m.at)}</span>
                    </div>
                    <p className="leading-7 whitespace-pre-wrap" dir="auto">{m.textFa}</p>
                    <AiAttribution m={m} />
                    <AiRetry m={m} question={canAsk ? lastUserText : ""} disabled={sending} onRetry={(q) => void send(q, true)} />
                    {m.action === "upload_project" && (
                      <Button
                        variant={isUser ? "secondary" : "outline"}
                        className="mt-2 min-h-10 px-3.5 text-xs font-medium self-start shadow-xs"
                        data-testid="goto-upload"
                        onClick={() => {
                          const el = document.getElementById("zip-m") ?? document.getElementById("zip-c");
                          el?.scrollIntoView({ block: "center" });
                          (el as HTMLInputElement | null)?.focus();
                        }}
                      >
                        رفتن به بارگذاری پروژه
                      </Button>
                    )}
                  </li>
                );
              })}
              {sending && asking && <ModelPending />}
            </ol>

            <div className="flex flex-wrap gap-1.5 pt-2 border-t border-border/40" data-testid="suggestions" aria-label={ui.suggestions}>
              {suggestions.slice(0, 6).map((s) => (
                <button
                  key={s}
                  type="button"
                  disabled={sending || active}
                  onClick={() => void send(s)}
                  className="min-h-11 rounded-full border border-border/60 bg-muted/30 px-3 py-1.5 text-xs font-medium text-muted-foreground transition-all duration-200 hover:border-primary/40 hover:bg-primary/10 hover:text-primary active:scale-95 disabled:opacity-50"
                  data-testid="suggestion"
                >
                  {s}
                </button>
              ))}
            </div>

            <form onSubmit={(e) => { e.preventDefault(); void send(text); }} className="flex flex-col gap-2.5 pt-1" data-testid="composer">
              <label htmlFor="agent-text" className="text-xs font-semibold text-muted-foreground">{ui.composerLabel}</label>
              <div className="relative rounded-2xl border border-input/80 bg-background/80 shadow-xs focus-within:border-primary focus-within:ring-2 focus-within:ring-primary/20 transition-all">
                <textarea
                  id="agent-text"
                  value={text}
                  maxLength={500}
                  rows={2}
                  onChange={(e) => setText(e.target.value)}
                  aria-describedby="composer-hint"
                  placeholder="دستور یا سؤالتان را اینجا بنویسید (Shift+Enter برای خط بعد)..."
                  onKeyDown={(e) => {
                    if (e.key === "Enter" && !e.shiftKey && !e.nativeEvent.isComposing) {
                      e.preventDefault();
                      void send(text);
                    }
                  }}
                  className="w-full resize-none border-0 bg-transparent p-3.5 text-sm sm:text-base leading-6 text-foreground placeholder:text-muted-foreground/60 focus:outline-none focus:ring-0"
                  data-testid="agent-input"
                />
                <div className="flex items-center justify-between border-t border-border/40 px-3 py-2 bg-muted/15 rounded-b-2xl">
                  <p id="composer-hint" className="text-[11px] text-muted-foreground">
                    {ui.composerHint} · <span className="font-mono">{apps.length}</span> برنامهٔ مجاز
                  </p>
                  <div className="flex flex-wrap items-center justify-end gap-2">
                  <Button
                    type="submit"
                    size="sm"
                    disabled={sending || !text.trim() || active}
                    className="h-11 px-4 text-xs sm:text-sm font-semibold shadow-xs"
                    data-testid="send"
                  >
                    {sending && !asking ? <Loader2 className="animate-spin motion-reduce:animate-none size-4" aria-hidden /> : <Send className="size-4" aria-hidden />}
                    <span>{sending && !asking ? ui.sending : ui.send}</span>
                  </Button>
                  {canAsk && (
                    <Button type="button" size="sm" variant="outline" disabled={sending || !text.trim() || active} onClick={() => void send(text, true)} title={aiUi.askHint} className="h-11 px-4 text-xs sm:text-sm font-semibold shadow-xs" data-testid="ask-model">
                      {asking ? <Loader2 className="animate-spin motion-reduce:animate-none size-4" aria-hidden /> : <Sparkles className="size-4" aria-hidden />}
                      <span>{asking ? aiUi.askBusy : aiUi.ask}</span>
                    </Button>
                  )}
                  </div>
                </div>
              </div>
              {error && <p role="alert" className="text-xs text-destructive font-medium mt-1" data-testid="agent-error">{error}</p>}
            </form>
          </div>
        </section>

        {/* ---- run panel ---- */}
        <div className="flex min-w-0 flex-col gap-4" data-testid="run-panel">
          {run ? (
            <div className="flex flex-col gap-4 rounded-2xl border border-border/80 bg-card/70 backdrop-blur-md p-4 sm:p-5 shadow-xs">
              <div className="flex flex-wrap items-center justify-between gap-3 border-b border-border/40 pb-3.5">
                <div className="flex flex-wrap items-center gap-2">
                  <span
                    data-testid="agent-run-status"
                    data-status={run.status}
                    data-phase={run.phase}
                    className={cn(
                      "inline-flex items-center gap-1.5 rounded-full px-3 py-1 text-xs font-semibold backdrop-blur-md border shadow-xs",
                      run.status === "FAILED" || run.status === "TIMED_OUT" || run.status === "CANCELLED"
                        ? "border-destructive/40 bg-destructive/10 text-destructive"
                        : "border-primary/40 bg-primary/10 text-primary"
                    )}
                  >
                    {run.status === "RUNNING" && <Loader2 className="size-3.5 animate-spin motion-reduce:animate-none" aria-hidden />}
                    <span>{ui.runStatus[run.status]} · {ui.phase[run.phase]}</span>
                  </span>
                  <bdi className="ltr-isolate text-xs font-mono text-muted-foreground bg-muted/40 px-2 py-1 rounded-md border border-border/40">
                    {run.app}
                  </bdi>
                </div>

                <div className="flex gap-2">
                  {run.status === "RUNNING" && (
                    <Button variant="outline" size="sm" className="h-8 px-3 text-xs" disabled={busy !== null} onClick={() => void control("cancel")} data-testid="agent-cancel">
                      {ui.cancel}
                    </Button>
                  )}
                  {run.kind !== "deployment" && (run.status === "FAILED" || run.status === "TIMED_OUT") && (
                    <Button variant="outline" size="sm" className="h-8 px-3 text-xs" disabled={busy !== null} onClick={() => void control("retry")} data-testid="agent-retry">
                      <RotateCcw className="size-3.5" aria-hidden />
                      {ui.retry}
                    </Button>
                  )}
                </div>
              </div>

              {run.errorCode && (
                <p role="alert" data-testid="agent-run-error" data-code={run.errorCode} className="rounded-xl border border-destructive/40 bg-destructive/10 p-3 text-xs sm:text-sm text-destructive font-medium">
                  {ui.runError[run.errorCode] ?? run.errorCode}
                </p>
              )}

              {run.kind === "deployment" && run.deployment ? (
                <>
                  <DeploymentPanel key={run.id} run={run} proposals={view?.proposals ?? []} initialFile={analysedFile} onChanged={() => convId && void refresh(convId)} />
                  <details className="rounded-xl border border-border/70 p-3 bg-muted/20" data-testid="upload-new-version">
                    <summary className="min-h-11 cursor-pointer py-2.5 text-xs sm:text-sm font-semibold">{liveUi.flow.uploadNewVersion}</summary>
                    <p className="mt-1 text-xs text-muted-foreground">{liveUi.flow.uploadNewVersionHint}</p>
                    <div className="mt-3"><UploadCard compact conversationId={convId} onUploaded={afterUpload} /></div>
                  </details>
                </>
              ) : (
                <>
                  {view && view.proposals.length > 0 && (
                    <section aria-labelledby="prop-h" className="flex flex-col gap-3" data-testid="proposals">
                      <h2 id="prop-h" className="font-bold text-sm text-foreground">{ui.proposals}</h2>
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
            </div>
          ) : (
            <div className="flex flex-col gap-4">
              <UploadCard conversationId={convId} onUploaded={afterUpload} />
              <div className="flex flex-col items-center justify-center gap-2 rounded-2xl border border-dashed border-border/70 p-8 text-center text-sm text-muted-foreground bg-card/40 backdrop-blur-md" data-testid="no-run">
                <Bot className="size-8 text-muted-foreground/40 mb-1" aria-hidden />
                <p className="font-medium text-foreground/80">آمادهٔ آغاز بررسی یا استقرار</p>
                <p className="text-xs max-w-sm">پس از ارسال درخواست یا بارگذاری پروژه، برنامهٔ ابزارها، اجرای زنده، گزارش و پیشنهادها در این بخش ظاهر می‌شوند.</p>
              </div>
            </div>
          )}
        </div>
      </div>
    </div>
  );
}
