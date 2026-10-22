import { createHash, randomBytes } from "node:crypto";
import * as fa from "@/i18n/agent-fa";
import * as dfa from "@/i18n/deploy-fa";
import { analyzeSource } from "../deploy/analyze";
import { authorizeLiveExecution } from "../deploy/live-gate";
import { SIM_SCENARIOS, type SimScenario } from "../deploy/params";
import { buildPlan, deployFingerprint } from "../deploy/plan";
import { buildReadiness } from "../deploy/readiness";
import { recommend, TRAFFIC_VALUES, type Traffic } from "../deploy/recommend";
import { UPLOAD_LIMITS } from "../deploy/limits";
import { DECISION_FOR_ITEM, NO_DECISIONS, type UserDecisions } from "../deploy/types";
import { isZipError } from "../deploy/zip";
import { withProject } from "../deploy/workspace";
import { createSourceCollector } from "../diagnostics/evidence";
import type { DiagnosticLLMProvider } from "../diagnostics/llm/provider";
import { semanticsFor } from "../diagnostics/semantics";
import { ownerHashOf, sanitizeForStore } from "../diagnostics/store";
import type { AnyEvidence, Semantics, SourceKey } from "../diagnostics/types";
import { isLiaraError } from "../liara/errors";
import type { LiaraService } from "../liara/service";
import type { WindowMinutes } from "../liara/read-client";
import { log } from "../security/logger";
import { parseIntent, FOLLOW_UP_PROMPTS, MAX_MESSAGE_CHARS, SUGGESTED_PROMPTS, type ParseContext } from "./intent";
import { canonicalJson, contentOf, digestsEqual, evaluateProposal, OPERATION_POLICY, proposalDigest, type ProposalContent } from "./policy";
import { createPlan, MAX_TOOL_CALLS } from "./planner";
import { SimulatedExecutionBackend, type ExecutionBackend } from "./simulation/backend";
import type { AgentStore } from "./store";
import { executeTool, type ToolContext } from "./tools";
import {
  AGENT_TERMINAL,
  ENGINE_INTENT,
  type ActionProposal,
  type AgentIntent,
  type AgentPhase,
  type AgentRunRecord,
  type AgentStatus,
  type ApprovalRecord,
  type ConversationMessage,
  type ConversationRecord,
  type DeploymentRunData,
  type MessageKind,
  type SimulationResult,
  type ToolCallRecord,
} from "./types";

/**
 * Controlled agent workflow (state machine, all transitions persisted + audited):
 *   REQUEST_RECEIVED → INTENT_RESOLVED → PLAN_CREATED → COLLECTING_EVIDENCE → ANALYZING → REPORT_READY
 *   REPORT_READY → ACTION_PROPOSED → AWAITING_APPROVAL → APPROVED | REJECTED | EXPIRED → (SIMULATION_COMPLETED) → REPORT_READY
 * Investigation reuses the existing diagnostic engine through the tool registry. The remediation branch can only ever reach the
 * SIMULATOR (`ExecutionBackend.kind === "simulation"`): no write-capable Liara client exists anywhere in this code base.
 */

export const AGENT_NEXT: Record<AgentPhase, AgentPhase[]> = {
  REQUEST_RECEIVED: ["INTENT_RESOLVED"],
  INTENT_RESOLVED: ["PLAN_CREATED"],
  PLAN_CREATED: ["COLLECTING_EVIDENCE"],
  COLLECTING_EVIDENCE: ["ANALYZING"],
  ANALYZING: ["REPORT_READY"],
  REPORT_READY: ["ACTION_PROPOSED"],
  ACTION_PROPOSED: ["AWAITING_APPROVAL"],
  AWAITING_APPROVAL: ["APPROVED", "REJECTED", "EXPIRED"],
  APPROVED: ["SIMULATION_COMPLETED", "SIMULATION_RUNNING"],
  REJECTED: ["REPORT_READY", "READINESS_REVIEW"],
  EXPIRED: ["REPORT_READY", "READINESS_REVIEW"],
  SIMULATION_COMPLETED: ["REPORT_READY"],
  // Phase 1E — first-deployment runs (same engine, same approval gate)
  SOURCE_RECEIVED: ["SOURCE_ANALYZING"],
  SOURCE_ANALYZING: ["READINESS_REVIEW"],
  READINESS_REVIEW: ["PLAN_PREPARED"],
  PLAN_PREPARED: ["AWAITING_APPROVAL"],
  SIMULATION_RUNNING: ["SIMULATION_VERIFICATION", "SIMULATION_COMPLETED", "READINESS_REVIEW"],
  SIMULATION_VERIFICATION: ["SIMULATION_COMPLETED", "READINESS_REVIEW"],
};

export { AgentError, isAgentError, type AgentErrorCode } from "./errors";
import { AgentError, isAgentError } from "./errors";

export interface ProposalView {
  proposal: ActionProposal;
  result: SimulationResult | null;
  approvals: ApprovalRecord[];
}

export interface ManagerOptions {
  svc: LiaraService;
  store: AgentStore;
  provider: DiagnosticLLMProvider;
  backend?: ExecutionBackend;
  runTimeoutMs?: number;
  toolTimeoutMs?: number;
  maxConcurrentRuns?: number;
  quotaPerWindow?: number;
  quotaWindowMs?: number;
  maxRetryDepth?: number;
  now?: () => number;
  semantics?: (app: string, mode: "mock" | "live") => Semantics;
  /** returns a fingerprint of the app's CURRENT state (read-only), or null when it cannot be verified */
  stateProbe?: (app: string) => Promise<string | null>;
  /** per-session upload quota (defaults to UPLOAD_LIMITS) */
  uploadQuota?: { perWindow: number; windowMs: number };
  hooks?: { afterTool?: (run: AgentRunRecord) => Promise<void> | void; beforeDecision?: () => Promise<void> | void };
}

interface Active {
  ac: AbortController;
  reason: "cancelled" | "timeout" | null;
  done: Promise<void>;
}

const rid = (prefix: string, nowMs: number) => `${prefix}_${new Date(nowMs).toISOString().replace(/[-:T.Z]/g, "").slice(0, 14)}_${randomBytes(4).toString("hex")}`;
const shortHash = (s: string) => ownerHashOf(s).slice(0, 8);

export class AgentRunManager {
  private active = new Map<string, Active>();
  private lock: Promise<unknown> = Promise.resolve();
  private ready: Promise<void>;
  private recentEvidence = new Map<string, { at: number; items: AnyEvidence[] }>();
  private uploads = new Map<string, number[]>();
  private o: Required<Omit<ManagerOptions, "hooks" | "semantics" | "stateProbe" | "backend">> & Pick<ManagerOptions, "hooks" | "semantics" | "stateProbe"> & { backend: ExecutionBackend };

  constructor(opts: ManagerOptions) {
    this.o = { uploadQuota: { perWindow: UPLOAD_LIMITS.maxUploadsPerWindow, windowMs: UPLOAD_LIMITS.uploadWindowMs }, runTimeoutMs: 30_000, toolTimeoutMs: 10_000, maxConcurrentRuns: 2, quotaPerWindow: 20, quotaWindowMs: 10 * 60_000, maxRetryDepth: 2, now: Date.now, backend: new SimulatedExecutionBackend(), ...opts };
    this.ready = this.o.store.recoverInterruptedAgentRuns(new Date(this.o.now()).toISOString()).then((c) => {
      if (c) log("warn", "agent.recovered_interrupted_runs", { count: c });
    });
  }

