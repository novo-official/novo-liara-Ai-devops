import type { DetectorResult, Detector, Finding, HypothesisKey } from "../types";
import { classifyDb, lineMs, type DbCategory } from "../signals";
import { excerpts, finding, strengthByCount } from "./util";

const KEY: Record<DbCategory, HypothesisKey> = {
  refused: "db_connection_refused",
  timeout: "db_connection_timeout",
  dns: "db_dns_failure",
  auth: "db_authentication_failure",
};

/**
 * B. Database connection failures, split into four DISTINCT categories (refused / timeout / DNS / authentication).
 * Works on sanitised log + event text only; lines without database context are never counted. Excerpts are
 * shareable-redacted so credentials and private hosts cannot appear.
 */
export const database: Detector = {
  id: "database",
  run({ evidence }) {
    const logs = evidence.data("logs");
    const events = evidence.data("events");
    const limitations: string[] = [];
    const buckets = new Map<DbCategory, { texts: string[]; times: number[]; ids: Set<string> }>();
    const add = (cat: DbCategory, text: string, ms: number | null, id: string | null) => {
      const b = buckets.get(cat) ?? { texts: [], times: [], ids: new Set<string>() };
      b.texts.push(text);
      if (ms !== null) b.times.push(ms);
      if (id) b.ids.add(id);
      buckets.set(cat, b);
    };
    for (const l of logs?.lines ?? []) {
      const c = classifyDb(l.message);
      if (c) add(c, l.message, lineMs(l), evidence.idOf("logs"));
    }
    for (const r of events?.rows ?? []) {
      const c = classifyDb(r.text);
      if (c) add(c, r.text, r.time ? Date.parse(r.time) : null, evidence.idOf("events"));
    }
    if (logs?.truncated) limitations.push("logs_truncated");
    const findings: Finding[] = [];
    for (const [cat, b] of buckets) {
      findings.push(
        finding({
          detector: "database",
          hypothesis: KEY[cat],
          kind: "observation",
          strength: strengthByCount(b.texts.length),
          evidenceIds: [...b.ids],
          excerpts: excerpts(b.texts),
          data: { category: cat, count: b.texts.length, firstMs: b.times.length ? Math.min(...b.times) : null, lastMs: b.times.length ? Math.max(...b.times) : null },
          limitations: b.texts.length < 2 ? ["single_occurrence"] : [],
          times: b.times,
        }),
      );
    }
    return { findings, limitations } satisfies DetectorResult;
  },
};
