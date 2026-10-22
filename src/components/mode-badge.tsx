import { FlaskConical, RadioTower } from "lucide-react";
import { Badge } from "@/components/ui/badge";
import { fa } from "@/i18n/fa";
import type { DataMode } from "@/server/domain/models";

export function ModeBadge({ mode }: { mode: DataMode }) {
  const live = mode === "live";
  return (
    <Badge variant="outline" data-testid="mode-badge" data-mode={mode} className={live ? "border-success/50 text-success" : "border-warning/50 text-warning"}>
      {live ? <RadioTower aria-hidden /> : <FlaskConical aria-hidden />}
      {live ? fa.mode.live : fa.mode.mock}
    </Badge>
  );
}

export function ModeBanner({ mode }: { mode: DataMode }) {
  const live = mode === "live";
  return (
    <p
      role="status"
      data-testid="mode-banner"
      className={`border-b px-4 py-2 text-center text-xs ${live ? "border-success/30 bg-success/10 text-success" : "border-warning/30 bg-warning/10 text-warning"}`}
    >
      {live ? fa.mode.liveBanner : fa.mode.mockBanner}
    </p>
  );
}