  private nowMs() {
    return this.o.now();
  }
  private iso() {
    return new Date(this.nowMs()).toISOString();
  }
  /** Serialises state-changing operations (start / propose / decide) so check-then-act sequences are atomic in this process. */
  private serial<T>(fn: () => Promise<T>): Promise<T> {
    const next = this.lock.then(fn);
    this.lock = next.catch(() => undefined);
    return next;
  }
  private audit(runId: string | null, event: string, data: Record<string, unknown> = {}) {
    return this.o.store.appendAudit(this.iso(), runId, `agent.${event}`, data);
  }

  // =============================================================================================== conversation helpers
  private async ownedConversation(id: string, sessionId: string): Promise<ConversationRecord> {
    const c = await this.o.store.getConversation(id);
    if (!c || c.ownerHash !== ownerHashOf(sessionId)) throw new AgentError("not_found");
    return c.conversation;
  }

  private async say(conv: { id: string }, role: ConversationMessage["role"], kind: MessageKind, textFa: string, extra: Partial<ConversationMessage> = {}, strict = false): Promise<ConversationMessage> {
    const m: ConversationMessage = { id: rid("msg", this.nowMs()), conversationId: conv.id, role, kind, textFa: sanitizeForStore(textFa), at: this.iso(), ...extra };
    const stored = await this.o.store.addMessage(m);
    if (!stored) {
      if (strict) throw new AgentError("conversation_full"); // the cap protects storage from a chatty client
      log("warn", "agent.conversation_full", { conversationId: conv.id });
    }
    return m;
  }

  private async apps(): Promise<string[]> {
    const l = await this.o.svc.listApps();
    return l.ok ? l.data.items.map((a) => a.name) : [];
  }

  private async parseContext(conv: ConversationRecord): Promise<ParseContext> {
    const runs = await this.o.store.listAgentRuns(conv.id);
    const withReport = [...runs].reverse().find((r) => r.report && r.status === "READY");
    const diag = runs.filter((r) => r.kind !== "deployment");
    return {
      apps: await this.apps(),
      lastApp: diag.at(-1)?.app ?? conv.app,
      lastIntent: diag.at(-1)?.intent ?? null,
      hasReport: !!withReport,
      lastReportHypotheses: withReport?.report?.hypotheses.map((h) => ({ key: h.key, titleFa: h.titleFa })) ?? null,
    };
  }

  // =============================================================================================== public: message entry
  /** Handles one operator message: parse (deterministic) → refuse / clarify / answer from the report / start a read-only investigation. */
  async handleMessage(req: { sessionId: string; conversationId?: string | null; text: string }): Promise<{ conversationId: string; messages: ConversationMessage[]; runId: string | null; proposalId: string | null }> {
    await this.ready;
    const owner = ownerHashOf(req.sessionId);
    let conv: ConversationRecord;
    if (req.conversationId) conv = await this.ownedConversation(req.conversationId, req.sessionId);
    else {
      const now = this.iso();
      conv = { id: rid("conv", this.nowMs()), app: null, createdAt: now, updatedAt: now, messageCount: 0 };
      await this.o.store.createConversation(owner, conv);
      await this.audit(null, "conversation_created", { conversationId: conv.id });
    }
    const out: ConversationMessage[] = [];
    const text = String(req.text ?? "").slice(0, MAX_MESSAGE_CHARS + 1);
    out.push(await this.say(conv, "user", "user", text.slice(0, MAX_MESSAGE_CHARS), {}, true));

    const parsed = parseIntent(text, await this.parseContext(conv));
    await this.audit(null, "intent_parsed", { conversationId: conv.id, kind: parsed.kind, intent: parsed.kind === "resolved" ? parsed.intent : null, reason: parsed.kind === "resolved" ? null : parsed.reason, rules: parsed.kind === "resolved" ? parsed.rules : [] });

    if (parsed.kind === "unsupported") {
      out.push(await this.say(conv, "agent", "refusal", parsed.messageFa, { intent: parsed.reason === "policy_override" || parsed.reason === "blocked_action" ? "unsupported" : "unsupported", suggestions: parsed.suggestions.slice(0, 5) }));
      return { conversationId: conv.id, messages: out, runId: null, proposalId: null };
    }
    if (parsed.kind === "clarify") {
      out.push(await this.say(conv, "agent", "clarification", parsed.questionFa, { intent: "ambiguous", suggestions: parsed.options.map((o) => o.text) }));
      return { conversationId: conv.id, messages: out, runId: null, proposalId: null };
    }

    const runs = await this.o.store.listAgentRuns(conv.id);
    const reportRun = [...runs].reverse().find((r) => r.report && r.status === "READY");

    switch (parsed.intent) {
      case "start_deployment":
      case "check_compatibility":
      case "recommend_plan":
      case "predeploy_checklist":
        return this.handleDeployIntent(conv, parsed.intent, req.sessionId, out);
      case "explain_finding": {
        out.push(await this.say(conv, "agent", "explanation", fa.explainText(reportRun!.report!, parsed.ref?.index ?? 1), { intent: parsed.intent, runId: reportRun!.id, suggestions: FOLLOW_UP_PROMPTS.map((f) => f.text) }));
        return { conversationId: conv.id, messages: out, runId: reportRun!.id, proposalId: null };
      }
      case "review_remediation": {
        out.push(await this.say(conv, "agent", "remediation_review", fa.reviewText(reportRun!.report!), { intent: parsed.intent, runId: reportRun!.id, suggestions: [FOLLOW_UP_PROMPTS[2]!.text] }));
        return { conversationId: conv.id, messages: out, runId: reportRun!.id, proposalId: null };
      }
      case "simulate_remediation_plan": {
        try {
          const p = await this.propose(reportRun!.id, req.sessionId, {});
          out.push(await this.say(conv, "agent", "proposal", fa.proposalText(p.proposal), { intent: parsed.intent, runId: reportRun!.id, proposalId: p.proposal.id }));
          return { conversationId: conv.id, messages: out, runId: reportRun!.id, proposalId: p.proposal.id };
        } catch (e) {
          if (!isAgentError(e)) throw e;
          const msg = e.code === "no_applicable_operation" ? fa.noOperation : e.code === "proposal_pending" ? fa.proposalPending : "ساخت طرح شبیه‌سازی ممکن نشد.";
          out.push(await this.say(conv, "agent", "refusal", msg, { intent: parsed.intent, runId: reportRun!.id }));
          return { conversationId: conv.id, messages: out, runId: reportRun!.id, proposalId: null };
        }
      }
      default: {
        const app = parsed.app!;
        out.push(await this.say(conv, "agent", "ack", fa.ack(parsed.intent, app, parsed.windowNoteFa), { intent: parsed.intent }));
        try {
          const run = await this.startInvestigation({ sessionId: req.sessionId, conv, app, intent: parsed.intent, windowMinutes: parsed.windowMinutes ?? 60, retryOf: null });
          return { conversationId: conv.id, messages: out, runId: run.id, proposalId: null };
        } catch (e) {
          if (isAgentError(e)) {
            const msgs: Partial<Record<string, string>> = { run_in_progress: "برای این برنامه هم‌اکنون یک بررسی در حال اجراست؛ منتظر پایان آن بمانید.", too_many_runs: "تعداد بررسی‌های هم‌زمان به سقف رسیده است؛ کمی صبر کنید.", run_quota_exceeded: "سهمیهٔ بررسی این بازه تمام شد؛ بعداً دوباره تلاش کنید." };
            out.push(await this.say(conv, "agent", "refusal", msgs[e.code] ?? "شروع بررسی ممکن نشد.", { intent: parsed.intent, ...(e.extra.existingRunId ? { runId: e.extra.existingRunId } : {}) }));
            return { conversationId: conv.id, messages: out, runId: e.extra.existingRunId ?? null, proposalId: null };
          }
          if (isLiaraError(e)) {
            out.push(await this.say(conv, "agent", "refusal", "برنامهٔ مورد نظر در فهرست مجاز نیست.", { intent: parsed.intent }));
            return { conversationId: conv.id, messages: out, runId: null, proposalId: null };
          }
          throw e;
        }
      }
    }
  }

