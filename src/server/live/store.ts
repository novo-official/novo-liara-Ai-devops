import { MemoryAgentStore, SqliteAgentStore, type AgentStore } from "../agent/store";
import { LiveOperationSchema, LiveProposalSchema } from "./schemas";
import { LIVE_NEXT, LIVE_TERMINAL, type LiveApprovalRecord, type LiveOperationRecord, type LiveProposal, type LiveProposalStatus, type LiveState } from "./types";

/**
 * Persistence of live proposals, approvals, operations and the bootstrapped app scope. SEPARATE tables from the simulation engine (a simulation row and
 * a live row can never be confused or replayed into each other). All state changes are atomic compare-and-set; every row is strictly validated on
 * write AND on read (zod), and stored as plain JSON because live records carry exact ids/hashes that the text sanitiser would alter.
 */

export const teamKey = (teamId: string | null) => teamId ?? "personal";

/** An operation blocks a new one for the same (team, app) unless it is provably clean: cancelled, or failed with the app CONFIRMED absent. */
export const isActiveOperation = (o: Pick<LiveOperationRecord, "state" | "remote"> & { kind?: LiveOperationRecord["kind"] }): boolean => {
  if (o.state === "CANCELLED") return false;
  // a release to an EXISTING app does not own the application name: once it ended (deployed or failed) the next release may be proposed; only in-flight work and an unresolved review hold the slot
  if (o.kind === "deploy_existing_app") return !["DEPLOYED", "FAILED"].includes(o.state);
  return !(o.state === "FAILED" && o.remote.appConfirmed === false);
};

type ProposalTarget = Exclude<LiveProposalStatus, "PENDING" | "CONSUMED">;
const needs = (to: ProposalTarget): "expiry_ok" | "expired_only" | "none" => (to === "APPROVED" || to === "REJECTED" ? "expiry_ok" : to === "EXPIRED" ? "expired_only" : "none");
const SCOPE_STATES: readonly LiveState[] = ["APPLICATION_CREATED", "UPLOADING_SOURCE", "SOURCE_UPLOADED", "CREATING_RELEASE", "RELEASE_CREATED", "VERIFYING_DEPLOYMENT", "DEPLOYED", "NEEDS_OPERATOR_REVIEW"];

export type StartResult = { started: true } | { started: false; reason: "proposal_not_approved" | "expired" | "operation_not_awaiting" | "operation_not_found" };

export interface LiveStore extends AgentStore {
  /** ATOMIC: the proposal AND its operation row (state AWAITING_LIVE_APPROVAL). One live attempt per (team, app) at a time: refused while another is pending/active. */
  createLiveProposal(p: LiveProposal, op: LiveOperationRecord): Promise<{ created: true } | { created: false; reason: "pending_exists" | "active_operation" }>;
  getLiveProposal(id: string): Promise<LiveProposal | null>;
  listLiveProposals(runId: string): Promise<LiveProposal[]>;
  transitionLiveProposal(id: string, to: ProposalTarget, nowIso: string, approval?: LiveApprovalRecord): Promise<{ changed: boolean; status: LiveProposalStatus }>;
  listLiveApprovals(proposalId: string): Promise<LiveApprovalRecord[]>;
  /** ATOMIC single-use claim: proposal APPROVED→CONSUMED (not expired) + operation AWAITING_LIVE_APPROVAL→APPROVED (`approvedOp` is the new record). */
  beginExecution(approvedOp: LiveOperationRecord, nowIso: string): Promise<StartResult>;
  /** operations that were in flight when the process stopped */
  listOperationsInStates(states: readonly LiveState[]): Promise<LiveOperationRecord[]>;
  getOperation(id: string): Promise<LiveOperationRecord | null>;
  getOperationByProposal(proposalId: string): Promise<LiveOperationRecord | null>;
  listOperations(ownerHash: string): Promise<LiveOperationRecord[]>;
  /** compare-and-set on the current state; also enforces LIVE_NEXT. `rec.state` is the NEW state. */
  updateOperation(rec: LiveOperationRecord, expectedFrom: LiveState): Promise<boolean>;
  /** synchronous (SQLite and memory are in-process): used by LiaraService.isAllowed */
  scopeHas(team: string | null, app: string): boolean;
  /** ATOMIC scope bootstrap, only for an app that this very operation created and the executor CONFIRMED (exact team + name). Idempotent. */
  bootstrapScope(operationId: string, nowIso: string): Promise<{ ok: boolean; reason?: string }>;
}

