import "server-only";
import { z } from "zod";
import { TRUSTED_LIARA_HOSTS } from "../config/env";
import { log } from "../security/logger";
import { ENDPOINTS, buildPath, type EndpointDef, type EndpointId } from "./endpoints";
import { httpStatusToCode, LiaraError, type ErrorShape } from "./errors";
import { SlidingWindowLimiter } from "../security/rate-limit";
import { issuesOf } from "./schemas";
import { redactText } from "../security/redact";
import type { Secret } from "../security/secret";

export interface HttpClientOptions {
  baseUrl: URL;
  token: Secret;
  teamId: string | null;
  timeoutMs: number;
  maxConcurrency: number;
  maxRps: number;
  fetchImpl?: typeof fetch;
  sleep?: (ms: number) => Promise<void>;
  now?: () => number;
  /** Rolling per-minute cap on upstream attempts (retries count). Default 120. */
  budgetPerMinute?: number;
  /** Hard cap on attempts for this client's lifetime (used by the verification command). */
  maxTotalRequests?: number;
}

const ERROR_BODY_PEEK_BYTES = 2048;
const MAX_ATTEMPTS = 3; // 1 try + 2 retries, GET only
const MAX_RETRY_AFTER_MS = 5000;
const RETRYABLE_STATUS = new Set([429, 502, 503, 504]);

/**
 * The single egress point to Liara. Read-only by construction:
 *  - exposes ONLY `get()`; there is no code path that sets any other HTTP method
 *  - the endpoint must be a registered EndpointDef (all GET)
 *  - host is pinned to TRUSTED_LIARA_HOSTS and re-validated per request
 *  - redirects are never followed (so the bearer token cannot be forwarded elsewhere)
 *  - bounded timeout, response size, retries, concurrency and request rate
 */
export class LiaraHttpClient {
  readonly mode = "live" as const;
  readonly #token: Secret;
  readonly #o: Required<Omit<HttpClientOptions, "token" | "maxTotalRequests">>;
  readonly #maxTotal: number;
  readonly #budget: SlidingWindowLimiter;
  #total = 0;
  #active = 0;
  #waiters: Array<() => void> = [];
  #lastStart = 0;

