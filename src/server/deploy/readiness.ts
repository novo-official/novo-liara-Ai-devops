import type { ChecklistItem, Finding, ReadinessReport, SourceAnalysis, UserDecisions, Verdict } from "./types";
import { NO_DECISIONS } from "./types";

export const VERDICT_FA: Record<Verdict, string> = {
  READY: "آماده برای ادامه (بدون هشدار ایستا)",
  READY_WITH_WARNINGS: "آماده با هشدار",
  NEEDS_CONFIGURATION: "نیازمند تنظیمات",
  BLOCKED: "مسدود (مانع وجود دارد)",
  UNSUPPORTED: "پشتیبانی‌نشده",
};

export const STATIC_NOTICE_FA = "این گزارش فقط از «خواندن ایستای» فایل‌ها ساخته شده است؛ هیچ کدی اجرا، نصب یا ساخته نشده. این به معنی تضمین موفقیت ساخت یا اجرا نیست و پروژه «آمادهٔ تولید» اعلام نمی‌شود.";

export const READINESS_LIMITATIONS = [
  "تحلیل ایستا است؛ ساخت و اجرای واقعی بررسی نشده است.",
  "نام متغیرهای محیطی از فایل‌های نمونه و ارجاع‌های متغیر محیطی در کد استنباط می‌شود و ممکن است ناقص یا اضافه باشد.",
  "وجود پایگاه‌داده و نیاز به دیسک از روی وابستگی‌ها حدس زده می‌شود.",
  "رفتار پلتفرم لیارا (فرمان start، پورت، نسخهٔ Node) تأیید زنده نشده است.",
];

/** Pure function: same analysis + same decisions ⇒ same verdict. Changing evidence changes the verdict (mutation-tested). */
export function buildReadiness(a: SourceAnalysis, decisions: UserDecisions = NO_DECISIONS): ReadinessReport {
  const fw = a.framework;
  const blockers = a.findings.filter((f) => f.kind === "blocker");
  const warned = a.findings.filter((f) => f.kind === "warning" || f.kind === "security");
  const checklist = buildChecklist(a, decisions, blockers);
  const pendingBlocking = checklist.filter((c) => c.kind === "manual" && c.blocking && c.state === "pending");
  const confirmedManual = checklist.some((c) => c.kind === "manual" && c.blocking && c.state === "done");

  let verdict: Verdict;
  if (!fw.supported) verdict = "UNSUPPORTED";
  else if (blockers.length) verdict = "BLOCKED";
  else if (pendingBlocking.length) verdict = "NEEDS_CONFIGURATION";
  else if (warned.length || confirmedManual) verdict = "READY_WITH_WARNINGS";
  else verdict = "READY";

  const nextActions: string[] = [];
  if (verdict === "UNSUPPORTED") nextActions.push("پروژه را به یک برنامهٔ Next.js با package.json در ریشه تبدیل یا جدا کنید، یا منتظر پشتیبانی چارچوب‌های دیگر بمانید.");
  for (const b of blockers) nextActions.push(`رفع مانع: ${b.titleFa}`);
  for (const c of pendingBlocking) nextActions.push(c.titleFa);
  for (const f of a.findings.filter((x) => x.kind === "security")) nextActions.push(`امنیت: ${f.titleFa}`);
  if (!nextActions.length && verdict !== "UNSUPPORTED") nextActions.push("می‌توانید طرح استقرار شبیه‌سازی‌شده را بسازید و بازبینی کنید.");

  return {
    schemaVersion: 1,
    verdict,
    verdictFa: VERDICT_FA[verdict],
    summaryFa: summaryFor(a, verdict, blockers.length, pendingBlocking.length, warned.length),
    staticNoticeFa: STATIC_NOTICE_FA,
    framework: { id: fw.id, nameFa: fw.nameFa, confidence: fw.confidence, supported: fw.supported },
    findings: a.findings,
    checklist,
    nextActionsFa: nextActions.slice(0, 12),
    limitations: READINESS_LIMITATIONS,
    decisions,
  };
}

function summaryFor(a: SourceAnalysis, v: Verdict, nb: number, np: number, nw: number): string {
  const fw = a.framework;
  if (v === "UNSUPPORTED") return `چارچوب شناسایی‌شده: ${fw.nameFa}. این نسخه فقط پروژه‌های Next.js را تحلیل می‌کند، بنابراین نتیجه «پشتیبانی‌نشده» است (نه «شکست‌خورده»).`;
  if (v === "BLOCKED") return `پروژهٔ ${fw.nameFa} شناسایی شد اما ${nb} مانع برای استقرار وجود دارد که باید اول رفع شود.`;
  if (v === "NEEDS_CONFIGURATION") return `پروژهٔ ${fw.nameFa} شناسایی شد. مانع فنی ایستا دیده نشد ولی ${np} کار دستی (تنظیمات یا سرویس جانبی) باید پیش از استقرار انجام و تأیید شود.`;
  if (v === "READY_WITH_WARNINGS") return `پروژهٔ ${fw.nameFa} شناسایی شد. مانعی دیده نشد${nw ? ` ولی ${nw} هشدار` : ""} و مواردی که شما تأیید کرده‌اید باید بررسی شود. این به معنی تضمین موفقیت نیست.`;
  return `پروژهٔ ${fw.nameFa} شناسایی شد و در بررسی ایستا هشداری ندارد. این به معنی تضمین موفقیت ساخت یا اجرا نیست.`;
}

