import { randomBytes, scrypt as scryptCb, timingSafeEqual, type ScryptOptions } from "node:crypto";

/**
 * Password hashing with scrypt (Node built-in, memory-hard, no native add-on).
 * Format: scrypt$<N>$<r>$<p>$<salt b64url>$<hash b64url>
 */
const KEYLEN = 32;
const DEFAULT = { N: 1 << 15, r: 8, p: 1 } as const;
const MAX_N = 1 << 17;
export const MAX_PASSWORD_LENGTH = 256;
export const MIN_PASSWORD_LENGTH = 12;

function scryptAsync(pw: string, salt: Buffer, keylen: number, opts: ScryptOptions): Promise<Buffer> {
  return new Promise((resolve, reject) => {
    scryptCb(pw, salt, keylen, opts, (err, key) => (err ? reject(err) : resolve(key)));
  });
}

const maxmem = (N: number, r: number) => 128 * N * r * 2 + 1024 * 1024;

export async function hashPassword(password: string, params: { N: number; r: number; p: number } = DEFAULT): Promise<string> {
  if (password.length < MIN_PASSWORD_LENGTH) throw new Error(`Password must be at least ${MIN_PASSWORD_LENGTH} characters`);
  if (password.length > MAX_PASSWORD_LENGTH) throw new Error("Password is too long");
  const salt = randomBytes(16);
  const key = await scryptAsync(password.normalize("NFKC"), salt, KEYLEN, { ...params, maxmem: maxmem(params.N, params.r) });
  return ["scrypt", params.N, params.r, params.p, salt.toString("base64url"), key.toString("base64url")].join("$");
}

export async function verifyPassword(password: string, stored: string): Promise<boolean> {
  if (typeof password !== "string" || password.length === 0 || password.length > MAX_PASSWORD_LENGTH) return false;
  const parts = stored.split("$");
  if (parts.length !== 6 || parts[0] !== "scrypt") return false;
  const N = Number(parts[1]);
  const r = Number(parts[2]);
  const p = Number(parts[3]);
  if (!Number.isInteger(N) || !Number.isInteger(r) || !Number.isInteger(p)) return false;
  if (N < 1 << 12 || N > MAX_N || (N & (N - 1)) !== 0 || r < 1 || r > 16 || p < 1 || p > 4) return false;
  const salt = Buffer.from(parts[4]!, "base64url");
  const expected = Buffer.from(parts[5]!, "base64url");
  if (salt.length < 8 || expected.length !== KEYLEN) return false;
  try {
    const actual = await scryptAsync(password.normalize("NFKC"), salt, KEYLEN, { N, r, p, maxmem: maxmem(N, r) });
    return timingSafeEqual(actual, expected);
  } catch {
    return false;
  }
}

/**
 * The exact `.env.local` line to print for a hash. LIVE FINDING (Phase 1F): Next's env loader (dotenv-expand) interpolates `$name` EVEN INSIDE
 * SINGLE QUOTES, so `'scrypt$4096$…'` was silently truncated to `scrypt` and every login failed. Each `$` must be escaped as `\$`; the line is
 * double-quoted so that it is also read verbatim-safe by other dotenv parsers. Round-trip tested against `@next/env`.
 */
export function envLineFor(hash: string): string {
  if (!/^[A-Za-z0-9$_.+\/=-]+$/.test(hash)) throw new Error("unexpected characters in password hash");
  return `APP_ACCESS_PASSWORD_HASH="${hash.replace(/\$/g, "\\$")}"`;
}
