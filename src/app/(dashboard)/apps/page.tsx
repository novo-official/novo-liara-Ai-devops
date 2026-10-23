import Link from "next/link";
import { Suspense } from "react";
import type { Metadata } from "next";
import { ChevronLeft, Inbox } from "lucide-react";
import { StateBadges } from "@/components/app-status";
import { Freshness } from "@/components/freshness";
import { ModeBadge } from "@/components/mode-badge";
import { RefreshButton } from "@/components/refresh-button";
import { SectionError } from "@/components/section-card";
import { Skeleton } from "@/components/ui/skeleton";
import { fa } from "@/i18n/fa";
import { faDateTime } from "@/lib/format";
import { requireSession } from "@/server/auth-dal";
import { getService } from "@/server/liara/service";

export const metadata: Metadata = { title: fa.apps.title };
export const dynamic = "force-dynamic";

export default async function AppsPage() {
  await requireSession();
  return (
    <div className="flex flex-col gap-6">
      <div className="flex flex-wrap items-end justify-between gap-3">
        <div>
          <h1 className="text-2xl font-bold">{fa.apps.title}</h1>
          <p className="text-sm text-muted-foreground">{fa.apps.subtitle}</p>
        </div>
        <RefreshButton />
      </div>
      <Suspense fallback={<AppsSkeleton />}>
        <AppsList />
      </Suspense>
    </div>
  );
}

function AppsSkeleton() {
  return (
    <div aria-busy="true" aria-label={fa.state.loading} className="grid gap-4 sm:grid-cols-2 lg:grid-cols-3">
      {Array.from({ length: 3 }, (_, i) => (
        <Skeleton key={i} className="h-40 rounded-xl motion-reduce:animate-none" />
      ))}
    </div>
  );
}

async function AppsList() {
  const section = await getService().listAppsWithRuntime();
  return (
    <>
      <Freshness fetchedAt={section.meta.fetchedAt} className="-mt-3" />
      {!section.ok && <SectionError code={section.error.code} />}

      {section.ok && section.data.items.length === 0 && (
        <div data-testid="apps-empty" className="flex flex-col items-center gap-2 rounded-xl border border-dashed p-10 text-center">
          <Inbox className="size-8 text-muted-foreground" aria-hidden />
          <p className="font-medium">{fa.apps.empty}</p>
          <p className="max-w-md text-sm text-muted-foreground">{fa.apps.emptyHint}</p>
        </div>
      )}

      {section.ok && section.data.items.length > 0 && (
        <ul className="grid gap-5 sm:grid-cols-2 lg:grid-cols-3" data-testid="apps-list">
          {section.data.items.map((app) => (
            <li key={app.name}>
              <div className="group relative flex h-full flex-col justify-between overflow-hidden rounded-2xl border border-border/70 bg-gradient-to-b from-card/90 via-card/70 to-card/40 p-5 shadow-xs backdrop-blur-md transition-all duration-300 hover:border-primary/40 hover:shadow-md hover:shadow-primary/5 hover:-translate-y-1">
                <div className="flex flex-col gap-4">
                  <div className="flex items-start justify-between gap-2 border-b border-border/40 pb-3">
                    <div className="flex flex-col">
                      <bdi className="ltr-isolate text-base font-bold tracking-tight text-foreground break-all group-hover:text-primary transition-colors">
                        {app.name}
                      </bdi>
                      <span className="text-xs text-muted-foreground/80 mt-0.5">
                        {app.platform ?? fa.apps.unknown}
                      </span>
                    </div>
                    <ModeBadge mode={section.meta.mode} />
                  </div>

                  <dl className="grid grid-cols-[auto_1fr] items-center gap-x-4 gap-y-2.5 text-xs sm:text-sm">
                    <dt className="text-muted-foreground font-medium">{fa.apps.status}</dt>
                    <dd>
                      <StateBadges runtime={app.runtime} rawStatus={app.status} />
                    </dd>
                    <dt className="text-muted-foreground font-medium">{fa.apps.updated}</dt>
                    <dd className="text-muted-foreground/90 font-mono text-xs">{faDateTime(app.createdAt)}</dd>
                  </dl>
                </div>

                <div className="mt-5 pt-3 border-t border-border/30">
                  <Link
                    href={`/apps/${encodeURIComponent(app.name)}`}
                    className="inline-flex w-full min-h-10 items-center justify-between rounded-xl bg-secondary/60 hover:bg-primary border border-border/50 hover:border-primary px-3.5 text-xs sm:text-sm font-semibold text-secondary-foreground hover:text-primary-foreground transition-all duration-200 shadow-xs"
                  >
                    <span>{fa.apps.open}</span>
                    <ChevronLeft className="size-4 transition-transform group-hover:-translate-x-1" aria-hidden />
                  </Link>
                </div>
              </div>
            </li>
          ))}
        </ul>
      )}

      {section.ok && (section.data.allowlistedMissing > 0 || section.data.skipped > 0) && (
        <div className="text-xs text-muted-foreground">
          {section.data.allowlistedMissing > 0 && <p>{fa.apps.missing(section.data.allowlistedMissing)}</p>}
          {section.data.skipped > 0 && <p>{fa.apps.skipped(section.data.skipped)}</p>}
        </div>
      )}
    </>
  );
}
