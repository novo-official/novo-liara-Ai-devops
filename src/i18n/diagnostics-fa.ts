import type { Availability, Confidence, Finding, Hypothesis, Intent, SourceKey } from "@/server/diagnostics/types";

/** Persian text for the diagnostic engine. Findings carry codes and numbers; every sentence is built here from facts, never from log text. */

const n = (x: unknown): string => new Intl.NumberFormat("fa-IR").format(Number(x));
const s = (x: unknown): string => String(x ?? "");

export const intentLabel: Record<Intent, string> = {
  why_restarting: "چرا برنامهٔ من مدام ری‌استارت می‌شود؟",
  why_slow: "چرا وب‌سایت من کند است؟",
  investigate_http_500: "بررسی احتمال خطای HTTP 500",
  recent_deployment_failures: "تحلیل شکست‌های اخیر استقرار (deployment)",
};

export const sourceLabel: Record<SourceKey, string> = {
  app: "جزئیات برنامه",
  runtime: "وضعیت اجرا (applets)",
  releases: "تاریخچهٔ نسخه‌ها",
  events: "رویدادها",
  logs: "لاگ‌ها",
  cpu: "متریک CPU",
  memory: "متریک حافظه",
};

export const availabilityLabel: Record<Availability, string> = {
  available: "در دسترس",
  missing: "بدون داده (پاسخ موفق ولی خالی)",
  unsupported: "پشتیبانی نمی‌شود / در دسترس نیست",
  access_denied: "دسترسی رد شد",
  stale: "قدیمی",
  contract_mismatch: "ناسازگاری قالب پاسخ",
  no_content: "پاسخ بدون محتوا (۲۰۴) — قابل‌اعتبارسنجی نیست",
  collection_failed: "جمع‌آوری ناموفق (خطا/زمان‌سنجی)",
};

export const confidenceLabel: Record<Confidence, string> = {
  HIGH: "اطمینان بالا",
  MEDIUM: "اطمینان متوسط",
  LOW: "اطمینان پایین",
  INSUFFICIENT_EVIDENCE: "شواهد ناکافی",
};

export const confidenceHelp: Record<Confidence, string> = {
  HIGH: "مشاهدهٔ مستقیم و صریح، دست‌کم از دو منبع مستقل (یا نشانهٔ صریح بدون ابهام) و بدون تناقض.",
  MEDIUM: "مشاهدهٔ صریح از یک منبع، یا استنتاج که فقط بر همبستگی استوار است.",
  LOW: "نشانهٔ ضعیف: یک رخداد، یا مقدار خام با واحد تأییدنشده.",
  INSUFFICIENT_EVIDENCE: "داده‌ای برای نتیجه‌گیری وجود ندارد یا قابل‌استفاده نیست.",
};

const hypothesisTitles: Record<string, string> = {
  crash_loop: "حلقهٔ ری‌استارت (crash loop)",
  isolated_restart: "ری‌استارت مجزا (نه حلقه)",
  db_connection_refused: "اتصال به پایگاه‌داده رد شد (connection refused)",
  db_connection_timeout: "اتصال به پایگاه‌داده زمان‌سنجی شد (timeout)",
  db_dns_failure: "نام میزبان پایگاه‌داده resolve نشد (DNS)",
  db_authentication_failure: "احراز هویت پایگاه‌داده ناموفق بود",
  missing_configuration: "پیکربندی/متغیر محیطی لازم موجود نیست",
  oom_kill: "پایان فرایند به‌دلیل کمبود حافظه (OOM)",
  memory_exhaustion_in_process: "اتمام حافظهٔ داخل فرایند برنامه",
  memory_growth_unverified: "رشد مقدار خام حافظه (واحد تأییدنشده)",
  memory_pressure: "فشار حافظه نسبت به ظرفیت معلوم",
  cpu_saturation: "اشباع CPU نسبت به ظرفیت معلوم",
  release_regression: "همبستگی زمانی خطاها با آخرین انتشار",
  release_failed: "شکست در انتشار اخیر",
  http_500: "خطای صریح HTTP 500 در لاگ‌ها",
  insufficient_evidence: "شواهد ناکافی",
  restart_loop_db_connection_refused: "حلقهٔ ری‌استارت همراه با رد شدن اتصال دیتابیس",
  restart_loop_db_connection_timeout: "حلقهٔ ری‌استارت همراه با timeout اتصال دیتابیس",
  restart_loop_db_dns_failure: "حلقهٔ ری‌استارت همراه با خطای DNS دیتابیس",
  restart_loop_db_authentication_failure: "حلقهٔ ری‌استارت همراه با خطای احراز هویت دیتابیس",
  restart_loop_missing_configuration: "حلقهٔ ری‌استارت همراه با نبودِ پیکربندی",
  restart_loop_oom_kill: "حلقهٔ ری‌استارت همراه با OOM",
};
export const hypothesisTitle = (key: string): string => hypothesisTitles[key] ?? key;

