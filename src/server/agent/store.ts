import { MemoryRunStore, SqliteRunStore, sanitizeForStore, type RunStore } from "../diagnostics/store";
import type { ActionProposal, AgentRunRecord, ApprovalRecord, ConversationMessage, ConversationRecord, ProposalStatus, SimulationResult } from "./types";

/** Hard bounds on stored events (SECURITY: no unbounded growth from a chatty or hostile client). */
export const MAX_MESSAGES_PER_CONVERSATION = 100;
export const MAX_TRANSITIONS_PER_RUN = 200;
export const MAX_TOOL_CALLS_RECORDED = 30;

export interface TransitionResult {
  changed: boolean;
  /** the status after the call (the new one if changed, otherwise the status that blocked the change) */
  status: ProposalStatus;
}

/**
 * Persistence for the agent workspace. Extends the diagnostic RunStore so that conversations, runs, proposals, approvals and
 * audit events share ONE database and ONE hash-chained audit log. Replaceable by PostgreSQL behind this interface.
 *
 * Never stored: tokens, raw API payloads, unredacted logs, credentials, env values, session ids (only SHA-256 owner hashes).
 * Every record passes `sanitizeForStore`. The 64-hex digest and state fingerprint live in dedicated columns because the
 * sanitiser (rightly) treats long hex strings as secrets.
 */
export interface AgentStore extends RunStore {
  createConversation(ownerHash: string, c: ConversationRecord): Promise<void>;
  getConversation(id: string): Promise<{ ownerHash: string; conversation: ConversationRecord } | null>;
  /** false when the per-conversation message cap is reached (message NOT stored) */
  addMessage(m: ConversationMessage): Promise<boolean>;
  listMessages(conversationId: string, limit?: number): Promise<ConversationMessage[]>;

  createAgentRun(ownerHash: string, r: AgentRunRecord): Promise<void>;
  saveAgentRun(r: AgentRunRecord): Promise<void>;
  getAgentRun(id: string): Promise<{ ownerHash: string; run: AgentRunRecord } | null>;
  listAgentRuns(conversationId: string): Promise<AgentRunRecord[]>;
  findRunningAgentRun(app: string): Promise<AgentRunRecord | null>;
  countRunningAgentRuns(): Promise<number>;
  countRecentAgentRuns(ownerHash: string, sinceIso: string): Promise<number>;
  recoverInterruptedAgentRuns(nowIso: string): Promise<number>;

  createProposal(ownerHash: string, p: ActionProposal): Promise<void>;
  getProposal(id: string): Promise<{ ownerHash: string; proposal: ActionProposal; result: SimulationResult | null } | null>;
  listProposals(runId: string): Promise<ActionProposal[]>;
  /** Atomic compare-and-set on the proposal status (single-use approvals, replay prevention). */
  transitionProposal(id: string, to: Exclude<ProposalStatus, "PENDING" | "SIMULATED_OK" | "SIMULATED_FAILED" | "VERIFICATION_FAILED">, nowIso: string, approval?: ApprovalRecord): Promise<TransitionResult>;
  finishProposal(id: string, status: "SIMULATED_OK" | "SIMULATED_FAILED" | "VERIFICATION_FAILED", result: SimulationResult): Promise<boolean>;
  listApprovals(proposalId: string): Promise<ApprovalRecord[]>;
}

const clipRun = (r: AgentRunRecord): AgentRunRecord => ({ ...r, transitions: r.transitions.slice(-MAX_TRANSITIONS_PER_RUN), toolCalls: r.toolCalls.slice(0, MAX_TOOL_CALLS_RECORDED) });
const split = (p: ActionProposal) => {
  const { digest, stateFingerprint, ...rest } = p;
  return { digest, stateFingerprint, json: JSON.stringify(sanitizeForStore(rest)) };
};
const join = (json: string, digest: string, stateFingerprint: string): ActionProposal => ({ ...(JSON.parse(json) as Omit<ActionProposal, "digest" | "stateFingerprint">), digest, stateFingerprint });
const requires = (to: string): "expiry_ok" | "expired_only" | "none" => (to === "APPROVED" || to === "REJECTED" ? "expiry_ok" : to === "EXPIRED" ? "expired_only" : "none");