function buildChecklist(a: SourceAnalysis, d: UserDecisions, blockers: Finding[]): ChecklistItem[] {
  const out: ChecklistItem[] = [];
  const r = a.runtime;
  const isNext = a.framework.id === "next" && a.framework.supported;
  const has = (id: string) => blockers.some((b) => b.id === id);

  out.push({ id: "source_supported", titleFa: "چارچوب پروژه پشتیبانی می‌شود", detailFa: `چارچوب: ${a.framework.nameFa}`, kind: "auto", blocking: true, state: a.framework.supported ? "ok" : "blocked", class: "D" });
  if (isNext) {
    out.push({ id: "build_script", titleFa: "اسکریپت build وجود دارد", detailFa: r.scripts.build.invocation ? `فرمان ساخت: ${r.scripts.build.invocation}` : "تعریف نشده", kind: "auto", blocking: true, state: has("missing_build_script") ? "blocked" : "ok", class: "B" });
    out.push({ id: "start_script", titleFa: "اسکریپت start وجود دارد", detailFa: r.output === "export" ? "برای خروجی استاتیک لازم نیست" : r.scripts.start.invocation ? `فرمان اجرا: ${r.scripts.start.invocation}` : "تعریف نشده", kind: "auto", blocking: true, state: r.output === "export" ? "not_applicable" : has("missing_start_script") ? "blocked" : "ok", class: "B" });
    out.push({ id: "node_version", titleFa: "نسخهٔ Node.js مشخص و سازگار است", detailFa: r.nodeRange ? `اعلام‌شده: ${r.nodeRange}` : "اعلام نشده", kind: "auto", blocking: false, state: has("node_engine_incompatible") ? "blocked" : r.nodeRange ? "ok" : "pending", class: "D" });
    out.push({ id: "lockfile", titleFa: "lockfile برای نصب قطعی وجود دارد", detailFa: r.lockfile ?? "یافت نشد", kind: "auto", blocking: false, state: r.lockfile ? "ok" : "pending", class: "C" });
    const required = a.envKeys.filter((k) => k.required);
    if (required.length) out.push({ id: "env_values", titleFa: "مقدار متغیرهای محیطی را آمادهٔ ورود دستی کنید", detailFa: `نام متغیرها: ${required.slice(0, 8).map((k) => k.name).join("، ")}${required.length > 8 ? " …" : ""}. مقدارها را فقط خودتان و خارج از این ابزار وارد می‌کنید.`, kind: "manual", blocking: true, state: d.envConfirmed ? "done" : "pending", class: "A" });
    else out.push({ id: "env_values", titleFa: "متغیر محیطی الزامی شناسایی نشد", detailFa: "ممکن است برنامه بدون پیکربندی اجرا شود؛ این یک استنباط ایستا است.", kind: "auto", blocking: false, state: "not_applicable", class: "A" });
    if (a.database.some((x) => x.needsService)) out.push({ id: "database", titleFa: "سرویس پایگاه‌داده را خودتان بسازید و نشانی اتصال را آماده کنید", detailFa: `پایگاه‌داده: ${[...new Set(a.database.map((x) => x.engine))].join("، ")}. ساخت پایگاه‌داده از مسیرهای API مورد استفادهٔ این پروژه تأیید نشده است؛ آن را در کنسول لیارا بسازید.`, kind: "manual", blocking: true, state: d.databaseConfirmed ? "done" : "pending", class: "D" });
    if (a.database.some((x) => x.fileBased) || a.storageHints.length) out.push({ id: "persistent_storage", titleFa: "دیسک دائمی برای دادهٔ فایل‌محور را تأیید کنید", detailFa: "فایل‌های روی سرور پایدار نیستند. ساخت دیسک در این نسخه انجام نمی‌شود و یک مرحلهٔ دستی است.", kind: "manual", blocking: a.database.some((x) => x.fileBased), state: d.storageConfirmed ? "done" : "pending", class: "A" });
  }
  out.push({ id: "sensitive_files", titleFa: "فایل حساسی در آرشیو نیست", detailFa: a.sensitiveFilesPresent.length ? `یافت شد: ${a.sensitiveFilesPresent.slice(0, 4).join("، ")}` : "موردی دیده نشد", kind: "auto", blocking: false, state: a.sensitiveFilesPresent.length ? "pending" : "ok", class: "C" });
  out.push({ id: "account_ready", titleFa: "حساب لیارا آماده است و اعتبار کافی دارد", detailFa: "شارژ حساب و خرید پلن همیشه دستی و به عهدهٔ شماست؛ این ابزار هیچ هزینه‌ای ایجاد نمی‌کند و موجودی را نمی‌خواند.", kind: "manual", blocking: false, state: d.accountReady ? "done" : "pending", class: "C" });
  return out;
}
