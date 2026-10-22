import type { EvidenceSet } from "./evidence-set";
import { injectionSuspect } from "./signals";
import type { Confidence, Contradiction, Diagnosis, Finding, Hypothesis, HypothesisKey, Intent, Semantics } from "./types";

/**
 * Deterministic diagnosis aggregation (documented in docs/DIAGNOSTIC_ENGINE.md). No probabilities: confidence is one of
 * HIGH / MEDIUM / LOW / INSUFFICIENT_EVIDENCE, derived by explicit rules from evidence strength, corroboration and conflicts.
 *
 * Confidence rules (per hypothesis):
 *   observation, strong   → HIGH if backed by ≥2 independent evidence sources, or by an explicit unambiguous signal
 *                           (explicit OOM signal; a missing variable that is named AND absent from the configured keys); else MEDIUM
 *   observation, moderate → MEDIUM          observation, weak → LOW
 *   inference,   strong|moderate → MEDIUM   (correlation / reasoning never exceeds MEDIUM)      inference, weak → LOW
 *   hard caps: contradictions → ≤ MEDIUM; memory_growth_unverified / isolated_restart → LOW
 */

const RANK: Record<Confidence, number> = { HIGH: 3, MEDIUM: 2, LOW: 1, INSUFFICIENT_EVIDENCE: 0 };
export const rankOf = (c: Confidence) => RANK[c];
const cap = (c: Confidence, max: Confidence): Confidence => (RANK[c] > RANK[max] ? max : c);

const STRENGTH_RANK = { strong: 3, moderate: 2, weak: 1 } as const;
const sourceOf = (id: string) => id.slice(id.lastIndexOf("/") + 1);

const DB_KEYS: HypothesisKey[] = ["db_connection_refused", "db_connection_timeout", "db_dns_failure", "db_authentication_failure"];
const isDb = (k: string): k is HypothesisKey => (DB_KEYS as string[]).includes(k);

/** Limitation codes that mean "information we do not have" (shown as missing evidence). */
const MISSING_CODES = new Set([
  "memory_units_unverified", "memory_limit_unknown", "cpu_units_unverified", "cpu_limit_unknown", "no_http_error_rate", "no_http_probe",
  "no_pre_release_baseline", "env_keys_unavailable", "logs_truncated", "release_state_vocabulary_unverified", "no_timeline_evidence",
  "runtime_restarting_without_timestamps", "release_outside_window", "raw_values_only",
]);

export interface AggregateInput {
  findings: Finding[];
  detectorLimitations: string[];
  evidence: EvidenceSet;
  intent: Intent;
  semantics: Semantics;
}

/** Group findings by hypothesis, keeping the strongest and unioning evidence/excerpts/limitations (dedupe overlapping findings). */
export function dedupe(findings: Finding[]): Finding[] {
  const byKey = new Map<string, Finding>();
  for (const f of findings) {
    const cur = byKey.get(f.hypothesis);
    if (!cur) {
      byKey.set(f.hypothesis, { ...f, evidenceIds: [...new Set(f.evidenceIds)], excerpts: [...f.excerpts], limitations: [...new Set(f.limitations)] });
      continue;
    }
    const stronger = STRENGTH_RANK[f.strength] > STRENGTH_RANK[cur.strength] ? f : cur;
    byKey.set(f.hypothesis, {
      ...stronger,
      kind: cur.kind === "observation" || f.kind === "observation" ? "observation" : "inference",
      evidenceIds: [...new Set([...cur.evidenceIds, ...f.evidenceIds])],
      excerpts: [...new Set([...cur.excerpts, ...f.excerpts])].slice(0, 3),
      limitations: [...new Set([...cur.limitations, ...f.limitations])],
      times: [...(cur.times ?? []), ...(f.times ?? [])],
    });
  }
  return [...byKey.values()];
}

function baseConfidence(f: Finding): Confidence {
  if (f.hypothesis === "memory_growth_unverified" || f.hypothesis === "isolated_restart") return "LOW";
  if (f.hypothesis === "insufficient_evidence") return "INSUFFICIENT_EVIDENCE";
  const sources = new Set(f.evidenceIds.map(sourceOf));
  if (f.kind === "observation") {
    if (f.strength === "strong") {
      const explicit =
        (f.hypothesis === "oom_kill" && f.data.via === "explicit_oom_signal") ||
        (f.hypothesis === "missing_configuration" && Array.isArray(f.data.absent) && f.data.absent.length > 0);
      return explicit || sources.size >= 2 ? "HIGH" : "MEDIUM";
    }
    return f.strength === "moderate" ? "MEDIUM" : "LOW";
  }
  return f.strength === "weak" ? "LOW" : "MEDIUM";
}

