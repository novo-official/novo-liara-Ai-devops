import { createHash } from "node:crypto";
import { assertStepAuthorized, type LiveGate } from "./authorize";
import { CreateAppRequestSchema, CreateReleaseRequestSchema, NON_REPO_GIT_INFO, type LiveWriteTransport, type WriteErrorCode } from "./contract";
import type { ResponseShape } from "./response-shape";
import type { LiveReader } from "./reader";
import type { LiveStore } from "./store";
import { ladderVerdict } from "@/lib/live-ladder";
import { EMPTY_LADDER, LiveError, type LiveOperationRecord, type LiveProposal, type LiveState, type StepName, type StepRecord } from "./types";
import { evaluateLadder, verdictOf, type Snapshot } from "./verify";
import type { ProbeResult } from "./probe";
import type { LiaraCliBackend } from "./cli/backend";

/**
 * LiaraDeploymentExecutor — the typed, isolated live executor. Five operations: createApplication, uploadSource, createRelease, inspectDeployment,
 * verifyRuntime (+ `run`, which sequences them). It shares nothing with the simulator and receives its write capability ONLY through the injected
 * three-method `LiveWriteTransport`.
 *
 * Safety rules implemented here:
 *  - every mutating step first calls `assertStepAuthorized` (fresh, from storage; a flag alone never passes)
 *  - request bodies are built ONLY from the approved, digest-bound proposal — never from the caller, never from text
 *  - exactly one POST per step; NO automatic retry. A timeout/5xx/unreadable answer is an UNKNOWN outcome: remote state is RECONCILED by reading first,
 *    and anything still unclear ends in NEEDS_OPERATOR_REVIEW (never a second create)
 *  - progress is persisted by compare-and-set after every transition; a lost race aborts the run instead of overwriting
 *  - success is never inferred from HTTP 200: DEPLOYED needs the whole verification ladder; unknown ≠ success
 *  - nothing is ever deleted, rolled back or upgraded automatically; partial resources are preserved and reported with recovery instructions
 */

export interface ExecutorConfig {
  /** trusted application-domain suffixes (empty ⇒ HTTP health can never be verified ⇒ DEPLOYED is unreachable) */
  suffixes: readonly string[];
  healthPath: string;
  healthMarker: string | null;
  /** total wall-clock budget for the verification polling */
  verifyBudgetMs: number;
  pollIntervalMs: number;
  reconcileAttempts: number;
  reconcileDelayMs: number;
  /** an operation older than this must not continue on its own */
  maxOperationAgeMs: number;
}
export const DEFAULT_EXECUTOR_CONFIG: Omit<ExecutorConfig, "suffixes"> = { healthPath: "/health", healthMarker: null, verifyBudgetMs: 10 * 60_000, pollIntervalMs: 5_000, reconcileAttempts: 4, reconcileDelayMs: 2_000, maxOperationAgeMs: 45 * 60_000 };

export interface ExecutorDeps {
  /** null ⇒ no REST write capability exists (a CLI-only configuration, or live execution disabled) */
  transport: LiveWriteTransport | null;
  /** Phase 2D: the restricted official-CLI backend (null unless explicitly enabled and pinned) */
  cli: LiaraCliBackend | null;
  /** Phase 2D: yields the API token ONLY for the CLI's private auth file (never stored, logged or passed on a command line) */
  getToken: () => string;
  reader: LiveReader;
  store: LiveStore;
  gate: () => LiveGate;
  config: ExecutorConfig;
  now: () => number;
  sleep: (ms: number) => Promise<void>;
  audit: (runId: string | null, event: string, data: Record<string, unknown>) => Promise<void>;
  probe: (o: { appName: string; path: string; marker?: string }) => Promise<ProbeResult>;
  /** re-derives the approved state fingerprint right now (plan availability, name absence, artifact, team); a mismatch blocks the run */
  fingerprint: (p: LiveProposal) => Promise<string | null>;
}

