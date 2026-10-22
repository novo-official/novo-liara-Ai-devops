import { FlaskConical, ShieldOff, TriangleAlert } from "lucide-react";
import { Badge } from "@/components/ui/badge";
import { ui } from "@/i18n/agent-fa";
import { cn } from "@/lib/utils";
import type { ActionProposal, ApprovalRecord, SimulationResult } from "@/server/agent/types";

/**
 * Distinguishes: plan created · proposal approved · simulation completed/failed · verification · REAL OPERATION NOT EXECUTED.
 * Simulated outcomes are deliberately NOT green: blue = simulated completion, amber = simulated failure.
 */
export function SimulationResultView({ proposal, result, approvals }: { proposal: ActionProposal; result: SimulationResult | null; approvals: ApprovalRecord[] }) {
  const approved = approvals.some((a) => a.outcome === "accepted");
  const st = proposal.status;
  const terminalNoExec = st === "REJECTED" || st === "EXPIRED" || st === "BLOCKED" || st === "CANCELLED";
  return (
    <div className="mt-3 rounded-lg border border-dashed p-3 text-sm" data-testid="execution-result" data-proposal-status={st}>
      <div className="flex flex-wrap items-center gap-2">
        <Badge variant="outline" data-testid="stage-created"><FlaskConical aria-hidden />{ui.outcome.created}</Badge>
        {approved && <Badge variant="outline" className="border-primary/50 text-primary" data-testid="stage-approved">{ui.outcome.approved}</Badge>}
        {result && (
          <Badge variant="outline" className={cn(result.outcome === "failed" ? "border-warning/60 text-warning" : "border-primary/50 text-primary")} data-testid="stage-simulation" data-outcome={result.outcome}>
            {result.outcome === "failed" ? ui.outcome.simFailed : ui.outcome.simDone}
          </Badge>
        )}
        {result?.verification && result.verification.outcome !== "not_run" && (
          <Badge variant="outline" className={cn(result.verification.outcome === "failure" ? "border-warning/60 text-warning" : "border-primary/50 text-primary")} data-testid="stage-verification" data-outcome={result.verification.outcome}>
            {result.verification.outcome === "failure" ? ui.outcome.verifyFail : ui.outcome.verifyOk}
          </Badge>
        )}
        {terminalNoExec && <Badge variant="outline" className="border-border text-muted-foreground" data-testid="stage-terminal">{st === "REJECTED" ? ui.outcome.rejected : st === "EXPIRED" ? ui.outcome.expired : st === "CANCELLED" ? ui.outcome.cancelled : ui.outcome.blocked}</Badge>}
        <Badge variant="outline" className="border-warning/60 text-warning" data-testid="stage-not-real"><ShieldOff aria-hidden />{ui.outcome.notReal}</Badge>
      </div>
      {result && (
        <div className="mt-3">
          <p className="text-xs font-medium">{ui.steps}</p>
          <ul className="mt-1 list-disc space-y-1 ps-5 text-xs">
            {result.steps.map((s, i) => (
              <li key={i} className={s.status === "failed" ? "text-warning" : ""}>{s.labelFa}</li>
            ))}
          </ul>
          {result.verification && result.verification.criteria.length > 0 && (
            <>
              <p className="mt-2 text-xs font-medium">{ui.criteria}</p>
              <ul className="mt-1 space-y-1 text-xs" data-testid="criteria">
                {result.verification.criteria.map((c, i) => (
                  <li key={i} data-passed={c.passed ? "true" : "false"} className="flex items-start gap-1.5">
                    {c.passed ? <span aria-hidden>✓</span> : <TriangleAlert className="mt-0.5 size-3.5 shrink-0 text-warning" aria-hidden />}
                    <span>{c.textFa} {c.passed ? "" : "— برقرار نبود"}</span>
                  </li>
                ))}
              </ul>
            </>
          )}
          <p className="mt-2 text-xs font-medium text-warning" data-testid="sim-note">{result.noteFa}</p>
        </div>
      )}
    </div>
  );
}
