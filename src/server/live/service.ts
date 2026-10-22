import { createHash, randomBytes } from "node:crypto";
import { analyzeSource } from "../deploy/analyze";
import { buildPlan } from "../deploy/plan";
import { buildReadiness } from "../deploy/readiness";
import { recommend } from "../deploy/recommend";
import { withProject } from "../deploy/workspace";
import { canonicalJson, digestsEqual } from "../agent/policy";
import { ownerHashOf } from "../diagnostics/store";
import { APP_NAME_REGEX, type AppConfig } from "../config/env";
import { log } from "../security/logger";
import { assertStepAuthorized, contentOfLive, liveDigest, type LiveGate } from "./authorize";
import { ArtifactError, buildDeploymentArtifact, materializeApprovedSource, type ArtifactResult } from "./artifact";
import type { LiaraCliBackend } from "./cli/backend";
import { argvTemplateDigest } from "./cli/spec";
import { bindingOf, buildExistingChecks, existingSignature, expectedDefaultSuffix, type ExistingFacts } from "./existing";
import { LIVE_PLATFORMS, type LiveWriteTransport } from "./contract";
import { DEFAULT_EXECUTOR_CONFIG, freshSteps, LiaraDeploymentExecutor, type ExecutorConfig } from "./executor";
import { listCandidates, selectPlan, type PlanSelection } from "./plans";
import { type PreflightCheck, type PreflightReport } from "./preflight";
import { gatherPreflight, type PreflightSelection } from "./preflight-gather";
import type { PlanProjection } from "../liara/plans";
import { safeProbe, type ProbeResult } from "./probe";
import type { LiveReader } from "./reader";
import type { LiveStore } from "./store";
import { isActiveOperation, teamKey } from "./store";
import { EMPTY_LADDER, LiveError, LIVE_STATES, LIVE_TERMINAL, type LiveApprovalRecord, type LiveOperationRecord, type LiveProposal, type LiveProposalContent, type LiveState } from "./types";

/**
 * LiveDeploymentService — proposals, decisions, execution start, recovery for REAL deployments. It reuses the architecture of the Phase 1D/1E approval engine
 * (owner binding, digest, expiry, drift, typed name, atomic single-use claim) but with its OWN types, tables and digest domain: a simulation approval can
 * never be presented here, and nothing here can be reached by chat text or model output (there is no code path from a message to these methods).
 */

export const LIVE_APPROVAL_TTL_MS = 10 * 60_000;

export interface Prerequisite {
  id: string;
  ok: boolean;
  blocking: boolean;
  /** shown to the operator; never contains a secret */
  detail: string;
}

export interface LiveServiceOptions {
  cfg: AppConfig;
  store: LiveStore;
  /** the read-only service, used ONLY through the narrow `reader` */
  reader: LiveReader;
  /** null ⇒ live execution unavailable (the default) */
  transport: LiveWriteTransport | null;
  /** Phase 2D: the restricted official-CLI backend; null (the default) ⇒ the `cli` backend does not exist */
  cliBackend?: LiaraCliBackend | null;
  now?: () => number;
  sleep?: (ms: number) => Promise<void>;
  executor?: Partial<ExecutorConfig>;
  probe?: (o: { appName: string; path: string; marker?: string }) => Promise<ProbeResult>;
  /**
   * Is a login session that maps to this owner hash still alive? Ownership is bound to the (in-memory) login session, so after a restart or a new login the
   * previous owner can never act again. When it is NOT active, another authenticated session may CLOSE (never approve or execute) that owner's operation —
   * see `recoveryAccess`. Absent ⇒ every owner is treated as active ⇒ strict owner-only (the safe default for tests and tooling).
   */
  isOwnerActive?: (ownerHash: string) => boolean;
}

export interface LiveProposalView {
  proposal: LiveProposal;
  approvals: LiveApprovalRecord[];
  operation: LiveOperationRecord | null;
}

const rid = (prefix: string, nowMs: number) => `${prefix}_${new Date(nowMs).toISOString().replace(/[-:T.Z]/g, "").slice(0, 14)}_${randomBytes(4).toString("hex")}`;
const sha256 = (b: Buffer | string) => createHash("sha256").update(b).digest("hex");
const shortHash = (s: string) => ownerHashOf(s).slice(0, 8);

export function liveFingerprint(i: { teamId: string | null; appName: string; planId: string; bundlePlanId: string; networkId: string; zipSha256: string; artifactDigest: string; unitsVerifiedAt: string | null; nameAbsent: boolean; planAvailable: boolean; preflightSig: string }): string {
  return sha256(canonicalJson({ domain: "liara-live-fingerprint-v1", ...i }));
}

const SIG_IDS = ["network_listing", "network_exists", "units_corroborated", "units_agree", "billing_semantics", "selected_plan", "balance", "team_scope"];
/** The slice of the preflight that is part of the approved state: if any of these changes between proposal, approval and execution, the approval is void (drift). */
export function preflightSig(pf: PreflightReport): string {
  return SIG_IDS.map((id) => `${id}:${pf.checks.find((k) => k.id === id)?.status ?? "none"}`).join("|");
}

export class LiveDeploymentService {
  readonly executor: LiaraDeploymentExecutor | null;
  private lock: Promise<unknown> = Promise.resolve();
  private readonly now: () => number;
  private readonly recovered: Promise<void>;

  constructor(private readonly o: LiveServiceOptions) {
    this.now = o.now ?? Date.now;
    this.executor = o.transport || o.cliBackend
      ? new LiaraDeploymentExecutor({
          transport: o.transport,
          cli: o.cliBackend ?? null,
          getToken: () => o.cfg.liara.token?.reveal() ?? "",
          reader: o.reader,
          store: o.store,
          gate: () => this.gate(),
          config: { ...DEFAULT_EXECUTOR_CONFIG, suffixes: o.cfg.live.appDomainSuffixes, healthPath: o.cfg.live.healthPath, healthMarker: o.cfg.live.healthMarker, ...o.executor },
          now: this.now,
          sleep: o.sleep ?? ((ms) => new Promise((r) => setTimeout(r, ms))),
          audit: (runId, event, data) => this.audit(runId, event, data),
          probe: o.probe ?? ((p) => safeProbe({ ...p, suffixes: o.cfg.live.appDomainSuffixes })),
          fingerprint: (p) => this.recomputeFingerprint(p),
        })
      : null;
    this.recovered = this.recover();
  }

  private iso() {
    return new Date(this.now()).toISOString();
  }
  private audit(runId: string | null, event: string, data: Record<string, unknown>) {
    return this.o.store.appendAudit(this.iso(), runId, `live.${event}`, data);
  }
  private serial<T>(fn: () => Promise<T>): Promise<T> {
    const next = this.lock.then(fn);
    this.lock = next.catch(() => undefined);
    return next;
  }

  gate(): LiveGate {
    const c = this.o.cfg;
    return { enabled: c.live.enabled && c.dataSource === "live" && (this.o.transport !== null || !!this.o.cliBackend), contractAttested: c.live.contractAttested, unitsVerified: c.live.planUnits !== null, networkId: c.live.networkId, teamId: c.liara.teamId, cliEnabled: !!this.o.cliBackend, cliIdentity: this.cliIdentity() };
  }

  /** The CLI's identity as verified RIGHT NOW (file hash + package name/version; nothing is executed). null when the backend is absent or the tool does not match the pin. */
  private cliIdentity(): { version: string; entrySha256: string } | null {
    const r = this.o.cliBackend?.verifyIdentity();
    return r?.ok ? r.identity : null;
  }

