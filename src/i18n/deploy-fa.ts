import type { SimulationResult } from "@/server/agent/types";
import type { PlanRecommendation } from "@/server/deploy/recommend";
import type { ChecklistItem, ReadinessReport } from "@/server/deploy/types";

/** Persian strings of the first-deployment journey (Phase 1E). Simple language first; raw API terms only in advanced details. */

export const zipReasonFa: Record<string, string> = {
  not_a_zip: "این فایل یک آرشیو ZIP معتبر نیست.",
  too_large: "حجم فایل از سقف مجاز بیشتر است.",
  too_many_entries: "تعداد فایل‌های داخل آرشیو بیش از حد مجاز است.",
  uncompressed_too_large: "حجم بازشدهٔ آرشیو از سقف مجاز بیشتر است.",
  file_too_large: "یکی از فایل‌های داخل آرشیو بیش از حد بزرگ است.",
  ratio_exceeded: "نسبت فشرده‌سازی مشکوک است (احتمال «بمب ZIP»).",
  unsafe_path: "مسیر یکی از فایل‌های آرشیو ناامن است (مثلاً خروج از پوشه).",
  symlink_or_special: "آرشیو شامل لینک نمادین یا فایل ویژه است که پذیرفته نمی‌شود.",
  duplicate_entry: "آرشیو شامل نام فایل تکراری است.",
  encrypted: "آرشیو رمزدار است و پذیرفته نمی‌شود.",
  unsupported_zip: "این نوع ZIP (ZIP64 یا چندبخشی یا روش فشرده‌سازی خاص) پشتیبانی نمی‌شود.",
  corrupt: "آرشیو خراب یا ناقص است.",
  size_mismatch: "اندازهٔ اعلام‌شدهٔ فایل‌ها با محتوای واقعی نمی‌خواند.",
  bad_content_type: "نوع فایل باید ZIP باشد.",
  empty: "فایل خالی است.",
  timeout: "زمان بارگذاری تمام شد.",
};

