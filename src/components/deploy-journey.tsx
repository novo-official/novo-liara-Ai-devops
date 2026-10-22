"use client";

import { useRef, useState, type KeyboardEvent } from "react";
import { CheckCircle2, CircleDashed, FileArchive, FlaskConical, Info, ListChecks, MinusCircle, OctagonX, RotateCcw, ShieldAlert, TriangleAlert, Upload } from "lucide-react";
import { ApprovalCard } from "@/components/approval-card";
import { useArtifactBinding } from "@/components/artifact-binding";
import { LiveDeploymentPanel } from "@/components/live-deployment";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { deployUi, zipReasonFa } from "@/i18n/deploy-fa";
import { liveUi } from "@/i18n/live-fa";
import { cn } from "@/lib/utils";
import { FIRST_DEPLOY_STRATEGY, GITHUB_ACTIONS_NOTE } from "@/server/deploy/strategy";
import type { ProposalView } from "@/server/agent/manager";
import type { AgentRunRecord, DeploymentRunData } from "@/server/agent/types";
import type { ChecklistItem, Finding, Verdict } from "@/server/deploy/types";

const u = deployUi;
const VERDICT_STYLE: Record<Verdict, string> = {
  READY: "border-primary/60 text-primary",
  READY_WITH_WARNINGS: "border-warning/60 text-warning",
  NEEDS_CONFIGURATION: "border-warning/60 text-warning",
  BLOCKED: "border-destructive/60 text-destructive",
  UNSUPPORTED: "border-border text-muted-foreground",
};
const STATE_ICON = { ok: CheckCircle2, done: CheckCircle2, pending: CircleDashed, not_applicable: MinusCircle, blocked: OctagonX } as const;

/** Step A — upload an UNTRUSTED ZIP. Nothing is executed; the server only reads files statically. */
export function UploadCard({ conversationId, onUploaded, compact = false }: { conversationId: string | null; onUploaded: (conversationId: string, file: File) => void; compact?: boolean }) {
  const input = useRef<HTMLInputElement>(null);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  async function upload() {
    const file = input.current?.files?.[0];
    if (!file) return setError(u.errors.pickFile);
    setBusy(true);
    setError(null);
    try {
      const res = await fetch("/api/agent/deploy/uploads", {
        method: "POST",
        headers: { "Content-Type": "application/zip", "X-Upload-Filename": file.name.replace(/[^\w. -]/g, "_").slice(0, 64), ...(conversationId ? { "X-Conversation-Id": conversationId } : {}) },
        body: file,
      });
      const j = (await res.json()) as { conversationId?: string; error?: { message?: string; reason?: string } };
      if (!res.ok || !j.conversationId) {
        setError([j.error?.message, j.error?.reason ? zipReasonFa[j.error.reason] : null].filter(Boolean).join(" ") || u.errors.network);
        return;
      }
      if (input.current) input.current.value = "";
      onUploaded(j.conversationId, file); // the analysed archive stays in browser memory only: the live path re-submits it, the server re-verifies it every time
    } catch {
      setError(u.errors.network);
    } finally {
      setBusy(false);
    }
  }

  return (
    <section aria-labelledby={`up-h-${compact ? "c" : "m"}`} className="rounded-xl border p-4" data-testid="deploy-upload">
      <h2 id={`up-h-${compact ? "c" : "m"}`} className="flex items-center gap-2 font-semibold"><FileArchive className="size-4 text-primary" aria-hidden />{compact ? "بارگذاری نسخهٔ جدید پروژه" : u.title}</h2>
      {!compact && <p className="mt-1 text-xs leading-6 text-muted-foreground">{u.intro}</p>}
      <div className="mt-3 flex flex-col gap-2">
        <label htmlFor={`zip-${compact ? "c" : "m"}`} className="text-sm font-medium">{u.upload.label}</label>
        <input ref={input} id={`zip-${compact ? "c" : "m"}`} type="file" accept=".zip,application/zip" data-testid="deploy-file" aria-describedby={`zip-hint-${compact ? "c" : "m"}`} className="block w-full rounded-lg border border-input bg-background p-2 text-sm file:me-3 file:rounded-md file:border-0 file:bg-secondary file:px-3 file:py-2" />
        <p id={`zip-hint-${compact ? "c" : "m"}`} className="text-xs text-muted-foreground">{u.upload.hint}</p>
        {error && <p role="alert" data-testid="deploy-upload-error" className="text-sm text-destructive">{error}</p>}
        <Button className="min-h-11 px-4 sm:w-fit" disabled={busy} onClick={() => void upload()} data-testid="deploy-upload-btn"><Upload aria-hidden />{busy ? u.upload.busy : u.upload.button}</Button>
        <p className="text-xs text-muted-foreground">{u.upload.notExecuted}</p>
      </div>
    </section>
  );
}

