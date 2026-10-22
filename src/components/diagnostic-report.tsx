import { AlertTriangle, CheckCircle2, FlaskConical, HelpCircle, Radio, ShieldQuestion } from "lucide-react";
import { Badge } from "@/components/ui/badge";
import { confidenceHelp } from "@/i18n/diagnostics-fa";
import { fa } from "@/i18n/fa";
import { faDateTime } from "@/lib/format";
import { cn } from "@/lib/utils";
import type { DiagnosticReport } from "@/server/diagnostics/report";
import type { Confidence } from "@/server/diagnostics/types";

const t = fa.assistant.report;
const confStyle: Record<Confidence, string> = {
  HIGH: "border-success/50 text-success",
  MEDIUM: "border-primary/50 text-primary",
  LOW: "border-warning/50 text-warning",
  INSUFFICIENT_EVIDENCE: "border-border text-muted-foreground",
};
const riskStyle: Record<string, string> = { R0: "text-muted-foreground", R1: "border-warning/50 text-warning", R2: "border-destructive/50 text-destructive", R3: "border-destructive text-destructive" };
const evId = (id: string) => `ev-${id.slice(id.lastIndexOf("/") + 1)}`;

/** Presentational (no hooks): rendered inside the polling client component. */
export function DiagnosticReportView({ report }: { report: DiagnosticReport }) {
  const sourceOf = (id: string) => report.evidence.find((e) => e.id === id)?.sourceFa ?? id;
  return (
    <section aria-labelledby="report-title" data-testid="report" data-status={report.summary.status} className="flex flex-col gap-6">
      <div>
        <h2 id="report-title" className="text-xl font-bold">
          {t.title}
        </h2>
        <p data-testid="report-mode" data-mode={report.mode} className={cn("mt-2 flex items-start gap-2 rounded-lg border p-3 text-sm", report.simulated ? "border-warning/40 bg-warning/10 text-warning" : "border-success/40 bg-success/10 text-success")}>
          {report.simulated ? <FlaskConical className="mt-0.5 size-4 shrink-0" aria-hidden /> : <Radio className="mt-0.5 size-4 shrink-0" aria-hidden />}
          {report.simulated ? t.simulatedBanner : t.liveBanner}
        </p>
      </div>

      <div className="rounded-xl border p-4" data-testid="report-summary">
        <h3 className="mb-2 font-semibold">{t.summary}</h3>
        <p className="text-sm leading-7">{report.summary.textFa}</p>
        <p className="mt-3 flex flex-wrap items-center gap-2 text-sm">
          <span className="text-muted-foreground">{t.statusLabel}:</span>
          <span data-testid="summary-status">{report.summary.statusFa}</span>
          <Badge variant="outline" className={confStyle[report.summary.overallConfidence]} data-testid="summary-confidence" data-confidence={report.summary.overallConfidence}>
            {report.summary.overallConfidenceFa}
          </Badge>
        </p>
      </div>

      {report.caveats.length > 0 && (
        <ul className="flex flex-col gap-2" data-testid="caveats" aria-label={t.caveats}>
          {report.caveats.map((c) => (
            <li key={c.code} data-caveat={c.code} className="flex items-start gap-2 rounded-lg border border-warning/30 bg-warning/5 p-3 text-sm">
              <AlertTriangle className="mt-0.5 size-4 shrink-0 text-warning" aria-hidden />
              {c.textFa}
            </li>
          ))}
        </ul>
      )}

      <div>
        <h3 className="mb-3 font-semibold">{t.causes}</h3>
        {report.hypotheses.length === 0 ? (
          <p className="rounded-lg border border-dashed p-4 text-sm text-muted-foreground" data-testid="no-hypotheses">
            {t.noCauses}
          </p>
        ) : (
          <ol className="flex flex-col gap-4">
            {report.hypotheses.map((h, i) => (
              <li key={h.key} data-testid={`hypothesis-${h.key}`} data-rank={i + 1} data-confidence={h.confidence} className="rounded-xl border p-4">
                <div className="flex flex-wrap items-center justify-between gap-2">
                  <h4 className="font-semibold">
                    {i + 1}. {h.titleFa}
                  </h4>
                  <Badge variant="outline" className={confStyle[h.confidence]} title={confidenceHelp[h.confidence]}>
                    {h.confidenceFa}
                  </Badge>
                </div>
                <p className="mt-1 text-xs text-muted-foreground">
                  {t.confidenceWhy}: <span className="ltr-isolate">{h.ruleIds.join(" · ")}</span>
                </p>

                {h.observations.length > 0 && (
                  <div className="mt-3">
                    <h5 className="text-sm font-medium">{t.observations}</h5>
                    <ul className="mt-1 list-disc space-y-1 ps-5 text-sm" data-testid="observations">
                      {h.observations.map((o) => (
                        <li key={o.id}>{o.textFa}</li>
                      ))}
                    </ul>
                  </div>
                )}
                {h.inferences.length > 0 && (
                  <div className="mt-3">
                    <h5 className="text-sm font-medium">{t.inferences}</h5>
                    <ul className="mt-1 list-disc space-y-1 ps-5 text-sm text-muted-foreground" data-testid="inferences">
                      {h.inferences.map((o) => (
                        <li key={o.id}>{o.textFa}</li>
                      ))}
                    </ul>
                  </div>
                )}
                {h.contradictions.length > 0 && (
                  <div className="mt-3 rounded-lg border border-warning/40 bg-warning/5 p-3 text-sm" data-testid="contradictions">
                    <h5 className="font-medium text-warning">{t.contradictions}</h5>
                    <ul className="mt-1 list-disc space-y-1 ps-5">
                      {h.contradictions.map((c, k) => (
                        <li key={`${c.code}-${k}`}>{c.textFa}</li>
                      ))}
                    </ul>
                  </div>
                )}
                {h.missing.length > 0 && (
                  <div className="mt-3 text-xs text-muted-foreground" data-testid="hypothesis-missing">
                    <span className="font-medium">{t.missing}: </span>
                    {h.missing.map((m) => m.textFa).join(" ")}
                  </div>
                )}
                <p className="mt-3 text-xs text-muted-foreground">
                  {t.supportingEvidence}:{" "}
                  {h.evidenceIds.map((id) => (
                    <a key={id} href={`#${evId(id)}`} className="me-2 underline underline-offset-2" data-testid="citation">
                      {sourceOf(id)}
                    </a>
                  ))}
                </p>
              </li>
            ))}
          </ol>
        )}
      </div>

      <div data-testid="missing-evidence">
        <h3 className="mb-2 font-semibold">{t.missingEvidence}</h3>
        {report.missingEvidence.length === 0 ? (
          <p className="flex items-center gap-2 text-sm text-muted-foreground">
            <CheckCircle2 className="size-4 text-success" aria-hidden /> {t.allEvidenceOk}
          </p>
        ) : (
          <ul className="flex flex-col gap-2 text-sm">
            {report.missingEvidence.map((m) => (
              <li key={m.evidenceId} data-availability={m.availability} className="flex flex-wrap items-center gap-2 rounded-lg border p-2">
                <HelpCircle className="size-4 text-warning" aria-hidden />
                <span className="font-medium">{m.sourceFa}</span>
                <Badge variant="outline">{m.availabilityFa}</Badge>
              </li>
            ))}
          </ul>
        )}
      </div>

      <div data-testid="recommendations">
        <h3 className="mb-1 font-semibold">{t.recommendations}</h3>
        <p className="mb-3 flex items-center gap-2 text-xs text-muted-foreground">
          <ShieldQuestion className="size-4" aria-hidden /> {t.notExecuted}
        </p>
        {report.recommendations.length === 0 ? (
          <p className="text-sm text-muted-foreground">{t.noRecommendations}</p>
        ) : (
          <ul className="flex flex-col gap-3">
            {report.recommendations.map((r) => (
              <li key={r.id} data-testid="recommendation" data-risk={r.risk} data-related={r.relatedDiagnosis} data-executable="false" className="rounded-xl border p-4 text-sm">
                <div className="flex flex-wrap items-center gap-2">
                  <Badge variant="outline" className={riskStyle[r.risk]}>
                    {fa.assistant.risk[r.risk]}
                  </Badge>
                  <Badge variant="outline">{r.actor === "operator_manual" ? t.manual : t.futureOp}</Badge>
                  <Badge variant="outline" className={r.requiresApproval ? "border-warning/50 text-warning" : ""}>
                    {r.requiresApproval ? t.approval : t.noApproval}
                  </Badge>
                </div>
                <p className="mt-2 leading-7">{r.descriptionFa}</p>
                <p className="mt-1 text-muted-foreground">
                  <span className="font-medium">{t.impact}: </span>
                  {r.expectedImpactFa}
                </p>
                {r.prerequisitesFa.length > 0 && (
                  <div className="mt-1">
                    <span className="font-medium">{t.prerequisites}:</span>
                    <ul className="list-disc space-y-0.5 ps-5 text-muted-foreground">
                      {r.prerequisitesFa.map((p) => (
                        <li key={p}>{p}</li>
                      ))}
                    </ul>
                  </div>
                )}
                <div className="mt-1">
                  <span className="font-medium">{t.verification}:</span>
                  <ul className="list-disc space-y-0.5 ps-5 text-muted-foreground">
                    {r.verificationPlanFa.map((p) => (
                      <li key={p}>{p}</li>
                    ))}
                  </ul>
                </div>
              </li>
            ))}
          </ul>
        )}
      </div>

      {report.limitations.length > 0 && (
        <div data-testid="limitations">
          <h3 className="mb-2 font-semibold">{t.limitations}</h3>
          <ul className="list-disc space-y-1 ps-5 text-sm text-muted-foreground">
            {report.limitations.map((l) => (
              <li key={l.code}>{l.textFa}</li>
            ))}
          </ul>
        </div>
      )}

      <div data-testid="narrative" data-status={report.narrative.status}>
        <h3 className="mb-2 font-semibold">{t.narrative}</h3>
        {report.narrative.status === "ok" && report.narrative.textFa ? (
          <blockquote className="rounded-lg border-s-4 border-warning/60 bg-muted/30 p-3 text-sm leading-7">{report.narrative.textFa}</blockquote>
        ) : null}
        <p className="mt-1 text-xs text-muted-foreground">{t.narrativeStatus[report.narrative.status] ?? t.narrativeStatus.unavailable}</p>
      </div>

      <div data-testid="evidence-details">
        <h3 className="mb-1 font-semibold">{t.evidence}</h3>
        <p className="mb-3 text-xs text-muted-foreground">{t.evidenceNote}</p>
        <ul className="flex flex-col gap-2">
          {report.evidence.map((e) => (
            <li key={e.id} id={evId(e.id)} data-testid={`evidence-${e.source}`} data-availability={e.availability} data-simulated={e.simulated ? "true" : "false"}>
              <details className="rounded-lg border p-3">
                <summary className="flex min-h-8 cursor-pointer flex-wrap items-center gap-2 text-sm">
                  <span className="font-medium">{e.sourceFa}</span>
                  <Badge variant="outline">{e.availabilityFa}</Badge>
                  <Badge variant="outline" className={e.simulated ? "border-warning/50 text-warning" : "border-success/50 text-success"}>
                    {e.simulated ? t.simulatedTag : t.realTag}
                  </Badge>
                </summary>
                <dl className="mt-3 grid gap-x-4 gap-y-1 text-xs sm:grid-cols-2">
                  <dt className="text-muted-foreground">{t.capability}</dt>
                  <dd className="ltr-isolate">{e.capability}</dd>
                  <dt className="text-muted-foreground">{t.verificationLabel}</dt>
                  <dd className="ltr-isolate">{e.verification}</dd>
                  <dt className="text-muted-foreground">{t.freshness}</dt>
                  <dd>
                    {e.freshness.state}
                    {e.freshness.newestObservation ? ` — ${faDateTime(e.freshness.newestObservation)}` : ""}
                  </dd>
                  <dt className="text-muted-foreground">{t.window}</dt>
                  <dd>{e.window ? `${faDateTime(e.window.from)} → ${faDateTime(e.window.to)}` : "—"}</dd>
                </dl>
                {Object.keys(e.summary).length > 0 && (
                  <pre dir="ltr" tabIndex={0} className="mt-3 max-h-64 overflow-auto rounded-md bg-muted/40 p-2 text-start text-[0.7rem] leading-5">
                    {JSON.stringify(e.summary, null, 2)}
                  </pre>
                )}
                {e.excerpts.length > 0 && (
                  <div className="mt-3">
                    <p className="text-xs font-medium">{t.excerpts}</p>
                    <ul dir="ltr" className="mt-1 space-y-1 rounded-md bg-muted/40 p-2 text-start font-mono text-[0.7rem]">
                      {e.excerpts.map((x, i) => (
                        <li key={i} className="break-all whitespace-pre-wrap">
                          {x}
                        </li>
                      ))}
                    </ul>
                  </div>
                )}
              </details>
            </li>
          ))}
        </ul>
      </div>
      <p className="text-xs text-muted-foreground">
        {fa.detail.updatedAt}: {faDateTime(report.generatedAt)}
      </p>
    </section>
  );
}