export const FAILURE_FA: Record<string, string> = {
  preflight_name_exists: "نام برنامه هم‌اکنون وجود دارد؛ چیزی ساخته نشد.",
  preflight_name_unverifiable: "امکان بررسی وجود نام برنامه نبود؛ برای جلوگیری از ساخت تکراری چیزی ساخته نشد.",
  preflight_drift: "وضعیت (پلن، نام، تیم یا بسته) از زمان تأیید تغییر کرده؛ چیزی ساخته نشد و تأیید جدید لازم است.",
  preflight_artifact_mismatch: "بستهٔ سورس با نسخهٔ تأییدشده یکی نیست؛ چیزی ساخته نشد.",
  preflight_plan_blocked: "پلن انتخاب‌شده دیگر معتبر/در دسترس نیست؛ چیزی ساخته نشد.",
  bad_request: "لیارا درخواست را نامعتبر دانست (۴۰۰).",
  unauthorized: "توکن لیارا پذیرفته نشد (۴۰۱).",
  insufficient_balance: "موجودی حساب برای این عملیات کافی نیست (۴۰۲). حساب را دستی شارژ کنید؛ این ابزار هرگز شارژ نمی‌کند.",
  forbidden: "دسترسی توکن برای این عملیات کافی نیست (۴۰۳).",
  not_found: "لیارا منبع را پیدا نکرد (۴۰۴).",
  already_exists: "برنامه‌ای با این نام از قبل وجود دارد (۴۰۹).",
  payload_too_large: "حجم بستهٔ سورس از سقف لیارا بیشتر است.",
  rate_limited: "لیارا درخواست را به‌دلیل محدودیت نرخ رد کرد.",
  rejected_other: "لیارا درخواست را رد کرد.",
  timeout: "پاسخ به‌موقع نرسید؛ نتیجه نامعلوم است.",
  network: "خطای شبکه؛ نتیجه نامعلوم است.",
  server_error: "خطای سرور لیارا؛ نتیجه نامعلوم است.",
  malformed_response: "پاسخ لیارا قابل‌فهم نبود؛ نتیجه نامعلوم است.",
  unexpected_redirect: "پاسخ غیرمنتظره (redirect)؛ نتیجه نامعلوم است.",
  rejected_but_name_present: "لیارا درخواست ساخت را رد کرد، اما برنامه‌ای با این نام دیده می‌شود؛ معلوم نیست توسط این درخواست ساخته شده یا کس دیگری آن را ساخته است. پاسخ خطا ثابت نمی‌کند که اثری روی سرور نبوده است.",
  rejected_but_state_unreadable: "لیارا درخواست را رد کرد اما امکان بررسی وضعیت واقعی نبود؛ پاسخ خطا به‌تنهایی ثابت نمی‌کند اثری روی سرور نبوده است.",
  rejected_but_release_present: "لیارا ساخت نسخه را رد کرد اما نسخهٔ تازه‌ای در فهرست دیده می‌شود؛ رد شدن ثابت نمی‌کند اثری نبوده است.",
  existing_app_missing: "برنامهٔ مقصد در لیارا دیده نشد؛ چیزی ارسال نشد.",
  existing_identity_mismatch: "هویت برنامهٔ موجود (نام یا پلن) با پیشنهاد تأییدشده یکی نیست؛ چیزی ارسال نشد.",
  existing_instance_changed: "نمونهٔ برنامه (شناسه، زمان ساخت یا شبکه) با تأیید نمی‌خواند؛ احتمالاً برنامه دوباره ساخته شده است. چیزی ارسال نشد.",
  existing_baseline_changed: "نسخه‌های فعلی برنامه با مبنای تأییدشده نمی‌خواند؛ چیزی ارسال نشد.",
  existing_app_not_running: "برنامهٔ مقصد روشن نیست (scale=0)؛ ساخت نسخه نیاز به برنامهٔ روشن دارد. این ابزار برنامه را خودکار روشن نمی‌کند و چیزی ارسال نشد.",
  baseline_unreadable: "فهرست نسخه‌های فعلی خوانده نشد؛ بدون آن نتیجهٔ استقرار قابل راستی‌آزمایی نیست و چیزی اجرا نشد.",
  cli_refused: "اجرای CLI رسمی پیش از شروع رد شد (هویت ابزار، منبع یا آرگومان‌ها با تأیید نمی‌خواند)؛ هیچ پردازشی اجرا نشد.",
  cli_spawn_failed: "پردازش CLI رسمی شروع نشد؛ هیچ درخواستی ارسال نشد.",
  cli_nonzero_no_release: "CLI رسمی با خطا پایان یافت و نسخهٔ تازه‌ای در لیارا دیده نشد (مشاهدهٔ لحظه‌ای، نه اثبات).",
  cli_zero_no_release: "CLI رسمی بدون خطا پایان یافت اما نسخهٔ تازه‌ای در لیارا دیده نشد؛ نتیجه قطعی نیست.",
  cli_timeout: "مهلت اجرای CLI رسمی تمام شد؛ نتیجه نامعلوم است.",
  cli_release_ambiguous: "پس از اجرای CLI بیش از یک نسخهٔ تازه دیده شد؛ حدس زده نمی‌شود.",
  partially_verified: "بخشی از سطوح راستی‌آزمایی تأیید شد اما همهٔ شش سطح تأیید نشد؛ برنامه «مستقر و راستی‌آزمایی‌شده» اعلام نمی‌شود.",
  identity_unverified: "برنامه در فهرست دیده شد اما هویت دقیق آن (نام گزارش‌شده توسط API) تأیید نشد؛ به دامنهٔ دسترسی اضافه نشد.",
  accepted_but_not_visible: "لیارا درخواست ساخت را پذیرفت اما برنامه هنوز در فهرست دیده نشد.",
  app_not_running: "برنامه ساخته شد اما روشن (scale=1) نیست؛ ساخت نسخه نیاز به برنامهٔ روشن دارد. این ابزار برنامه را خودکار روشن نمی‌کند.",
  verification_failed: "راستی‌آزمایی پس از استقرار شکست خورد.",
  verification_inconclusive: "شواهد کافی برای اعلام موفقیت وجود ندارد (وضعیت نسخه، اجرا یا سلامت HTTP نامعلوم است).",
  operation_too_old: "عملیات بیش از حد طول کشیده و خودکار ادامه نمی‌یابد.",
  interrupted_by_restart: "سرور در میانهٔ عملیات راه‌اندازی مجدد شد؛ نتیجهٔ آخرین درخواست نامعلوم است.",
};
const fa = (code: string) => FAILURE_FA[code] ?? "خطای نامشخص.";

const freshSteps = (): StepRecord[] => (["create_application", "upload_source", "create_release", "verify_deployment"] as const).map((name) => ({ name, status: "pending", startedAt: null, endedAt: null, outcome: null }));
export { freshSteps };

export class LiaraDeploymentExecutor {
  private inFlight = new Map<string, Promise<LiveOperationRecord>>();
  constructor(private readonly d: ExecutorDeps) {}

  private iso() {
    return new Date(this.d.now()).toISOString();
  }