function FindingList({ items, testid }: { items: Finding[]; testid: string }) {
  if (!items.length) return null;
  return (
    <ul className="mt-2 flex flex-col gap-2" data-testid={testid}>
      {items.map((f) => (
        <li key={f.id} data-finding={f.id} className="rounded-lg border p-3 text-sm">
          <p className="font-medium">{f.titleFa}</p>
          <p className="mt-1 text-xs leading-6 text-muted-foreground">{f.detailFa}</p>
          <details className="mt-1 text-xs text-muted-foreground"><summary className="cursor-pointer">{u.advanced}</summary><p className="ltr-isolate mt-1">{f.source} · {f.basis}</p></details>
        </li>
      ))}
    </ul>
  );
}

function Checklist({ run, d, locked, onChanged }: { run: AgentRunRecord; d: DeploymentRunData; locked: boolean; onChanged: () => void }) {
  const [busy, setBusy] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [optimistic, setOptimistic] = useState<Record<string, boolean>>({});
  async function toggle(item: ChecklistItem, done: boolean) {
    setBusy(item.id);
    setError(null);
    setOptimistic((o) => ({ ...o, [item.id]: done })); // instant feedback; the server's answer replaces it
    try {
      const res = await fetch(`/api/agent/deploy/runs/${run.id}/checklist`, { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ item: item.id, done }) });
      if (!res.ok) setError(((await res.json()) as { error?: { message?: string } }).error?.message ?? u.errors.network);
      onChanged();
    } catch {
      setError(u.errors.network);
    } finally {
      setOptimistic((o) => {
        const { [item.id]: _drop, ...rest } = o;
        void _drop;
        return rest;
      });
      setBusy(null);
    }
  }
  return (
    <section aria-labelledby="chk-h" className="rounded-xl border p-4" data-testid="deploy-checklist">
      <h2 id="chk-h" className="flex items-center gap-2 font-semibold"><ListChecks className="size-4 text-primary" aria-hidden />{u.checklist}</h2>
      <p className="mt-1 text-xs text-muted-foreground">{u.checklistHint}</p>
      <ul className="mt-3 flex flex-col gap-2">
        {d.readiness.checklist.map((c) => {
          const Icon = STATE_ICON[c.state];
          const manual = c.kind === "manual";
          const checked = optimistic[c.id] ?? c.state === "done";
          return (
            <li key={c.id} data-item={c.id} data-state={c.state} className="rounded-lg border p-3 text-sm">
              <div className="flex items-start gap-2">
                {manual ? (
                  <input id={`chk-${c.id}`} type="checkbox" className="mt-1 size-5 shrink-0" checked={checked} disabled={locked || busy !== null} onChange={(e) => void toggle(c, e.target.checked)} data-testid={`check-${c.id}`} />
                ) : (
                  <Icon className={cn("mt-0.5 size-5 shrink-0", c.state === "blocked" && "text-destructive", c.state === "ok" && "text-primary")} aria-hidden />
                )}
                <div className="min-w-0">
                  <label htmlFor={manual ? `chk-${c.id}` : undefined} className="font-medium">{c.titleFa}</label>
                  <p className="mt-0.5 text-xs leading-6 text-muted-foreground">{c.detailFa}</p>
                  {/* a <div>, NOT a <p>: it contains <details>, which is invalid inside a paragraph (React reported it as a hydration error: "3 Issues" in the dev overlay) */}
                  <div className="mt-1 flex flex-wrap items-center gap-2 text-xs">
                    <Badge variant="outline" data-testid={`state-${c.id}`}>{u.state[c.state]}</Badge>
                    {c.blocking && c.state !== "ok" && c.state !== "not_applicable" && c.state !== "done" && <Badge variant="outline" className="border-warning/60 text-warning">مانع تا انجام</Badge>}
                    <details className="inline text-muted-foreground"><summary className="inline cursor-pointer">{u.advanced}</summary> <span>{u.classLabel[c.class]}</span></details>
                  </div>
                </div>
              </div>
            </li>
          );
        })}
      </ul>
      {locked && <p className="mt-2 text-xs text-muted-foreground">برای تغییر فهرست، ابتدا طرح باز را لغو یا رد کنید.</p>}
      {error && <p role="alert" className="mt-2 text-sm text-destructive">{error}</p>}
    </section>
  );
}

