import type { ActionProposal, OperationKind, SimulationResult } from "../types";

/**
 * SIMULATOR — synthetic results only.
 * This module imports NOTHING from the Liara layer, performs no I/O, constructs no client and knows no endpoint. It cannot
 * restart, scale, deploy, change env/plan or delete anything. Every result is stamped `simulated: true` and says so in Persian.
 */

export type SimScenario = "ok" | "operation_failure" | "verification_failure";

export const NOT_REAL_FA = "شبیه‌سازی — هیچ عملیات واقعی انجام نشد و هیچ درخواست نوشتنی به لیارا ارسال نشد.";

const STEPS: Record<OperationKind, string[]> = {
  restart_app: ["ارسال درخواست ری‌استارت (ساختگی)", "انتظار برای راه‌اندازی مجدد (ساختگی)"],
  start_app: ["ارسال درخواست روشن‌کردن (ساختگی)", "انتظار برای آماده‌شدن (ساختگی)"],
  stop_app: ["ارسال درخواست خاموش‌کردن (ساختگی)", "انتظار برای توقف نمونه‌ها (ساختگی)"],
  change_plan: ["اعتبارسنجی پلن مقصد (ساختگی)", "اعمال تغییر پلن (ساختگی)"],
  update_env: ["اعتبارسنجی نام کلیدها (ساختگی)", "جایگزینی مجموعهٔ متغیرها و راه‌اندازی مجدد (ساختگی)"],
  deploy_release: ["بارگذاری سورس اصلاح‌شده (ساختگی)", "ساخت و استقرار نسخهٔ جدید (ساختگی)"],
  delete_resource: [],
  first_deploy: [],
};

const CRITERIA: Record<OperationKind, string[]> = {
  restart_app: ["همهٔ نمونه‌ها در پس‌حالتِ ساختگی در وضعیت اجرا هستند", "چرخهٔ ری‌استارت جدیدی در پس‌حالتِ ساختگی ثبت نشده است"],
  start_app: ["برنامه در پس‌حالتِ ساختگی روشن است", "نمونه‌ای در وضعیت اجرا گزارش شده است"],
  stop_app: ["برنامه در پس‌حالتِ ساختگی خاموش است", "نمونهٔ در حال اجرایی باقی نمانده است"],
  change_plan: ["پلن در پس‌حالتِ ساختگی برابر مقصد است", "برنامه پس از تغییر در وضعیت اجرا است"],
  update_env: ["کلیدهای خواسته‌شده در پس‌حالتِ ساختگی موجودند", "لاگ‌های ساختگی دیگر خطای نبودِ همان متغیر را نشان نمی‌دهند"],
  deploy_release: ["نسخهٔ جدید در پس‌حالتِ ساختگی در وضعیت موفق است", "نرخ خطا نسبت به پیش از استقرار بدتر نشده است"],
  delete_resource: [],
  first_deploy: [],
};

/** Deterministic default scenario so the demo shows both successful and failing simulations (tests inject their own). */
export function defaultScenario(p: Pick<ActionProposal, "app" | "operation">): SimScenario {
  if (p.app === "demo-conflict") return "verification_failure";
  if (p.app === "demo-oom" && p.operation === "change_plan") return "operation_failure";
  return "ok";
}

export function simulate(p: ActionProposal, scenario: SimScenario, nowIso: string): SimulationResult {
  const labels = STEPS[p.operation];
  const base = { simulated: true as const, proposalId: p.id, operation: p.operation, noteFa: NOT_REAL_FA, completedAt: nowIso };
  if (scenario === "operation_failure") {
    return { ...base, outcome: "failed", steps: [{ labelFa: labels[0] ?? "-", status: "ok" }, { labelFa: `${labels[1] ?? "-"} — خطای شبیه‌سازی‌شده: پلتفرم ساختگی درخواست را رد کرد`, status: "failed" }], verification: { outcome: "not_run", criteria: [] } };
  }
  const crit = CRITERIA[p.operation];
  const failing = scenario === "verification_failure";
  return {
    ...base,
    outcome: "succeeded",
    steps: labels.map((labelFa) => ({ labelFa, status: "ok" as const })),
    verification: { outcome: failing ? "failure" : "success", criteria: crit.map((textFa, i) => ({ textFa, passed: failing ? i === 0 : true })) },
  };
}