  /** Compare-and-set persist. A lost race means someone else owns the operation: abort, never overwrite. */
  private async persist(op: LiveOperationRecord, from: LiveState, note: string | null = null): Promise<LiveOperationRecord> {
    const next: LiveOperationRecord = { ...op, updatedAt: this.iso(), transitions: op.state === from ? op.transitions : [...op.transitions, { at: this.iso(), from, to: op.state, note }] };
    if (!(await this.d.store.updateOperation(next, from))) throw new LiveError("live_invalid_state", [from, op.state]);
    return next;
  }
  private patch(op: LiveOperationRecord, p: Partial<LiveOperationRecord>): LiveOperationRecord {
    return { ...op, ...p };
  }
  private withStep(op: LiveOperationRecord, name: StepName, p: Partial<StepRecord>): LiveOperationRecord {
    return { ...op, steps: op.steps.map((s) => (s.name === name ? { ...s, ...p } : s)) };
  }

  private async finishFailed(op: LiveOperationRecord, from: LiveState, step: StepName | "preflight", code: string, remoteConfirmed: boolean | null, recovery: string[]): Promise<LiveOperationRecord> {
    const upd = this.patch(op, { state: "FAILED", failure: { code, step, messageFa: fa(code) }, recoveryFa: recovery, remote: { ...op.remote, appConfirmed: remoteConfirmed ?? op.remote.appConfirmed } });
    const saved = await this.persist(step === "preflight" ? upd : this.withStep(upd, step as StepName, { status: "failed", endedAt: this.iso(), outcome: code }), from, code);
    await this.d.audit(null, "operation_failed", { operationId: op.id, step, code, appConfirmed: saved.remote.appConfirmed });
    return saved;
  }
  private async needsReview(op: LiveOperationRecord, from: LiveState, step: StepName, code: string, recovery: string[], evidence?: { status: number | null; shape?: ResponseShape }): Promise<LiveOperationRecord> {
    const upd = this.withStep(this.patch(op, { state: "NEEDS_OPERATOR_REVIEW", failure: { code, step, messageFa: fa(code) }, recoveryFa: recovery }), step, { status: "unknown", endedAt: this.iso(), outcome: code });
    const saved = await this.persist(upd, from, code);
    // the HTTP status and (for an unreadable 2xx) the sanitised SHAPE of the answer are kept: without them an "unknown" upload cannot be diagnosed afterwards
    await this.d.audit(null, "operation_needs_review", { operationId: op.id, step, code, ...(evidence ? { httpStatus: evidence.status, shape: evidence.shape ?? null } : {}) });
    return saved;
  }

  // ===================================================================================================== typed operations

  /** Reads only: does this name exist, in this team, right now? `null` = could not tell. */
  private async nameExists(name: string): Promise<boolean | null> {
    const r = await this.d.reader.appNameExists(name);
    return r.ok ? r.data.exists : null;
  }

  /** Polls the (read-only) list a few times; used after a create whose outcome is known-accepted or unknown. */
  private async reconcileExists(name: string): Promise<boolean | null> {
    let last: boolean | null = null;
    for (let i = 0; i < this.d.config.reconcileAttempts; i++) {
      last = await this.nameExists(name);
      if (last === true) return true;
      await this.d.sleep(this.d.config.reconcileDelayMs);
    }
    return last; // false = not visible yet (NOT proof of absence), null = unreadable
  }

  async createApplication(op: LiveOperationRecord): Promise<LiveOperationRecord> {
    const p = await assertStepAuthorized(this.d.store, op, this.d.gate(), "APPROVED");
    let cur = this.withStep(this.patch(op, { state: "CREATING_APPLICATION" }), "create_application", { status: "started", startedAt: this.iso() });
    cur = await this.persist(cur, "APPROVED", "create_application_started");
    await this.d.audit(null, "create_application_attempt", { operationId: op.id, app: p.appName, plan: p.planId });
    // the body is derived from the approved proposal ONLY
    const body = CreateAppRequestSchema.parse({ name: p.appName, planID: p.planId, platform: p.platform, bundlePlanID: p.bundlePlanId, network: p.networkId });
    if (!this.d.transport) throw new LiveError("live_execution_disabled");
    const r = await this.d.transport.createApp(body);
    if (!r.ok && r.kind === "rejected") {
      // An HTTP error does NOT prove the absence of a server-side effect (the OpenAPI states no such guarantee): READ the state before concluding anything.
      const seen = await this.reconcileExists(p.appName);
      if (seen === false) {
        // observed absent (an observation at this moment, not a proof): FAILED, the name is released, an existing app of that name is never touched
        return this.finishFailed(cur, "CREATING_APPLICATION", "create_application", r.code, false, r.code === "insufficient_balance" ? ["حساب لیارا را دستی شارژ کنید و یک عملیات جدید با تأیید تازه بسازید."] : ["علت را بررسی کنید و یک عملیات جدید با تأیید تازه بسازید؛ در لحظهٔ بررسی هیچ برنامه‌ای با این نام دیده نشد."]);
      }
      return this.needsReview(cur, "CREATING_APPLICATION", "create_application", seen === true ? "rejected_but_name_present" : "rejected_but_state_unreadable", [
        "در کنسول لیارا بررسی کنید برنامه‌ای با این نام هست یا نه و چه کسی آن را ساخته است. این ابزار هیچ‌گاه درخواست ساخت را دوباره نمی‌فرستد و به دامنهٔ دسترسی چیزی اضافه نمی‌کند.",
        "اگر برنامه مال شما نیست، عملیات را رها کنید و نام دیگری با تأیید تازه انتخاب کنید.",
      ]);
    }
    const accepted = r.ok;
    if (accepted) cur = this.patch(cur, { ladder: { ...cur.ladder, apiAcceptedRequest: "ok" } });
    const visible = await this.reconcileExists(p.appName);
    if (visible !== true) {
      const code = accepted ? "accepted_but_not_visible" : (r as { code: WriteErrorCode }).code;
      return this.needsReview(cur, "CREATING_APPLICATION", "create_application", code, [
        "در کنسول لیارا بررسی کنید که برنامه ساخته شده است یا نه. این ابزار هیچ‌گاه درخواست ساخت را دوباره نمی‌فرستد.",
        "اگر برنامه وجود دارد، «بررسی دوبارهٔ وضعیت» را بزنید؛ اگر نه، عملیات را رها کنید و با تأیید تازه شروع کنید.",
      ]);
    }
    // the exact NEW identity must be proven before this app can ever join the allowlist: the API-reported name has to equal the approved name
    let identity = false;
    for (let k = 0; k < this.d.config.reconcileAttempts && !identity; k++) {
      const id = await this.d.reader.appIdentity(p.appName);
      identity = id.ok && id.data.name === p.appName;
      if (!identity) await this.d.sleep(this.d.config.reconcileDelayMs);
    }
    if (!identity) {
      return this.needsReview(cur, "CREATING_APPLICATION", "create_application", "identity_unverified", ["در کنسول لیارا نام و مشخصات برنامه را با پیشنهاد تأییدشده مقایسه کنید؛ سپس «بررسی دوبارهٔ وضعیت» را بزنید. چیزی به دامنهٔ دسترسی افزوده نشد."]);
    }
    cur = this.withStep(this.patch(cur, { state: "APPLICATION_CREATED", remote: { ...cur.remote, appConfirmed: true }, ladder: { ...cur.ladder, apiAcceptedRequest: "ok" } }), "create_application", { status: "done", endedAt: this.iso(), outcome: accepted ? "accepted_and_visible" : "reconciled_after_unknown_outcome" });
    cur = await this.persist(cur, "CREATING_APPLICATION", accepted ? "app_visible" : "reconciled_after_unknown");
    // transactional scope bootstrap: only for THIS operation's app, only after confirmed creation
    const b = await this.d.store.bootstrapScope(cur.id, this.iso());
    await this.d.audit(null, "scope_bootstrap", { operationId: cur.id, app: p.appName, ok: b.ok, reason: b.reason ?? null });
    return cur;
  }

