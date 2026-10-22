import { z } from "zod";
import { APP_NAME_REGEX } from "../config/env";
import type { ResponseShape } from "./response-shape";

/**
 * THE WRITE CONTRACT — exactly three typed operations, validated with strict zod schemas. There is no generic request type anywhere in `live/`.
 *
 * Evidence classes (see docs/LIVE_DEPLOYMENT_EXECUTOR.md):
 *   [A] documented in the pinned OpenAPI (`paas.yaml`, commit 338325a4)     [C] observed ONLY in the official CLI source (not documentation)
 *   POST /v1/projects                  body [A] name, planID, platform, readOnlyRootFilesystem, network   [C] bundlePlanID, network (ALWAYS sent by the CLI)
 *                                      response [A] 200 with an EMPTY body (the new app id is not returned) · 400, 401, 409   [C] 402 (balance), 403
 *   POST /v2/projects/{name}/sources   multipart field `file` [A] ("The .gz file to deploy") → {sourceID} [A] · 400, 401, 404   [C] 413 (size)
 *   POST /v2/projects/{name}/releases  body [A] sourceID, port, type   [C] platformConfig, build (always sent by the CLI) → {releaseID} [A] · 400, 401, 404
 * Error bodies are unspecified upstream (empty `content`); this layer therefore classifies by HTTP STATUS only and never trusts or stores a body.
 * Which of the [C] fields are REQUIRED has never been verified live: the operator must attest to the contract (LIARA_LIVE_CONTRACT_ATTESTED) before any write.
 */

export const PLAN_ID = /^[A-Za-z0-9][A-Za-z0-9_.-]{0,59}$/;
const OPAQUE_ID = /^[A-Za-z0-9][A-Za-z0-9_-]{2,127}$/;
/**
 * Identifiers RETURNED by Liara (`sourceID`, `releaseID`). The OpenAPI only says `type: string` and the official CLI performs NO validation at all (it forwards
 * `response.sourceID` verbatim), so no format may be invented: the first real upload ended "unknown" with a 2xx answer whose `sourceID` this project had refused to
 * read. Local acceptance policy: 1–256 printable ASCII characters without whitespace, quotes or backslash. This defensive bound is NOT specified by Liara and is
 * a subset of the documented string type, not a guarantee of accepting every vendor string. Unsupported strings keep an unknown outcome and are never retried.
 * The value is only ever re-sent to Liara as a JSON string, rendered
 * escaped and passed through the redaction layer; it is never put in a path, a shell or an HTML attribute.
 */
export const VENDOR_ID = /^[\x21\x23-\x26\x28-\x5b\x5d-\x7e]{1,256}$/;

/** Platforms the live executor can deploy (ids as observed in the CLI's AVAILABLE_PLATFORMS; unverified live). */
export const LIVE_PLATFORMS = ["next", "static"] as const;
export type LivePlatform = (typeof LIVE_PLATFORMS)[number];

export const CreateAppRequestSchema = z
  .object({
    name: z.string().regex(APP_NAME_REGEX),
    planID: z.string().regex(PLAN_ID),
    platform: z.enum(LIVE_PLATFORMS),
    /** [C] always sent by the CLI (taken from plans.projectBundlePlans[planID]) */
    bundlePlanID: z.string().regex(PLAN_ID),
    /** [C] always sent by the CLI (an `_id` from GET /v1/networks); never invented here */
    network: z.string().regex(OPAQUE_ID),
    /** [A] optional; omitted unless set */
    readOnlyRootFilesystem: z.boolean().optional(),
  })
  .strict();
export type CreateAppRequest = z.infer<typeof CreateAppRequestSchema>;

export const UploadSourceRequestSchema = z.object({ app: z.string().regex(APP_NAME_REGEX), filename: z.literal("source.tar.gz") }).strict();
export const UploadSourceResponseSchema = z.object({ sourceID: z.string().regex(VENDOR_ID) });
export type UploadSourceResponse = z.infer<typeof UploadSourceResponseSchema>;

export const GitInfoNonRepoSchema = z
  .object({ branch: z.null(), message: z.null(), commit: z.null(), committedAt: z.null(), remote: z.null(), author: z.object({ email: z.null(), name: z.null() }).strict(), tags: z.array(z.never()).max(0) })
  .strict();
