"use client";

import { useCallback, useEffect, useRef, useState } from "react";
import { CheckCircle2, CircleDashed, Eye, FlaskConical, Gavel, Loader2, Lock, OctagonX, Rocket, ShieldAlert, Siren, TriangleAlert } from "lucide-react";
import { ArtifactBinder, NO_ARTIFACT, type ArtifactBinding } from "@/components/artifact-binding";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Countdown } from "@/components/countdown";
import { liveUi as t } from "@/i18n/live-fa";
import { faDateTime, faNumber } from "@/lib/format";
import { cn } from "@/lib/utils";
import { LADDER_EVIDENCE, LADDER_KEYS, ladderVerdict } from "@/lib/live-ladder";
import { artifactUsable } from "@/lib/artifact-binding";
import { nextAction, stages, type NextActionInput } from "@/lib/live-next-action";
import { deployUi } from "@/i18n/deploy-fa";
import type { ExistingBackendView, ExistingPreview, ExistingTargetView, LiveModeInfo, LiveStatus, LiveProposalView } from "@/server/live/service";
import type { PreflightReport } from "@/server/live/preflight";
import type { LiveOperationRecord } from "@/server/live/types";

const STATE_STYLE: Record<string, string> = {
  SIMULATED: "border-warning/60 text-warning",
  BLOCKED: "border-destructive/60 text-destructive",
  READY_FOR_APPROVAL: "border-primary/60 text-primary",
  LIVE_IN_PROGRESS: "border-primary/60 text-primary",
  LIVE_VERIFIED: "border-primary bg-primary/10 text-primary",
  LIVE_FAILED: "border-destructive/60 text-destructive",
};
const IN_FLIGHT = ["APPROVED", "CREATING_APPLICATION", "APPLICATION_CREATED", "UPLOADING_SOURCE", "SOURCE_UPLOADED", "CREATING_RELEASE", "RELEASE_CREATED", "VERIFYING_DEPLOYMENT"];
const APP_RE = /^[a-z0-9][a-z0-9-]{1,61}[a-z0-9]$/;

async function api<T>(url: string, init?: RequestInit): Promise<{ ok: true; data: T } | { ok: false; message: string; code: string | null }> {
  try {
    const res = await fetch(url, init);
    const j = (await res.json()) as T & { error?: { code?: string; message?: string; reason?: string } };
    if (!res.ok) return { ok: false, message: [j.error?.message, j.error?.reason].filter(Boolean).join(" · ") || t.errors.generic, code: j.error?.code ?? null };
    return { ok: true, data: j };
  } catch {
    return { ok: false, message: t.errors.network, code: null };
  }
}

/** Live deployment panel (Phase 2A). Every control that could cause a write is DISABLED until the server reports the prerequisites; nothing here talks to Liara. */
export type ReadinessSummary = { verdict: string; frameworkFa: string } | null;

export type LiveSection = "existing" | "new";

export function LiveDeploymentPanel({ runId, defaultApp, readiness = null, artifact = NO_ARTIFACT, section = "existing" }: { runId: string; defaultApp: string; readiness?: ReadinessSummary; artifact?: ArtifactBinding; section?: LiveSection }) {
  const [status, setStatus] = useState<LiveStatus | null>(null);
  const [loadError, setLoadError] = useState<string | null>(null);

  const refresh = useCallback(async () => {
    const r = await api<LiveStatus>(`/api/agent/live/status?runId=${encodeURIComponent(runId)}`);
    if (r.ok) {
      setStatus(r.data);
      setLoadError(null);
    } else setLoadError(r.message);
  }, [runId]);

  useEffect(() => {
    let alive = true;
    void api<LiveStatus>(`/api/agent/live/status?runId=${encodeURIComponent(runId)}`).then((r) => {
      if (!alive) return;
      if (r.ok) setStatus(r.data);
      else setLoadError(r.message);
    });
    return () => {
      alive = false;
    };
  }, [runId]);
  const inProgress = status?.uiState === "LIVE_IN_PROGRESS";
  const hasPending = !!status?.proposals.some((p) => p.proposal.status === "PENDING");
  useEffect(() => {
    if (!inProgress && !hasPending) return;
    const id = setInterval(() => void refresh(), 3000);
    return () => clearInterval(id);
  }, [inProgress, hasPending, refresh]);

  if (!status) {
    return (
      <section aria-labelledby="live-h" className="rounded-xl border p-4" data-testid="live-panel" data-state="loading">
        <h2 id="live-h" className="font-semibold">{t.title}</h2>
        {loadError ? <p role="alert" className="mt-2 text-sm text-destructive">{loadError}</p> : <Loader2 className="mt-2 size-4 animate-spin motion-reduce:animate-none" aria-label="…" />}
      </section>
    );
  }

  return <LiveDeploymentView status={status} runId={runId} defaultApp={defaultApp} readiness={readiness} artifact={artifact} section={section} onChanged={refresh} />;
}

/** Presentational half (also used by the unit tests): everything is derived from the server's status document. `section` picks ONE of the two live paths. */
export function LiveDeploymentView({ status, runId, defaultApp, readiness = null, artifact = NO_ARTIFACT, section = "existing", onChanged: refresh }: { status: LiveStatus; runId: string; defaultApp: string; readiness?: ReadinessSummary; artifact?: ArtifactBinding; section?: LiveSection; onChanged: () => void }) {
  const hardPrereqMissing = status.prerequisites.some((p) => p.blocking && !p.ok);
  const blockingRun = status.runBlockers.filter((b) => !b.startsWith("sensitive_files"));
  const canPropose = !hardPrereqMissing && blockingRun.length === 0 && (status.catalogue?.unitsVerified ?? false);
  const createProposals = status.proposals.filter((v) => v.proposal.kind !== "deploy_existing_app");
  const existingProposals = status.proposals.filter((v) => v.proposal.kind === "deploy_existing_app");
  const latest = createProposals.at(-1);
  const openProposal = createProposals.find((p) => p.proposal.status === "PENDING" || p.proposal.status === "APPROVED");

  return (
    <section aria-labelledby="live-h" className={cn("flex flex-col gap-4 rounded-xl border-2 p-4", MODE_FRAME[status.mode.kind])} data-testid="live-panel" data-state={status.uiState} data-live-mode={status.mode.kind} data-section={section}>
      <div className="flex flex-wrap items-center gap-2">
        <Rocket className="size-4 text-destructive" aria-hidden />
        <h2 id="live-h" className="font-semibold">{t.title}</h2>
        <Badge variant="outline" className={cn("ms-auto", STATE_STYLE[status.uiState])} data-testid="live-state-badge" data-state={status.uiState}>{t.states[status.uiState]}</Badge>
      </div>
      <ModeBanner mode={status.mode} />
      <p className="text-xs leading-6 text-muted-foreground" data-testid="live-subtitle">{t.subtitle}</p>

      {section === "existing" ? (
        <ExistingAppSection status={status} runId={runId} readiness={readiness} proposals={existingProposals} artifact={artifact} onChanged={refresh} />
      ) : (
        <section aria-labelledby="live-new-h" className="flex flex-col gap-4 rounded-xl border border-dashed p-3" data-testid="live-create-new">
          <h3 id="live-new-h" className="text-sm font-semibold">{t.existing.createNewTitle}</h3>
          <p className="text-xs leading-6 text-muted-foreground">{t.existing.createNewNote}</p>
          <p role="status" className="rounded-lg border p-2 text-sm leading-7" data-testid="live-state-help">{t.stateHelp[status.uiState]}</p>

          {status.preflight && <PreflightSummary pf={status.preflight} proposal={openProposal?.proposal ?? null} />}

          <div data-testid="live-prereqs">
            <h3 className="text-sm font-medium">{t.prerequisites}</h3>
            <ul className="mt-1 flex flex-col gap-1.5">
              {status.prerequisites.map((p) => (
                <li key={p.id} data-prereq={p.id} data-ok={p.ok} className="flex items-start gap-2 rounded-lg border p-2 text-xs leading-6">
                  {p.ok ? <CheckCircle2 className="mt-0.5 size-4 shrink-0 text-primary" aria-hidden /> : <OctagonX className="mt-0.5 size-4 shrink-0 text-destructive" aria-hidden />}
                  <span className="min-w-0 break-words"><strong>{t.prereqLabels[p.id] ?? p.id}</strong> — <span className={p.ok ? "text-primary" : "text-destructive"}>{p.ok ? t.ok : t.missing}</span><br /><span className="text-muted-foreground">{p.detail}</span></span>
                </li>
              ))}
            </ul>
          </div>

          {status.runBlockers.length > 0 && (
            <div data-testid="live-blockers">
              <h3 className="text-sm font-medium">{t.blockers}</h3>
              <ul className="mt-1 list-disc space-y-1 ps-5 text-sm leading-7">{status.runBlockers.map((b) => <li key={b} data-blocker={b}>{t.blockerLabels[b] ?? b}</li>)}</ul>
            </div>
          )}

          <PlanTable status={status} />

          <ArtifactBinder artifact={artifact} />

          {openProposal ? null : <ProposalForm runId={runId} defaultApp={defaultApp} status={status} enabled={canPropose} artifact={artifact} onChanged={refresh} />}

          {createProposals.map((v) => <LiveProposalCard key={v.proposal.id} view={v} artifact={artifact} onChanged={refresh} />)}

          {latest?.operation && <OperationView op={latest.operation} onChanged={refresh} />}
        </section>
      )}
    </section>
  );
}

