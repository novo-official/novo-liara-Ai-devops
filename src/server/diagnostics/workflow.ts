import { randomBytes } from "node:crypto";
import { isLiaraError, LiaraError } from "../liara/errors";
import { WINDOWS_MINUTES, type WindowMinutes } from "../liara/read-client";
import type { LiaraService } from "../liara/service";
import { log } from "../security/logger";
import { analyze } from "./engine";
import { collectEvidence, SOURCES_BY_INTENT } from "./evidence";
import type { EvidenceSet } from "./evidence-set";
import type { DiagnosticLLMProvider } from "./llm/provider";
import { buildNarrative, buildReport, llmContext } from "./report";
import { semanticsFor } from "./semantics";
import { ownerHashOf, TERMINAL, type RunPhase, type RunRecord, type RunStatus, type RunStore, type StepKey, type StepState } from "./store";
import { isIntent, type AnyEvidence, type Semantics, type SourceKey } from "./types";

/**
 * Controlled diagnostic workflow (state machine):
 *   IDLE → COLLECTING_EVIDENCE → ANALYZING → GENERATING_REPORT → COMPLETED
 * Terminal statuses: COMPLETED | COMPLETED_WITH_GAPS (partial evidence) | FAILED (fatal) | CANCELLED | TIMED_OUT.
 * Read-only by construction: the only Liara access is the allowlist-enforcing LiaraService (GET-only). There is no code path from a
 * diagnosis, recommendation or LLM output to any infrastructure operation.
 */

export const NEXT: Record<RunPhase, RunPhase[]> = {
  IDLE: ["COLLECTING_EVIDENCE"],
  COLLECTING_EVIDENCE: ["ANALYZING"],
  ANALYZING: ["GENERATING_REPORT"],
  GENERATING_REPORT: ["COMPLETED"],
  COMPLETED: [],
};

export type RunErrorCode = "unknown_intent" | "invalid_window" | "run_in_progress" | "too_many_runs" | "run_quota_exceeded" | "retry_not_allowed" | "not_found";
export class RunError extends Error {
  constructor(
    public readonly code: RunErrorCode,
    public readonly existingRunId?: string,
  ) {
    super(code);
    this.name = "RunError";
  }
}

const STEP_SOURCES: Record<StepKey, SourceKey[]> = {
  collect_logs: ["logs", "events"],
  inspect_runtime: ["app", "runtime"],
  review_releases: ["releases"],
  analyze_metrics: ["cpu", "memory"],
  identify_hypotheses: [],
  prepare_report: [],
};
const STEP_ORDER: StepKey[] = ["collect_logs", "inspect_runtime", "review_releases", "analyze_metrics", "identify_hypotheses", "prepare_report"];

export interface ManagerOptions {
  svc: LiaraService;
  store: RunStore;
  provider: DiagnosticLLMProvider;
  runTimeoutMs?: number;
  sourceTimeoutMs?: number;
  narrativeTimeoutMs?: number;
  maxConcurrentRuns?: number;
  quotaPerWindow?: number;
  quotaWindowMs?: number;
  maxRetryDepth?: number;
  now?: () => number;
  semantics?: (app: string, mode: "mock" | "live") => Semantics;
  /** test seam: runs between phases so tests can observe/cancel deterministically */
  hooks?: { afterCollect?: (run: RunRecord) => Promise<void> | void };
}

interface Active {
  ac: AbortController;
  reason: "cancelled" | "timeout" | null;
  done: Promise<void>;
}

export class DiagnosticRunManager {
  private active = new Map<string, Active>();
  /** Serialises start(): the duplicate/concurrency/quota checks and the record creation must be one atomic step. */
  private startQueue: Promise<unknown> = Promise.resolve();
  private ready: Promise<void>;
  private o: Required<Omit<ManagerOptions, "hooks" | "semantics">> & Pick<ManagerOptions, "hooks" | "semantics">;