function Recommendation({ d }: { d: DeploymentRunData }) {
  const rec = d.recommendation;
  if (!rec) return null;
  return (
    <section aria-labelledby="rec-h" className="rounded-xl border p-4" data-testid="deploy-recommendation">
      <h2 id="rec-h" className="font-semibold">{u.rec.title}</h2>
      <Badge variant="outline" className="mt-2 border-warning/60 text-warning" data-testid="rec-label">{u.rec.preliminary}</Badge>
      <p className="mt-2 text-sm leading-7">{rec.approach.titleFa}</p>
      <dl className="mt-2 grid grid-cols-2 gap-2 text-sm sm:grid-cols-4">
        <div><dt className="text-xs text-muted-foreground">{u.rec.ram}</dt><dd>{rec.resources.ramMbMin}–{rec.resources.ramMbRecommended} MB</dd></div>
        <div><dt className="text-xs text-muted-foreground">{u.rec.cpu}</dt><dd>{rec.resources.cpuCores}</dd></div>
        <div><dt className="text-xs text-muted-foreground">{u.rec.disk}</dt><dd>{rec.resources.diskGb ? `${rec.resources.diskGb} GB` : "—"}</dd></div>
        <div><dt className="text-xs text-muted-foreground">دسته</dt><dd>{rec.categoryFa}</dd></div>
      </dl>
      <p className="mt-2 rounded-lg border border-warning/40 bg-warning/5 p-2 text-xs leading-6" data-testid="rec-pricing">{rec.pricingFa}</p>
      {rec.tradeoffsFa.length > 0 && <><h3 className="mt-3 text-sm font-medium">{u.rec.tradeoffs}</h3><ul className="mt-1 list-disc space-y-1 ps-5 text-xs leading-6">{rec.tradeoffsFa.map((t) => <li key={t}>{t}</li>)}</ul></>}
      <h3 className="mt-3 text-sm font-medium">{u.rec.manual}</h3>
      <ul className="mt-1 list-disc space-y-1 ps-5 text-xs leading-6">{rec.manualStepsFa.map((t) => <li key={t}>{t}</li>)}</ul>
      <details className="mt-3 text-xs"><summary className="cursor-pointer text-muted-foreground">{u.rec.reasons} / {u.advanced}</summary>
        <ul className="mt-1 space-y-1">{rec.reasoning.map((r, i) => <li key={i}><span className="ltr-isolate">{r.factor}</span>: {r.effectFa}</li>)}</ul>
        <h3 className="mt-2 font-medium">{u.rec.missing}</h3><ul className="mt-1 list-disc ps-5">{rec.missingInformationFa.map((t) => <li key={t}>{t}</li>)}</ul>
      </details>
    </section>
  );
}

export function DeploymentTimeline({ view }: { view: ProposalView }) {
  const dep = view.result?.deployment;
  if (!dep) return null;
  return (
    <section aria-labelledby="tl-h" className="rounded-xl border p-4" data-testid="deploy-timeline" data-outcome={view.result!.outcome}>
      <h2 id="tl-h" className="flex items-center gap-2 font-semibold"><FlaskConical className="size-4 text-warning" aria-hidden />{u.timeline.title}</h2>
      <Badge variant="outline" className="mt-2 border-warning/60 text-warning">شبیه‌سازی — هیچ چیز واقعی ساخته نشد</Badge>
      <ol className="mt-3 flex flex-col gap-2" aria-live="polite">
        {dep.stages.map((s) => (
          <li key={s.id} data-testid={`stage-${s.id}`} data-status={s.status} className={cn("rounded-lg border p-3 text-sm", s.status === "failed" && "border-warning/60 bg-warning/10", s.status === "not_run" && "opacity-60")}>
            <div className="flex items-center gap-2">
              {s.status === "ok" ? <CheckCircle2 className="size-4 text-primary" aria-hidden /> : s.status === "failed" ? <TriangleAlert className="size-4 text-warning" aria-hidden /> : <CircleDashed className="size-4 text-muted-foreground" aria-hidden />}
              <span className="font-medium">{s.labelFa}</span>
              <span className="ms-auto text-xs text-muted-foreground">{s.status === "ok" ? u.timeline.ok : s.status === "failed" ? u.timeline.failed : u.timeline.notRun}</span>
            </div>
            {s.detailFa && <p className="mt-1 text-xs leading-6 text-muted-foreground">{s.detailFa}</p>}
          </li>
        ))}
      </ol>
      <details className="mt-3 text-xs"><summary className="cursor-pointer text-muted-foreground">{u.timeline.log}</summary><pre dir="rtl" className="mt-1 overflow-auto rounded-md bg-muted/40 p-2 text-start leading-6" data-testid="deploy-log">{dep.logFa.join("\n")}</pre></details>
      <p className="mt-2 text-xs text-muted-foreground" data-testid="deploy-no-url">{dep.urlNoteFa} {dep.releaseNoteFa}</p>
    </section>
  );
}