  /** What is missing before a real deployment may even be PROPOSED. Pure reporting; changes nothing. */
  prerequisites(): Prerequisite[] {
    const c = this.o.cfg;
    const g = this.gate();
    const p = (id: string, ok: boolean, detail: string, blocking = true): Prerequisite => ({ id, ok, blocking, detail });
    return [
      p("live_flag", c.live.enabled, c.live.enabled ? "اجرای واقعی در پیکربندی فعال شده است (شرط لازم، نه کافی)." : "اجرای واقعی خاموش است (LIARA_LIVE_DEPLOY_ENABLED=false) — حالت پیش‌فرض."),
      p("data_source_live", c.dataSource === "live", c.dataSource === "live" ? "منبع داده: لیارای واقعی." : "منبع داده شبیه‌سازی است؛ اجرای واقعی با داده‌ٔ شبیه‌سازی‌شده ممکن نیست."),
      p("token", !!c.liara.token, c.liara.token ? "توکن پیکربندی شده است (مقدار نمایش داده نمی‌شود)." : "توکن لیارا پیکربندی نشده است."),
      p("write_transport", g.enabled, g.enabled ? "مسیر نوشتن آماده است." : "مسیر نوشتن ساخته نشده است."),
      p("contract_attested", c.live.contractAttested, c.live.contractAttested ? "اپراتور تأیید کرده فیلدهای نوشتن (CLI-observed) راستی‌آزمایی شده‌اند." : "فیلدهای ساخت اپ/نسخه که فقط در CLI رسمی دیده شده‌اند هنوز راستی‌آزمایی نشده‌اند (LIARA_LIVE_CONTRACT_ATTESTED)."),
      p("plan_units_verified", c.live.planUnits !== null, c.live.planUnits ? `واحدها و معنای صورتحساب توسط اپراتور تأیید شده (${c.live.planUnits.source}).` : "واحد RAM/CPU/قیمت و معنای صورتحساب تأیید نشده است (LIARA_PLAN_UNITS_JSON)؛ بدون آن هزینه نمایش داده نمی‌شود و ساخت مسدود است."),
      p("network_id", c.live.networkId !== null, c.live.networkId ? "شناسهٔ شبکه توسط اپراتور تعیین شده است." : "شناسهٔ شبکه (network _id) که CLI رسمی همیشه می‌فرستد تعیین نشده است (LIARA_NETWORK_ID)."),
      p("app_domain_suffix", c.live.appDomainSuffixes.length > 0, c.live.appDomainSuffixes.length ? "دامنهٔ مورد اعتماد برای بررسی سلامت HTTP تعیین شده است." : "دامنهٔ پیش‌فرض برنامه برای بررسی سلامت پیکربندی نشده (LIARA_APP_DOMAIN_SUFFIXES)؛ بدون آن «DEPLOYED» هرگز اعلام نمی‌شود."),
    ];
  }

  // ===================================================================================================== status (read-only, for the UI)
  async status(sessionId: string, runId: string | null): Promise<LiveStatus> {
    await this.recovered;
    const prerequisites = this.prerequisites();
    const g0 = this.gate();
    const mode: LiveModeInfo = { kind: this.o.cfg.dataSource !== "live" ? "simulation" : g0.enabled ? "live_enabled" : "live_disabled", dataSource: this.o.cfg.dataSource, liveFlag: this.o.cfg.live.enabled, writePathReady: g0.enabled };
    const out: LiveStatus = { uiState: "BLOCKED", prerequisites, runBlockers: [], catalogue: null, minRamMb: null, proposals: [], preflight: null, mode, existing: null, locks: [] };
    if (!runId) return out;
    const run = await this.ownedRun(runId, sessionId);
    const d = run.deployment!;
    const readiness = buildReadiness(d.analysis, d.decisions);
    if (readiness.verdict !== "READY" && readiness.verdict !== "READY_WITH_WARNINGS") out.runBlockers.push("readiness_" + readiness.verdict.toLowerCase());
    if (d.analysis.envKeys.some((k) => k.required)) out.runBlockers.push("environment_values_entry_not_supported_in_phase_2a");
    if (d.analysis.sensitiveFilesPresent.length) out.runBlockers.push("sensitive_files_in_archive_will_be_excluded");
    const rec = recommend({ analysis: d.analysis, traffic: d.options.traffic });
    out.minRamMb = rec.resources.ramMbMin;
    const cat = await this.o.reader.planCatalogue();
    out.catalogue = cat.ok
      ? { source: this.o.cfg.dataSource === "live" ? "live" : "simulated", unitsVerified: this.o.cfg.live.planUnits !== null, candidates: listCandidates(cat.data, this.o.cfg.live.planUnits, rec.resources.ramMbMin), notes: ["سازگاری پلن با پلتفرم در API مشخص نیست.", ...(this.o.cfg.live.planUnits ? [] : ["واحدها تأیید نشده؛ بدون تأیید اپراتور، نه هزینه نمایش داده می‌شود و نه ساخت مجاز است."])] }
      : { source: "unavailable", unitsVerified: false, candidates: [], notes: ["فهرست پلن‌ها خوانده نشد."] };
    out.proposals = await this.listForRun(runId, sessionId);
    out.locks = await this.lockingOperations(sessionId, runId);
    const open = out.proposals.find((v) => v.proposal.status === "PENDING" || v.proposal.status === "APPROVED")?.proposal ?? null;
    const flying = out.proposals.some((v) => v.operation && IN_FLIGHT.includes(v.operation.state));
    if (!flying) out.preflight = await this.cachedPreflight(runId, open ? { planId: open.planId, bundlePlanId: open.bundlePlanId, appName: open.appName, minRamMb: rec.resources.ramMbMin } : null, out.runBlockers, cat.ok ? cat.data : null);
    // Phase 2E: authorised EXISTING applications, their identity/domain checks and the two backends (read-only; skipped while an operation is in flight)
    let platform: string | null = null;
    try {
      const bp = buildPlan(d.analysis, readiness, rec, { appName: "preview-app" });
      platform = bp.ok ? bp.plan.params.platform : null;
    } catch {
      platform = null;
    }
    const exOps = out.proposals.map((v) => v.operation).filter((o): o is LiveOperationRecord => !!o);
    const exFlying = exOps.some((o) => IN_FLIGHT.includes(o.state));
    if (!exFlying) out.existing = await this.cachedExisting(runId, platform, out.runBlockers);
    const ops = out.proposals.map((v) => v.operation).filter((o): o is LiveOperationRecord => !!o);
    const latest = ops.at(-1);
    const hardBlocked = prerequisites.some((p) => p.blocking && !p.ok) || out.runBlockers.some((b) => !b.startsWith("sensitive_files"));
    if (latest && IN_FLIGHT.includes(latest.state)) out.uiState = "LIVE_IN_PROGRESS";
    else if (latest?.state === "DEPLOYED") out.uiState = "LIVE_VERIFIED";
    else if (latest && (latest.state === "FAILED" || latest.state === "NEEDS_OPERATOR_REVIEW")) out.uiState = "LIVE_FAILED";
    else out.uiState = hardBlocked ? (run.phase === "SIMULATION_COMPLETED" ? "SIMULATED" : "BLOCKED") : "READY_FOR_APPROVAL";
    if (out.existing) {
      const eo = exOps.filter((o) => o.kind === "deploy_existing_app").at(-1);
      const anyReady = out.existing.targets.some((t) => t.ready) && out.existing.backends.some((b) => b.ready) && !out.runBlockers.some((b) => !b.startsWith("sensitive_files"));
      out.existing.uiState = eo && IN_FLIGHT.includes(eo.state) ? "LIVE_IN_PROGRESS" : eo?.state === "DEPLOYED" ? "LIVE_VERIFIED" : eo && (eo.state === "FAILED" || eo.state === "NEEDS_OPERATOR_REVIEW") ? "LIVE_FAILED" : !anyReady ? (mode.kind === "simulation" ? "SIMULATED" : "BLOCKED") : "READY_FOR_APPROVAL";
    }
    return out;
  }

  /**
   * How may THIS session act on an operation's RECOVERY controls (re-verify / abandon / cancel)?
   *  - "owner": the session that created it.
   *  - "orphan": the owner's login session no longer exists (restart / expiry / new login), so nobody can ever act on it again. A different authenticated session
   *    of the same deployment and team may close it — explicitly (`adoptOrphan`), audited with both actor hashes. Approving or executing is NEVER transferred.
   *  - "other_session": its owner is still logged in elsewhere: the operation is shown (state only) but cannot be touched from here.
   */
  private recoveryAccess(op: LiveOperationRecord, sessionId: string): "owner" | "orphan" | "other_session" {
    if (op.ownerHash === ownerHashOf(sessionId)) return "owner";
    if (teamKey(op.teamId) !== teamKey(this.o.cfg.liara.teamId)) return "other_session"; // never across teams
    return this.o.isOwnerActive && !this.o.isOwnerActive(op.ownerHash) ? "orphan" : "other_session";
  }

  /**
   * Operations on this team that still hold a (team, app) slot but belong to ANOTHER run (typically: the page was reloaded or a new ZIP was analysed after an
   * earlier attempt ended in NEEDS_OPERATOR_REVIEW — and, because ownership follows the login session, usually under an older login). The store's lock is per
   * (team, app), not per run or session, so without this list the new run showed nothing yet every new proposal was refused as "already started", and the
   * recovery buttons were unreachable. Read-only. An operation owned by another LIVE session is reported as a stub (state only, no id, no actions).
   */
  private async lockingOperations(sessionId: string, runId: string): Promise<LockView[]> {
    const all = await this.o.store.listOperationsInStates(LIVE_STATES);
    const out: LockView[] = [];
    for (const op of all) {
      if (teamKey(op.teamId) !== teamKey(this.o.cfg.liara.teamId) || !isActiveOperation(op)) continue;
      const p = await this.o.store.getLiveProposal(op.proposalId);
      if (p?.runId === runId) continue; // already shown with its own run's proposals
      const access = this.recoveryAccess(op, sessionId);
      out.push({ access, appName: op.appName, state: op.state, createdAt: op.createdAt, operation: access === "other_session" ? null : op });
    }
    return out.sort((x, y) => x.createdAt.localeCompare(y.createdAt));
  }

