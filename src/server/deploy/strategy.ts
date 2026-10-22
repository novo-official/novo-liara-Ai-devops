/**
 * The FUTURE first-deployment execution workflow, classified against the pinned evidence (docs/API_CAPABILITY_MATRIX.md).
 *   A  documented in the pinned OpenAPI (`paas.yaml`) — contract may still be weak
 *   B  observed only in the official Liara CLI source — not documentation, must be verified live
 *   C  manual user action (this system will not do it, ever, without a separate decision)
 *   D  unavailable or unverified — no basis to automate or to make claims
 * Nothing in this file performs I/O. Phase 1E only SIMULATES these steps.
 */

export type EvidenceClass = "A" | "B" | "C" | "D";
export interface StrategyStep {
  id: string;
  order: number;
  titleFa: string;
  detailFa: string;
  /** strongest class available for the step; `alsoManual` when part of it must be done by the user */
  class: EvidenceClass;
  alsoManual: boolean;
  /** advanced details only — raw API vocabulary is hidden in the beginner view */
  api: string[];
  mutation: boolean;
  risk: "R0" | "R2";
  /** true when the step is part of the simulated timeline */
  simulated: boolean;
  openQuestions: string[];
}

export const FIRST_DEPLOY_STRATEGY: readonly StrategyStep[] = [
  { id: "select_team", order: 1, titleFa: "انتخاب حساب یا تیم", detailFa: "تعیین اینکه برنامه در کدام حساب/تیم ساخته شود. انتخاب تیم در کنسول انجام می‌شود.", class: "B", alsoManual: true, api: ["query teamID (فقط در CLI رسمی دیده شده)"], mutation: false, risk: "R0", simulated: false, openQuestions: ["پارامتر teamID مستند نیست و تأیید زنده نشده."] },
  { id: "check_account", order: 2, titleFa: "بررسی آمادگی حساب", detailFa: "اطمینان از فعال‌بودن حساب و داشتن اعتبار. هیچ API مستندی برای خواندن موجودی وجود ندارد؛ شارژ حساب همیشه دستی است.", class: "C", alsoManual: true, api: [], mutation: false, risk: "R0", simulated: false, openQuestions: ["موجودی/اعتبار از API مستند قابل خواندن نیست."] },
  { id: "choose_platform", order: 3, titleFa: "انتخاب پلتفرم برنامه", detailFa: "برای Next.js شناسهٔ پلتفرم «next» (برای خروجی استاتیک «static») است؛ این شناسه‌ها فقط از CLI رسمی مشاهده شده‌اند.", class: "B", alsoManual: false, api: ["body.platform در POST /v1/projects"], mutation: false, risk: "R0", simulated: false, openQuestions: ["فهرست رسمی شناسه‌های پلتفرم در OpenAPI نیست."] },
  { id: "recommend_plan", order: 4, titleFa: "پیشنهاد پلن منابع", detailFa: "فهرست پلن‌ها فقط از پاسخ آزاد GET /v1/me به‌دست می‌آید و واحد/قیمت آن تأیید نشده؛ بنابراین فقط «راهنمای اولیهٔ منابع» نمایش داده می‌شود.", class: "D", alsoManual: true, api: ["GET /v1/me (schema آزاد)"], mutation: false, risk: "R0", simulated: false, openQuestions: ["واحد RAM/CPU و قیمت (ساعتی یا ماهانه) تأیید نشده است."] },
  { id: "create_app", order: 5, titleFa: "ساخت برنامه", detailFa: "ساخت یک برنامهٔ جدید با نام، پلتفرم و پلن. پاسخ شناسهٔ برنامه را برنمی‌گرداند؛ وجود برنامه باید با خواندن دوباره تأیید شود.", class: "A", alsoManual: false, api: ["POST /v1/projects"], mutation: true, risk: "R2", simulated: true, openQuestions: ["هیچ فیلدی در schema الزامی نشده؛ فیلدهای لازم هر پلتفرم از CLI استنباط می‌شود.", "نام تکراری با 409 رد می‌شود؛ تکراری‌بودن نام در حساب پیش از ساخت قابل بررسی کامل نیست."] },
  { id: "configure_env", order: 6, titleFa: "تنظیم متغیرهای محیطی", detailFa: "فقط نام متغیرها در طرح ثبت می‌شود. مقدارها را کاربر خارج از این ابزار وارد می‌کند. به‌روزرسانی متغیرها کل مجموعه را جایگزین و برنامه را ری‌استارت می‌کند.", class: "A", alsoManual: true, api: ["POST /v1/projects/update-envs"], mutation: true, risk: "R2", simulated: true, openQuestions: ["رفتار «جایگزینی کل مجموعه» از CLI استنباط شده.", "پاس‌دادن envs در ساخت نسخه فقط در CLI دیده شده؛ ترتیب بهینه برای اولین استقرار تأیید نشده."] },
  { id: "prepare_artifact", order: 7, titleFa: "آماده‌سازی بستهٔ سورس", detailFa: "فشرده‌سازی سورس (بدون node_modules و فایل‌های حساب). مستندات فرمت «.gz» را ذکر می‌کند؛ ساخت دقیق آرشیو را CLI انجام می‌دهد.", class: "B", alsoManual: false, api: ["createArchive در CLI رسمی"], mutation: false, risk: "R0", simulated: true, openQuestions: ["قالب دقیق آرشیو تأیید زنده نشده؛ سقف 256MiB فقط در CLI دیده شده."] },
  { id: "upload_source", order: 8, titleFa: "بارگذاری سورس", detailFa: "ارسال بسته به لیارا؛ پاسخ شناسهٔ سورس (sourceID) است.", class: "A", alsoManual: false, api: ["POST /v2/projects/{name}/sources (multipart: file)"], mutation: true, risk: "R2", simulated: true, openQuestions: [] },
  { id: "create_release", order: 9, titleFa: "ساخت نسخه (release)", detailFa: "ساخت نسخه از روی سورس بارگذاری‌شده با پورت و نوع پلتفرم. فیلدهای دیگر (build، healthCheck …) فقط در CLI دیده شده‌اند.", class: "A", alsoManual: false, api: ["POST /v2/projects/{name}/releases"], mutation: true, risk: "R2", simulated: true, openQuestions: ["کدام فیلدها برای هر پلتفرم الزامی‌اند مشخص نیست."] },
  { id: "track_build", order: 10, titleFa: "پیگیری ساخت", detailFa: "خواندن وضعیت و لاگ ساخت نسخه. وضعیت نسخه در فهرست releases مستند است؛ لاگ ساخت و وضعیت تکی فقط در CLI دیده شده‌اند.", class: "B", alsoManual: false, api: ["GET /v1/projects/{name}/releases (A)", "GET /v1/releases/{id} (B)", "GET /v2/releases/{id}/build-logs (B)"], mutation: false, risk: "R0", simulated: true, openQuestions: ["واژگان وضعیت نسخه (READY/FAILED/…) تأیید زنده نشده است."] },
  { id: "verify_startup", order: 11, titleFa: "بررسی راه‌اندازی", detailFa: "خواندن وضعیت applet ها، رویدادها و لاگ پس از استقرار (همان ابزارهای فقط‌خواندنی عیب‌یابی).", class: "A", alsoManual: false, api: ["GET /v1/projects/{name}/applets", "GET /v1/projects/{name}/logs"], mutation: false, risk: "R0", simulated: true, openQuestions: ["واژگان وضعیت applet تأیید نشده است."] },
  { id: "domain_guidance", order: 12, titleFa: "راهنمای دامنه", detailFa: "افزودن دامنه و SSL از API مستند است، اما تغییر رکورد DNS (CNAME) را باید کاربر در ثبت‌کنندهٔ دامنه انجام دهد.", class: "A", alsoManual: true, api: ["POST /v1/domains", "POST /v1/domains/provision-ssl-certs", "GET /v1/domains/{id}/check"], mutation: true, risk: "R2", simulated: false, openQuestions: ["وضعیت‌های دامنه/گواهی مستند نشده است."] },
  { id: "post_checks", order: 13, titleFa: "بررسی‌های پس از استقرار", detailFa: "تست دستی نشانی برنامه و بررسی لاگ‌ها. این ابزار هیچ بررسی HTTP بیرونی روی سایت شما انجام نمی‌دهد.", class: "C", alsoManual: true, api: [], mutation: false, risk: "R0", simulated: true, openQuestions: ["هیچ معیار HTTP (۵xx، تأخیر) در API وجود ندارد."] },
] as const;

/** Separate from direct API deployment. Never executed, configured or credentialed by this project. */
export const GITHUB_ACTIONS_NOTE = {
  titleFa: "مسیر جداگانه: استقرار از طریق CI (مثلاً GitHub Actions)",
  detailFa:
    "اجرای CLI رسمی در یک pipeline خارجی یک مسیر مستقل از «استقرار مستقیم با API» است. در OpenAPI و منابع پین‌شدهٔ این پروژه هیچ API برای «اتصال بومی GitHub» مستند یا تأیید نشده و این پروژه هیچ workflow یا توکنی را در این فاز نمی‌سازد، تنظیم نمی‌کند و اجرا نمی‌کند. اگر بعداً این مسیر انتخاب شود، توکن باید فقط به‌صورت secret در همان سرویس CI نگه‌داری شود (هرگز در گفتگو یا کد).",
  verified: false,
  executedHere: false,
} as const;

export function strategySummary() {
  const byClass = { A: 0, B: 0, C: 0, D: 0 } as Record<EvidenceClass, number>;
  for (const s of FIRST_DEPLOY_STRATEGY) byClass[s.class]++;
  return { steps: FIRST_DEPLOY_STRATEGY.length, byClass, githubActions: GITHUB_ACTIONS_NOTE };
}