  constructor(opts: HttpClientOptions) {
    if (!TRUSTED_LIARA_HOSTS.includes(opts.baseUrl.hostname) || opts.baseUrl.protocol !== "https:") {
      throw new LiaraError("not_configured", "Untrusted Liara base URL");
    }
    this.#token = opts.token;
    this.#o = {
      baseUrl: opts.baseUrl,
      teamId: opts.teamId,
      timeoutMs: opts.timeoutMs,
      maxConcurrency: opts.maxConcurrency,
      maxRps: opts.maxRps,
      fetchImpl: opts.fetchImpl ?? fetch,
      sleep: opts.sleep ?? ((ms) => new Promise((r) => setTimeout(r, ms))),
      now: opts.now ?? Date.now,
      budgetPerMinute: opts.budgetPerMinute ?? 120,
    };
    this.#maxTotal = opts.maxTotalRequests ?? Number.POSITIVE_INFINITY;
    this.#budget = new SlidingWindowLimiter({ windowMs: 60_000, max: this.#o.budgetPerMinute }, this.#o.now);
  }

  toJSON() {
    return { client: "LiaraHttpClient", token: "[REDACTED]" };
  }

  async get<S extends z.ZodType>(
    endpointId: EndpointId,
    args: { name?: string; query?: Record<string, string | number | boolean> },
    schema: S,
  ): Promise<z.output<S>> {
    const def: EndpointDef = ENDPOINTS[endpointId];
    if (!def || def.method !== "GET") throw new LiaraError("unsupported", "Unsupported endpoint");

    const url = new URL(buildPath(def, args.name), this.#o.baseUrl);
    for (const [k, v] of Object.entries(args.query ?? {})) url.searchParams.set(k, String(v));
    if (this.#o.teamId) url.searchParams.set("teamID", this.#o.teamId);
    // Defence in depth: the final origin must still be the trusted one.
    if (url.origin !== this.#o.baseUrl.origin || !TRUSTED_LIARA_HOSTS.includes(url.hostname)) {
      throw new LiaraError("not_configured", "Refusing request to untrusted origin");
    }

    const deadline = this.#o.now() + this.#o.timeoutMs * 2.5;
    let lastErr: LiaraError | undefined;
    for (let attempt = 1; attempt <= MAX_ATTEMPTS; attempt++) {
      try {
        const raw = await this.#once(def, url);
        const parsed = schema.safeParse(raw);
        if (!parsed.success) {
          throw new LiaraError("contract_mismatch", "Upstream response did not match the expected contract", {
            issues: issuesOf(parsed.error).map((i) => ({ path: redactText(i.path, { maxLength: 80 }), code: i.code })),
            endpoint: def.id,
          });
        }
        return parsed.data;
      } catch (e) {
        const err = e instanceof LiaraError ? e : new LiaraError("network", "Network error", { endpoint: def.id });
        lastErr = err;
        const retryable =
          err.code === "network" ||
          err.code === "timeout" ||
          (err.status !== undefined && RETRYABLE_STATUS.has(err.status));
        if (!retryable || attempt === MAX_ATTEMPTS) throw err;
        const backoff = Math.min(
          err.opts.retryAfterSec !== undefined ? err.opts.retryAfterSec * 1000 : 250 * 2 ** (attempt - 1),
          MAX_RETRY_AFTER_MS,
        );
        const wait = backoff + Math.floor(Math.random() * 100);
        if (this.#o.now() + wait > deadline) throw err;
        log("warn", "liara.retry", { endpoint: def.id, attempt, code: err.code, status: err.status });
        await this.#o.sleep(wait);
      }
    }
    throw lastErr ?? new LiaraError("network", "Network error");
  }

  async #once(def: EndpointDef, url: URL): Promise<unknown> {
    await this.#acquire();
    const started = this.#o.now();
    try {
      // Request budgets (every attempt, including retries, counts). Local exhaustion is never retried.
      if (this.#total >= this.#maxTotal) {
        throw new LiaraError("rate_limited", "Request budget for this run is exhausted", { endpoint: def.id });
      }
      const slot = this.#budget.take("all");
      if (!slot.allowed) {
        throw new LiaraError("rate_limited", "Local upstream request budget exhausted", { endpoint: def.id, retryAfterSec: slot.retryAfterSec });
      }
      this.#total++;
      let res: Response;
      try {
        res = await this.#o.fetchImpl(url, {
          method: "GET", // fixed literal: this class cannot issue any other method
          redirect: "manual",
          cache: "no-store",
          headers: {
            Authorization: `Bearer ${this.#token.reveal()}`,
            Accept: "application/json",
            "User-Agent": "liara-devops-agent/0.1 (read-only)",
          },
          signal: AbortSignal.timeout(this.#o.timeoutMs),
        });
      } catch (e) {
        const name = (e as { name?: string })?.name;
        if (name === "TimeoutError" || name === "AbortError") {
          throw new LiaraError("timeout", "Upstream request timed out", { endpoint: def.id });
        }
        throw new LiaraError("network", "Network error", { endpoint: def.id });
      }

      log("info", "liara.response", { endpoint: def.id, status: res.status, ms: this.#o.now() - started });

      if (res.status >= 300 && res.status < 400) {
        await res.body?.cancel().catch(() => undefined);
        throw new LiaraError("upstream_error", "Unexpected redirect from upstream", { status: res.status, endpoint: def.id });
      }
      if (res.status === 204 || res.status === 205) {
        // No Content: there is NOTHING to parse. Never JSON.parse an empty body, never reinterpret 204 as 200, never invent an empty payload.
        const unexpectedBody = res.body !== null && res.body !== undefined;
        await res.body?.cancel().catch(() => undefined);
        throw new LiaraError("no_content", `Upstream returned HTTP ${res.status} without a payload`, { status: res.status, endpoint: def.id, noContent: { unexpectedBody } });
      }
      if (!res.ok) {
        const errorShape = await this.#peekErrorShape(res);
        const raHeader = res.headers.get("retry-after");
        const ra = raHeader === null || raHeader.trim() === "" ? Number.NaN : Number(raHeader);
        throw new LiaraError(httpStatusToCode(res.status), `Upstream returned HTTP ${res.status}`, {
          status: res.status,
          endpoint: def.id,
          retryAfterSec: Number.isFinite(ra) && ra >= 0 ? ra : undefined,
          errorShape,
        });
      }
      try {
        return await this.#readJson(res, def);
      } catch (e) {
        if (e instanceof LiaraError) throw e;
        const name = (e as { name?: string })?.name;
        throw new LiaraError(name === "TimeoutError" || name === "AbortError" ? "timeout" : "network", "Upstream body read failed", { endpoint: def.id });
      }
    } finally {
      this.#release();
    }
  }

  /** Reads at most 2 KB of an error body and keeps ONLY its structure (key names). Content is discarded. */
  async #peekErrorShape(res: Response): Promise<ErrorShape> {
    const ct = (res.headers.get("content-type") ?? "").split(";")[0]!.trim().toLowerCase();
    const contentType = /^[a-z0-9.+-]+\/[a-z0-9.+-]+$/.test(ct) ? ct : null;
    try {
      if (!res.body) return { contentType, kind: "empty", bytes: 0 };
      const reader = res.body.getReader();
      const chunks: Uint8Array[] = [];
      let total = 0;
      while (total < ERROR_BODY_PEEK_BYTES) {
        const { done, value } = await reader.read();
        if (done) break;
        chunks.push(value);
        total += value.byteLength;
      }
      await reader.cancel().catch(() => undefined);
      if (total === 0) return { contentType, kind: "empty", bytes: 0 };
      const text = Buffer.concat(chunks).toString("utf8");
      try {
        const parsed: unknown = JSON.parse(text);
        if (Array.isArray(parsed)) return { contentType, kind: "json-array", bytes: total };
        if (parsed && typeof parsed === "object") {
          const keys = Object.keys(parsed).filter((k) => /^[A-Za-z_][A-Za-z0-9_-]{0,31}$/.test(k)).slice(0, 10);
          return { contentType, kind: "json-object", keys, bytes: total };
        }
        return { contentType, kind: "json-other", bytes: total };
      } catch {
        return { contentType, kind: "text", bytes: total };
      }
    } catch {
      return { contentType, kind: "empty", bytes: 0 };
    }
  }

  async #readJson(res: Response, def: EndpointDef): Promise<unknown> {
    const declared = Number(res.headers.get("content-length"));
    if (Number.isFinite(declared) && declared > def.maxBytes) {
      await res.body?.cancel().catch(() => undefined);
      throw new LiaraError("response_too_large", "Upstream response too large", { endpoint: def.id });
    }
    const ct = res.headers.get("content-type") ?? "";
    if (!res.body) return undefined;
    const reader = res.body.getReader();
    const chunks: Uint8Array[] = [];
    let total = 0;
    for (;;) {
      const { done, value } = await reader.read();
      if (done) break;
      total += value.byteLength;
      if (total > def.maxBytes) {
        await reader.cancel().catch(() => undefined);
        throw new LiaraError("response_too_large", "Upstream response too large", { endpoint: def.id });
      }
      chunks.push(value);
    }
    if (total === 0) return undefined;
    if (!/json/i.test(ct)) {
      throw new LiaraError("contract_mismatch", "Upstream response was not JSON", { endpoint: def.id, issues: [{ path: "(content-type)", code: "invalid_type" }] });
    }
    try {
      return JSON.parse(Buffer.concat(chunks).toString("utf8"));
    } catch {
      throw new LiaraError("contract_mismatch", "Upstream returned malformed JSON", { endpoint: def.id, issues: [{ path: "(body)", code: "invalid_json" }] });
    }
  }

  // ----- concurrency + rate limiting -----
  async #acquire(): Promise<void> {
    while (this.#active >= this.#o.maxConcurrency) {
      await new Promise<void>((r) => this.#waiters.push(r));
    }
    this.#active++;
    const minGap = Math.ceil(1000 / this.#o.maxRps);
    const wait = this.#lastStart + minGap - this.#o.now();
    this.#lastStart = Math.max(this.#o.now(), this.#lastStart + minGap);
    if (wait > 0) await this.#o.sleep(wait);
  }
  #release(): void {
    this.#active--;
    this.#waiters.shift()?.();
  }
}