  /**
   * Phase 2D — NO create request. Proves that the application the operator approved is the one that exists RIGHT NOW (exact name reported by the API, same plan id,
   * running). Anything else ends the operation before a single byte is sent. Existing apps are never added to the scope here (bootstrapScope refuses them).
   */
  async adoptExisting(op: LiveOperationRecord): Promise<LiveOperationRecord> {
    const p = await assertStepAuthorized(this.d.store, op, this.d.gate(), "APPROVED");
    let id: Awaited<ReturnType<LiveReader["appIdentity"]>> = { ok: false, code: "not_found" };
    for (let i = 0; i < this.d.config.reconcileAttempts; i++) {
      id = await this.d.reader.appIdentity(p.appName);
      if (id.ok) break;
      await this.d.sleep(this.d.config.reconcileDelayMs);
    }
    if (!id.ok) return this.finishFailed(op, "APPROVED", "preflight", "existing_app_missing", null, ["برنامه را در کنسول لیارا بررسی کنید و پیشنهاد را دوباره بسازید."]);
    if (id.data.name !== p.appName || (id.data.planId !== null && id.data.planId !== p.planId)) return this.finishFailed(op, "APPROVED", "preflight", "existing_identity_mismatch", null, ["مشخصات برنامه با پیشنهاد تأییدشده نمی‌خواند؛ پیشنهاد تازه بسازید."]);
    // the approval is bound to ONE application INSTANCE: a deleted-and-recreated app (same name, new instance id / creation time / network) is a different app
    const b = p.existing;
    if (!b || id.data.instanceId !== b.instanceId || id.data.createdAt !== b.createdAt || id.data.networkId !== b.networkId) return this.finishFailed(op, "APPROVED", "preflight", "existing_instance_changed", null, ["برنامه حذف و دوباره ساخته شده یا مشخصات آن عوض شده است؛ تأیید قدیمی معتبر نیست. پیشنهاد تازه بسازید."]);
    const base = await this.d.reader.releaseBaseline(p.appName);
    if (!base.ok || base.data.currentRelease !== b.baselineRelease || base.data.total !== b.releaseTotal) return this.finishFailed(op, "APPROVED", "preflight", "existing_baseline_changed", null, ["نسخه‌های برنامه از زمان تأیید تغییر کرده‌اند (کسی نسخهٔ تازه‌ای ساخته یا فهرست خوانده نشد)؛ پیشنهاد تازه بسازید."]);
    if (id.data.scale !== 1) return this.finishFailed(op, "APPROVED", "preflight", "existing_app_not_running", null, ["برنامه را خودتان در کنسول لیارا روشن کنید و پیشنهاد تازه بسازید."]);
    let cur = this.withStep(this.patch(op, { state: "APPLICATION_CREATED", remote: { ...op.remote, appConfirmed: true }, ladder: { ...op.ladder, apiAcceptedRequest: "ok" } }), "create_application", { status: "done", startedAt: this.iso(), endedAt: this.iso(), outcome: "existing_app_verified" });
    cur = await this.persist(cur, "APPROVED", "existing_app_verified");
    await this.d.audit(null, "existing_app_verified", { operationId: cur.id, app: p.appName, backend: p.backend });
    return cur;
  }

