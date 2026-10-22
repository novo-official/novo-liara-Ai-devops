import type { Detector } from "../types";
import { isExitLine, isRestartEvent, lineMs } from "../signals";
import { clusterTimes, excerpts, finding, MINUTE } from "./util";

/** Minimum distinct restart cycles before we call it a LOOP. One or two restarts are reported as isolated. */
export const CRASH_LOOP_MIN_CYCLES = 3;

/**
 * A. Crash loop. Needs timestamped restart/exit evidence (events and/or exit lines in logs). Restart signals closer than
 * 30 s are one cycle. A runtime "restarting" state without timestamps is NOT enough to claim a loop.
 */
export const crashLoop: Detector = {
  id: "crash_loop",
  run({ evidence }) {
    const events = evidence.data("events");
    const logs = evidence.data("logs");
    const rt = evidence.data("runtime");
    const limitations: string[] = [];

    const evRows = (events?.rows ?? []).filter((r) => r.time && isRestartEvent(r.text));
    const evTimes = evRows.map((r) => Date.parse(r.time!));
    const logRows = (logs?.lines ?? []).filter((l) => isExitLine(l.message) && lineMs(l) !== null);
    const logTimes = logRows.map((l) => lineMs(l)!);

    const evCycles = clusterTimes(evTimes);
    const logCycles = clusterTimes(logTimes);
    const cycles = evCycles.length >= logCycles.length ? evCycles : logCycles;
    const runtimeRestarting = rt?.assessment.runtime === "restarting";
    const usedIds = [...(evCycles.length ? [evidence.idOf("events")] : []), ...(logCycles.length ? [evidence.idOf("logs")] : []), ...(runtimeRestarting && cycles.length ? [evidence.idOf("runtime")] : [])].filter((x): x is string => !!x);

    if (cycles.length === 0) {
      if (runtimeRestarting) limitations.push("runtime_restarting_without_timestamps");
      if (!events && !logs) limitations.push("no_timeline_evidence");
      return { findings: [], limitations };
    }

    const bothSources = evCycles.length >= CRASH_LOOP_MIN_CYCLES && logCycles.length >= CRASH_LOOP_MIN_CYCLES;
    const spanMin = Math.round((cycles[cycles.length - 1]! - cycles[0]!) / MINUTE);
    const data = { cycles: cycles.length, eventCycles: evCycles.length, logCycles: logCycles.length, spanMinutes: spanMin, runtimeRestarting, windowMinutes: evidence.item("events")?.window ? Math.round((Date.parse(evidence.item("events")!.window!.to) - Date.parse(evidence.item("events")!.window!.from)) / MINUTE) : null };
    const texts = [...evRows.map((r) => r.text), ...logRows.map((l) => l.message)];

    if (cycles.length < CRASH_LOOP_MIN_CYCLES) {
      return {
        findings: [finding({ detector: "crash_loop", hypothesis: "isolated_restart", kind: "observation", strength: "weak", evidenceIds: usedIds, excerpts: excerpts(texts), data, limitations: ["single_restart_not_a_loop"], times: cycles })],
        limitations,
      };
    }
    const strong = bothSources || runtimeRestarting;
    return {
      findings: [finding({ detector: "crash_loop", hypothesis: "crash_loop", kind: "observation", strength: strong ? "strong" : "moderate", evidenceIds: usedIds, excerpts: excerpts(texts), data, limitations: strong ? [] : ["single_source_restart_evidence"], times: cycles })],
      limitations,
    };
  },
};
