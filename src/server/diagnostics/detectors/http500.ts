import type { Detector } from "../types";
import { http5xx, lineMs } from "../signals";
import { excerpts, finding, strengthByCount } from "./util";

/**
 * G. Explicit HTTP 500 evidence in logs. Reports COUNTS of explicit lines in the sampled window only: the API exposes no request
 * totals or status metrics, so no error RATE is ever computed. Other 5xx codes are counted separately.
 */
export const http500: Detector = {
  id: "http500",
  run({ evidence }) {
    const logs = evidence.data("logs");
    if (!logs) return { findings: [], limitations: [] };
    const hits500: string[] = [];
    const times: number[] = [];
    let other = 0;
    for (const l of logs.lines) {
      const codes = http5xx(l.message);
      if (codes.includes(500)) {
        hits500.push(l.message);
        const ms = lineMs(l);
        if (ms !== null) times.push(ms);
      } else if (codes.length) other++;
    }
    const limitations = ["no_http_error_rate", "no_http_probe", ...(logs.truncated ? ["logs_truncated"] : [])];
    if (hits500.length === 0) return { findings: [], limitations: other ? limitations : ["no_http_probe"] };
    return {
      findings: [
        finding({
          detector: "http500",
          hypothesis: "http_500",
          kind: "observation",
          strength: strengthByCount(hits500.length),
          evidenceIds: [evidence.idOf("logs")!],
          excerpts: excerpts(hits500),
          data: { count500: hits500.length, otherServerErrors: other, sampledLines: logs.lines.length, truncated: logs.truncated },
          limitations,
          times,
        }),
      ],
      limitations,
    };
  },
};