  constructor(opts: ManagerOptions) {
    this.o = {
      runTimeoutMs: 30_000,
      sourceTimeoutMs: 10_000,
      narrativeTimeoutMs: 3_000,
      maxConcurrentRuns: 2,
      quotaPerWindow: 10,
      quotaWindowMs: 10 * 60_000,
      maxRetryDepth: 2,
      now: Date.now,
      ...opts,
    };
    // runs that were in flight when a previous process died can never finish: mark them failed (records survive restarts)
    this.ready = this.o.store.recoverInterrupted(new Date(this.o.now()).toISOString()).then((n) => {
      if (n) log("warn", "diagnostics.recovered_interrupted_runs", { count: n });
    });
  }

  private iso() {
    return new Date(this.o.now()).toISOString();
  }

  // ---------- public API ----------
  start(req: { sessionId: string; app: string; intent: unknown; windowMinutes?: unknown; retryOf?: string | null }): Promise<RunRecord> {
    const next = this.startQueue.then(() => this.doStart(req));
    this.startQueue = next.catch(() => undefined);
    return next;
  }

  private async doStart(req: { sessionId: string; app: string; intent: unknown; windowMinutes?: unknown; retryOf?: string | null }): Promise<RunRecord> {
    await this.ready;
    const { store, svc } = this.o;
    if (!isIntent(req.intent)) throw new RunError("unknown_intent");
    const win = req.windowMinutes === undefined ? 60 : Number(req.windowMinutes);
    if (!(WINDOWS_MINUTES as readonly number[]).includes(win)) throw new RunError("invalid_window");
    // allowlist enforcement BEFORE anything else touches the app (unknown / malformed / non-allowlisted are indistinguishable)
    if (!svc.isAllowed(req.app)) throw new LiaraError("app_not_allowed", "Application is not accessible");

    const owner = ownerHashOf(req.sessionId);
    let retryOf: string | null = null;
    if (req.retryOf) {
      const prev = await store.get(req.retryOf);
      if (!prev || prev.ownerHash !== owner) throw new RunError("not_found");
      if (!["FAILED", "COMPLETED_WITH_GAPS", "TIMED_OUT"].includes(prev.run.status) || prev.run.app !== req.app) throw new RunError("retry_not_allowed");
      let depth = 1;
      for (let cur: string | null = prev.run.retryOf; cur; depth++) {
        if (depth >= this.o.maxRetryDepth) throw new RunError("retry_not_allowed"); // bounded retry chain
        cur = (await store.get(cur))?.run.retryOf ?? null;
      }
      retryOf = prev.run.id;
    }

    // duplicate-run protection, concurrency cap and per-owner quota
    const dup = await store.findActiveByApp(req.app);
    if (dup) throw new RunError("run_in_progress", dup.id);
    if ((await store.countActive()) >= this.o.maxConcurrentRuns) throw new RunError("too_many_runs");
    if ((await store.countRecentByOwner(owner, new Date(this.o.now() - this.o.quotaWindowMs).toISOString())) >= this.o.quotaPerWindow) throw new RunError("run_quota_exceeded");

    const now = this.iso();
    const needed = SOURCES_BY_INTENT[req.intent];
    const steps: StepState[] = STEP_ORDER.map((key) => ({ key, status: STEP_SOURCES[key].length && !STEP_SOURCES[key].some((s) => needed.includes(s)) ? "skipped" : "pending" }));
    const run: RunRecord = {
      id: `run_${now.replace(/[-:T.Z]/g, "").slice(0, 14)}_${randomBytes(4).toString("hex")}`,
      app: req.app,
      intent: req.intent,
      windowMinutes: win,
      mode: svc.mode,
      status: "RUNNING",
      phase: "IDLE",
      createdAt: now,
      updatedAt: now,
      finishedAt: null,
      retryOf,
      steps,
      transitions: [{ at: now, from: null, to: "IDLE" }],
      errorCode: null,
      report: null,
    };
    await store.create(owner, run);
    await store.appendAudit(now, run.id, "run_created", { app: run.app, intent: run.intent, window: win, mode: run.mode, retryOf });

    const accepted = structuredClone(run); // snapshot at acceptance: phase IDLE; the live record keeps changing as the run progresses
    const ac = new AbortController();
    const entry: Active = { ac, reason: null, done: Promise.resolve() };
    this.active.set(run.id, entry);
    // the run promise never rejects: a storage failure while recording the outcome must not become an unhandled rejection
    entry.done = this.execute(run, entry)
      .catch((e: unknown) => log("error", "diagnostics.run_unrecoverable", { runId: run.id, name: (e as { name?: string })?.name }))
      .finally(() => this.active.delete(run.id));
    return accepted;
  }

