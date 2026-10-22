import { NextResponse } from "next/server";
import { getConfig } from "../config/env";
import { errorMessage } from "@/i18n/fa";
import { isLiaraError, type LiaraErrorCode } from "../liara/errors";
import { isRunError } from "../diagnostics/workflow";
import { isAgentError } from "../agent/errors";
import { isLiveError } from "../live/types";
import { log } from "./logger";
import { redactDeep } from "./redact";
import { SlidingWindowLimiter } from "./rate-limit";
import { getSession, parseCookieHeader, sessionCookieName, type Session } from "./session";

/** Maps an error code to the HTTP status returned to the browser. */
const STATUS: Record<string, number> = {
  unauthenticated: 401,
  csrf: 403,
  invalid_credentials: 401,
  auth_not_configured: 503,
  bad_request: 400,
  invalid_input: 400,
  not_found: 404,
  app_not_allowed: 404, // indistinguishable from not_found on purpose
  rate_limited: 429,
  unauthorized: 502, // upstream rejected OUR token — not the browser's session
  forbidden: 502,
  timeout: 504,
  network: 502,
  upstream_error: 502,
  response_too_large: 502,
  contract_mismatch: 502,
  no_content: 502,
  unsupported: 501,
  not_configured: 503,
  method_not_allowed: 405,
  unknown_intent: 400,
  invalid_window: 400,
  run_in_progress: 409,
  too_many_runs: 429,
  run_quota_exceeded: 429,
  retry_not_allowed: 409,
  conversation_full: 409,
  proposal_pending: 409,
  proposal_limit: 409,
  not_ready: 409,
  no_applicable_operation: 409,
  confirmation_required: 400,
  digest_mismatch: 409,
  already_decided: 409,
  expired: 410,
  blocked_policy: 403,
  blocked_drift: 409,
  proposal_tampered: 409,
  invalid_decision: 400,
  upload_rejected: 422,
  upload_quota_exceeded: 429,
  no_project: 409,
  plan_refused: 409,
  app_name_taken: 409,
  live_execution_disabled: 403,
  simulation_approval_not_valid_for_live: 403,
  live_prerequisite_missing: 409,
  live_not_found: 404,
  live_proposal_pending: 409,
  live_digest_mismatch: 409,
  live_confirmation_required: 400,
  live_expired: 410,
  live_already_decided: 409,
  live_blocked_policy: 403,
  live_blocked_drift: 409,
  live_tampered: 409,
  live_binding_mismatch: 409,
  live_operation_in_progress: 409,
  live_duplicate_app: 409,
  live_invalid_state: 409,
  live_artifact_rejected: 422,
  live_artifact_mismatch: 409,
  live_plan_blocked: 409,
  live_not_approved: 409,
  live_simulation_approval_rejected: 403,
  internal: 500,
};

export function apiError(code: string, extra: { retryAfterSec?: number; status?: number; reason?: string } = {}): NextResponse {
  const status = extra.status ?? STATUS[code] ?? 500;
  const res = NextResponse.json({ error: { code, message: errorMessage(code), ...(extra.reason ? { reason: extra.reason } : {}) } }, { status });
  res.headers.set("Cache-Control", "no-store");
  if (extra.retryAfterSec) res.headers.set("Retry-After", String(extra.retryAfterSec));
  return res;
}

export function apiJson(data: unknown, init?: { status?: number; headers?: Record<string, string> }): NextResponse {
  // Final defence-in-depth scrub of everything that leaves the server.
  const res = NextResponse.json(redactDeep(data), { status: init?.status ?? 200 });
  res.headers.set("Cache-Control", "no-store");
  for (const [k, v] of Object.entries(init?.headers ?? {})) res.headers.set(k, v);
  return res;
}

const g = globalThis as unknown as { __apiLimiter?: SlidingWindowLimiter };
function apiLimiter(): SlidingWindowLimiter {
  return (g.__apiLimiter ??= new SlidingWindowLimiter({ windowMs: 60_000, max: 120 }));
}
export function __resetApiLimiterForTests(): void {
  g.__apiLimiter = undefined;
}

export function sessionFromRequest(req: Request): Session | null {
  const id = parseCookieHeader(req.headers.get("cookie"), sessionCookieName());
  return getSession(id);
}

export function clientKey(req: Request): string {
  if (!getConfig().auth.trustProxyHeaders) return "global";
  // Rightmost entry = the one appended by our own trusted proxy (leftmost values are client-controlled).
  const xff = req.headers.get("x-forwarded-for");
  const last = xff?.split(",").pop()?.trim();
  return last && /^[0-9a-fA-F:.]{3,45}$/.test(last) ? last : "global";
}

/** Same-origin enforcement for state-changing requests. */
export function checkSameOrigin(req: Request): NextResponse | null {
  const host = (getConfig().auth.trustProxyHeaders ? req.headers.get("x-forwarded-host") : null) ?? req.headers.get("host") ?? new URL(req.url).host;
  const origin = req.headers.get("origin");
  if (origin) {
    let o: URL;
    try {
      o = new URL(origin);
    } catch {
      return apiError("csrf");
    }
    if (!host || o.host !== host) return apiError("csrf");
  } else if (req.headers.get("sec-fetch-site") !== "same-origin") {
    return apiError("csrf");
  }
  return null;
}

/** Same-origin + JSON enforcement for state-changing requests. */
export function checkSameOriginJson(req: Request): NextResponse | null {
  const bad = checkSameOrigin(req);
  if (bad) return bad;
  if (!/^application\/json\b/i.test(req.headers.get("content-type") ?? "")) return apiError("csrf");
  return null;
}

