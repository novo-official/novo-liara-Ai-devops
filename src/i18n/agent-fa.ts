import { confidenceLabel, hypothesisTitle, intentLabel } from "@/i18n/diagnostics-fa";
import type { DiagnosticReport } from "@/server/diagnostics/report";
import type { ActionProposal, AgentIntent, AgentPlan, SimulationResult, ToolId } from "@/server/agent/types";

/** Persian texts of the agent. All are deterministic templates built from structured facts — never from log text or model output. */
const n = (x: number) => new Intl.NumberFormat("fa-IR").format(x);

export const SIM_BANNER = "شبیه‌سازی — هیچ عملیات واقعی انجام نمی‌شود";
export const SIM_BANNER_LONG = "همهٔ اقدام‌ها در این نسخه فقط شبیه‌سازی‌اند: هیچ درخواست نوشتنی به لیارا ارسال نمی‌شود و تأیید شما هیچ تغییر واقعی ایجاد نمی‌کند.";

export const intentNameFa: Record<AgentIntent, string> = {
  inspect_health: "بررسی سلامت برنامه",
  investigate_restarts: "بررسی ری‌استارت‌های مکرر",
  investigate_http500: "بررسی خطای HTTP 500",
  investigate_slow: "بررسی کندی",
  investigate_deployments: "بررسی شکست‌های استقرار",
  explain_finding: "توضیح یک یافته",
  review_remediation: "بررسی اقدام پیشنهادی",
  simulate_remediation_plan: "طرح شبیه‌سازی‌شدهٔ اقدام",
  start_deployment: "آماده‌سازی استقرار پروژه",
  check_compatibility: "بررسی سازگاری پروژه با لیارا",
  recommend_plan: "راهنمای منابع و پلن",
  predeploy_checklist: "فهرست کارهای پیش از انتشار",
};

export const toolNameFa: Record<ToolId, string> = {
  list_apps: "فهرست برنامه‌ها",
  get_app_details: "جزئیات برنامه",
  get_runtime_status: "وضعیت اجرا",
  get_recent_releases: "نسخه‌های اخیر",
  get_recent_events: "رویدادهای اخیر",
  get_application_logs: "لاگ‌های برنامه",
  get_cpu_metrics: "متریک CPU",
  get_memory_metrics: "متریک حافظه",
  diagnose_application: "تشخیص (موتور قطعی)",
};

export const ack = (intent: AgentIntent, app: string, windowNote?: string) => `درخواست شما «${intentNameFa[intent]}» برای برنامهٔ ${app} شناخته شد. ${windowNote ?? ""}`.trim();

export function planText(p: AgentPlan): string {
  if (p.steps.length === 0) return "برای این درخواست ابزار جدیدی لازم نیست؛ از گزارش موجود استفاده می‌شود.";
  return `برنامهٔ بررسی (فقط‌خواندنی، ${n(p.steps.length)} مرحله): ${p.steps.map((s, i) => `${n(i + 1)}) ${toolNameFa[s.tool]}`).join("، ")}.${p.skipped.length ? ` ${n(p.skipped.length)} مرحله حذف شد (شاهد موجود، قابلیت ناموجود یا سقف بودجه).` : ""}`;
}

export function reportText(r: DiagnosticReport): string {
  const top = r.hypotheses[0];
  const head = r.summary.textFa;
  if (!top) return head;
  return `${head} فرضیهٔ اول: «${top.titleFa}» (${confidenceLabel[top.confidence]}). گزارش کامل با شواهد در پایین نمایش داده شده است.`;
}

export function explainText(r: DiagnosticReport, index: number): string {
  if (r.hypotheses.length === 0) return `در گزارش اخیر یافته‌ای برای توضیح وجود ندارد: ${r.summary.statusFa}. ${r.limitations[0]?.textFa ?? ""}`.trim();
  const h = r.hypotheses[Math.min(Math.max(index, 1), r.hypotheses.length) - 1]!;
  const parts = [`«${h.titleFa}» — ${h.confidenceFa}.`];
  if (h.observations.length) parts.push(`مشاهده‌ها: ${h.observations.map((o) => o.textFa).join(" ")}`);
  if (h.inferences.length) parts.push(`استنتاج‌ها (فقط محتمل): ${h.inferences.map((o) => o.textFa).join(" ")}`);
  if (h.contradictions.length) parts.push(`شواهد متناقض: ${h.contradictions.map((c) => c.textFa).join(" ")}`);
  if (h.missing.length) parts.push(`اطلاعات ناقص: ${h.missing.map((m) => m.textFa).join(" ")}`);
  const src = [...new Set(h.evidenceIds.map((id) => r.evidence.find((e) => e.id === id)?.sourceFa).filter(Boolean))];
  if (src.length) parts.push(`شواهد پشتیبان: ${src.join("، ")}.`);
  return parts.join(" ");
}