  async get(id: string, sessionId: string): Promise<RunRecord | null> {
    await this.ready;
    const r = await this.o.store.get(id);
    return r && r.ownerHash === ownerHashOf(sessionId) ? r.run : null; // other sessions' runs look like "not found"
  }

  async list(sessionId: string, limit = 20): Promise<RunRecord[]> {
    await this.ready;
    return this.o.store.listByOwner(ownerHashOf(sessionId), limit);
  }

  async cancel(id: string, sessionId: string): Promise<RunRecord | null> {
    const run = await this.get(id, sessionId);
    if (!run) return null;
    if (TERMINAL.includes(run.status)) return run; // idempotent
    const a = this.active.get(id);
    if (a) {
      a.reason ??= "cancelled";
      a.ac.abort();
      await a.done;
    }
    return this.get(id, sessionId);
  }

  /** Resolves when the run (if still active in this process) has finished. For tests and graceful shutdown. */
  async waitFor(id: string): Promise<void> {
    await this.active.get(id)?.done;
  }

  async activeCount(): Promise<number> {
    return this.o.store.countActive();
  }

  // ---------- execution ----------
  private async persist(run: RunRecord): Promise<void> {
    run.updatedAt = this.iso();
    await this.o.store.save(run);
  }

  private async transition(run: RunRecord, to: RunPhase, note?: string): Promise<void> {
    if (!NEXT[run.phase].includes(to)) throw new Error(`invalid transition ${run.phase} -> ${to}`);
    run.transitions.push({ at: this.iso(), from: run.phase, to, note });
    run.phase = to;
    await this.persist(run);
    await this.o.store.appendAudit(this.iso(), run.id, "state_transition", { from: run.transitions.at(-2)?.to ?? null, to });
  }

  private async finish(run: RunRecord, status: RunStatus, errorCode: string | null): Promise<void> {
    run.status = status;
    run.errorCode = errorCode;
    run.finishedAt = this.iso();
    run.transitions.push({ at: run.finishedAt, from: run.phase, to: status, note: errorCode ?? undefined });
    for (const s of run.steps) if (s.status === "running" || s.status === "pending") s.status = status === "COMPLETED" || status === "COMPLETED_WITH_GAPS" ? "done" : "failed";
    await this.persist(run);
    await this.o.store.appendAudit(this.iso(), run.id, "run_finished", { status, errorCode });
  }

  private setStep(run: RunRecord, key: StepKey, status: StepState["status"]) {
    const s = run.steps.find((x) => x.key === key)!;
    if (s.status === "skipped") return;
    s.status = status;
    if (status === "running") s.startedAt ??= this.iso();
    if (status === "done" || status === "failed") s.endedAt = this.iso();
  }