  private exCache = new Map<string, { at: number; value: ExistingStatus }>();
  /** Reads (bounded, cached 30 s) the identity of every authorised existing app (≤ 6) and the readiness of both backends. Names and ids are never returned in full. */
  private async cachedExisting(runId: string, sourcePlatform: string | null, runBlockers: string[]): Promise<ExistingStatus> {
    void runBlockers;
    const key = `${runId}|${sourcePlatform}`;
    const hit = this.exCache.get(key);
    if (hit && this.now() - hit.at < 30_000) return structuredClone(hit.value);
    const hashHint = (s: string | null) => (s === null ? null : createHash("sha256").update(s).digest("hex").slice(0, 8));
    const backendView = (id: "api" | "cli"): ExistingBackendView => {
      const prerequisites = this.existingPrerequisites(id);
      const blockers = prerequisites.filter((x) => x.blocking && !x.ok).map((x) => x.id);
      return { id, isDefault: id === "api", ready: blockers.length === 0, blockers, prerequisites, cliVersion: id === "cli" ? this.o.cfg.cli.version : null };
    };
    const value: ExistingStatus = { targets: [], backends: [backendView("api"), backendView("cli")], readError: null, uiState: "BLOCKED" };
    const names = await this.o.reader.authorizedApps();
    if (!names.ok) value.readError = names.code;
    else {
      for (const name of names.data.names.slice(0, 6)) {
        const f = await this.existingFacts(name);
        if (f instanceof LiveError) {
          value.targets.push({ name, facts: null, expectedSuffix: null, checks: [], blocked: f.detail, ready: false });
          continue;
        }
        const checks = buildExistingChecks({ facts: f, sourcePlatform, config: { suffixes: this.o.cfg.live.appDomainSuffixes, healthPath: this.o.cfg.live.healthPath, healthMarker: this.o.cfg.live.healthMarker } });
        const blocked = checks.filter((k) => k.status === "blocked").map((k) => k.id);
        value.targets.push({ name, facts: { planId: f.planId, platform: f.platform, scale: f.scale, instanceHint: hashHint(f.instanceId), createdAt: f.createdAt, hasNetwork: f.networkId !== null, defaultSubdomain: f.defaultSubdomain, currentReleaseHint: hashHint(f.baseline.currentRelease), releaseTotal: f.baseline.total }, expectedSuffix: expectedDefaultSuffix(f.networkId), checks, blocked, ready: blocked.length === 0 });
      }
    }
    if (this.exCache.size > 50) this.exCache.clear();
    this.exCache.set(key, { at: this.now(), value: structuredClone(value) });
    return value;
  }

  private pfCache = new Map<string, { at: number; report: PreflightReport }>();
  /** status() may be polled: the (read-only) preflight is cached for 30 s per run so it cannot burn the request budget. Proposals/decisions never use the cache. */
  private async cachedPreflight(runId: string, sel: { planId: string | null; bundlePlanId: string | null; appName: string | null; minRamMb: number | null } | null, runBlockers: string[], cat: PlanProjection | null): Promise<PreflightReport> {
    const key = runId + JSON.stringify(sel);
    const hit = this.pfCache.get(key);
    if (hit && this.now() - hit.at < 30_000) return hit.report;
    const report = await this.runPreflight(sel, runBlockers, cat);
    if (this.pfCache.size > 50) this.pfCache.clear();
    this.pfCache.set(key, { at: this.now(), report });
    return report;
  }

  // ===================================================================================================== proposals
  private async ownedRun(runId: string, sessionId: string) {
    const r = await this.o.store.getAgentRun(runId);
    if (!r || r.ownerHash !== ownerHashOf(sessionId) || r.run.kind !== "deployment" || !r.run.deployment) throw new LiveError("live_not_found");
    return r.run;
  }

  /** Builds a LIVE proposal bound to the exact artifact, plan, team, network and cost picture. Re-upload of the ZIP is required (archives are never persisted). */
  createProposal(sessionId: string, req: { runId: string; planId: string; bundlePlanId?: string | null; appName: string; zip: Buffer }): Promise<LiveProposalView> {
    return this.serial(async () => {
      await this.recovered;
      const g = this.gate();
      if (!g.enabled || !this.o.transport) throw new LiveError("live_execution_disabled"); // creating an application is REST-only (the CLI backend never creates apps)
      const missing = this.prerequisites().filter((p) => p.blocking && !p.ok).map((p) => p.id);
      if (missing.length) throw new LiveError("live_prerequisite_missing", missing);
      const run = await this.ownedRun(req.runId, sessionId);
      const d = run.deployment!;
      if (run.status !== "READY" || !["READINESS_REVIEW", "SIMULATION_COMPLETED"].includes(run.phase)) throw new LiveError("live_invalid_state", [run.phase]);
      const readiness = buildReadiness(d.analysis, d.decisions);
      if (readiness.verdict !== "READY" && readiness.verdict !== "READY_WITH_WARNINGS") throw new LiveError("live_prerequisite_missing", ["readiness_" + readiness.verdict.toLowerCase()]);
      if (d.analysis.envKeys.some((k) => k.required)) throw new LiveError("live_prerequisite_missing", ["environment_values_entry_not_supported_in_phase_2a"]);
      const appName = (req.appName ?? "").trim().toLowerCase();
      if (!APP_NAME_REGEX.test(appName)) throw new LiveError("live_binding_mismatch", ["app_name_invalid"]);

      // ---- bind the ORIGINAL ZIP, the analysis and the generated artifact ----
      const zipSha256 = sha256(req.zip);
      if (!zipSha256.startsWith(d.project.artifactDigest32)) throw new LiveError("live_artifact_mismatch", ["zip_is_not_the_analysed_archive"]);
      const analysisDigest = sha256(canonicalJson(d.analysis));
      let fresh: ReturnType<typeof analyzeSource>;
      try {
        fresh = await withProject(req.zip, (t, s) => analyzeSource(t, s));
      } catch {
        throw new LiveError("live_artifact_rejected", ["analysis_failed"]);
      }
      if (sha256(canonicalJson(fresh)) !== analysisDigest) throw new LiveError("live_artifact_mismatch", ["analysis_differs"]);
      let art: ArtifactResult;
      try {
        art = await buildDeploymentArtifact(req.zip, { now: this.now });
      } catch (e) {
        throw new LiveError("live_artifact_rejected", [e instanceof ArtifactError ? e.code : "build_failed"]);
      }

      // ---- plan, cost, name ----
      const cat = await this.o.reader.planCatalogue();
      if (!cat.ok) throw new LiveError("live_plan_blocked", ["catalogue_unreadable:" + cat.code]);
      const rec = recommend({ analysis: d.analysis, traffic: d.options.traffic });
      const sel = selectPlan({ projection: cat.data, planId: req.planId, bundlePlanId: req.bundlePlanId ?? null, units: this.o.cfg.live.planUnits, minRamMb: rec.resources.ramMbMin });
      if (!sel.ok || !sel.bundlePlanId) throw new LiveError("live_plan_blocked", sel.blockers);
      const inv = await this.o.reader.appInventory(appName);
      if (!inv.ok) throw new LiveError("live_prerequisite_missing", ["name_unverifiable"]);
      if (inv.data.exists) throw new LiveError("live_duplicate_app");
      // ---- Phase 2B: the full preflight (units corroboration, network, team, balance, billing semantics). Any blocked check stops the proposal. ----
      const pf = await this.runPreflight({ planId: sel.plan!.id, bundlePlanId: sel.bundlePlanId, appName, minRamMb: rec.resources.ramMbMin }, [], cat.data, inv.data);
      const pfBlocked = pf.checks.filter((k) => k.status === "blocked").map((k) => k.id);
      if (pfBlocked.length) throw new LiveError("live_prerequisite_missing", pfBlocked);

      const plan = buildPlan(d.analysis, readiness, rec, { appName });
      if (!plan.ok) throw new LiveError("live_prerequisite_missing", ["plan_" + plan.refusal]);
      const platform = plan.plan.params.platform;
      if (!(LIVE_PLATFORMS as readonly string[]).includes(platform)) throw new LiveError("live_prerequisite_missing", ["platform_unsupported"]);

      const nowMs = this.now();
      const id = rid("lprop", nowMs);
      const operationId = rid("lop", nowMs);
      const content: LiveProposalContent = {
        id,
        kind: "create_new_app",
        backend: "api",
        cli: null,
        existing: null,
        operationId,
        runId: run.id,
        conversationId: run.conversationId,
        ownerHash: ownerHashOf(sessionId),
        teamId: g.teamId,
        appName,
        planId: sel.plan!.id,
        bundlePlanId: sel.bundlePlanId,
        networkId: g.networkId!,
        platform,
        artifact: { zipSha256, analysisDigest, artifactDigest: art.sha256, artifactBytes: art.size, fileCount: art.fileCount, format: art.format },
        config: { port: plan.plan.params.build.port, output: plan.plan.params.build.output, nodeRange: plan.plan.params.build.nodeRange, buildInvocation: plan.plan.params.build.buildInvocation, startInvocation: plan.plan.params.build.startInvocation },
        envKeys: [],
        financial: sel.financial,
        executionMode: "live",
        environment: "live",
        confirmation: "type_app_name",
        stateFingerprint: liveFingerprint({ teamId: g.teamId, appName, planId: sel.plan!.id, bundlePlanId: sel.bundlePlanId, networkId: g.networkId!, zipSha256, artifactDigest: art.sha256, unitsVerifiedAt: this.o.cfg.live.planUnits?.verifiedAt ?? null, nameAbsent: true, planAvailable: true, preflightSig: preflightSig(pf) }),
        createdAt: new Date(nowMs).toISOString(),
        expiresAt: new Date(nowMs + LIVE_APPROVAL_TTL_MS).toISOString(),
      };
      const proposal: LiveProposal = { ...content, digest: liveDigest(content), status: "PENDING" };
      const op: LiveOperationRecord = {
        id: operationId,
        kind: "create_new_app",
        backend: "api",
        proposalId: id,
        ownerHash: content.ownerHash,
        teamId: g.teamId,
        appName,
        planId: content.planId,
        platform,
        state: "AWAITING_LIVE_APPROVAL",
        createdAt: content.createdAt,
        updatedAt: content.createdAt,
        steps: freshSteps(),
        remote: { appConfirmed: null, sourceId: null, releaseId: null },
        ladder: { ...EMPTY_LADDER },
        failure: null,
        recoveryFa: [],
        transitions: [
          { at: content.createdAt, from: null, to: "PREFLIGHT", note: "preflight_passed" },
          { at: content.createdAt, from: "PREFLIGHT", to: "AWAITING_LIVE_APPROVAL", note: null },
        ],
      };
      const r = await this.o.store.createLiveProposal(proposal, op);
      if (!r.created) throw new LiveError(r.reason === "pending_exists" ? "live_proposal_pending" : "live_duplicate_app");
      await this.audit(run.id, "proposal_created", { proposalId: id, operationId, app: appName, plan: content.planId, team: g.teamId ? "team" : "personal", digest12: proposal.digest.slice(0, 12), expiresAt: proposal.expiresAt, actor: shortHash(sessionId) });
      return { proposal, approvals: [], operation: op };
    });
  }