function PlanForm({ run, d, hasOpen, canPlan, failed, onChanged }: { run: AgentRunRecord; d: DeploymentRunData; hasOpen: boolean; canPlan: boolean; failed: boolean; onChanged: () => void }) {
  const [appName, setAppName] = useState(d.options.appName);
  const [traffic, setTraffic] = useState<string>(d.options.traffic);
  const [scenario, setScenario] = useState<string>(d.options.scenario);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  async function prepare() {
    setBusy(true);
    setError(null);
    try {
      const res = await fetch(`/api/agent/deploy/runs/${run.id}/plan`, { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ appName, traffic, scenario }) });
      if (!res.ok) {
        const j = (await res.json()) as { error?: { message?: string } };
        setError(j.error?.message ?? u.errors.network);
      }
      onChanged();
    } catch {
      setError(u.errors.network);
    } finally {
      setBusy(false);
    }
  }
  return (
    <section aria-labelledby="plan-h" className="rounded-xl border p-4" data-testid="deploy-plan-form">
      <h2 id="plan-h" className="font-semibold">{u.plan.title}</h2>
      <div className="mt-3 grid gap-3 sm:grid-cols-2">
        <div className="flex flex-col gap-1"><label htmlFor="dp-name" className="text-sm font-medium">{u.plan.appName}</label>
          <input id="dp-name" dir="ltr" value={appName} onChange={(e) => setAppName(e.target.value)} aria-describedby="dp-name-h" className="h-11 rounded-lg border border-input bg-background px-3 text-start font-mono" data-testid="plan-app-name" />
          <p id="dp-name-h" className="text-xs text-muted-foreground">{u.plan.appNameHint}</p></div>
        <div className="flex flex-col gap-1"><label htmlFor="dp-traffic" className="text-sm font-medium">{u.rec.traffic}</label>
          <select id="dp-traffic" value={traffic} onChange={(e) => setTraffic(e.target.value)} className="h-11 rounded-lg border border-input bg-background px-3" data-testid="plan-traffic">
            {(Object.keys(u.rec.trafficOptions) as (keyof typeof u.rec.trafficOptions)[]).map((k) => <option key={k} value={k}>{u.rec.trafficOptions[k]}</option>)}</select></div>
        <div className="flex flex-col gap-1 sm:col-span-2"><label htmlFor="dp-scn" className="text-sm font-medium">{u.plan.scenario}</label>
          <select id="dp-scn" value={scenario} onChange={(e) => setScenario(e.target.value)} aria-describedby="dp-scn-h" className="h-11 rounded-lg border border-input bg-background px-3" data-testid="plan-scenario">
            {(Object.keys(u.scenarios) as (keyof typeof u.scenarios)[]).map((k) => <option key={k} value={k}>{u.scenarios[k]}</option>)}</select>
          <p id="dp-scn-h" className="text-xs text-muted-foreground">{u.plan.scenarioHint}</p></div>
      </div>
      {error && <p role="alert" className="mt-2 text-sm text-destructive" data-testid="plan-error">{error}</p>}
      <Button className="mt-3 min-h-11 px-4" disabled={busy || !canPlan} onClick={() => void prepare()} data-testid="plan-prepare">{failed || hasOpen ? <RotateCcw aria-hidden /> : null}{busy ? u.plan.preparing : failed || hasOpen ? u.plan.replan : u.plan.prepare}</Button>
      {!canPlan && <p className="mt-2 text-xs text-muted-foreground" data-testid="plan-disabled-note">ساخت طرح تا رفع موانع و تکمیل کارهای دستی فعال نمی‌شود.</p>}
    </section>
  );
}

