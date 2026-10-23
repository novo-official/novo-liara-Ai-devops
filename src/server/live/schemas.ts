import { z } from "zod";
import { APP_NAME_REGEX } from "../config/env";
import { LIVE_PLATFORMS, PLAN_ID, VENDOR_ID } from "./contract";
import { LIVE_STATES } from "./types";

/** Strict schemas for everything the live layer persists. Live records are NEVER passed through the generic text sanitiser (it would pseudonymise ids and
 * redact hashes, breaking exact binding); instead every field is constrained here and parsed on write AND on read, so a tampered row cannot load. */
const HEX64 = z.string().regex(/^[0-9a-f]{64}$/);
const ID = z.string().regex(/^[A-Za-z0-9][A-Za-z0-9_-]{2,127}$/);
const ISO = z.string().regex(/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(\.\d+)?Z$/);
const SHORT = z.string().max(200);

export const FinancialSchema = z
  .object({
    unitsVerified: z.boolean(),
    planId: z.string().regex(PLAN_ID).or(z.literal("invalid")),
    resource: z.object({ ramAmount: z.number().nullable(), cpuAmount: z.number().nullable(), volume: z.number().nullable(), price: z.number().nullable(), ramUnit: z.string().max(10).nullable(), cpuUnit: z.string().max(10).nullable(), priceUnit: z.string().max(20).nullable() }).strict(),
    estimate: z.object({ durationHours: z.number(), amount: z.number(), currency: z.string().max(5), basis: z.string().max(200) }).strict().nullable(),
    requiredBalance: z.number().nullable(),
    knownOtherCosts: z.array(SHORT).max(10),
    unknownCostComponents: z.array(SHORT).max(20),
  })
  .strict();

export const LiveKindSchema = z.enum(["create_new_app", "deploy_existing_app"]);
export const LiveBackendSchema = z.enum(["api", "cli"]);
export const CliBindingSchema = z.object({ version: z.string().regex(/^\d{1,3}\.\d{1,3}\.\d{1,3}$/), entrySha256: HEX64, argvDigest: HEX64, manifestDigest: HEX64 }).strict();

export const ExistingBindingSchema = z.object({ instanceId: z.string().max(100).nullable(), createdAt: z.string().max(40).nullable(), networkId: z.string().max(128).nullable(), baselineRelease: z.string().max(100).nullable(), releaseTotal: z.number().int().nonnegative().nullable(), defaultSubdomain: z.boolean().nullable() }).strict();

export const LiveProposalSchema = z
  .object({
    id: ID,
    kind: LiveKindSchema.default("create_new_app"),
    backend: LiveBackendSchema.default("api"),
    cli: CliBindingSchema.nullable().default(null),
    existing: ExistingBindingSchema.nullable().default(null),
    operationId: ID,
    runId: ID,
    conversationId: ID,
    ownerHash: z.string().regex(/^[0-9a-f]{16,64}$/),
    teamId: z.string().regex(/^[A-Za-z0-9_-]{1,64}$/).nullable(),
    appName: z.string().regex(APP_NAME_REGEX),
    planId: z.string().regex(PLAN_ID),
    bundlePlanId: z.string().regex(PLAN_ID),
    networkId: z.string().regex(/^[A-Za-z0-9][A-Za-z0-9_-]{2,127}$/),
    platform: z.enum(LIVE_PLATFORMS),
    artifact: z.object({ zipSha256: HEX64, analysisDigest: HEX64, artifactDigest: HEX64, artifactBytes: z.number().int().positive(), fileCount: z.number().int().positive(), format: z.string().max(200) }).strict(),
    config: z.object({ port: z.number().int().min(1).max(65535), output: z.enum(["server", "standalone", "export"]), nodeRange: z.string().max(40).nullable(), buildInvocation: z.string().max(40).nullable(), startInvocation: z.string().max(40).nullable() }).strict(),
    envKeys: z.array(z.string().regex(/^[A-Z][A-Z0-9_]{1,63}$/)).max(40),
    financial: FinancialSchema,
    executionMode: z.literal("live"),
    environment: z.literal("live"),
    confirmation: z.literal("type_app_name"),
    stateFingerprint: HEX64,
    createdAt: ISO,
    expiresAt: ISO,
    digest: HEX64,
    status: z.enum(["PENDING", "APPROVED", "REJECTED", "EXPIRED", "CANCELLED", "BLOCKED", "CONSUMED"]),
  })
  .strict();

