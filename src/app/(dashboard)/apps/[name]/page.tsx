import Link from "next/link";
import { notFound } from "next/navigation";
import { Suspense } from "react";
import type { Metadata } from "next";
import { ChevronRight } from "lucide-react";
import { RuntimePanel } from "@/components/runtime-panel";
import { assessRuntime } from "@/server/domain/runtime";
import { MetricChart } from "@/components/metric-chart";
import { ModeBadge } from "@/components/mode-badge";
import { RefreshButton } from "@/components/refresh-button";
import { Resolved, SectionCard, SectionError, SectionSkeleton } from "@/components/section-card";
import { Badge } from "@/components/ui/badge";
import { fa } from "@/i18n/fa";
import { faDateTime, faNumber, faTime } from "@/lib/format";
import { cn } from "@/lib/utils";
import { requireSession } from "@/server/auth-dal";
import { getService } from "@/server/liara/service";
import { WINDOWS_MINUTES, type WindowMinutes } from "@/server/liara/read-client";

export const dynamic = "force-dynamic";

type Props = { params: Promise<{ name: string }>; searchParams: Promise<{ window?: string }> };

export async function generateMetadata({ params }: Props): Promise<Metadata> {
  const { name } = await params;
  return { title: name };
}

function parseWindow(raw: string | undefined): WindowMinutes {
  const n = Number(raw);
  return (WINDOWS_MINUTES as readonly number[]).includes(n) ? (n as WindowMinutes) : 60;
}

export default async function AppDetailPage({ params, searchParams }: Props) {
  await requireSession();
  const { name } = await params;
  const win = parseWindow((await searchParams).window);
  const svc = getService();
  if (!svc.isAllowed(name)) notFound(); // identical for unknown, malformed and non-allowlisted names

  const base = `/apps/${encodeURIComponent(name)}`;
  return (
    <div className="flex flex-col gap-6">
      <div>
        <Link href="/apps" className="inline-flex min-h-11 items-center gap-1 text-sm text-muted-foreground hover:text-foreground">
          <ChevronRight className="size-4" aria-hidden />
          {fa.detail.back}
        </Link>
        <div className="flex flex-wrap items-center justify-between gap-3">
          <div className="flex flex-wrap items-center gap-3">
            <h1 className="ltr-isolate text-2xl font-bold break-all">{name}</h1>
            <ModeBadge mode={svc.mode} />
          </div>
          <RefreshButton />
        </div>
        <nav aria-label={fa.detail.window} className="mt-4 flex flex-wrap items-center gap-2">
          <span className="text-xs font-semibold text-muted-foreground me-1">{fa.detail.window}:</span>
          <div className="inline-flex items-center gap-1 rounded-xl bg-card/60 p-1 border border-border/60 backdrop-blur-md shadow-inner">
            {WINDOWS_MINUTES.map((w) => (
              <Link
                key={w}
                href={`${base}?window=${w}`}
                aria-current={w === win ? "true" : undefined}
                className={cn(
                  "inline-flex min-h-8 items-center rounded-lg px-3 py-1 text-xs font-semibold transition-all duration-200",
                  w === win
                    ? "bg-primary/15 text-primary border border-primary/25 shadow-xs"
                    : "text-muted-foreground hover:text-foreground hover:bg-muted/40"
                )}
              >
                {fa.detail.windows[String(w)]}
              </Link>
            ))}
          </div>
        </nav>
      </div>

      <Suspense fallback={<SectionSkeleton title={fa.detail.runtime} />}>
        <Runtime name={name} />
      </Suspense>

      <div className="grid gap-6 lg:grid-cols-2">
        <Suspense fallback={<SectionSkeleton title={fa.detail.cpu} />}>
          <Metric name={name} kind="cpu" win={win} />
        </Suspense>
        <Suspense fallback={<SectionSkeleton title={fa.detail.memory} />}>
          <Metric name={name} kind="memory" win={win} />
        </Suspense>
      </div>

      <div className="grid gap-6 lg:grid-cols-2">
        <Suspense fallback={<SectionSkeleton title={fa.detail.releases} />}>
          <Releases name={name} />
        </Suspense>
        <Suspense fallback={<SectionSkeleton title={fa.detail.events} />}>
          <Events name={name} win={win} />
        </Suspense>
      </div>

      <Suspense fallback={<SectionSkeleton title={fa.detail.logs} rows={6} />}>
        <Logs name={name} win={win} />
      </Suspense>
    </div>
  );
}

