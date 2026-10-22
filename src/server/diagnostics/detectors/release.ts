import type { Detector, Finding } from "../types";
import { classifyDb, http5xx, isErrorLine, isExitLine, isRestartEvent, lineMs } from "../signals";
import { finding, MINUTE } from "./util";
import type { Release } from "../../domain/models";

const FAILED = /(fail|error|cancel|time-?out|abort)/i;
const MIN_BASELINE_MIN = 5;
const MIN_AFTER_ERRORS = 5;
const RATE_FACTOR = 3;
const RECENT_MS = 72 * 3_600_000;

const relMs = (r: Release) => Date.parse(r.finishedAt ?? r.createdAt ?? "") || null;

/**
 * F. Release regression / failed release.
 *  - release_failed: a recent release whose state looks failed (vocabulary is UNVERIFIED → moderate at most). A failed release
 *    that never became current does not affect the running version, and the finding says so.
 *  - release_regression: error signals (error lines, restart/exit events, 5xx, DB errors) jump after the latest release finished
 *    compared with a clean baseline BEFORE it. This is temporal correlation, never proof of causation → at most moderate.
 */
export const release: Detector = {
  id: "release",
  run({ evidence, now }) {
    const rel = evidence.data("releases");
    if (!rel || rel.releases.length === 0) return { findings: [], limitations: rel ? ["no_release_history"] : [] };
    const findings: Finding[] = [];
    const limitations: string[] = [];
    const relId = evidence.idOf("releases")!;

    // ---- failed releases ----
    const sorted = [...rel.releases].filter((r) => relMs(r) !== null).sort((a, b) => relMs(b)! - relMs(a)!);
    const failed = sorted.filter((r) => r.state && FAILED.test(r.state) && now - relMs(r)! <= RECENT_MS);
    if (failed.length) {
      const latest = failed[0]!;
      const newerSuccess = sorted.find((r) => relMs(r)! > relMs(latest)! && !(r.state && FAILED.test(r.state)));
      const isCurrent = rel.currentRelease !== null && (latest.tag === rel.currentRelease || latest.id === rel.currentRelease);
      findings.push(
        finding({
          detector: "release",
          hypothesis: "release_failed",
          kind: "observation",
          // a failed release that a LATER successful release has already superseded is history, not an active problem
          strength: newerSuccess ? "weak" : "moderate",
          evidenceIds: [relId],
          data: { count: failed.length, latestTag: latest.tag, latestState: latest.state, failedIsCurrent: isCurrent, newerSuccessExists: !!newerSuccess, finishedMs: relMs(latest) },
          limitations: ["release_state_vocabulary_unverified", ...(isCurrent ? [] : ["failed_release_is_not_current"])],
          times: [relMs(latest)!],
        }),
      );
    }

    // ---- regression correlation ----
    const ok = sorted.find((r) => !(r.state && FAILED.test(r.state)));
    const logs = evidence.data("logs");
    const events = evidence.data("events");
    if (!ok || (!logs && !events)) return { findings, limitations };
    const pivot = relMs(ok)!;
    const winFrom = Date.parse((evidence.item("logs") ?? evidence.item("events"))!.window!.from);
    const winTo = Date.parse((evidence.item("logs") ?? evidence.item("events"))!.window!.to);
    if (pivot < winFrom || pivot > winTo) {
      limitations.push("release_outside_window");
      return { findings, limitations };
    }
    const signals: number[] = [];
    for (const l of logs?.lines ?? []) {
      const ms = lineMs(l);
      if (ms !== null && (isErrorLine(l.message) || http5xx(l.message).length || classifyDb(l.message))) signals.push(ms);
    }
    for (const r of events?.rows ?? []) {
      if (r.time && (isRestartEvent(r.text) || isExitLine(r.text))) signals.push(Date.parse(r.time));
    }
    if (signals.length === 0) return { findings, limitations };
    const before = signals.filter((t) => t < pivot).length;
    const after = signals.filter((t) => t >= pivot);
    const beforeMin = (pivot - winFrom) / MINUTE;
    const afterMin = Math.max(1, (winTo - pivot) / MINUTE);
    const rateAfter = after.length / afterMin;
    const rateBefore = beforeMin >= MIN_BASELINE_MIN ? before / beforeMin : null;
    if (after.length < MIN_AFTER_ERRORS) return { findings, limitations };
    const firstAfter = Math.min(...after);
    const data = { releaseTag: ok.tag, pivotMs: pivot, errorsBefore: before, errorsAfter: after.length, baselineMinutes: Math.round(beforeMin), afterMinutes: Math.round(afterMin), firstErrorMinutesAfterRelease: Math.round((firstAfter - pivot) / MINUTE) };
    if (rateBefore === null) {
      limitations.push("no_pre_release_baseline");
      findings.push(finding({ detector: "release", hypothesis: "release_regression", kind: "inference", strength: "weak", evidenceIds: [relId, ...[logs && evidence.idOf("logs"), events && evidence.idOf("events")].filter((x): x is string => !!x)], data, limitations: ["no_pre_release_baseline", "correlation_not_causation"], times: after }));
    } else if (rateAfter >= RATE_FACTOR * rateBefore) {
      findings.push(finding({ detector: "release", hypothesis: "release_regression", kind: "inference", strength: "moderate", evidenceIds: [relId, ...[logs && evidence.idOf("logs"), events && evidence.idOf("events")].filter((x): x is string => !!x)], data: { ...data, rateBeforePerMin: Number(rateBefore.toFixed(2)), rateAfterPerMin: Number(rateAfter.toFixed(2)) }, limitations: ["correlation_not_causation"], times: after }));
    }
    return { findings, limitations };
  },
};
