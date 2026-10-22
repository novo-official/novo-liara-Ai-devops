import "server-only";
import { TRUSTED_LIARA_HOSTS, type AppConfig } from "../config/env";
import { log } from "../security/logger";
import type { Secret } from "../security/secret";
import {
  classifyStatus,
  CreateAppRequestSchema,
  CreateReleaseRequestSchema,
  CreateReleaseResponseSchema,
  UploadSourceRequestSchema,
  UploadSourceResponseSchema,
  type CreateAppRequest,
  type CreateReleaseRequest,
  type CreateReleaseResponse,
  type LiveWriteTransport,
  type UploadSourceResponse,
  type WriteResult,
} from "./contract";
import { APP_NAME_REGEX } from "../config/env";
import { MAX_ARTIFACT_BYTES } from "./artifact";
import { describeResponse, safeContentType, type ResponseMeta } from "./response-shape";

/**
 * THE ONLY CODE IN THIS PROJECT THAT CAN SEND A WRITE REQUEST (static scans enforce that the string `"POST"` appears nowhere else in `src/`).
 *  - three fixed endpoint templates; the path is built from a validated app name, never from caller input
 *  - exactly ONE attempt per call: no retries, no redirects (`manual`), bounded timeouts, bounded response reads
 *  - classifies outcomes into "definitely rejected" vs "unknown outcome" so the caller can reconcile instead of retrying
 *  - never logs bodies, never stores or echoes upstream text
 *  - constructed only by `createLiveWriteClient`, which returns null unless live execution is explicitly configured; even then, the executor still
 *    refuses to call it without a fresh server-validated live approval.
 */

export interface WriteClientOptions {
  baseUrl: URL;
  token: Secret;
  teamId: string | null;
  /** createApp / createRelease */
  timeoutMs: number;
  /** source upload (the CLI disables the timeout; we bound it) */
  uploadTimeoutMs: number;
  fetchImpl?: typeof fetch;
  now?: () => number;
}

const MAX_RESPONSE_BYTES = 64 * 1024;

export class LiaraWriteClient implements LiveWriteTransport {
  readonly #o: Required<Omit<WriteClientOptions, "teamId">> & { teamId: string | null };
  constructor(opts: WriteClientOptions) {
    if (!TRUSTED_LIARA_HOSTS.includes(opts.baseUrl.hostname) || opts.baseUrl.protocol !== "https:") throw new Error("untrusted write host");
    this.#o = { ...opts, fetchImpl: opts.fetchImpl ?? fetch, now: opts.now ?? Date.now };
  }
  toJSON() {
    return { client: "LiaraWriteClient", token: "[REDACTED]" };
  }

  async createApp(req: CreateAppRequest): Promise<WriteResult<{ accepted: true }>> {
    const body = CreateAppRequestSchema.parse(req); // strict: unknown members are a bug, not a feature
    const r = await this.#send("createApp", "/v1/projects", { json: body }, this.#o.timeoutMs);
    if (!r.ok) return r;
    // [A] documents an EMPTY 200 body: the app id is not returned, so success is never claimed from this response alone
    return { ok: true, status: r.status, data: { accepted: true } };
  }

  async uploadSource(app: string, archive: Buffer): Promise<WriteResult<UploadSourceResponse>> {
    UploadSourceRequestSchema.parse({ app, filename: "source.tar.gz" });
    if (archive.length === 0 || archive.length > MAX_ARTIFACT_BYTES) throw new Error("archive size out of bounds");
    const form = new FormData();
    form.append("file", new Blob([new Uint8Array(archive)], { type: "application/gzip" }), "source.tar.gz");
    const r = await this.#send("uploadSource", `/v2/projects/${encodeURIComponent(app)}/sources`, { form }, this.#o.uploadTimeoutMs);
    if (!r.ok) return r;
    const parsed = UploadSourceResponseSchema.safeParse(r.json);
    if (parsed.success) return { ok: true, status: r.status, data: parsed.data };
    return this.#unreadable("uploadSource", r.meta, r.json, "sourceID");
  }

  async createRelease(app: string, req: CreateReleaseRequest): Promise<WriteResult<CreateReleaseResponse>> {
    if (!APP_NAME_REGEX.test(app)) throw new Error("invalid app name");
    const body = CreateReleaseRequestSchema.parse(req);
    const r = await this.#send("createRelease", `/v2/projects/${encodeURIComponent(app)}/releases`, { json: body }, this.#o.timeoutMs);
    if (!r.ok) return r;
    const parsed = CreateReleaseResponseSchema.safeParse(r.json);
    if (parsed.success) return { ok: true, status: r.status, data: parsed.data };
    return this.#unreadable("createRelease", r.meta, r.json, "releaseID");
  }