  private async view(id: string): Promise<LiveProposalView> {
    const proposal = (await this.o.store.getLiveProposal(id))!;
    return { proposal, approvals: await this.o.store.listLiveApprovals(id), operation: await this.o.store.getOperationByProposal(id) };
  }

  async getProposalView(proposalId: string, sessionId: string): Promise<LiveProposalView> {
    await this.expireIfDue(proposalId);
    const p = await this.o.store.getLiveProposal(proposalId);
    if (!p || p.ownerHash !== ownerHashOf(sessionId)) throw new LiveError("live_not_found");
    return this.view(proposalId);
  }
  async listForRun(runId: string, sessionId: string): Promise<LiveProposalView[]> {
    await this.ownedRun(runId, sessionId);
    const ps = await this.o.store.listLiveProposals(runId);
    for (const p of ps) await this.expireIfDue(p.id);
    return Promise.all(ps.map((p) => this.view(p.id)));
  }

  /** Lazy expiry, exactly once; the operation is cancelled with it so the (team, app) slot is released. */
  async expireIfDue(proposalId: string): Promise<boolean> {
    const p = await this.o.store.getLiveProposal(proposalId);
    if (!p || p.status !== "PENDING" || p.expiresAt > this.iso()) return false;
    const t = await this.o.store.transitionLiveProposal(proposalId, "EXPIRED", this.iso());
    if (!t.changed) return false;
    await this.cancelOperationOf(p, "approval_expired");
    await this.audit(p.runId, "proposal_expired", { proposalId });
    return true;
  }
  private async cancelOperationOf(p: LiveProposal, note: string) {
    const op = await this.o.store.getOperation(p.operationId);
    if (op && op.state === "AWAITING_LIVE_APPROVAL") await this.o.store.updateOperation({ ...op, state: "CANCELLED", updatedAt: this.iso(), transitions: [...op.transitions, { at: this.iso(), from: "AWAITING_LIVE_APPROVAL", to: "CANCELLED", note }] }, "AWAITING_LIVE_APPROVAL");
  }

  private async recomputeFingerprint(p: LiveProposal): Promise<string | null> {
    if (p.kind === "deploy_existing_app") return this.existingFingerprint(p);
    const cat = await this.o.reader.planCatalogue();
    if (!cat.ok) return null;
    const plan = cat.data.plans.find((x) => x.id === p.planId);
    const bundles = (cat.data.bundles[p.planId] ?? []).some((b) => b.id === p.bundlePlanId && b.available === true);
    const inv = await this.o.reader.appInventory(p.appName);
    if (!inv.ok || inv.data.exists === null) return null;
    const pf = await this.runPreflight({ planId: p.planId, bundlePlanId: p.bundlePlanId, appName: p.appName, minRamMb: null }, [], cat.data, inv.data);
    return liveFingerprint({ teamId: this.o.cfg.liara.teamId, appName: p.appName, planId: p.planId, bundlePlanId: p.bundlePlanId, networkId: this.o.cfg.live.networkId ?? "", zipSha256: p.artifact.zipSha256, artifactDigest: p.artifact.artifactDigest, unitsVerifiedAt: this.o.cfg.live.planUnits?.verifiedAt ?? null, nameAbsent: !inv.data.exists, planAvailable: plan?.available === true && bundles, preflightSig: preflightSig(pf) });
  }

  /** Phase 2B: read-only preflight (see `gatherPreflight`). Creates nothing; the report holds classes, never amounts or names. */
  runPreflight(sel: PreflightSelection | null, runBlockers: string[] = [], cat?: PlanProjection | null, inv?: { count: number; exists: boolean | null } | null): Promise<PreflightReport> {
    return gatherPreflight({ reader: this.o.reader, cfg: this.o.cfg, nowIso: this.iso(), sel, runBlockers, cat, inv });
  }


  // ===================================================================================================== Phase 2D: deploy to an EXISTING application
  /** What an existing-app release needs. No plan units, no network, no billing semantics: nothing is created and the plan is not touched. */
  existingPrerequisites(backend: "api" | "cli"): Prerequisite[] {
    const c = this.o.cfg;
    const p = (id: string, ok: boolean, detail: string, blocking = true): Prerequisite => ({ id, ok, blocking, detail });
    const base: Prerequisite[] = [
      p("live_flag", c.live.enabled, c.live.enabled ? "اجرای واقعی در پیکربندی فعال شده است (شرط لازم، نه کافی)." : "اجرای واقعی خاموش است — حالت پیش‌فرض."),
      p("data_source_live", c.dataSource === "live", c.dataSource === "live" ? "منبع داده: لیارای واقعی." : "منبع داده شبیه‌سازی است."),
      p("token", !!c.liara.token, c.liara.token ? "توکن پیکربندی شده است (مقدار نمایش داده نمی‌شود)." : "توکن لیارا پیکربندی نشده است."),
      p("app_domain_suffix", c.live.appDomainSuffixes.length > 0, c.live.appDomainSuffixes.length ? "دامنهٔ بررسی سلامت HTTP تعیین شده است." : "دامنهٔ بررسی سلامت پیکربندی نشده؛ بدون آن «DEPLOYED» اعلام نمی‌شود."),
      p("health_marker", !!c.live.healthMarker, c.live.healthMarker ? "نشانگر سلامت قطعی تنظیم شده است." : "نشانگر سلامت قطعی تنظیم نشده است."),
    ];
    if (backend === "api") {
      base.push(p("write_transport", this.o.transport !== null, this.o.transport ? "مسیر نوشتن REST آماده است." : "مسیر نوشتن REST ساخته نشده است."));
      base.push(p("contract_attested", c.live.contractAttested, c.live.contractAttested ? "فیلدهای فقط‌CLI نسخه (platformConfig، build.cache) توسط اپراتور تأیید شده‌اند." : "فیلدهای ساخت نسخه که فقط در CLI رسمی دیده شده‌اند تأیید نشده‌اند (LIARA_LIVE_CONTRACT_ATTESTED)."));
    } else {
      const id = this.o.cliBackend?.verifyIdentity();
      base.push(p("cli_backend_enabled", !!this.o.cliBackend, this.o.cliBackend ? "بک‌اند CLI فعال و پین‌شده است." : "بک‌اند CLI رسمی فعال نیست (LIARA_CLI_ENABLED و پین ابزار)."));
      base.push(p("cli_identity_verified", !!id?.ok, id?.ok ? `هویت ابزار تأیید شد (نسخه ${id.identity.version}).` : `هویت CLI تأیید نشد${id && !id.ok ? ` (${id.code})` : ""}.`));
    }
    return base;
  }

