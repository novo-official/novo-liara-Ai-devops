import { FlaskConical, RadioTower } from "lucide-react";
import { Badge } from "@/components/ui/badge";
import { fa } from "@/i18n/fa";
import type { DataMode } from "@/server/domain/models";

export function ModeBadge({ mode }: { mode: DataMode }) {
  const live = mode === "live";
  return (
    <Badge
      variant="outline"
      data-testid="mode-badge"
      data-mode={mode}
      className={`inline-flex items-center gap-1.5 px-2.5 py-1 text-xs font-semibold rounded-full backdrop-blur-md shadow-xs transition-all ${
        live
          ? "border-success/40 bg-success/10 text-success shadow-success/10"
          : "border-warning/40 bg-warning/10 text-warning shadow-warning/10"
      }`}
    >
      <span className={`size-1.5 rounded-full ${live ? "bg-success animate-pulse" : "bg-warning"}`} />
      {live ? <RadioTower className="size-3.5" aria-hidden /> : <FlaskConical className="size-3.5" aria-hidden />}
      <span>{live ? fa.mode.live : fa.mode.mock}</span>
    </Badge>
  );
}

export function ModeBanner({ mode }: { mode: DataMode }) {
  const live = mode === "live";
  return (
    <div
      role="status"
      data-testid="mode-banner"
      className={`border-b px-4 py-1.5 text-center text-xs font-medium backdrop-blur-md transition-colors ${
        live
          ? "border-success/20 bg-success/5 text-success"
          : "border-warning/20 bg-warning/5 text-warning"
      }`}
    >
      <div className="mx-auto flex max-w-6xl items-center justify-center gap-2">
        <span className={`size-1.5 rounded-full ${live ? "bg-success" : "bg-warning"}`} />
        <span>{live ? fa.mode.liveBanner : fa.mode.mockBanner}</span>
      </div>
    </div>
  );
}