  /**
   * Phase 2D — the OFFICIAL CLI performs the two write calls (source upload + release). Rules: it runs at most ONCE; its exit code and output are NEVER taken as proof;
   * the outcome is established by comparing the releases list with a baseline read BEFORE the run. Zero new releases after a non-zero exit is an observation, not a
   * proof (the CLI may have died after the POST); a timeout or kill is an unknown outcome and goes to the operator. Nothing is deleted or retried.
   */
  async cliDeploy(op: LiveOperationRecord, zip: Buffer): Promise<LiveOperationRecord> {
    const p = await assertStepAuthorized(this.d.store, op, this.d.gate(), "APPLICATION_CREATED");
    if (!this.d.cli || !p.cli) throw new LiveError("live_prerequisite_missing", ["cli_backend_enabled"]);
    const before = await this.d.reader.getReleases(p.appName);
    if (!before.ok) return this.finishFailed(op, "APPLICATION_CREATED", "preflight", "baseline_unreadable", true, ["اتصال خواندن را بررسی کنید و پیشنهاد تازه بسازید؛ چیزی اجرا نشد."]);
    const known = new Set(before.data.releases.map((x) => x.id));
    let cur = this.withStep(this.patch(op, { state: "UPLOADING_SOURCE" }), "upload_source", { status: "started", startedAt: this.iso() });
    cur = await this.persist(cur, "APPLICATION_CREATED", "cli_deploy_started");
    await this.d.audit(null, "cli_deploy_attempt", { operationId: op.id, app: p.appName, cliVersion: p.cli.version, argvDigest12: p.cli.argvDigest.slice(0, 12), manifestDigest12: p.cli.manifestDigest.slice(0, 12) });
    const res = await this.d.cli.deploy({ params: { app: p.appName, platform: p.platform, port: p.config.port, teamId: p.teamId, message: `agent-op-${op.id}` }, zip, getToken: this.d.getToken, expected: p.cli });
    await this.d.audit(null, "cli_deploy_result", { operationId: op.id, outcome: res.outcome, refusal: res.refusal, exitCode: res.exitCode, signal: res.signal, durationMs: res.durationMs, tail: res.tail, truncated: res.outputTruncated });
    if (res.outcome === "refused") return this.finishFailed(this.withStep(cur, "upload_source", { status: "failed" }), "UPLOADING_SOURCE", "upload_source", "cli_refused", true, ["هیچ پردازشی اجرا نشد. تنظیمات CLI (مسیر، هش، نسخه) و فایل ZIP را بررسی کنید و پیشنهاد تازه بسازید."]);
    if (res.outcome === "spawn_failed") return this.finishFailed(cur, "UPLOADING_SOURCE", "upload_source", "cli_spawn_failed", true, ["مسیر Node و CLI را بررسی کنید؛ چیزی ارسال نشد."]);
    // the process ran: reconcile by READING (never by parsing its output)
    let fresh: string[] | null = null;
    for (let i = 0; i < this.d.config.reconcileAttempts; i++) {
      const after = await this.d.reader.getReleases(p.appName);
      fresh = after.ok ? after.data.releases.filter((x) => !known.has(x.id)).map((x) => x.id) : null;
      if (fresh !== null && fresh.length > 0) break;
      await this.d.sleep(this.d.config.reconcileDelayMs);
    }
    const review = (code: string, rec: string[]) => this.needsReview(cur, "UPLOADING_SOURCE", "upload_source", code, rec);
    const manual = ["در کنسول لیارا فهرست نسخه‌ها را ببینید. این ابزار CLI را دوباره اجرا نمی‌کند و چیزی را حذف یا بازگردانی نمی‌کند.", "اگر نسخه‌ای ساخته شده «بررسی دوبارهٔ وضعیت» را بزنید."];
    if (fresh === null) return review(res.outcome === "timeout" ? "cli_timeout" : "rejected_but_state_unreadable", manual);
    if (fresh.length > 1) return review("cli_release_ambiguous", manual);
    if (fresh.length === 0) {
      if (res.outcome === "timeout") return review("cli_timeout", manual);
      if (res.outcome === "exit_zero") return review("cli_zero_no_release", manual);
      return this.finishFailed(cur, "UPLOADING_SOURCE", "upload_source", "cli_nonzero_no_release", true, ["برنامه حفظ شده است. خروجی پاک‌سازی‌شدهٔ CLI در گزارش حسابرسی است؛ علت را رفع کنید و پیشنهاد تازه بسازید."]);
    }
    // exactly one new release: adopt it. The upload and the release happened inside the CLI, so those two levels are INFERRED from the release's existence (evidence: releases list).
    cur = this.withStep(this.patch(cur, { state: "SOURCE_UPLOADED", ladder: { ...cur.ladder, sourceUploaded: "ok" } }), "upload_source", { status: "done", endedAt: this.iso(), outcome: "uploaded_by_cli_inferred" });
    cur = await this.persist(cur, "UPLOADING_SOURCE", "cli_source_inferred");
    cur = this.withStep(this.patch(cur, { state: "CREATING_RELEASE" }), "create_release", { status: "started", startedAt: this.iso() });
    cur = await this.persist(cur, "SOURCE_UPLOADED", "cli_release_started");
    cur = this.withStep(this.patch(cur, { state: "RELEASE_CREATED", remote: { ...cur.remote, releaseId: fresh[0]! } }), "create_release", { status: "done", endedAt: this.iso(), outcome: "release_observed_after_cli" });
    return this.persist(cur, "CREATING_RELEASE", "cli_release_observed");
  }