const dbCat: Record<string, string> = { refused: "رد شدن اتصال", timeout: "timeout", dns: "DNS", auth: "احراز هویت" };

/** One sentence per finding, built only from structured facts. */
export function findingText(f: Finding): string {
  const d = f.data;
  switch (f.hypothesis) {
    case "crash_loop":
      return `${n(d.cycles)} چرخهٔ ری‌استارت/خروج با زمان‌بندی مشخص در ${n(d.spanMinutes)} دقیقه دیده شد (رویداد: ${n(d.eventCycles)}، لاگ: ${n(d.logCycles)}).`;
    case "isolated_restart":
      return `${n(d.cycles)} ری‌استارت مجزا دیده شد؛ برای «حلقه» دست‌کم ۳ چرخه لازم است، پس این به‌تنهایی حلقهٔ ری‌استارت نیست.`;
    case "db_connection_refused":
    case "db_connection_timeout":
    case "db_dns_failure":
    case "db_authentication_failure":
      return `${n(d.count)} خط خطای اتصال به پایگاه‌داده از نوع «${dbCat[s(d.category)] ?? s(d.category)}» دیده شد (اطلاعات ورود و میزبان‌های خصوصی حذف/نام‌مستعار شده‌اند).`;
    case "missing_configuration": {
      const names = (d.names as string[]) ?? [];
      const absent = (d.absent as string[]) ?? [];
      const present = (d.presentButFailing as string[]) ?? [];
      let t = names.length ? `خطای نبودِ پیکربندی برای متغیر(های) ${names.join("، ")} دیده شد (فقط نام؛ مقدار هرگز خوانده یا نمایش داده نمی‌شود).` : "خطای عمومی پیکربندی دیده شد، بدون نام متغیر مشخص.";
      if (absent.length) t += ` در فهرست کلیدهای پیکربندی‌شدهٔ برنامه موجود نیست: ${absent.join("، ")}.`;
      if (present.length) t += ` کلید موجود است ولی خطا ادامه دارد (مقدار قابل‌بررسی نیست): ${present.join("، ")}.`;
      return t;
    }
    case "oom_kill":
      return d.via === "explicit_oom_signal"
        ? `${n(d.count)} نشانهٔ صریح OOM (کمبود حافظه) در رویداد/لاگ/دلیل applet دیده شد.`
        : `${n(d.count)} خروج با کد ۱۳۷ (SIGKILL) دیده شد؛ این معمولاً با OOM همراه است ولی اثبات آن نیست.`;
    case "memory_exhaustion_in_process":
      return `${n(d.count)} خطای کمبود حافظهٔ داخل فرایند (heap/MemoryError) دیده شد؛ لزوماً سقف حافظهٔ کانتینر نیست.`;
    case "memory_growth_unverified":
      return `مقدار خام حافظه حدود ${n(d.growthRatio)} برابر رشد کرده است؛ چون واحد و ظرفیت تأیید نشده، نمی‌توان از «اتمام حافظه» حرف زد.`;
    case "memory_pressure":
      return `مصرف حافظه در ${n(d.samples)} نمونهٔ آخر بیش از ۹۰٪ ظرفیت معلوم (${n(d.limit)} ${s(d.unit)}) بوده است.${d.semanticsOrigin === "simulated_fixture" ? " (واحد/ظرفیت شبیه‌سازی‌شده)" : ""}`;
    case "cpu_saturation":
      return `مصرف CPU در ${n(d.samples)} نمونهٔ آخر بیش از ۹۰٪ ظرفیت معلوم (${n(d.limit)} ${s(d.unit)}) بوده است؛ این مصرف است نه تأخیر اندازه‌گیری‌شده.${d.semanticsOrigin === "simulated_fixture" ? " (واحد/ظرفیت شبیه‌سازی‌شده)" : ""}`;
    case "release_regression":
      return `پس از انتشار نسخهٔ ${s(d.releaseTag)}، سیگنال‌های خطا از ${n(d.errorsBefore)} (پیش) به ${n(d.errorsAfter)} (پس) رسید و نخستین خطا ${n(d.firstErrorMinutesAfterRelease)} دقیقه بعد از انتشار بود. این همبستگی زمانی است، نه اثبات علّیت.`;
    case "release_failed":
      return `${n(d.count)} انتشار اخیر وضعیتی شبیه شکست دارد؛ آخرین: ${s(d.latestTag)} (${s(d.latestState)}). ${d.failedIsCurrent ? "این نسخه نسخهٔ فعلی است." : "این نسخه فعلی نشده؛ نسخهٔ در حال اجرا مستقیماً از آن تأثیر نمی‌پذیرد."}`;
    case "http_500":
      return `${n(d.count500)} خط صریح HTTP 500 در ${n(d.sampledLines)} خط لاگ نمونه‌برداری‌شده دیده شد${d.truncated ? " (لاگ‌ها بریده شده‌اند؛ شمارش حداقلی است)" : ""}. نرخ خطا قابل محاسبه نیست.`;
    case "insufficient_evidence":
      return `برای تشخیص، لاگ یا رویدادی در دسترس نیست: ${((d.reasons as string[]) ?? []).map((r) => { const [src, av] = r.split(":"); return `${sourceLabel[src as SourceKey] ?? src}: ${availabilityLabel[av as Availability] ?? av}`; }).join("؛ ")}.`;
    default:
      return f.hypothesis;
  }
}

