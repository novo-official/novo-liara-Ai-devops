import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { loadEnvConfig } from "@next/env";
import { envLineFor, hashPassword, MAX_PASSWORD_LENGTH, verifyPassword } from "@/server/security/password";
import { SlidingWindowLimiter } from "@/server/security/rate-limit";
import {
  __clearSessionsForTests,
  __setClockForTests,
  buildClearCookie,
  buildSetCookie,
  createSession,
  destroySession,
  getSession,
  parseCookieHeader,
} from "@/server/security/session";
import { __setConfigForTests } from "@/server/config/env";
import { makeConfig } from "../helpers/live";

const FAST = { N: 4096, r: 8, p: 1 };

describe("password hashing (scrypt)", () => {
  it("verifies the right password and rejects wrong ones", async () => {
    const h = await hashPassword("a-long-enough-password", FAST);
    expect(h.startsWith("scrypt$4096$8$1$")).toBe(true);
    expect(await verifyPassword("a-long-enough-password", h)).toBe(true);
    expect(await verifyPassword("a-long-enough-passworD", h)).toBe(false);
    expect(await verifyPassword("", h)).toBe(false);
  });

  it("uses a fresh salt per hash", async () => {
    const [a, b] = await Promise.all([hashPassword("same-password-123", FAST), hashPassword("same-password-123", FAST)]);
    expect(a).not.toBe(b);
  });

  it("rejects short and oversized passwords at hash time and oversized at verify time", async () => {
    await expect(hashPassword("short", FAST)).rejects.toThrow();
    await expect(hashPassword("x".repeat(MAX_PASSWORD_LENGTH + 1), FAST)).rejects.toThrow();
    const h = await hashPassword("a-long-enough-password", FAST);
    expect(await verifyPassword("x".repeat(MAX_PASSWORD_LENGTH + 1), h)).toBe(false);
  });

  it.each([
    "",
    "plaintext",
    "scrypt$bad",
    "bcrypt$4096$8$1$AAAA$AAAA",
    "scrypt$999999999$8$1$AAAAAAAAAAAAAAAAAAAAAA$AAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA", // DoS-sized N
    "scrypt$4097$8$1$AAAAAAAAAAAAAAAAAAAAAA$AAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA", // N not power of 2
    "scrypt$4096$8$1$AA$AA",
  ])("fails closed on malformed stored hash %j", async (stored) => {
    expect(await verifyPassword("whatever-password-1", stored)).toBe(false);
  });
});

describe("SlidingWindowLimiter", () => {
  it("blocks after max events inside the window and recovers after it", () => {
    let t = 0;
    const l = new SlidingWindowLimiter({ windowMs: 1000, max: 3 }, () => t);
    for (let i = 0; i < 3; i++) {
      expect(l.check("k").allowed).toBe(true);
      l.record("k");
    }
    const blocked = l.check("k");
    expect(blocked.allowed).toBe(false);
    expect(blocked.retryAfterSec).toBeGreaterThanOrEqual(1);
    expect(l.check("other").allowed).toBe(true);
    t = 1001;
    expect(l.check("k").allowed).toBe(true);
  });

  it("bounds memory by collapsing overflow keys into one bucket", () => {
    const l = new SlidingWindowLimiter({ windowMs: 1000, max: 2, maxKeys: 3 });
    for (let i = 0; i < 3; i++) l.record(`k${i}`); // table is now full
    expect(l.check("fresh-1").allowed).toBe(true);
    l.record("fresh-1");
    l.record("fresh-2");
    // unseen keys now share one bucket, so the flood saturates instead of growing memory
    expect(l.check("fresh-3").allowed).toBe(false);
    expect(l.check("k0").allowed).toBe(true); // existing keys keep their own budget
  });
});