  async uploadSource(op: LiveOperationRecord, artifact: Buffer): Promise<LiveOperationRecord> {
    const p = await assertStepAuthorized(this.d.store, op, this.d.gate(), "APPLICATION_CREATED");
    const digest = createHash("sha256").update(artifact).digest("hex");
    if (digest !== p.artifact.artifactDigest) throw new LiveError("live_artifact_mismatch");
    // the official CLI refuses to deploy an app that is not running (scale = 0); we never start it automatically
    const app = await this.waitForApp(p.appName);
    if (!app.ok || app.scale !== 1) {
      return this.needsReview(this.withStep(op, "upload_source", { status: "pending" }), "APPLICATION_CREATED", "upload_source", app.ok ? "app_not_running" : "verification_inconclusive", ["برنامه را در کنسول لیارا روشن کنید یا وضعیت را بررسی کنید؛ سپس «بررسی دوبارهٔ وضعیت» را بزنید."]);
    }
    let cur = this.withStep(this.patch(op, { state: "UPLOADING_SOURCE" }), "upload_source", { status: "started", startedAt: this.iso() });
    cur = await this.persist(cur, "APPLICATION_CREATED", "upload_started");
    await this.d.audit(null, "upload_attempt", { operationId: op.id, bytes: artifact.length, digest12: digest.slice(0, 12) });
    if (!this.d.transport) throw new LiveError("live_execution_disabled");
    const r = await this.d.transport.uploadSource(p.appName, artifact);
    if (!r.ok) {
      if (r.kind === "rejected") return this.finishFailed(cur, "UPLOADING_SOURCE", "upload_source", r.code, true, ["برنامهٔ ساخته‌شده حفظ شده است. مشکل را رفع کنید و برای انتشار، در کنسول لیارا یا با یک عملیات جدید (نام تازه) اقدام کنید. هیچ چیزی حذف نشد."]);
      const accepted = r.status !== null && r.status >= 200 && r.status < 300; // an answer in the 2xx range: Liara took the file, only its reply was unusable
      return this.needsReview(cur, "UPLOADING_SOURCE", "upload_source", r.code, accepted ? [
        "لیارا با وضعیت موفق (۲xx) پاسخ داد، یعنی فایل به احتمال زیاد دریافت و ذخیره شده است؛ فقط شناسهٔ سورس (sourceID) از پاسخ خوانده نشد. هیچ نسخه‌ای ساخته نشد و برنامه و نسخهٔ فعلی دست‌نخورده‌اند.",
        "سورس ذخیره‌شده بی‌اثر است و فهرست‌کردن یا حذف آن از API ممکن نیست. این ابزار بارگذاری را خودکار تکرار نمی‌کند؛ ادامه فقط با یک عملیات تازه و تأیید تازهٔ شما ممکن است.",
        "شکل پاسخ (بدون هیچ مقداری) در گزارش حسابرسی ثبت شده است؛ پیش از تلاش دوباره آن را بررسی کنید و این عملیات را رها کنید.",
      ] : ["نتیجهٔ بارگذاری نامعلوم است و راهی برای فهرست‌کردن سورس‌های بارگذاری‌شده نیست. این ابزار بارگذاری را خودکار تکرار نمی‌کند.", "در کنسول لیارا وضعیت برنامه را ببینید؛ در صورت لزوم عملیات را رها کنید."], { status: r.status, shape: r.shape });
    }
    cur = this.withStep(this.patch(cur, { state: "SOURCE_UPLOADED", remote: { ...cur.remote, sourceId: r.data.sourceID }, ladder: { ...cur.ladder, sourceUploaded: "ok" } }), "upload_source", { status: "done", endedAt: this.iso(), outcome: "uploaded" });
    return this.persist(cur, "UPLOADING_SOURCE", "source_uploaded");
  }

  async createRelease(op: LiveOperationRecord): Promise<LiveOperationRecord> {
    const p = await assertStepAuthorized(this.d.store, op, this.d.gate(), "SOURCE_UPLOADED");
    if (!op.remote.sourceId) throw new LiveError("live_invalid_state", ["no_source"]);
    const before = await this.d.reader.getReleases(p.appName);
    const known = new Set(before.ok ? before.data.releases.map((x) => x.id) : []);
    let cur = this.withStep(this.patch(op, { state: "CREATING_RELEASE" }), "create_release", { status: "started", startedAt: this.iso() });
    cur = await this.persist(cur, "SOURCE_UPLOADED", "release_started");
    await this.d.audit(null, "release_attempt", { operationId: op.id, app: p.appName });
    const body = CreateReleaseRequestSchema.parse({ sourceID: op.remote.sourceId, port: p.config.port, type: p.platform, platformConfig: {}, build: { cache: true }, gitInfo: NON_REPO_GIT_INFO });
    if (!this.d.transport) throw new LiveError("live_execution_disabled");
    const r = await this.d.transport.createRelease(p.appName, body);
    if (r.ok) {
      cur = this.withStep(this.patch(cur, { state: "RELEASE_CREATED", remote: { ...cur.remote, releaseId: r.data.releaseID } }), "create_release", { status: "done", endedAt: this.iso(), outcome: "created" });
      return this.persist(cur, "CREATING_RELEASE", "release_created");
    }
    if (r.kind === "rejected") {
      // a rejection is not proof of "nothing happened": compare the releases list with the baseline taken before the POST
      const after = await this.d.reader.getReleases(p.appName);
      const fresh = after.ok ? after.data.releases.filter((x) => !known.has(x.id)) : null;
      if (fresh === null || fresh.length > 0) return this.needsReview(cur, "CREATING_RELEASE", "create_release", fresh === null ? "rejected_but_state_unreadable" : "rejected_but_release_present", ["در کنسول لیارا فهرست نسخه‌ها را ببینید؛ این ابزار ساخت نسخه را دوباره نمی‌فرستد و چیزی را حذف یا بازگردانی نمی‌کند."]);
    }
    if (r.kind === "rejected") return this.finishFailed(cur, "CREATING_RELEASE", "create_release", r.code, true, ["برنامه و سورس بارگذاری‌شده حفظ شده‌اند. علت را بررسی کنید؛ هیچ حذف یا بازگشت خودکاری انجام نمی‌شود."]);
    // unknown outcome: RECONCILE by reading the releases list — a release id that was not there before our POST is adopted; otherwise a human decides
    for (let i = 0; i < this.d.config.reconcileAttempts; i++) {
      const after = await this.d.reader.getReleases(p.appName);
      const fresh = after.ok ? after.data.releases.filter((x) => !known.has(x.id)) : [];
      if (fresh.length === 1) {
        cur = this.withStep(this.patch(cur, { state: "RELEASE_CREATED", remote: { ...cur.remote, releaseId: fresh[0]!.id } }), "create_release", { status: "done", endedAt: this.iso(), outcome: "reconciled_after_unknown_outcome" });
        return this.persist(cur, "CREATING_RELEASE", "release_reconciled");
      }
      if (fresh.length > 1) break; // ambiguous: never guess
      await this.d.sleep(this.d.config.reconcileDelayMs);
    }
    return this.needsReview(cur, "CREATING_RELEASE", "create_release", r.code, ["نتیجهٔ ساخت نسخه نامعلوم است. فهرست نسخه‌ها را در کنسول لیارا ببینید؛ این ابزار درخواست را دوباره نمی‌فرستد.", "اگر نسخه‌ای ساخته شده، «بررسی دوبارهٔ وضعیت» را بزنید."], { status: r.status, shape: r.shape });
  }