// =====================================================================================================================
export class MemoryAgentStore extends MemoryRunStore implements AgentStore {
  private conversations = new Map<string, { ownerHash: string; json: string }>();
  private messages = new Map<string, string[]>();
  private aruns = new Map<string, { ownerHash: string; json: string }>();
  private proposals = new Map<string, { ownerHash: string; json: string; digest: string; fp: string; result: string | null }>();
  private approvals: ApprovalRecord[] = [];

  async createConversation(ownerHash: string, c: ConversationRecord) {
    this.conversations.set(c.id, { ownerHash, json: JSON.stringify(sanitizeForStore(c)) });
  }
  async getConversation(id: string) {
    const r = this.conversations.get(id);
    return r ? { ownerHash: r.ownerHash, conversation: JSON.parse(r.json) as ConversationRecord } : null;
  }
  async addMessage(m: ConversationMessage) {
    const list = this.messages.get(m.conversationId) ?? [];
    if (list.length >= MAX_MESSAGES_PER_CONVERSATION) return false;
    list.push(JSON.stringify(sanitizeForStore(m)));
    this.messages.set(m.conversationId, list);
    const c = this.conversations.get(m.conversationId);
    if (c) {
      const conv = JSON.parse(c.json) as ConversationRecord;
      conv.messageCount = list.length;
      conv.updatedAt = m.at;
      c.json = JSON.stringify(conv);
    }
    return true;
  }
  async listMessages(conversationId: string, limit = MAX_MESSAGES_PER_CONVERSATION) {
    return (this.messages.get(conversationId) ?? []).slice(-limit).map((j) => JSON.parse(j) as ConversationMessage);
  }

  async createAgentRun(ownerHash: string, r: AgentRunRecord) {
    this.aruns.set(r.id, { ownerHash, json: JSON.stringify(sanitizeForStore(clipRun(r))) });
  }
  async saveAgentRun(r: AgentRunRecord) {
    const cur = this.aruns.get(r.id);
    if (cur) cur.json = JSON.stringify(sanitizeForStore(clipRun(r)));
  }
  async getAgentRun(id: string) {
    const r = this.aruns.get(id);
    return r ? { ownerHash: r.ownerHash, run: JSON.parse(r.json) as AgentRunRecord } : null;
  }
  private allRuns() {
    return [...this.aruns.values()].map((r) => ({ ownerHash: r.ownerHash, run: JSON.parse(r.json) as AgentRunRecord }));
  }
  async listAgentRuns(conversationId: string) {
    return this.allRuns().map((r) => r.run).filter((r) => r.conversationId === conversationId).sort((a, b) => a.createdAt.localeCompare(b.createdAt));
  }
  async findRunningAgentRun(app: string) {
    return this.allRuns().map((r) => r.run).find((r) => r.app === app && r.status === "RUNNING") ?? null;
  }
  async countRunningAgentRuns() {
    return this.allRuns().filter((r) => r.run.status === "RUNNING").length;
  }
  async countRecentAgentRuns(ownerHash: string, sinceIso: string) {
    return this.allRuns().filter((r) => r.ownerHash === ownerHash && r.run.createdAt >= sinceIso).length;
  }
  async recoverInterruptedAgentRuns(nowIso: string) {
    let n = 0;
    for (const [id, r] of this.aruns) {
      const run = JSON.parse(r.json) as AgentRunRecord;
      if (run.status !== "RUNNING") continue;
      run.status = "FAILED";
      run.errorCode = "interrupted_by_restart";
      run.finishedAt = nowIso;
      run.updatedAt = nowIso;
      run.transitions.push({ at: nowIso, from: run.phase, to: "FAILED", actor: "system", outcome: "error", note: "interrupted_by_restart" });
      r.json = JSON.stringify(run);
      await this.appendAudit(nowIso, id, "agent_run_interrupted_by_restart", {});
      n++;
    }
    return n;
  }

