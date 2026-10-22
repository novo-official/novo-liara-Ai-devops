import { createHmac, randomBytes } from "node:crypto";
import { inspect } from "node:util";

/** Wraps a secret so it cannot be serialized, logged or interpolated by accident. */
export class Secret {
  readonly #value: string;
  constructor(value: string) {
    this.#value = value;
  }
  reveal(): string {
    return this.#value;
  }
  toJSON(): string {
    return "[REDACTED]";
  }
  toString(): string {
    return "[REDACTED]";
  }
  [inspect.custom](): string {
    return "Secret([REDACTED])";
  }
}

/**
 * Secret values we know about. Stored as per-process HMAC digests (random key), so the
 * registry itself never holds plaintext. Used by the redactor to mask exact tokens.
 */
const FINGERPRINT_KEY = randomBytes(32);
const MIN_LEN = 6;
const MAX_LEN = 512;
const MAX_ENTRIES = 2000;

const g = globalThis as unknown as { __fp?: Set<string> };
const fingerprints: Set<string> = (g.__fp ??= new Set<string>());

function fp(value: string): string {
  return createHmac("sha256", FINGERPRINT_KEY).update(value).digest("base64");
}

/** Registers a value to be masked wherever it appears as a whole token. */
export function registerSecret(value: string): void {
  if (value.length < MIN_LEN || value.length > MAX_LEN) return;
  if (fingerprints.size >= MAX_ENTRIES) {
    const first = fingerprints.values().next().value;
    if (first !== undefined) fingerprints.delete(first);
  }
  fingerprints.add(fp(value));
}

export function isRegisteredSecret(token: string): boolean {
  if (token.length < MIN_LEN || token.length > MAX_LEN) return false;
  return fingerprints.has(fp(token));
}

export function hasRegisteredSecrets(): boolean {
  return fingerprints.size > 0;
}

export function __resetSecretsForTests(): void {
  fingerprints.clear();
}