const VERDICT_STYLE: Record<string, string> = { READY_FOR_OPERATOR_APPROVAL: "border-primary text-primary", BLOCKED_BY_PRICING: "border-warning text-warning", BLOCKED_BY_CONTRACT: "border-warning text-warning", BLOCKED_BY_CONFIGURATION: "border-warning text-warning", BLOCKED_BY_SECURITY: "border-destructive text-destructive" };
const money = (n: number | null) => (n === null ? "—" : faNumber(n));

/** Plain-language final preflight summary (everything derives from the server's sanitised report; nothing here can start anything). */
function PreflightSummary({ pf, proposal }: { pf: PreflightReport; proposal: LiveProposalView["proposal"] | null }) {
  const pp = t.preflight;
  const blocked = pf.checks.filter((c) => c.status === "blocked");
  const sel = pf.pricing?.selected ?? null;
  const planCheck = pf.checks.find((c) => c.id === "selected_plan");
  return (
    <section aria-labelledby="pf-h" className="flex flex-col gap-3 rounded-lg border p-3" data-testid="live-preflight" data-verdict={pf.verdict}>
      <div className="flex flex-wrap items-center gap-2">
        <h3 id="pf-h" className="text-sm font-semibold">{pp.title}</h3>
        <Badge variant="outline" className={cn("ms-auto", VERDICT_STYLE[pf.verdict])} data-testid="live-verdict">{pp.verdict[pf.verdict]}</Badge>
      </div>
      <p className="text-xs leading-6 text-muted-foreground">{pp.intro}</p>
      <dl className="grid min-w-0 gap-x-4 gap-y-3 text-sm sm:grid-cols-2 [&>div]:min-w-0" data-testid="live-preflight-summary">
        <Binding k={pp.what.app}>{proposal ? <bdi className="ltr-isolate font-mono">{proposal.appName}</bdi> : pp.noApp}</Binding>
        <Binding k={pp.what.team}>{pf.team.configured ? pp.teamNamed : pp.personalTeam}</Binding>
        <Binding k={pp.what.plan} wide>{proposal ? <><bdi className="ltr-isolate font-mono">{proposal.planId}</bdi>{planCheck ? <span className="block text-xs leading-6 text-muted-foreground">{planCheck.detailFa}</span> : null}</> : pp.noPlan}</Binding>
        <Binding k={pp.what.cost} wide>
          {sel && sel.hourlyToman !== null ? <span data-testid="live-cost-verified">{pp.costVerified(money(sel.estimate.oneHour), money(sel.estimate.oneDay), money(sel.estimate.thirtyDays))}</span> : <span className="text-warning" data-testid="live-cost-unknown">{pp.costUnknown}</span>}
          <span className="mt-1 block text-xs text-muted-foreground" data-testid="live-balance-class">{pp.balanceLabels[pf.account.balance]}</span>
          {pf.pricing && pf.pricing.unresolved.length > 0 && <span className="mt-1 block text-xs text-warning" data-testid="live-unresolved">{pp.unresolvedLead}: {pf.pricing.unresolved.join("؛ ")}</span>}
          {pf.pricing && <span className="mt-1 block text-xs text-muted-foreground">{pp.bundleLead}: {pf.pricing.bundleCostsFa}</span>}
        </Binding>
        <Binding k={pp.what.approvals} wide><ul className="list-disc space-y-1 ps-5 text-xs leading-6">{pp.approvals.map((x) => <li key={x}>{x}</li>)}</ul></Binding>
        <Binding k={pp.what.agent} wide><ol className="list-none space-y-1 text-xs leading-6">{pp.agentSteps.map((x) => <li key={x}>{x}</li>)}</ol></Binding>
        <Binding k={pp.what.verify} wide>
          <ul className="space-y-1 text-xs leading-6" data-testid="live-verify-plan">{LADDER_KEYS.map((k) => <li key={k}>{t.ladderLabels[k]} <Badge variant="outline" className="ms-1">{t.evidenceShort[LADDER_EVIDENCE[k].source]}</Badge></li>)}</ul>
        </Binding>
        <Binding k={pp.what.failure} wide><ul className="list-disc space-y-1 ps-5 text-xs leading-6">{pp.failureText.map((x) => <li key={x}>{x}</li>)}</ul></Binding>
      </dl>
      <div data-testid="live-preflight-missing">
        <h4 className="text-sm font-medium">{pp.missing}</h4>
        {blocked.length === 0 ? <p className="mt-1 text-sm text-primary">{pp.none}</p> : (
          <ul className="mt-1 flex flex-col gap-1.5">
            {blocked.map((c) => (
              <li key={c.id} data-check={c.id} data-category={c.category} className="flex items-start gap-2 rounded-lg border border-destructive/30 p-2 text-xs leading-6">
                <OctagonX className="mt-0.5 size-4 shrink-0 text-destructive" aria-hidden />
                <span className="min-w-0 break-words"><strong>{c.titleFa}</strong> <Badge variant="outline" className="ms-1">{pp.categories[c.category]}</Badge><br /><span className="text-muted-foreground">{c.detailFa}</span></span>
              </li>
            ))}
          </ul>
        )}
      </div>
      <details className="text-sm" data-testid="live-preflight-all">
        <summary className="cursor-pointer font-medium">{pp.all} ({faNumber(pf.checks.length)})</summary>
        <ul className="mt-2 flex flex-col gap-1.5">
          {pf.checks.map((c) => (
            <li key={c.id} data-check={c.id} data-status={c.status} className="rounded-lg border p-2 text-xs leading-6">
              <span className="flex flex-wrap items-center gap-1.5"><strong>{c.titleFa}</strong><Badge variant="outline">{pp.statuses[c.status]}</Badge><Badge variant="outline">{pp.categories[c.category]}</Badge>{c.evidence.map((e) => <Badge key={e} variant="outline" data-evidence={e}>{pp.evidence[e]}</Badge>)}</span>
              <span className="mt-1 block text-muted-foreground">{c.detailFa}</span>
            </li>
          ))}
        </ul>
      </details>
    </section>
  );
}

const MODE_FRAME: Record<LiveModeInfo["kind"], string> = {
  simulation: "border-warning/50",
  live_disabled: "border-primary/30",
  live_enabled: "border-destructive",
};
const MODE_BANNER: Record<LiveModeInfo["kind"], { cls: string; Icon: typeof Lock }> = {
  simulation: { cls: "border-warning/60 bg-warning/10 text-warning", Icon: FlaskConical },
  live_disabled: { cls: "border-primary/40 bg-primary/5 text-foreground", Icon: Lock },
  live_enabled: { cls: "border-destructive bg-destructive/10 text-destructive", Icon: Siren },
};

/** Three visually and textually distinct modes — never confusable: SIMULATION (mock data) · LIVE DISABLED (real data, read-only) · LIVE ENABLED (real writes after a fresh approval). */
function ModeBanner({ mode }: { mode: LiveModeInfo }) {
  const m = MODE_BANNER[mode.kind];
  const text = t.modes[mode.kind]!;
  return (
    <div role="status" data-testid="live-mode-banner" data-live-mode={mode.kind} className={cn("flex items-start gap-2 rounded-lg border-2 p-3 text-sm", m.cls)}>
      <m.Icon className="mt-0.5 size-5 shrink-0" aria-hidden />
      <div>
        <strong data-testid="live-mode-label">{text.label}</strong>
        <p className="mt-0.5 text-xs leading-6">{text.help}</p>
      </div>
    </div>
  );
}

