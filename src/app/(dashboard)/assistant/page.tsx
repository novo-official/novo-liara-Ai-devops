import Link from "next/link";
import type { Metadata } from "next";
import { Bot, FlaskConical, ShieldCheck } from "lucide-react";
import { AiProviderBadge } from "@/components/ai-provider-badge";
import { DiagnosticForm } from "@/components/diagnostic-form";
import { Freshness } from "@/components/freshness";
import { ModeBadge } from "@/components/mode-badge";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { fa } from "@/i18n/fa";
import { intentLabel } from "@/i18n/diagnostics-fa";
import { faDateTime } from "@/lib/format";
import { requireSession } from "@/server/auth-dal";
import { getAiStatus } from "@/server/ai/status";
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
  const ai = getAiStatus(getConfig());
  return (
    <div className="flex flex-col gap-6">
      <div>
        <h1 className="flex items-center gap-2 text-2xl font-bold">
          <Bot className="size-6 text-primary" aria-hidden /> {a.title}
        </h1>
        <p className="text-sm text-muted-foreground">{a.subtitle}</p>
        <div className="mt-4 flex flex-col gap-2.5 text-xs sm:text-sm">
          {ai.enabled ? (
            <AiProviderBadge ai={ai} />
          ) : (
            <>
              <p data-testid="offline-banner" className="flex items-center gap-3 rounded-2xl border border-success/30 bg-success/10 px-4 py-3 text-success backdrop-blur-md shadow-xs">
                <ShieldCheck className="size-4.5 shrink-0" aria-hidden /> <span>{a.offlineBanner}</span>
              </p>
              <p data-testid="provider-status" data-provider={provider} className="flex items-center gap-3 rounded-2xl border border-warning/30 bg-warning/10 px-4 py-3 text-warning backdrop-blur-md shadow-xs">
                <FlaskConical className="size-4.5 shrink-0" aria-hidden /> <span>{provider === "mock" ? a.providerMock : a.providerDisabled}</span>
              </p>
            </>
          )}
          <div className="flex items-center gap-2 pt-1">
            <ModeBadge mode={svc.mode} />
          </div>
        </div>
      </div>

      <Card>
        <CardContent className="p-5">
          {apps.ok ? <DiagnosticForm apps={apps.data.items.map((x) => x.name)} /> : <p role="alert" className="text-sm text-destructive">{fa.errors[apps.error.code] ?? fa.errors.internal}</p>}
        </CardContent>
      </Card>

      <Card>
        <CardHeader className="border-b border-border/40 pb-3">
          <CardTitle className="text-sm sm:text-base font-bold text-foreground">{a.recent}</CardTitle>
        </CardHeader>
        <CardContent className="p-5">
          {runs.length === 0 ? (
            <div className="flex flex-col items-center justify-center gap-2 rounded-xl border border-dashed border-border/70 p-8 text-center text-sm text-muted-foreground" data-testid="no-runs">
              <Bot className="size-6 text-muted-foreground/40" aria-hidden />
              <p>{a.noRuns}</p>
            </div>
          ) : (
            <ul className="flex flex-col gap-2.5" data-testid="runs-list">
              {runs.map((r) => (
                <li key={r.id} data-run-status={r.status} className="flex flex-wrap items-center justify-between gap-3 rounded-xl border border-border/60 bg-muted/20 hover:bg-muted/35 p-3.5 text-xs sm:text-sm transition-all duration-200">
                  <div className="min-w-0">
                    <p className="font-semibold text-foreground">
                      <bdi className="ltr-isolate">{r.app}</bdi> — {intentLabel[r.intent]}
                    </p>
                    <p className="text-xs text-muted-foreground mt-0.5 font-mono">
                      {a.runStatus[r.status]} · {faDateTime(r.createdAt)}
                    </p>
                  </div>
                  <Link href={`/assistant/runs/${r.id}`} className="inline-flex min-h-9 items-center rounded-lg bg-secondary/80 hover:bg-primary border border-border/60 hover:border-primary px-3 text-xs font-semibold text-secondary-foreground hover:text-primary-foreground transition-all duration-200 shadow-xs">
                    {a.openRun}
                  </Link>
                </li>
              ))}
            </ul>
          )}
          <Freshness fetchedAt={new Date().toISOString()} className="mt-4" />
        </CardContent>
      </Card>
    </div>
  );
}