  private async waitForApp(name: string): Promise<{ ok: true; scale: number | null } | { ok: false }> {
    for (let i = 0; i < this.d.config.reconcileAttempts; i++) {
      const a = await this.d.reader.getApp(name);
      if (a.ok) return { ok: true, scale: a.data.scale };
      await this.d.sleep(this.d.config.reconcileDelayMs);
    }
    return { ok: false };
  }

  /** READ-ONLY. One observation of everything the ladder needs. */
  async inspectDeployment(op: LiveOperationRecord): Promise<Snapshot> {
    const app = op.appName;
    const rel = await this.d.reader.getReleases(app);
    const entry = rel.ok && op.remote.releaseId ? rel.data.releases.find((x) => x.id === op.remote.releaseId) : undefined;
    const rt = await this.d.reader.getRuntime(app);
    let health: Snapshot["health"] = null;
    const probeConfigured = this.d.config.suffixes.length > 0;
    if (probeConfigured && entry && ["READY", "DEPLOYING"].includes((entry.state ?? "").toUpperCase())) {
      const pr = await this.d.probe({ appName: app, path: this.d.config.healthPath, marker: this.d.config.healthMarker ?? undefined });
      health = { outcome: pr.outcome, status: pr.status, markerFound: pr.markerFound, markerRequired: this.d.config.healthMarker !== null };
    }
    return {
      apiAcceptedRequest: op.ladder.apiAcceptedRequest === "ok",
      sourceUploaded: op.ladder.sourceUploaded === "ok" || !!op.remote.sourceId,
      releaseId: op.remote.releaseId,
      releaseState: entry?.state ?? null,
      currentReleaseMatches: rel.ok && op.remote.releaseId ? rel.data.currentRelease === op.remote.releaseId : null,
      runtime: rt.ok ? { runtime: rt.data.runtime, heuristic: rt.data.heuristic, appletCount: rt.data.appletCount } : null,
      health,
      probeConfigured,
    };
  }

  /**
   * Bounded polling → ladder → DEPLOYED / FAILED / NEEDS_OPERATOR_REVIEW. Read-only; safe to repeat. Also the engine of "re-verify": started from
   * NEEDS_OPERATOR_REVIEW it never moves back into the pipeline, it can only end in DEPLOYED (all six facts "ok"), FAILED, or stay under review.
   */
  async verifyRuntime(op: LiveOperationRecord, from: LiveState = "RELEASE_CREATED"): Promise<LiveOperationRecord> {
    let cur = op;
    if (cur.state !== "VERIFYING_DEPLOYMENT" && cur.state !== "NEEDS_OPERATOR_REVIEW") {
      cur = this.withStep(this.patch(cur, { state: "VERIFYING_DEPLOYMENT" }), "verify_deployment", { status: "started", startedAt: this.iso() });
      cur = await this.persist(cur, from, "verification_started");
    }
    if (!cur.remote.releaseId) throw new LiveError("live_invalid_state", ["no_release"]);
    const deadline = this.d.now() + this.d.config.verifyBudgetMs;
    for (;;) {
      const snap = await this.inspectDeployment(cur);
      const ladder = evaluateLadder(snap);
      cur = await this.persist(this.patch(cur, { ladder }), cur.state);
      const expired = this.d.now() >= deadline;
      const verdict = verdictOf(ladder, { stillPolling: !expired });
      if (verdict === "deployed") {
        const was = cur.state;
        cur = this.withStep(this.patch(cur, { state: "DEPLOYED", failure: null, recoveryFa: [] }), "verify_deployment", { status: "done", endedAt: this.iso(), outcome: "all_criteria_satisfied" });
        const done = await this.persist(cur, was, "deployed_verified");
        await this.d.audit(null, "operation_deployed", { operationId: cur.id, ladder });
        return done;
      }
      if (verdict === "failed") return this.finishFailed(cur, cur.state, "verify_deployment", "verification_failed", true, ["برنامه و نسخه حفظ شده‌اند (حذف یا بازگشت خودکار وجود ندارد). لاگ و وضعیت نسخه را در کنسول لیارا ببینید؛ اصلاح را با یک استقرار جدید انجام دهید."]);
      if (verdict === "needs_review") return this.needsReview(cur, cur.state, "verify_deployment", ladderVerdict(ladder) === "PARTIALLY_VERIFIED" ? "partially_verified" : "verification_inconclusive", ["شواهد کافی برای موفقیت نیست (وضعیت نسخه/اجرا یا سلامت HTTP نامعلوم است). نشانی برنامه را دستی بررسی کنید و بعد «بررسی دوبارهٔ وضعیت» را بزنید.", this.d.config.suffixes.length === 0 ? "دامنهٔ پیش‌فرض برای بررسی HTTP پیکربندی نشده است (LIARA_APP_DOMAIN_SUFFIXES)." : "بررسی سلامت HTTP موفق نبود."]);
      await this.d.sleep(this.d.config.pollIntervalMs);
    }
  }