  /** A 2xx whose body could not be used: the request WAS accepted, so the outcome is unknown (never retried) — but the evidence is kept (shape only, never values). */
  #unreadable(op: string, meta: ResponseMeta, json: unknown, expectedKey: string): Extract<WriteResult<never>, { ok: false }> {
    const shape = describeResponse(meta, json, expectedKey);
    log("warn", "liara.write_unreadable", { op, shape });
    return { ok: false, kind: "unknown_outcome", status: meta.status, code: "malformed_response", shape };
  }

  async #send(op: "createApp" | "uploadSource" | "createRelease", path: string, payload: { json?: unknown; form?: FormData }, timeoutMs: number): Promise<{ ok: true; status: number; json: unknown; meta: ResponseMeta } | Extract<WriteResult<never>, { ok: false }>> {
    const url = new URL(path, this.#o.baseUrl);
    if (this.#o.teamId) url.searchParams.set("teamID", this.#o.teamId);
    if (url.origin !== this.#o.baseUrl.origin || !TRUSTED_LIARA_HOSTS.includes(url.hostname)) throw new Error("untrusted write origin");
    const headers: Record<string, string> = { Authorization: `Bearer ${this.#o.token.reveal()}`, Accept: "application/json", "User-Agent": "liara-devops-agent/0.1 (live-executor)" };
    if (payload.json !== undefined) headers["Content-Type"] = "application/json";
    const started = this.#o.now();
    let res: Response;
    try {
      res = await this.#o.fetchImpl(url, {
        method: "POST", // the only write verb this class can emit
        redirect: "manual",
        cache: "no-store",
        headers,
        body: payload.form ?? JSON.stringify(payload.json),
        signal: AbortSignal.timeout(timeoutMs),
      });
    } catch (e) {
      const name = (e as { name?: string })?.name;
      log("warn", "liara.write_unknown", { op, code: name === "TimeoutError" || name === "AbortError" ? "timeout" : "network", ms: this.#o.now() - started });
      return { ok: false, kind: "unknown_outcome", status: null, code: name === "TimeoutError" || name === "AbortError" ? "timeout" : "network" };
    }
    log("info", "liara.write_response", { op, status: res.status, ms: this.#o.now() - started });
    if (res.status < 200 || res.status >= 300) {
      await res.body?.cancel().catch(() => undefined); // bodies are unspecified and never used
      const c = classifyStatus(res.status);
      return c.kind === "rejected" ? { ok: false, kind: "rejected", status: res.status, code: c.code } : { ok: false, kind: "unknown_outcome", status: res.status, code: c.code };
    }
    // 2xx: read a bounded body (may be empty, per [A])
    const contentType = safeContentType(res.headers.get("content-type"));
    const meta = (body: ResponseMeta["body"], bytes: number, firstChar?: string): ResponseMeta => ({ status: res.status, contentType, bytes, body, firstChar });
    const unreadable = (m: ResponseMeta): Extract<WriteResult<never>, { ok: false }> => this.#unreadable(op, m, undefined, op === "createRelease" ? "releaseID" : "sourceID");
    let total = 0;
    try {
      const reader = res.body?.getReader();
      const chunks: Uint8Array[] = [];
      for (;;) {
        const part = reader ? await reader.read() : { done: true as const, value: undefined };
        if (part.done) break;
        total += part.value.byteLength;
        if (total > MAX_RESPONSE_BYTES) {
          await reader?.cancel().catch(() => undefined);
          return unreadable(meta("too_large", total));
        }
        chunks.push(part.value);
      }
      if (total === 0) return { ok: true, status: res.status, json: undefined, meta: meta("empty", 0) };
      const text = Buffer.concat(chunks).toString("utf8");
      try {
        return { ok: true, status: res.status, json: JSON.parse(text), meta: meta("json", total) };
      } catch {
        return unreadable(meta("non_json", total, text.trimStart().charAt(0)));
      }
    } catch {
      return unreadable(meta("non_json", total));
    }
  }
}

/** Disabled by default: returns null unless live execution is configured. Presence of a client never authorises anything. */
export function createLiveWriteClient(cfg: AppConfig, deps: { fetchImpl?: typeof fetch; now?: () => number } = {}): LiaraWriteClient | null {
  if (!cfg.live.enabled || cfg.dataSource !== "live" || !cfg.liara.token) return null;
  return new LiaraWriteClient({ baseUrl: cfg.liara.baseUrl, token: cfg.liara.token, teamId: cfg.liara.teamId, timeoutMs: Math.min(cfg.liara.timeoutMs, 30_000), uploadTimeoutMs: 180_000, ...deps });
}