/** Share of restart cycles that have a matching `times` entry within `windowMs` BEFORE the restart. null = cannot be checked. */
export function precedingShare(cycles: number[] | undefined, causeTimes: number[] | undefined, windowMs = 120_000): number | null {
  if (!cycles?.length || !causeTimes?.length) return null;
  const hit = cycles.filter((c) => causeTimes.some((t) => t <= c + 30_000 && c - t <= windowMs)).length;
  return hit / cycles.length;
}

interface Draft {
  key: string;
  base: Confidence;
  observations: Finding[];
  inferences: Finding[];
  contradictions: Contradiction[];
  ruleIds: string[];
  merged: string[];
  confidence?: Confidence;
}

const synth = (id: string, hypothesis: HypothesisKey, strength: Finding["strength"], evidenceIds: string[], data: Finding["data"], limitations: string[] = []): Finding => ({ id, detector: "aggregator", hypothesis, kind: "inference", strength, evidenceIds, excerpts: [], data, limitations });

export function aggregate(input: AggregateInput): Diagnosis {
  const { evidence, intent } = input;
  const findings = dedupe(input.findings);
  const byKey = new Map(findings.map((f) => [f.hypothesis as string, f]));
  const drafts = new Map<string, Draft>();
  const draft = (f: Finding): Draft => ({ key: f.hypothesis, base: baseConfidence(f), observations: f.kind === "observation" ? [f] : [], inferences: f.kind === "inference" ? [f] : [], contradictions: [], ruleIds: [`obs:${f.hypothesis}`], merged: [] });
  for (const f of findings) drafts.set(f.hypothesis, draft(f));

  // ---------- R-LOOP: merge a crash loop with the best-supported cause ----------
  const loop = byKey.get("crash_loop");
  if (loop) {
    const loopConf = baseConfidence(loop);
    const dbCandidates = findings
      .filter((f) => isDb(f.hypothesis) && STRENGTH_RANK[f.strength] >= 2)
      .map((f) => ({ f, share: precedingShare(loop.times, f.times) }))
      .filter((c) => c.share === null || c.share > 0)
      .sort((a, b) => (b.share ?? 0.01) - (a.share ?? 0.01) || Number(b.f.data.count) - Number(a.f.data.count));
    const oom = byKey.get("oom_kill");
    const cfg = byKey.get("missing_configuration");
    let cause: Finding | undefined;
    let rule = "";
    let confidence: Confidence = "MEDIUM";
    let share: number | null = null;
    if (oom) {
      cause = oom;
      rule = "R-LOOP-OOM";
      confidence = oom.data.via === "explicit_oom_signal" && loopConf === "HIGH" ? "HIGH" : "MEDIUM";
    } else if (cfg && STRENGTH_RANK[cfg.strength] >= 2) {
      cause = cfg;
      rule = "R-LOOP-CONFIG";
      confidence = baseConfidence(cfg) === "HIGH" && loopConf === "HIGH" ? "HIGH" : "MEDIUM";
    } else if (dbCandidates.length) {
      cause = dbCandidates[0]!.f;
      share = dbCandidates[0]!.share;
      rule = "R-LOOP-DB";
      if (share === null) confidence = "MEDIUM";
      else if (share >= 0.5) confidence = loopConf === "HIGH" && Number(cause.data.count) >= 3 ? "HIGH" : "MEDIUM";
      else confidence = "LOW";
    }
    if (cause) {
      const key = `restart_loop_${cause.hypothesis}`;
      const link = synth(`aggregator:${key}`, cause.hypothesis, share !== null && share >= 0.5 ? "strong" : "moderate", [...new Set([...loop.evidenceIds, ...cause.evidenceIds])], { relation: "restart_loop_with_cause", precedingShare: share, cycles: Number(loop.data.cycles) }, share === null ? ["cause_ordering_unverifiable"] : ["correlation_not_causation"]);
      drafts.delete("crash_loop");
      drafts.delete(cause.hypothesis);
      drafts.set(key, { key, base: confidence, observations: [loop, cause], inferences: [link], contradictions: [], ruleIds: [rule], merged: ["crash_loop", cause.hypothesis], confidence });
    }
  }

  // ---------- R-HTTP: attach possible-relation inferences to http_500 ----------
  const http = drafts.get("http_500");
  if (http) {
    const related = [...drafts.keys()].filter((k) => k !== "http_500" && (isDb(k) || k === "missing_configuration" || k.startsWith("restart_loop_") || k === "oom_kill"));
    if (related.length) {
      http.inferences.push(synth("aggregator:http_500:related", "http_500", "weak", findings.find((f) => f.hypothesis === "http_500")!.evidenceIds, { relatedHypotheses: related }, ["correlation_not_causation"]));
      http.ruleIds.push("R-HTTP-RELATED");
    }
  }

  // ---------- contradictions ----------
  // (a) several database failure categories at once cannot all be THE cause of one failure
  const dbAll = findings.filter((f) => isDb(f.hypothesis) && STRENGTH_RANK[f.strength] >= 2).map((f) => f.hypothesis);
  if (new Set(dbAll).size >= 2) {
    for (const d of drafts.values()) {
      const own = d.observations.filter((f) => isDb(f.hypothesis)).map((f) => f.hypothesis as string);
      if (own.length === 0) continue;
      for (const other of dbAll) {
        if (own.includes(other)) continue;
        d.contradictions.push({ withKey: other, evidenceIds: findings.find((f) => f.hypothesis === other)!.evidenceIds, code: "conflicting_db_categories" });
      }
      d.ruleIds.push("C-DB-CONFLICT");
    }
  }
  // (b) runtime says "all instances running, older than the restarts" while restart cycles are claimed
  const rt = evidence.data("runtime");
  const loopDraft = [...drafts.values()].find((d) => d.key === "crash_loop" || d.key.startsWith("restart_loop_"));
  const cycleTimes = loop?.times ?? [];
  if (loopDraft && rt && rt.assessment.runtime === "running" && rt.assessment.failureReasons.length === 0 && cycleTimes.length) {
    const oldest = Math.min(...rt.applets.map((a) => (a.since ? Date.parse(a.since) : Infinity)));
    if (oldest < Math.min(...cycleTimes)) {
      loopDraft.contradictions.push({ withKey: "runtime_state", evidenceIds: [evidence.idOf("runtime")!], code: "runtime_running_older_than_restarts" });
      loopDraft.ruleIds.push("C-RUNTIME-VS-EVENTS");
    }
  }

  // ---------- confidence ----------
  const hypotheses: Hypothesis[] = [...drafts.values()].map((d) => {
    let c = d.confidence ?? d.base;
    if (d.contradictions.length) c = cap(c, "MEDIUM");
    const all = [...d.observations, ...d.inferences];
    const limitations = [...new Set(all.flatMap((f) => f.limitations))];
    for (const x of d.contradictions) limitations.push(x.code);
    return {
      key: d.key,
      confidence: c,
      ruleIds: [...new Set([...d.ruleIds, `conf:${c}`])],
      observations: d.observations,
      inferences: d.inferences,
      evidenceIds: [...new Set(all.flatMap((f) => f.evidenceIds))],
      contradictions: d.contradictions,
      missing: limitations.filter((l) => MISSING_CODES.has(l)),
      limitations: [...new Set(limitations)],
      merged: d.merged,
    };
  });

  // ---------- ranking (intent-aware tie-break) ----------
  const PRIORITY: Record<string, number> = {
    restart_loop_oom_kill: 100, restart_loop_missing_configuration: 98, restart_loop_db_authentication_failure: 96, restart_loop_db_connection_refused: 96, restart_loop_db_connection_timeout: 96, restart_loop_db_dns_failure: 96,
    crash_loop: 90, oom_kill: 88, memory_exhaustion_in_process: 86, missing_configuration: 84, db_authentication_failure: 80, db_connection_refused: 80, db_dns_failure: 80, db_connection_timeout: 80,
    http_500: 70, release_failed: 66, release_regression: 64, cpu_saturation: 60, memory_pressure: 58, memory_growth_unverified: 30, isolated_restart: 20,
  };
  const INTENT_BOOST: Record<Intent, Record<string, number>> = {
    why_restarting: { crash_loop: 30 },
    why_slow: { cpu_saturation: 40, memory_pressure: 30, db_connection_timeout: 35 },
    investigate_http_500: { http_500: 40 },
    recent_deployment_failures: { release_failed: 40, release_regression: 40 },
  };
  const score = (h: Hypothesis) => (PRIORITY[h.key] ?? 10) + (INTENT_BOOST[intent][h.key] ?? 0);
  hypotheses.sort((a, b) => RANK[b.confidence] - RANK[a.confidence] || score(b) - score(a) || a.key.localeCompare(b.key));

  // ---------- status, missing evidence, caveats ----------
  const missingEvidence = evidence.items.filter((i) => i.availability !== "available").map((i) => ({ source: i.source, availability: i.availability, evidenceId: i.id }));
  const limitations = [...new Set([...input.detectorLimitations, ...hypotheses.flatMap((h) => h.limitations)])];
  const caveats: string[] = [];
  if (evidence.items.some((i) => i.simulated)) caveats.push("simulated_data");
  if (evidence.items.some((i) => i.verification !== "LIVE_VERIFIED")) caveats.push("contract_unverified");
  // HTTP 204 (no payload): the source exists but its content is unknown — it must never read as "nothing happened"
  if (evidence.items.some((i) => i.availability === "no_content")) caveats.push("no_content_observed");
  if (input.semantics.cpu?.origin === "simulated_fixture" || input.semantics.memory?.origin === "simulated_fixture") caveats.push("simulated_semantics");
  const texts = [...(evidence.data("logs")?.lines.map((l) => l.message) ?? []), ...(evidence.data("events")?.rows.map((r) => r.text) ?? []), ...((evidence.data("runtime")?.applets ?? []).map((a) => a.reason ?? ""))];
  if (texts.some(injectionSuspect)) caveats.push("injection_suspected");
  if (evidence.items.some((i) => i.source === "runtime" && i.data && (i.data as { assessment: { runtimeIsHeuristic: boolean } }).assessment.runtimeIsHeuristic)) caveats.push("runtime_interpretation_heuristic");

  const insufficient = hypotheses.find((h) => h.key === "insufficient_evidence");
  if (insufficient) {
    // cite what we DID try to look at: the unusable timeline sources
    if (insufficient.evidenceIds.length === 0) insufficient.evidenceIds = evidence.items.map((i) => i.id);
    return { status: "INSUFFICIENT_EVIDENCE", hypotheses: [insufficient, ...hypotheses.filter((h) => h !== insufficient)], overallConfidence: "INSUFFICIENT_EVIDENCE", missingEvidence, limitations, caveats };
  }
  if (hypotheses.length === 0) return { status: "NO_ANOMALY_IN_EXAMINED_EVIDENCE", hypotheses: [], overallConfidence: "LOW", missingEvidence, limitations, caveats };
  return { status: "ISSUES_FOUND", hypotheses, overallConfidence: hypotheses[0]!.confidence, missingEvidence, limitations, caveats };
}