  // =============================================================================================== investigation runs
  private startInvestigation(req: { sessionId: string; conv: ConversationRecord; app: string; intent: AgentIntent; windowMinutes: number; retryOf: string | null }): Promise<AgentRunRecord> {
    return this.serial(async () => {
      await this.ready;
      const { store, svc } = this.o;
      if (!svc.isAllowed(req.app)) throw Object.assign(new Error("app_not_allowed"), { name: "LiaraError", code: "app_not_allowed" });
      const owner = ownerHashOf(req.sessionId);
      const dup = await store.findRunningAgentRun(req.app);
      if (dup) throw new AgentError("run_in_progress", { existingRunId: dup.id });
      if ((await store.countRunningAgentRuns()) >= this.o.maxConcurrentRuns) throw new AgentError("too_many_runs");
      if ((await store.countRecentAgentRuns(owner, new Date(this.nowMs() - this.o.quotaWindowMs).toISOString())) >= this.o.quotaPerWindow) throw new AgentError("run_quota_exceeded");

      const now = this.iso();
      const run: AgentRunRecord = {
        id: rid("arun", this.nowMs()), conversationId: req.conv.id, app: req.app, intent: req.intent, windowMinutes: req.windowMinutes, mode: svc.mode,
        status: "RUNNING", phase: "REQUEST_RECEIVED", createdAt: now, updatedAt: now, finishedAt: null, retryOf: req.retryOf, plan: null, toolCalls: [],
        transitions: [{ at: now, from: null, to: "REQUEST_RECEIVED", actor: `operator:${shortHash(req.sessionId)}`, outcome: "ok" }], errorCode: null, report: null, proposalIds: [],
      };
      await store.createAgentRun(owner, run);
      await this.audit(run.id, "run_created", { app: run.app, intent: run.intent, window: run.windowMinutes, mode: run.mode, retryOf: req.retryOf, actor: shortHash(req.sessionId) });
      const accepted = structuredClone(run);
      const ac = new AbortController();
      const entry: Active = { ac, reason: null, done: Promise.resolve() };
      this.active.set(run.id, entry);
      entry.done = this.execute(run, entry, req.conv)
        .catch((e: unknown) => log("error", "agent.run_unrecoverable", { runId: run.id, name: (e as { name?: string })?.name }))
        .finally(() => this.active.delete(run.id));
      return accepted;
    });
  }

  private async persist(run: AgentRunRecord) {
    run.updatedAt = this.iso();
    await this.o.store.saveAgentRun(run);
  }

  private async transition(run: AgentRunRecord, to: AgentPhase, opts: { actor?: string; outcome?: "ok" | "error" | "blocked"; note?: string; meta?: Record<string, string | number | boolean | null> } = {}) {
    if (!AGENT_NEXT[run.phase].includes(to)) throw new Error(`invalid agent transition ${run.phase} -> ${to}`);
    const from = run.phase;
    run.transitions.push({ at: this.iso(), from, to, actor: opts.actor ?? "agent", outcome: opts.outcome ?? "ok", note: opts.note, meta: opts.meta });
    run.phase = to;
    await this.persist(run);
    await this.audit(run.id, "transition", { from, to, outcome: opts.outcome ?? "ok", actor: opts.actor ?? "agent", note: opts.note ?? null });
  }

  private async finish(run: AgentRunRecord, status: AgentStatus, errorCode: string | null) {
    run.status = status;
    run.errorCode = errorCode;
    run.finishedAt = this.iso();
    run.transitions.push({ at: run.finishedAt, from: run.phase, to: status, actor: "agent", outcome: status === "READY" ? "ok" : "error", note: errorCode ?? undefined });
    for (const t of run.toolCalls) if (t.status === "pending" || t.status === "running") t.status = "skipped";
    await this.persist(run);
    await this.audit(run.id, "run_finished", { status, errorCode });
  }

  private summarize(tool: string, output: unknown): ToolCallRecord["summary"] {
    const o = output as Record<string, unknown>;
    const g = (k: string) => (o[k] ?? null) as Record<string, unknown> | null;
    const pick = (x: Record<string, unknown> | null, keys: string[]) => Object.fromEntries(keys.map((k) => [k, typeof x?.[k] === "number" || typeof x?.[k] === "string" || typeof x?.[k] === "boolean" ? (x![k] as string | number | boolean) : null]));
    switch (tool) {
      case "list_apps": return { appCount: ((o.apps as unknown[]) ?? []).length };
      case "get_app_details": return { envKeyCount: ((g("details")?.envKeys as unknown[]) ?? []).length };
      case "get_runtime_status": return pick(g("runtime"), ["enabled", "runtime", "appletCount"]);
      case "get_recent_releases": return pick(g("releases"), ["total", "currentRelease"]);
      case "get_recent_events": return pick(g("events"), ["rowCount"]);
      case "get_application_logs": return pick(g("logs"), ["lineCount", "truncated"]);
      case "get_cpu_metrics":
      case "get_memory_metrics": return { seriesCount: ((g("metrics")?.series as unknown[]) ?? []).length, schema: (g("metrics")?.schema as string) ?? null };
      case "diagnose_application": return { status: (o.status as string) ?? null, hypotheses: ((o.hypotheses as unknown[]) ?? []).length, recommendations: (o.recommendationCount as number) ?? 0 };
      default: return {};
    }
  }

