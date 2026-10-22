/**
 * Safe domain models: the ONLY shapes that may leave the Liara integration layer.
 * Every field is an explicit allow-listed projection; nothing is a pass-through of upstream data.
 */
export type DataMode = "mock" | "live";

export interface AppSummary {
  name: string;
  platform: string | null;
  /** Raw upstream status text (vocabulary undocumented) — display only, never interpreted. */
  status: string | null;
  /** Documented as 1 = on, 0 = off. */
  scale: number | null;
  planId: string | null;
  createdAt: string | null;
  isDeployed: boolean | null;
}

export interface AppDetail extends AppSummary {
  /** Phase 2E: the application's opaque instance id (`_id`) — changes when an app is deleted and recreated under the same name. Never shown in full. */
  instanceId: string | null;
  /** Phase 2E: the network `_id` the app runs in (CLI `IProjectDetails.network._id`); null = no network */
  networkId: string | null;
  defaultSubdomain: boolean | null;
  zeroDowntime: boolean | null;
  readOnlyRootFilesystem: boolean | null;
  fixedIpStatus: string | null;
  /** Variable NAMES only. Values are never projected. */
  envKeys: { key: string; encrypted: boolean | null }[];
}

export interface Applet {
  id: string;
  name: string | null;
  since: string | null;
  state: string | null;
  reason: string | null;
  releaseTag: string | null;
}

export interface Release {
  id: string;
  type: string | null;
  state: string | null;
  port: number | null;
  tag: string | null;
  createdAt: string | null;
  finishedAt: string | null;
  sourceAvailable: boolean | null;
  branch: string | null;
  commit: string | null;
  message: string | null;
}

export interface ReleaseList {
  total: number | null;
  currentRelease: string | null;
  releases: Release[];
  skipped: number;
}

export interface EventRow {
  time: string | null;
  /** True when the time was inferred from a numeric first column (event schema is untyped upstream). */
  timeInferred: boolean;
  text: string;
}

export interface LogLine {
  time: string | null;
  stream: string | null;
  message: string;
}

export interface MetricPoint {
  t: number; // unix seconds
  v: number; // raw value, unit undocumented
}

export interface MetricSeries {
  applet: string | null;
  /** Raw observations in time order. Never interpolated, resampled or unit-converted. */
  points: MetricPoint[];
  /** Last successful observation, or null when the series has no valid point. */
  lastObservation: MetricPoint | null;
  /** Gaps (in seconds) larger than 3x the median sampling step; charts must break the line there. */
  gapsAfter: number[];
  /** Median sampling step in seconds (null when fewer than 2 points). */
  stepSeconds: number | null;
}

export interface MetricResult {
  kind: "cpu" | "memory";
  /** A unit is reported ONLY when present in the verified-units table; otherwise null (unknown). */
  unit: string | null;
  series: MetricSeries[];
  windowStart: number;
  windowEnd: number;
  /**
   * ok          at least one valid point
   * empty       API returned no series (or none with data)
   * unsupported API returned data we could not interpret (schema mismatch) — NOT the same as "no data"
   */
  schema: "ok" | "empty" | "unsupported";
  droppedSeries: number;
  droppedPoints: number;
}

export interface LogsResult {
  lines: LogLine[];
  truncated: boolean;
  source: "v1" | "v2";
  contract: "documented" | "observed";
  /** Set when auto mode fell back from the documented v1 endpoint to the observed v2 one. */
  v1FallbackReason?: string;
}

export interface EventsResult {
  rows: EventRow[];
  truncated: boolean;
}

/** Wrapper adding provenance to everything the UI shows. */
export interface Meta {
  mode: DataMode;
  fetchedAt: string;
  contract?: "documented" | "observed";
  source?: string;
}

export type Section<T> =
  | { ok: true; data: T; meta: Meta }
  | { ok: false; error: { code: string; retryAfterSec?: number }; meta: { mode: DataMode; fetchedAt: string } };
