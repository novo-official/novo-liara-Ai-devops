import type { Detector, SourceKey } from "../types";
import { finding } from "./util";

/**
 * H. Insufficient evidence. Without any usable timeline (logs or events) the other detectors cannot say much, so this
 * detector states WHY (per source availability) instead of letting silence read as health. Also records a limitation
 * per unusable source so partial evidence is always visible.
 */
export const insufficient: Detector = {
  id: "insufficient",
  run({ evidence }) {
    const limitations: string[] = [];
    const unusable: { source: SourceKey; availability: string }[] = [];
    for (const i of evidence.items) {
      if (i.availability !== "available") {
        unusable.push({ source: i.source, availability: i.availability });
        limitations.push(`src_${i.source}_${i.availability}`);
      }
    }
    const timeline = evidence.data("logs") !== null || evidence.data("events") !== null;
    if (timeline) return { findings: [], limitations };
    return {
      findings: [
        finding({
          detector: "insufficient",
          hypothesis: "insufficient_evidence",
          kind: "observation",
          strength: "strong",
          evidenceIds: evidence.items.filter((i) => i.source === "logs" || i.source === "events").map((i) => i.id),
          data: { reasons: unusable.map((u) => `${u.source}:${u.availability}`) },
          limitations: ["no_timeline_evidence"],
        }),
      ],
      limitations,
    };
  },
};