  private async execute(run: AgentRunRecord, a: Active, conv: ConversationRecord): Promise<void> {
    const timer = setTimeout(() => {
      a.reason ??= "timeout";
      a.ac.abort();
    }, this.o.runTimeoutMs);
    const aborted = async (): Promise<boolean> => {
      if (!a.ac.signal.aborted) return false;
      await this.finish(run, a.reason === "timeout" ? "TIMED_OUT" : "CANCELLED", a.reason === "timeout" ? "run_timeout" : "cancelled_by_operator");
      await this.say(conv, "system", "system", a.reason === "timeout" ? "بررسی از زمان مجاز بیشتر طول کشید و متوقف شد." : "بررسی لغو شد.", { runId: run.id });
      return true;
    };
    try {
      await this.transition(run, "INTENT_RESOLVED", { meta: { intent: run.intent } });
      const cached = this.recentEvidence.get(conv.id);
      const existing = cached && this.nowMs() - cached.at < 5 * 60_000 ? cached.items : [];
      const plan = createPlan({ svc: this.o.svc, app: run.app, intent: run.intent, windowMinutes: run.windowMinutes, existingEvidence: existing, now: this.o.now, maxToolCalls: MAX_TOOL_CALLS });
      run.plan = plan;
      run.toolCalls = plan.steps.map((s) => ({ stepId: s.id, tool: s.tool, reasonFa: s.reasonFa, status: "pending" }));
      await this.transition(run, "PLAN_CREATED", { meta: { steps: plan.steps.length, skipped: plan.skipped.length } });
      await this.say(conv, "agent", "plan", fa.planText(plan), { runId: run.id, intent: run.intent });
      if (plan.steps.length === 0 || !plan.steps.some((s) => s.tool === "diagnose_application")) {
        await this.finish(run, "FAILED", "plan_blocked");
        await this.say(conv, "agent", "refusal", "برنامهٔ بررسی ساخته نشد (برنامه مجاز نیست یا هیچ ابزاری در دسترس نیست).", { runId: run.id });
        return;
      }

      await this.transition(run, "COLLECTING_EVIDENCE");
      const evidence = new Map<SourceKey, AnyEvidence>();
      for (const e of existing) if (e.app === run.app) evidence.set(e.source, e);
      const report: ToolContext["report"] = { current: null };
      const mode = this.o.svc.mode;
      const ctx: ToolContext = {
        svc: this.o.svc, runId: run.id, app: run.app, windowMinutes: run.windowMinutes as WindowMinutes, now: this.o.now, sourceTimeoutMs: this.o.toolTimeoutMs, signal: a.ac.signal,
        budget: { max: plan.budget.maxToolCalls, used: 0 }, evidence, provider: this.o.provider, semantics: (this.o.semantics ?? semanticsFor)(run.app, mode), report,
        audit: (event, data) => this.audit(run.id, event, data), actor: "agent",
      };

      const usable = (s: SourceKey) => ctx.evidence.get(s)?.availability === "available" || ctx.evidence.get(s)?.availability === "stale";
      for (const step of plan.steps) {
        if (await aborted()) return;
        const rec = run.toolCalls.find((t) => t.stepId === step.id)!;
        // P7: when neither logs nor events could be read, the optional deep dives cannot change the outcome → skip and save budget
        const timelineDead = ["logs", "events"].every((s) => ctx.evidence.has(s as SourceKey) && !usable(s as SourceKey));
        if (step.optional && timelineDead) {
          rec.status = "skipped";
          rec.errorCode = "timeline_unavailable";
          plan.skipped.push({ tool: step.tool, code: "timeline_unavailable", reasonFa: "لاگ و رویداد هیچ‌کدام در دسترس نبود؛ این مرحلهٔ اختیاری نتیجه را تغییر نمی‌داد." });
          await this.persist(run);
          continue;
        }
        if (step.tool === "diagnose_application") await this.transition(run, "ANALYZING");
        rec.status = "running";
        rec.startedAt = this.iso();
        await this.persist(run);
        const res = await executeTool(ctx, step.tool, step.args);
        rec.endedAt = this.iso();
        rec.durationMs = res.durationMs;
        if (res.ok) {
          rec.status = "succeeded";
          rec.availability = res.availability;
          rec.evidenceId = res.evidenceId;
          rec.summary = this.summarize(step.tool, res.output);
        } else {
          rec.status = "failed";
          rec.errorCode = res.error;
        }
        await this.persist(run);
        await this.o.hooks?.afterTool?.(run);
        if (!res.ok && step.tool === "diagnose_application") {
          if (await aborted()) return;
          await this.finish(run, "FAILED", res.error);
          await this.say(conv, "system", "system", "تحلیل ناموفق بود.", { runId: run.id });
          return;
        }
      }
      if (await aborted()) return;
      if (!report.current) {
        await this.finish(run, "FAILED", "no_report");
        return;
      }
      run.report = report.current;
      this.recentEvidence.set(conv.id, { at: this.nowMs(), items: [...ctx.evidence.values()] });
      await this.transition(run, "REPORT_READY", { meta: { status: report.current.summary.status } });
      await this.finish(run, "READY", null);
      await this.say(conv, "agent", "report", fa.reportText(report.current), { runId: run.id, intent: run.intent, suggestions: FOLLOW_UP_PROMPTS.map((f) => f.text) });
    } catch (e) {
      const code = isLiaraError(e) ? e.code : (e as { code?: string })?.code === "cancelled" ? "cancelled_by_operator" : "agent_error";
      log("error", "agent.run_failed", { runId: run.id, code, name: (e as { name?: string })?.name });
      if (!AGENT_TERMINAL.includes(run.status)) {
        await this.finish(run, "FAILED", code);
        await this.say(conv, "system", "system", "بررسی با خطای داخلی متوقف شد.", { runId: run.id });
      }
    } finally {
      clearTimeout(timer);
    }
  }

  // =============================================================================================== views and run control
  private async ownedRun(id: string, sessionId: string): Promise<AgentRunRecord> {
    await this.ready;
    const r = await this.o.store.getAgentRun(id);
    if (!r || r.ownerHash !== ownerHashOf(sessionId)) throw new AgentError("not_found"); // other sessions' runs look "not found"
    return r.run;
  }

  async getRun(id: string, sessionId: string): Promise<{ run: AgentRunRecord; proposals: ProposalView[] }> {
    const run = await this.ownedRun(id, sessionId);
    for (const p of await this.o.store.listProposals(run.id)) await this.expireIfDue(p.id);
    return { run: (await this.o.store.getAgentRun(id))!.run, proposals: await this.proposalViews(run.id) };
  }

  private async proposalViews(runId: string): Promise<ProposalView[]> {
    const list = await this.o.store.listProposals(runId);
    return Promise.all(list.map(async (p) => ({ proposal: p, result: (await this.o.store.getProposal(p.id))?.result ?? null, approvals: await this.o.store.listApprovals(p.id) })));
  }

  async getConversationView(id: string, sessionId: string) {
    await this.ready;
    const conversation = await this.ownedConversation(id, sessionId);
    const runs = await this.o.store.listAgentRuns(id);
    for (const r of runs) for (const p of await this.o.store.listProposals(r.id)) await this.expireIfDue(p.id);
    const fresh = await this.o.store.listAgentRuns(id);
    const latest = fresh.at(-1) ?? null;
    return {
      conversation,
      messages: await this.o.store.listMessages(id),
      runs: fresh.map((r) => ({ id: r.id, app: r.app, intent: r.intent, status: r.status, phase: r.phase, createdAt: r.createdAt })),
      activeRun: latest,
      proposals: latest ? await this.proposalViews(latest.id) : [],
    };
  }

  async cancel(id: string, sessionId: string): Promise<AgentRunRecord> {
    const run = await this.ownedRun(id, sessionId);
    const a = this.active.get(id);
    if (run.status === "RUNNING" && a) {
      a.reason ??= "cancelled";
      a.ac.abort();
      await a.done;
    } else if (run.status === "READY") {
      // closing an open approval branch: the pending proposal is cancelled, nothing is executed
      for (const p of await this.o.store.listProposals(run.id)) {
        if (p.status !== "PENDING") continue;
        const t = await this.o.store.transitionProposal(p.id, "CANCELLED", this.iso());
        if (t.changed) await this.closeBranch(run.id, "REJECTED", "cancelled_by_operator", "blocked");
      }
    }
    return (await this.o.store.getAgentRun(id))!.run;
  }

  async retry(id: string, sessionId: string): Promise<AgentRunRecord> {
    const prev = await this.ownedRun(id, sessionId);
    if (!["FAILED", "TIMED_OUT"].includes(prev.status)) throw new AgentError("retry_not_allowed");
    let depth = 1;
    for (let cur = prev.retryOf; cur; depth++) {
      if (depth >= this.o.maxRetryDepth) throw new AgentError("retry_not_allowed"); // bounded retry chain
      cur = (await this.o.store.getAgentRun(cur))?.run.retryOf ?? null;
    }
    const conv = await this.ownedConversation(prev.conversationId, sessionId);
    return this.startInvestigation({ sessionId, conv, app: prev.app, intent: prev.intent, windowMinutes: prev.windowMinutes, retryOf: prev.id });
  }

  async waitFor(runId: string): Promise<void> {
    await this.active.get(runId)?.done;
  }

  // =============================================================================================== remediation branch (SIMULATED)
  private async stateFingerprint(app: string): Promise<string | null> {
    if (this.o.stateProbe) return this.o.stateProbe(app);
    const c = createSourceCollector(this.o.svc, { runId: "probe", app, windowMinutes: 60, now: this.o.now, sourceTimeoutMs: this.o.toolTimeoutMs });
    const [app_, rt, rel] = await Promise.all([c.collect("app"), c.collect("runtime"), c.collect("releases")]);
    if (app_.source !== "app" || rt.source !== "runtime" || !app_.data || !rt.data) return null; // cannot verify the current state
    const releases = rel.source === "releases" ? rel.data : null;
    return createHash("sha256").update(canonicalJson({ scale: app_.data.scale, isDeployed: app_.data.isDeployed, planId: app_.data.planId, status: app_.data.status, runtime: rt.data.assessment.runtime, applets: rt.data.assessment.appletCount, current: releases?.currentRelease ?? null })).digest("hex");
  }