const STEP_KEYS = ["upload", "analysis", "checklist", "recommendation", "plan", "approval", "timeline", "result"] as const;

type PathTab = "existing" | "simulation" | "new";
const PATH_TABS: PathTab[] = ["existing", "simulation", "new"];
const fl = liveUi.flow;

/** Three clearly separate paths. Roving tabindex + arrow keys per the WAI-ARIA tabs pattern (direction-aware for RTL). */
function PathTabs({ value, onChange, pendingSimulation }: { value: PathTab; onChange: (v: PathTab) => void; pendingSimulation: boolean }) {
  const refs = useRef<Partial<Record<PathTab, HTMLButtonElement | null>>>({});
  function onKey(e: KeyboardEvent<HTMLButtonElement>) {
    const rtl = getComputedStyle(e.currentTarget).direction === "rtl";
    const i = PATH_TABS.indexOf(value);
    let n = i;
    if (e.key === (rtl ? "ArrowLeft" : "ArrowRight")) n = (i + 1) % PATH_TABS.length;
    else if (e.key === (rtl ? "ArrowRight" : "ArrowLeft")) n = (i + PATH_TABS.length - 1) % PATH_TABS.length;
    else if (e.key === "Home") n = 0;
    else if (e.key === "End") n = PATH_TABS.length - 1;
    else return;
    e.preventDefault();
    onChange(PATH_TABS[n]!);
    refs.current[PATH_TABS[n]!]?.focus();
  }
  return (
    <div role="tablist" aria-label={fl.pathTabsLabel} className="grid gap-2 sm:grid-cols-3" data-testid="path-tabs">
      {PATH_TABS.map((k) => (
        <button
          key={k} ref={(el) => { refs.current[k] = el; }} type="button" role="tab" id={`path-tab-${k}`} aria-selected={value === k} aria-controls={`path-panel-${k}`} tabIndex={value === k ? 0 : -1}
          onClick={() => onChange(k)} onKeyDown={onKey} data-testid={`path-tab-${k}`} data-primary={String(k === "existing")}
          className={cn("flex min-h-11 flex-col items-start gap-0.5 rounded-lg border-2 p-3 text-start text-sm", value === k ? "border-primary bg-primary/5" : "border-border hover:bg-muted", k === "existing" && value !== k && "border-primary/40")}
        >
          <span className="flex flex-wrap items-center gap-1.5 font-semibold">{fl.tabs[k]}{k === "existing" && <Badge variant="outline" className="border-primary/60 text-primary">پیشنهادی</Badge>}{k === "simulation" && pendingSimulation && <Badge variant="outline" className="border-warning/60 text-warning" data-testid="path-tab-simulation-pending">{fl.openPlanBadge}</Badge>}</span>
          <span className="text-xs font-normal leading-6 text-muted-foreground">{fl.tabHints[k]}</span>
        </button>
      ))}
    </div>
  );
}