  /** Operator-requested re-check of an operation under review. READ-ONLY: with a release → full verification; without one → only refresh whether the app exists. */
  async reverify(op: LiveOperationRecord): Promise<LiveOperationRecord> {
    if (op.state !== "NEEDS_OPERATOR_REVIEW") throw new LiveError("live_invalid_state", [op.state]);
    if (op.remote.releaseId) return this.verifyRuntime(op, "NEEDS_OPERATOR_REVIEW");
    const exists = await this.nameExists(op.appName);
    if (exists === true && op.remote.appConfirmed !== true) {
      const id = await this.d.reader.appIdentity(op.appName);
      if (!id.ok || id.data.name !== op.appName) return op; // the exact identity is still unproven: nothing is confirmed and nothing joins the allowlist
      const upd = await this.persist(this.patch(op, { remote: { ...op.remote, appConfirmed: true }, recoveryFa: ["برنامه در لیارا وجود دارد. این ابزار انتشار را خودکار ادامه نمی‌دهد؛ برنامه را در کنسول بررسی/منتشر کنید یا عملیات را رها کنید (برنامه حفظ می‌شود)."] }), "NEEDS_OPERATOR_REVIEW", "app_visible_on_reverify");
      const b = await this.d.store.bootstrapScope(upd.id, this.iso());
      await this.d.audit(null, "scope_bootstrap", { operationId: upd.id, app: upd.appName, ok: b.ok, reason: b.reason ?? null });
      return upd;
    }
    return op;
  }

  /** Whole run for an APPROVED operation. One run per operation per process; across processes the store's compare-and-set arbitrates. */
  run(op: LiveOperationRecord, input: { artifact: Buffer; zip: Buffer }): Promise<LiveOperationRecord> {
    const existing = this.inFlight.get(op.id);
    if (existing) return Promise.reject(new LiveError("live_operation_in_progress"));
    const p = this.exec(op, input).finally(() => this.inFlight.delete(op.id));
    this.inFlight.set(op.id, p);
    return p;
  }
  isRunning(id: string) {
    return this.inFlight.has(id);
  }

  private async exec(op0: LiveOperationRecord, input: { artifact: Buffer; zip: Buffer }): Promise<LiveOperationRecord> {
    const artifact = input.artifact;
    let op = op0;
    const age = () => this.d.now() - Date.parse(op0.createdAt);
    // ---- fresh preflight (everything re-derived now; nothing trusted from the time of approval) ----
    const p = await assertStepAuthorized(this.d.store, op, this.d.gate(), "APPROVED");
    const digest = createHash("sha256").update(artifact).digest("hex");
    if (digest !== p.artifact.artifactDigest) return this.finishFailed(op, "APPROVED", "preflight", "preflight_artifact_mismatch", false, ["همان فایل ZIP تأییدشده را دوباره بارگذاری کنید."]);
    const exists = await this.nameExists(p.appName);
    if (p.kind === "deploy_existing_app" && exists === false) return this.finishFailed(op, "APPROVED", "preflight", "existing_app_missing", null, ["برنامه را در کنسول لیارا بررسی کنید و پیشنهاد را دوباره بسازید."]);
    if (p.kind === "create_new_app" && exists === true) return this.finishFailed(op, "APPROVED", "preflight", "preflight_name_exists", false, ["نام دیگری انتخاب کنید و تأیید تازه بگیرید."]);
    if (exists === null) return this.finishFailed(op, "APPROVED", "preflight", "preflight_name_unverifiable", false, ["اتصال و دسترسی خواندن را بررسی کنید و دوباره تلاش کنید؛ چیزی ساخته نشد."]);
    const fp = await this.d.fingerprint(p);
    if (fp === null || fp !== p.stateFingerprint) return this.finishFailed(op, "APPROVED", "preflight", fp === null ? (p.kind === "deploy_existing_app" ? "preflight_drift" : "preflight_plan_blocked") : "preflight_drift", false, ["پیشنهاد را دوباره بسازید و تأیید تازه بگیرید."]);
    // ---- steps ----
    // a release to an EXISTING application never sends a create request: its identity is verified instead (and it never joins the scope: the operator allowlisted it)
    op = p.kind === "deploy_existing_app" ? await this.adoptExisting(op) : await this.createApplication(op);
    if (op.state !== "APPLICATION_CREATED") return op;
    if (age() > this.d.config.maxOperationAgeMs) return this.needsReview(op, "APPLICATION_CREATED", "upload_source", "operation_too_old", ["عملیات بیش از حد طول کشیده؛ وضعیت را دستی بررسی کنید."]);
    if (p.backend === "cli") {
      op = await this.cliDeploy(op, input.zip);
      if (op.state !== "RELEASE_CREATED") return op;
      return this.verifyRuntime(op, "RELEASE_CREATED");
    }
    op = await this.uploadSource(op, artifact);
    if (op.state !== "SOURCE_UPLOADED") return op;
    op = await this.createRelease(op);
    if (op.state !== "RELEASE_CREATED") return op;
    return this.verifyRuntime(op, "RELEASE_CREATED");
  }
}
export { EMPTY_LADDER };