  /** Builds an immutable, server-generated proposal from a report recommendation. It can only ever be simulated. */
  propose(runId: string, sessionId: string, opts: { recommendationId?: string }): Promise<ProposalView> {
    return this.serial(async () => {
      const run = await this.ownedRun(runId, sessionId);
      const { store, svc } = this.o;
      for (const p of await store.listProposals(run.id)) await this.expireIfDue(p.id);
      const existing = await store.listProposals(run.id);
      if (existing.some((p) => p.status === "PENDING")) throw new AgentError("proposal_pending");
      const fresh = (await store.getAgentRun(run.id))!.run;
      if (fresh.status !== "READY" || fresh.phase !== "REPORT_READY" || !fresh.report) throw new AgentError("not_ready");
      Object.assign(run, fresh); // an expiry above may have advanced the stored run
      if (existing.length >= 3) throw new AgentError("proposal_limit");
      const taken = new Set(existing.filter((p) => ["PENDING", "APPROVED", "SIMULATED_OK", "SIMULATED_FAILED", "VERIFICATION_FAILED"].includes(p.status)).map((p) => p.recommendationId));
      const cands = (fresh.report?.recommendations ?? []).filter((r) => r.operation && r.actor === "liara_operation_future" && (r.risk === "R1" || r.risk === "R2") && !taken.has(r.id) && (!opts.recommendationId || r.id === opts.recommendationId));
      // an operation whose parameters cannot be derived from evidence (e.g. unknown variable names) is NOT proposed: nothing is invented
      const rec = cands.find((r) => evaluateProposal({ app: run.app, operation: r.operation!.kind, params: r.operation!.params, risk: r.risk, executionMode: "simulation", confirmation: OPERATION_POLICY[r.operation!.kind].confirmation }, (x) => svc.isAllowed(x)).ok);
      if (!rec) throw new AgentError("no_applicable_operation");
      const fp = await this.stateFingerprint(run.app);
      if (!fp) throw new AgentError("not_ready"); // fail closed: the current state cannot be observed
      const op = rec.operation!;
      const policy = OPERATION_POLICY[op.kind];
      const created = this.iso();
      const content: ProposalContent = sanitizeForStore({
        id: rid("prop", this.nowMs()), runId: run.id, conversationId: run.conversationId, app: run.app, operation: op.kind, params: op.params, risk: rec.risk, executionMode: "simulation" as const,
        recommendationId: rec.id, relatedDiagnosis: rec.relatedDiagnosis, evidenceIds: rec.evidenceIds, stateFingerprint: fp,
        descriptionFa: `${policy.labelFa}: ${rec.descriptionFa}`, impactFa: rec.expectedImpactFa, downtimeFa: policy.downtimeFa,
        preconditionsFa: [...policy.preconditionsFa, ...rec.prerequisitesFa], verificationPlanFa: rec.verificationPlanFa,
        confirmation: policy.confirmation === "type_app_name" ? ("type_app_name" as const) : ("click" as const), createdAt: created, expiresAt: new Date(this.nowMs() + policy.ttlSec * 1000).toISOString(),
      });
      // keep the fingerprint untouched by the sanitiser (64-hex looks like a secret to it)
      content.stateFingerprint = fp;
      const proposal: ActionProposal = { ...content, digest: proposalDigest(content), status: "PENDING" };
      const verdict = evaluateProposal({ app: proposal.app, operation: proposal.operation, params: proposal.params, risk: proposal.risk, executionMode: proposal.executionMode, confirmation: proposal.confirmation }, (x) => svc.isAllowed(x));
      if (!verdict.ok) throw new AgentError("blocked_policy");
      await store.createProposal(ownerHashOf(sessionId), proposal);
      run.proposalIds.push(proposal.id);
      await this.transition(run, "ACTION_PROPOSED", { actor: "agent", meta: { operation: proposal.operation, risk: proposal.risk } });
      await this.transition(run, "AWAITING_APPROVAL", { actor: "agent", meta: { expiresAt: proposal.expiresAt } });
      await this.audit(run.id, "proposal_created", { proposalId: proposal.id, operation: proposal.operation, risk: proposal.risk, app: proposal.app, digest12: proposal.digest.slice(0, 12), expiresAt: proposal.expiresAt });
      return { proposal, result: null, approvals: [] };
    });
  }

  private async closeBranch(runId: string, via: "APPROVED" | "REJECTED" | "EXPIRED", note: string, outcome: "ok" | "blocked" | "error" = "ok") {
    const rec = await this.o.store.getAgentRun(runId);
    if (!rec) return;
    const run = rec.run;
    if (run.phase === "AWAITING_APPROVAL") await this.transition(run, via, { actor: "system", outcome, note });
    if (via === "APPROVED") {
      /* simulation transitions are applied by decide() */
    } else if (run.phase === "REJECTED" || run.phase === "EXPIRED") await this.transition(run, run.kind === "deployment" ? "READINESS_REVIEW" : "REPORT_READY", { actor: "system", note: "branch_closed" });
  }

  /** Lazy expiry: a pending proposal past its deadline becomes EXPIRED (atomic compare-and-set), exactly once. */
  async expireIfDue(proposalId: string): Promise<boolean> {
    const rec = await this.o.store.getProposal(proposalId);
    if (!rec || rec.proposal.status !== "PENDING" || rec.proposal.expiresAt > this.iso()) return false;
    const t = await this.o.store.transitionProposal(proposalId, "EXPIRED", this.iso());
    if (!t.changed) return false;
    await this.audit(rec.proposal.runId, "proposal_expired", { proposalId });
    await this.closeBranch(rec.proposal.runId, "EXPIRED", "approval_window_elapsed", "blocked");
    const conv = await this.o.store.getConversation(rec.proposal.conversationId);
    if (conv) await this.say(conv.conversation, "agent", "decision", fa.decisionText.expired, { runId: rec.proposal.runId, proposalId });
    return true;
  }

