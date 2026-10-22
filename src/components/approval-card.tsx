"use client";

import { useCallback, useRef, useState } from "react";
import { FlaskConical, Gavel } from "lucide-react";
import { Button } from "@/components/ui/button";
import { Badge } from "@/components/ui/badge";
import { Countdown } from "@/components/countdown";
import { SimulationResultView } from "@/components/simulation-result";
import { ui } from "@/i18n/agent-fa";
import { faDateTime } from "@/lib/format";
import type { ProposalView } from "@/server/agent/manager";

const d = ui.dialog;

/** Beginner-readable summary of a first-deployment plan (the raw parameters stay available under "technical details"). */
function DeploySummary({ params }: { params: Record<string, unknown> }) {
  const r = (params.resources ?? {}) as { ramMbMin?: number; ramMbRecommended?: number; diskGb?: number | null };
  const b = (params.build ?? {}) as { buildInvocation?: string | null; startInvocation?: string | null; port?: number };
  const keys = Array.isArray(params.envKeys) ? (params.envKeys as string[]) : [];
  const steps = Array.isArray(params.steps) ? (params.steps as string[]) : [];
  return (
    <div className="sm:col-span-2" data-testid="deploy-summary">
      <dt className="text-xs text-muted-foreground">خلاصهٔ طرح</dt>
      <dd>
        <ul className="mt-1 list-disc space-y-1 ps-5 leading-7">
          <li>پلتفرم: <bdi className="ltr-isolate">{String(params.platform)}</bdi> — دستهٔ منابع: {String(params.planCategory)} (راهنمای اولیه، نه پلن واقعی)</li>
          <li>حافظه: {r.ramMbMin}–{r.ramMbRecommended} MB{r.diskGb ? ` · دیسک ${r.diskGb} GB` : ""}</li>
          <li>ساخت: <bdi className="ltr-isolate">{b.buildInvocation ?? "—"}</bdi> · اجرا: <bdi className="ltr-isolate">{b.startInvocation ?? "—"}</bdi> · پورت {b.port}</li>
          <li>متغیرهای محیطی (فقط نام): {keys.length ? <bdi className="ltr-isolate">{keys.join(", ")}</bdi> : "ندارد"}</li>
          <li>{steps.length} مرحلهٔ شبیه‌سازی‌شده — هیچ‌کدام واقعی نیست</li>
        </ul>
      </dd>
    </div>
  );
}