  /** Same safe pipeline as a new-app proposal: the ORIGINAL ZIP, the analysis and the generated artifact are bound by digest. */
  private async bindSource(run: Awaited<ReturnType<LiveDeploymentService["ownedRun"]>>, zip: Buffer) {
    const d = run.deployment!;
    if (run.status !== "READY" || !["READINESS_REVIEW", "SIMULATION_COMPLETED"].includes(run.phase)) throw new LiveError("live_invalid_state", [run.phase]);
    const readiness = buildReadiness(d.analysis, d.decisions);
    if (readiness.verdict !== "READY" && readiness.verdict !== "READY_WITH_WARNINGS") throw new LiveError("live_prerequisite_missing", ["readiness_" + readiness.verdict.toLowerCase()]);
    if (d.analysis.envKeys.some((k) => k.required)) throw new LiveError("live_prerequisite_missing", ["environment_values_entry_not_supported_in_phase_2a"]);
    const zipSha256 = sha256(zip);
    if (!zipSha256.startsWith(d.project.artifactDigest32)) throw new LiveError("live_artifact_mismatch", ["zip_is_not_the_analysed_archive"]);
    const analysisDigest = sha256(canonicalJson(d.analysis));
    let fresh: ReturnType<typeof analyzeSource>;
    try {
      fresh = await withProject(zip, (t, s) => analyzeSource(t, s));
    } catch {
      throw new LiveError("live_artifact_rejected", ["analysis_failed"]);
    }
    if (sha256(canonicalJson(fresh)) !== analysisDigest) throw new LiveError("live_artifact_mismatch", ["analysis_differs"]);
    let art: ArtifactResult;
    try {
      art = await buildDeploymentArtifact(zip, { now: this.now });
    } catch (e) {
      throw new LiveError("live_artifact_rejected", [e instanceof ArtifactError ? e.code : "build_failed"]);
    }
    const rec = recommend({ analysis: d.analysis, traffic: d.options.traffic });
    return { d, readiness, zipSha256, analysisDigest, art, rec };
  }

  /**
   * Reads what the approval will bind about the EXISTING application INSTANCE: name, plan, platform, scale, instance id, creation time, network, default-subdomain
   * flag and the release baseline. Read-only; creates and changes nothing. Hard preconditions return a typed error.
   */
  private async existingFacts(appName: string): Promise<(ExistingFacts & { planId: string }) | LiveError> {
    const inv = await this.o.reader.appInventory(appName);
    if (!inv.ok) return new LiveError("live_prerequisite_missing", ["name_unverifiable"]);
    if (inv.data.exists !== true) return new LiveError("live_prerequisite_missing", ["existing_app_missing"]);
    if (!this.o.reader.inScope(appName)) return new LiveError("live_prerequisite_missing", ["existing_app_not_in_scope"]); // the OPERATOR must allowlist it; a release never widens the scope
    const id = await this.o.reader.appIdentity(appName);
    if (!id.ok || id.data.name !== appName) return new LiveError("live_prerequisite_missing", ["existing_identity_unverified"]);
    if (id.data.scale !== 1) return new LiveError("live_prerequisite_missing", ["existing_app_not_running"]);
    if (!id.data.planId || !/^[A-Za-z0-9][A-Za-z0-9_.-]{0,59}$/.test(id.data.planId)) return new LiveError("live_prerequisite_missing", ["existing_plan_unknown"]);
    const base = await this.o.reader.releaseBaseline(appName);
    if (!base.ok) return new LiveError("live_prerequisite_missing", ["release_baseline_unreadable"]);
    return { name: appName, planId: id.data.planId, platform: id.data.platform, scale: 1, instanceId: id.data.instanceId, createdAt: id.data.createdAt, networkId: id.data.networkId, defaultSubdomain: id.data.defaultSubdomain, baseline: { currentRelease: base.data.currentRelease, total: base.data.total } };
  }

  private existingSig(backend: "api" | "cli", facts: ExistingFacts, cli: { version: string; entrySha256: string } | null): string {
    return `existing|${backend}|inscope|${cli ? `${cli.version}:${cli.entrySha256.slice(0, 16)}` : "no-cli"}|${existingSignature(facts)}`;
  }

  private async existingFingerprint(p: LiveProposal): Promise<string | null> {
    const f = await this.existingFacts(p.appName);
    if (f instanceof LiveError || f.planId !== p.planId || (f.platform !== null && f.platform !== p.platform)) return null;
    return liveFingerprint({ teamId: this.o.cfg.liara.teamId, appName: p.appName, planId: p.planId, bundlePlanId: "existing", networkId: "existing", zipSha256: p.artifact.zipSha256, artifactDigest: p.artifact.artifactDigest, unitsVerifiedAt: null, nameAbsent: false, planAvailable: true, preflightSig: this.existingSig(p.backend, f, p.backend === "cli" ? this.cliIdentity() : null) });
  }

