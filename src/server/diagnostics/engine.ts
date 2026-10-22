import { assertCitationIntegrity, aggregate } from "./aggregate";
import { DETECTORS_BY_INTENT } from "./detectors";
import type { EvidenceSet } from "./evidence-set";
import { recommend } from "./recommend";
import type { Diagnosis, Finding, Intent, Recommendation, Semantics } from "./types";

export interface Analysis {
  findings: Finding[];
  diagnosis: Diagnosis;
  recommendations: Recommendation[];
}

/** Pure, synchronous, offline: evidence in, diagnosis + recommendations out. Fully usable without any LLM. */
export function analyze(args: { runId: string; intent: Intent; evidence: EvidenceSet; semantics: Semantics; now: number }): Analysis {
  const { evidence, intent, semantics, now, runId } = args;
  const findings: Finding[] = [];
  const limitations: string[] = [];
  for (const d of DETECTORS_BY_INTENT[intent]) {
    const r = d.run({ runId, now, intent, evidence, semantics });
    findings.push(...r.findings);
    limitations.push(...r.limitations);
  }
  const diagnosis = aggregate({ findings, detectorLimitations: limitations, evidence, intent, semantics });
  const recommendations = recommend(diagnosis);
  assertCitationIntegrity(diagnosis, evidence.ids(), recommendations);
  return { findings, diagnosis, recommendations };
}