/**
 * Wrapper for every Liara-backed read route: session -> rate limit -> handler -> uniform error mapping.
 * Only GET handlers are ever wrapped; there is no wrapper for write methods on data routes.
 */
export async function guardedRead(
  req: Request,
  handler: (ctx: { session: Session }) => Promise<unknown>,
): Promise<NextResponse> {
  try {
    const session = sessionFromRequest(req);
    if (!session) return apiError("unauthenticated");
    const rl = apiLimiter().take(session.id);
    if (!rl.allowed) return apiError("rate_limited", { retryAfterSec: rl.retryAfterSec });
    const out = await handler({ session });
    return out instanceof Response ? (out as NextResponse) : apiJson(out);
  } catch (e) {
    return mapError(e);
  }
}

/**
 * Wrapper for the diagnostic-run actions (create / cancel). These are POSTs but they can only start or stop an OFFLINE analysis of
 * allowlisted apps through the read-only service: session -> same-origin JSON check -> rate limit -> handler. Never reaches a Liara write.
 */
export async function guardedAction(
  req: Request,
  handler: (ctx: { session: Session; body: unknown }) => Promise<unknown>,
): Promise<NextResponse> {
  try {
    const session = sessionFromRequest(req);
    if (!session) return apiError("unauthenticated");
    const csrf = checkSameOriginJson(req);
    if (csrf) return csrf;
    const rl = apiLimiter().take(session.id);
    if (!rl.allowed) return apiError("rate_limited", { retryAfterSec: rl.retryAfterSec });
    const text = await req.text();
    if (text.length > 2048) return apiError("bad_request");
    let body: unknown;
    try {
      body = text ? JSON.parse(text) : {};
    } catch {
      return apiError("bad_request");
    }
    const out = await handler({ session, body });
    return out instanceof Response ? (out as NextResponse) : apiJson(out);
  } catch (e) {
    return mapError(e);
  }
}

const ZIP_TYPES = /^application\/(zip|x-zip-compressed|octet-stream)\b/i;

/**
 * Wrapper for the project-upload route: session → same-origin (a non-simple content type also forces a CORS preflight) → rate limit →
 * size-capped, time-capped streaming read of the raw ZIP body. The bytes are UNTRUSTED and are never written to disk here.
 */
export async function guardedUpload(
  req: Request,
  limits: { maxBytes: number; timeoutMs: number },
  handler: (ctx: { session: Session; bytes: Buffer; filename: string | null; conversationId: string | null; headers: Headers }) => Promise<unknown>,
): Promise<NextResponse> {
  try {
    const session = sessionFromRequest(req);
    if (!session) return apiError("unauthenticated");
    const csrf = checkSameOrigin(req);
    if (csrf) return csrf;
    if (!ZIP_TYPES.test(req.headers.get("content-type") ?? "")) return apiError("upload_rejected", { reason: "bad_content_type" });
    const rl = apiLimiter().take(session.id);
    if (!rl.allowed) return apiError("rate_limited", { retryAfterSec: rl.retryAfterSec });
    const declared = Number(req.headers.get("content-length") ?? "");
    if (Number.isFinite(declared) && declared > limits.maxBytes) return apiError("upload_rejected", { reason: "too_large" });
    if (!req.body) return apiError("upload_rejected", { reason: "empty" });
    const reader = req.body.getReader();
    const chunks: Uint8Array[] = [];
    let total = 0;
    const deadline = Date.now() + limits.timeoutMs;
    for (;;) {
      if (Date.now() > deadline) {
        await reader.cancel().catch(() => undefined);
        return apiError("upload_rejected", { reason: "timeout" });
      }
      const { done, value } = await reader.read();
      if (done) break;
      total += value.byteLength;
      if (total > limits.maxBytes) {
        await reader.cancel().catch(() => undefined);
        return apiError("upload_rejected", { reason: "too_large" });
      }
      chunks.push(value);
    }
    if (total === 0) return apiError("upload_rejected", { reason: "empty" });
    const nameHdr = req.headers.get("x-upload-filename");
    const convHdr = req.headers.get("x-conversation-id");
    const out = await handler({
      session,
      bytes: Buffer.concat(chunks, total),
      filename: nameHdr && /^[\w. -]{1,64}$/.test(nameHdr) ? nameHdr : null,
      conversationId: convHdr && /^conv_\d{14}_[0-9a-f]{8}$/.test(convHdr) ? convHdr : null,
      headers: req.headers,
    });
    return out instanceof Response ? (out as NextResponse) : apiJson(out);
  } catch (e) {
    return mapError(e);
  }
}

export function mapError(e: unknown): NextResponse {
  if (isLiveError(e)) {
    log("warn", "api.live_error", { code: e.code });
    return apiError(e.code, { reason: e.detail.length ? e.detail.slice(0, 6).join(",") : undefined });
  }
  if (isAgentError(e)) {
    log("warn", "api.agent_error", { code: e.code });
    const res = apiError(e.code, { reason: e.extra?.reason });
    if (e.extra?.existingRunId) res.headers.set("X-Existing-Run", e.extra.existingRunId);
    return res;
  }
  if (isRunError(e)) {
    log("warn", "api.run_error", { code: e.code });
    const res = apiError(e.code);
    if (e.existingRunId) res.headers.set("X-Existing-Run", e.existingRunId);
    return res;
  }
  if (isLiaraError(e)) {
    const code: LiaraErrorCode = e.code;
    log("warn", "api.error", { code, status: e.status, endpoint: e.endpoint });
    return apiError(code, { retryAfterSec: e.opts?.retryAfterSec });
  }
  // Unknown error: never echo its message to the client.
  log("error", "api.unhandled", { name: (e as { name?: string })?.name });
  return apiError("internal");
}