  /**
   * Builds a LIVE proposal to release the approved source to an application that ALREADY EXISTS (e.g. one created by hand in the console). It never creates the
   * application, never changes its plan/network, and never adds it to the scope (the operator must have allowlisted it). `backend` selects who performs the two
   * write calls: `api` (typed REST) or `cli` (official CLI behind the restricted runner). Nothing is sent by this method.
   */
  createExistingProposal(sessionId: string, req: { runId: string; appName: string; backend: "api" | "cli"; zip: Buffer }): Promise<LiveProposalView> {
    return this.serial(async () => {
      await this.recovered;
      const g = this.gate();
      if (!g.enabled) throw new LiveError("live_execution_disabled");
      if (req.backend !== "api" && req.backend !== "cli") throw new LiveError("live_binding_mismatch", ["backend"]);
      const missing = this.existingPrerequisites(req.backend).filter((x) => x.blocking && !x.ok).map((x) => x.id);
      if (missing.length) throw new LiveError("live_prerequisite_missing", missing);
      const run = await this.ownedRun(req.runId, sessionId);
      const appName = (req.appName ?? "").trim().toLowerCase();
      if (!APP_NAME_REGEX.test(appName)) throw new LiveError("live_binding_mismatch", ["app_name_invalid"]);
      const { d, zipSha256, analysisDigest, art } = await this.bindSource(run, req.zip);
      const facts = await this.existingFacts(appName);
      if (facts instanceof LiveError) throw facts;
      const rec = recommend({ analysis: d.analysis, traffic: d.options.traffic });
      const plan = buildPlan(d.analysis, buildReadiness(d.analysis, d.decisions), rec, { appName });
      if (!plan.ok) throw new LiveError("live_prerequisite_missing", ["plan_" + plan.refusal]);
      const platform = plan.plan.params.platform;
      if (!(LIVE_PLATFORMS as readonly string[]).includes(platform)) throw new LiveError("live_prerequisite_missing", ["platform_unsupported"]);
      // the release type must be the platform of the EXISTING app (the official CLI takes it from the project); a reported mismatch is never "fixed" by guessing
      if (facts.platform !== null && facts.platform !== platform) throw new LiveError("live_prerequisite_missing", ["existing_platform_mismatch"]);
      // instance identity, default address, domain suffix, probe host and a SPECIFIC health marker must all be valid, or the release could never be verified
      const exChecks = buildExistingChecks({ facts, sourcePlatform: platform, config: { suffixes: this.o.cfg.live.appDomainSuffixes, healthPath: this.o.cfg.live.healthPath, healthMarker: this.o.cfg.live.healthMarker } });
      const exBlocked = exChecks.filter((k) => k.status === "blocked").map((k) => k.id);
      if (exBlocked.length) throw new LiveError("live_prerequisite_missing", exBlocked);

      const nowMs = this.now();
      const id = rid("lprop", nowMs);
      const operationId = rid("lop", nowMs);
      let cli: LiveProposalContent["cli"] = null;
      if (req.backend === "cli") {
        const ident = this.o.cliBackend!.verifyIdentity();
        if (!ident.ok) throw new LiveError("live_prerequisite_missing", [ident.code]);
        let manifest;
        try {
          manifest = await materializeApprovedSource(req.zip, null, { now: this.now });
        } catch (e) {
          throw new LiveError("live_artifact_rejected", [e instanceof ArtifactError ? e.code : "manifest_failed"]);
        }
        cli = { version: ident.identity.version, entrySha256: ident.identity.entrySha256, argvDigest: argvTemplateDigest({ app: appName, platform, port: plan.plan.params.build.port, teamId: g.teamId, message: `agent-op-${operationId}` }), manifestDigest: manifest.digest };
      }
      const content: LiveProposalContent = {
        id,
        kind: "deploy_existing_app",
        backend: req.backend,
        cli,
        existing: bindingOf(facts),
        operationId,
        runId: run.id,
        conversationId: run.conversationId,
        ownerHash: ownerHashOf(sessionId),
        teamId: g.teamId,
        appName,
        planId: facts.planId,
        bundlePlanId: "existing", // not applicable: the existing app's own plan, bundle and network are never touched
        networkId: "existing",
        platform,
        artifact: { zipSha256, analysisDigest, artifactDigest: art.sha256, artifactBytes: art.size, fileCount: art.fileCount, format: art.format },
        config: { port: plan.plan.params.build.port, output: plan.plan.params.build.output, nodeRange: plan.plan.params.build.nodeRange, buildInvocation: plan.plan.params.build.buildInvocation, startInvocation: plan.plan.params.build.startInvocation },
        envKeys: [],
        financial: {
          unitsVerified: false,
          planId: facts.planId,
          resource: { ramAmount: null, cpuAmount: null, volume: null, price: null, ramUnit: null, cpuUnit: null, priceUnit: null },
          estimate: null,
          requiredBalance: null,
          knownOtherCosts: ["پلن و هزینهٔ برنامهٔ موجود تغییر نمی‌کند؛ ساخت نسخه، برنامه یا پلن جدیدی نمی‌سازد."],
          unknownCostComponents: ["هزینهٔ build و ترافیک در منابع رسمی مشخص نشده است", "سقف تعداد استقرار روزانهٔ بستهٔ امکانات (مثلاً ۲۰ در روز برای پایه) مصرف می‌شود"],
        },
        executionMode: "live",
        environment: "live",
        confirmation: "type_app_name",
        stateFingerprint: liveFingerprint({ teamId: g.teamId, appName, planId: facts.planId, bundlePlanId: "existing", networkId: "existing", zipSha256, artifactDigest: art.sha256, unitsVerifiedAt: null, nameAbsent: false, planAvailable: true, preflightSig: this.existingSig(req.backend, facts, cli ? { version: cli.version, entrySha256: cli.entrySha256 } : null) }),
        createdAt: new Date(nowMs).toISOString(),
        expiresAt: new Date(nowMs + LIVE_APPROVAL_TTL_MS).toISOString(),
      };
      const proposal: LiveProposal = { ...content, digest: liveDigest(content), status: "PENDING" };
      const op: LiveOperationRecord = {
        id: operationId,
        kind: "deploy_existing_app",
        backend: req.backend,
        proposalId: id,
        ownerHash: content.ownerHash,
        teamId: g.teamId,
        appName,
        planId: content.planId,
        platform,
        state: "AWAITING_LIVE_APPROVAL",
        createdAt: content.createdAt,
        updatedAt: content.createdAt,
        steps: freshSteps(),
        remote: { appConfirmed: null, sourceId: null, releaseId: null },
        ladder: { ...EMPTY_LADDER },
        failure: null,
        recoveryFa: [],
        transitions: [
          { at: content.createdAt, from: null, to: "PREFLIGHT", note: "preflight_passed" },
          { at: content.createdAt, from: "PREFLIGHT", to: "AWAITING_LIVE_APPROVAL", note: null },
        ],
      };
      const r = await this.o.store.createLiveProposal(proposal, op);
      if (!r.created) throw new LiveError(r.reason === "pending_exists" ? "live_proposal_pending" : "live_operation_in_progress");
      await this.audit(run.id, "proposal_created", { proposalId: id, operationId, kind: content.kind, backend: content.backend, app: appName, team: g.teamId ? "team" : "personal", digest12: proposal.digest.slice(0, 12), expiresAt: proposal.expiresAt, actor: shortHash(sessionId), cliVersion: cli?.version ?? null, argvDigest12: cli?.argvDigest.slice(0, 12) ?? null, manifestDigest12: cli?.manifestDigest.slice(0, 12) ?? null });
      return { proposal, approvals: [], operation: op };
    });
  }

  /**
   * OFFLINE PREVIEW of an existing-app release (UX: "what exactly would be approved?"). It runs the SAME artifact binding as `createExistingProposal` — the
   * original ZIP must be the analysed archive, the analysis must reproduce, the deterministic artifact is built — but it persists NOTHING (no proposal, no
   * operation, no approval), needs neither the live flag nor the attestation, and contacts no write endpoint. Target facts come from the read-only reader and
   * only when the data source is live; otherwise they are reported as not checked. `executable` is always derived from the real gate: a preview never
   * authorises anything, and the digests it shows are NOT an approval.
   */
  async previewExisting(sessionId: string, req: { runId: string; appName: string; backend: "api" | "cli"; zip: Buffer }): Promise<ExistingPreview> {
    await this.recovered;
    if (req.backend !== "api" && req.backend !== "cli") throw new LiveError("live_binding_mismatch", ["backend"]);
    const appName = (req.appName ?? "").trim().toLowerCase();
    if (!APP_NAME_REGEX.test(appName)) throw new LiveError("live_binding_mismatch", ["app_name_invalid"]);
    const run = await this.ownedRun(req.runId, sessionId);
    const { d, zipSha256, analysisDigest, art, readiness } = await this.bindSource(run, req.zip);
    const rec = recommend({ analysis: d.analysis, traffic: d.options.traffic });
    const plan = buildPlan(d.analysis, readiness, rec, { appName });
    const platform = plan.ok ? plan.plan.params.platform : null;
    const prerequisites = this.existingPrerequisites(req.backend);
    const executionBlockers = prerequisites.filter((x) => x.blocking && !x.ok).map((x) => x.id);
    let target: ExistingPreview["target"] = { checked: false, reason: this.o.cfg.dataSource === "live" ? null : "data_source_not_live", facts: null, checks: [], blocked: [] };
    if (this.o.cfg.dataSource === "live") {
      const facts = await this.existingFacts(appName);
      if (facts instanceof LiveError) target = { checked: true, reason: null, facts: null, checks: [], blocked: facts.detail };
      else {
        const checks = buildExistingChecks({ facts, sourcePlatform: platform, config: { suffixes: this.o.cfg.live.appDomainSuffixes, healthPath: this.o.cfg.live.healthPath, healthMarker: this.o.cfg.live.healthMarker } });
        const blocked = checks.filter((k) => k.status === "blocked").map((k) => k.id);
        if (platform && facts.platform !== null && facts.platform !== platform) blocked.push("existing_platform_mismatch");
        target = { checked: true, reason: null, facts: { planId: facts.planId, platform: facts.platform, scale: facts.scale, hasNetwork: facts.networkId !== null, defaultSubdomain: facts.defaultSubdomain, releaseTotal: facts.baseline.total }, checks, blocked };
      }
    }
    const targetReady = target.checked && target.blocked.length === 0;
    await this.audit(run.id, "preview_created", { kind: "deploy_existing_app", backend: req.backend, app: appName, zip12: zipSha256.slice(0, 12), actor: shortHash(sessionId), targetChecked: target.checked, targetReady, executionBlockers });
    return {
      appName,
      backend: req.backend,
      platform,
      artifact: { zipSha256, analysisDigest, artifactDigest: art.sha256, artifactBytes: art.size, fileCount: art.fileCount, format: art.format },
      config: plan.ok ? { port: plan.plan.params.build.port, output: plan.plan.params.build.output, nodeRange: plan.plan.params.build.nodeRange } : null,
      target,
      targetReady,
      prerequisites,
      executionBlockers,
      executable: targetReady && executionBlockers.length === 0 && this.gate().enabled,
      persisted: false,
      note: "preview_only_not_an_approval",
    };
  }

