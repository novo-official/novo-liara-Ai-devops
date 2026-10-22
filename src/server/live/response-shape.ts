/**
 * SANITISED SHAPE of a write response — what the operator needs to diagnose an unreadable 2xx without ever storing upstream text. It records the HTTP status, the
 * content type (token characters only), the byte count, whether the body was empty / JSON / not JSON, and for a JSON object the top-level key NAMES with the
 * kind (and, for strings, the length and a coarse FORMAT class) of each value. Only recognised protocol key names and media types are retained: unknown names
 * can themselves contain secrets. It never contains a value, a fragment of a value or any text of a non-JSON body.
 */
export interface ShapeKey {
  name: string;
  type: "string" | "number" | "boolean" | "null" | "object" | "array";
  /** strings only */
  length?: number;
  format?: "uuid" | "hex" | "alnum" | "alnum_dash_underscore" | "has_dot" | "has_slash" | "has_space" | "other";
}
export interface ResponseShape {
  status: number;
  contentType: string | null;
  bytes: number;
  body: "empty" | "json" | "non_json" | "too_large";
  /** JSON top level, or for a non-JSON body only the coarse kind of its first character */
  lead: "object" | "array" | "string" | "number" | "boolean" | "null" | "html_like" | "text_like" | null;
  keys: ShapeKey[];
  /** the `sourceID` / `releaseID` member specifically (the one the contract needs) */
  expected: { key: string; present: boolean; type: ShapeKey["type"] | null; length: number | null; format: ShapeKey["format"] | null };
}
export interface ResponseMeta {
  status: number;
  contentType: string | null;
  bytes: number;
  body: ResponseShape["body"];
  /** first non-space character of a non-JSON body (only its class is ever kept) */
  firstChar?: string;
}

const DIAGNOSTIC_KEYS = new Set(["sourceID", "sourceId", "source_id", "releaseID", "releaseId", "release_id", "id", "data", "result", "error", "errors", "message", "code", "status"]);
const safeName = (s: string) => DIAGNOSTIC_KEYS.has(s) ? s : "[other]";
const MEDIA_TYPES = new Set(["application/json", "application/problem+json", "text/json", "text/plain", "text/html", "application/octet-stream"]);
export const safeContentType = (raw: string | null): string | null => {
  if (!raw) return null;
  const type = raw.split(";", 1)[0]!.trim().toLowerCase();
  return MEDIA_TYPES.has(type) ? type : "?";
};

function stringFormat(s: string): ShapeKey["format"] {
  if (/^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i.test(s)) return "uuid";
  if (/^[0-9a-f]+$/i.test(s)) return "hex";
  if (/\s/.test(s)) return "has_space";
  if (s.includes("/")) return "has_slash";
  if (s.includes(".")) return "has_dot";
  if (/^[A-Za-z0-9]+$/.test(s)) return "alnum";
  if (/^[A-Za-z0-9_-]+$/.test(s)) return "alnum_dash_underscore";
  return "other";
}
function kindOf(v: unknown): ShapeKey["type"] {
  return v === null ? "null" : Array.isArray(v) ? "array" : typeof v === "string" ? "string" : typeof v === "number" ? "number" : typeof v === "boolean" ? "boolean" : "object";
}
const keyInfo = (name: string, v: unknown): ShapeKey => {
  const type = kindOf(v);
  return typeof v === "string" ? { name: safeName(name), type, length: v.length, format: stringFormat(v) } : { name: safeName(name), type };
};

export function describeResponse(meta: ResponseMeta, json: unknown, expectedKey: string): ResponseShape {
  const keys: ShapeKey[] = [];
  let lead: ResponseShape["lead"] = null;
  if (meta.body === "json") {
    lead = kindOf(json) as ResponseShape["lead"];
    if (json && typeof json === "object" && !Array.isArray(json)) for (const [k, v] of Object.entries(json as Record<string, unknown>).slice(0, 12)) keys.push(keyInfo(k, v));
  } else if (meta.body === "non_json" && meta.firstChar) {
    lead = meta.firstChar === "<" ? "html_like" : "text_like";
  }
  const hit = json && typeof json === "object" && !Array.isArray(json) && Object.prototype.hasOwnProperty.call(json, expectedKey) ? keyInfo(expectedKey, (json as Record<string, unknown>)[expectedKey]) : null;
  return {
    status: meta.status,
    contentType: safeContentType(meta.contentType),
    bytes: meta.bytes,
    body: meta.body,
    lead,
    keys,
    expected: { key: expectedKey, present: !!hit, type: hit?.type ?? null, length: hit?.length ?? null, format: hit?.format ?? null },
  };
}