  /**
   * Server-validated approval. NEVER trusts a client boolean: the proposal is loaded from storage and must (1) belong to the caller's
   * session (actor binding), (2) be unexpired, (3) match its own stored digest (no tampering), (4) match the digest the client saw
   * (any modification invalidates approval), (5) re-pass the policy table, (6) satisfy the typed confirmation for R2, (7) still
   * describe the current app state (drift) — and only then is the PENDING→APPROVED claim made atomically (single use, replay-proof).
   */
  async decide(proposalId: string, sessionId: string, req: { decision: unknown; digest: unknown; confirmAppName?: unknown }): Promise<ProposalView> {
    await this.ready;
    const { store, svc } = this.o;
    if (req.decision !== "approve" && req.decision !== "reject") throw new AgentError("invalid_decision");
    if (typeof req.digest !== "string" || !/^[0-9a-f]{64}$/.test(req.digest)) throw new AgentError("digest_mismatch");
    const owner = ownerHashOf(sessionId);
    const rec = await store.getProposal(proposalId);
    if (!rec || rec.ownerHash !== owner) throw new AgentError("not_found");
    await this.o.hooks?.beforeDecision?.();
    const p = rec.proposal;
    const actor = `operator:${shortHash(sessionId)}`;
    const aprv = (decision: "approve" | "reject", outcome: ApprovalRecord["outcome"]): ApprovalRecord => ({ id: rid("aprv", this.nowMs()), proposalId, decision, actorHash: owner, decidedAt: this.iso(), digest: p.digest, outcome, scope: "simulation" });
    const conv = (await store.getConversation(p.conversationId))?.conversation;

    if (p.status !== "PENDING") {
      await this.audit(p.runId, "decision_replayed", { proposalId, status: p.status, actor: shortHash(sessionId) });
      throw new AgentError("already_decided");
    }
    if (await this.expireIfDue(proposalId)) throw new AgentError("expired");

    const runRec = await store.getAgentRun(p.runId);
    if (!runRec || runRec.ownerHash !== owner || runRec.run.app !== p.app || runRec.run.status !== "READY") throw new AgentError("not_found");

    // (3) stored-row integrity and (4) the digest the operator actually reviewed
    if (!digestsEqual(proposalDigest(contentOf(p)), p.digest)) {
      const t = await store.transitionProposal(proposalId, "BLOCKED", this.iso(), aprv(req.decision, "blocked_policy"));
      if (t.changed) {
        await this.audit(p.runId, "proposal_tampered", { proposalId });
        await this.closeBranch(p.runId, "REJECTED", "proposal_tampered", "blocked");
        if (conv) await this.say(conv, "agent", "decision", fa.decisionText.tampered, { runId: p.runId, proposalId });
      }
      throw new AgentError("proposal_tampered");
    }
    if (!digestsEqual(req.digest, p.digest)) {
      await this.audit(p.runId, "digest_mismatch", { proposalId, actor: shortHash(sessionId) }); // pending stays pending: a wrong digest cannot burn or authorise anything
      throw new AgentError("digest_mismatch");
    }

    // (5) policy re-evaluation at decision time
    const verdict = evaluateProposal({ app: p.app, operation: p.operation, params: p.params, risk: p.risk, executionMode: p.executionMode, confirmation: p.confirmation }, (x) => svc.isAllowed(x));
    if (!verdict.ok) {
      const t = await store.transitionProposal(proposalId, "BLOCKED", this.iso(), aprv(req.decision, "blocked_policy"));
      if (t.changed) {
        await this.audit(p.runId, "proposal_blocked_policy", { proposalId, code: verdict.code });
        await this.closeBranch(p.runId, "REJECTED", `policy:${verdict.code}`, "blocked");
        if (conv) await this.say(conv, "agent", "decision", fa.decisionText.blocked_policy, { runId: p.runId, proposalId });
      }
      throw new AgentError("blocked_policy");
    }

    if (req.decision === "reject") {
      const t = await store.transitionProposal(proposalId, "REJECTED", this.iso(), aprv("reject", "rejected"));
      if (!t.changed) throw new AgentError(t.status === "EXPIRED" ? "expired" : "already_decided");
      await this.audit(p.runId, "proposal_rejected", { proposalId, actor: shortHash(sessionId) });
      await this.closeBranch(p.runId, "REJECTED", "rejected_by_operator");
      if (conv) await this.say(conv, "agent", "decision", fa.decisionText.rejected, { runId: p.runId, proposalId, suggestions: FOLLOW_UP_PROMPTS.map((f) => f.text) });
      return (await this.proposalViews(p.runId)).find((v) => v.proposal.id === proposalId)!;
    }

    // approve: (6) typed confirmation, (7) drift
    if (p.confirmation === "type_app_name" && req.confirmAppName !== p.app) throw new AgentError("confirmation_required");
    const now = p.operation === "first_deploy" ? await this.deployStateFingerprint(runRec.run, p.app) : await this.stateFingerprint(p.app);
    if (now === null || !digestsEqual(now, p.stateFingerprint)) {
      const t = await store.transitionProposal(proposalId, "BLOCKED", this.iso(), aprv("approve", "blocked_drift"));
      if (t.changed) {
        await this.audit(p.runId, "proposal_blocked_drift", { proposalId, unverifiable: now === null });
        await this.closeBranch(p.runId, "REJECTED", "state_drift", "blocked");
        if (conv) await this.say(conv, "agent", "decision", fa.decisionText.blocked_drift, { runId: p.runId, proposalId });
      }
      throw new AgentError("blocked_drift");
    }
    const claimed = await store.transitionProposal(proposalId, "APPROVED", this.iso(), aprv("approve", "accepted")); // atomic, single use
    if (!claimed.changed) {
      await this.audit(p.runId, "decision_replayed", { proposalId, status: claimed.status, actor: shortHash(sessionId) });
      throw new AgentError(claimed.status === "EXPIRED" ? "expired" : "already_decided");
    }
    await this.audit(p.runId, "proposal_approved", { proposalId, actor: actor, digest12: p.digest.slice(0, 12), mode: "simulation" });
    const run = (await store.getAgentRun(p.runId))!.run;
    await this.transition(run, "APPROVED", { actor, note: "simulation_only" });
    if (conv) await this.say(conv, "agent", "decision", fa.decisionText.approved, { runId: p.runId, proposalId });

    // the ONLY execution path: the simulated backend
    const result = await this.o.backend.execute(p, this.iso());
    const status = result.outcome === "failed" ? "SIMULATED_FAILED" : result.verification?.outcome === "failure" ? "VERIFICATION_FAILED" : "SIMULATED_OK";
    await store.finishProposal(proposalId, status, result);
    await this.audit(p.runId, "simulation_completed", { proposalId, outcome: result.outcome, verification: result.verification?.outcome ?? null, simulated: true, operation: p.operation });
    if (run.kind === "deployment" && result.deployment) {
      const d = result.deployment;
      await this.transition(run, "SIMULATION_RUNNING", { actor: "simulator", meta: { simulated: true, scenario: d.scenario } });
      const stoppedInRunning = d.failedStage !== null && d.reached === "running";
      if (stoppedInRunning) {
        await this.finish(run, "FAILED", "simulation_failed");
      } else {
        await this.transition(run, "SIMULATION_VERIFICATION", { actor: "simulator", meta: { simulated: true } });
        if (d.failedStage !== null) await this.finish(run, "FAILED", "simulation_failed");
        else {
          await this.transition(run, "SIMULATION_COMPLETED", { actor: "simulator", meta: { simulated: true } });
          await this.finish(run, "READY", null);
        }
      }
      if (conv) await this.say(conv, "agent", "simulation", dfa.deploymentResultText(result), { runId: p.runId, proposalId, suggestions: result.outcome === "failed" ? ["ساخت طرح جدید برای استقرار"] : [] });
    } else {
      await this.transition(run, "SIMULATION_COMPLETED", { actor: "simulator", outcome: result.outcome === "failed" ? "error" : "ok", meta: { simulated: true } });
      await this.transition(run, "REPORT_READY", { actor: "system", note: "branch_closed" });
      if (conv) await this.say(conv, "agent", "simulation", fa.simulationText(result), { runId: p.runId, proposalId, suggestions: FOLLOW_UP_PROMPTS.map((f) => f.text) });
    }
    return (await this.proposalViews(p.runId)).find((v) => v.proposal.id === proposalId)!;
  }

  // =============================================================================================== Phase 1E: first-deployment journey
  /** Latest deployment run (with a stored analysis) in a conversation. */
  private async latestDeployment(convId: string): Promise<AgentRunRecord | null> {
    const runs = await this.o.store.listAgentRuns(convId);
    return [...runs].reverse().find((r) => r.kind === "deployment" && r.deployment) ?? null;
  }

