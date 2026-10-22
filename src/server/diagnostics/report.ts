import { availabilityLabel, caveatText, confidenceLabel, findingText, hypothesisTitle, inferenceText, intentLabel, limitationText, sourceLabel, statusText, summaryText } from "@/i18n/diagnostics-fa";
import { redactText } from "../security/redact";
import type { Analysis } from "./engine";
import type { EvidenceSet } from "./evidence-set";
import { injectionSuspect } from "./signals";
import type { AnyEvidence, Availability, Confidence, Hypothesis, Intent, Recommendation, SourceKey } from "./types";
import type { DiagnosticLLMProvider, LLMContext, LLMErrorCode } from "./llm/provider";
import { NarrativeSchema } from "./llm/provider";

const safe = (s: unknown, max = 120): string => redactText(String(s ?? ""), { shareable: true, maxLength: max });

export interface EvidenceSummary {
  id: string;
  source: SourceKey;
  sourceFa: string;
  capability: string;
  app: string;
  mode: "mock" | "live";
  simulated: boolean;
  collectedAt: string;
  window: { from: string; to: string } | null;
  availability: Availability;
  availabilityFa: string;
  freshness: { state: string; newestObservation: string | null; ageSec: number | null };
  verification: string;
  errorCode?: string;
  notes: string[];
  /** Bounded, sanitised facts about the evidence (never raw API data, never whole logs). */
  summary: Record<string, unknown>;
  /** Excerpts cited by findings (shareable-redacted, ≤ 200 chars each). */
  excerpts: string[];
}

export type NarrativeStatus = "ok" | "unavailable" | "disabled" | "timeout" | "error" | "invalid" | "cancelled";
export interface ReportNarrative {
  status: NarrativeStatus;
  source: "mock-simulated" | "none";
  textFa?: string;
  citedEvidenceIds: string[];
  providerId?: string;
}

export interface ReportItem {
  id: string;
  textFa: string;
  evidenceIds: string[];
  excerpts: string[];
}

export interface DiagnosticReport {
  schemaVersion: 1;
  runId: string;
  app: string;
  intent: Intent;
  intentFa: string;
  mode: "mock" | "live";
  simulated: boolean;
  generatedAt: string;
  summary: { status: string; statusFa: string; primaryKey: string | null; overallConfidence: Confidence; overallConfidenceFa: string; textFa: string };
  hypotheses: {
    key: string;
    titleFa: string;
    confidence: Confidence;
    confidenceFa: string;
    ruleIds: string[];
    observations: ReportItem[];
    inferences: ReportItem[];
    contradictions: { code: string; textFa: string; withKey: string; evidenceIds: string[] }[];
    evidenceIds: string[];
    missing: { code: string; textFa: string }[];
    limitations: { code: string; textFa: string }[];
    merged: string[];
  }[];
  recommendations: Recommendation[];
  evidence: EvidenceSummary[];
  missingEvidence: { source: SourceKey; sourceFa: string; availability: Availability; availabilityFa: string; evidenceId: string }[];
  limitations: { code: string; textFa: string }[];
  caveats: { code: string; textFa: string }[];
  narrative: ReportNarrative;
}

