import type { Metadata } from "next";
import { Ban, CircleCheck, CircleDashed, CircleHelp, CircleSlash, CircleX, FlaskConical, ShieldAlert, TriangleAlert } from "lucide-react";
import { Freshness } from "@/components/freshness";
import { ModeBadge } from "@/components/mode-badge";
import { RefreshButton } from "@/components/refresh-button";
import { Badge } from "@/components/ui/badge";
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from "@/components/ui/card";
import { errorMessage, fa } from "@/i18n/fa";
import { faDateTime, faNumber } from "@/lib/format";
import { requireSession } from "@/server/auth-dal";
import type { CapabilityHealth, VerificationStatus } from "@/server/liara/capabilities";
import { getService } from "@/server/liara/service";

export const metadata: Metadata = { title: fa.diag.title };
export const dynamic = "force-dynamic";

const verificationStyle: Record<VerificationStatus, { cls: string; Icon: typeof CircleCheck }> = {
  LIVE_VERIFIED: { cls: "border-success/50 text-success", Icon: CircleCheck },
  DOCUMENTED_UNVERIFIED: { cls: "text-muted-foreground", Icon: CircleHelp },
  CLI_ONLY_UNVERIFIED: { cls: "border-warning/50 text-warning", Icon: CircleHelp },
  UNAVAILABLE: { cls: "border-warning/50 text-warning", Icon: CircleSlash },
  ACCESS_DENIED: { cls: "border-destructive/50 text-destructive", Icon: ShieldAlert },
  CONTRACT_MISMATCH: { cls: "border-destructive/50 text-destructive", Icon: CircleX },
};
const healthStyle: Record<CapabilityHealth, { cls: string; Icon: typeof CircleCheck }> = {
  ok: { cls: "text-success", Icon: CircleCheck },
  failing: { cls: "border-destructive/50 text-destructive", Icon: CircleX },
  not_probed: { cls: "text-muted-foreground", Icon: CircleDashed },
  simulated: { cls: "border-warning/50 text-warning", Icon: FlaskConical },
  disabled: { cls: "text-muted-foreground", Icon: Ban },
  no_content: { cls: "border-warning/50 text-warning", Icon: CircleHelp },
};

const connTone: Record<string, string> = {
  connected: "text-success",
  simulated: "text-warning",
  degraded: "text-warning",
  stale: "text-warning",
  unknown: "text-muted-foreground",
  auth_failure: "text-destructive",
  endpoint_unavailable: "text-destructive",
  contract_mismatch: "text-destructive",
  unreachable: "text-destructive",
};