  async createProposal(ownerHash: string, p: ActionProposal) {
    const s = split(p);
    this.proposals.set(p.id, { ownerHash, json: s.json, digest: s.digest, fp: s.stateFingerprint, result: null });
  }
  private hydrate(r: { json: string; digest: string; fp: string }, status?: ProposalStatus): ActionProposal {
    const p = join(r.json, r.digest, r.fp);
    return status ? { ...p, status } : p;
  }
  async getProposal(id: string) {
    const r = this.proposals.get(id);
    return r ? { ownerHash: r.ownerHash, proposal: this.hydrate(r), result: r.result ? (JSON.parse(r.result) as SimulationResult) : null } : null;
  }
  async listProposals(runId: string) {
    return [...this.proposals.values()].map((r) => this.hydrate(r)).filter((p) => p.runId === runId).sort((a, b) => a.createdAt.localeCompare(b.createdAt));
  }
  /** Synchronous check-and-set (no await between read and write) ⇒ atomic in this process. */
  async transitionProposal(id: string, to: TransitionTarget, nowIso: string, approval?: ApprovalRecord): Promise<TransitionResult> {
    const r = this.proposals.get(id);
    if (!r) return { changed: false, status: "BLOCKED" };
    const p = JSON.parse(r.json) as ActionProposal;
    const need = requires(to);
    const ok = p.status === "PENDING" && (need === "none" || (need === "expiry_ok" && p.expiresAt > nowIso) || (need === "expired_only" && p.expiresAt <= nowIso));
    if (!ok) return { changed: false, status: p.status };
    p.status = to;
    r.json = JSON.stringify(p);
    if (approval) this.approvals.push({ ...approval });
    return { changed: true, status: to };
  }
  async finishProposal(id: string, status: "SIMULATED_OK" | "SIMULATED_FAILED" | "VERIFICATION_FAILED", result: SimulationResult) {
    const r = this.proposals.get(id);
    if (!r) return false;
    const p = JSON.parse(r.json) as ActionProposal;
    if (p.status !== "APPROVED") return false;
    p.status = status;
    r.json = JSON.stringify(p);
    r.result = JSON.stringify(sanitizeForStore(result));
    return true;
  }
  async listApprovals(proposalId: string) {
    return this.approvals.filter((a) => a.proposalId === proposalId);
  }
  /** test seam: simulate tampering with a stored proposal */
  __tamperProposal(id: string, patch: Partial<ActionProposal>) {
    const r = this.proposals.get(id);
    if (r) r.json = JSON.stringify({ ...(JSON.parse(r.json) as object), ...patch });
  }
}

type TransitionTarget = Exclude<ProposalStatus, "PENDING" | "SIMULATED_OK" | "SIMULATED_FAILED" | "VERIFICATION_FAILED">;

// =====================================================================================================================
export class SqliteAgentStore extends SqliteRunStore implements AgentStore {
  constructor(file: string) {
    super(file);
    this.db.exec(`
      CREATE TABLE IF NOT EXISTS conversations (id TEXT PRIMARY KEY, owner_hash TEXT NOT NULL, created_at TEXT NOT NULL, updated_at TEXT NOT NULL, record_json TEXT NOT NULL);
      CREATE TABLE IF NOT EXISTS messages (id TEXT PRIMARY KEY, conversation_id TEXT NOT NULL, seq INTEGER NOT NULL, at TEXT NOT NULL, record_json TEXT NOT NULL);
      CREATE INDEX IF NOT EXISTS messages_conv ON messages(conversation_id, seq);
      CREATE TABLE IF NOT EXISTS agent_runs (id TEXT PRIMARY KEY, owner_hash TEXT NOT NULL, conversation_id TEXT NOT NULL, app TEXT NOT NULL, status TEXT NOT NULL, created_at TEXT NOT NULL, updated_at TEXT NOT NULL, record_json TEXT NOT NULL);
      CREATE INDEX IF NOT EXISTS agent_runs_conv ON agent_runs(conversation_id, created_at);
      CREATE INDEX IF NOT EXISTS agent_runs_active ON agent_runs(status, app);
      CREATE TABLE IF NOT EXISTS proposals (id TEXT PRIMARY KEY, run_id TEXT NOT NULL, owner_hash TEXT NOT NULL, app TEXT NOT NULL, status TEXT NOT NULL, digest TEXT NOT NULL, fingerprint TEXT NOT NULL, created_at TEXT NOT NULL, expires_at TEXT NOT NULL, record_json TEXT NOT NULL, result_json TEXT);
      CREATE INDEX IF NOT EXISTS proposals_run ON proposals(run_id, created_at);
      CREATE TABLE IF NOT EXISTS approvals (id TEXT PRIMARY KEY, proposal_id TEXT NOT NULL, actor_hash TEXT NOT NULL, decision TEXT NOT NULL, outcome TEXT NOT NULL, decided_at TEXT NOT NULL, digest12 TEXT NOT NULL);
      CREATE INDEX IF NOT EXISTS approvals_proposal ON approvals(proposal_id);
    `);
  }

