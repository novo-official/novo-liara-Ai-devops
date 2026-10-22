import Link from "next/link";
import type { Metadata } from "next";
import { Bot, FlaskConical, ShieldCheck } from "lucide-react";
import { DiagnosticForm } from "@/components/diagnostic-form";
import { Freshness } from "@/components/freshness";
import { ModeBadge } from "@/components/mode-badge";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { fa } from "@/i18n/fa";
import { intentLabel } from "@/i18n/diagnostics-fa";
import { faDateTime } from "@/lib/format";
import { requireSession } from "@/server/auth-dal";
import { getConfig } from "@/server/config/env";
import { getRunManager } from "@/server/diagnostics/runtime";
import { getService } from "@/server/liara/service";

export const metadata: Metadata = { title: fa.assistant.title };
export const dynamic = "force-dynamic";
const a = fa.assistant;

export default async function AssistantPage() {
  const session = await requireSession();
  const svc = getService();
  const apps = await svc.listApps();
  const runs = await getRunManager().list(session.id, 8);
  const provider = getConfig().ai.provider;
  return (
    <div className="flex flex-col gap-6">
      <div>
        <h1 className="flex items-center gap-2 text-2xl font-bold">
          <Bot className="size-6 text-primary" aria-hidden /> {a.title}
        </h1>
        <p className="text-sm text-muted-foreground">{a.subtitle}</p>
        <div className="mt-3 flex flex-col gap-2 text-sm">
          <p data-testid="offline-banner" className="flex items-start gap-2 rounded-lg border border-success/30 bg-success/10 p-3 text-success">
            <ShieldCheck className="mt-0.5 size-4 shrink-0" aria-hidden /> {a.offlineBanner}
          </p>
          <p data-testid="provider-status" data-provider={provider} className="flex items-start gap-2 rounded-lg border border-warning/30 bg-warning/10 p-3 text-warning">
            <FlaskConical className="mt-0.5 size-4 shrink-0" aria-hidden /> {provider === "mock" ? a.providerMock : a.providerDisabled}
          </p>
          <div className="flex items-center gap-2">
            <ModeBadge mode={svc.mode} />
          </div>
        </div>
      </div>

      <Card>
        <CardContent>
          {apps.ok ? <DiagnosticForm apps={apps.data.items.map((x) => x.name)} /> : <p role="alert" className="text-sm text-destructive">{fa.errors[apps.error.code] ?? fa.errors.internal}</p>}
        </CardContent>
      </Card>

      <Card>
        <CardHeader>
          <CardTitle className="text-base">{a.recent}</CardTitle>
        </CardHeader>
        <CardContent>
          {runs.length === 0 ? (
            <p className="text-sm text-muted-foreground" data-testid="no-runs">
              {a.noRuns}
            </p>
          ) : (
            <ul className="flex flex-col divide-y" data-testid="runs-list">
              {runs.map((r) => (
                <li key={r.id} data-run-status={r.status} className="flex flex-wrap items-center justify-between gap-2 py-3 text-sm">
                  <div className="min-w-0">
                    <p className="font-medium">
                      <bdi className="ltr-isolate">{r.app}</bdi> — {intentLabel[r.intent]}
                    </p>
                    <p className="text-xs text-muted-foreground">
                      {a.runStatus[r.status]} · {faDateTime(r.createdAt)}
                    </p>
                  </div>
                  <Link href={`/assistant/runs/${r.id}`} className="inline-flex min-h-11 items-center rounded-lg border px-3 hover:bg-muted">
                    {a.openRun}
                  </Link>
                </li>
              ))}
            </ul>
          )}
          <Freshness fetchedAt={new Date().toISOString()} className="mt-3" />
        </CardContent>
      </Card>
    </div>
  );
}