  // ===================================================================================================== decision
  /**
   * Server-side validation of a LIVE decision. A simulation proposal id/digest is refused outright; the client sends no "approved" flag; nothing but
   * a human click with the exact digest and the typed application name can authorise — and the authorisation is scoped "live" and single-use.
   */
  async decide(proposalId: string, sessionId: string, req: { decision: unknown; digest: unknown; confirmAppName?: unknown; acknowledgeFinancial?: unknown }): Promise<LiveProposalView> {
    await this.recovered;
    if (typeof proposalId === "string" && proposalId.startsWith("prop_")) throw new LiveError("live_simulation_approval_rejected"); // simulation ids are never valid here
    if (req.decision !== "approve" && req.decision !== "reject") throw new LiveError("live_binding_mismatch", ["decision"]);
    if (typeof req.digest !== "string" || !/^[0-9a-f]{64}$/.test(req.digest)) throw new LiveError("live_digest_mismatch");
    const owner = ownerHashOf(sessionId);
    const p = await this.o.store.getLiveProposal(proposalId);
    if (!p || p.ownerHash !== owner) throw new LiveError("live_not_found");
    const rec = (decision: "approve" | "reject", outcome: LiveApprovalRecord["outcome"]): LiveApprovalRecord => ({ id: rid("laprv", this.now()), proposalId, operationId: p.operationId, decision, actorHash: owner, decidedAt: this.iso(), digest12: p.digest.slice(0, 12), outcome, scope: "live" });
    if (p.status !== "PENDING") {
      await this.audit(p.runId, "decision_replayed", { proposalId, status: p.status, actor: shortHash(sessionId) });
      throw new LiveError("live_already_decided");
    }
    if (await this.expireIfDue(proposalId)) throw new LiveError("live_expired");
    const block = async (outcome: LiveApprovalRecord["outcome"], err: LiveError, event: string) => {
      const t = await this.o.store.transitionLiveProposal(proposalId, "BLOCKED", this.iso(), rec(req.decision as "approve" | "reject", outcome));
      if (t.changed) {
        await this.cancelOperationOf(p, event);
        await this.audit(p.runId, event, { proposalId });
      }
      throw err;
    };
    if (!digestsEqual(liveDigest(contentOfLive(p)), p.digest)) return block("blocked_policy", new LiveError("live_tampered"), "proposal_tampered");
    if (!digestsEqual(req.digest, p.digest)) {
      await this.audit(p.runId, "digest_mismatch", { proposalId, actor: shortHash(sessionId) });
      throw new LiveError("live_digest_mismatch"); // stays PENDING: a wrong digest can neither burn nor authorise
    }
    if (p.executionMode !== "live" || p.environment !== "live") return block("blocked_policy", new LiveError("live_simulation_approval_rejected"), "proposal_blocked_policy");

    if (req.decision === "reject") {
      const t = await this.o.store.transitionLiveProposal(proposalId, "REJECTED", this.iso(), rec("reject", "rejected"));
      if (!t.changed) throw new LiveError(t.status === "EXPIRED" ? "live_expired" : "live_already_decided");
      await this.cancelOperationOf(p, "rejected_by_operator");
      await this.audit(p.runId, "proposal_rejected", { proposalId, actor: shortHash(sessionId) });
      return this.view(proposalId);
    }

    // ---- approve: current prerequisites, exact bindings, typed name, drift ----
    const g = this.gate();
    const missing = (p.kind === "create_new_app" ? this.prerequisites() : this.existingPrerequisites(p.backend)).filter((x) => x.blocking && !x.ok).map((x) => x.id);
    if (!g.enabled) return block("blocked_policy", new LiveError("live_execution_disabled"), "proposal_blocked_policy");
    if (missing.length) return block("blocked_policy", new LiveError("live_prerequisite_missing", missing), "proposal_blocked_policy");
    if (p.teamId !== g.teamId || (p.kind === "create_new_app" && p.networkId !== g.networkId)) return block("blocked_policy", new LiveError("live_binding_mismatch", ["team_or_network"]), "proposal_blocked_binding");
    if (req.confirmAppName !== p.appName) throw new LiveError("live_confirmation_required");
    // Phase 2B: explicit FINANCIAL acknowledgment (the figures and the listed unknowns are in the proposal the operator just read)
    if (p.kind === "create_new_app" && req.acknowledgeFinancial !== true) throw new LiveError("live_confirmation_required", ["financial_acknowledgment"]); // a release to an existing app creates no new cost line
    const fp = await this.recomputeFingerprint(p);
    if (fp === null || fp !== p.stateFingerprint) return block("blocked_drift", new LiveError("live_blocked_drift"), "proposal_blocked_drift");
    const t = await this.o.store.transitionLiveProposal(proposalId, "APPROVED", this.iso(), rec("approve", "accepted")); // atomic, single use
    if (!t.changed) throw new LiveError(t.status === "EXPIRED" ? "live_expired" : "live_already_decided");
    await this.audit(p.runId, "proposal_approved", { proposalId, operationId: p.operationId, app: p.appName, team: p.teamId ? "team" : "personal", digest12: p.digest.slice(0, 12), actor: shortHash(sessionId), scope: "live", financialAcknowledged: true, unitsVerified: p.financial.unitsVerified, unknownCostComponents: p.financial.unknownCostComponents.length });
    return this.view(proposalId);
  }

  // ===================================================================================================== execution
  /**
   * Starts the REAL deployment of an approved proposal. The operator re-uploads the ZIP (it is never stored); its SHA-256 and the regenerated artifact digest
   * must equal the approved ones. The proposal is consumed atomically (single use) and the executor runs in the background; poll `getOperation`.
   */
  async execute(proposalId: string, sessionId: string, zip: Buffer): Promise<LiveOperationRecord> {
    await this.recovered;
    if (typeof proposalId === "string" && proposalId.startsWith("prop_")) throw new LiveError("live_simulation_approval_rejected");
    if (!this.executor) throw new LiveError("live_execution_disabled");
    const p = await this.o.store.getLiveProposal(proposalId);
    if (!p || p.ownerHash !== ownerHashOf(sessionId)) throw new LiveError("live_not_found");
    if (p.status !== "APPROVED") throw new LiveError("live_not_approved");
    if (!digestsEqual(liveDigest(contentOfLive(p)), p.digest)) throw new LiveError("live_tampered");
    const g = this.gate();
    if (!g.enabled) throw new LiveError("live_execution_disabled");
    if (sha256(zip) !== p.artifact.zipSha256) throw new LiveError("live_artifact_mismatch", ["zip_sha256"]);
    let art: ArtifactResult;
    try {
      art = await buildDeploymentArtifact(zip, { now: this.now });
    } catch (e) {
      throw new LiveError("live_artifact_rejected", [e instanceof ArtifactError ? e.code : "build_failed"]);
    }
    if (art.sha256 !== p.artifact.artifactDigest) throw new LiveError("live_artifact_mismatch", ["artifact_digest"]);
    const cur = await this.o.store.getOperation(p.operationId);
    if (!cur) throw new LiveError("live_not_found");
    const nowIso = this.iso();
    const approvedOp: LiveOperationRecord = { ...cur, state: "APPROVED", updatedAt: nowIso, transitions: [...cur.transitions, { at: nowIso, from: "AWAITING_LIVE_APPROVAL", to: "APPROVED", note: "execution_claimed" }] };
    const r = await this.o.store.beginExecution(approvedOp, nowIso); // atomic: proposal APPROVED→CONSUMED + operation →APPROVED
    if (!r.started) {
      if (r.reason === "expired") {
        await this.o.store.updateOperation({ ...cur, state: "CANCELLED", updatedAt: nowIso, transitions: [...cur.transitions, { at: nowIso, from: "AWAITING_LIVE_APPROVAL", to: "CANCELLED", note: "approval_expired_before_execution" }] }, "AWAITING_LIVE_APPROVAL");
        throw new LiveError("live_expired");
      }
      throw new LiveError(r.reason === "operation_not_awaiting" ? "live_operation_in_progress" : "live_not_approved");
    }
    await this.audit(p.runId, "execution_claimed", { operationId: cur.id, app: p.appName, digest12: p.digest.slice(0, 12) });
    // background: never throws into the request; any unexpected error leaves the operation under review (never a retry)
    void this.executor.run(approvedOp, { artifact: art.bytes, zip }).catch(async (e) => {
      log("error", "live.run_unexpected", { name: (e as { name?: string })?.name, code: (e as { code?: string })?.code });
      await this.markReview(cur.id, "interrupted_by_restart");
    });
    return approvedOp;
  }

  private async markReview(opId: string, code: string) {
    const op = await this.o.store.getOperation(opId);
    if (!op || LIVE_TERMINAL.includes(op.state) || op.state === "NEEDS_OPERATOR_REVIEW" || op.state === "AWAITING_LIVE_APPROVAL") return;
    const step = op.state === "UPLOADING_SOURCE" ? "upload_source" : op.state === "CREATING_RELEASE" ? "create_release" : op.state === "VERIFYING_DEPLOYMENT" ? "verify_deployment" : "create_application";
    await this.o.store.updateOperation(
      { ...op, state: "NEEDS_OPERATOR_REVIEW", updatedAt: this.iso(), failure: { code, step, messageFa: "عملیات بدون نتیجهٔ قطعی متوقف شد؛ وضعیت واقعی را در کنسول لیارا بررسی کنید." }, recoveryFa: ["هیچ درخواست نوشتنی خودکار تکرار نمی‌شود.", "در کنسول لیارا وضعیت برنامه و نسخه‌ها را ببینید، سپس «بررسی دوبارهٔ وضعیت» یا «رها کردن» را بزنید."], transitions: [...op.transitions, { at: this.iso(), from: op.state, to: "NEEDS_OPERATOR_REVIEW", note: code }] },
      op.state,
    );
  }

  async getOperation(opId: string, sessionId: string): Promise<LiveOperationRecord> {
    const op = await this.o.store.getOperation(opId);
    if (!op || op.ownerHash !== ownerHashOf(sessionId)) throw new LiveError("live_not_found");
    return op;
  }

