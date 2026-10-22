import Link from "next/link";
import { notFound } from "next/navigation";
import type { Metadata } from "next";
import { ChevronRight } from "lucide-react";
import { RunView } from "@/components/run-view";
import { ModeBadge } from "@/components/mode-badge";
import { fa } from "@/i18n/fa";
import { intentLabel } from "@/i18n/diagnostics-fa";
import { requireSession } from "@/server/auth-dal";
import { getRunManager } from "@/server/diagnostics/runtime";

export const metadata: Metadata = { title: fa.assistant.report.title };
export const dynamic = "force-dynamic";

export default async function RunPage({ params }: { params: Promise<{ id: string }> }) {
  const session = await requireSession();
  const { id } = await params;
  if (!/^run_[0-9]{14}_[0-9a-f]{8}$/.test(id)) notFound();
  const run = await getRunManager().get(id, session.id); // other sessions' runs are indistinguishable from missing ones
  if (!run) notFound();
  return (
    <div className="flex flex-col gap-6">
      <div>
        <Link href="/assistant" className="inline-flex min-h-11 items-center gap-1 text-sm text-muted-foreground hover:text-foreground">
          <ChevronRight className="size-4" aria-hidden />
          {fa.assistant.backToAssistant}
        </Link>
        <h1 className="flex flex-wrap items-center gap-3 text-2xl font-bold">
          <bdi className="ltr-isolate break-all">{run.app}</bdi>
          <ModeBadge mode={run.mode} />
        </h1>
        <p className="text-sm text-muted-foreground">{intentLabel[run.intent]}</p>
      </div>
      <RunView initial={run} />
    </div>
  );
}