export const deployUi = {
  title: "مسیر اولین استقرار",
  intro: "پروژهٔ خود را به‌صورت ZIP بارگذاری کنید تا ببینیم چه چیزهایی لازم دارد، چه چیزی کم است و یک طرح استقرار شبیه‌سازی‌شده بسازیم. هیچ کدی اجرا نمی‌شود و هیچ چیزی در لیارا ساخته نمی‌شود.",
  steps: { upload: "بارگذاری پروژه", analysis: "تحلیل پروژه", checklist: "فهرست آمادگی", recommendation: "منابع پیشنهادی", plan: "طرح استقرار", approval: "تأیید", timeline: "اجرای شبیه‌سازی‌شده", result: "نتیجه و گام بعد" },
  upload: { label: "فایل ZIP پروژه", hint: "حداکثر ۲۰ مگابایت. فقط ریشهٔ پروژهٔ Next.js (دارای package.json). فایل‌های .env و node_modules خوانده نمی‌شوند.", button: "بارگذاری و تحلیل", busy: "در حال تحلیل ایستا…", notExecuted: "هیچ‌چیز از پروژهٔ شما اجرا، نصب یا ساخته نمی‌شود." },
  verdict: { READY: "آماده", READY_WITH_WARNINGS: "آماده با هشدار", NEEDS_CONFIGURATION: "نیازمند تنظیمات", BLOCKED: "مسدود", UNSUPPORTED: "پشتیبانی‌نشده" } as const,
  verdictHelp: {
    READY: "در بررسی ایستا مانعی دیده نشد. این به معنی تضمین موفقیت نیست.",
    READY_WITH_WARNINGS: "مانعی نیست ولی هشدارهایی هست که باید ببینید.",
    NEEDS_CONFIGURATION: "کارهای دستی باقی است؛ پس از انجام، آن‌ها را در فهرست تأیید کنید.",
    BLOCKED: "پیش از ادامه باید موانع زیر رفع شود و پروژه دوباره بارگذاری شود.",
    UNSUPPORTED: "این نوع پروژه هنوز تحلیل کامل نمی‌شود (این به معنی خراب‌بودن پروژه نیست).",
  } as const,
  staticOnly: "نتیجه فقط از خواندن ایستای فایل‌ها آمده است؛ ساخت و اجرای واقعی بررسی نشده.",
  detected: "آنچه پیدا شد",
  missing: "آنچه کم است یا باید رفع شود",
  security: "هشدارهای امنیتی",
  checklist: "فهرست کارهای شما",
  checklistHint: "کارهایی که فقط خودتان می‌توانید انجام دهید. وقتی انجام دادید، تیک بزنید.",
  state: { ok: "انجام‌شده خودکار", pending: "در انتظار", done: "تأیید شما", not_applicable: "لازم نیست", blocked: "مانع" } as const,
  classLabel: { A: "API مستند", B: "فقط در CLI رسمی دیده شده", C: "گام دستی", D: "تأییدنشده" } as const,
  rec: { title: "منابع پیشنهادی", approach: "روش پیشنهادی", resources: "منابع تقریبی", ram: "حافظه", cpu: "CPU", disk: "دیسک", reasons: "چرا؟", tradeoffs: "نکته‌ها و معاوضه‌ها", missing: "اطلاعاتی که کم است", manual: "کارهای دستی", traffic: "ترافیک مورد انتظار", trafficOptions: { unknown: "نمی‌دانم", low: "کم", medium: "متوسط", high: "زیاد" } as const, preliminary: "راهنمای اولیهٔ منابع (تأییدنشده) — نه پلن و نه قیمت" },
  plan: { title: "طرح استقرار", appName: "نام برنامه", appNameHint: "حروف کوچک انگلیسی، عدد و خط تیره (۳ تا ۴۲ نویسه)", scenario: "سناریوی آزمایش شبیه‌سازی", scenarioHint: "فقط برای دیدن رفتار مسیر؛ بخشی از طرح و امضای آن است.", prepare: "ساخت طرح برای بازبینی", preparing: "در حال ساخت طرح…", replan: "ساخت طرح جدید", review: "بازبینی و تأیید", simOnly: "این طرح فقط در شبیه‌سازی اجرا می‌شود؛ تأیید شما هرگز اجرای واقعی را مجاز نمی‌کند." },
  scenarios: { success: "موفق", missing_build_script: "نبود اسکریپت build", missing_config: "نبود تنظیمات الزامی", insufficient_permissions: "نبود دسترسی کافی", build_failure: "شکست ساخت", startup_failure: "شکست راه‌اندازی", health_failure: "شکست بررسی سلامت" } as const,
  timeline: { title: "اجرای شبیه‌سازی‌شده", ok: "انجام شد (شبیه‌سازی)", failed: "شکست (شبیه‌سازی)", notRun: "اجرا نشد", log: "گزارش ساختگی" },
  result: {
    success: "شبیه‌سازی استقرار کامل شد — هیچ برنامه واقعی ساخته نشد.",
    failed: "شبیه‌سازی در یک مرحله متوقف شد — هیچ تغییر واقعی انجام نشد.",
    next: "گام‌های بعدی",
    nextSuccess: ["اگر خروجی را می‌پسندید، برای استقرار واقعی باید در آینده مسیر اجرای واقعی با تأیید جدید و جداگانه فعال شود (هنوز وجود ندارد).", "تا آن زمان می‌توانید پروژه را در کنسول لیارا یا با CLI رسمی به‌صورت دستی مستقر کنید.", "تأیید این شبیه‌سازی هیچ‌وقت برای اجرای واقعی معتبر نیست."],
    nextFailed: ["مشکل مرحلهٔ شکست‌خورده را رفع کنید (یا سناریوی دیگری را امتحان کنید).", "با «ساخت طرح جدید» دوباره بازبینی کنید."],
    noUrl: "نشانی واقعی ساخته نشد — این یک شبیه‌سازی است.",
    noRelease: "شناسهٔ نسخه در شبیه‌سازی ساخته نمی‌شود.",
  },
  advanced: "جزئیات فنی (برای کاربران پیشرفته)",
  strategyTitle: "مسیر اجرای آینده (فقط شبیه‌سازی می‌شود)",
  githubTitle: "مسیر جداگانه: CI",
  errors: {
    network: "ارتباط با سرور برقرار نشد؛ دوباره تلاش کنید.",
    pickFile: "ابتدا یک فایل ZIP انتخاب کنید.",
  },
  cancelProposal: "لغو طرح",
};