  /** Owner, or — only for recovery controls and only with explicit `adoptOrphan` — a session acting on an operation whose owner session is gone. Never for approve/execute. */
  private async operationForRecovery(opId: string, sessionId: string, adoptOrphan: boolean, action: string): Promise<LiveOperationRecord> {
    const op = await this.o.store.getOperation(opId);
    if (!op) throw new LiveError("live_not_found");
    const access = this.recoveryAccess(op, sessionId);
    if (access === "owner") return op;
    if (access === "orphan" && adoptOrphan) {
      await this.audit(null, "operation_recovery_by_other_session", { operationId: op.id, action, actor: shortHash(sessionId), previousOwner: op.ownerHash.slice(0, 8), state: op.state });
      return op;
    }
    throw new LiveError("live_not_found"); // fail closed: indistinguishable from "does not exist"
  }

  /** Cancellation is only possible BEFORE anything remote has been attempted. */
  async cancel(opId: string, sessionId: string, adoptOrphan = false): Promise<LiveOperationRecord> {
    const op = await this.operationForRecovery(opId, sessionId, adoptOrphan, "cancel");
    if (op.state !== "AWAITING_LIVE_APPROVAL" && op.state !== "APPROVED") throw new LiveError("live_invalid_state", [op.state]);
    const nowIso = this.iso();
    const next = { ...op, state: "CANCELLED" as const, updatedAt: nowIso, transitions: [...op.transitions, { at: nowIso, from: op.state, to: "CANCELLED" as const, note: "cancelled_by_operator" }] };
    if (!(await this.o.store.updateOperation(next, op.state))) throw new LiveError("live_invalid_state", ["raced"]);
    // a PENDING proposal would otherwise keep blocking new proposals for this (team, app) until it expires; the record itself is kept (status CANCELLED)
    const t = await this.o.store.transitionLiveProposal(op.proposalId, "CANCELLED", nowIso);
    await this.audit(null, "operation_cancelled", { operationId: opId, actor: shortHash(sessionId), proposalClosed: t.changed });
    return next;
  }

  /** The explicit recovery workflow for NEEDS_OPERATOR_REVIEW: re-verify (read-only) or abandon (the remote resources are KEPT; nothing is deleted). */
  async resolve(opId: string, sessionId: string, action: "reverify" | "abandon", adoptOrphan = false): Promise<LiveOperationRecord> {
    await this.recovered;
    const op = await this.operationForRecovery(opId, sessionId, adoptOrphan, action);
    if (op.state !== "NEEDS_OPERATOR_REVIEW") throw new LiveError("live_invalid_state", [op.state]);
    if (action === "reverify") {
      if (!this.executor) throw new LiveError("live_execution_disabled");
      await this.audit(null, "operation_reverify", { operationId: opId, actor: shortHash(sessionId) });
      return this.executor.reverify(op);
    }
    if (action !== "abandon") throw new LiveError("live_binding_mismatch", ["action"]);
    const nowIso = this.iso();
    const next: LiveOperationRecord = { ...op, state: "FAILED", updatedAt: nowIso, failure: { code: "abandoned_by_operator", step: op.failure?.step ?? "verify_deployment", messageFa: "عملیات توسط اپراتور رها شد؛ منابع ساخته‌شده در لیارا حفظ شده‌اند (هیچ حذفی انجام نشد)." }, transitions: [...op.transitions, { at: nowIso, from: "NEEDS_OPERATOR_REVIEW", to: "FAILED", note: "abandoned_by_operator" }] };
    if (!(await this.o.store.updateOperation(next, "NEEDS_OPERATOR_REVIEW"))) throw new LiveError("live_invalid_state", ["raced"]);
    await this.audit(null, "operation_abandoned", { operationId: opId, actor: shortHash(sessionId), appConfirmed: op.remote.appConfirmed });
    return next;
  }

  /** Startup sweep. In-flight state is process-local, so anything mid-flight now is orphaned: it goes UNDER REVIEW (never retried); dead approvals are cancelled. */
  private async recover(): Promise<void> {
    try {
      const inflight = await this.o.store.listOperationsInStates(["APPROVED", "CREATING_APPLICATION", "UPLOADING_SOURCE", "CREATING_RELEASE", "VERIFYING_DEPLOYMENT", "SOURCE_UPLOADED", "RELEASE_CREATED", "APPLICATION_CREATED"]);
      for (const op of inflight) if (!this.executor?.isRunning(op.id)) await this.markReview(op.id, "interrupted_by_restart");
      for (const op of await this.o.store.listOperationsInStates(["AWAITING_LIVE_APPROVAL"])) {
        const p = await this.o.store.getLiveProposal(op.proposalId);
        if (!p || !["PENDING", "APPROVED"].includes(p.status)) await this.cancelOperationOf(p ?? ({ operationId: op.id } as LiveProposal), "orphaned_awaiting_approval");
      }
    } catch (e) {
      log("error", "live.recover_failed", { name: (e as { name?: string })?.name });
    }
  }
}

export type LiveUiState = "SIMULATED" | "BLOCKED" | "READY_FOR_APPROVAL" | "LIVE_IN_PROGRESS" | "LIVE_VERIFIED" | "LIVE_FAILED";
/** Which of the three visually distinct modes the system is in. Derived from configuration only; never from user input. */
export interface LiveModeInfo {
  /** simulation = mock data (nothing real can happen); live_disabled = real READ-ONLY data, writes impossible; live_enabled = a real write path exists (still needs a fresh approval per operation) */
  kind: "simulation" | "live_disabled" | "live_enabled";
  dataSource: "mock" | "live";
  liveFlag: boolean;
  writePathReady: boolean;
}
export interface ExistingTargetView {
  name: string;
  /** null when the facts could not be read or a hard precondition failed (see `blocked`) */
  facts: { planId: string; platform: string | null; scale: number | null; instanceHint: string | null; createdAt: string | null; hasNetwork: boolean; defaultSubdomain: boolean | null; currentReleaseHint: string | null; releaseTotal: number | null } | null;
  expectedSuffix: string | null;
  checks: PreflightCheck[];
  blocked: string[];
  ready: boolean;
}
export interface ExistingBackendView {
  id: "api" | "cli";
  isDefault: boolean;
  ready: boolean;
  blockers: string[];
  prerequisites: Prerequisite[];
  cliVersion: string | null;
}
export interface ExistingStatus {
  targets: ExistingTargetView[];
  backends: ExistingBackendView[];
  readError: string | null;
  uiState: LiveUiState;
}

/** Result of `previewExisting`: what WOULD be bound, split into target readiness and execution prerequisites. Nothing here is an approval. */
export interface ExistingPreview {
  appName: string;
  backend: "api" | "cli";
  platform: string | null;
  artifact: { zipSha256: string; analysisDigest: string; artifactDigest: string; artifactBytes: number; fileCount: number; format: string };
  config: { port: number; output: string; nodeRange: string | null } | null;
  target: { checked: boolean; reason: string | null; facts: { planId: string; platform: string | null; scale: number | null; hasNetwork: boolean; defaultSubdomain: boolean | null; releaseTotal: number | null } | null; checks: PreflightCheck[]; blocked: string[] };
  targetReady: boolean;
  prerequisites: Prerequisite[];
  executionBlockers: string[];
  executable: boolean;
  persisted: false;
  note: "preview_only_not_an_approval";
}

export interface LockView {
  access: "owner" | "orphan" | "other_session";
  appName: string;
  state: LiveState;
  createdAt: string;
  /** null for "other_session": the full record (and its id) is never handed to a session that does not own it */
  operation: LiveOperationRecord | null;
}

export interface LiveStatus {
  uiState: LiveUiState;
  prerequisites: Prerequisite[];
  /** why the live panel is blocked beyond configuration (readiness, secrets, …) */
  runBlockers: string[];
  catalogue: { source: "live" | "simulated" | "unavailable"; unitsVerified: boolean; candidates: ReturnType<typeof listCandidates>; notes: string[] } | null;
  minRamMb: number | null;
  proposals: LiveProposalView[];
  /** Phase 2B: sanitised preflight (null while an operation is in flight, to avoid needless reads) */
  preflight: PreflightReport | null;
  /** Phase 2E */
  mode: LiveModeInfo;
  existing: ExistingStatus | null;
  /** operations from other runs that still hold a (team, app) slot — the operator can resolve them from any run */
  locks: LockView[];
}

const IN_FLIGHT: readonly LiveState[] = ["APPROVED", "CREATING_APPLICATION", "APPLICATION_CREATED", "UPLOADING_SOURCE", "SOURCE_UPLOADED", "CREATING_RELEASE", "RELEASE_CREATED", "VERIFYING_DEPLOYMENT"];

export type { PlanSelection, LiveState, Prerequisite as LivePrerequisite };
export { assertStepAuthorized };