const parseP = (j: unknown) => LiveProposalSchema.parse(j);
const parseO = (j: unknown) => LiveOperationSchema.parse(j) as LiveOperationRecord;
const validTransition = (from: LiveState, to: LiveState) => from === to || LIVE_NEXT[from].includes(to);

// =====================================================================================================================
export class MemoryLiveStore extends MemoryAgentStore implements LiveStore {
  private lp = new Map<string, string>();
  private la: LiveApprovalRecord[] = [];
  private lo = new Map<string, string>();
  private scope = new Set<string>();

  async createLiveProposal(p: LiveProposal, op: LiveOperationRecord) {
    const row = parseP(p);
    const opRow = parseO(op);
    for (const raw of this.lp.values()) {
      const x = JSON.parse(raw) as LiveProposal;
      if (x.status === "PENDING" && x.appName === row.appName && teamKey(x.teamId) === teamKey(row.teamId)) return { created: false as const, reason: "pending_exists" as const };
    }
    for (const raw of this.lo.values()) {
      const o = JSON.parse(raw) as LiveOperationRecord;
      if (o.appName === row.appName && teamKey(o.teamId) === teamKey(row.teamId) && isActiveOperation(o)) return { created: false as const, reason: "active_operation" as const };
    }
    this.lp.set(row.id, JSON.stringify(row));
    this.lo.set(opRow.id, JSON.stringify(opRow));
    return { created: true as const };
  }
  async getLiveProposal(id: string) {
    const r = this.lp.get(id);
    return r ? parseP(JSON.parse(r)) : null;
  }
  async listLiveProposals(runId: string) {
    return [...this.lp.values()].map((r) => parseP(JSON.parse(r))).filter((p) => p.runId === runId).sort((a, b) => a.createdAt.localeCompare(b.createdAt));
  }
  async transitionLiveProposal(id: string, to: ProposalTarget, nowIso: string, approval?: LiveApprovalRecord) {
    const raw = this.lp.get(id);
    if (!raw) return { changed: false, status: "BLOCKED" as LiveProposalStatus };
    const p = parseP(JSON.parse(raw));
    const n = needs(to);
    // EXPIRED is also legal from APPROVED (approved but never executed, deadline passed): the compare-and-set below is the same atomic step `beginExecution` uses,
    // so an execution that already started (CONSUMED) can never be expired, and an expired one can never start.
    const fromOk = p.status === "PENDING" || (to === "EXPIRED" && p.status === "APPROVED");
    const ok = fromOk && (n === "none" || (n === "expiry_ok" && p.expiresAt > nowIso) || (n === "expired_only" && p.expiresAt <= nowIso));
    if (!ok) return { changed: false, status: p.status };
    this.lp.set(id, JSON.stringify({ ...p, status: to }));
    if (approval) this.la.push(approval);
    return { changed: true, status: to as LiveProposalStatus };
  }
  async listLiveApprovals(proposalId: string) {
    return this.la.filter((a) => a.proposalId === proposalId);
  }
  async beginExecution(approvedOp: LiveOperationRecord, nowIso: string): Promise<StartResult> {
    const row = parseO(approvedOp);
    const rawOp = this.lo.get(row.id);
    if (!rawOp) return { started: false, reason: "operation_not_found" };
    const cur = parseO(JSON.parse(rawOp));
    if (cur.state !== "AWAITING_LIVE_APPROVAL" || row.state !== "APPROVED") return { started: false, reason: "operation_not_awaiting" };
    const raw = this.lp.get(cur.proposalId);
    if (!raw) return { started: false, reason: "proposal_not_approved" };
    const p = parseP(JSON.parse(raw));
    if (p.status !== "APPROVED") return { started: false, reason: "proposal_not_approved" };
    if (p.expiresAt <= nowIso) return { started: false, reason: "expired" };
    this.lp.set(p.id, JSON.stringify({ ...p, status: "CONSUMED" }));
    this.lo.set(row.id, JSON.stringify(row));
    return { started: true };
  }
  async listOperationsInStates(states: readonly LiveState[]) {
    return [...this.lo.values()].map((r) => parseO(JSON.parse(r))).filter((o) => states.includes(o.state));
  }
  async getOperation(id: string) {
    const r = this.lo.get(id);
    return r ? parseO(JSON.parse(r)) : null;
  }
  async getOperationByProposal(proposalId: string) {
    for (const r of this.lo.values()) {
      const o = parseO(JSON.parse(r));
      if (o.proposalId === proposalId) return o;
    }
    return null;
  }
  async listOperations(ownerHash: string) {
    return [...this.lo.values()].map((r) => parseO(JSON.parse(r))).filter((o) => o.ownerHash === ownerHash).sort((a, b) => a.createdAt.localeCompare(b.createdAt));
  }
  async updateOperation(rec: LiveOperationRecord, expectedFrom: LiveState) {
    const row = parseO(rec);
    const raw = this.lo.get(row.id);
    if (!raw) return false;
    const cur = parseO(JSON.parse(raw));
    if (cur.state !== expectedFrom || !validTransition(expectedFrom, row.state)) return false;
    if (LIVE_TERMINAL.includes(cur.state) && cur.state !== row.state) return false;
    this.lo.set(row.id, JSON.stringify(row));
    return true;
  }
  scopeHas(team: string | null, app: string) {
    return this.scope.has(`${teamKey(team)}\u0000${app}`);
  }
  async bootstrapScope(operationId: string, nowIso: string) {
    void nowIso;
    const raw = this.lo.get(operationId);
    if (!raw) return { ok: false, reason: "operation_not_found" };
    const o = parseO(JSON.parse(raw));
    if (o.kind !== "create_new_app") return { ok: false, reason: "not_a_creation" }; // an existing application is NEVER added to the scope by a release
    if (o.remote.appConfirmed !== true || !SCOPE_STATES.includes(o.state)) return { ok: false, reason: "creation_not_confirmed" };
    const p = this.lp.get(o.proposalId);
    if (!p || parseP(JSON.parse(p)).status !== "CONSUMED" || !this.la.some((a) => a.proposalId === o.proposalId && a.outcome === "accepted")) return { ok: false, reason: "not_approved" };
    this.scope.add(`${teamKey(o.teamId)}\u0000${o.appName}`);
    return { ok: true };
  }
  /** test seams */
  __tamperLiveProposal(id: string, patch: Record<string, unknown>) {
    const r = this.lp.get(id);
    if (r) this.lp.set(id, JSON.stringify({ ...(JSON.parse(r) as object), ...patch }));
  }
}