async function Runtime({ name }: { name: string }) {
  const svc = getService();
  const [app, applets] = await Promise.all([svc.getApp(name), svc.getApplets(name)]);
  return (
    <SectionCard title={fa.detail.runtime} meta={app.meta} testId="section-runtime">
      {!app.ok ? (
        <SectionError code={app.error.code} />
      ) : (
        <div className="flex flex-col gap-5">
          <RuntimePanel a={assessRuntime(app.data, applets.ok ? applets.data : null)} rawStatus={app.data.status} />
          <dl className="grid grid-cols-2 gap-x-4 gap-y-3 text-sm sm:grid-cols-3">
            <Fact label={fa.apps.platform}>
              <span className="ltr-isolate">{app.data.platform ?? fa.apps.unknown}</span>
            </Fact>
            <Fact label={fa.detail.plan}>
              <span className="ltr-isolate">{app.data.planId ?? fa.apps.unknown}</span>
            </Fact>
            <Fact label={fa.detail.deployed}>{app.data.isDeployed === null ? fa.apps.unknown : app.data.isDeployed ? fa.detail.yes : fa.detail.no}</Fact>
          </dl>

          <div>
            <h3 className="mb-2 text-sm font-medium">{fa.detail.applets}</h3>
            {!applets.ok ? (
              <SectionError code={applets.error.code} />
            ) : applets.data.items.length === 0 ? (
              <p className="text-sm text-muted-foreground" data-testid="applets-empty">
                {fa.detail.noApplets}
              </p>
            ) : (
              <ul className="flex flex-col gap-2" data-testid="applets-list">
                {applets.data.items.map((a) => (
                  <li key={a.id} className="rounded-lg border p-3 text-sm">
                    <div className="flex flex-wrap items-center justify-between gap-2">
                      <bdi className="ltr-isolate break-all font-mono text-xs">{a.name ?? a.id}</bdi>
                      <Badge variant="outline" className="ltr-isolate">
                        {a.state ?? fa.apps.unknown}
                      </Badge>
                    </div>
                    <p className="mt-1 text-xs text-muted-foreground">
                      {faDateTime(a.since)}
                      {a.releaseTag && <> · <bdi className="ltr-isolate">{a.releaseTag}</bdi></>}
                    </p>
                    {a.reason && <p className="ltr-isolate mt-1 text-xs">{a.reason}</p>}
                  </li>
                ))}
              </ul>
            )}
          </div>

          <details className="rounded-lg border p-3">
            <summary className="min-h-8 cursor-pointer text-sm font-medium">
              {fa.detail.envKeys} ({faNumber(app.data.envKeys.length)})
            </summary>
            <p className="my-2 text-xs text-muted-foreground">{fa.detail.envKeysNote}</p>
            <ul className="flex flex-wrap gap-2">
              {app.data.envKeys.map((k) => (
                <li key={k.key} className="ltr-isolate rounded-md bg-muted px-2 py-1 font-mono text-xs">
                  {k.key}
                </li>
              ))}
            </ul>
          </details>
        </div>
      )}
    </SectionCard>
  );
}

function Fact({ label, children }: { label: string; children: React.ReactNode }) {
  return (
    <div>
      <dt className="text-xs text-muted-foreground">{label}</dt>
      <dd className="mt-0.5">{children}</dd>
    </div>
  );
}

async function Metric({ name, kind, win }: { name: string; kind: "cpu" | "memory"; win: WindowMinutes }) {
  const section = await getService().getMetrics(name, kind, win);
  const title = kind === "cpu" ? fa.detail.cpu : fa.detail.memory;
  return <Resolved section={section} title={title} testId={`section-${kind}`} render={(r) => <MetricChart result={r} label={title} fetchedAt={section.meta.fetchedAt} />} />;
}