export function reviewText(r: DiagnosticReport): string {
  if (r.recommendations.length === 0) return "اقدامی پیشنهاد نشده است.";
  const lines = r.recommendations.slice(0, 6).map((x, i) => `${n(i + 1)}) [${x.risk}] ${x.descriptionFa} ${x.requiresApproval ? "(نیازمند تأیید صریح)" : "(بررسی دستی، بدون نیاز به تأیید)"}`);
  return `اقدام‌های پیشنهادی گزارش (هیچ‌کدام اجرا نمی‌شوند): ${lines.join(" ")}`;
}

export const noOperation = "در این گزارش اقدامی که بتوان آن را به‌صورت «طرح شبیه‌سازی‌شده» ساخت پیشنهاد نشده است؛ چیزی از خودم نمی‌سازم. گزارش را بررسی کنید یا ابتدا یک بررسی تازه انجام دهید.";
export const proposalPending = "یک پیشنهاد در انتظار تصمیم شماست؛ ابتدا همان را تأیید یا رد کنید.";

export function proposalText(p: ActionProposal): string {
  return `پیشنهاد «${p.descriptionFa}» برای برنامهٔ ${p.app} ساخته شد (ریسک ${p.risk}). این یک آزمون جریان تأییدِ شبیه‌سازی‌شده است: تأیید شما هیچ عملیات واقعی انجام نمی‌دهد. پیشنهاد تا ${new Intl.DateTimeFormat("fa-IR", { hour: "2-digit", minute: "2-digit", timeZone: "Asia/Tehran" }).format(new Date(p.expiresAt))} معتبر است.`;
}

export const decisionText = {
  rejected: "پیشنهاد رد شد. هیچ اقدامی (حتی شبیه‌سازی‌شده) اجرا نشد.",
  expired: "مهلت تأیید به پایان رسید؛ پیشنهاد منقضی شد و هیچ اقدامی اجرا نشد.",
  blocked_drift: "وضعیت برنامه نسبت به زمان ساخت پیشنهاد تغییر کرده است؛ تأیید مسدود شد. پیشنهاد جدیدی بسازید.",
  blocked_policy: "سیاست امنیتی این پیشنهاد را مسدود کرد؛ هیچ اقدامی اجرا نشد.",
  tampered: "یکپارچگی پیشنهاد تأیید نشد؛ تأیید مسدود شد.",
  approved: "پیشنهاد تأیید شد (فقط برای آزمون شبیه‌سازی).",
};

export function simulationText(r: SimulationResult): string {
  if (r.outcome === "failed") return `شبیه‌سازی ناموفق بود (خطای ساختگی). ${r.noteFa}`;
  const v = r.verification;
  const vt = !v || v.outcome === "not_run" ? "" : v.outcome === "success" ? " راستی‌آزمایی ساختگی موفق بود." : " راستی‌آزمایی ساختگی ناموفق بود.";
  return `شبیه‌سازی کامل شد.${vt} ${r.noteFa}`;
}

export const intents = intentLabel;
export { hypothesisTitle };