// =====================================================================================================================
export class SqliteLiveStore extends SqliteAgentStore implements LiveStore {
  constructor(file: string) {
    super(file);
    this.db.exec(`
      CREATE TABLE IF NOT EXISTS live_proposals (id TEXT PRIMARY KEY, run_id TEXT NOT NULL, owner_hash TEXT NOT NULL, team_key TEXT NOT NULL, app_name TEXT NOT NULL, operation_id TEXT NOT NULL UNIQUE, status TEXT NOT NULL, digest TEXT NOT NULL, fingerprint TEXT NOT NULL, created_at TEXT NOT NULL, expires_at TEXT NOT NULL, record_json TEXT NOT NULL);
      CREATE INDEX IF NOT EXISTS live_proposals_run ON live_proposals(run_id, created_at);
      CREATE UNIQUE INDEX IF NOT EXISTS live_proposals_pending ON live_proposals(team_key, app_name) WHERE status='PENDING';
      CREATE TABLE IF NOT EXISTS live_approvals (id TEXT PRIMARY KEY, proposal_id TEXT NOT NULL, operation_id TEXT NOT NULL, actor_hash TEXT NOT NULL, decision TEXT NOT NULL, outcome TEXT NOT NULL, decided_at TEXT NOT NULL, digest12 TEXT NOT NULL);
      CREATE INDEX IF NOT EXISTS live_approvals_proposal ON live_approvals(proposal_id);
      CREATE TABLE IF NOT EXISTS live_operations (id TEXT PRIMARY KEY, proposal_id TEXT NOT NULL UNIQUE, owner_hash TEXT NOT NULL, team_key TEXT NOT NULL, app_name TEXT NOT NULL, state TEXT NOT NULL, active INTEGER NOT NULL, created_at TEXT NOT NULL, updated_at TEXT NOT NULL, record_json TEXT NOT NULL);
      CREATE UNIQUE INDEX IF NOT EXISTS live_operations_active ON live_operations(team_key, app_name) WHERE active=1;
      CREATE TABLE IF NOT EXISTS app_scope (team_key TEXT NOT NULL, app_name TEXT NOT NULL, operation_id TEXT NOT NULL, added_at TEXT NOT NULL, PRIMARY KEY (team_key, app_name));
    `);
  }

  private hasActiveOp(team: string, app: string): boolean {
    return !!this.db.prepare("SELECT 1 AS x FROM live_operations WHERE team_key=? AND app_name=? AND active=1").get(team, app);
  }