const shortId = (s: string | null) => (s === null ? "—" : `${s.slice(0, 6)}…`);

/** Fingerprint of everything a preview was computed for: if the file, target or backend changes, the preview is stale. */
const previewKey = (a: ArtifactBinding, app: string, backend: string) => `${a.file?.name ?? ""}|${a.file?.size ?? 0}|${a.sha256 ?? ""}|${app}|${backend}`;

/**
 * EXISTING-application release — the PRIMARY path. One flow, top to bottom: next action → stages → analysis → the ONE ZIP → target → backend → the two kinds of
 * readiness (A: source+target, read-only; B: execution prerequisites) → offline preview → approval request → timeline. Preview needs no live flag; a request,
 * an approval and an execution always do.
 */
function ExistingAppSection({ status, runId, readiness, proposals, artifact, onChanged }: { status: LiveStatus; runId: string; readiness: ReadinessSummary; proposals: LiveProposalView[]; artifact: ArtifactBinding; onChanged: () => void }) {
  const ex = status.existing;
  const x = t.existing;
  const fl = t.flow;
  const targets = ex?.targets ?? [];
  const [picked, setPicked] = useState<string>("");
  const [backend, setBackend] = useState<"api" | "cli">("api");
  const [busy, setBusy] = useState<"request" | "preview" | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [preview, setPreview] = useState<{ key: string; data: ExistingPreview } | null>(null);
  const target: ExistingTargetView | undefined = targets.find((tg) => tg.name === picked) ?? targets.find((tg) => tg.ready) ?? targets[0];
  const backends = ex?.backends ?? [];
  const be: ExistingBackendView | undefined = backends.find((b) => b.id === backend);
  const blockingRun = status.runBlockers.filter((b) => !b.startsWith("sensitive_files"));
  const open = proposals.find((p) => p.proposal.status === "PENDING" || p.proposal.status === "APPROVED");
  const live = status.mode.kind === "live_enabled";
  const latest = proposals.at(-1);
  const locks = status.locks ?? [];
  const lock = locks.find((l) => l.appName === target?.name) ?? null;
  const readinessOk = readiness ? readiness.verdict === "READY" || readiness.verdict === "READY_WITH_WARNINGS" : true;
  const fileOk = artifactUsable(artifact.state);
  const key = previewKey(artifact, target?.name ?? "", backend);
  const freshPreview = preview && preview.key === key ? preview.data : null;
  const previewState: NextActionInput["preview"] = busy === "preview" ? "busy" : freshPreview ? "ok" : preview ? "stale" : "none";
  const canPreview = readinessOk && blockingRun.length === 0 && !!target && fileOk && !open && busy === null;
  const canPropose = live && !!target?.ready && !!be?.ready && blockingRun.length === 0 && !open && !lock && fileOk && !!freshPreview && busy === null;
  const flow: NextActionInput = {
    mode: status.mode.kind,
    readinessOk,
    runBlockers: blockingRun,
    artifact: artifact.state,
    hasTargets: targets.length > 0,
    targetName: target?.name ?? null,
    targetReady: !!target?.ready,
    targetBlocked: target?.blocked ?? [],
    backendReady: !!be?.ready,
    backendBlockers: be?.blockers ?? [],
    preview: previewState,
    previewExecutionBlockers: freshPreview?.executionBlockers ?? [],
    proposal: open ? (open.proposal.status as "PENDING" | "APPROVED") : null,
    opState: latest?.operation?.state ?? null,
    lockState: lock?.state ?? null,
    lockAccess: lock?.access,
  };
  const na = nextAction(flow);
  const stageList = stages(flow);
  const naText = fl.next[na.id]!;

  async function runPreview() {
    if (!target || !artifact.file) return setError(x.pickAll);
    setBusy("preview");
    setError(null);
    const k = key;
    const r = await api<ExistingPreview>("/api/agent/live/proposals", { method: "POST", headers: { "Content-Type": "application/zip", "X-Live-Kind": "preview_existing_app", "X-Live-Backend": backend, "X-Live-Run": runId, "X-Live-App": target.name }, body: artifact.file });
    setBusy(null);
    if (!r.ok) return setError(r.message);
    setPreview({ key: k, data: r.data });
  }
  async function submit() {
    if (!target || !artifact.file) return setError(x.pickAll);
    setBusy("request");
    setError(null);
    const r = await api<LiveProposalView>("/api/agent/live/proposals", { method: "POST", headers: { "Content-Type": "application/zip", "X-Live-Kind": "deploy_existing_app", "X-Live-Backend": backend, "X-Live-Run": runId, "X-Live-App": target.name }, body: artifact.file });
    setBusy(null);
    if (!r.ok) return setError(r.message);
    setPreview(null);
    onChanged();
  }
  const focusBinder = () => {
    const el = document.getElementById("artifact-file");
    el?.scrollIntoView({ block: "center" });
    el?.focus();
  };
  const disabledNote = lock ? fl.requestDisabledLocked : status.mode.kind === "simulation" ? x.proposeDisabledSim : !live ? x.proposeDisabledOff : !fileOk ? fl.requestDisabledNeedFile : !freshPreview ? fl.requestDisabledNeedPreview : t.stateHelp.BLOCKED;
  const prereqs = freshPreview?.prerequisites ?? be?.prerequisites ?? [];

  return (
    <section aria-labelledby="live-ex-h" className="flex flex-col gap-4 rounded-xl border-2 border-primary/30 p-3" data-testid="live-existing" data-state={ex?.uiState ?? "BLOCKED"} data-live-mode={status.mode.kind}>
      <div className="flex flex-wrap items-center gap-2">
        <Rocket className="size-4 text-primary" aria-hidden />
        <h3 id="live-ex-h" className="font-semibold">{x.title}</h3>
        <Badge variant="outline" className={cn("ms-auto", STATE_STYLE[ex?.uiState ?? "BLOCKED"])} data-testid="live-existing-state" data-state={ex?.uiState ?? "BLOCKED"}>{t.states[ex?.uiState ?? "BLOCKED"]}</Badge>
      </div>
      <p className="text-xs leading-6 text-muted-foreground">{x.subtitle}</p>
      <p className="rounded-lg border border-primary/30 bg-primary/5 p-2 text-xs leading-6" data-testid="live-existing-never-create">{x.never}</p>

      {/* the ONE answer to "what do I do now?" */}
      <div role="status" aria-live="polite" data-testid="live-next-action" data-action={na.id} data-tone={na.tone} className={cn("flex flex-col gap-2 rounded-lg border-2 p-3", na.tone === "action" && "border-primary bg-primary/5", na.tone === "done" && "border-primary bg-primary/10", na.tone === "blocked" && "border-warning bg-warning/10", na.tone === "wait" && "border-border")}>
        <p className="text-xs text-muted-foreground">{fl.nextTitle}</p>
        <p className="text-base font-semibold" data-testid="live-next-title">{naText.title}</p>
        <p className="text-sm leading-7">{naText.detail}</p>
        {na.id === "fix_target" && na.operatorBlockers.length > 0 && (
          <><p className="text-xs font-medium">{fl.unmetLead}:</p><ul className="list-disc space-y-1 ps-5 text-xs leading-6" data-testid="live-next-target-blockers">{(target?.checks.filter((c) => c.status === "blocked") ?? []).map((c) => <li key={c.id}>{c.titleFa}</li>)}{(target?.checks.length ? [] : na.operatorBlockers).map((id) => <li key={id}><bdi className="ltr-isolate font-mono">{id}</bdi></li>)}</ul></>
        )}
        {na.id === "operator_enable_live" && (
          <div data-testid="live-next-operator-steps">
            <p className="text-xs font-medium">{fl.operatorStepLead}</p>
            <ol className="mt-1 list-decimal space-y-1 ps-5 text-xs leading-6">{na.operatorBlockers.map((id) => <li key={id} data-operator-step={id}>{fl.operatorSteps[id] ?? t.prereqLabels[id] ?? id}</li>)}</ol>
          </div>
        )}
        {(na.id === "choose_zip" || na.id === "fix_zip") && <Button type="button" variant="outline" className="min-h-11 w-fit px-4" onClick={focusBinder} data-testid="live-next-goto-file">{fl.binder.gotoBinder}</Button>}
        {na.id === "run_preview" && <Button type="button" className="min-h-11 w-fit px-4" onClick={() => void runPreview()} disabled={!canPreview} data-testid="live-next-run-preview"><Eye aria-hidden />{fl.preview.button}</Button>}
      </div>

      {locks.length > 0 && (
        <section aria-labelledby="live-lock-h" className="flex flex-col gap-3 rounded-lg border-2 border-warning p-3" data-testid="live-locks">
          <h4 id="live-lock-h" className="text-sm font-semibold">{fl.lock.title}</h4>
          <p className="text-xs leading-6 text-muted-foreground">{fl.lock.help}</p>
          {locks.map((l) => (
            <div key={l.operation?.id ?? `${l.appName}-${l.createdAt}`} className="flex flex-col gap-2" data-testid="live-lock" data-op-id={l.operation?.id ?? ""} data-app={l.appName} data-state={l.state} data-access={l.access}>
              {l.appName !== target?.name && <p className="text-xs text-muted-foreground">{fl.lock.otherApp}</p>}
              {l.access === "orphan" && <p className="rounded-lg border border-warning/50 bg-warning/5 p-2 text-xs leading-6" data-testid="live-lock-orphan-note">{fl.lock.orphan}</p>}
              {l.operation ? <OperationView op={l.operation} orphan={l.access === "orphan"} onChanged={onChanged} /> : <p className="rounded-lg border p-2 text-sm leading-7" data-testid="live-lock-elsewhere">{fl.lock.elsewhere(l.appName, t.states_fa[l.state as keyof typeof t.states_fa] ?? l.state)}</p>}
            </div>
          ))}
        </section>
      )}

      <ol aria-label={fl.stagesLabel} className="flex flex-wrap gap-2 text-xs" data-testid="live-existing-stages">
        {stageList.map((st, i) => (
          <li key={st.id} data-stage={st.id} data-state={st.state} aria-current={st.state === "current" || st.state === "blocked" ? "step" : undefined} className={cn("flex items-center gap-1 rounded-full border px-2 py-1", st.state === "current" && "border-primary text-primary", st.state === "blocked" && "border-warning text-warning", st.state === "done" && "text-muted-foreground")}>
            {st.state === "done" ? <CheckCircle2 className="size-3.5" aria-hidden /> : <span aria-hidden className="inline-flex size-4 items-center justify-center rounded-full border text-[10px]">{i + 1}</span>}
            <span>{fl.stageLabels[st.id]}</span>
            <span className="sr-only">— {fl.stageStates[st.state]}</span>
          </li>
        ))}
      </ol>

      {/* 1. analysis and readiness of the uploaded source */}
      <div data-testid="live-existing-analysis">
        <h4 className="text-sm font-medium">{x.analysis}</h4>
        {readiness ? (
          <p className="mt-1 flex flex-wrap items-center gap-2 text-sm"><span>{x.framework}: {readiness.frameworkFa}</span><Badge variant="outline" data-testid="live-existing-readiness" data-verdict={readiness.verdict}>{x.readinessLabel}: {deployUi.verdict[readiness.verdict as keyof typeof deployUi.verdict] ?? readiness.verdict}</Badge></p>
        ) : null}
        {blockingRun.length > 0 && <ul className="mt-1 list-disc space-y-1 ps-5 text-sm leading-7 text-destructive">{blockingRun.map((b) => <li key={b} data-blocker={b}>{t.blockerLabels[b] ?? b}</li>)}</ul>}
      </div>

      {/* 2. the ONE archive */}
      <ArtifactBinder artifact={artifact} />

      {/* 3. authorised targets */}
      <fieldset className="flex min-w-0 flex-col gap-2" data-testid="live-existing-targets">
        <legend className="text-sm font-medium">{x.targets}</legend>
        {ex?.readError && <p role="alert" className="text-sm text-destructive">{x.readError}</p>}
        {targets.length === 0 && !ex?.readError && <p className="text-sm text-muted-foreground" data-testid="live-existing-empty">{x.noTargets}</p>}
        {targets.map((tg) => (
          <label key={tg.name} className={cn("flex min-w-0 cursor-pointer items-start gap-2 rounded-lg border p-2 text-sm", target?.name === tg.name && "border-primary bg-primary/5")} data-testid="live-existing-target" data-app={tg.name} data-ready={String(tg.ready)}>
            <input type="radio" name="live-existing-target" value={tg.name} checked={target?.name === tg.name} onChange={() => setPicked(tg.name)} className="mt-1 size-4 shrink-0" />
            <span className="min-w-0"><bdi className="ltr-isolate font-mono">{tg.name}</bdi> <Badge variant="outline" className={tg.ready ? "border-primary/60 text-primary" : "border-destructive/50 text-destructive"}>{tg.ready ? x.ready : x.notReady}</Badge></span>
          </label>
        ))}
      </fieldset>

      {target && (
        <div className="flex flex-col gap-3 rounded-lg border p-3" data-testid="live-existing-identity" data-app={target.name}>
          {target.facts ? (
            <dl className="grid min-w-0 gap-x-4 gap-y-2 text-sm sm:grid-cols-2 [&>div]:min-w-0">
              <Binding k={x.facts.plan}><bdi className="ltr-isolate font-mono">{target.facts.planId}</bdi></Binding>
              <Binding k={x.facts.platform}><bdi className="ltr-isolate font-mono">{target.facts.platform ?? x.unknown}</bdi></Binding>
              <Binding k={x.facts.scale}>{target.facts.scale === 1 ? x.running : target.facts.scale === 0 ? x.stopped : x.unknown}</Binding>
              <Binding k={x.facts.instance}><bdi className="ltr-isolate font-mono" data-testid="live-existing-instance">{target.facts.instanceHint ?? "—"}</bdi></Binding>
              <Binding k={x.facts.created}>{target.facts.createdAt ? faDateTime(target.facts.createdAt) : x.unknown}</Binding>
              <Binding k={x.facts.network}>{target.facts.hasNetwork ? x.yes : x.no}</Binding>
              <Binding k={x.facts.releases}>{target.facts.releaseTotal === null ? x.unknown : faNumber(target.facts.releaseTotal)}</Binding>
              <Binding k={x.facts.release}><bdi className="ltr-isolate font-mono">{target.facts.currentReleaseHint ?? "—"}</bdi></Binding>
              <Binding k={x.facts.subdomain}>{target.facts.defaultSubdomain === null ? x.unknown : target.facts.defaultSubdomain ? x.enabled : x.disabled}</Binding>
              <Binding k={x.facts.suffix}><bdi className="ltr-isolate font-mono">{target.expectedSuffix}</bdi></Binding>
            </dl>
          ) : (
            <p className="text-sm text-destructive" data-testid="live-existing-unreadable">{target.blocked.join("، ")}</p>
          )}
          <p className="text-xs leading-6 text-muted-foreground">{x.recreatedWarn}</p>
          {target.checks.length > 0 && (
            <details className="text-sm" data-testid="live-existing-checks" open={target.blocked.length > 0}>
              <summary className="cursor-pointer font-medium">{x.checks} ({faNumber(target.checks.length)})</summary>
              <ul className="mt-2 flex flex-col gap-1.5">
                {target.checks.map((c) => (
                  <li key={c.id} data-check={c.id} data-status={c.status} className={cn("rounded-lg border p-2 text-xs leading-6", c.status === "blocked" && "border-destructive/40")}>
                    <span className="flex flex-wrap items-center gap-1.5"><strong>{c.titleFa}</strong><Badge variant="outline">{t.preflight.statuses[c.status]}</Badge>{c.evidence.map((e) => <Badge key={e} variant="outline">{t.preflight.evidence[e]}</Badge>)}</span>
                    <span className="mt-1 block text-muted-foreground">{c.detailFa}</span>
                  </li>
                ))}
              </ul>
            </details>
          )}
        </div>
      )}

      {/* 4. backend: REST by default; the CLI is a fallback that is never selected for you */}
      <fieldset className="flex min-w-0 flex-col gap-2" data-testid="live-existing-backends">
        <legend className="text-sm font-medium">{x.backend}</legend>
        {backends.map((b) => (
          <label key={b.id} className={cn("flex min-w-0 items-start gap-2 rounded-lg border p-2 text-sm", b.ready ? "cursor-pointer" : "opacity-70", backend === b.id && "border-primary bg-primary/5")} data-testid="live-existing-backend" data-backend={b.id} data-ready={String(b.ready)}>
            <input type="radio" name="live-existing-backend" value={b.id} checked={backend === b.id} disabled={!b.ready} onChange={() => setBackend(b.id)} className="mt-1 size-4 shrink-0" />
            <span className="min-w-0">
              <strong>{x.backends[b.id]!.title}</strong> <Badge variant="outline">{b.isDefault ? x.defaultBadge : x.fallbackBadge}</Badge> <Badge variant="outline" className={b.ready ? "border-primary/60 text-primary" : "border-warning/60 text-warning"}>{b.ready ? x.ready : x.notReady}</Badge>
              <span className="block text-xs leading-6 text-muted-foreground">{x.backends[b.id]!.desc}</span>
              {b.blockers.length > 0 && <span className="block text-xs leading-6 text-warning" data-testid="live-existing-backend-blockers">{x.blockersLead}: {b.blockers.map((id) => t.prereqLabels[id] ?? id).join("، ")}</span>}
            </span>
          </label>
        ))}
      </fieldset>

      {/* 5. two DIFFERENT kinds of readiness, never mixed */}
      <section aria-labelledby="live-gates-h" className="flex flex-col gap-3" data-testid="live-existing-gates">
        <h4 id="live-gates-h" className="text-sm font-medium">{fl.gates.title}</h4>
        <div className="grid gap-3 md:grid-cols-2">
          <div className="min-w-0 rounded-lg border p-3" data-testid="live-gate-target">
            <p className="text-xs font-medium leading-6">{fl.gates.target}</p>
            <ul className="mt-2 flex flex-col gap-1.5 text-xs leading-6">
              <GateRow ok={readinessOk && blockingRun.length === 0} label={x.analysis} />
              <GateRow ok={artifact.state === "match" || artifact.state === "unverifiable"} label={fl.binder.title} detail={fl.binder.states[artifact.state] ?? fl.binder.none} />
              <GateRow ok={!!target?.ready} label={x.targets} detail={target ? (target.ready ? x.ready : `${fl.unmetLead}: ${target.checks.filter((c) => c.status === "blocked").map((c) => c.titleFa).join("، ") || target.blocked.join("، ") || x.notReady}`) : x.noTargets} />
            </ul>
          </div>
          <div className="min-w-0 rounded-lg border p-3" data-testid="live-gate-execution">
            <p className="text-xs font-medium leading-6">{fl.gates.execution}</p>
            <ul className="mt-2 flex flex-col gap-1.5 text-xs leading-6">
              {prereqs.map((p) => <GateRow key={p.id} ok={p.ok} label={t.prereqLabels[p.id] ?? p.id} testid={`live-gate-prereq-${p.id}`} />)}
            </ul>
          </div>
        </div>
      </section>

      {/* 6. cost disclosure */}
      <div className="rounded-lg border border-warning/50 bg-warning/5 p-3" data-testid="live-existing-cost">
        <h4 className="text-sm font-medium">{x.cost.title}</h4>
        <ul className="mt-1 list-disc space-y-1 ps-5 text-xs leading-6">{x.cost.lines.map((l) => <li key={l}>{l}</li>)}</ul>
      </div>

      {/* 7. offline preview — needs neither the live flag nor any approval; sends no write request and stores nothing */}
      {!open && (
        <div className="flex flex-col gap-2" data-testid="live-existing-preview-box">
          <Button type="button" variant="outline" className="min-h-11 px-4 sm:w-fit" onClick={() => void runPreview()} disabled={!canPreview} data-testid="live-existing-preview-btn"><Eye aria-hidden />{busy === "preview" ? fl.preview.busy : fl.preview.button}</Button>
          {preview && !freshPreview && <p role="status" className="text-xs leading-6 text-warning" data-testid="live-existing-preview-stale">{fl.preview.stale}</p>}
          {freshPreview && <PreviewCard preview={freshPreview} />}
        </div>
      )}

      {/* 8. approval request — needs the live flag, a fresh preview and the same archive */}
      {!open && (
        <form onSubmit={(e) => { e.preventDefault(); void submit(); }} className="flex flex-col gap-3" data-testid="live-existing-form" data-enabled={String(canPropose)}>
          <Button type="submit" className="min-h-11 px-4 sm:w-fit" disabled={!canPropose} data-testid="live-existing-propose">{busy === "request" ? t.form.busy : fl.requestButton}</Button>
          {!canPropose && <p className="flex items-center gap-1.5 text-xs text-muted-foreground" data-testid="live-existing-disabled-note"><ShieldAlert className="size-4 shrink-0" aria-hidden />{disabledNote}</p>}
          {error && <p role="alert" className="text-sm text-destructive" data-testid="live-existing-error">{error}</p>}
        </form>
      )}
      {open && error && <p role="alert" className="text-sm text-destructive" data-testid="live-existing-error">{error}</p>}

      {proposals.map((v) => <LiveProposalCard key={v.proposal.id} view={v} artifact={artifact} onChanged={onChanged} />)}
      {latest?.operation && <OperationView op={latest.operation} onChanged={onChanged} />}
    </section>
  );
}

