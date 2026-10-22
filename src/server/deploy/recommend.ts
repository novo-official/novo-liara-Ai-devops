import type { SourceAnalysis } from "./types";

/**
 * Explainable resource guidance. It outputs PRELIMINARY guidance unless a verified plan catalogue with verified units is supplied.
 * Phase 1E never has such a catalogue (GET /v1/me is free-form and unverified), so no plan id or price is ever produced in production:
 * the gate exists so that, once the catalogue is verified live, ids/prices can appear without changing callers — and so tests can prove the gate.
 */

export type Traffic = "unknown" | "low" | "medium" | "high";
export const TRAFFIC_VALUES: Traffic[] = ["unknown", "low", "medium", "high"];

export interface PlanCatalogue {
  verified: boolean;
  unitsVerified: boolean;
  priceUnitVerified: boolean;
  plans: { id: string; ramMb: number; cpu: number; diskGb: number | null; priceMonthly: number | null; available: boolean }[];
}

export interface RecommendInput {
  analysis: SourceAnalysis;
  traffic?: Traffic;
  /** user-declared extra needs not visible in the source */
  needsBackgroundWorker?: boolean;
  constraints?: { maxRamMb?: number | null };
  catalogue?: PlanCatalogue | null;
}

export type Category = "starter" | "standard" | "performance";
export interface PlanRecommendation {
  approach: { id: "next_server" | "static_export"; titleFa: string; platformCandidate: "next" | "static"; reasonsFa: string[] };
  resources: { ramMbMin: number; ramMbRecommended: number; cpuCores: number; diskGb: number | null };
  category: Category;
  categoryFa: string;
  liaraPlan: { id: string; ramMb: number; priceMonthly: number | null } | null;
  labelFa: string;
  pricingFa: string;
  reasoning: { factor: string; evidence: string; effectFa: string }[];
  missingInformationFa: string[];
  tradeoffsFa: string[];
  manualStepsFa: string[];
  catalogueUsed: boolean;
}

const CAT_FA: Record<Category, string> = { starter: "پایه (کوچک)", standard: "استاندارد (متوسط)", performance: "پرقدرت (بزرگ)" };