  private async handleDeployIntent(conv: ConversationRecord, intent: AgentIntent, sessionId: string, out: ConversationMessage[]) {
    const dep = await this.latestDeployment(conv.id);
    const done = (runId: string | null, proposalId: string | null = null) => ({ conversationId: conv.id, messages: out, runId, proposalId });
    if (!dep?.deployment) {
      out.push(await this.say(conv, "agent", "clarification", dfa.uploadPromptFa(), { intent, action: "upload_project", suggestions: [] }));
      return done(null);
    }
    const d = dep.deployment;
    const follow = ["قبل از انتشار چه چیزهایی کم دارم؟", "برای سایتم چه پلنی مناسبه؟", "می‌خوام پروژه‌ام رو دیپلوی کنم"];
    if (intent === "check_compatibility") out.push(await this.say(conv, "agent", "report", dfa.readinessText(d.readiness), { intent, runId: dep.id, suggestions: follow }));
    else if (intent === "predeploy_checklist") out.push(await this.say(conv, "agent", "report", dfa.checklistText(d.readiness), { intent, runId: dep.id, suggestions: follow }));
    else if (intent === "recommend_plan") {
      if (!d.recommendation) out.push(await this.say(conv, "agent", "refusal", dfa.planRefusalText("not_supported"), { intent, runId: dep.id }));
      else out.push(await this.say(conv, "agent", "report", dfa.recommendationText(d.recommendation), { intent, runId: dep.id, suggestions: follow }));
    } else {
      try {
        const v = await this.prepareDeployment(dep.id, sessionId, {});
        out.push(await this.say(conv, "agent", "proposal", dfa.planProposalText(v.proposal.app), { intent, runId: dep.id, proposalId: v.proposal.id }));
        return done(dep.id, v.proposal.id);
      } catch (e) {
        if (!isAgentError(e)) throw e;
        const reason = e.extra.reason ?? e.code;
        const text = e.code === "plan_refused" ? dfa.planRefusalText(reason) : e.code === "app_name_taken" ? "نام پیشنهادی برنامه از قبل وجود دارد؛ نام دیگری در پنل مسیر استقرار وارد کنید." : e.code === "proposal_limit" ? "سقف تعداد طرح‌های این پروژه پر شده است؛ پروژه را دوباره بارگذاری کنید." : "ساخت طرح در حال حاضر ممکن نیست.";
        out.push(await this.say(conv, "agent", "refusal", text, { intent, runId: dep.id, suggestions: follow }));
      }
    }
    return done(dep.id);
  }

  /**
   * Receives an UNTRUSTED ZIP: validates it (limits, traversal, symlinks, ratio), extracts only non-sensitive files to an isolated temp dir,
   * analyses it STATICALLY (nothing is executed), deletes the temp dir, and stores only the sanitised analysis + readiness report.
   */
  async receiveProject(req: { sessionId: string; conversationId?: string | null; archive: Buffer; filename?: string | null }): Promise<{ conversationId: string; runId: string; messages: ConversationMessage[] }> {
    await this.ready;
    const owner = ownerHashOf(req.sessionId);
    // per-session upload quota (process-local sliding window)
    const nowMs = this.nowMs();
    const recent = (this.uploads.get(owner) ?? []).filter((t) => nowMs - t < this.o.uploadQuota.windowMs);
    if (recent.length >= this.o.uploadQuota.perWindow) throw new AgentError("upload_quota_exceeded");
    recent.push(nowMs);
    this.uploads.set(owner, recent);

    const conv0 = req.conversationId ? await this.ownedConversation(req.conversationId, req.sessionId) : null;
    let analysis;
    try {
      analysis = await withProject(req.archive, (tree, summary) => analyzeSource(tree, summary));
    } catch (e) {
      if (isZipError(e)) {
        await this.audit(null, "upload_rejected", { reason: e.code, bytes: req.archive.length, actor: shortHash(req.sessionId) });
        throw new AgentError("upload_rejected", { reason: e.code });
      }
      log("error", "agent.upload_failed", { name: (e as { name?: string })?.name });
      throw new AgentError("upload_rejected", { reason: "corrupt" });
    }

    const now = this.iso();
    let conv = conv0;
    if (!conv) {
      conv = { id: rid("conv", this.nowMs()), app: null, createdAt: now, updatedAt: now, messageCount: 0 };
      await this.o.store.createConversation(owner, conv);
      await this.audit(null, "conversation_created", { conversationId: conv.id });
    }
    const safeName = typeof req.filename === "string" && /^[\w. -]{1,64}$/.test(req.filename) ? req.filename : null;
    const out: ConversationMessage[] = [];
    const run: AgentRunRecord = {
      kind: "deployment", id: rid("arun", this.nowMs()), conversationId: conv.id, app: analysis.project.suggestedAppName, intent: "start_deployment", windowMinutes: 60, mode: this.o.svc.mode,
      status: "RUNNING", phase: "SOURCE_RECEIVED", createdAt: now, updatedAt: now, finishedAt: null, retryOf: null, plan: null, toolCalls: [],
      transitions: [{ at: now, from: null, to: "SOURCE_RECEIVED", actor: `operator:${shortHash(req.sessionId)}`, outcome: "ok" }], errorCode: null, report: null, proposalIds: [],
    };
    await this.o.store.createAgentRun(owner, run);
    await this.audit(run.id, "run_created", { kind: "deployment", mode: run.mode, bytes: analysis.project.archiveBytes, files: analysis.project.fileCount, digest12: analysis.project.artifactDigest32.slice(0, 12), actor: shortHash(req.sessionId) });
    out.push(await this.say(conv, "user", "system", `پروژه بارگذاری شد${safeName ? ` (${safeName})` : ""}: ${analysis.project.fileCount} فایل، ${Math.ceil(analysis.project.archiveBytes / 1024)} کیلوبایت.`, { runId: run.id }, true));
    await this.transition(run, "SOURCE_ANALYZING", { actor: "agent" });
    const decisions: UserDecisions = { ...NO_DECISIONS };
    const readiness = buildReadiness(analysis, decisions);
    const recommendation = analysis.framework.supported ? recommend({ analysis }) : null;
    run.deployment = {
      project: { ...analysis.project, filename: safeName, receivedAt: now },
      analysis,
      readiness,
      recommendation,
      options: { appName: analysis.project.suggestedAppName, traffic: "unknown", scenario: "success" },
      decisions,
      proposalId: null,
    };
    await this.transition(run, "READINESS_REVIEW", { actor: "agent", meta: { verdict: readiness.verdict, framework: analysis.framework.id } });
    await this.finish(run, "READY", null);
    await this.audit(run.id, "readiness_ready", { verdict: readiness.verdict, framework: analysis.framework.id, supported: analysis.framework.supported, findings: analysis.findings.length });
    out.push(await this.say(conv, "agent", "report", dfa.readinessText(readiness), { intent: "check_compatibility", runId: run.id, suggestions: ["قبل از انتشار چه چیزهایی کم دارم؟", "برای سایتم چه پلنی مناسبه؟", "می‌خوام پروژه‌ام رو دیپلوی کنم"] }));
    return { conversationId: conv.id, runId: run.id, messages: out };
  }

  private async ownedDeployment(runId: string, sessionId: string): Promise<AgentRunRecord & { deployment: DeploymentRunData }> {
    const run = await this.ownedRun(runId, sessionId);
    if (run.kind !== "deployment" || !run.deployment) throw new AgentError("not_found");
    return run as AgentRunRecord & { deployment: DeploymentRunData };
  }

