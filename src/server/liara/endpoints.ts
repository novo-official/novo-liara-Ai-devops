import { APP_NAME_REGEX } from "../config/env";
import { LiaraError } from "./errors";

/**
 * Registry of the ONLY upstream calls this build can make. All are GET.
 * `contract`: documented = present in the pinned OpenAPI (docs/reference/openapi);
 *             observed   = seen only in the official CLI source (unstable, opt-in).
 * There is deliberately no entry for any POST/PUT/PATCH/DELETE endpoint.
 */
export interface EndpointDef {
  id: string;
  method: "GET";
  /** path template; `{name}` is the only supported placeholder */
  path: string;
  contract: "documented" | "observed";
  maxBytes: number;
}

const MB = 1024 * 1024;

export const ENDPOINTS = {
  listApps: { id: "listApps", method: "GET", path: "/v1/projects", contract: "documented", maxBytes: 2 * MB },
  getApp: { id: "getApp", method: "GET", path: "/v1/projects/{name}", contract: "documented", maxBytes: 1 * MB },
  getApplets: { id: "getApplets", method: "GET", path: "/v1/projects/{name}/applets", contract: "documented", maxBytes: 1 * MB },
  getReleases: { id: "getReleases", method: "GET", path: "/v1/projects/{name}/releases", contract: "documented", maxBytes: 2 * MB },
  getEvents: { id: "getEvents", method: "GET", path: "/v1/projects/{name}/events", contract: "documented", maxBytes: 2 * MB },
  getLogsV1: { id: "getLogsV1", method: "GET", path: "/v1/projects/{name}/logs", contract: "documented", maxBytes: 4 * MB },
  getLogsV2: { id: "getLogsV2", method: "GET", path: "/v2/projects/{name}/logs", contract: "observed", maxBytes: 4 * MB },
  getMetricsCpu: { id: "getMetricsCpu", method: "GET", path: "/v1/projects/{name}/metrics/cpu", contract: "documented", maxBytes: 2 * MB },
  getMetricsMemory: { id: "getMetricsMemory", method: "GET", path: "/v1/projects/{name}/metrics/memory", contract: "documented", maxBytes: 2 * MB },
  // ---- account scope (GET /v1/me*, pinned `me.yaml`). Used by the account-only verification path; responses are projected inside the adapter. ----
  getMe: { id: "getMe", method: "GET", path: "/v1/me", contract: "documented", maxBytes: 2 * MB },
  getMeSubscription: { id: "getMeSubscription", method: "GET", path: "/v1/me/subscription", contract: "documented", maxBytes: 64 * 1024 },
  getMeFreeCredit: { id: "getMeFreeCredit", method: "GET", path: "/v1/me/free-credit", contract: "documented", maxBytes: 16 * 1024 },
  /** Phase 2B: documented in the pinned `billing.yaml` (commit 338325a4). Response keys are projected to `user.balance` only. */
  getBilling: { id: "getBilling", method: "GET", path: "/v1/billing", contract: "documented", maxBytes: 64 * 1024 },
  /** Phase 2B: CLI-observed ONLY (`liara network:list`; absent from every pinned spec). Opt-in via LIARA_ALLOW_UNDOCUMENTED_ENDPOINTS. */
  listNetworks: { id: "listNetworks", method: "GET", path: "/v1/networks", contract: "observed", maxBytes: 64 * 1024 },
} as const satisfies Record<string, EndpointDef>;

export type EndpointId = keyof typeof ENDPOINTS;

export function buildPath(def: EndpointDef, name?: string): string {
  if (!def.path.includes("{name}")) return def.path;
  if (typeof name !== "string" || !APP_NAME_REGEX.test(name)) {
    throw new LiaraError("invalid_input", "Invalid application name");
  }
  return def.path.replace("{name}", encodeURIComponent(name));
}
