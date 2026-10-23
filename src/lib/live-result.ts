/**
 * The RESULT of a live operation as the browser shows it — pure data (no server imports), built either from the server's `status.lastResults` or from the
 * validated answer of `POST /api/agent/live/operations/:id/resolve`. A 200 from that route is NEVER success by itself: only the validated domain `state` counts.
 */
import { LADDER_KEYS, type Ladder, type LadderLevel } from "./live-ladder";

/** Kept in sync with `LIVE_STATES` in src/server/live/types.ts by a unit test (the browser must not import server modules). */
export const LIVE_STATE_NAMES = ["PREFLIGHT", "AWAITING_LIVE_APPROVAL", "APPROVED", "CREATING_APPLICATION", "APPLICATION_CREATED", "UPLOADING_SOURCE", "SOURCE_UPLOADED", "CREATING_RELEASE", "RELEASE_CREATED", "VERIFYING_DEPLOYMENT", "DEPLOYED", "FAILED", "NEEDS_OPERATOR_REVIEW", "CANCELLED"] as const;
export type ResultState = (typeof LIVE_STATE_NAMES)[number];

/** Where the "runtime started" fact came from. `unrecorded` = a record written before provenance existed: it is never guessed. */
export type RuntimeEvidence = "observed" | "inferred" | "unknown" | "unrecorded";

/** One HTTP health observation (see `HealthObservation` on the server): a FACT with its time and source, never a summary. */
export interface HealthView {
  observedAt: string;
  outcome: string;
  status: number | null;
  markerRequired: boolean;
  markerMatched: boolean | null;
  failure: string | null;
  durationMs: number | null;
}
export interface AppletsView {
  observedAt: string;
  readable: boolean;
  runtimeClass: string | null;
  appletCount: number | null;
  failure: string | null;
}
/** A FRESH read-only check made after the deployment finished. It never changes the deployment result. */
export interface CheckView {
  observedAt: string;
  verdict: "http_ok" | "http_failed" | "unknown";
  runtime: "observed" | "inferred" | "unknown";
  currentReleaseMatches: boolean | null;
  health: HealthView | null;
  applets: AppletsView | null;
}

export interface LiveResultView {
  operationId: string;
  appName: string;
  kind: "create_new_app" | "deploy_existing_app";
  state: ResultState;
  /** time of the last persisted change (ISO) */
  completedAt: string;
  releaseId: string | null;
  ladder: Ladder;
  failureCode: string | null;
  failureFa: string | null;
  recoveryFa: string[];
  abandoned: boolean;
  runtimeEvidence: RuntimeEvidence;
  /** was the applets list readable when the runtime was judged? null = not recorded */
  appletsReadable: boolean | null;
  /** when the evidence behind the recorded ladder was gathered; null = not recorded (older record) */
  evidenceObservedAt: string | null;
  /** health observation behind the recorded ladder: `undefined` = not recorded, `null` = no probe ran then */
  health?: HealthView | null;
  applets?: AppletsView | null;
  /** the latest FRESH check, if any (distinct from the historical evidence above) */
  latestCheck: CheckView | null;
  /** who may act on it from this session (only set for history entries served by the status API) */
  access?: "owner" | "orphan";
}

/** Structural subset of `LiveOperationRecord` (so the server can pass its record without this file importing it). */
export interface OperationLike {
  id: string;
  kind?: string;
  appName: string;
  state: string;
  updatedAt: string;
  remote: { releaseId: string | null };
  ladder: object;
  failure: { code: string; messageFa: string } | null;
  recoveryFa: string[];
  evidence?: { runtime: "observed" | "inferred" | "unknown"; appletsReadable: boolean | null; observedAt?: string; health?: HealthView | null; applets?: AppletsView | null };
  latestCheck?: CheckView;
  transitions?: { at: string }[];
}

const LEVELS: readonly LadderLevel[] = ["unknown", "ok", "failed"];
const isState = (s: unknown): s is ResultState => typeof s === "string" && (LIVE_STATE_NAMES as readonly string[]).includes(s);