function summarize(e: AnyEvidence): Record<string, unknown> {
  if (!e.data) return {};
  switch (e.source) {
    case "app": {
      const d = e.data as import("./types").EvidenceDataMap["app"];
      return { platform: safe(d.platform, 40), status: safe(d.status, 60), scale: d.scale, planId: safe(d.planId, 40), isDeployed: d.isDeployed, envKeyCount: d.envKeys.length, envKeys: d.envKeys.slice(0, 60) };
    }
    case "runtime": {
      const d = e.data as import("./types").EvidenceDataMap["runtime"];
      const a = d.assessment;
      return { enabled: a.enabled, runtime: a.runtime, runtimeIsHeuristic: a.runtimeIsHeuristic, appletCount: a.appletCount, byState: a.byState.map((s) => ({ raw: safe(s.raw, 40), count: s.count, class: s.class })), failureReasons: a.failureReasons.map((r) => safe(r, 160)) };
    }
    case "releases": {
      const d = e.data as import("./types").EvidenceDataMap["releases"];
      return { total: d.total, currentRelease: safe(d.currentRelease, 60), recent: d.releases.slice(0, 5).map((r) => ({ tag: safe(r.tag, 40), state: safe(r.state, 40), createdAt: r.createdAt, finishedAt: r.finishedAt })) };
    }
    case "events": {
      const d = e.data as import("./types").EvidenceDataMap["events"];
      const times = d.rows.map((r) => r.time).filter((t): t is string => !!t).sort();
      return { rowCount: d.rows.length, truncated: d.truncated, oldest: times[0] ?? null, newest: times.at(-1) ?? null };
    }
    case "logs": {
      const d = e.data as import("./types").EvidenceDataMap["logs"];
      const times = d.lines.map((l) => l.time).filter((t): t is string => !!t).sort();
      return { lineCount: d.lines.length, truncated: d.truncated, source: d.source, oldest: times[0] ?? null, newest: times.at(-1) ?? null };
    }
    case "cpu":
    case "memory": {
      const d = e.data as import("./types").MetricEvidenceData;
      return { unit: d.unit, unitNote: d.unit === null ? "unverified" : "verified", schema: d.schema, series: d.series.map((s) => ({ applet: safe(s.applet, 60), count: s.count, stepSeconds: s.stepSeconds, gaps: s.gaps, last: s.lastObservation, min: s.min, max: s.max })) };
    }
  }
}

export function toEvidenceSummary(e: AnyEvidence, excerpts: string[]): EvidenceSummary {
  return {
    id: e.id, source: e.source, sourceFa: sourceLabel[e.source], capability: e.capability, app: e.app, mode: e.mode, simulated: e.simulated, collectedAt: e.collectedAt, window: e.window,
    availability: e.availability, availabilityFa: availabilityLabel[e.availability], freshness: e.freshness, verification: e.verification, errorCode: e.errorCode, notes: e.notes,
    summary: summarize(e), excerpts: excerpts.slice(0, 5),
  };
}

function hypothesisReport(h: Hypothesis): DiagnosticReport["hypotheses"][number] {
  const item = (f: import("./types").Finding, text: string): ReportItem => ({ id: f.id, textFa: text, evidenceIds: f.evidenceIds, excerpts: f.excerpts });
  return {
    key: h.key,
    titleFa: hypothesisTitle(h.key),
    confidence: h.confidence,
    confidenceFa: confidenceLabel[h.confidence],
    ruleIds: h.ruleIds,
    observations: h.observations.map((f) => item(f, findingText(f))),
    inferences: h.inferences.map((f) => item(f, inferenceText(f))),
    contradictions: h.contradictions.map((c) => ({ code: c.code, textFa: limitationText(c.code), withKey: String(c.withKey), evidenceIds: c.evidenceIds })),
    evidenceIds: h.evidenceIds,
    missing: h.missing.map((code) => ({ code, textFa: limitationText(code) })),
    limitations: h.limitations.map((code) => ({ code, textFa: limitationText(code) })),
    merged: h.merged,
  };
}

export function llmContext(args: { app: string; intent: Intent; analysis: Analysis; simulated: boolean }): LLMContext {
  const { diagnosis } = args.analysis;
  return {
    intent: args.intent,
    app: args.app,
    simulatedData: args.simulated,
    status: diagnosis.status,
    overallConfidence: diagnosis.overallConfidence,
    hypotheses: diagnosis.hypotheses.map((h) => ({ key: h.key, titleFa: hypothesisTitle(h.key), confidence: h.confidence, evidenceIds: h.evidenceIds, observationsFa: h.observations.map(findingText), limitationsFa: h.limitations.map(limitationText) })),
    missingFa: diagnosis.missingEvidence.map((m) => `${sourceLabel[m.source]}: ${availabilityLabel[m.availability]}.`),
    // untrusted text goes in a separate, clearly named field; capped and already shareable-redacted
    untrustedExcerpts: diagnosis.hypotheses.flatMap((h) => [...h.observations, ...h.inferences].flatMap((f) => f.excerpts.slice(0, 2).map((text) => ({ evidenceId: f.evidenceIds[0] ?? "", text })))).slice(0, 6),
  };
}