  private async execute(run: RunRecord, a: Active): Promise<void> {
    const timer = setTimeout(() => {
      a.reason ??= "timeout";
      a.ac.abort();
    }, this.o.runTimeoutMs);
    const aborted = async (): Promise<boolean> => {
      if (!a.ac.signal.aborted) return false;
      await this.finish(run, a.reason === "timeout" ? "TIMED_OUT" : "CANCELLED", a.reason === "timeout" ? "run_timeout" : "cancelled_by_operator");
      return true;
    };
    try {
      await this.transition(run, "COLLECTING_EVIDENCE");
      const needed = SOURCES_BY_INTENT[run.intent];
      const pending = new Map<StepKey, Set<SourceKey>>();
      for (const k of STEP_ORDER) if (STEP_SOURCES[k].length) pending.set(k, new Set(STEP_SOURCES[k].filter((s) => needed.includes(s))));
      const stepOf = (src: SourceKey): StepKey => STEP_ORDER.find((k) => STEP_SOURCES[k].includes(src))!;
      const progress: Promise<void>[] = [];
      let evidence: EvidenceSet;
      try {
        evidence = await collectEvidence(this.o.svc, {
          runId: run.id,
          app: run.app,
          intent: run.intent,
          windowMinutes: run.windowMinutes as WindowMinutes,
          now: this.o.now,
          sourceTimeoutMs: this.o.sourceTimeoutMs,
          maxSources: 8, // request budget: at most one fetch per source, never more than 8 per run
          signal: a.ac.signal,
          onProgress: (src, phase, item) => {
            const step = stepOf(src);
            if (phase === "start") this.setStep(run, step, "running");
            else {
              const set = pending.get(step)!;
              set.delete(src);
              if (set.size === 0) this.setStep(run, step, "done");
              void item;
            }
            progress.push(this.persist(run));
          },
        });
      } catch (e) {
        await Promise.allSettled(progress);
        if (await aborted()) return;
        throw e;
      }
      await Promise.allSettled(progress);
      if (await aborted()) return;
      await this.o.hooks?.afterCollect?.(run);
      if (await aborted()) return;

      await this.transition(run, "ANALYZING");
      this.setStep(run, "identify_hypotheses", "running");
      await this.persist(run);
      const mode = this.o.svc.mode;
      const semantics = (this.o.semantics ?? semanticsFor)(run.app, mode);
      const analysis = analyze({ runId: run.id, intent: run.intent, evidence, semantics, now: this.o.now() });
      this.setStep(run, "identify_hypotheses", "done");
      if (await aborted()) return;

      await this.transition(run, "GENERATING_REPORT");
      this.setStep(run, "prepare_report", "running");
      await this.persist(run);
      const remaining = Math.max(500, Math.min(this.o.narrativeTimeoutMs, this.o.runTimeoutMs / 2));
      const narrative = await buildNarrative(this.o.provider, llmContext({ app: run.app, intent: run.intent, analysis, simulated: mode === "mock" }), evidence.ids(), { timeoutMs: remaining, signal: a.ac.signal });
      if (await aborted()) return;
      await this.o.store.appendAudit(this.iso(), run.id, "narrative", { status: narrative.status, source: narrative.source });
      run.report = buildReport({ runId: run.id, app: run.app, intent: run.intent, evidence, analysis, narrative, now: this.o.now() });
      this.setStep(run, "prepare_report", "done");
      await this.transition(run, "COMPLETED");

      const items: AnyEvidence[] = evidence.items;
      await this.o.store.appendAudit(this.iso(), run.id, "evidence_collected", Object.fromEntries(items.map((i) => [i.source, i.availability])));
      const unusable = items.filter((i) => i.availability !== "available");
      const allDenied = items.length > 0 && items.every((i) => i.availability === "access_denied");
      const allFailed = items.length > 0 && items.every((i) => i.availability === "collection_failed" || i.availability === "access_denied" || i.availability === "contract_mismatch" || i.availability === "no_content" || i.availability === "unsupported");
      if (allDenied) await this.finish(run, "FAILED", "access_denied");
      else if (allFailed) await this.finish(run, "FAILED", "no_usable_evidence");
      else await this.finish(run, unusable.length ? "COMPLETED_WITH_GAPS" : "COMPLETED", null);
    } catch (e) {
      // fatal failure: record a stable, non-sensitive code only (never the error message)
      const code = isLiaraError(e) ? e.code : (e as { code?: string })?.code === "cancelled" ? "cancelled_by_operator" : "analysis_error";
      log("error", "diagnostics.run_failed", { runId: run.id, code, name: (e as { name?: string })?.name });
      if (!TERMINAL.includes(run.status)) await this.finish(run, "FAILED", code);
    } finally {
      clearTimeout(timer);
    }
  }
}

/** Duck-typed (see isLiaraError): safe even if this module is bundled more than once. */
export function isRunError(e: unknown): e is RunError {
  return e instanceof RunError || (typeof e === "object" && e !== null && (e as { name?: unknown }).name === "RunError" && typeof (e as { code?: unknown }).code === "string");
}