export default async function DiagnosticsPage() {
  await requireSession();
  const d = await getService().diagnostics({ probe: true });
  const live = d.mode === "live";

  return (
    <div className="flex flex-col gap-6">
      <div className="flex flex-wrap items-end justify-between gap-3">
        <div>
          <h1 className="text-2xl font-bold">{fa.diag.title}</h1>
          <p className="text-sm text-muted-foreground">{fa.diag.subtitle}</p>
          <Freshness fetchedAt={d.generatedAt} className="mt-1" />
        </div>
        <RefreshButton />
      </div>

      <Card>
        <CardContent>
          <dl className="grid grid-cols-1 gap-x-6 gap-y-4 text-sm sm:grid-cols-2 lg:grid-cols-3" data-testid="diag-summary">
            <Item label={fa.diag.mode}>
              <ModeBadge mode={d.mode} />
            </Item>
            <Item label={fa.diag.connectivity}>
              <span data-testid="diag-connectivity" data-state={d.connectivity} className={`font-medium ${connTone[d.connectivity]}`}>
                {fa.diag.connectivityLabels[d.connectivity]}
              </span>
            </Item>
            <Item label={fa.diag.lastSuccess}>
              {live ? (
                d.lastSuccessAt ? (
                  <span data-testid="diag-last-success" data-age={d.lastSuccessAgeSec ?? ""}>
                    {faDateTime(d.lastSuccessAt)}
                    {d.connectivity === "stale" && d.lastSuccessAgeSec !== null && <span className="ms-2 text-warning">{fa.diag.staleNote(d.lastSuccessAgeSec)}</span>}
                  </span>
                ) : (
                  fa.diag.never
                )
              ) : (
                "—"
              )}
            </Item>
            <Item label={fa.diag.host}>
              <span className="ltr-isolate">{d.host ?? "—"}</span>
            </Item>
            <Item label={fa.diag.token}>{live ? (d.tokenConfigured ? fa.diag.tokenSet : fa.diag.tokenUnset) : "—"}</Item>
            <Item label={fa.diag.team}>{d.teamScoped ? fa.diag.teamOn : fa.diag.teamOff}</Item>
            <Item label={fa.diag.allowlist}>{faNumber(d.allowlistSize)}</Item>
            <Item label={fa.diag.logsStrategy}>
              <span className="ltr-isolate">{d.logsStrategy}</span>
            </Item>
            <Item label={fa.diag.undocumented}>{d.undocumentedEnabled ? fa.diag.enabled : fa.diag.disabled}</Item>
          </dl>
          <p className="mt-4 text-xs text-muted-foreground">{fa.diag.probe}</p>
          {live && <p className="mt-1 text-xs text-muted-foreground">{fa.diag.verifiedCount(d.verifiedCount, d.capabilities.length)}</p>}
        </CardContent>
      </Card>

      {d.issues.length > 0 && (
        <Card>
          <CardHeader>
            <CardTitle className="text-base">{fa.diag.issues}</CardTitle>
          </CardHeader>
          <CardContent>
            <ul className="flex flex-col gap-2 text-sm" data-testid="diag-issues">
              {d.issues.map((i) => (
                <li key={i.capability} data-kind={i.kind} className="flex flex-wrap items-center gap-2">
                  <TriangleAlert className="size-4 text-destructive" aria-hidden />
                  <span>{fa.diag.capLabels[i.capability] ?? i.capability}:</span>
                  <Badge variant="outline">{fa.diag.issueLabels[i.kind]}</Badge>
                  <span className="text-xs text-muted-foreground">{errorMessage(i.code)}</span>
                </li>
              ))}
            </ul>
          </CardContent>
        </Card>
      )}

      <Card>
        <CardHeader>
          <CardTitle className="text-base">{fa.diag.capabilities}</CardTitle>
          <CardDescription>
            {fa.diag.contract}: {fa.diag.contractLabels.documented} / {fa.diag.contractLabels.observed}
          </CardDescription>
        </CardHeader>
        <CardContent>
          <ul className="flex flex-col divide-y" data-testid="diag-capabilities">
            {d.capabilities.map((c) => {
              const v = verificationStyle[c.verification];
              const h = healthStyle[c.health];
              return (
                <li key={c.id} className="flex flex-col gap-2 py-3 sm:flex-row sm:items-center sm:justify-between" data-capability={c.id} data-verification={c.verification} data-health={c.health}>
                  <div className="min-w-0">
                    <p className="font-medium">{fa.diag.capLabels[c.id] ?? c.id}</p>
                    <p className="ltr-isolate text-xs text-muted-foreground">{c.endpoint}</p>
                    {c.lastErrorCode && (
                      <p className="mt-1 text-xs text-destructive">
                        {fa.diag.lastError}: {errorMessage(c.lastErrorCode)}
                      </p>
                    )}
                    {c.verifiedAt && (
                      <p className="mt-1 text-xs text-muted-foreground">
                        {fa.diag.verifiedAt}: {faDateTime(c.verifiedAt)}
                      </p>
                    )}
                  </div>
                  <div className="flex flex-wrap items-center gap-2">
                    <Badge variant="outline" className={v.cls} title={fa.diag.verificationHelp[c.verification]}>
                      <v.Icon aria-hidden />
                      {fa.diag.verificationLabels[c.verification]}
                    </Badge>
                    <Badge variant="outline" className={h.cls}>
                      <h.Icon aria-hidden />
                      {fa.diag.healthLabels[c.health]}
                    </Badge>
                  </div>
                </li>
              );
            })}
          </ul>
          <details className="mt-4 rounded-lg border p-3 text-xs text-muted-foreground">
            <summary className="min-h-8 cursor-pointer text-sm font-medium text-foreground">{fa.diag.legendTitle}</summary>
            <dl className="mt-2 flex flex-col gap-2">
              {(Object.keys(fa.diag.verificationLabels) as VerificationStatus[]).map((k) => (
                <div key={k}>
                  <dt className="font-medium text-foreground">{fa.diag.verificationLabels[k]}</dt>
                  <dd>{fa.diag.verificationHelp[k]}</dd>
                </div>
              ))}
            </dl>
          </details>
        </CardContent>
      </Card>

      <Card>
        <CardHeader>
          <CardTitle className="text-base">{fa.diag.notAvailable}</CardTitle>
        </CardHeader>
        <CardContent>
          <ul className="flex flex-col gap-2 text-sm" data-testid="diag-not-available">
            {d.notAvailable.map((n) => (
              <li key={n.id} className="flex items-start gap-2">
                <TriangleAlert className="mt-0.5 size-4 shrink-0 text-warning" aria-hidden />
                {fa.diag.naLabels[n.id] ?? n.id}
              </li>
            ))}
          </ul>
        </CardContent>
      </Card>
    </div>
  );
}

function Item({ label, children }: { label: string; children: React.ReactNode }) {
  return (
    <div className="flex flex-col gap-1 rounded-xl bg-card/60 border border-border/60 p-3.5 backdrop-blur-xs shadow-2xs">
      <dt className="text-xs font-semibold text-muted-foreground">{label}</dt>
      <dd className="mt-0.5 text-sm font-medium text-foreground">{children}</dd>
    </div>
  );
}
