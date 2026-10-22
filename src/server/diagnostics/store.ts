import { createHash } from "node:crypto";
import { chmodSync, mkdirSync } from "node:fs";
import path from "node:path";
import { redactText } from "../security/redact";
import type { DiagnosticReport } from "./report";
import type { Intent } from "./types";

export type RunPhase = "IDLE" | "COLLECTING_EVIDENCE" | "ANALYZING" | "GENERATING_REPORT" | "COMPLETED";
export type RunStatus = "RUNNING" | "COMPLETED" | "COMPLETED_WITH_GAPS" | "FAILED" | "CANCELLED" | "TIMED_OUT";
export const TERMINAL: RunStatus[] = ["COMPLETED", "COMPLETED_WITH_GAPS", "FAILED", "CANCELLED", "TIMED_OUT"];

export type StepKey = "collect_logs" | "inspect_runtime" | "review_releases" | "analyze_metrics" | "identify_hypotheses" | "prepare_report";
export interface StepState {
  key: StepKey;
  status: "pending" | "running" | "done" | "skipped" | "failed";
  startedAt?: string;
  endedAt?: string;
}
export interface Transition {
  at: string;
  from: RunPhase | null;
  to: RunPhase | RunStatus;
  note?: string;
}

/** Sanitised run record. Never contains tokens, raw API responses, credentials, env values or unsanitised logs. */
export interface RunRecord {
  id: string;
  app: string;
  intent: Intent;
  windowMinutes: number;
  mode: "mock" | "live";
  status: RunStatus;
  phase: RunPhase;
  createdAt: string;
  updatedAt: string;
  finishedAt: string | null;
  retryOf: string | null;
  steps: StepState[];
  transitions: Transition[];
  errorCode: string | null;
  report: DiagnosticReport | null;
}

export interface AuditRow {
  seq: number;
  at: string;
  runId: string | null;
  event: string;
  data: string;
  prevHash: string;
  hash: string;
}

/** Replaceable persistence boundary (SQLite today, PostgreSQL later). All methods are synchronous-in-spirit but async-typed. */
export interface RunStore {
  create(ownerHash: string, run: RunRecord): Promise<void>;
  save(run: RunRecord): Promise<void>;
  get(id: string): Promise<{ ownerHash: string; run: RunRecord } | null>;
  listByOwner(ownerHash: string, limit: number): Promise<RunRecord[]>;
  findActiveByApp(app: string): Promise<RunRecord | null>;
  countActive(): Promise<number>;
  countRecentByOwner(ownerHash: string, sinceIso: string): Promise<number>;
  /** Marks non-terminal runs as FAILED(interrupted_by_restart). Returns how many. */
  recoverInterrupted(nowIso: string): Promise<number>;
  appendAudit(at: string, runId: string | null, event: string, data: Record<string, unknown>): Promise<void>;
  readAudit(limit?: number): Promise<AuditRow[]>;
  verifyAudit(): Promise<{ ok: boolean; brokenAt: number | null; rows: number }>;
  close(): void;
}

export const ownerHashOf = (sessionId: string): string => createHash("sha256").update(`diag-owner:${sessionId}`).digest("hex");

/**
 * Fail-closed sanitisation applied to EVERYTHING before it is persisted: every string passes through shareable redaction
 * (credentials, tokens, private hosts, IPs, emails, home paths). Applied again on top of the engine's own sanitisation.
 */
export function sanitizeForStore<T>(value: T, depth = 0): T {
  if (depth > 14) return "[TRUNCATED]" as unknown as T;
  if (typeof value === "string") return redactText(value, { shareable: true, maxLength: 4000 }) as unknown as T;
  if (Array.isArray(value)) return value.map((v) => sanitizeForStore(v, depth + 1)) as unknown as T;
  if (value && typeof value === "object") {
    const out: Record<string, unknown> = {};
    for (const [k, v] of Object.entries(value as Record<string, unknown>)) {
      if (/^(token|password|secret|authorization|cookie|apikey|api_key)$/i.test(k)) continue; // never persisted, whatever the value
      out[k] = sanitizeForStore(v, depth + 1);
    }
    return out as T;
  }
  return value;
}

export function auditHash(prev: string, at: string, runId: string | null, event: string, data: string): string {
  return createHash("sha256").update([prev, at, runId ?? "", event, data].join("\u001f")).digest("hex");
}
const GENESIS = "0".repeat(64);