/** The whole first-deployment journey for one deployment run. Step A (upload) is `UploadCard`. */
export function DeploymentPanel({ run, proposals, onChanged, initialFile = null }: { run: AgentRunRecord; proposals: ProposalView[]; onChanged: () => void; initialFile?: File | null }) {
  const d = run.deployment!;
  const r = d.readiness;
  const artifact = useArtifactBinding(d.project.artifactDigest32, initialFile);
  const pending = proposals.find((p) => p.proposal.status === "PENDING");
  const last = proposals.at(-1);
  const simulated = proposals.find((p) => p.result);
  const failedSim = run.status === "FAILED" && run.errorCode === "simulation_failed";
  const finished = run.phase === "SIMULATION_COMPLETED";
  const liveEligible = r.verdict === "READY" || r.verdict === "READY_WITH_WARNINGS" || finished;
  // A run that opens ready lands on the primary (existing-app) path. One that opens blocked starts in the checklist (the only content then) and STAYS there when
  // fixing the blockers makes the live paths available, so the operator is never yanked away from the step they were working on.
  const [tab, setTab] = useState<PathTab>(liveEligible ? "existing" : "simulation");
  const planAllowed = (r.verdict === "READY" || r.verdict === "READY_WITH_WARNINGS") && !finished && (run.status === "READY" || failedSim); // an open plan may be superseded by a new one
  const done: Record<(typeof STEP_KEYS)[number], boolean> = {
    upload: true, analysis: true,
    checklist: r.verdict === "READY" || r.verdict === "READY_WITH_WARNINGS",
    recommendation: !!d.recommendation && proposals.length > 0,
    plan: proposals.length > 0,
    approval: proposals.some((p) => ["SIMULATED_OK", "SIMULATED_FAILED", "VERIFICATION_FAILED"].includes(p.proposal.status)),
    timeline: !!simulated, result: !!simulated,
  };
  const current = STEP_KEYS.find((k) => !done[k]) ?? "result";
  const detected = r.findings.filter((f) => f.kind === "detected" || f.kind === "info");
  const problems = r.findings.filter((f) => f.kind === "blocker" || f.kind === "missing" || f.kind === "warning");
  const security = r.findings.filter((f) => f.kind === "security");
  const active: PathTab = liveEligible ? tab : "simulation";

  const simulation = (
    <div className="flex flex-col gap-4" data-testid="deploy-simulation">
      <ol className="flex flex-wrap gap-2 text-xs" aria-label={u.title} data-testid="deploy-stepper">
        {STEP_KEYS.map((k, i) => (
          <li key={k} data-step={k} data-state={done[k] ? "done" : k === current ? "current" : "todo"} aria-current={k === current ? "step" : undefined} className={cn("flex items-center gap-1 rounded-full border px-2 py-1", k === current && "border-primary text-primary", done[k] && "text-muted-foreground")}>
            {done[k] ? <CheckCircle2 className="size-3.5" aria-hidden /> : <span aria-hidden className="inline-flex size-4 items-center justify-center rounded-full border text-[10px]">{i + 1}</span>}
            <span>{u.steps[k]}</span>
          </li>
        ))}
      </ol>

      <Checklist run={run} d={d} locked={!!pending} onChanged={onChanged} />
      <Recommendation d={d} />
      <PlanForm key={run.id + (last?.proposal.id ?? "")} run={run} d={d} hasOpen={!!pending} canPlan={planAllowed} failed={failedSim} onChanged={onChanged} />

      {proposals.length > 0 && (
        <section aria-labelledby="ap-h" className="flex flex-col gap-3" data-testid="deploy-proposals">
          <h2 id="ap-h" className="font-semibold">{u.steps.approval}</h2>
          <p className="text-xs leading-6 text-muted-foreground">{u.plan.simOnly}</p>
          {proposals.map((pv) => <ApprovalCard key={pv.proposal.id} view={pv} onChanged={onChanged} />)}
        </section>
      )}

      {simulated && <DeploymentTimeline view={simulated} />}

      {simulated?.result && (
        <section aria-labelledby="res-h" className={cn("rounded-xl border p-4", simulated.result.outcome === "failed" ? "border-warning/60 bg-warning/5" : "border-primary/40 bg-primary/5")} data-testid="deploy-final" data-outcome={simulated.result.outcome}>
          <h2 id="res-h" className="font-semibold">{u.steps.result}</h2>
          <p className="mt-1 text-sm leading-7">{simulated.result.outcome === "succeeded" ? u.result.success : u.result.failed}</p>
          <p className="mt-1 text-xs text-muted-foreground">{u.result.noUrl} {u.result.noRelease}</p>
          <h3 className="mt-3 text-sm font-medium">{u.result.next}</h3>
          <ul className="mt-1 list-disc space-y-1 ps-5 text-sm leading-7">{(simulated.result.outcome === "succeeded" ? u.result.nextSuccess : u.result.nextFailed).map((t) => <li key={t}>{t}</li>)}</ul>
        </section>
      )}
    </div>
  );

  return (
    <div className="flex flex-col gap-4" data-testid="deploy-panel" data-verdict={r.verdict} data-phase={run.phase} data-path={active}>
      <section aria-labelledby="an-h" className="rounded-xl border p-4" data-testid="deploy-analysis">
        <div className="flex flex-wrap items-center gap-2">
          <h2 id="an-h" className="font-semibold">{u.steps.analysis}</h2>
          <Badge variant="outline" className={VERDICT_STYLE[r.verdict]} data-testid="deploy-verdict" data-verdict={r.verdict}>{u.verdict[r.verdict]}</Badge>
          <span className="ms-auto text-xs text-muted-foreground">{r.framework.nameFa}</span>
        </div>
        <p className="mt-2 text-sm leading-7">{u.verdictHelp[r.verdict]}</p>
        <p className="mt-1 text-sm leading-7 text-muted-foreground">{r.summaryFa}</p>
        <p className="mt-2 flex items-start gap-1.5 rounded-lg border border-warning/40 bg-warning/5 p-2 text-xs leading-6" data-testid="deploy-static-notice"><Info className="mt-0.5 size-3.5 shrink-0 text-warning" aria-hidden />{r.staticNoticeFa}</p>
        {/* a clean READY analysis folds its long lists away so the deployment path starts higher on the page; anything that needs attention stays open */}
        <details className="mt-3" open={r.verdict !== "READY"} data-testid="deploy-analysis-details">
          <summary className="min-h-11 cursor-pointer py-2 text-sm font-medium">{u.detected} / {u.missing} / {u.security}</summary>
          {detected.length > 0 && <><h3 className="mt-3 text-sm font-medium">{u.detected}</h3><FindingList items={detected} testid="findings-detected" /></>}
          {problems.length > 0 && <><h3 className="mt-3 text-sm font-medium">{u.missing}</h3><FindingList items={problems} testid="findings-problems" /></>}
          {security.length > 0 && <><h3 className="mt-3 flex items-center gap-1.5 text-sm font-medium text-warning"><ShieldAlert className="size-4" aria-hidden />{u.security}</h3><FindingList items={security} testid="findings-security" /></>}
        </details>
        {r.nextActionsFa.length > 0 && <><h3 className="mt-3 text-sm font-medium">{u.steps.checklist}</h3><ul className="mt-1 list-disc space-y-1 ps-5 text-sm leading-7" data-testid="next-actions">{r.nextActionsFa.map((a) => <li key={a}>{a}</li>)}</ul></>}
      </section>

      {liveEligible && <PathTabs value={active} onChange={setTab} pendingSimulation={!!pending} />}

      {liveEligible ? (
        <>
          <div role="tabpanel" id="path-panel-existing" aria-labelledby="path-tab-existing" hidden={active !== "existing"} data-testid="path-panel-existing">
            {active === "existing" && <LiveDeploymentPanel runId={run.id} defaultApp="" readiness={{ verdict: r.verdict, frameworkFa: r.framework.nameFa }} artifact={artifact} section="existing" />}
          </div>
          <div role="tabpanel" id="path-panel-simulation" aria-labelledby="path-tab-simulation" hidden={active !== "simulation"} data-testid="path-panel-simulation">{simulation}</div>
          <div role="tabpanel" id="path-panel-new" aria-labelledby="path-tab-new" hidden={active !== "new"} data-testid="path-panel-new">
            {active === "new" && <LiveDeploymentPanel runId={run.id} defaultApp="" readiness={{ verdict: r.verdict, frameworkFa: r.framework.nameFa }} artifact={artifact} section="new" />}
          </div>
        </>
      ) : simulation}

      <details className="rounded-xl border p-4 text-sm" data-testid="deploy-advanced">
        <summary className="min-h-11 cursor-pointer py-2 font-medium">{u.strategyTitle} · {u.advanced}</summary>
        <ol className="mt-3 flex flex-col gap-2 text-xs leading-6">
          {FIRST_DEPLOY_STRATEGY.map((s) => (
            <li key={s.id} data-strategy={s.id} data-class={s.class} className="rounded-lg border p-2"><span className="font-medium">{s.order}. {s.titleFa}</span> <Badge variant="outline">{u.classLabel[s.class]}{s.alsoManual ? " + دستی" : ""}</Badge><p className="text-muted-foreground">{s.detailFa}</p>{s.api.length > 0 && <p className="ltr-isolate text-muted-foreground">{s.api.join(" · ")}</p>}</li>
          ))}
        </ol>
        <p className="mt-3 text-xs leading-6" data-testid="github-note"><strong>{GITHUB_ACTIONS_NOTE.titleFa}:</strong> {GITHUB_ACTIONS_NOTE.detailFa}</p>
      </details>
    </div>
  );
}
