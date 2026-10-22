import type { SimulationResult } from "../agent/types";
import type { DeployParamsT, DeployStepId, SimScenario } from "./params";

/**
 * DEPLOYMENT SIMULATOR — synthetic only. Like the Phase 1D simulator it imports nothing from the Liara layer, performs no I/O and has
 * no client. It invents NO deployment URL and NO release id, and every line it produces says it is simulated.
 */

export const DEPLOY_SIM_NOTE = "شبیه‌سازی — هیچ برنامه‌ای ساخته و هیچ نسخه‌ای منتشر نشد و هیچ درخواست نوشتنی به لیارا ارسال نشد. نشانی واقعی و شناسهٔ نسخهٔ واقعی وجود ندارد.";

interface StageDef { id: DeployStepId; phase: "running" | "verification"; labelFa: string; okFa: string }
const STAGES: StageDef[] = [
  { id: "create_app", phase: "running", labelFa: "ساخت برنامه (ساختگی)", okFa: "برنامه در پس‌حالت ساختگی ثبت شد" },
  { id: "validate_config", phase: "running", labelFa: "اعتبارسنجی پیکربندی (ساختگی)", okFa: "اسکریپت‌ها و نام متغیرها معتبر بود" },
  { id: "prepare_artifact", phase: "running", labelFa: "آماده‌سازی بستهٔ سورس (ساختگی)", okFa: "بستهٔ ساختگی آماده شد" },
  { id: "upload_source", phase: "running", labelFa: "بارگذاری سورس (ساختگی)", okFa: "بارگذاری ساختگی انجام شد" },
  { id: "create_release", phase: "running", labelFa: "ساخت نسخه (ساختگی)", okFa: "نسخهٔ ساختگی ثبت شد (بدون شناسهٔ واقعی)" },
  { id: "build", phase: "running", labelFa: "ساخت پروژه (ساختگی)", okFa: "ساخت ساختگی تمام شد" },
  { id: "runtime_startup", phase: "running", labelFa: "راه‌اندازی برنامه (ساختگی)", okFa: "راه‌اندازی ساختگی انجام شد" },
  { id: "health_check", phase: "verification", labelFa: "بررسی سلامت (ساختگی)", okFa: "بررسی سلامت ساختگی موفق بود" },
  { id: "post_checks", phase: "verification", labelFa: "بررسی‌های پس از استقرار (ساختگی)", okFa: "بررسی‌های ساختگی موفق بود؛ بررسی دستی نشانی و لاگ‌ها با شماست" },
];

const FAIL_AT: Record<Exclude<SimScenario, "success">, { stage: DeployStepId; detailFa: string; code: string }> = {
  insufficient_permissions: { stage: "create_app", code: "insufficient_permissions", detailFa: "خطای شبیه‌سازی‌شده: توکن اجازهٔ ساخت برنامه را ندارد (۴۰۳ ساختگی)." },
  missing_build_script: { stage: "validate_config", code: "missing_build_script", detailFa: "خطای شبیه‌سازی‌شده: اسکریپت build در بستهٔ ساختگی پیدا نشد." },
  missing_config: { stage: "validate_config", code: "missing_config", detailFa: "خطای شبیه‌سازی‌شده: مقدار یکی از متغیرهای الزامی وارد نشده بود." },
  build_failure: { stage: "build", code: "build_failure", detailFa: "خطای شبیه‌سازی‌شده: ساخت با خطای کامپایل متوقف شد." },
  startup_failure: { stage: "runtime_startup", code: "startup_failure", detailFa: "خطای شبیه‌سازی‌شده: برنامه پس از راه‌اندازی بلافاصله خارج شد." },
  health_failure: { stage: "health_check", code: "health_failure", detailFa: "خطای شبیه‌سازی‌شده: بررسی سلامت پاسخ سالم نداد." },
};

export interface DeploymentSimDetail {
  scenario: SimScenario;
  stages: { id: DeployStepId; phase: "running" | "verification"; labelFa: string; status: "ok" | "failed" | "not_run"; detailFa: string | null }[];
  reached: "none" | "running" | "verification" | "completed";
  failedStage: DeployStepId | null;
  failureCode: string | null;
  logFa: string[];
  urlNoteFa: string;
  releaseNoteFa: string;
}

export function simulateDeployment(p: { id: string; app: string; params: DeployParamsT }, nowIso: string): SimulationResult & { deployment: DeploymentSimDetail } {
  const scenario = p.params.simulation.scenario;
  const wanted = new Set<DeployStepId>(p.params.steps);
  const stages = STAGES.filter((s) => wanted.has(s.id));
  const fail = scenario === "success" ? null : FAIL_AT[scenario];
  const out: DeploymentSimDetail["stages"] = [];
  const log: string[] = [`[شبیه‌سازی] برنامه: ${p.app} · پلتفرم: ${p.params.platform}`];
  let failed: DeployStepId | null = null;
  let reached: DeploymentSimDetail["reached"] = "none";
  for (const s of stages) {
    if (failed) {
      out.push({ id: s.id, phase: s.phase, labelFa: s.labelFa, status: "not_run", detailFa: null });
      continue;
    }
    if (fail && fail.stage === s.id && wanted.has(fail.stage)) {
      failed = s.id;
      out.push({ id: s.id, phase: s.phase, labelFa: s.labelFa, status: "failed", detailFa: fail.detailFa });
      log.push(`[شبیه‌سازی] ✗ ${s.labelFa}: ${fail.detailFa}`);
      reached = s.phase === "running" ? "running" : "verification";
      continue;
    }
    out.push({ id: s.id, phase: s.phase, labelFa: s.labelFa, status: "ok", detailFa: s.okFa });
    log.push(`[شبیه‌سازی] ✓ ${s.labelFa}`);
    if (s.id === "build") log.push("[شبیه‌سازی] ... پیشرفت ساخت ۱۰۰٪ (متن ساختگی)");
    reached = s.phase;
  }
  // a scenario whose stage is not part of the plan (e.g. runtime_startup on a static plan) cannot fail: the run completes
  if (!failed) reached = "completed";
  const okAll = !failed;
  const verifyStages = out.filter((s) => s.phase === "verification");
  const verifyReached = verifyStages.some((s) => s.status !== "not_run");
  return {
    simulated: true,
    proposalId: p.id,
    operation: "first_deploy",
    outcome: okAll ? "succeeded" : "failed",
    steps: out.filter((s) => s.status !== "not_run").map((s) => ({ labelFa: s.detailFa && s.status === "failed" ? `${s.labelFa} — ${s.detailFa}` : s.labelFa, status: s.status === "failed" ? ("failed" as const) : ("ok" as const) })),
    verification: !verifyReached ? { outcome: "not_run", criteria: [] } : { outcome: verifyStages.some((s) => s.status === "failed") ? "failure" : "success", criteria: verifyStages.filter((s) => s.status !== "not_run").map((s) => ({ textFa: s.labelFa, passed: s.status === "ok" })) },
    noteFa: DEPLOY_SIM_NOTE,
    completedAt: nowIso,
    deployment: {
      scenario,
      stages: out,
      reached,
      failedStage: failed,
      failureCode: fail && failed ? fail.code : null,
      logFa: log,
      urlNoteFa: "نشانی واقعی ساخته نشد؛ این یک شبیه‌سازی است.",
      releaseNoteFa: "شناسهٔ نسخه در شبیه‌سازی ساخته نمی‌شود.",
    },
  };
}