function GateRow({ ok, label, detail, testid }: { ok: boolean; label: string; detail?: string; testid?: string }) {
  return (
    <li className="flex items-start gap-2" data-ok={String(ok)} data-testid={testid}>
      {ok ? <CheckCircle2 className="mt-0.5 size-4 shrink-0 text-primary" aria-hidden /> : <OctagonX className="mt-0.5 size-4 shrink-0 text-destructive" aria-hidden />}
      <span className="min-w-0 break-words"><strong>{label}</strong> — <span className={ok ? "text-primary" : "text-destructive"}>{ok ? t.flow.gates.ok : t.flow.gates.missing}</span>{detail ? <span className="block text-muted-foreground">{detail}</span> : null}</span>
    </li>
  );
}

/** What the server would bind, and — separately — whether the target is ready and whether execution is possible. Never an approval. */
export function PreviewCard({ preview: p }: { preview: ExistingPreview }) {
  const pv = t.flow.preview;
  return (
    <section aria-labelledby="live-pv-h" className="flex flex-col gap-3 rounded-lg border border-primary/40 p-3" data-testid="live-existing-preview" data-executable={String(p.executable)} data-target-ready={String(p.targetReady)}>
      <div className="flex flex-wrap items-center gap-2">
        <h4 id="live-pv-h" className="text-sm font-semibold">{pv.title}</h4>
        <Badge variant="outline" className="ms-auto border-warning/60 text-warning">{pv.badge}</Badge>
      </div>
      <p className="rounded-lg border border-warning/40 bg-warning/5 p-2 text-xs leading-6" data-testid="live-preview-not-approval">{pv.notApproval}</p>
      <h5 className="text-sm font-medium">{pv.bound}</h5>
      <dl className="grid min-w-0 gap-x-4 gap-y-2 text-sm sm:grid-cols-2 [&>div]:min-w-0">
        <Binding k={pv.app}><bdi className="ltr-isolate font-mono">{p.appName}</bdi></Binding>
        <Binding k={pv.backend}><bdi className="ltr-isolate font-mono">{p.backend}</bdi></Binding>
        <Binding k={pv.platform}><bdi className="ltr-isolate font-mono">{p.platform ?? "—"}</bdi></Binding>
        <Binding k={pv.files}>{faNumber(p.artifact.fileCount)} {t.proposal.files} · {faNumber(p.artifact.artifactBytes)} B</Binding>
        <Binding k={pv.zipSha} wide><span className="ltr-isolate break-all font-mono text-xs" data-testid="live-preview-zip-sha">{p.artifact.zipSha256}</span></Binding>
        <Binding k={pv.analysisDigest} wide><span className="ltr-isolate break-all font-mono text-xs">{p.artifact.analysisDigest}</span></Binding>
        <Binding k={pv.artifactDigest} wide><span className="ltr-isolate break-all font-mono text-xs">{p.artifact.artifactDigest}</span></Binding>
      </dl>
      <p className={cn("text-sm leading-7", p.targetReady ? "text-primary" : "text-warning")} data-testid="live-preview-target">
        {!p.target.checked ? pv.targetNotChecked : p.targetReady ? pv.targetReady : `${pv.targetBlocked} — ${t.flow.unmetLead}: ${(p.target.checks.filter((c) => c.status === "blocked").map((c) => c.titleFa).join("، ") || p.target.blocked.join("، "))}`}
      </p>
      <div data-testid="live-preview-execution">
        <p className={cn("text-sm leading-7", p.executable ? "text-primary" : "text-warning")}>{p.executable ? pv.executableYes : pv.executableNo}</p>
        {p.executionBlockers.length > 0 && <><p className="mt-1 text-xs font-medium">{pv.blockersLead}:</p><ul className="mt-1 list-disc space-y-1 ps-5 text-xs leading-6">{p.executionBlockers.map((id) => <li key={id} data-blocker={id}>{t.prereqLabels[id] ?? id}</li>)}</ul></>}
      </div>
    </section>
  );
}