  protected tx<T>(fn: () => T): T {
    this.db.exec("BEGIN IMMEDIATE");
    try {
      const out = fn();
      this.db.exec("COMMIT");
      return out;
    } catch (e) {
      this.db.exec("ROLLBACK");
      throw e;
    }
  }
  protected clean<T>(v: T): string {
    return JSON.stringify(sanitizeForStore(v));
  }

  async createConversation(ownerHash: string, c: ConversationRecord) {
    this.db.prepare("INSERT INTO conversations (id, owner_hash, created_at, updated_at, record_json) VALUES (?,?,?,?,?)").run(c.id, ownerHash, c.createdAt, c.updatedAt, this.clean(c));
  }
  async getConversation(id: string) {
    const r = this.db.prepare("SELECT owner_hash, record_json FROM conversations WHERE id=?").get(id);
    return r ? { ownerHash: String(r.owner_hash), conversation: JSON.parse(String(r.record_json)) as ConversationRecord } : null;
  }
  async addMessage(m: ConversationMessage) {
    return this.tx(() => {
      const n = Number(this.db.prepare("SELECT COUNT(*) AS n FROM messages WHERE conversation_id=?").get(m.conversationId)?.n ?? 0);
      if (n >= MAX_MESSAGES_PER_CONVERSATION) return false;
      this.db.prepare("INSERT INTO messages (id, conversation_id, seq, at, record_json) VALUES (?,?,?,?,?)").run(m.id, m.conversationId, n + 1, m.at, this.clean(m));
      const row = this.db.prepare("SELECT record_json FROM conversations WHERE id=?").get(m.conversationId);
      if (row) {
        const conv = JSON.parse(String(row.record_json)) as ConversationRecord;
        conv.messageCount = n + 1;
        conv.updatedAt = m.at;
        this.db.prepare("UPDATE conversations SET updated_at=?, record_json=? WHERE id=?").run(m.at, JSON.stringify(conv), m.conversationId);
      }
      return true;
    });
  }
  async listMessages(conversationId: string, limit = MAX_MESSAGES_PER_CONVERSATION) {
    return this.db.prepare("SELECT record_json FROM messages WHERE conversation_id=? ORDER BY seq DESC LIMIT ?").all(conversationId, limit).reverse().map((r) => JSON.parse(String(r.record_json)) as ConversationMessage);
  }

  async createAgentRun(ownerHash: string, r: AgentRunRecord) {
    this.db.prepare("INSERT INTO agent_runs (id, owner_hash, conversation_id, app, status, created_at, updated_at, record_json) VALUES (?,?,?,?,?,?,?,?)").run(r.id, ownerHash, r.conversationId, r.app, r.status, r.createdAt, r.updatedAt, this.clean(clipRun(r)));
  }
  async saveAgentRun(r: AgentRunRecord) {
    this.db.prepare("UPDATE agent_runs SET status=?, updated_at=?, record_json=? WHERE id=?").run(r.status, r.updatedAt, this.clean(clipRun(r)), r.id);
  }
  async getAgentRun(id: string) {
    const r = this.db.prepare("SELECT owner_hash, record_json FROM agent_runs WHERE id=?").get(id);
    return r ? { ownerHash: String(r.owner_hash), run: JSON.parse(String(r.record_json)) as AgentRunRecord } : null;
  }
  async listAgentRuns(conversationId: string) {
    return this.db.prepare("SELECT record_json FROM agent_runs WHERE conversation_id=? ORDER BY created_at ASC").all(conversationId).map((r) => JSON.parse(String(r.record_json)) as AgentRunRecord);
  }
  async findRunningAgentRun(app: string) {
    const r = this.db.prepare("SELECT record_json FROM agent_runs WHERE app=? AND status='RUNNING' LIMIT 1").get(app);
    return r ? (JSON.parse(String(r.record_json)) as AgentRunRecord) : null;
  }
  async countRunningAgentRuns() {
    return Number(this.db.prepare("SELECT COUNT(*) AS n FROM agent_runs WHERE status='RUNNING'").get()?.n ?? 0);
  }
  async countRecentAgentRuns(ownerHash: string, sinceIso: string) {
    return Number(this.db.prepare("SELECT COUNT(*) AS n FROM agent_runs WHERE owner_hash=? AND created_at>=?").get(ownerHash, sinceIso)?.n ?? 0);
  }
  async recoverInterruptedAgentRuns(nowIso: string) {
    const rows = this.db.prepare("SELECT record_json FROM agent_runs WHERE status='RUNNING'").all();
    for (const r of rows) {
      const run = JSON.parse(String(r.record_json)) as AgentRunRecord;
      run.status = "FAILED";
      run.errorCode = "interrupted_by_restart";
      run.finishedAt = nowIso;
      run.updatedAt = nowIso;
      run.transitions.push({ at: nowIso, from: run.phase, to: "FAILED", actor: "system", outcome: "error", note: "interrupted_by_restart" });
      await this.saveAgentRun(run);
      await this.appendAudit(nowIso, run.id, "agent_run_interrupted_by_restart", {});
    }
    return rows.length;
  }

