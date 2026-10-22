"use client";

import { useEffect, useState } from "react";
import { CheckCircle2, FileArchive, Loader2, OctagonX, TriangleAlert, X } from "lucide-react";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { artifactState, formatBytes, sha256Hex, type ArtifactState } from "@/lib/artifact-binding";
import { liveUi } from "@/i18n/live-fa";
import { cn } from "@/lib/utils";

const b = liveUi.flow.binder;

/** What the live panel receives: the ONE selected archive plus its client-side verdict against the analysed digest. Never persisted; the server re-verifies every time. */
export interface ArtifactBinding {
  file: File | null;
  sha256: string | null;
  state: ArtifactState;
  /** true when the file was carried over from the upload that produced the analysis */
  fromUpload: boolean;
  set: (f: File | null) => void;
}

export const NO_ARTIFACT: ArtifactBinding = { file: null, sha256: null, state: "none", fromUpload: false, set: () => undefined };

export function useArtifactBinding(analysedPrefix: string, initial: File | null): ArtifactBinding {
  const [sel, setSel] = useState<{ file: File | null; fromUpload: boolean }>({ file: initial, fromUpload: !!initial });
  const [hashed, setHashed] = useState<{ file: File; sha256: string | null } | null>(null);
  useEffect(() => {
    const f = sel.file;
    if (!f) return;
    let alive = true;
    void sha256Hex(f).then((sha256) => alive && setHashed({ file: f, sha256 }));
    return () => {
      alive = false;
    };
  }, [sel.file]);
  const current = sel.file && hashed?.file === sel.file ? hashed : null;
  return { file: sel.file, sha256: current?.sha256 ?? null, state: artifactState(sel.file, current, analysedPrefix), fromUpload: sel.fromUpload, set: (f) => setSel({ file: f, fromUpload: false }) };
}

const STATE_STYLE: Record<ArtifactState, string> = {
  none: "border-border text-muted-foreground",
  hashing: "border-border text-muted-foreground",
  match: "border-primary/60 text-primary",
  mismatch: "border-destructive/60 text-destructive",
  unverifiable: "border-warning/60 text-warning",
};

/** The only ZIP input of the whole deployment page (besides the analysis upload). Preview, proposal and execution all use this selection. */
export function ArtifactBinder({ artifact }: { artifact: ArtifactBinding }) {
  const { file, state } = artifact;
  return (
    <section aria-labelledby="ab-h" className={cn("flex flex-col gap-2 rounded-lg border p-3", state === "mismatch" && "border-destructive/50")} data-testid="artifact-binder" data-state={state}>
      <h4 id="ab-h" className="flex items-center gap-2 text-sm font-semibold"><FileArchive className="size-4 text-primary" aria-hidden />{b.title}</h4>
      <p className="text-xs leading-6 text-muted-foreground">{b.help}</p>
      <label htmlFor="artifact-file" className="text-sm font-medium">{b.label}</label>
      <input id="artifact-file" type="file" accept=".zip,application/zip" data-testid="artifact-file" aria-describedby="artifact-status" onChange={(e) => artifact.set(e.target.files?.[0] ?? null)} className="block min-h-11 w-full rounded-lg border border-input bg-background p-2 text-sm file:me-3 file:rounded-md file:border-0 file:bg-secondary file:px-3 file:py-2" />
      <div id="artifact-status" role="status" aria-live="polite" data-testid="artifact-status" className="text-xs leading-6">
        {!file ? (
          <p className="text-muted-foreground">{b.none}</p>
        ) : (
          <div className="flex flex-col gap-1">
            <p className="flex flex-wrap items-center gap-2">
              <bdi className="ltr-isolate break-all font-mono" data-testid="artifact-name">{file.name}</bdi>
              <span className="text-muted-foreground">{formatBytes(file.size)}</span>
              <Badge variant="outline" className={STATE_STYLE[state]} data-testid="artifact-state-badge" data-state={state}>
                {state === "hashing" ? <Loader2 className="animate-spin motion-reduce:animate-none" aria-hidden /> : state === "match" ? <CheckCircle2 aria-hidden /> : state === "mismatch" ? <OctagonX aria-hidden /> : <TriangleAlert aria-hidden />}
                {b.states[state]}
              </Badge>
            </p>
            {artifact.sha256 && <p className="text-muted-foreground">{b.fingerprint}: <span className="ltr-isolate break-all font-mono" data-testid="artifact-sha">{artifact.sha256.slice(0, 16)}…</span></p>}
            {artifact.fromUpload && <p className="text-muted-foreground">{b.fromUpload}</p>}
            <Button type="button" variant="ghost" className="min-h-11 w-fit px-3" onClick={() => { artifact.set(null); const el = document.getElementById("artifact-file") as HTMLInputElement | null; if (el) el.value = ""; }} data-testid="artifact-clear"><X aria-hidden />{b.clear}</Button>
          </div>
        )}
      </div>
    </section>
  );
}