// ---------------- in-memory store (tests / dev fallback) ----------------
export class MemoryRunStore implements RunStore {
  protected runs = new Map<string, { ownerHash: string; json: string }>();
  protected audit: AuditRow[] = [];
  async create(ownerHash: string, run: RunRecord) {
    this.runs.set(run.id, { ownerHash, json: JSON.stringify(sanitizeForStore(run)) });
  }
  async save(run: RunRecord) {
    const cur = this.runs.get(run.id);
    if (cur) cur.json = JSON.stringify(sanitizeForStore(run));
  }
  async get(id: string) {
    const r = this.runs.get(id);
    return r ? { ownerHash: r.ownerHash, run: JSON.parse(r.json) as RunRecord } : null;
  }
  private all(): { ownerHash: string; run: RunRecord }[] {
    return [...this.runs.values()].map((r) => ({ ownerHash: r.ownerHash, run: JSON.parse(r.json) as RunRecord }));
  }
  async listByOwner(ownerHash: string, limit: number) {
    return this.all().filter((r) => r.ownerHash === ownerHash).map((r) => r.run).sort((a, b) => b.createdAt.localeCompare(a.createdAt)).slice(0, limit);
  }
  async findActiveByApp(app: string) {
    return this.all().map((r) => r.run).find((r) => r.app === app && !TERMINAL.includes(r.status)) ?? null;
  }
  async countActive() {
    return this.all().filter((r) => !TERMINAL.includes(r.run.status)).length;
  }
  async countRecentByOwner(ownerHash: string, sinceIso: string) {
    return this.all().filter((r) => r.ownerHash === ownerHash && r.run.createdAt >= sinceIso).length;
  }
  async recoverInterrupted(nowIso: string) {
    let n = 0;
    for (const [id, r] of this.runs) {
      const run = JSON.parse(r.json) as RunRecord;
      if (TERMINAL.includes(run.status)) continue;
      run.status = "FAILED";
      run.errorCode = "interrupted_by_restart";
      run.finishedAt = nowIso;
      run.updatedAt = nowIso;
      run.transitions.push({ at: nowIso, from: run.phase, to: "FAILED", note: "interrupted_by_restart" });
      r.json = JSON.stringify(run);
      await this.appendAudit(nowIso, id, "run_interrupted_by_restart", {});
      n++;
    }
    return n;
  }
  async appendAudit(at: string, runId: string | null, event: string, data: Record<string, unknown>) {
    const d = JSON.stringify(sanitizeForStore(data));
    const prev = this.audit.at(-1)?.hash ?? GENESIS;
    this.audit.push({ seq: this.audit.length + 1, at, runId, event, data: d, prevHash: prev, hash: auditHash(prev, at, runId, event, d) });
  }
  async readAudit(limit = 200) {
    return this.audit.slice(-limit);
  }
  async verifyAudit() {
    let prev = GENESIS;
    for (const r of this.audit) {
      if (r.prevHash !== prev || r.hash !== auditHash(prev, r.at, r.runId, r.event, r.data)) return { ok: false, brokenAt: r.seq, rows: this.audit.length };
      prev = r.hash;
    }
    return { ok: true, brokenAt: null, rows: this.audit.length };
  }
  /** test seam: tamper with the audit log */
  __tamperAudit(seq: number, data: string) {
    const r = this.audit.find((x) => x.seq === seq);
    if (r) r.data = data;
  }
  close() {}
}

// ---------------- SQLite store (node:sqlite, built in — no native add-on) ----------------
export interface Stmt {
  run(...p: unknown[]): unknown;
  get(...p: unknown[]): Record<string, unknown> | undefined;
  all(...p: unknown[]): Record<string, unknown>[];
}
export interface Db {
  exec(sql: string): void;
  prepare(sql: string): Stmt;
  close(): void;
}

