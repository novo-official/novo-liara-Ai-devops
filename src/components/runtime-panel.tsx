import { fa } from "@/i18n/fa";
import { faNumber } from "@/lib/format";
import type { RuntimeAssessment } from "@/server/domain/runtime";
import { Badge } from "@/components/ui/badge";
import { enabledLabel, enabledStyle, runtimeStyle } from "./app-status";

/** Three independent rows: configuration, runtime (from applets), health evidence. Never collapsed into one "status". */
export function RuntimePanel({ a, rawStatus }: { a: RuntimeAssessment; rawStatus: string | null }) {
  return (
    <div className="flex flex-col gap-3" data-testid="runtime-panel">
      <dl className="grid gap-3 text-sm sm:grid-cols-3">
        <div data-testid="state-enabled" data-enabled={a.enabled}>
          <dt className="text-xs text-muted-foreground">{fa.runtime.enabledLabel}</dt>
          <dd className="mt-1 flex flex-wrap items-center gap-2">
            <Badge variant="outline" className={enabledStyle(a)}>
              {enabledLabel(a)}
            </Badge>
            {rawStatus && (
              <span className="ltr-isolate text-xs text-muted-foreground" title={fa.apps.status}>
                {rawStatus}
              </span>
            )}
          </dd>
        </div>
        <div data-testid="state-runtime" data-runtime={a.runtime}>
          <dt className="text-xs text-muted-foreground">{fa.runtime.runtimeLabel}</dt>
          <dd className="mt-1">
            <Badge variant="outline" className={runtimeStyle(a)}>
              {fa.runtime.classes[a.runtime]}
            </Badge>
          </dd>
        </div>
        <div data-testid="state-health" data-health={a.health}>
          <dt className="text-xs text-muted-foreground">{fa.runtime.healthLabel}</dt>
          <dd className="mt-1 text-muted-foreground">{fa.runtime.healthNone}</dd>
        </div>
      </dl>

      {a.byState.length > 0 && (
        <div className="text-xs text-muted-foreground">
          <span>{fa.runtime.rawStates}: </span>
          {a.byState.map((s) => (
            <span key={s.raw} className="ltr-isolate me-3 inline-block">
              {s.raw} ×{faNumber(s.count)} → {fa.runtime.classes[s.class]}
            </span>
          ))}
          <p className="mt-1">{a.runtimeIsHeuristic ? fa.runtime.heuristic : fa.runtime.verified}</p>
        </div>
      )}

      {a.failureReasons.length > 0 && (
        <div className="rounded-lg border border-destructive/40 bg-destructive/10 p-3 text-xs" data-testid="failure-reasons">
          <p className="mb-1 font-medium text-destructive">{fa.runtime.reasons}</p>
          <ul className="ltr-isolate list-disc space-y-0.5 ps-5">
            {a.failureReasons.map((r) => (
              <li key={r}>{r}</li>
            ))}
          </ul>
        </div>
      )}

      {a.enabled === "enabled" && a.runtime !== "running" && <p className="text-xs text-warning">{fa.runtime.notHealthy}</p>}
    </div>
  );
}
