import { TriangleAlert } from "lucide-react";
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from "@/components/ui/card";
import { Skeleton } from "@/components/ui/skeleton";
import { errorMessage, fa } from "@/i18n/fa";
import { Freshness } from "@/components/freshness";
import type { Meta, Section } from "@/server/domain/models";

export function SectionCard({
  title,
  meta,
  note,
  children,
  testId,
}: {
  title: string;
  meta?: Meta | { mode: string; fetchedAt: string };
  note?: string;
  children: React.ReactNode;
  testId?: string;
}) {
  return (
    <Card data-testid={testId} className="min-w-0">
      <CardHeader>
        <CardTitle className="text-base">{title}</CardTitle>
        {(meta || note) && (
          <CardDescription className="flex flex-wrap gap-x-3 gap-y-1 text-xs">
            {meta && <Freshness fetchedAt={meta.fetchedAt} />}
            {note && <span>{note}</span>}
          </CardDescription>
        )}
      </CardHeader>
      <CardContent className="min-w-0">{children}</CardContent>
    </Card>
  );
}

export function SectionError({ code }: { code: string }) {
  // HTTP 204: the endpoint answered but supplied no payload — a warning (content unverifiable), not a hard failure and never "no events"
  const soft = code === "no_content";
  return (
    <div role="alert" data-testid="section-error" data-code={code} data-severity={soft ? "warning" : "error"} className={soft ? "flex items-start gap-2 rounded-lg border border-warning/50 bg-warning/10 p-3 text-sm" : "flex items-start gap-2 rounded-lg border border-destructive/40 bg-destructive/10 p-3 text-sm"}>
      <TriangleAlert className={soft ? "mt-0.5 size-4 shrink-0 text-warning" : "mt-0.5 size-4 shrink-0 text-destructive"} aria-hidden />
      <div>
        <p>{errorMessage(code)}</p>
        <p className="mt-1 text-xs text-muted-foreground">{fa.state.retry}: «{fa.detail.refresh}»</p>
      </div>
    </div>
  );
}

export function SectionSkeleton({ title, rows = 3 }: { title: string; rows?: number }) {
  return (
    <Card aria-busy="true" aria-label={`${title} — ${fa.state.loading}`}>
      <CardHeader>
        <CardTitle className="text-base">{title}</CardTitle>
      </CardHeader>
      <CardContent className="flex flex-col gap-2">
        {Array.from({ length: rows }, (_, i) => (
          <Skeleton key={i} className="h-5 w-full motion-reduce:animate-none" />
        ))}
      </CardContent>
    </Card>
  );
}

/** Renders a Section: error panel on failure, otherwise delegates to `render`. */
export function Resolved<T>({ section, title, note, render, testId }: { section: Section<T>; title: string; note?: string; render: (data: T) => React.ReactNode; testId?: string }) {
  return (
    <SectionCard title={title} meta={section.meta} note={section.ok ? note : undefined} testId={testId}>
      {section.ok ? render(section.data) : <SectionError code={section.error.code} />}
    </SectionCard>
  );
}