export function uploadPromptFa(): string {
  return "برای این کار ابتدا پروژه‌تان را به‌صورت فایل ZIP بارگذاری کنید (دکمهٔ «بارگذاری پروژه» در پنل مسیر استقرار). من فقط فایل‌ها را «می‌خوانم»؛ هیچ کدی اجرا و هیچ چیزی در لیارا ساخته نمی‌شود.";
}

export function readinessText(r: ReadinessReport): string {
  const lines = [`نتیجهٔ بررسی ایستا: «${r.verdictFa}». ${r.summaryFa}`, r.staticNoticeFa];
  if (r.nextActionsFa.length) lines.push("کارهای بعدی:\n" + r.nextActionsFa.slice(0, 6).map((a) => `• ${a}`).join("\n"));
  return lines.join("\n\n");
}

export function checklistText(r: ReadinessReport): string {
  const pending = r.checklist.filter((c) => c.state === "pending" || c.state === "blocked");
  const done = r.checklist.filter((c) => c.state === "ok" || c.state === "done");
  const fmt = (c: ChecklistItem) => `• ${c.titleFa}${c.kind === "manual" ? " (کار دستی)" : ""}`;
  return [pending.length ? `هنوز کم دارید:\n${pending.map(fmt).join("\n")}` : "طبق بررسی ایستا چیز اجباری کم نیست.", done.length ? `آماده است:\n${done.slice(0, 6).map(fmt).join("\n")}` : "", r.staticNoticeFa].filter(Boolean).join("\n\n");
}

export function recommendationText(rec: PlanRecommendation): string {
  const r = rec.resources;
  return [`${rec.labelFa}: ${rec.approach.titleFa}.`, `حافظهٔ تقریبی: حداقل ${r.ramMbMin}MB، توصیه ${r.ramMbRecommended}MB؛ دسته: ${rec.categoryFa}.`, rec.pricingFa, rec.tradeoffsFa.length ? "نکته‌ها:\n" + rec.tradeoffsFa.slice(0, 3).map((t) => `• ${t}`).join("\n") : ""].filter(Boolean).join("\n\n");
}

export function planProposalText(appName: string): string {
  return `طرح استقرار شبیه‌سازی‌شدهٔ «${appName}» آماده است. آن را در پنل مسیر استقرار بازبینی کنید. برای تأیید باید نام برنامه را تایپ کنید. تأیید فقط یک «شبیه‌سازی» را اجرا می‌کند و هیچ چیز واقعی ساخته نمی‌شود.`;
}

export function planRefusalText(reason: string): string {
  const m: Record<string, string> = {
    not_supported: "این نوع پروژه هنوز پشتیبانی نمی‌شود؛ طرحی ساخته نشد.",
    blocked: "موانعی وجود دارد؛ تا رفع نشوند طرحی ساخته نمی‌شود. فهرست موانع را در گزارش ببینید.",
    needs_configuration: "هنوز کارهای دستی باقی است (متغیرها یا پایگاه‌داده). آن‌ها را در فهرست آمادگی تأیید کنید و دوباره درخواست دهید.",
    invalid_app_name: "نام برنامه نامعتبر است (حروف کوچک انگلیسی، عدد و خط تیره).",
    unsafe_command: "فرمان‌های ساخت/اجرا از قالب مجاز بیرون است؛ طرحی ساخته نشد.",
  };
  return m[reason] ?? "ساخت طرح ممکن نشد.";
}

export function deploymentResultText(r: SimulationResult): string {
  const d = r.deployment;
  if (!d) return deployUi.result.failed;
  if (r.outcome === "succeeded") return `${deployUi.result.success} ${deployUi.result.noUrl}`;
  const stage = d.stages.find((s) => s.id === d.failedStage);
  return `${deployUi.result.failed} مرحلهٔ متوقف‌شده: «${stage?.labelFa ?? "?"}». ${stage?.detailFa ?? ""}`;
}
