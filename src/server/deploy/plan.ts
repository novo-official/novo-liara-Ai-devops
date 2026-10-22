import { createHash, randomBytes } from "node:crypto";
import { DEPLOY_STEP_IDS, DeployParams, NEW_APP_NAME, type DeployParamsT, type SimScenario } from "./params";
import type { PlanRecommendation } from "./recommend";
import type { ReadinessReport, SourceAnalysis } from "./types";

export interface PlanOptions {
  appName?: string | null;
  scenario?: SimScenario;
  teamId?: string | null;
}

export type PlanRefusal = "not_supported" | "blocked" | "needs_configuration" | "invalid_app_name" | "unsafe_command";
export interface BuiltPlan {
  params: DeployParamsT;
  descriptionFa: string;
  impactFa: string;
  preconditionsFa: string[];
  verificationPlanFa: string[];
  evidenceIds: string[];
}

/** Steps depend on the platform: a static export has no runtime start. */
export function stepsFor(platform: "next" | "static") {
  return DEPLOY_STEP_IDS.filter((s) => platform === "next" || s !== "runtime_startup");
}

/**
 * Builds the immutable deployment-plan parameters from the analysis. Pure: same inputs ⇒ same params (except the random plan id).
 * Returns a refusal (never a partial plan) when the readiness verdict does not allow planning.
 */
export function buildPlan(a: SourceAnalysis, readiness: ReadinessReport, rec: PlanRecommendation, opts: PlanOptions = {}): { ok: true; plan: BuiltPlan } | { ok: false; refusal: PlanRefusal } {
  if (readiness.verdict === "UNSUPPORTED") return { ok: false, refusal: "not_supported" };
  if (readiness.verdict === "BLOCKED") return { ok: false, refusal: "blocked" };
  if (readiness.verdict === "NEEDS_CONFIGURATION") return { ok: false, refusal: "needs_configuration" };
  const appName = (opts.appName ?? a.project.suggestedAppName).trim().toLowerCase();
  if (!NEW_APP_NAME.test(appName)) return { ok: false, refusal: "invalid_app_name" };

  const platform = rec.approach.platformCandidate;
  const r = a.runtime;
  const buildInv = r.scripts.build.invocation;
  const startInv = platform === "next" ? r.scripts.start.invocation : null;
  const params: DeployParamsT = {
    planId: `dplan_${randomBytes(6).toString("hex")}`,
    artifactDigest: a.project.artifactDigest32,
    framework: "next",
    appName,
    teamId: opts.teamId ?? null,
    platform,
    planCategory: rec.category,
    resources: { ramMbMin: rec.resources.ramMbMin, ramMbRecommended: rec.resources.ramMbRecommended, diskGb: rec.resources.diskGb },
    build: { packageManager: r.packageManager, buildInvocation: buildInv, startInvocation: startInv, output: r.output, port: r.port ?? 3000, nodeRange: r.nodeRange && /^[0-9A-Za-z.<>=^~|* x-]{1,40}$/.test(r.nodeRange) ? r.nodeRange : null },
    envKeys: a.envKeys.filter((k) => k.required).map((k) => k.name).slice(0, 40),
    needsDatabase: a.database.some((d) => d.needsService),
    readinessBasis: readiness.verdict === "READY" ? "READY" : readiness.checklist.some((c) => c.kind === "manual" && c.blocking && c.state === "done") ? "NEEDS_CONFIGURATION_CONFIRMED" : "READY_WITH_WARNINGS",
    steps: stepsFor(platform),
    environment: "simulation",
    simulation: { scenario: opts.scenario ?? "success" },
  };
  const parsed = DeployParams.safeParse(params);
  if (!parsed.success) return { ok: false, refusal: "unsafe_command" };
  const p = parsed.data;
  return {
    ok: true,
    plan: {
      params: p,
      descriptionFa: `استقرار اولیهٔ «${p.appName}» (Next.js، پلتفرم ${p.platform}) — فقط شبیه‌سازی`,
      impactFa: "در شبیه‌سازی هیچ برنامه‌ای ساخته نمی‌شود و هیچ نسخه‌ای منتشر نمی‌شود. در یک اجرای واقعی آینده این طرح یک برنامهٔ جدید (قابل‌هزینه) می‌سازد، سورس را بارگذاری و یک نسخه منتشر می‌کند.",
      preconditionsFa: [
        "آرشیو همان نسخه‌ای است که تحلیل شد (با شناسهٔ یکتا بسته شده است).",
        p.envKeys.length ? `مقدار ${p.envKeys.length} متغیر محیطی (${p.envKeys.slice(0, 5).join("، ")}${p.envKeys.length > 5 ? " …" : ""}) را خودتان و خارج از این ابزار وارد می‌کنید.` : "متغیر محیطی الزامی شناسایی نشد.",
        p.needsDatabase ? "سرویس پایگاه‌داده را خودتان ساخته‌اید؛ این طرح آن را نمی‌سازد." : "پایگاه‌داده لازم شناسایی نشد.",
        "شارژ حساب و پرداخت هزینه دستی و به عهدهٔ شماست.",
      ],
      verificationPlanFa: ["ساخت نسخه بدون خطا تمام شود.", "برنامه روی پورت اعلام‌شده بالا بیاید.", "بررسی سلامت پس از استقرار موفق باشد.", "بررسی دستی نشانی و لاگ‌ها توسط شما."],
      evidenceIds: [`analysis/${p.artifactDigest.slice(0, 12)}`],
    },
  };
}

/** Drift fingerprint: changes when the artifact, the target name's availability, the verdict or the operator's decisions change. */
export function deployFingerprint(input: { artifactDigest: string; appName: string; nameTaken: boolean; verdict: string; decisions: Record<string, boolean> }): string {
  const canon = JSON.stringify({ a: input.artifactDigest, n: input.appName, t: input.nameTaken, v: input.verdict, d: Object.keys(input.decisions).sort().map((k) => [k, input.decisions[k]]) });
  return createHash("sha256").update(canon).digest("hex");
}