const Step = z.object({ name: z.enum(["create_application", "upload_source", "create_release", "verify_deployment"]), status: z.enum(["pending", "started", "done", "failed", "unknown"]), startedAt: ISO.nullable(), endedAt: ISO.nullable(), outcome: z.string().max(60).nullable() }).strict();
const Level = z.enum(["unknown", "ok", "failed"]);
const PROBE_OUTCOME = z.enum(["ok", "http_error", "blocked_address", "invalid_target", "timeout", "network", "redirect", "too_large", "disabled", "cancelled"]);
const PROBE_FAILURE = z.enum(["dns", "tls", "connection", "timeout", "cancelled", "blocked_address", "redirect", "http_status", "too_large", "marker_mismatch", "invalid_target", "disabled"]);
export const HealthObservationSchema = z.object({ source: z.literal("http_probe"), observedAt: ISO, outcome: PROBE_OUTCOME, status: z.number().int().min(0).max(999).nullable(), markerRequired: z.boolean(), markerMatched: z.boolean().nullable(), failure: PROBE_FAILURE.nullable(), durationMs: z.number().int().min(0).max(3_600_000).nullable() }).strict();
export const AppletsObservationSchema = z.object({ observedAt: ISO, readable: z.boolean(), runtimeClass: z.string().max(30).nullable(), appletCount: z.number().int().min(0).max(1000).nullable(), failure: z.string().max(40).nullable() }).strict();
const RUNTIME = z.enum(["observed", "inferred", "unknown"]);

export const LiveOperationSchema = z
  .object({
    id: ID,
    kind: LiveKindSchema.default("create_new_app"),
    backend: LiveBackendSchema.default("api"),
    proposalId: ID,
    ownerHash: z.string().regex(/^[0-9a-f]{16,64}$/),
    teamId: z.string().regex(/^[A-Za-z0-9_-]{1,64}$/).nullable(),
    appName: z.string().regex(APP_NAME_REGEX),
    planId: z.string().regex(PLAN_ID),
    platform: z.enum(LIVE_PLATFORMS),
    state: z.enum(LIVE_STATES),
    createdAt: ISO,
    updatedAt: ISO,
    steps: z.array(Step).max(4),
    // ids RETURNED by Liara are opaque strings (see VENDOR_ID): the strict project-id pattern here would make persisting a SUCCESSFUL upload throw
    remote: z.object({ appConfirmed: z.boolean().nullable(), sourceId: z.string().regex(VENDOR_ID).nullable(), releaseId: z.string().regex(VENDOR_ID).nullable() }).strict(),
    ladder: z.object({ apiAcceptedRequest: Level, sourceUploaded: Level, releaseCreated: Level, buildCompleted: Level, runtimeStarted: Level, httpHealthVerified: Level }).strict(),
    evidence: z.object({ runtime: RUNTIME, appletsReadable: z.boolean().nullable(), observedAt: ISO.optional(), health: HealthObservationSchema.nullable().optional(), applets: AppletsObservationSchema.nullable().optional() }).strict().optional(),
    runner: z.object({ instance: z.string().regex(/^[A-Za-z0-9_-]{1,40}$/), pid: z.number().int().min(1).max(4_294_967_295) }).strict().optional(),
    latestCheck: z.object({ observedAt: ISO, verdict: z.enum(["http_ok", "http_failed", "unknown"]), runtime: RUNTIME, currentReleaseMatches: z.boolean().nullable(), health: HealthObservationSchema.nullable(), applets: AppletsObservationSchema.nullable() }).strict().optional(),
    failure: z.object({ code: z.string().max(60), step: z.enum(["create_application", "upload_source", "create_release", "verify_deployment", "preflight", "approval"]), messageFa: z.string().max(400) }).strict().nullable(),
    recoveryFa: z.array(z.string().max(400)).max(12),
    transitions: z.array(z.object({ at: ISO, from: z.enum(LIVE_STATES).nullable(), to: z.enum(LIVE_STATES), note: z.string().max(80).nullable() }).strict()).max(60),
  })
  .strict();