function PlanTable({ status }: { status: LiveStatus }) {
  const c = status.catalogue;
  return (
    <div data-testid="live-plans">
      <h3 className="text-sm font-medium">{t.plans}</h3>
      <p className="mt-1 text-xs leading-6 text-muted-foreground">{t.plansNote}</p>
      {!c || c.candidates.length === 0 ? (
        <p className="mt-2 text-sm text-muted-foreground">{t.noPlans}</p>
      ) : (
        <div className="mt-2 overflow-x-auto">
          <table className="w-full min-w-[28rem] text-start text-xs">
            <caption className="sr-only">{t.plans}</caption>
            <thead><tr className="text-muted-foreground">{Object.values(t.planCols).map((h) => <th key={h} scope="col" className="p-1.5 text-start font-medium">{h}</th>)}</tr></thead>
            <tbody>
              {c.candidates.map((p) => (
                <tr key={p.id} className="border-t" data-plan={p.id} data-recommended={String(p.recommended)}>
                  <th scope="row" className="ltr-isolate p-1.5 text-start font-mono font-normal">{p.id}</th>
                  <td className="p-1.5">{p.ramAmount === null ? "—" : faNumber(p.ramAmount)}</td>
                  <td className="p-1.5">{p.price === null ? "—" : faNumber(p.price)}</td>
                  <td className="ltr-isolate p-1.5">{p.region ?? "—"}</td>
                  <td className="p-1.5 leading-6">{p.reasonFa}</td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      )}
      {c && c.notes.length > 0 && <ul className="mt-2 list-disc space-y-1 ps-5 text-xs leading-6 text-warning" data-testid="live-plan-notes">{c.notes.map((n) => <li key={n}>{n}</li>)}</ul>}
    </div>
  );
}

function ProposalForm({ runId, defaultApp, status, enabled, artifact, onChanged }: { runId: string; defaultApp: string; status: LiveStatus; enabled: boolean; artifact: ArtifactBinding; onChanged: () => void }) {
  const [app, setApp] = useState(defaultApp);
  const [plan, setPlan] = useState("");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const plans = status.catalogue?.candidates ?? [];
  const fileOk = artifactUsable(artifact.state);

  async function submit() {
    const f = artifact.file;
    if (!APP_RE.test(app) || !plan || !f || !fileOk) return setError(t.form.pickAll);
    setBusy(true);
    setError(null);
    const r = await api<LiveProposalView>("/api/agent/live/proposals", { method: "POST", headers: { "Content-Type": "application/zip", "X-Live-Run": runId, "X-Live-Plan": plan, "X-Live-App": app }, body: f });
    setBusy(false);
    if (!r.ok) return setError(r.message);
    onChanged();
  }

  return (
    <form onSubmit={(e) => { e.preventDefault(); void submit(); }} className="flex flex-col gap-3 rounded-lg border p-3" data-testid="live-form" data-enabled={String(enabled)}>
      <h3 className="text-sm font-medium">{t.form.title}</h3>
      <fieldset disabled={!enabled || busy} className="flex min-w-0 flex-col gap-3 disabled:opacity-60">
        <label className="flex flex-col gap-1 text-sm">{t.form.appName}
          <input dir="ltr" value={app} onChange={(e) => setApp(e.target.value.trim().toLowerCase())} maxLength={63} autoComplete="off" data-testid="live-app-input" className="h-11 w-full rounded-lg border border-input bg-background px-3 text-start font-mono" />
        </label>
        <label className="flex flex-col gap-1 text-sm">{t.form.plan}
          <select value={plan} onChange={(e) => setPlan(e.target.value)} data-testid="live-plan-select" dir="ltr" className="h-11 w-full rounded-lg border border-input bg-background px-3 text-start font-mono">
            <option value="">—</option>
            {plans.map((p) => <option key={p.id} value={p.id}>{p.id}</option>)}
          </select>
        </label>
        <p className="text-xs leading-6 text-muted-foreground" data-testid="live-form-zip-note">{t.form.zipHint} {fileOk ? "" : t.flow.requestDisabledNeedFile}</p>
        <Button type="submit" className="min-h-11 px-4 sm:w-fit" disabled={!enabled || busy || !fileOk} data-testid="live-propose">{busy ? t.form.busy : t.form.submit}</Button>
      </fieldset>
      {!enabled && <p className="flex items-center gap-1.5 text-xs text-muted-foreground" data-testid="live-disabled-note"><ShieldAlert className="size-4 shrink-0" aria-hidden />{t.stateHelp.BLOCKED}</p>}
      {error && <p role="alert" className="text-sm text-destructive" data-testid="live-form-error">{error}</p>}
    </form>
  );
}

function Binding({ k, children, wide = false }: { k: string; children: React.ReactNode; wide?: boolean }) {
  return <div className={wide ? "sm:col-span-2" : undefined}><dt className="text-xs text-muted-foreground">{k}</dt><dd className="mt-0.5 break-words">{children}</dd></div>;
}

function LiveProposalCard({ view, artifact, onChanged }: { view: LiveProposalView; artifact: ArtifactBinding; onChanged: () => void }) {
  const p = view.proposal;
  const ref = useRef<HTMLDialogElement>(null);
  const opener = useRef<HTMLButtonElement>(null);
  const [typed, setTyped] = useState("");
  const [acked, setAcked] = useState(false);
  const [busy, setBusy] = useState<"approve" | "reject" | "execute" | null>(null);
  const [error, setError] = useState<string | null>(null);
  const existingKind = p.kind === "deploy_existing_app";
  const pending = p.status === "PENDING";
  const approvedWaiting = p.status === "APPROVED";
  const close = () => {
    ref.current?.close();
    opener.current?.focus();
  };

  async function decide(decision: "approve" | "reject") {
    setBusy(decision);
    setError(null);
    const r = await api("/api/agent/live/proposals/" + p.id + "/decision", { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ decision, digest: p.digest, ...(decision === "approve" ? { confirmAppName: typed, ...(existingKind ? {} : { acknowledgeFinancial: acked }) } : {}) }) });
    setBusy(null);
    if (!r.ok) setError(r.message);
    else close();
    onChanged();
  }
  async function execute() {
    const f = artifact.file;
    if (!f || !artifactUsable(artifact.state)) return setError(t.flow.binder.missingForExecute);
    setBusy("execute");
    setError(null);
    const r = await api("/api/agent/live/proposals/" + p.id + "/execute", { method: "POST", headers: { "Content-Type": "application/zip" }, body: f });
    setBusy(null);
    if (!r.ok) setError(r.message);
    onChanged();
  }

  const est = p.financial.estimate;
  return (
    <article className="rounded-xl border border-destructive/40 p-4" data-testid="live-proposal" data-proposal-id={p.id} data-status={p.status}>
      <div className="flex flex-wrap items-center gap-2">
        <Badge variant="outline" className="border-destructive/60 text-destructive" data-testid="live-real-badge"><TriangleAlert aria-hidden />{existingKind ? `${t.existing.realBadge} — ${t.existing.title}` : t.proposal.badge}</Badge>
        <Badge variant="outline">{t.statuses[p.status] ?? p.status}</Badge>
        {pending && <span className="ms-auto text-xs text-muted-foreground">{t.proposal.expires}: <Countdown expiresAt={p.expiresAt} onExpire={onChanged} /></span>}
      </div>
      <p className="mt-2 text-sm leading-7" data-testid="live-effects">{existingKind ? t.proposal.effectsExisting : t.proposal.effects}</p>
      {pending && <Button ref={opener} className="mt-3 min-h-11 px-4" onClick={() => { setError(null); ref.current?.showModal(); }} data-testid="live-open-approval"><Gavel aria-hidden />{t.proposal.review}</Button>}

      {approvedWaiting && (
        <div className="mt-3 flex flex-col gap-2 rounded-lg border p-3" data-testid="live-execute-box">
          <p className="text-sm leading-7">{t.proposal.approvedNote}</p>
          <p className="text-xs leading-6" data-testid="live-exec-file" data-state={artifact.state}>
            {artifact.file ? <><bdi className="ltr-isolate break-all font-mono">{artifact.file.name}</bdi> — {t.flow.binder.states[artifact.state]}</> : <span className="text-warning">{t.flow.binder.missingForExecute}</span>}
          </p>
          {!artifactUsable(artifact.state) && <Button type="button" variant="outline" className="min-h-11 w-fit px-3" onClick={() => { const el = document.getElementById("artifact-file"); el?.scrollIntoView({ block: "center" }); el?.focus(); }} data-testid="live-exec-goto-file">{t.flow.binder.gotoBinder}</Button>}
          <Button className="min-h-11 px-4 sm:w-fit" onClick={() => void execute()} disabled={busy !== null || !artifactUsable(artifact.state)} data-testid="live-execute"><Rocket aria-hidden />{busy === "execute" ? t.proposal.executing : t.proposal.execute}</Button>
        </div>
      )}
      {error && !pending && <p role="alert" className="mt-2 text-sm text-destructive" data-testid="live-exec-error">{error}</p>}

      <dialog ref={ref} aria-labelledby={`ldlg-${p.id}`} data-testid="live-dialog" className="m-auto w-[min(42rem,calc(100vw-1.5rem))] max-h-[90dvh] overflow-y-auto overflow-x-hidden rounded-xl border bg-card p-0 text-card-foreground backdrop:bg-black/60">
        <div className="flex min-w-0 flex-col gap-4 p-4 sm:p-5">
          <h2 id={`ldlg-${p.id}`} className="text-lg font-bold">{t.proposal.title}</h2>
          <p role="note" className="rounded-lg border border-destructive/50 bg-destructive/10 p-3 text-sm text-destructive" data-testid="live-dialog-warning">{existingKind ? t.proposal.effectsExisting : t.proposal.effects}</p>
          <h3 className="text-sm font-medium">{t.proposal.bindings}</h3>
          <dl className="grid min-w-0 gap-x-4 gap-y-3 text-sm sm:grid-cols-2 [&>div]:min-w-0" data-testid="live-bindings" data-kind={p.kind}>
            {existingKind && <Binding k={t.existing.bindings.kind} wide><span data-testid="live-bind-kind">{t.existing.bindings.kindValue}</span></Binding>}
            {existingKind && <Binding k={t.existing.bindings.backend}><bdi className="ltr-isolate font-mono" data-testid="live-bind-backend">{p.backend}</bdi> <Badge variant="outline">{p.backend === "api" ? t.existing.defaultBadge : t.existing.fallbackBadge}</Badge></Binding>}
            <Binding k={t.proposal.operator}><bdi className="ltr-isolate font-mono">{p.ownerHash.slice(0, 8)}</bdi></Binding>
            <Binding k={t.proposal.team}>{p.teamId ? <bdi className="ltr-isolate font-mono">{p.teamId}</bdi> : t.proposal.personalScope}</Binding>
            <Binding k={t.proposal.app}><bdi className="ltr-isolate font-mono" data-testid="live-bind-app">{p.appName}</bdi></Binding>
            <Binding k={t.proposal.plan}><bdi className="ltr-isolate font-mono">{p.planId}</bdi></Binding>
            {!existingKind && <Binding k={t.proposal.bundle}><bdi className="ltr-isolate font-mono">{p.bundlePlanId}</bdi></Binding>}
            {!existingKind && <Binding k={t.proposal.network}><bdi className="ltr-isolate font-mono">{p.networkId}</bdi></Binding>}
            <Binding k={t.proposal.platform}><bdi className="ltr-isolate font-mono">{p.platform}</bdi></Binding>
            {existingKind && p.existing && <Binding k={t.existing.bindings.instance}><bdi className="ltr-isolate font-mono" data-testid="live-bind-instance">{shortId(p.existing.instanceId)}</bdi></Binding>}
            {existingKind && p.existing && <Binding k={t.existing.bindings.created}>{p.existing.createdAt ? faDateTime(p.existing.createdAt) : t.existing.unknown}</Binding>}
            {existingKind && p.existing && <Binding k={t.existing.bindings.network}>{p.existing.networkId ? t.existing.yes : t.existing.no}</Binding>}
            {existingKind && p.existing && <Binding k={t.existing.bindings.baseline}>{p.existing.releaseTotal === null ? t.existing.unknown : `${faNumber(p.existing.releaseTotal)} · `}<bdi className="ltr-isolate font-mono">{shortId(p.existing.baselineRelease)}</bdi></Binding>}
            {existingKind && p.existing && <Binding k={t.existing.bindings.subdomain}>{p.existing.defaultSubdomain === null ? t.existing.unknown : p.existing.defaultSubdomain ? t.existing.enabled : t.existing.disabled}</Binding>}
            <Binding k={t.proposal.config}><bdi className="ltr-isolate font-mono">port {p.config.port} · {p.config.output}</bdi></Binding>
            <Binding k={t.proposal.envKeys}>{p.envKeys.length ? <bdi className="ltr-isolate font-mono">{p.envKeys.join(", ")}</bdi> : t.proposal.noEnv}</Binding>
            <Binding k={t.proposal.artifact}>{faNumber(p.artifact.fileCount)} {t.proposal.files} · {faNumber(p.artifact.artifactBytes)} B</Binding>
            <Binding k={t.proposal.zipSha} wide><span className="ltr-isolate break-all font-mono text-xs">{p.artifact.zipSha256}</span></Binding>
            <Binding k={t.proposal.artifactDigest} wide><span className="ltr-isolate break-all font-mono text-xs">{p.artifact.artifactDigest}</span></Binding>
            {existingKind && p.cli && <Binding k={t.existing.bindings.cliTool} wide><span data-testid="live-bind-cli">{t.existing.cliUnit} <bdi className="ltr-isolate font-mono">{p.cli.version}</bdi> · <bdi className="ltr-isolate font-mono">{p.cli.entrySha256.slice(0, 16)}…</bdi></span></Binding>}
            {existingKind && p.cli && <Binding k={t.existing.bindings.cliArgv} wide><span className="ltr-isolate break-all font-mono text-xs">{p.cli.argvDigest}</span></Binding>}
            {existingKind && p.cli && <Binding k={t.existing.bindings.cliManifest} wide><span className="ltr-isolate break-all font-mono text-xs">{p.cli.manifestDigest}</span></Binding>}
            <Binding k={t.proposal.financial} wide>
              {existingKind ? (
                <ul className="list-disc space-y-1 ps-5 text-xs leading-6" data-testid="live-existing-bind-cost">{[...p.financial.knownOtherCosts, ...p.financial.unknownCostComponents].map((x) => <li key={x}>{x}</li>)}</ul>
              ) : est ? <span data-testid="live-estimate">{t.proposal.estimate}: {faNumber(est.amount)} {est.currency} — {est.basis}</span> : <span className="text-warning" data-testid="live-financial-unknown">{t.proposal.financialUnknown}</span>}
              {!existingKind && p.financial.unknownCostComponents.length > 0 && <ul className="mt-1 list-disc space-y-1 ps-5 text-xs text-warning">{p.financial.unknownCostComponents.map((x) => <li key={x}>{x}</li>)}</ul>}
            </Binding>
            <Binding k={t.proposal.expires}>{faDateTime(p.expiresAt)} — <Countdown expiresAt={p.expiresAt} /></Binding>
            <Binding k={t.proposal.operation}><span className="ltr-isolate break-all font-mono text-xs">{p.operationId}</span></Binding>
            <Binding k={t.proposal.digest} wide><span className="ltr-isolate break-all font-mono text-xs" data-testid="live-digest">{p.digest}</span></Binding>
          </dl>
          <div className="flex flex-col gap-2">
            <label htmlFor={`lconfirm-${p.id}`} className="text-sm font-medium">{t.proposal.typeName(p.appName)}</label>
            <input id={`lconfirm-${p.id}`} dir="ltr" autoComplete="off" value={typed} onChange={(e) => setTyped(e.target.value)} data-testid="live-confirm-input" className="h-11 w-full rounded-lg border border-input bg-background px-3 text-start font-mono" />
          </div>
          {existingKind && <p className="rounded-lg border border-primary/30 bg-primary/5 p-3 text-xs leading-6" data-testid="live-existing-recreate-note">{t.existing.recreatedWarn}</p>}
          {!existingKind && <label className="flex items-start gap-2 rounded-lg border border-warning/50 bg-warning/5 p-3 text-sm leading-7" htmlFor={`lack-${p.id}`}>
            <input id={`lack-${p.id}`} type="checkbox" checked={acked} onChange={(e) => setAcked(e.target.checked)} data-testid="live-ack" className="mt-1.5 size-5 shrink-0" />
            <span><strong>{t.ack.label}</strong><span className="block text-xs text-muted-foreground">{t.ack.help}</span></span>
          </label>}
          {error && <p role="alert" className="text-sm text-destructive" data-testid="live-dialog-error">{error}</p>}
          <div className="flex flex-wrap gap-2">
            <Button className="min-h-11 px-4" disabled={busy !== null || typed !== p.appName || (!existingKind && !acked)} onClick={() => void decide("approve")} data-testid="live-approve">{busy === "approve" ? t.proposal.working : t.proposal.approve}</Button>
            <Button variant="outline" className="min-h-11 px-4" disabled={busy !== null} onClick={() => void decide("reject")} data-testid="live-reject">{busy === "reject" ? t.proposal.working : t.proposal.reject}</Button>
            <Button variant="ghost" className="min-h-11 px-4" disabled={busy !== null} onClick={close} data-testid="live-close">{t.proposal.close}</Button>
          </div>
        </div>
      </dialog>
    </article>
  );
}

/** Second step of "abandon": says exactly what it does (local bookkeeping only) before anything changes. */
export function AbandonConfirmBox({ opId, busy, disabled, onConfirm, onBack }: { opId: string; busy: boolean; disabled: boolean; onConfirm: () => void; onBack: () => void }) {
  return (
    <div role="group" aria-labelledby={`ab-${opId}`} className="mt-3 flex flex-col gap-2 rounded-lg border-2 border-warning p-3" data-testid="live-abandon-confirm-box">
      <p id={`ab-${opId}`} className="text-sm font-semibold">{t.flow.abandon.confirmTitle}</p>
      <ul className="list-disc space-y-1 ps-5 text-xs leading-6">{t.flow.abandon.confirmBody.map((x) => <li key={x}>{x}</li>)}</ul>
      <div className="flex flex-wrap gap-2">
        <Button className="min-h-11 px-3" disabled={disabled} onClick={onConfirm} data-testid="live-abandon-confirm">{busy ? t.operation.working : t.flow.abandon.confirm}</Button>
        <Button variant="ghost" className="min-h-11 px-3" disabled={disabled} onClick={onBack} data-testid="live-abandon-back">{t.flow.abandon.back}</Button>
      </div>
    </div>
  );
}

function OperationView({ op, orphan = false, onChanged }: { op: LiveOperationRecord; orphan?: boolean; onChanged: () => void }) {
  const [busy, setBusy] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [confirmAbandon, setConfirmAbandon] = useState(false);
  const existingKind = op.kind === "deploy_existing_app";
  const lbl = (st: keyof typeof t.states_fa) => (existingKind ? t.existing.stateLabels[st] : undefined) ?? t.states_fa[st];
  const review = op.state === "NEEDS_OPERATOR_REVIEW";
  const cancellable = op.state === "AWAITING_LIVE_APPROVAL" || op.state === "APPROVED";
  async function act(action: "cancel" | "reverify" | "abandon") {
    setBusy(action);
    setError(null);
    const r = await api(`/api/agent/live/operations/${op.id}/resolve`, { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ action, ...(orphan ? { adoptOrphan: true } : {}) }) });
    setBusy(null);
    setConfirmAbandon(false);
    if (!r.ok) setError(r.message);
    onChanged();
  }
  return (
    <section aria-labelledby={`op-h-${op.id}`} className={cn("rounded-xl border p-4", op.state === "DEPLOYED" ? "border-primary/60 bg-primary/5" : op.failure ? "border-destructive/50" : "")} data-testid="live-operation" data-state={op.state} data-op-id={op.id} data-kind={op.kind} data-backend={op.backend}>
      <div className="flex flex-wrap items-center gap-2">
        <h3 id={`op-h-${op.id}`} className="font-semibold">{existingKind ? t.existing.timelineTitle : t.operation.title}</h3>
        <bdi className="ltr-isolate text-sm">{op.appName}</bdi>
        <Badge variant="outline" className={cn("ms-auto", op.state === "DEPLOYED" ? "border-primary text-primary" : op.state === "FAILED" || review ? "border-destructive/60 text-destructive" : "")} data-testid="live-op-state">
          {IN_FLIGHT.includes(op.state) && <Loader2 className="animate-spin motion-reduce:animate-none" aria-hidden />}
          {lbl(op.state)}
        </Badge>
      </div>

      <h4 className="mt-3 text-sm font-medium">{t.operation.timeline}</h4>
      <ol className="mt-1 flex flex-col gap-1 text-xs" data-testid="live-timeline">
        {op.transitions.map((x, i) => (
          <li key={i} data-to={x.to} className="flex items-center gap-2"><CheckCircle2 className="size-3.5 shrink-0 text-primary" aria-hidden /><span>{lbl(x.to)}</span><span className="ms-auto text-muted-foreground">{faDateTime(x.at)}</span></li>
        ))}
      </ol>

      <p className="mt-3 text-sm" data-testid="live-ladder-verdict" data-verdict={ladderVerdict(op.ladder)}><strong>{t.verification.verdict[ladderVerdict(op.ladder)]}</strong></p>
      <h4 className="mt-3 text-sm font-medium">{t.operation.ladder}</h4>
      <ul className="mt-1 flex flex-col gap-1 text-xs" data-testid="live-ladder">
        {Object.entries(op.ladder).map(([k, v]) => (
          <li key={k} data-level={k} data-value={v} className="flex items-center gap-2">
            {v === "ok" ? <CheckCircle2 className="size-3.5 shrink-0 text-primary" aria-hidden /> : v === "failed" ? <OctagonX className="size-3.5 shrink-0 text-destructive" aria-hidden /> : <CircleDashed className="size-3.5 shrink-0 text-muted-foreground" aria-hidden />}
            <span>{t.ladderLabels[k] ?? k}</span><span className="ms-auto text-muted-foreground">{t.levels[v]}</span>
          </li>
        ))}
      </ul>
      <details className="mt-2 text-xs" data-testid="live-ladder-evidence">
        <summary className="cursor-pointer text-muted-foreground">{t.verification.evidence}</summary>
        <ul className="mt-1 flex flex-col gap-1.5">
          {LADDER_KEYS.map((k) => (
            <li key={k} data-evidence-level={k} className="rounded-lg border p-2 leading-6"><strong>{t.ladderLabels[k]}</strong> <Badge variant="outline">{t.evidenceShort[LADDER_EVIDENCE[k].source]}</Badge><br /><bdi className="ltr-isolate text-muted-foreground">{LADDER_EVIDENCE[k].refs.join(" · ")}</bdi><br />{LADDER_EVIDENCE[k].limitationFa}</li>
          ))}
        </ul>
      </details>

      {op.failure && (
        <div className="mt-3 rounded-lg border border-destructive/40 bg-destructive/5 p-3" data-testid="live-failure" data-code={op.failure.code}>
          <h4 className="text-sm font-medium">{t.operation.failure}</h4>
          <p className="mt-1 text-sm leading-7">{op.failure.messageFa}</p>
          {op.recoveryFa.length > 0 && <><h4 className="mt-2 text-sm font-medium">{t.operation.recovery}</h4><ul className="mt-1 list-disc space-y-1 ps-5 text-sm leading-7" data-testid="live-recovery">{op.recoveryFa.map((r) => <li key={r}>{r}</li>)}</ul></>}
        </div>
      )}

      {(review || cancellable) && (
        <div className="mt-3 flex flex-wrap gap-2">
          {review && <Button variant="outline" className="min-h-11 px-3" disabled={busy !== null} onClick={() => void act("reverify")} data-testid="live-reverify">{busy === "reverify" ? t.operation.working : t.operation.reverify}</Button>}
          {review && <Button variant="outline" className="min-h-11 px-3" disabled={busy !== null} aria-expanded={confirmAbandon} onClick={() => setConfirmAbandon(true)} data-testid="live-abandon">{t.operation.abandon}</Button>}
          {cancellable && <Button variant="outline" className="min-h-11 px-3" disabled={busy !== null} onClick={() => void act("cancel")} data-testid="live-cancel">{busy === "cancel" ? t.operation.working : t.operation.cancel}</Button>}
        </div>
      )}
      {review && confirmAbandon && <AbandonConfirmBox opId={op.id} busy={busy === "abandon"} disabled={busy !== null} onConfirm={() => void act("abandon")} onBack={() => setConfirmAbandon(false)} />}
      {error && <p role="alert" className="mt-2 text-sm text-destructive" data-testid="live-op-error">{error}</p>}
    </section>
  );
}