/** Throws when any claim cites evidence that does not exist, or a non-insufficient hypothesis cites nothing. */
export function assertCitationIntegrity(d: Diagnosis, ids: Set<string>, recommendations: { id: string; evidenceIds: string[] }[] = []): void {
  const bad = (what: string, id: string) => {
    throw new Error(`citation integrity violated: ${what} cites unknown evidence ${id}`);
  };
  for (const h of d.hypotheses) {
    if (h.key !== "insufficient_evidence" && h.evidenceIds.length === 0) throw new Error(`citation integrity violated: hypothesis ${h.key} cites no evidence`);
    for (const id of h.evidenceIds) if (!ids.has(id)) bad(`hypothesis ${h.key}`, id);
    for (const f of [...h.observations, ...h.inferences]) for (const id of f.evidenceIds) if (!ids.has(id)) bad(`finding ${f.id}`, id);
    for (const c of h.contradictions) for (const id of c.evidenceIds) if (!ids.has(id)) bad(`contradiction of ${h.key}`, id);
  }
  for (const m of d.missingEvidence) if (!ids.has(m.evidenceId)) bad("missing-evidence entry", m.evidenceId);
  for (const r of recommendations) for (const id of r.evidenceIds) if (!ids.has(id)) bad(`recommendation ${r.id}`, id);
}