export function toResultView(op: OperationLike): LiveResultView | null {
  if (!isState(op.state)) return null;
  const ladder = {} as Ladder;
  for (const k of LADDER_KEYS) {
    const v = (op.ladder as Record<string, unknown>)[k];
    if (!LEVELS.includes(v as LadderLevel)) return null;
    ladder[k] = v as LadderLevel;
  }
  return {
    operationId: op.id,
    appName: op.appName,
    kind: op.kind === "create_new_app" ? "create_new_app" : "deploy_existing_app",
    state: op.state,
    // the time of the last STATE change; `updatedAt` also moves when evidence is refreshed, which must not look like a new completion
    completedAt: op.transitions && op.transitions.length ? op.transitions[op.transitions.length - 1]!.at : op.updatedAt,
    releaseId: op.remote.releaseId,
    ladder,
    failureCode: op.failure?.code ?? null,
    failureFa: op.failure?.messageFa ?? null,
    recoveryFa: op.recoveryFa.slice(0, 12),
    abandoned: op.failure?.code === "abandoned_by_operator",
    runtimeEvidence: op.evidence ? op.evidence.runtime : "unrecorded",
    appletsReadable: op.evidence ? op.evidence.appletsReadable : null,
    evidenceObservedAt: op.evidence?.observedAt ?? null,
    ...(op.evidence ? { health: op.evidence.health, applets: op.evidence.applets } : {}),
    latestCheck: op.latestCheck ?? null,
  };
}

const OUTCOMES = ["ok", "http_error", "blocked_address", "invalid_target", "timeout", "network", "redirect", "too_large", "disabled", "cancelled"];
const FAILURES = ["dns", "tls", "connection", "timeout", "cancelled", "blocked_address", "redirect", "http_status", "too_large", "marker_mismatch", "invalid_target", "disabled"];
const isObj = (x: unknown): x is Record<string, unknown> => !!x && typeof x === "object" && !Array.isArray(x);
const str = (x: unknown, max: number): x is string => typeof x === "string" && x.length > 0 && x.length <= max;

const nullableBool = (x: unknown): x is boolean | null => x === null || typeof x === "boolean";
const nullableInt = (x: unknown, max: number): x is number | null => x === null || (typeof x === "number" && Number.isInteger(x) && x >= 0 && x <= max);
function parseHealth(x: unknown): HealthView | undefined {
  if (!isObj(x) || x.source !== "http_probe" || !str(x.observedAt, 40) || !OUTCOMES.includes(String(x.outcome))) return undefined;
  if (!nullableInt(x.status, 999) || typeof x.markerRequired !== "boolean" || !nullableBool(x.markerMatched) || !(x.failure === null || FAILURES.includes(String(x.failure))) || !nullableInt(x.durationMs, 3_600_000)) return undefined;
  return { observedAt: x.observedAt, outcome: String(x.outcome), status: x.status, markerRequired: x.markerRequired, markerMatched: x.markerMatched, failure: x.failure === null ? null : String(x.failure), durationMs: x.durationMs };
}
function parseApplets(x: unknown): AppletsView | undefined {
  if (!isObj(x) || !str(x.observedAt, 40) || typeof x.readable !== "boolean") return undefined;
  if (!(x.runtimeClass === null || str(x.runtimeClass, 30)) || !nullableInt(x.appletCount, 1000) || !(x.failure === null || str(x.failure, 40))) return undefined;
  return { observedAt: x.observedAt, readable: x.readable, runtimeClass: x.runtimeClass as string | null, appletCount: x.appletCount, failure: x.failure as string | null };
}
function parseCheck(x: unknown): CheckView | undefined {
  if (!isObj(x) || !str(x.observedAt, 40) || !["http_ok", "http_failed", "unknown"].includes(String(x.verdict)) || !["observed", "inferred", "unknown"].includes(String(x.runtime)) || !nullableBool(x.currentReleaseMatches)) return undefined;
  const health = x.health === null ? null : parseHealth(x.health);
  const applets = x.applets === null ? null : parseApplets(x.applets);
  if (health === undefined || applets === undefined) return undefined;
  return { observedAt: x.observedAt, verdict: x.verdict as CheckView["verdict"], runtime: x.runtime as CheckView["runtime"], currentReleaseMatches: x.currentReleaseMatches, health, applets };
}