/** Calls the (offline) provider with a hard timeout and validates the output. Failure never blocks the deterministic report. */
export async function buildNarrative(provider: DiagnosticLLMProvider, ctx: LLMContext, knownEvidenceIds: Set<string>, opts: { timeoutMs: number; signal?: AbortSignal }): Promise<ReportNarrative> {
  const source = provider.simulated ? ("mock-simulated" as const) : ("none" as const);
  if (provider.kind === "disabled") return { status: "disabled", source: "none", citedEvidenceIds: [], providerId: provider.id };
  const fail = (status: NarrativeStatus): ReportNarrative => ({ status, source, citedEvidenceIds: [], providerId: provider.id });
  let timer: ReturnType<typeof setTimeout> | undefined;
  try {
    const raced = await Promise.race([
      provider.summarize(ctx, opts),
      new Promise<{ ok: false; error: LLMErrorCode }>((resolve) => {
        timer = setTimeout(() => resolve({ ok: false, error: "timeout" }), opts.timeoutMs);
      }),
    ]);
    if (!raced.ok) return fail(raced.error === "timeout" ? "timeout" : raced.error === "provider_disabled" ? "disabled" : raced.error === "cancelled" ? "cancelled" : "error");
    const parsed = NarrativeSchema.safeParse(raced); // strips any extra fields (e.g. forged "actions")
    if (!parsed.success) return fail("invalid");
    const { narrativeFa, citedEvidenceIds } = parsed.data;
    if (citedEvidenceIds.some((id) => !knownEvidenceIds.has(id))) return fail("invalid"); // citation integrity applies to LLM text too
    if (injectionSuspect(narrativeFa)) return fail("invalid"); // never surface instruction-like output
    return { status: "ok", source, textFa: safe(narrativeFa, 1500), citedEvidenceIds, providerId: provider.id };
  } catch {
    return fail("error");
  } finally {
    if (timer) clearTimeout(timer);
  }
}

export function buildReport(args: { runId: string; app: string; intent: Intent; evidence: EvidenceSet; analysis: Analysis; narrative: ReportNarrative; now: number }): DiagnosticReport {
  const { analysis, evidence } = args;
  const d = analysis.diagnosis;
  const excerptsById = new Map<string, string[]>();
  for (const h of d.hypotheses) for (const f of [...h.observations, ...h.inferences]) for (const id of f.evidenceIds) excerptsById.set(id, [...new Set([...(excerptsById.get(id) ?? []), ...f.excerpts])]);
  const primary = d.hypotheses[0];
  const mode = evidence.items[0]?.mode ?? "mock";
  return {
    schemaVersion: 1,
    runId: args.runId,
    app: args.app,
    intent: args.intent,
    intentFa: intentLabel[args.intent],
    mode,
    simulated: mode === "mock",
    generatedAt: new Date(args.now).toISOString(),
    summary: { status: d.status, statusFa: statusText(d.status), primaryKey: primary && primary.key !== "insufficient_evidence" ? primary.key : null, overallConfidence: d.overallConfidence, overallConfidenceFa: confidenceLabel[d.overallConfidence], textFa: summaryText({ status: d.status, primary, overall: d.overallConfidence, intent: args.intent, missingCount: d.missingEvidence.length }) },
    hypotheses: d.hypotheses.map(hypothesisReport),
    recommendations: analysis.recommendations,
    evidence: evidence.items.map((e) => toEvidenceSummary(e, excerptsById.get(e.id) ?? [])),
    missingEvidence: d.missingEvidence.map((m) => ({ ...m, sourceFa: sourceLabel[m.source], availabilityFa: availabilityLabel[m.availability] })),
    limitations: d.limitations.map((code) => ({ code, textFa: limitationText(code) })),
    caveats: d.caveats.map((code) => ({ code, textFa: caveatText[code] ?? code })),
    narrative: args.narrative,
  };
}