export function recommend(i: RecommendInput): PlanRecommendation {
  const a = i.analysis;
  const traffic = i.traffic ?? "unknown";
  const reasoning: PlanRecommendation["reasoning"] = [];
  const tradeoffs: string[] = [];
  const missing: string[] = [];
  const manual: string[] = [];

  const isExport = a.runtime.output === "export";
  const approach: PlanRecommendation["approach"] = isExport
    ? { id: "static_export", platformCandidate: "static", titleFa: "میزبانی فایل‌های استاتیک (خروجی export)", reasonsFa: ["در next.config خروجی استاتیک انتخاب شده؛ سرور Next.js لازم نیست.", "شناسهٔ پلتفرم «static» فقط از CLI رسمی مشاهده شده و تأیید زنده نشده است."] }
    : { id: "next_server", platformCandidate: "next", titleFa: "اجرای برنامهٔ Next.js روی پلتفرم next", reasonsFa: ["پروژه به رندر سمت سرور/مسیرهای API نیاز دارد یا خروجی استاتیک انتخاب نشده است.", "شناسهٔ پلتفرم «next» فقط از CLI رسمی مشاهده شده و تأیید زنده نشده است."] };
  reasoning.push({ factor: "framework", evidence: a.runtime.router !== "none" ? `router=${a.runtime.router}, output=${a.runtime.output}` : "output=" + a.runtime.output, effectFa: isExport ? "منابع اجرا بسیار کمتر از حالت سرور است." : "یک پردازش Node.js دائمی نیاز است." });

  // memory floor / recommendation (heuristic guidance, NOT a Liara measurement)
  let min = isExport ? 128 : 512;
  let rec = isExport ? 256 : 1024;
  if (!isExport) {
    if (traffic === "medium") { min = 1024; rec = 2048; }
    if (traffic === "high") { min = 2048; rec = 4096; }
    if (traffic === "low") rec = 768;
  }
  reasoning.push({ factor: "traffic", evidence: traffic, effectFa: traffic === "unknown" ? "ترافیک نامشخص است؛ فرض محافظه‌کارانه و کم‌ترافیک." : `برآورد ترافیک «${traffic}» حد حافظه را تعیین کرد.` });
  if (traffic === "unknown") missing.push("ترافیک مورد انتظار (کم/متوسط/زیاد) مشخص نیست.");
  if (a.database.some((d) => d.engine === "prisma_unknown" || d.viaDependency === "@prisma/client" || d.viaDependency === "prisma")) { rec += 256; reasoning.push({ factor: "orm", evidence: "prisma", effectFa: "موتور Prisma حافظهٔ اضافه مصرف می‌کند (راهنمای تقریبی)." }); }
  if (a.runtime.nextMajor !== null && a.runtime.nextMajor >= 14 && !isExport) tradeoffs.push("مرحلهٔ ساخت Next.js ممکن است از اجرای عادی حافظهٔ بیشتری بخواهد؛ اگر ساخت با کمبود حافظه شکست خورد، پلن بزرگ‌تر لازم است.");
  const needsBg = !!i.needsBackgroundWorker || a.backgroundHints.length > 0;
  if (needsBg) { tradeoffs.push("کارهای پس‌زمینه/زمان‌بندی‌شده در همان پردازش وب می‌توانند با ری‌استارت یا مقیاس‌بندی مختل شوند؛ پردازش جداگانه توصیه می‌شود و در این نسخه بررسی نمی‌شود."); reasoning.push({ factor: "background", evidence: a.backgroundHints[0] ?? "user", effectFa: "نیاز احتمالی به پردازش جدا." }); }
  const wantsDisk = a.database.some((d) => d.fileBased) || a.storageHints.length > 0;
  const diskGb = wantsDisk ? 1 : null;
  if (wantsDisk) { reasoning.push({ factor: "storage", evidence: a.database.some((d) => d.fileBased) ? "sqlite" : a.storageHints[0]!, effectFa: "دیسک دائمی لازم است (حدس اولیهٔ ۱ گیگابایت)." }); manual.push("دیسک دائمی را خودتان بسازید و اندازه را بر پایهٔ حجم دادهٔ واقعی تعیین کنید."); }
  if (a.database.some((d) => d.needsService)) { manual.push("سرویس پایگاه‌داده را جداگانه بسازید؛ منابع آن جدا از پلن برنامه محاسبه می‌شود."); missing.push("نوع و اندازهٔ پایگاه‌داده (ساخت آن توسط این ابزار انجام نمی‌شود)."); }
  manual.push("شارژ حساب و خرید یا ارتقای پلن فقط دستی و به عهدهٔ شماست؛ این ابزار هیچ هزینه‌ای ایجاد نمی‌کند.");

  const maxRam = i.constraints?.maxRamMb ?? null;
  let constraintConflict = false;
  if (maxRam !== null) {
    if (maxRam < min) { constraintConflict = true; tradeoffs.push(`سقف حافظهٔ شما (${maxRam}MB) کمتر از حداقل برآوردی (${min}MB) است؛ احتمال شکست ساخت یا اجرا بالا است.`); }
    else if (maxRam < rec) { tradeoffs.push(`سقف حافظهٔ شما (${maxRam}MB) کمتر از مقدار توصیه‌شده (${rec}MB) است؛ برنامه با حاشیهٔ کم اجرا می‌شود.`); rec = maxRam; }
    reasoning.push({ factor: "constraint", evidence: `maxRam=${maxRam}`, effectFa: constraintConflict ? "با حداقل برآوردی ناسازگار است." : "توصیه به سقف شما محدود شد." });
  }
  const category: Category = rec <= 1024 ? "starter" : rec <= 2048 ? "standard" : "performance";
  const cpuCores = rec >= 4096 ? 2 : 1;

  // catalogue gate: ids and prices ONLY from a verified catalogue with verified units
  const cat = i.catalogue;
  let liaraPlan: PlanRecommendation["liaraPlan"] = null;
  let pricing = "نام پلن‌ها و قیمت فعلی نمایش داده نمی‌شود: فهرست پلن‌های حساب هنوز با پاسخ زندهٔ لیارا تأیید نشده و واحد قیمت مشخص نیست. این فقط «راهنمای اولیهٔ منابع» است، نه قیمت یا پیشنهاد پلن.";
  let label = "راهنمای اولیهٔ منابع (تأییدنشده)";
  let used = false;
  if (cat && cat.verified && cat.unitsVerified) {
    const ok = cat.plans.filter((p) => p.available && p.ramMb >= (constraintConflict ? min : rec)).sort((x, y) => x.ramMb - y.ramMb);
    const pick = ok[0];
    if (pick) {
      used = true;
      liaraPlan = { id: pick.id, ramMb: pick.ramMb, priceMonthly: cat.priceUnitVerified ? pick.priceMonthly : null };
      label = "بر پایهٔ کاتالوگ تأییدشده";
      pricing = cat.priceUnitVerified && pick.priceMonthly !== null ? `قیمت ماهانه (طبق کاتالوگ تأییدشده): ${pick.priceMonthly}.` : "شناسهٔ پلن از کاتالوگ تأییدشده است ولی واحد قیمت تأیید نشده؛ قیمت نمایش داده نمی‌شود.";
    } else tradeoffs.push("پلنی مطابق نیازها در کاتالوگ در دسترس نبود.");
  }
  missing.push("نیاز واقعی به حافظه و CPU فقط با ساخت و اجرای واقعی و مشاهدهٔ متریک‌ها مشخص می‌شود.");

  return {
    approach,
    resources: { ramMbMin: min, ramMbRecommended: rec, cpuCores, diskGb },
    category,
    categoryFa: CAT_FA[category],
    liaraPlan,
    labelFa: label,
    pricingFa: pricing,
    reasoning,
    missingInformationFa: missing,
    tradeoffsFa: tradeoffs,
    manualStepsFa: manual,
    catalogueUsed: used,
  };
}
