import { redactText } from "../security/redact";
import { Pseudonymizer } from "../security/pseudonym";
import { toIso } from "./schemas";
import type { EndpointId } from "./endpoints";

/**
 * Safe fixture recording. Nothing is written unless a field is EXPLICITLY approved in a spec.
 * Rules:
 *   true            keep scalar (string redacted + truncated to 60 chars); objects/arrays are dropped
 *   "shape"         replace by {type, length} — no content
 *   "matrix"        for arrays of arrays: {rows, columns:[distinct column counts]} — no content
 *   "time"          replace by a relative "$ago:<seconds>" marker (understood by the mock transport)
 *   {pseudo: "x"}   replace by a stable pseudonym "x-1", "x-2", …
 *   [spec]          array whose items are sanitized with `spec`
 *   {…}             nested object spec
 * Every other key in the payload is dropped, so new/unknown upstream fields can never be recorded.
 */
export type Rule = true | "shape" | "matrix" | "time" | { pseudo: string } | [Spec] | Spec;
export interface Spec {
  [key: string]: Rule;
}

export const APPROVED_FIELDS: Record<EndpointId, Spec> = {
  listApps: { projects: [{ _id: { pseudo: "id" }, project_id: { pseudo: "app" }, type: true, status: true, scale: true, planID: true, created_at: "time", isDeployed: true }] },
  getApp: {
    project: {
      project_id: { pseudo: "app" },
      type: true,
      status: true,
      defaultSubdomain: true,
      readOnlyRootFilesystem: true,
      zeroDowntime: true,
      scale: true,
      envs: [{ key: { pseudo: "ENV_KEY" }, encrypted: true }], // `value` is NOT approved
      planID: true,
      fixedIPStatus: true,
      created_at: "time",
      isDeployed: true,
    },
  },
  getApplets: { applets: [{ id: { pseudo: "applet" }, name: { pseudo: "applet-name" }, timestamp: "time", state: true, reason: "shape", release: { tag: true } }] },
  getReleases: {
    total: true,
    currentRelease: true,
    releases: [{ _id: { pseudo: "release" }, type: true, state: true, port: true, tag: true, createdAt: "time", finishedAt: "time", sourceAvailable: true, gitInfo: { branch: "shape", commit: "shape", message: "shape" } }],
  },
  getEvents: { data: [{ values: "matrix" }] },
  getLogsV1: [{ type: true, datetime: "time", message: "shape" }] as unknown as Spec,
  getLogsV2: { data: [{ values: "matrix" }] },
  getMetricsCpu: { end: "time", result: [{ applet: { pseudo: "applet-name" }, values: "matrix" }] },
  getMetricsMemory: { end: "time", result: [{ applet: { pseudo: "applet-name" }, values: "matrix" }] },
  // Account scope: NOTHING is approved for recording (profile data and storage keys live in these responses). Empty spec = drop every key.
  getMe: {},
  getMeSubscription: {},
  getMeFreeCredit: {},
  getBilling: {},
  listNetworks: {},
};

export { Pseudonymizer };

const MAX_ITEMS = 20;

export function sanitizeForFixture(raw: unknown, rule: Rule, ctx: { now: number; pseudo: Pseudonymizer }): unknown {
  if (rule === true) {
    if (typeof raw === "string") return redactText(raw, { maxLength: 60 });
    if (typeof raw === "number" || typeof raw === "boolean" || raw === null) return raw;
    return undefined;
  }
  if (rule === "shape") {
    if (typeof raw === "string") return { type: "string", length: raw.length };
    if (Array.isArray(raw)) return { type: "array", length: raw.length };
    return raw === null ? null : { type: typeof raw };
  }
  if (rule === "matrix") {
    if (!Array.isArray(raw)) return undefined;
    const cols = [...new Set(raw.map((r) => (Array.isArray(r) ? r.length : -1)))].sort((a, b) => a - b);
    return { rows: raw.length, columns: cols };
  }
  if (rule === "time") {
    const iso = toIso(raw);
    return iso ? `$ago:${Math.max(0, Math.round((ctx.now - Date.parse(iso)) / 1000))}` : undefined;
  }
  if (Array.isArray(rule)) {
    if (!Array.isArray(raw)) return undefined;
    return raw.slice(0, MAX_ITEMS).map((item) => sanitizeForFixture(item, rule[0], ctx));
  }
  if (typeof rule === "object" && "pseudo" in rule && typeof rule.pseudo === "string") {
    return typeof raw === "string" ? ctx.pseudo.name(rule.pseudo, raw) : undefined;
  }
  // nested object spec
  if (raw && typeof raw === "object" && !Array.isArray(raw)) {
    const out: Record<string, unknown> = {};
    for (const [k, sub] of Object.entries(rule as Spec)) {
      if (!(k in (raw as object))) continue;
      const v = sanitizeForFixture((raw as Record<string, unknown>)[k], sub, ctx);
      if (v !== undefined) out[k] = v;
    }
    return out;
  }
  return undefined;
}

