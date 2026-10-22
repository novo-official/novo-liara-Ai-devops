import { z } from "zod";
import { getConfig } from "../config/env";
import { log } from "./logger";
import { verifyPassword, MAX_PASSWORD_LENGTH } from "./password";
import { SlidingWindowLimiter } from "./rate-limit";
import { buildClearCookie, buildSetCookie, createSession, destroySession, parseCookieHeader, sessionCookieName } from "./session";
import { apiError, apiJson, checkSameOriginJson, clientKey } from "./guard";
import type { NextResponse } from "next/server";

const WINDOW = 15 * 60_000;
const g = globalThis as unknown as { __loginPerClient?: SlidingWindowLimiter; __loginGlobal?: SlidingWindowLimiter };
const perClient = () => (g.__loginPerClient ??= new SlidingWindowLimiter({ windowMs: WINDOW, max: 5 }));
const global_ = () => (g.__loginGlobal ??= new SlidingWindowLimiter({ windowMs: WINDOW, max: 20 }));
export function __resetLoginLimitersForTests(): void {
  g.__loginPerClient = undefined;
  g.__loginGlobal = undefined;
}

const Body = z.object({ password: z.string().min(1).max(MAX_PASSWORD_LENGTH) }).strict();

export async function handleLogin(req: Request): Promise<NextResponse> {
  const csrf = checkSameOriginJson(req);
  if (csrf) return csrf;

  const hash = getConfig().auth.passwordHash;
  if (!hash) return apiError("auth_not_configured"); // fail closed: no default credentials, ever

  const key = clientKey(req);
  const a = perClient().check(key);
  const b = global_().check("all");
  if (!a.allowed || !b.allowed) {
    log("warn", "auth.login_throttled", {});
    return apiError("rate_limited", { retryAfterSec: Math.max(a.retryAfterSec, b.retryAfterSec) });
  }

  let parsed: z.infer<typeof Body>;
  try {
    const text = await req.text();
    if (text.length > 2048) return apiError("bad_request");
    parsed = Body.parse(JSON.parse(text));
  } catch {
    return apiError("bad_request");
  }

  const ok = await verifyPassword(parsed.password, hash.reveal());
  if (!ok) {
    perClient().record(key);
    global_().record("all");
    log("warn", "auth.login_failed", {});
    return apiError("invalid_credentials");
  }

  const session = createSession();
  log("info", "auth.login_ok", {});
  const res = apiJson({ ok: true });
  res.headers.append("Set-Cookie", buildSetCookie(session.id));
  return res;
}

export async function handleLogout(req: Request): Promise<NextResponse> {
  const csrf = checkSameOriginJson(req);
  if (csrf) return csrf;
  destroySession(parseCookieHeader(req.headers.get("cookie"), sessionCookieName()));
  const res = apiJson({ ok: true });
  res.headers.append("Set-Cookie", buildClearCookie());
  return res;
}
