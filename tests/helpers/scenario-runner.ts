import { analyze, type Analysis } from "@/server/diagnostics/engine";
import { collectEvidence } from "@/server/diagnostics/evidence";
import { EvidenceSet } from "@/server/diagnostics/evidence-set";
import { semanticsFor } from "@/server/diagnostics/semantics";
import type { AnyEvidence, Intent, Semantics } from "@/server/diagnostics/types";
import { buildService } from "@/server/liara/service";
import { NOW } from "./evidence-builder";
import { makeConfig } from "./live";

export const mockSvc = () => buildService(makeConfig(), { now: () => NOW });

export async function collect(app: string, intent: Intent, windowMinutes: 15 | 60 | 360 | 1440 = 60): Promise<EvidenceSet> {
  return collectEvidence(mockSvc(), { runId: "run_20260102040000_aabbccdd", app, intent, windowMinutes, now: () => NOW, sourceTimeoutMs: 5000, maxSources: 8 });
}

export async function runScenario(app: string, intent: Intent, over: { semantics?: Semantics; mutate?: (items: AnyEvidence[]) => AnyEvidence[] } = {}): Promise<{ evidence: EvidenceSet; analysis: Analysis }> {
  let evidence = await collect(app, intent);
  if (over.mutate) evidence = new EvidenceSet(over.mutate(structuredClone(evidence.items)));
  const analysis = analyze({ runId: "run_20260102040000_aabbccdd", intent, evidence, semantics: over.semantics ?? semanticsFor(app, "mock"), now: NOW });
  return { evidence, analysis };
}

/** Rewrites log lines / events of a collected evidence set (fixture mutation). */
export function mapLogs(fn: (msg: string) => string | null) {
  return (items: AnyEvidence[]): AnyEvidence[] =>
    items.map((i) => {
      if (i.source === "logs" && i.data) {
        const lines = i.data.lines.flatMap((l) => { const m = fn(l.message); return m === null ? [] : [{ ...l, message: m }]; });
        return { ...i, data: { ...i.data, lines } } as AnyEvidence;
      }
      return i;
    });
}
export function mapEvents(fn: (text: string) => string | null) {
  return (items: AnyEvidence[]): AnyEvidence[] =>
    items.map((i) => {
      if (i.source === "events" && i.data) {
        const rows = i.data.rows.flatMap((r) => { const m = fn(r.text); return m === null ? [] : [{ ...r, text: m }]; });
        return { ...i, data: { ...i.data, rows } } as AnyEvidence;
      }
      return i;
    });
}
export const compose = (...fns: ((i: AnyEvidence[]) => AnyEvidence[])[]) => (items: AnyEvidence[]) => fns.reduce((acc, f) => f(acc), items);

/** Keeps only log lines / events newer than `agoSec` seconds before NOW (fixture time-slicing). */
export function keepNewerThan(agoSec: number) {
  const cut = NOW - agoSec * 1000;
  return (items: AnyEvidence[]): AnyEvidence[] =>
    items.map((i) => {
      if (i.source === "logs" && i.data) return { ...i, data: { ...i.data, lines: i.data.lines.filter((l) => (l.time ? Date.parse(l.time) >= cut : true)) } } as AnyEvidence;
      if (i.source === "events" && i.data) return { ...i, data: { ...i.data, rows: i.data.rows.filter((r) => (r.time ? Date.parse(r.time) >= cut : true)) } } as AnyEvidence;
      return i;
    });
}