/** Proposal card + native <dialog> (focus trap, Esc to close). Approval = digest of the exact reviewed proposal, validated by the server. */
export function ApprovalCard({ view, onChanged }: { view: ProposalView; onChanged: () => void }) {
  const { proposal: p, result, approvals } = view;
  const ref = useRef<HTMLDialogElement>(null);
  const opener = useRef<HTMLButtonElement>(null);
  const [typed, setTyped] = useState("");
  const [busy, setBusy] = useState<"approve" | "reject" | null>(null);
  const [error, setError] = useState<string | null>(null);
  const pending = p.status === "PENDING";
  const needsTyping = p.confirmation === "type_app_name";
  const typedOk = !needsTyping || typed === p.app;
  const expire = useCallback(() => onChanged(), [onChanged]);

  const open = () => {
    setError(null);
    ref.current?.showModal();
  };
  const close = () => {
    ref.current?.close();
    opener.current?.focus();
  };

  async function decide(decision: "approve" | "reject") {
    setBusy(decision);
    setError(null);
    try {
      const res = await fetch(`/api/agent/proposals/${p.id}/decision`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ decision, digest: p.digest, ...(needsTyping && decision === "approve" ? { confirmAppName: typed } : {}) }),
      });
      if (!res.ok) {
        const j = (await res.json()) as { error?: { message?: string } };
        setError(j.error?.message ?? "خطا");
      } else {
        close();
      }
      onChanged();
    } catch {
      setError(ui.pollError);
    } finally {
      setBusy(null);
    }
  }

  return (
    <article className="rounded-xl border p-4" data-testid="proposal-card" data-proposal-id={p.id} data-status={p.status} data-operation={p.operation} data-risk={p.risk}>
      <div className="flex flex-wrap items-center gap-2">
        <Badge variant="outline" className="border-warning/60 text-warning"><FlaskConical aria-hidden />{ui.proposalNote}</Badge>
        <Badge variant="outline" className={p.risk === "R2" ? "border-destructive/50 text-destructive" : "border-warning/50 text-warning"}>{ui.risks[p.risk]}</Badge>
        <Badge variant="outline" className="ltr-isolate">{p.operation}</Badge>
        {pending && <span className="ms-auto text-xs text-muted-foreground">{d.remaining}: <Countdown expiresAt={p.expiresAt} onExpire={expire} /></span>}
      </div>
      <p className="mt-2 text-sm leading-7">{p.descriptionFa}</p>
      <p className="mt-1 text-xs text-muted-foreground">{d.target}: <bdi className="ltr-isolate">{p.app}</bdi></p>

      {pending ? (
        <Button ref={opener} className="mt-3 min-h-11 px-4" onClick={open} data-testid="open-approval"><Gavel aria-hidden />{ui.review}</Button>
      ) : null}
      <SimulationResultView proposal={p} result={result} approvals={approvals} />

      <dialog ref={ref} aria-labelledby={`dlg-${p.id}`} data-testid="approval-dialog" className="m-auto w-[min(40rem,calc(100vw-1.5rem))] max-h-[90dvh] overflow-y-auto overflow-x-hidden rounded-xl border bg-card p-0 text-card-foreground backdrop:bg-black/60">
        <div className="flex min-w-0 flex-col gap-4 p-4 sm:p-5">
          <h2 id={`dlg-${p.id}`} className="text-lg font-bold">{d.title}</h2>
          <p role="note" className="rounded-lg border border-warning/50 bg-warning/10 p-3 text-sm text-warning" data-testid="dialog-sim-notice">{d.simNotice}</p>
          <dl className="grid min-w-0 gap-x-4 gap-y-3 text-sm sm:grid-cols-2 [&>div]:min-w-0 [&_dd]:break-words">
            <div className="sm:col-span-2"><dt className="text-xs text-muted-foreground">{d.action}</dt><dd className="mt-0.5 leading-7">{p.descriptionFa}</dd></div>
            <div><dt className="text-xs text-muted-foreground">{d.target}</dt><dd className="ltr-isolate mt-0.5 font-mono">{p.app}</dd></div>
            <div><dt className="text-xs text-muted-foreground">{d.operation}</dt><dd className="ltr-isolate mt-0.5 font-mono">{p.operation}</dd></div>
            <div><dt className="text-xs text-muted-foreground">{d.risk}</dt><dd className="mt-0.5">{ui.risks[p.risk]}</dd></div>
            <div><dt className="text-xs text-muted-foreground">{d.expires}</dt><dd className="mt-0.5">{faDateTime(p.expiresAt)} — <Countdown expiresAt={p.expiresAt} /></dd></div>
            <div className="sm:col-span-2"><dt className="text-xs text-muted-foreground">{d.impact}</dt><dd className="mt-0.5 leading-7">{p.impactFa}</dd></div>
            <div className="sm:col-span-2"><dt className="text-xs text-muted-foreground">{d.downtime}</dt><dd className="mt-0.5 leading-7">{p.downtimeFa}</dd></div>
            {p.operation === "first_deploy" && <DeploySummary params={p.params} />}
            <div className="sm:col-span-2"><dt className="text-xs text-muted-foreground">{d.params}</dt><dd>{p.operation === "first_deploy" ? <details className="mt-1 text-xs"><summary className="cursor-pointer text-muted-foreground">{d.paramsAdvanced}</summary><pre dir="ltr" className="mt-1 max-w-full overflow-auto rounded-md bg-muted/40 p-2 text-start text-xs">{JSON.stringify(p.params, null, 2)}</pre></details> : <pre dir="ltr" className="mt-1 max-w-full overflow-auto rounded-md bg-muted/40 p-2 text-start text-xs">{JSON.stringify(p.params, null, 2)}</pre>}</dd></div>
            <div className="sm:col-span-2"><dt className="text-xs text-muted-foreground">{d.preconditions}</dt><dd><ul className="mt-1 list-disc space-y-1 ps-5">{p.preconditionsFa.map((x) => <li key={x}>{x}</li>)}</ul></dd></div>
            <div className="sm:col-span-2"><dt className="text-xs text-muted-foreground">{d.verification}</dt><dd><ul className="mt-1 list-disc space-y-1 ps-5">{p.verificationPlanFa.map((x) => <li key={x}>{x}</li>)}</ul></dd></div>
            <div className="sm:col-span-2"><dt className="text-xs text-muted-foreground">{d.digest}</dt><dd className="ltr-isolate mt-0.5 break-all font-mono text-xs" data-testid="digest">{p.digest}</dd></div>
          </dl>
          {needsTyping && (
            <div className="flex flex-col gap-2">
              <label htmlFor={`confirm-${p.id}`} className="text-sm font-medium">{d.typeName(p.app)}</label>
              <input id={`confirm-${p.id}`} dir="ltr" autoComplete="off" value={typed} onChange={(e) => setTyped(e.target.value)} data-testid="confirm-input" className="h-11 w-full rounded-lg border border-input bg-background px-3 text-start font-mono" />
            </div>
          )}
          {error && <p role="alert" data-testid="dialog-error" className="text-sm text-destructive">{error}</p>}
          <div className="flex flex-wrap gap-2">
            <Button className="min-h-11 px-4" disabled={busy !== null || !typedOk} onClick={() => decide("approve")} data-testid="approve">{busy === "approve" ? d.working : d.approve}</Button>
            <Button variant="outline" className="min-h-11 px-4" disabled={busy !== null} onClick={() => decide("reject")} data-testid="reject">{busy === "reject" ? d.working : d.reject}</Button>
            <Button variant="ghost" className="min-h-11 px-4" disabled={busy !== null} onClick={close} data-testid="close-dialog">{d.close}</Button>
          </div>
        </div>
      </dialog>
    </article>
  );
}