describe("sessions", () => {
  beforeEach(() => {
    __setConfigForTests(makeConfig({ SESSION_IDLE_TIMEOUT_MINUTES: "10", SESSION_ABSOLUTE_TIMEOUT_HOURS: "1" }));
    __clearSessionsForTests();
  });
  afterEach(() => {
    __setClockForTests(undefined);
    __setConfigForTests(undefined);
  });

  it("creates high-entropy opaque ids and validates them", () => {
    const s = createSession();
    expect(s.id).toMatch(/^[A-Za-z0-9_-]{43}$/);
    expect(getSession(s.id)?.id).toBe(s.id);
    expect(getSession("nope")).toBeNull();
    expect(getSession("A".repeat(43))).toBeNull();
    expect(getSession(undefined)).toBeNull();
    expect(getSession("__proto__")).toBeNull();
  });

  it("expires on idle timeout and on absolute lifetime; logout revokes", () => {
    let now = 1_000_000;
    __setClockForTests(() => now);
    const s = createSession();
    now += 9 * 60_000;
    expect(getSession(s.id)).not.toBeNull(); // activity refreshes idle timer
    now += 11 * 60_000;
    expect(getSession(s.id)).toBeNull(); // idle > 10 min

    const s2 = createSession();
    for (let i = 0; i < 7; i++) {
      now += 9 * 60_000;
      getSession(s2.id);
    }
    now += 9 * 60_000;
    expect(getSession(s2.id)).toBeNull(); // > 1 h absolute even though active

    const s3 = createSession();
    destroySession(s3.id);
    expect(getSession(s3.id)).toBeNull();
  });

  it("caps concurrent sessions", () => {
    const ids = Array.from({ length: 30 }, () => createSession().id);
    expect(getSession(ids[0])).toBeNull();
    expect(getSession(ids[29])).not.toBeNull();
  });

  it("builds hardened cookies (production adds Secure + __Host- prefix)", () => {
    const dev = buildSetCookie("abc");
    expect(dev).toMatch(/HttpOnly/);
    expect(dev).toMatch(/SameSite=Strict/);
    expect(dev).toMatch(/Path=\//);
    expect(dev).not.toMatch(/Secure/);

    __setConfigForTests(makeConfig({ NODE_ENV: "production" }));
    const prod = buildSetCookie("abc");
    expect(prod.startsWith("__Host-")).toBe(true);
    expect(prod).toMatch(/; Secure/);
    expect(prod).not.toMatch(/Domain=/);
    expect(buildClearCookie()).toMatch(/Max-Age=0/);
  });

  it("parses cookie headers defensively", () => {
    expect(parseCookieHeader("a=1; liara_agent_session=xyz; b=2", "liara_agent_session")).toBe("xyz");
    expect(parseCookieHeader("evil_liara_agent_session=xyz", "liara_agent_session")).toBeUndefined();
    expect(parseCookieHeader(null, "x")).toBeUndefined();
  });
});


describe("the .env.local line printed by `npm run hash-password` survives Next's env loader (live finding)", () => {
  it("round-trips through @next/env and still verifies; the old single-quoted form was truncated", async () => {
    const hash = await hashPassword("a-long-enough-password-123", FAST);
    const dir = mkdtempSync(path.join(tmpdir(), "envline-"));
    const prev = process.env.APP_ACCESS_PASSWORD_HASH;
    vi.stubEnv("NODE_ENV", "production"); // Next skips .env.local when NODE_ENV=test
    try {
      delete process.env.APP_ACCESS_PASSWORD_HASH;
      writeFileSync(path.join(dir, ".env.local"), `${envLineFor(hash)}\n`);
      loadEnvConfig(dir, false, undefined, true);
      expect(process.env.APP_ACCESS_PASSWORD_HASH).toBe(hash);
      expect(await verifyPassword("a-long-enough-password-123", process.env.APP_ACCESS_PASSWORD_HASH!)).toBe(true);
      // regression: the previously printed form
      delete process.env.APP_ACCESS_PASSWORD_HASH;
      writeFileSync(path.join(dir, ".env.local"), `APP_ACCESS_PASSWORD_HASH='${hash}'\n`);
      loadEnvConfig(dir, false, undefined, true);
      expect(process.env.APP_ACCESS_PASSWORD_HASH).not.toBe(hash);
    } finally {
      vi.unstubAllEnvs();
      if (prev === undefined) delete process.env.APP_ACCESS_PASSWORD_HASH;
      else process.env.APP_ACCESS_PASSWORD_HASH = prev;
      rmSync(dir, { recursive: true, force: true });
    }
  });
  it("refuses to format anything that is not a plain hash", () => {
    for (const bad of ['x"; rm -rf /', "a b", "x\ny", ""]) expect(() => envLineFor(bad)).toThrow();
  });
});