/** Sanitises a payload for the given endpoint (top-level arrays use a one-item spec array). */
export function recordPayload(id: EndpointId, raw: unknown, ctx: { now: number; pseudo: Pseudonymizer }): unknown {
  const spec = APPROVED_FIELDS[id];
  const rule: Rule = id === "getLogsV1" ? [(spec as unknown as [Spec])[0]] : spec;
  return sanitizeForFixture(raw, rule, ctx);
}

/** Last line of defence before writing a file. Throws if anything secret-looking survived. */
export function assertSafeToWrite(serialized: string, secrets: string[]): void {
  for (const s of secrets) {
    if (s && serialized.includes(s)) throw new Error("Refusing to write fixture: a known secret is present");
  }
  if (/eyJ[A-Za-z0-9_-]{6,}\.[A-Za-z0-9_-]{6,}\./.test(serialized) || /-----BEGIN [A-Z ]*PRIVATE KEY/.test(serialized)) {
    throw new Error("Refusing to write fixture: credential-shaped content present");
  }
}

export class RecordingRefused extends Error {}

const MARKER = /^\$ago:\d+$/;
const PSEUDONYM = /^[A-Za-z][A-Za-z_-]{0,30}-\d{1,4}$/;
const KEY_NAME = /^[A-Za-z_][A-Za-z0-9_]{0,40}$/;

/**
 * Fail-closed validation of an already-sanitised sample. Every string leaf must be (a) a relative-time marker,
 * (b) a pseudonym label, or (c) a short scalar that the SHAREABLE redactor would leave completely unchanged.
 * Anything else aborts the recording instead of being "fixed up".
 */
export function validateRecordedSample(sample: unknown, path = "$", depth = 0): void {
  if (depth > 10) throw new RecordingRefused(`too deep at ${path}`);
  if (sample === null || typeof sample === "number" || typeof sample === "boolean") return;
  if (typeof sample === "string") {
    if (MARKER.test(sample) || PSEUDONYM.test(sample)) return;
    if (sample.length > 60) throw new RecordingRefused(`long string at ${path}`);
    if (redactText(sample, { shareable: true, maxLength: 200 }) !== sample) throw new RecordingRefused(`sensitive-looking value at ${path}`);
    return;
  }
  if (Array.isArray(sample)) {
    sample.forEach((v, i) => validateRecordedSample(v, `${path}[${i}]`, depth + 1));
    return;
  }
  if (typeof sample === "object") {
    for (const [k, v] of Object.entries(sample as Record<string, unknown>)) {
      if (!KEY_NAME.test(k)) throw new RecordingRefused(`unexpected key at ${path}`);
      validateRecordedSample(v, `${path}.${k}`, depth + 1);
    }
    return;
  }
  throw new RecordingRefused(`unsupported value at ${path}`);
}

/** Human-reviewable manifest written next to recordings. Nothing is promoted automatically. */
export function reviewManifest(entries: { id: EndpointId; keys: string[]; bytes: number }[], at: string): string {
  const lines = [
    "# Recorded fixtures — REVIEW REQUIRED",
    "",
    `Recorded at ${at} from a LIVE read-only connection. Status: **NOT REVIEWED / NOT PROMOTED**.`,
    "",
    "Contents are sanitised, field-allowlisted and pseudonymised; raw API responses were never written to disk.",
    "Before copying any file into `fixtures/reviewed/` (committed) verify by hand that nothing identifies a customer,",
    "then add a line to `fixtures/reviewed/README.md` recording who reviewed it and when.",
    "",
    "| Endpoint | Top-level keys | Bytes |",
    "|---|---|---|",
    ...entries.map((e) => `| ${e.id} | ${e.keys.join(", ") || "(array)"} | ${e.bytes} |`),
    "",
  ];
  return lines.join("\n");
}