  /** Records the operator's decision for a manual checklist item (never overridable for blockers). */
  async setChecklist(runId: string, sessionId: string, item: string, done: boolean): Promise<DeploymentRunData> {
    return this.serial(async () => {
      const run = await this.ownedDeployment(runId, sessionId);
      const key = DECISION_FOR_ITEM[item];
      if (!key || typeof done !== "boolean") throw new AgentError("invalid_input");
      const ci = run.deployment.readiness.checklist.find((c) => c.id === item && c.kind === "manual");
      if (!ci) throw new AgentError("invalid_input");
      for (const p of await this.o.store.listProposals(run.id)) await this.expireIfDue(p.id);
      if ((await this.o.store.listProposals(run.id)).some((p) => p.status === "PENDING")) throw new AgentError("proposal_pending"); // cancel/decide the open plan first
      const fresh = (await this.o.store.getAgentRun(run.id))!.run as typeof run;
      fresh.deployment.decisions = { ...fresh.deployment.decisions, [key]: done };
      fresh.deployment.readiness = buildReadiness(fresh.deployment.analysis, fresh.deployment.decisions);
      await this.persist(fresh);
      await this.audit(run.id, "deployment_checklist_decision", { item, done, verdict: fresh.deployment.readiness.verdict, actor: shortHash(sessionId) });
      return fresh.deployment;
    });
  }

  private async deployStateFingerprint(run: AgentRunRecord, app: string): Promise<string | null> {
    if (this.o.stateProbe) return this.o.stateProbe(app);
    const d = run.deployment;
    if (!d) return null;
    const verdict = buildReadiness(d.analysis, d.decisions).verdict;
    return deployFingerprint({ artifactDigest: d.analysis.project.artifactDigest32, appName: app, nameTaken: this.o.svc.isAllowed(app), verdict, decisions: { ...d.decisions } });
  }

  /**
   * Builds the immutable first-deploy proposal. It goes through the SAME policy table, digest, expiry and `decide()` gate as every
   * other proposal. Refuses (never half-plans) when the readiness verdict forbids planning.
   */
  prepareDeployment(runId: string, sessionId: string, opts: { appName?: unknown; traffic?: unknown; scenario?: unknown }): Promise<ProposalView> {
    return this.serial(async () => {
      const run0 = await this.ownedDeployment(runId, sessionId);
      const { store, svc } = this.o;
      if (opts.traffic !== undefined && !TRAFFIC_VALUES.includes(opts.traffic as Traffic)) throw new AgentError("invalid_input");
      if (opts.scenario !== undefined && !(SIM_SCENARIOS as readonly string[]).includes(opts.scenario as string)) throw new AgentError("invalid_input");
      if (opts.appName !== undefined && typeof opts.appName !== "string") throw new AgentError("invalid_input");
      for (const p of await store.listProposals(run0.id)) await this.expireIfDue(p.id);
      let existing = await store.listProposals(run0.id);
      if (existing.length >= 6) throw new AgentError("proposal_limit");
      // a newer plan supersedes an open one: the old proposal is cancelled (never approvable again)
      for (const p of existing.filter((x) => x.status === "PENDING")) {
        const t = await store.transitionProposal(p.id, "CANCELLED", this.iso());
        if (t.changed) {
          await this.audit(run0.id, "proposal_superseded", { proposalId: p.id });
          await this.closeBranch(run0.id, "REJECTED", "superseded_by_new_plan", "blocked");
        }
      }
      existing = await store.listProposals(run0.id);
      const run = (await store.getAgentRun(run0.id))!.run as typeof run0;
      const replan = run.status === "FAILED" && run.errorCode === "simulation_failed";
      if (!(run.status === "READY" && run.phase === "READINESS_REVIEW") && !replan) throw new AgentError("not_ready");
      const d = run.deployment;
      const options = {
        appName: typeof opts.appName === "string" && opts.appName.trim() ? opts.appName.trim().toLowerCase() : d.options.appName,
        traffic: (opts.traffic as Traffic | undefined) ?? d.options.traffic,
        scenario: (opts.scenario as SimScenario | undefined) ?? d.options.scenario,
      };
      const readiness = buildReadiness(d.analysis, d.decisions);
      const recommendation = d.analysis.framework.supported ? recommend({ analysis: d.analysis, traffic: options.traffic }) : null;
      if (!recommendation) throw new AgentError("plan_refused", { reason: "not_supported" });
      const built = buildPlan(d.analysis, readiness, recommendation, { appName: options.appName, scenario: options.scenario });
      if (!built.ok) throw new AgentError("plan_refused", { reason: built.refusal });
      if (svc.isAllowed(built.plan.params.appName)) throw new AgentError("app_name_taken");
      const fp = await this.deployStateFingerprint({ ...run, deployment: { ...d, readiness } } as AgentRunRecord, built.plan.params.appName);
      if (!fp) throw new AgentError("not_ready");
      const policy = OPERATION_POLICY.first_deploy;
      const created = this.iso();
      const b = built.plan;
      const content: ProposalContent = sanitizeForStore({
        id: rid("prop", this.nowMs()), runId: run.id, conversationId: run.conversationId, app: b.params.appName, operation: "first_deploy" as const, params: b.params as unknown as Record<string, unknown>, risk: "R2" as const, executionMode: "simulation" as const,
        recommendationId: b.params.planId, relatedDiagnosis: "deployment_readiness", evidenceIds: b.evidenceIds, stateFingerprint: fp,
        descriptionFa: b.descriptionFa, impactFa: b.impactFa, downtimeFa: policy.downtimeFa, preconditionsFa: [...b.preconditionsFa, ...policy.preconditionsFa], verificationPlanFa: b.verificationPlanFa,
        confirmation: "type_app_name" as const, createdAt: created, expiresAt: new Date(this.nowMs() + policy.ttlSec * 1000).toISOString(),
      });
      content.stateFingerprint = fp;
      const proposal: ActionProposal = { ...content, digest: proposalDigest(content), status: "PENDING" };
      const verdict = evaluateProposal({ app: proposal.app, operation: proposal.operation, params: proposal.params, risk: proposal.risk, executionMode: proposal.executionMode, confirmation: proposal.confirmation }, (x) => svc.isAllowed(x));
      if (!verdict.ok) throw new AgentError(verdict.code === "target_app_exists" ? "app_name_taken" : "blocked_policy");
      await store.createProposal(ownerHashOf(sessionId), proposal);
      if (replan) {
        run.status = "READY";
        run.errorCode = null;
        run.finishedAt = null;
        await this.transition(run, "READINESS_REVIEW", { actor: "operator", note: "replan_after_simulated_failure" });
      }
      run.app = proposal.app;
      run.proposalIds.push(proposal.id);
      run.deployment = { ...d, readiness, recommendation, options, proposalId: proposal.id };
      await this.transition(run, "PLAN_PREPARED", { actor: "agent", meta: { operation: "first_deploy", risk: "R2" } });
      await this.transition(run, "AWAITING_APPROVAL", { actor: "agent", meta: { expiresAt: proposal.expiresAt } });
      await this.audit(run.id, "proposal_created", { proposalId: proposal.id, operation: proposal.operation, risk: proposal.risk, app: proposal.app, digest12: proposal.digest.slice(0, 12), expiresAt: proposal.expiresAt, kind: "first_deploy" });
      return { proposal, result: null, approvals: [] };
    });
  }

  /**
   * The ONLY live-execution entry point, and it always refuses: a simulated approval is not valid for a live target, and live execution
   * does not exist in this phase. Exists so that "replay a simulated approval against a live action" is a testable, audited refusal.
   */
  async requestLiveExecution(proposalId: string, sessionId: string): Promise<never> {
    await this.ready;
    const rec = await this.o.store.getProposal(proposalId);
    if (!rec || rec.ownerHash !== ownerHashOf(sessionId)) throw new AgentError("not_found");
    const approvals = await this.o.store.listApprovals(proposalId);
    const approval = approvals.find((a) => a.outcome === "accepted") ?? null;
    const verdict = authorizeLiveExecution({ proposal: rec.proposal, approval });
    await this.audit(rec.proposal.runId, "live_execution_refused", { proposalId, code: verdict.code, actor: shortHash(sessionId) });
    throw new AgentError(verdict.code);
  }
}

export { SUGGESTED_PROMPTS, ENGINE_INTENT };