/** Inference sentences created by the aggregator. */
export function inferenceText(f: Finding): string {
  const d = f.data;
  if (d.relation === "restart_loop_with_cause") {
    const cycles = Number(d.cycles);
    if (d.precedingShare === null) return "ترتیب زمانی خطا و ری‌استارت‌ها قابل بررسی نیست؛ ارتباط علّی فقط محتمل است، نه ثابت‌شده.";
    return `از ${n(cycles)} چرخهٔ ری‌استارت، ${n(Math.round(Number(d.precedingShare) * cycles))} مورد کمتر از ۲ دقیقه پس از این خطا رخ داد. این همبستگی زمانی است، نه اثبات علّیت.`;
  }
  if (Array.isArray(d.relatedHypotheses)) return `خطاهای HTTP 500 هم‌زمان با نشانه‌های دیگر دیده شد (${(d.relatedHypotheses as string[]).map(hypothesisTitle).join("، ")})؛ رابطهٔ آن‌ها فقط محتمل است.`;
  return findingText(f);
}

const lim: Record<string, string> = {
  logs_truncated: "لاگ‌ها به ۲۰۰ خط آخر محدود شده‌اند؛ شمارش‌ها حداقلی‌اند.",
  single_occurrence: "فقط یک رخداد دیده شد.",
  single_restart_not_a_loop: "ری‌استارت‌های کمتر از ۳ چرخه حلقه محسوب نمی‌شوند.",
  single_source_restart_evidence: "شواهد ری‌استارت فقط از یک منبع آمده است.",
  runtime_restarting_without_timestamps: "وضعیت applet «ری‌استارت/خطا» است ولی شاهدی با زمان‌بندی برای اثبات حلقه وجود ندارد.",
  no_timeline_evidence: "هیچ منبع زمان‌دار (لاگ یا رویداد) در دسترس نیست.",
  env_keys_unavailable: "فهرست کلیدهای پیکربندی در دسترس نبود؛ نبودِ متغیر قابل تأیید نیست.",
  env_key_present_value_unverifiable: "کلید پیکربندی وجود دارد؛ درستی مقدار آن قابل‌بررسی نیست (مقدارها هرگز خوانده نمی‌شوند).",
  config_error_without_variable_name: "خطای پیکربندی بدون نام متغیر مشخص است.",
  exit137_not_proof_of_oom: "کد ۱۳۷ اثبات OOM نیست؛ هر SIGKILL این کد را می‌دهد.",
  process_heap_limit_not_container_limit: "سقف heap فرایند با سقف حافظهٔ کانتینر یکی نیست.",
  memory_units_unverified: "واحد متریک حافظه تأیید نشده؛ ادعای اتمام حافظه از روی مقدار خام ممکن نیست.",
  raw_values_only: "فقط مقدار خام موجود است.",
  memory_limit_unknown: "ظرفیت حافظهٔ پلن معلوم نیست؛ نسبت مصرف قابل‌محاسبه نیست.",
  cpu_units_unverified: "واحد متریک CPU تأیید نشده؛ هیچ درصدی از مقدار خام استنباط نمی‌شود.",
  cpu_limit_unknown: "سقف CPU پلن معلوم نیست؛ اشباع قابل‌ارزیابی نیست.",
  utilisation_not_latency: "مصرف بالای CPU با کندیِ اندازه‌گیری‌شده یکی نیست.",
  simulated_semantics: "واحد/ظرفیت این متریک شبیه‌سازی‌شده است (فیکسچر آزمایشی).",
  release_state_vocabulary_unverified: "واژگان وضعیت انتشار هنوز با API زنده تأیید نشده است.",
  failed_release_is_not_current: "انتشار ناموفق نسخهٔ فعلی نشده است.",
  release_outside_window: "زمان آخرین انتشار خارج از بازهٔ بررسی است؛ مقایسه ممکن نیست.",
  no_release_history: "تاریخچهٔ نسخه‌ای وجود ندارد.",
  no_pre_release_baseline: "پیش از انتشار داده‌ی کافی برای مقایسه (baseline) نیست.",
  correlation_not_causation: "همبستگی زمانی علّیت را ثابت نمی‌کند.",
  no_http_error_rate: "API متریک وضعیت HTTP یا شمار درخواست‌ها ندارد؛ نرخ خطا محاسبه نمی‌شود.",
  no_http_probe: "هیچ probe سلامت HTTP تأییدشده‌ای وجود ندارد.",
  cause_ordering_unverifiable: "ترتیب زمانی علت و ری‌استارت‌ها قابل بررسی نیست.",
  conflicting_db_categories: "چند نوع خطای متفاوت دیتابیس هم‌زمان دیده شد؛ شواهد با هم در تناقض‌اند.",
  runtime_running_older_than_restarts: "وضعیت اجرا می‌گوید همهٔ نمونه‌ها قدیمی‌تر از ری‌استارت‌ها و سالم‌اند؛ با شواهد ری‌استارت در تناقض است.",
};

