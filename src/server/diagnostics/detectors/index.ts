import type { Detector, Intent } from "../types";
import { cpu } from "./cpu";
import { crashLoop } from "./crash-loop";
import { database } from "./database";
import { http500 } from "./http500";
import { insufficient } from "./insufficient";
import { memory } from "./memory";
import { missingConfig } from "./missing-config";
import { release } from "./release";

export { cpu, crashLoop, database, http500, insufficient, memory, missingConfig, release };

/** Detector sets per supported intent. `insufficient` always runs last so it can describe what the others could not see. */
export const DETECTORS_BY_INTENT: Record<Intent, Detector[]> = {
  why_restarting: [crashLoop, database, missingConfig, memory, release, insufficient],
  why_slow: [cpu, memory, database, release, http500, insufficient],
  investigate_http_500: [http500, database, missingConfig, release, crashLoop, memory, insufficient],
  recent_deployment_failures: [release, crashLoop, missingConfig, database, http500, insufficient],
};
