"use client";

import { useState } from "react";
import { AlertTriangle, CheckCircle2, Loader2, Server } from "lucide-react";
import { runtimeUi as t } from "@/i18n/agent-fa";
import { faDateTime } from "@/lib/format";

export interface ServerRuntimeData {
  process: { startedAt: string };
  routing: string;
  manager: { createdAt: string; dataMode: string; provider: { kind: string; id: string; model: string | null }; allowed: string[] };
  config: { dataSource: string; allowedApps: string[] | null; liveDeploy: boolean; tokenPresent: boolean; ai: { provider: string; liveRequests: boolean; model: string | null; keyPresent: boolean; maxOutputTokens: number; maxTotalRequests: number | null } };
  consistent: boolean;
  problems: string[];
}

/** Pure view of /api/agent/runtime (testable without a browser). Shows what the running process uses — never a secret. */
export function ServerRuntimeView({ data }: { data: ServerRuntimeData }) {
  const c = data.config;
  return (
    <div className="flex flex-col gap-2 text-xs leading-6" data-testid="runtime-view" data-consistent={data.consistent ? "true" : "false"}>
      {data.consistent ? (
        <p className="flex items-center gap-1.5 text-success" role="status"><CheckCircle2 className="size-3.5" aria-hidden />{t.ok}</p>
      ) : (
        <div role="alert" className="rounded-lg border border-destructive/50 bg-destructive/10 p-2.5 text-destructive" data-testid="runtime-problems">
          <p className="mb-1 flex items-center gap-1.5 font-semibold"><AlertTriangle className="size-3.5" aria-hidden />{t.problems[data.problems[0] ?? ""] ?? t.problems.stale_code}</p>
          <ul className="list-disc ps-5">{data.problems.slice(1).map((p) => <li key={p}>{t.problems[p] ?? p}</li>)}</ul>
        </div>
      )}
      <dl className="grid gap-x-4 gap-y-1 sm:grid-cols-2">
        <Row k={t.rows.data}><span data-testid="runtime-data-source" data-source={c.dataSource}>{t.dataSource[c.dataSource] ?? c.dataSource}</span></Row>
        <Row k={t.rows.apps}>{c.allowedApps === null ? t.allApps : c.allowedApps.length === 0 ? t.noApps : <bdi className="ltr-isolate font-mono" data-testid="runtime-apps">{c.allowedApps.join(", ")}</bdi>}</Row>
        <Row k={t.rows.ai}>
          {t.aiProvider[c.ai.provider] ?? c.ai.provider}
          {c.ai.model && <> · <bdi className="ltr-isolate font-mono">{c.ai.model}</bdi></>}
          {c.ai.provider === "boxapi" && <> · {c.ai.keyPresent ? t.keyPresent : t.keyAbsent} · max {c.ai.maxOutputTokens}{c.ai.maxTotalRequests !== null ? ` · ≤ ${c.ai.maxTotalRequests}` : ""}</>}
        </Row>
        <Row k={t.rows.live}>{c.liveDeploy ? t.liveOn : t.liveOff}</Row>
        <Row k={t.rows.routing}><bdi className="ltr-isolate font-mono" data-testid="runtime-routing">{data.routing}</bdi></Row>
        <Row k={t.rows.started}>{faDateTime(data.process.startedAt)}</Row>
        <Row k={t.rows.managerBuilt}>{faDateTime(data.manager.createdAt)}</Row>
      </dl>
    </div>
  );
}

function Row({ k, children }: { k: string; children: React.ReactNode }) {
  return (
    <div className="min-w-0">
      <dt className="text-muted-foreground">{k}</dt>
      <dd className="min-w-0 break-words">{children}</dd>
    </div>
  );
}

/** Collapsed by default; reads the status only when opened (a GET with no Liara or model request). */
export function ServerRuntimePanel() {
  const [data, setData] = useState<ServerRuntimeData | null>(null);
  const [state, setState] = useState<"idle" | "loading" | "failed">("idle");
  async function load() {
    setState("loading");
    try {
      const r = await fetch("/api/agent/runtime", { cache: "no-store" });
      if (!r.ok) throw new Error("x");
      setData((await r.json()) as ServerRuntimeData);
      setState("idle");
    } catch {
      setState("failed");
    }
  }
  return (
    <details className="rounded-2xl border border-border/70 bg-card/50 px-4 py-2.5" data-testid="server-runtime-panel" onToggle={(e) => (e.currentTarget as HTMLDetailsElement).open && void load()}>
      <summary className="flex min-h-11 cursor-pointer items-center gap-2 py-2.5 text-xs font-semibold sm:text-sm">
        <Server className="size-4 text-muted-foreground" aria-hidden />
        {t.summary}
      </summary>
      <div className="pb-2 pt-1">
        {state === "loading" && <p className="flex items-center gap-2 text-xs text-muted-foreground" role="status"><Loader2 className="size-3.5 animate-spin motion-reduce:animate-none" aria-hidden />{t.loading}</p>}
        {state === "failed" && <p role="alert" className="text-xs text-destructive">{t.failed}</p>}
        {data && state !== "loading" && <ServerRuntimeView data={data} />}
      </div>
    </details>
  );
}