/**
 * Validates the JSON answer of `/resolve` (untrusted: it crossed the network) and turns it into a result. Returns null for ANYTHING unexpected — the caller must then
 * say the outcome is uncertain and re-read the status; it must not assume success.
 */
export function parseOperationResponse(json: unknown, expectedId: string): LiveResultView | null {
  if (!isObj(json) || json.id !== expectedId) return null;
  const { remote, ladder, failure, recoveryFa, evidence } = json;
  if (!str(json.appName, 63) || !isState(json.state) || !str(json.updatedAt, 40) || !isObj(remote) || !isObj(ladder) || !Array.isArray(recoveryFa)) return null;
  const releaseId = remote.releaseId === null || remote.releaseId === undefined ? null : str(remote.releaseId, 256) ? remote.releaseId : undefined;
  if (releaseId === undefined) return null;
  let f: { code: string; messageFa: string } | null = null;
  if (failure !== null && failure !== undefined) {
    if (!isObj(failure) || !str(failure.code, 60) || !str(failure.messageFa, 400)) return null;
    f = { code: failure.code, messageFa: failure.messageFa };
  }
  let ev: OperationLike["evidence"];
  if (evidence !== undefined && evidence !== null) {
    if (!isObj(evidence) || !["observed", "inferred", "unknown"].includes(String(evidence.runtime)) || !(evidence.appletsReadable === null || typeof evidence.appletsReadable === "boolean")) return null;
    ev = { runtime: evidence.runtime as "observed" | "inferred" | "unknown", appletsReadable: evidence.appletsReadable };
    if (evidence.observedAt !== undefined) {
      if (!str(evidence.observedAt, 40)) return null;
      ev.observedAt = evidence.observedAt;
    }
    if (evidence.health !== undefined) {
      const h = evidence.health === null ? null : parseHealth(evidence.health);
      if (h === undefined) return null;
      ev.health = h;
    }
    if (evidence.applets !== undefined) {
      const a = evidence.applets === null ? null : parseApplets(evidence.applets);
      if (a === undefined) return null;
      ev.applets = a;
    }
  }
  let check: CheckView | undefined;
  if (json.latestCheck !== undefined && json.latestCheck !== null) {
    check = parseCheck(json.latestCheck);
    if (!check) return null;
  }
  const transitions = Array.isArray(json.transitions) ? json.transitions.filter((t): t is { at: string } => isObj(t) && str(t.at, 40)).map((t) => ({ at: t.at })) : undefined;
  return toResultView({
    id: json.id,
    kind: typeof json.kind === "string" ? json.kind : undefined,
    appName: json.appName,
    state: json.state,
    updatedAt: json.updatedAt,
    remote: { releaseId },
    ladder: Object.fromEntries(Object.entries(ladder).map(([k, v]) => [k, String(v)])),
    failure: f,
    recoveryFa: recoveryFa.filter((x): x is string => typeof x === "string" && x.length <= 400),
    evidence: ev,
    latestCheck: check,
    transitions,
  });
}

/**
 * Which results to show for the page: the ones CONFIRMED in this browser session by an action response come first and are never replaced by an older history
 * entry of the same operation (no duplicates); a result is hidden once a NEWER operation of the same application exists in the current run (it is history no longer).
 */
export function mergeResults(confirmed: readonly LiveResultView[], history: readonly LiveResultView[], newerThan: (appName: string, completedAt: string) => boolean): LiveResultView[] {
  const seen = new Set<string>();
  const out: LiveResultView[] = [];
  for (const r of [...confirmed, ...history]) {
    if (seen.has(r.operationId)) continue;
    seen.add(r.operationId);
    if (newerThan(r.appName, r.completedAt)) continue;
    out.push(r);
  }
  return out;
}