async function Releases({ name }: { name: string }) {
  const section = await getService().getReleases(name, 1, 10);
  return (
    <Resolved
      section={section}
      title={fa.detail.releases}
      testId="section-releases"
      render={(r) =>
        r.releases.length === 0 ? (
          <p className="text-sm text-muted-foreground" data-testid="releases-empty">
            {fa.detail.noReleases}
          </p>
        ) : (
          <div className="flex flex-col gap-3">
            {r.currentRelease && (
              <p className="text-xs text-muted-foreground">
                {fa.detail.currentRelease}: <bdi className="ltr-isolate">{r.currentRelease}</bdi>
                <span className="mt-1 block" data-testid="release-hint">{fa.detail.releaseHint}</span>
              </p>
            )}
            <ul className="flex flex-col gap-2">
              {r.releases.map((rel) => (
                <li key={rel.id} className="rounded-lg border p-3 text-sm">
                  <div className="flex flex-wrap items-center justify-between gap-2">
                    <bdi className="ltr-isolate font-mono">{rel.tag ?? rel.id}</bdi>
                    <Badge variant="outline" className="ltr-isolate">
                      {rel.state ?? fa.apps.unknown}
                    </Badge>
                  </div>
                  <p className="mt-1 text-xs text-muted-foreground">{faDateTime(rel.createdAt)}</p>
                  {(rel.branch || rel.commit || rel.message) && (
                    <p className="ltr-isolate mt-1 text-xs">
                      {[rel.branch, rel.commit].filter(Boolean).join(" @ ")}
                      {rel.message ? ` — ${rel.message}` : ""}
                    </p>
                  )}
                </li>
              ))}
            </ul>
          </div>
        )
      }
    />
  );
}

async function Events({ name, win }: { name: string; win: WindowMinutes }) {
  const section = await getService().getEvents(name, win);
  return (
    <Resolved
      section={section}
      title={fa.detail.events}
      testId="section-events"
      render={(e) =>
        e.rows.length === 0 ? (
          <p className="text-sm text-muted-foreground" data-testid="events-empty">
            {fa.detail.noEvents}
          </p>
        ) : (
          <div className="flex flex-col gap-2">
            <ul className="flex flex-col gap-2">
              {e.rows.map((r, i) => (
                <li key={i} className="rounded-lg border p-3 text-sm">
                  <p className="text-xs text-muted-foreground">{faDateTime(r.time)}</p>
                  <p className="ltr-isolate mt-0.5 text-start">{r.text}</p>
                </li>
              ))}
            </ul>
            {e.rows.some((r) => r.timeInferred) && <p className="text-xs text-muted-foreground">{fa.detail.timeInferred}</p>}
            {e.truncated && <p className="text-xs text-muted-foreground">{fa.detail.truncated}</p>}
          </div>
        )
      }
    />
  );
}

async function Logs({ name, win }: { name: string; win: WindowMinutes }) {
  const section = await getService().getLogs(name, win, 200);
  return (
    <Resolved
      section={section}
      title={fa.detail.logs}
      testId="section-logs"
      note={section.ok ? fa.detail.logSource(section.data.source, section.data.contract) : undefined}
      render={(l) =>
        l.lines.length === 0 ? (
          <p className="text-sm text-muted-foreground" data-testid="logs-empty">
            {fa.detail.noLogs}
          </p>
        ) : (
          <div className="flex flex-col gap-2">
            <div role="region" aria-label={fa.detail.logs} tabIndex={0} className="max-h-96 overflow-auto rounded-lg bg-muted/40 p-3">
              <ol className="ltr-isolate flex flex-col gap-0.5 font-mono text-xs leading-relaxed" data-testid="logs-list">
                {l.lines.map((line, i) => (
                  <li key={i} className="whitespace-pre-wrap break-all">
                    <span className="text-muted-foreground">{faTime(line.time)}</span>
                    {line.stream && <span className="text-muted-foreground"> [{line.stream}]</span>} {line.message}
                  </li>
                ))}
              </ol>
            </div>
            {l.truncated && <p className="text-xs text-muted-foreground">{fa.detail.truncated}</p>}
          </div>
        )
      }
    />
  );
}