  async createProposal(ownerHash: string, p: ActionProposal) {
    const s = split(p);
    this.db.prepare("INSERT INTO proposals (id, run_id, owner_hash, app, status, digest, fingerprint, created_at, expires_at, record_json) VALUES (?,?,?,?,?,?,?,?,?,?)").run(p.id, p.runId, ownerHash, p.app, p.status, s.digest, s.stateFingerprint, p.createdAt, p.expiresAt, s.json);
  }
  private rowToProposal(r: Record<string, unknown>): ActionProposal {
    const p = join(String(r.record_json), String(r.digest), String(r.fingerprint));
    return { ...p, status: String(r.status) as ProposalStatus };
  }
  async getProposal(id: string) {
    const r = this.db.prepare("SELECT * FROM proposals WHERE id=?").get(id);
    return r ? { ownerHash: String(r.owner_hash), proposal: this.rowToProposal(r), result: r.result_json ? (JSON.parse(String(r.result_json)) as SimulationResult) : null } : null;
  }
  async listProposals(runId: string) {
    return this.db.prepare("SELECT * FROM proposals WHERE run_id=? ORDER BY created_at ASC").all(runId).map((r) => this.rowToProposal(r));
  }
  async transitionProposal(id: string, to: TransitionTarget, nowIso: string, approval?: ApprovalRecord): Promise<TransitionResult> {
    return this.tx(() => {
      const need = requires(to);
      const cond = need === "expiry_ok" ? "AND expires_at > ?" : need === "expired_only" ? "AND expires_at <= ?" : "";
      const args: unknown[] = [to, id];
      if (need !== "none") args.push(nowIso);
      const res = this.db.prepare(`UPDATE proposals SET status=? WHERE id=? AND status='PENDING' ${cond}`).run(...args) as { changes: number | bigint };
      if (Number(res.changes) !== 1) {
        const cur = this.db.prepare("SELECT status FROM proposals WHERE id=?").get(id);
        return { changed: false, status: (cur ? String(cur.status) : "BLOCKED") as ProposalStatus };
      }
      if (approval) this.db.prepare("INSERT INTO approvals (id, proposal_id, actor_hash, decision, outcome, decided_at, digest12) VALUES (?,?,?,?,?,?,?)").run(approval.id, approval.proposalId, approval.actorHash, approval.decision, approval.outcome, approval.decidedAt, approval.digest.slice(0, 12));
      return { changed: true, status: to };
    });
  }
  async finishProposal(id: string, status: "SIMULATED_OK" | "SIMULATED_FAILED" | "VERIFICATION_FAILED", result: SimulationResult) {
    const res = this.db.prepare("UPDATE proposals SET status=?, result_json=? WHERE id=? AND status='APPROVED'").run(status, this.clean(result), id) as { changes: number | bigint };
    return Number(res.changes) === 1;
  }
  async listApprovals(proposalId: string) {
    return this.db.prepare("SELECT * FROM approvals WHERE proposal_id=? ORDER BY decided_at ASC").all(proposalId).map((r) => ({ id: String(r.id), proposalId: String(r.proposal_id), decision: String(r.decision) as "approve" | "reject", actorHash: String(r.actor_hash), decidedAt: String(r.decided_at), digest: String(r.digest12), outcome: String(r.outcome) as ApprovalRecord["outcome"], scope: "simulation" as const }));
  }
  /** test seams */
  __rawAgent(sql: string, ...p: unknown[]) {
    return this.db.prepare(sql).run(...p);
  }
  __allAgent(sql: string, ...p: unknown[]) {
    return this.db.prepare(sql).all(...p);
  }
}
