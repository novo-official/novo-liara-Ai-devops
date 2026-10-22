"use client";

import { useEffect, useState } from "react";
import { Clock } from "lucide-react";
import { fa } from "@/i18n/fa";
import { faDateTime, relativeFa } from "@/lib/format";
import { cn } from "@/lib/utils";

/**
 * Shows when the data was fetched and keeps ageing it on the client, so a page that stays open (or is restored
 * from the browser's back/forward cache) can never silently look current. Before hydration only the absolute
 * fetch time is rendered.
 */
export function Freshness({ fetchedAt, staleAfterSec = 120, className }: { fetchedAt: string; staleAfterSec?: number; className?: string }) {
  const [age, setAge] = useState<number | null>(null);
  useEffect(() => {
    const tick = () => setAge(Math.max(0, (Date.now() - Date.parse(fetchedAt)) / 1000));
    tick();
    const id = setInterval(tick, 10_000);
    const onShow = () => tick();
    window.addEventListener("pageshow", onShow);
    document.addEventListener("visibilitychange", onShow);
    return () => {
      clearInterval(id);
      window.removeEventListener("pageshow", onShow);
      document.removeEventListener("visibilitychange", onShow);
    };
  }, [fetchedAt]);

  const stale = age !== null && age > staleAfterSec;
  return (
    <span data-testid="freshness" data-stale={stale ? "true" : "false"} className={cn("inline-flex flex-wrap items-center gap-x-1.5 text-xs", stale ? "text-warning" : "text-muted-foreground", className)}>
      <Clock className="size-3" aria-hidden />
      <span>
        {fa.fresh.fetched}: <time dateTime={fetchedAt}>{faDateTime(fetchedAt)}</time>
      </span>
      {age !== null && <span>({age < 5 ? fa.fresh.justNow : relativeFa(age, fa.fresh.ago)})</span>}
      {stale && <strong role="status">{fa.fresh.stale}</strong>}
    </span>
  );
}