export function limitationText(code: string): string {
  if (lim[code]) return lim[code];
  let m = /^src_([a-z]+)_([a-z_]+)$/.exec(code);
  if (m) return `${sourceLabel[m[1] as SourceKey] ?? m[1]}: ${availabilityLabel[m[2] as Availability] ?? m[2]}.`;
  m = /^(cpu|memory)_metrics_([a-z_]+)$/.exec(code);
  if (m) return `${m[1] === "cpu" ? "متریک CPU" : "متریک حافظه"}: ${m[2] === "stale" ? "قدیمی است و در تحلیل استفاده نشد" : (availabilityLabel[m[2] as Availability] ?? m[2])}.`;
  return code;
}

export const caveatText: Record<string, string> = {
  simulated_data: "همهٔ داده‌ها شبیه‌سازی‌شده‌اند و از لیارا نمی‌آیند.",
  contract_unverified: "قرارداد API هنوز با پاسخ زندهٔ لیارا تأیید نشده است؛ برداشت‌ها مشروط‌اند.",
  no_content_observed: "یکی از منابع با «بدون محتوا» (HTTP 204) پاسخ داد؛ این به‌معنی «رویدادی وجود ندارد» نیست و محتوای آن اعتبارسنجی نشده است. نبودِ شاهد، نشانهٔ سالم‌بودن نیست.",
  simulated_semantics: "واحد/ظرفیت متریک در این گزارش شبیه‌سازی‌شده است.",
  injection_suspected: "در لاگ‌ها متنی شبیه دستور دیده شد؛ این متن فقط داده است و هیچ اقدامی بر پایهٔ آن انجام یا پیشنهاد نمی‌شود.",
  runtime_interpretation_heuristic: "تفسیر وضعیت applet استنباطی است (واژگان تأییدنشده).",
};

export function statusText(status: string): string {
  return status === "ISSUES_FOUND" ? "نشانه‌هایی از مشکل در شواهد بررسی‌شده پیدا شد" : status === "NO_ANOMALY_IN_EXAMINED_EVIDENCE" ? "در شواهد بررسی‌شده ناهنجاری مشخصی پیدا نشد (این به‌معنی سلامت تأییدشده نیست)" : "شواهد برای تشخیص کافی نیست";
}

export function summaryText(args: { status: string; primary: Hypothesis | undefined; overall: Confidence; intent: Intent; missingCount: number }): string {
  const { status, primary, overall, intent, missingCount } = args;
  const head = `درخواست: «${intentLabel[intent]}». `;
  if (status === "INSUFFICIENT_EVIDENCE") return `${head}${statusText(status)}. هیچ علتی ادعا نمی‌شود؛ پایین‌تر دلیل ناکافی بودن و کارهای پیشنهادی آمده است.`;
  if (status === "NO_ANOMALY_IN_EXAMINED_EVIDENCE") return `${head}${statusText(status)}. نبودِ شواهد مشکل، تأیید سلامت نیست${missingCount ? ` و ${n(missingCount)} منبع داده ناقص یا نامعتبر بود` : ""}.`;
  return `${head}محتمل‌ترین فرضیه: «${hypothesisTitle(primary!.key)}» با ${confidenceLabel[overall]}. این گزارش مشاهده‌ها و استنتاج‌ها را جدا می‌کند و بدون شاهد، علت قطعی ادعا نمی‌کند.${missingCount ? ` ${n(missingCount)} منبع داده ناقص بود.` : ""}`;
}