export class SqliteRunStore implements RunStore {
  protected db: Db;
  constructor(file: string) {
    // getBuiltinModule avoids bundler resolution issues for the scheme-only `node:sqlite` module.
    const mod = process.getBuiltinModule("node:sqlite") as unknown as { DatabaseSync: new (f: string) => Db } | undefined;
    if (!mod) throw new Error("node:sqlite is unavailable (Node >= 22.13 required)");
    if (file !== ":memory:") mkdirSync(path.dirname(path.resolve(file)), { recursive: true });
    this.db = new mod.DatabaseSync(file);
    if (file !== ":memory:") {
      try {
        chmodSync(file, 0o600);
      } catch {
        /* best effort */
      }
      this.db.exec("PRAGMA journal_mode=WAL;");
    }
    this.db.exec("PRAGMA busy_timeout=3000;");
    this.db.exec(`
      CREATE TABLE IF NOT EXISTS runs (
        id TEXT PRIMARY KEY, owner_hash TEXT NOT NULL, app TEXT NOT NULL, status TEXT NOT NULL,
        created_at TEXT NOT NULL, updated_at TEXT NOT NULL, record_json TEXT NOT NULL
      );
      CREATE INDEX IF NOT EXISTS runs_owner ON runs(owner_hash, created_at);
      CREATE INDEX IF NOT EXISTS runs_active ON runs(status, app);
      CREATE TABLE IF NOT EXISTS audit (
        seq INTEGER PRIMARY KEY AUTOINCREMENT, at TEXT NOT NULL, run_id TEXT, event TEXT NOT NULL,
        data TEXT NOT NULL, prev_hash TEXT NOT NULL, hash TEXT NOT NULL
      );
    `);
  }
  protected json(run: RunRecord) {
    return JSON.stringify(sanitizeForStore(run));
  }
  async create(ownerHash: string, run: RunRecord) {
    this.db.prepare("INSERT INTO runs (id, owner_hash, app, status, created_at, updated_at, record_json) VALUES (?,?,?,?,?,?,?)").run(run.id, ownerHash, run.app, run.status, run.createdAt, run.updatedAt, this.json(run));
  }
  async save(run: RunRecord) {
    this.db.prepare("UPDATE runs SET status=?, updated_at=?, record_json=? WHERE id=?").run(run.status, run.updatedAt, this.json(run), run.id);
  }
  async get(id: string) {
    const r = this.db.prepare("SELECT owner_hash, record_json FROM runs WHERE id=?").get(id);
    return r ? { ownerHash: String(r.owner_hash), run: JSON.parse(String(r.record_json)) as RunRecord } : null;
  }
  async listByOwner(ownerHash: string, limit: number) {
    return this.db.prepare("SELECT record_json FROM runs WHERE owner_hash=? ORDER BY created_at DESC LIMIT ?").all(ownerHash, limit).map((r) => JSON.parse(String(r.record_json)) as RunRecord);
  }
  async findActiveByApp(app: string) {
    const r = this.db.prepare("SELECT record_json FROM runs WHERE app=? AND status='RUNNING' LIMIT 1").get(app);
    return r ? (JSON.parse(String(r.record_json)) as RunRecord) : null;
  }
  async countActive() {
    return Number(this.db.prepare("SELECT COUNT(*) AS n FROM runs WHERE status='RUNNING'").get()?.n ?? 0);
  }
  async countRecentByOwner(ownerHash: string, sinceIso: string) {
    return Number(this.db.prepare("SELECT COUNT(*) AS n FROM runs WHERE owner_hash=? AND created_at>=?").get(ownerHash, sinceIso)?.n ?? 0);
  }
  async recoverInterrupted(nowIso: string) {
    const rows = this.db.prepare("SELECT id, record_json FROM runs WHERE status='RUNNING'").all();
    for (const r of rows) {
      const run = JSON.parse(String(r.record_json)) as RunRecord;
      run.status = "FAILED";
      run.errorCode = "interrupted_by_restart";
      run.finishedAt = nowIso;
      run.updatedAt = nowIso;
      run.transitions.push({ at: nowIso, from: run.phase, to: "FAILED", note: "interrupted_by_restart" });
      await this.save(run);
      await this.appendAudit(nowIso, run.id, "run_interrupted_by_restart", {});
    }
    return rows.length;
  }
  async appendAudit(at: string, runId: string | null, event: string, data: Record<string, unknown>) {
    const d = JSON.stringify(sanitizeForStore(data));
    const last = this.db.prepare("SELECT hash FROM audit ORDER BY seq DESC LIMIT 1").get();
    const prev = last ? String(last.hash) : GENESIS;
    this.db.prepare("INSERT INTO audit (at, run_id, event, data, prev_hash, hash) VALUES (?,?,?,?,?,?)").run(at, runId, event, d, prev, auditHash(prev, at, runId, event, d));
  }
  async readAudit(limit = 200) {
    return this.db.prepare("SELECT seq, at, run_id, event, data, prev_hash, hash FROM audit ORDER BY seq DESC LIMIT ?").all(limit).reverse().map((r) => ({ seq: Number(r.seq), at: String(r.at), runId: r.run_id === null ? null : String(r.run_id), event: String(r.event), data: String(r.data), prevHash: String(r.prev_hash), hash: String(r.hash) }));
  }
  async verifyAudit() {
    const rows = this.db.prepare("SELECT seq, at, run_id, event, data, prev_hash, hash FROM audit ORDER BY seq ASC").all();
    let prev = GENESIS;
    for (const r of rows) {
      const rid = r.run_id === null ? null : String(r.run_id);
      if (String(r.prev_hash) !== prev || String(r.hash) !== auditHash(prev, String(r.at), rid, String(r.event), String(r.data))) return { ok: false, brokenAt: Number(r.seq), rows: rows.length };
      prev = String(r.hash);
    }
    return { ok: true, brokenAt: null, rows: rows.length };
  }
  /** test seam */
  __raw(sql: string, ...p: unknown[]) {
    return this.db.prepare(sql).run(...p);
  }
  __all(sql: string, ...p: unknown[]) {
    return this.db.prepare(sql).all(...p);
  }
  close() {
    this.db.close();
  }
}