export const NON_REPO_GIT_INFO: z.infer<typeof GitInfoNonRepoSchema> = { branch: null, message: null, commit: null, committedAt: null, remote: null, author: { email: null, name: null }, tags: [] };

export const CreateReleaseRequestSchema = z
  .object({
    sourceID: z.string().regex(VENDOR_ID),
    port: z.number().int().min(1).max(65535),
    /** [A] "The platform of your app" */
    type: z.enum(LIVE_PLATFORMS),
    /** [C] always sent by the CLI; for Next.js it is the liara.json "next" section or {} (the CLI auto-detects a version only for node/python/php/dotnet/go, never for `next`) — this project never reads liara.json, so it is {} */
    platformConfig: z.object({}).strict(),
    /** [C] the CLI sends `{cache, args, dockerfile, location}`; `cache` defaults to TRUE (`!(no-cache || build.cache === false)`) and the rest are undefined ⇒ `{"cache":true}` on the wire.
     * (Phase 2A wrongly assumed `{}`; corrected after the Phase 2B CLI review.) */
    build: z.object({ cache: z.literal(true) }).strict(),
    /**
     * [C] the CLI ALWAYS sends `gitInfo` for a source deploy. For a directory that is not a git repository (our case: a private temp dir from the approved ZIP) every
     * `git` lookup fails and the CLI's `retrieveConfig` yields `null`, so the body carries EXACTLY this object (tags `[]`). It is mirrored verbatim so that this request
     * is the one the vendor's own client sends for a non-git folder; it contains no data about the operator, the machine or the code.
     */
    gitInfo: GitInfoNonRepoSchema,
  })
  .strict();
export type CreateReleaseRequest = z.infer<typeof CreateReleaseRequestSchema>;
export const CreateReleaseResponseSchema = z.object({ releaseID: z.string().regex(VENDOR_ID) });
export type CreateReleaseResponse = z.infer<typeof CreateReleaseResponseSchema>;

export type WriteErrorCode =
  | "bad_request"
  | "unauthorized"
  | "insufficient_balance"
  | "forbidden"
  | "not_found"
  | "already_exists"
  | "payload_too_large"
  | "rate_limited"
  | "rejected_other"
  | "timeout"
  | "network"
  | "server_error"
  | "malformed_response"
  | "unexpected_redirect";

export type WriteResult<T> =
  | { ok: true; status: number; data: T }
  /** the API DEFINITELY did not accept the request (a 4xx other than 408): safe to treat as "nothing happened" */
  | { ok: false; kind: "rejected"; status: number; code: WriteErrorCode }
  /** the outcome is UNKNOWN (timeout, network error, 5xx, redirect, unreadable 2xx): NEVER retried blindly — reconcile remote state first */
  | { ok: false; kind: "unknown_outcome"; status: number | null; code: WriteErrorCode; shape?: ResponseShape };

export function classifyStatus(status: number): { kind: "rejected" | "unknown_outcome"; code: WriteErrorCode } {
  if (status === 400) return { kind: "rejected", code: "bad_request" };
  if (status === 401) return { kind: "rejected", code: "unauthorized" };
  if (status === 402) return { kind: "rejected", code: "insufficient_balance" };
  if (status === 403) return { kind: "rejected", code: "forbidden" };
  if (status === 404) return { kind: "rejected", code: "not_found" };
  if (status === 409) return { kind: "rejected", code: "already_exists" };
  if (status === 413) return { kind: "rejected", code: "payload_too_large" };
  if (status === 429) return { kind: "rejected", code: "rate_limited" };
  if (status === 408) return { kind: "unknown_outcome", code: "timeout" };
  if (status >= 300 && status < 400) return { kind: "unknown_outcome", code: "unexpected_redirect" };
  if (status >= 400 && status < 500) return { kind: "rejected", code: "rejected_other" };
  return { kind: "unknown_outcome", code: "server_error" };
}

/** The ONLY surface through which the executor can write. Three methods; nothing generic. */
export interface LiveWriteTransport {
  createApp(req: CreateAppRequest): Promise<WriteResult<{ accepted: true }>>;
  uploadSource(app: string, archive: Buffer): Promise<WriteResult<UploadSourceResponse>>;
  createRelease(app: string, req: CreateReleaseRequest): Promise<WriteResult<CreateReleaseResponse>>;
}