  async createLiveProposal(p: LiveProposal, op: LiveOperationRecord) {
    const row = parseP(p);
    const opRow = parseO(op);
    return this.tx(() => {
      const tk = teamKey(row.teamId);
      if (this.db.prepare("SELECT 1 AS x FROM live_proposals WHERE team_key=? AND app_name=? AND status='PENDING'").get(tk, row.appName)) return { created: false as const, reason: "pending_exists" as const };
      if (this.hasActiveOp(tk, row.appName)) return { created: false as const, reason: "active_operation" as const };
      this.db.prepare("INSERT INTO live_proposals (id, run_id, owner_hash, team_key, app_name, operation_id, status, digest, fingerprint, created_at, expires_at, record_json) VALUES (?,?,?,?,?,?,?,?,?,?,?,?)").run(row.id, row.runId, row.ownerHash, tk, row.appName, row.operationId, row.status, row.digest, row.stateFingerprint, row.createdAt, row.expiresAt, JSON.stringify(row));
      this.db.prepare("INSERT INTO live_operations (id, proposal_id, owner_hash, team_key, app_name, state, active, created_at, updated_at, record_json) VALUES (?,?,?,?,?,?,?,?,?,?)").run(opRow.id, opRow.proposalId, opRow.ownerHash, tk, opRow.appName, opRow.state, isActiveOperation(opRow) ? 1 : 0, opRow.createdAt, opRow.updatedAt, JSON.stringify(opRow));
      return { created: true as const };
    });
  }
  private liveRowToProposal(r: Record<string, unknown>): LiveProposal {
    return { ...parseP(JSON.parse(String(r.record_json))), status: String(r.status) as LiveProposalStatus };
  }
  async getLiveProposal(id: string) {
    const r = this.db.prepare("SELECT * FROM live_proposals WHERE id=?").get(id);
    return r ? this.liveRowToProposal(r) : null;
  }
  async listLiveProposals(runId: string) {
    return this.db.prepare("SELECT * FROM live_proposals WHERE run_id=? ORDER BY created_at ASC").all(runId).map((r) => this.liveRowToProposal(r));
  }
  async transitionLiveProposal(id: string, to: ProposalTarget, nowIso: string, approval?: LiveApprovalRecord) {
    return this.tx(() => {
      const n = needs(to);
      const cond = n === "expiry_ok" ? "AND expires_at > ?" : n === "expired_only" ? "AND expires_at <= ?" : "";
      const args: unknown[] = [to, id];
      if (n !== "none") args.push(nowIso);
      const from = to === "EXPIRED" ? "('PENDING','APPROVED')" : "('PENDING')"; // see the in-memory store: APPROVED→EXPIRED only, and only once the deadline has passed
      const res = this.db.prepare(`UPDATE live_proposals SET status=? WHERE id=? AND status IN ${from} ${cond}`).run(...args) as { changes: number | bigint };
      if (Number(res.changes) !== 1) {
        const cur = this.db.prepare("SELECT status FROM live_proposals WHERE id=?").get(id);
        return { changed: false, status: (cur ? String(cur.status) : "BLOCKED") as LiveProposalStatus };
      }
      if (approval) this.db.prepare("INSERT INTO live_approvals (id, proposal_id, operation_id, actor_hash, decision, outcome, decided_at, digest12) VALUES (?,?,?,?,?,?,?,?)").run(approval.id, approval.proposalId, approval.operationId, approval.actorHash, approval.decision, approval.outcome, approval.decidedAt, approval.digest12);
      return { changed: true, status: to as LiveProposalStatus };
    });
  }
  async listLiveApprovals(proposalId: string) {
    return this.db.prepare("SELECT * FROM live_approvals WHERE proposal_id=? ORDER BY decided_at ASC").all(proposalId).map((r) => ({ id: String(r.id), proposalId: String(r.proposal_id), operationId: String(r.operation_id), decision: String(r.decision) as "approve" | "reject", actorHash: String(r.actor_hash), decidedAt: String(r.decided_at), digest12: String(r.digest12), outcome: String(r.outcome) as LiveApprovalRecord["outcome"], scope: "live" as const }));
  }
  async beginExecution(approvedOp: LiveOperationRecord, nowIso: string): Promise<StartResult> {
    const row = parseO(approvedOp);
    return this.tx((): StartResult => {
      const cur = this.db.prepare("SELECT state, proposal_id FROM live_operations WHERE id=?").get(row.id);
      if (!cur) return { started: false, reason: "operation_not_found" };
      if (String(cur.state) !== "AWAITING_LIVE_APPROVAL" || row.state !== "APPROVED") return { started: false, reason: "operation_not_awaiting" };
      const p = this.db.prepare("SELECT status, expires_at FROM live_proposals WHERE id=?").get(String(cur.proposal_id));
      if (!p || String(p.status) !== "APPROVED") return { started: false, reason: "proposal_not_approved" };
      if (String(p.expires_at) <= nowIso) return { started: false, reason: "expired" };
      const c = this.db.prepare("UPDATE live_proposals SET status='CONSUMED' WHERE id=? AND status='APPROVED'").run(String(cur.proposal_id)) as { changes: number | bigint };
      const o = this.db.prepare("UPDATE live_operations SET state='APPROVED', updated_at=?, record_json=? WHERE id=? AND state='AWAITING_LIVE_APPROVAL'").run(row.updatedAt, JSON.stringify(row), row.id) as { changes: number | bigint };
      if (Number(c.changes) !== 1 || Number(o.changes) !== 1) throw new Error("claim raced"); // rolls the whole claim back
      return { started: true };
    });
  }
  async listOperationsInStates(states: readonly LiveState[]) {
    if (states.length === 0) return [];
    const q = states.map(() => "?").join(",");
    return this.db.prepare(`SELECT record_json FROM live_operations WHERE state IN (${q})`).all(...states).map((r) => parseO(JSON.parse(String(r.record_json))));
  }
  async getOperation(id: string) {
    const r = this.db.prepare("SELECT record_json FROM live_operations WHERE id=?").get(id);
    return r ? parseO(JSON.parse(String(r.record_json))) : null;
  }
  async getOperationByProposal(proposalId: string) {
    const r = this.db.prepare("SELECT record_json FROM live_operations WHERE proposal_id=?").get(proposalId);
    return r ? parseO(JSON.parse(String(r.record_json))) : null;
  }
  async listOperations(ownerHash: string) {
    return this.db.prepare("SELECT record_json FROM live_operations WHERE owner_hash=? ORDER BY created_at ASC").all(ownerHash).map((r) => parseO(JSON.parse(String(r.record_json))));
  }
  async updateOperation(rec: LiveOperationRecord, expectedFrom: LiveState) {
    const row = parseO(rec);
    if (!validTransition(expectedFrom, row.state)) return false;
    return this.tx(() => {
      const res = this.db.prepare("UPDATE live_operations SET state=?, active=?, updated_at=?, record_json=? WHERE id=? AND state=?").run(row.state, isActiveOperation(row) ? 1 : 0, row.updatedAt, JSON.stringify(row), row.id, expectedFrom) as { changes: number | bigint };
      return Number(res.changes) === 1;
    });
  }
  scopeHas(team: string | null, app: string) {
    return !!this.db.prepare("SELECT 1 AS x FROM app_scope WHERE team_key=? AND app_name=?").get(teamKey(team), app);
  }
  async bootstrapScope(operationId: string, nowIso: string) {
    return this.tx(() => {
      const r = this.db.prepare("SELECT record_json FROM live_operations WHERE id=?").get(operationId);
      if (!r) return { ok: false, reason: "operation_not_found" };
      const o = parseO(JSON.parse(String(r.record_json)));
      if (o.kind !== "create_new_app") return { ok: false, reason: "not_a_creation" };
      if (o.remote.appConfirmed !== true || !SCOPE_STATES.includes(o.state)) return { ok: false, reason: "creation_not_confirmed" };
      const p = this.db.prepare("SELECT status FROM live_proposals WHERE id=?").get(o.proposalId);
      const a = this.db.prepare("SELECT 1 AS x FROM live_approvals WHERE proposal_id=? AND outcome='accepted'").get(o.proposalId);
      if (!p || String(p.status) !== "CONSUMED" || !a) return { ok: false, reason: "not_approved" };
      this.db.prepare("INSERT OR IGNORE INTO app_scope (team_key, app_name, operation_id, added_at) VALUES (?,?,?,?)").run(teamKey(o.teamId), o.appName, o.id, nowIso);
      return { ok: true };
    });
  }
  /** test seams */
  __rawLive(sql: string, ...p: unknown[]) {
    return this.db.prepare(sql).run(...p);
  }
  __allLive(sql: string, ...p: unknown[]) {
    return this.db.prepare(sql).all(...p);
  }
}