/** UI strings of the agent workspace. */
export const ui = {
  title: "فضای کار عامل",
  subtitle: "گفتگو به فارسی، برنامهٔ ابزارها، شواهد، گزارش و پیشنهادهای شبیه‌سازی‌شده",
  limits: "فهم زبان آزاد پیاده‌سازی نشده است: فقط چند درخواست مشخص (بررسی ری‌استارت، خطای ۵۰۰، کندی، شکست استقرار، سلامت، توضیح یافته، بررسی اقدام پیشنهادی، طرح شبیه‌سازی) پشتیبانی می‌شود. مدل زبانی واقعی استفاده نمی‌شود و هیچ هزینه‌ای مصرف نمی‌شود.",
  provider: { mock: "متن روایی: ارائه‌دهندهٔ آفلاین شبیه‌سازی‌شده", disabled: "ارائه‌دهندهٔ متن غیرفعال است؛ گزارش قطعی بدون متن روایی تولید می‌شود." },
  conversation: "گفتگو",
  composerLabel: "پیام شما (حداکثر ۵۰۰ نویسه)",
  composerHint: "Enter برای ارسال، Shift+Enter برای خط جدید",
  send: "ارسال",
  sending: "در حال ارسال…",
  empty: "یکی از نمونه‌ها را انتخاب کنید یا درخواست خود را بنویسید.",
  suggestions: "پیشنهادها",
  roles: { user: "شما", agent: "عامل", system: "سیستم" } as Record<string, string>,
  planTitle: "برنامهٔ بررسی",
  planNote: "همهٔ مراحل فقط‌خواندنی (R0) هستند.",
  timelineTitle: "اجرای ابزارها",
  skippedTitle: "مراحل حذف‌شده",
  tool: { pending: "در انتظار", running: "در حال اجرا", succeeded: "موفق", failed: "ناموفق", skipped: "حذف شد" } as Record<string, string>,
  toolError: { unknown_tool: "ابزار ثبت‌نشده", invalid_arguments: "آرگومان نامعتبر", app_not_allowed: "برنامه مجاز نیست", budget_exceeded: "بودجهٔ درخواست پر شد", capability_unavailable: "قابلیت در دسترس نیست", timeout: "زمان‌سنجی شد", cancelled: "لغو شد", tool_failed: "خطای ابزار", timeline_unavailable: "لاگ و رویداد در دسترس نبود" } as Record<string, string>,
  analysisDone: "تحلیل با موتور قطعی انجام شد",
  runStatus: { RUNNING: "در حال اجرا", READY: "گزارش آماده است", FAILED: "ناموفق", CANCELLED: "لغو شد", TIMED_OUT: "زمان‌سنجی شد" } as Record<string, string>,
  phase: {
    REQUEST_RECEIVED: "درخواست دریافت شد", INTENT_RESOLVED: "قصد شناسایی شد", PLAN_CREATED: "برنامه ساخته شد", COLLECTING_EVIDENCE: "جمع‌آوری شواهد", ANALYZING: "تحلیل", REPORT_READY: "گزارش آماده",
    ACTION_PROPOSED: "اقدام پیشنهاد شد", AWAITING_APPROVAL: "در انتظار تأیید", APPROVED: "تأیید شد (شبیه‌سازی)", REJECTED: "رد/مسدود شد", EXPIRED: "منقضی شد", SIMULATION_COMPLETED: "شبیه‌سازی کامل شد",
    SOURCE_RECEIVED: "پروژه دریافت شد", SOURCE_ANALYZING: "تحلیل ایستای پروژه", READINESS_REVIEW: "بازبینی آمادگی", PLAN_PREPARED: "طرح آماده شد", SIMULATION_RUNNING: "شبیه‌سازی در حال اجرا", SIMULATION_VERIFICATION: "راستی‌آزمایی شبیه‌سازی‌شده",
  } as Record<string, string>,
  cancel: "لغو بررسی",
  retry: "تلاش دوباره",
  runError: { plan_blocked: "برنامه‌ای ساخته نشد.", run_timeout: "بررسی از زمان مجاز بیشتر طول کشید.", cancelled_by_operator: "بررسی توسط شما لغو شد.", interrupted_by_restart: "سرور در میانهٔ اجرا راه‌اندازی مجدد شد.", agent_error: "خطای داخلی در بررسی.", no_report: "گزارشی تولید نشد.", tool_failed: "تحلیل ناموفق بود.", simulation_failed: "شبیه‌سازی استقرار در یک مرحله متوقف شد (هیچ تغییر واقعی انجام نشد)." } as Record<string, string>,
  proposals: "پیشنهادهای شبیه‌سازی‌شده",
  proposalNote: "آزمون جریان تأیید — شبیه‌سازی‌شده",
  review: "بررسی و تصمیم",
  dialog: {
    title: "تأیید پیشنهاد (شبیه‌سازی‌شده)",
    action: "اقدام دقیق", target: "برنامهٔ هدف", operation: "عملیات", params: "پارامترهای پاک‌سازی‌شده", paramsAdvanced: "نمایش JSON (جزئیات فنی)", risk: "ریسک", impact: "اثر مورد انتظار", downtime: "قطعی احتمالی",
    preconditions: "پیش‌شرط‌ها", verification: "برنامهٔ راستی‌آزمایی", digest: "شناسهٔ یکپارچگی (SHA-256)", expires: "اعتبار تا", remaining: "زمان باقی‌مانده",
    simNotice: "این تأیید فقط آزمونِ جریانِ شبیه‌سازی‌شده است. هیچ عملیات واقعی روی لیارا انجام نمی‌شود.",
    typeName: (a: string) => `برای تأیید، نام دقیق برنامه را تایپ کنید: ${a}`,
    approve: "تأیید (شبیه‌سازی)", reject: "رد", close: "بستن", working: "در حال ثبت…",
  },
  outcome: {
    created: "طرح ایجاد شد", approved: "پیشنهاد تأیید شد", simDone: "شبیه‌سازی کامل شد", simFailed: "شبیه‌سازی ناموفق بود", verifyOk: "راستی‌آزمایی ساختگی موفق", verifyFail: "راستی‌آزمایی ساختگی ناموفق", notReal: "عملیات واقعی اجرا نشد",
    rejected: "رد شد؛ هیچ اجرایی انجام نشد", expired: "منقضی شد؛ هیچ اجرایی انجام نشد", blocked: "مسدود شد؛ هیچ اجرایی انجام نشد", cancelled: "لغو شد؛ هیچ اجرایی انجام نشد",
  },
  steps: "گام‌های شبیه‌سازی", criteria: "معیارهای راستی‌آزمایی (ساختگی)",
  risks: { R0: "R0 — مشاهده", R1: "R1 — ری‌استارت‌گونه", R2: "R2 — پیکربندی/پلن/استقرار", R3: "R3 — مخرب (هرگز پیشنهاد نمی‌شود)" } as Record<string, string>,
  sessionLost: "نشست شما منقضی شده؛ دوباره وارد شوید.",
  pollError: "ارتباط با سرور برقرار نشد.",
};
