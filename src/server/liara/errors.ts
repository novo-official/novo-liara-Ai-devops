/**
 * Typed errors for the Liara integration. Messages are static strings chosen by us:
 * upstream response bodies and URLs are NEVER copied into an error.
 */
export type LiaraErrorCode =
  | "not_configured"
  | "invalid_input"
  | "app_not_allowed"
  | "not_found"
  | "unauthorized" // upstream rejected our token (401)
  | "forbidden" // upstream 403
  | "rate_limited"
  | "timeout"
  | "network"
  | "upstream_error"
  | "response_too_large"
  | "contract_mismatch"
  /**
   * HTTP 204/205: the endpoint WAS reached and answered, but supplied no payload. It is NOT a success with zero items, NOT a malformed 200 and NOT proof of
   * absence: the content cannot be validated against the documented 200 schema. Kept distinct from `contract_mismatch` so history and diagnostics can tell them apart.
   */
  | "no_content"
  | "unsupported";

export interface ContractIssue {
  path: string;
  code: string;
}

export interface ErrorShape {
  contentType: string | null;
  kind: "empty" | "json-object" | "json-array" | "json-other" | "text";
  /** Top-level key names of a JSON object error body (sanitised identifiers only). */
  keys?: string[];
  bytes: number;
}

export class LiaraError extends Error {
  constructor(
    public readonly code: LiaraErrorCode,
    message: string,
    public readonly opts: {
      status?: number;
      retryAfterSec?: number;
      issues?: ContractIssue[];
      endpoint?: string;
      /** Structure of an upstream ERROR body (key names only; values are never kept). */
      errorShape?: ErrorShape;
      /** `no_content` only: the body was never read; `unexpectedBody` = the response claimed no content but carried a body (it is ignored, never parsed) */
      noContent?: { unexpectedBody: boolean };
    } = {},
  ) {
    super(message);
    this.name = "LiaraError";
  }
  get status() {
    return this.opts.status;
  }
  get endpoint() {
    return this.opts.endpoint;
  }
}

export function httpStatusToCode(status: number): LiaraErrorCode {
  if (status === 401) return "unauthorized";
  if (status === 403) return "forbidden";
  if (status === 404) return "not_found";
  if (status === 429) return "rate_limited";
  return "upstream_error";
}

/**
 * Duck-typed guard. Next.js may bundle this module separately for pages and route handlers, in which case `instanceof`
 * fails across bundles for errors raised by a process-wide singleton. The (name, code) pair is the stable contract.
 */
export function isLiaraError(e: unknown): e is LiaraError {
  return e instanceof LiaraError || (typeof e === "object" && e !== null && (e as { name?: unknown }).name === "LiaraError" && typeof (e as { code?: unknown }).code === "string");
}
