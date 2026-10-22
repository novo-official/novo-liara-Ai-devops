import { randomBytes, timingSafeEqual } from "node:crypto";
import { getConfig } from "../config/env";

/**
 * Opaque server-side sessions (revocable). The cookie holds a random 256-bit id only.
 * Single-instance, in-memory: sessions are lost on restart (acceptable for Phase 1A).
 */
export interface Session {
  id: string;
  createdAt: number;
  lastSeenAt: number;
}

const MAX_SESSIONS = 20;
const g = globalThis as unknown as { __sessions?: Map<string, Session> };
const store: Map<string, Session> = (g.__sessions ??= new Map());

let clock: () => number = Date.now;
export function __setClockForTests(fn: (() => number) | undefined): void {
  clock = fn ?? Date.now;
}
export function __clearSessionsForTests(): void {
  store.clear();
}

const ID_RE = /^[A-Za-z0-9_-]{43}$/;

export function createSession(): Session {
  const now = clock();
  // Evict expired, then oldest, to keep memory bounded.
  for (const [id] of store) if (isExpired(store.get(id)!, now)) store.delete(id);
  while (store.size >= MAX_SESSIONS) {
    const oldest = store.keys().next().value;
    if (oldest === undefined) break;
    store.delete(oldest);
  }
  const s: Session = { id: randomBytes(32).toString("base64url"), createdAt: now, lastSeenAt: now };
  store.set(s.id, s);
  return s;
}

function isExpired(s: Session, now: number): boolean {
  const { idleTimeoutMs, absoluteTimeoutMs } = getConfig().auth;
  return now - s.lastSeenAt > idleTimeoutMs || now - s.createdAt > absoluteTimeoutMs;
}

export function getSession(id: string | undefined | null): Session | null {
  if (!id || !ID_RE.test(id)) return null;
  const now = clock();
  // Constant-time-ish lookup is unnecessary for a hash-map keyed by 256-bit random ids, but we still
  // compare the stored id to the presented one to defend against prototype-key tricks.
  const s = store.get(id);
  if (!s) return null;
  const a = Buffer.from(s.id);
  const b = Buffer.from(id);
  if (a.length !== b.length || !timingSafeEqual(a, b)) return null;
  if (isExpired(s, now)) {
    store.delete(id);
    return null;
  }
  s.lastSeenAt = now;
  return s;
}

export function destroySession(id: string | undefined | null): void {
  if (id) store.delete(id);
}

export function sessionCookieName(): string {
  return getConfig().auth.secureCookies ? "__Host-liara_agent_session" : "liara_agent_session";
}

export function sessionCookieAttributes(maxAgeSec?: number): string {
  const { secureCookies, absoluteTimeoutMs } = getConfig().auth;
  const parts = ["Path=/", "HttpOnly", "SameSite=Strict", `Max-Age=${maxAgeSec ?? Math.floor(absoluteTimeoutMs / 1000)}`];
  if (secureCookies) parts.push("Secure");
  return parts.join("; ");
}

export function buildSetCookie(sessionId: string): string {
  return `${sessionCookieName()}=${sessionId}; ${sessionCookieAttributes()}`;
}

export function buildClearCookie(): string {
  return `${sessionCookieName()}=; ${sessionCookieAttributes(0)}`;
}

export function parseCookieHeader(header: string | null | undefined, name: string): string | undefined {
  if (!header) return undefined;
  for (const part of header.split(";")) {
    const idx = part.indexOf("=");
    if (idx < 0) continue;
    if (part.slice(0, idx).trim() === name) return part.slice(idx + 1).trim();
  }
  return undefined;
}
