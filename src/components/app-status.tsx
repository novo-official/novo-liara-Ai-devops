import { Badge } from "@/components/ui/badge";
import { fa } from "@/i18n/fa";
import { isPositiveRuntime, type RuntimeAssessment } from "@/server/domain/runtime";
import type { RuntimeClass } from "@/server/domain/vocabulary";

type RuntimeKey = RuntimeAssessment["runtime"];

/** Colour semantics: green ONLY for a running runtime without failure evidence. "Enabled" is configuration, never green. */
export function runtimeStyle(a: RuntimeAssessment): string {
  if (isPositiveRuntime(a)) return "border-success/50 text-success";
  switch (a.runtime as RuntimeKey) {
    case "restarting":
      return "border-destructive/60 bg-destructive/10 text-destructive";
    case "starting":
      return "border-warning/50 text-warning";
    default:
      return "border-border text-muted-foreground";
  }
}

export function enabledStyle(a: RuntimeAssessment): string {
  return a.enabled === "enabled" ? "border-primary/50 text-primary" : "border-border text-muted-foreground";
}

export function enabledLabel(a: RuntimeAssessment): string {
  return a.enabled === "enabled" ? fa.runtime.enabled : a.enabled === "disabled" ? fa.runtime.disabled : fa.runtime.enabledUnknown;
}

/** Compact, independent indicators for list cards. */
export function StateBadges({ runtime, rawStatus }: { runtime: RuntimeAssessment; rawStatus?: string | null }) {
  const isRunning = isPositiveRuntime(runtime);
  return (
    <span className="inline-flex flex-wrap items-center gap-1.5" data-testid="state-badges">
      <Badge variant="outline" className={`rounded-full px-2.5 py-0.5 text-xs font-medium backdrop-blur-md transition-all ${enabledStyle(runtime)}`} data-testid="badge-enabled" data-enabled={runtime.enabled}>
        {fa.runtime.enabledLabel}: {enabledLabel(runtime)}
      </Badge>
      <Badge variant="outline" className={`inline-flex items-center gap-1.5 rounded-full px-2.5 py-0.5 text-xs font-semibold backdrop-blur-md transition-all ${runtimeStyle(runtime)}`} data-testid="badge-runtime" data-runtime={runtime.runtime}>
        {isRunning && <span className="size-1.5 rounded-full bg-success animate-pulse" />}
        {fa.runtime.classes[runtime.runtime]}
      </Badge>
      {rawStatus && (
        <span className="ltr-isolate text-xs font-mono text-muted-foreground/80 bg-muted/40 px-2 py-0.5 rounded-md border border-border/40" title={fa.apps.status}>
          {rawStatus}
        </span>
      )}
    </span>
  );
}

export type { RuntimeClass };
