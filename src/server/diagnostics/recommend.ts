import { createHash } from "node:crypto";
import type { Diagnosis, Hypothesis, Recommendation, Risk } from "./types";

/**
 * Recommendation policy (docs/DIAGNOSTIC_ENGINE.md). Recommendations are derived ONLY from deterministic hypotheses —
 * never from LLM text or from instruction-like content in logs. Nothing here executes anything (`executableNow: false`).
 *   R0 read/manual advice · R1 restart-class · R2 config / plan / deploy changes · R3 destructive (never recommended)
 * Context rules: a database failure never yields a memory upgrade; a restart is never offered as a guaranteed fix and only
 * after the cause is fixed; env/plan/deploy changes always require approval and are marked as future (Phase 1D+) operations.
 */

type OpKind = NonNullable<Recommendation["operation"]>["kind"];
type Tpl = Omit<Recommendation, "id" | "relatedDiagnosis" | "evidenceIds" | "executableNow" | "requiresApproval" | "operation"> & { tplId: string; op?: OpKind };

const manual = (tplId: string, risk: Risk, descriptionFa: string, expectedImpactFa: string, prerequisitesFa: string[], verificationPlanFa: string[]): Tpl => ({ tplId, risk, descriptionFa, expectedImpactFa, prerequisitesFa, verificationPlanFa, actor: "operator_manual" });
const future = (tplId: string, risk: Risk, descriptionFa: string, expectedImpactFa: string, prerequisitesFa: string[], verificationPlanFa: string[], op?: OpKind): Tpl => ({ tplId, risk, descriptionFa, expectedImpactFa, prerequisitesFa, verificationPlanFa, actor: "liara_operation_future", op });

const NEW_LOGS = "پس از رفع، لاگ‌های ۱۵ دقیقهٔ جدید را دوباره بررسی کنید: همان خط‌های خطا نباید تکرار شوند.";
const NO_RESTARTS = "در رویدادهای بازهٔ جدید، چرخهٔ ری‌استارت جدیدی نباید ثبت شود.";

const DB: Record<string, Tpl[]> = {
  db_connection_refused: [
    manual("db-up", "R0", "بررسی کنید سرویس پایگاه‌داده روشن و در دسترس است و آدرس/پورت مقصد درست است (از کنسول سرویس دیتابیس).", "اگر دیتابیس خاموش یا آدرس اشتباه باشد، رفع آن باید خطاهای «رد شدن اتصال» را متوقف کند.", ["دسترسی به کنسول سرویس پایگاه‌داده"], [NEW_LOGS]),
    manual("db-keys", "R0", "نام کلیدهای پیکربندی اتصال (فقط نام، نه مقدار) را در تنظیمات برنامه بررسی کنید و با آدرس واقعی دیتابیس تطبیق دهید.", "نام/آدرس نادرست اتصال یکی از دلایل رایج این خطاست.", ["دسترسی به تنظیمات برنامه"], [NEW_LOGS]),
  ],
  db_connection_timeout: [
    manual("db-timeout", "R0", "بار پایگاه‌داده، قوانین شبکه/فایروال و تنظیمات connection pool و timeout را بررسی کنید.", "اگر دیتابیس کند یا شبکه محدود باشد، رفع آن زمان‌سنجی‌ها را کم می‌کند.", ["دسترسی به متریک‌ها/کنسول دیتابیس"], [NEW_LOGS]),
  ],
  db_dns_failure: [
    manual("db-dns", "R0", "نام میزبان در متغیر اتصال (فقط نام کلید را بررسی کنید) و وجود سرویس در همان شبکه را تأیید کنید.", "نام میزبان نادرست یا خارج از شبکه، خطای DNS می‌دهد.", ["دسترسی به تنظیمات برنامه و سرویس دیتابیس"], [NEW_LOGS]),
    future("db-dns-env", "R2", "در صورت نادرست بودن نام میزبان، مقدار متغیر اتصال را به‌روزرسانی کنید (مقدار را خودتان وارد می‌کنید؛ این ابزار آن را نمی‌بیند).", "اصلاح نام میزبان باید خطای DNS را رفع کند.", ["تأیید تأثیر ری‌استارت ناشی از تغییر متغیر (مشاهدهٔ CLI، تأییدنشده)", "تأیید و تصویب صریح اپراتور"], [NEW_LOGS, NO_RESTARTS], "update_env"),
  ],
  db_authentication_failure: [
    manual("db-auth", "R0", "درستی نام کاربری/گذرواژهٔ دیتابیس را در سمت خود دیتابیس بررسی کنید (آیا کاربر وجود دارد و گذرواژه تغییر نکرده است؟).", "اگر اعتبارنامه نادرست باشد، اصلاح آن تنها راه رفع خطای احراز هویت است؛ ری‌استارت کمکی نمی‌کند.", ["دسترسی مدیریتی به دیتابیس"], [NEW_LOGS]),
    future("db-auth-env", "R2", "پس از اصلاح اعتبارنامه، متغیر اتصال برنامه را با مقدار جدید به‌روزرسانی کنید (مقدار را خودتان وارد می‌کنید؛ این ابزار آن را درخواست یا ذخیره نمی‌کند).", "برنامه با اعتبارنامهٔ درست باید بتواند به دیتابیس وصل شود.", ["تأیید تأثیر ری‌استارت ناشی از تغییر متغیر (مشاهدهٔ CLI، تأییدنشده)", "تأیید و تصویب صریح اپراتور"], [NEW_LOGS, NO_RESTARTS], "update_env"),
  ],
};

const TPL: Record<string, Tpl[]> = {
  ...DB,
  crash_loop: [manual("loop-cause", "R0", "پیش از هر اقدامی، علت خروج (کد/دلیل پایان) را در لاگ‌ها و رویدادها پیدا کنید؛ ری‌استارت دوباره به‌تنهایی مشکلی را حل نمی‌کند چون برنامه از قبل در حال ری‌استارت است.", "شناخت علت، اقدام درست را مشخص می‌کند.", [], [NO_RESTARTS])],
  isolated_restart: [manual("monitor", "R0", "فعلاً فقط پایش کنید؛ ری‌استارت مجزا شاهدی برای اقدام نیست. اگر تکرار شد دوباره عیب‌یابی کنید.", "جلوگیری از اقدام بی‌دلیل.", [], ["تکرار ری‌استارت را در بازهٔ بعدی بررسی کنید."])],
  missing_configuration: [
    future("config-set", "R2", "متغیر(های) محیطی گم‌شده را در تنظیمات برنامه تعریف کنید (نام‌ها در بخش مشاهده‌ها آمده؛ مقدار را خودتان وارد می‌کنید و این ابزار آن را نمی‌بیند).", "با تعریف متغیر لازم، خطای نبودِ پیکربندی باید برطرف شود.", ["تأیید تأثیر ری‌استارت ناشی از تغییر متغیر (مشاهدهٔ CLI، تأییدنشده)", "تأیید و تصویب صریح اپراتور"], ["لاگ‌های جدید دیگر خطای نبودِ همان متغیر را نشان ندهند.", NO_RESTARTS], "update_env"),
    manual("config-present", "R0", "اگر کلید وجود دارد ولی خطا ادامه دارد، قالب و محتوای مقدار را بیرون از این ابزار بررسی کنید (مقدارها هرگز خوانده نمی‌شوند).", "ممکن است مقدار خالی یا با قالب نادرست باشد.", [], [NEW_LOGS]),
  ],
  oom_kill: [
    manual("oom-investigate", "R0", "الگوی مصرف حافظه را در لاگ‌ها و کد بررسی کنید (نشتی، پردازش دسته‌ای بزرگ، کش بدون سقف).", "رفع علت مصرف زیاد پایدارترین راه‌حل است.", [], [NEW_LOGS]),
    future("oom-plan", "R2", "در صورت تأیید نیاز، پلن با حافظهٔ بیشتر را بررسی کنید (هزینه و ظرفیت پلن‌ها باید از API تأیید شود؛ فعلاً در دسترس نیست).", "افزایش سقف حافظه می‌تواند OOM را کم کند ولی اگر نشتی باشد فقط به تعویق می‌اندازد.", ["فهرست و قیمت پلن‌ها از API تأییدشده", "تأیید و تصویب صریح اپراتور"], ["نبود نشانهٔ OOM در بازهٔ جدید", "پایداری مصرف حافظه"], "change_plan"),
    future("oom-restart", "R1", "ری‌استارت فقط به‌عنوان تسکین موقت (نه راه‌حل) و پس از بررسی علت.", "حافظه موقتاً آزاد می‌شود؛ مشکل ریشه‌ای باقی می‌ماند.", ["علت یا برنامهٔ رفع مشخص باشد", "تأیید صریح اپراتور"], [NO_RESTARTS], "restart_app"),
  ],
  memory_exhaustion_in_process: [manual("heap", "R0", "سقف حافظهٔ زمان‌اجرا (مثلاً heap) و الگوی تخصیص حافظهٔ برنامه را بررسی کنید.", "این خطا از خود فرایند است و ممکن است با تنظیم زمان‌اجرا یا اصلاح کد رفع شود.", [], [NEW_LOGS])],
  memory_growth_unverified: [manual("units", "R0", "ابتدا واحد و ظرفیت متریک حافظه را تأیید کنید (npm run verify:liara-readonly)؛ تا آن زمان تغییر پلن توصیه نمی‌شود.", "بدون واحد معتبر، هر تصمیم دربارهٔ حافظه حدس است.", ["اتصال زندهٔ فقط‌خواندنی و تأیید انسانی گزارش"], ["واحد و سقف در جدول تأییدشده ثبت شود"])],
  memory_pressure: [
    manual("mem-opt", "R0", "مصرف حافظه را بهینه کنید یا نشتی را بررسی کنید.", "کاهش مصرف فشار حافظه را کم می‌کند.", [], ["نسبت مصرف به ظرفیت در نمونه‌های بعدی کمتر شود"]),
    future("mem-plan", "R2", "در صورت نیاز، پلن با حافظهٔ بیشتر.", "افزایش ظرفیت فشار را کم می‌کند.", ["قیمت و ظرفیت پلن از API تأییدشده", "تأیید و تصویب صریح اپراتور"], ["نسبت مصرف به ظرفیت کمتر از ۹۰٪"], "change_plan"),
  ],
  cpu_saturation: [
    manual("cpu-opt", "R0", "نقاط پرمصرف CPU را پروفایل و بهینه کنید.", "کاهش مصرف CPU معمولاً مؤثرتر و ارزان‌تر از ارتقای پلن است.", [], ["نسبت مصرف به ظرفیت کمتر از ۹۰٪"]),
    future("cpu-plan", "R2", "در صورت اثبات نیاز، پلن با CPU بیشتر.", "ظرفیت بیشتر اشباع را کم می‌کند.", ["قیمت و ظرفیت پلن از API تأییدشده", "تأیید و تصویب صریح اپراتور"], ["نسبت مصرف به ظرفیت کمتر از ۹۰٪", "کاهش زمان پاسخ (باید جداگانه اندازه‌گیری شود)"], "change_plan"),
  ],
  release_regression: [
    manual("rel-review", "R0", "تغییرات آخرین انتشار (شاخه/کامیت در بخش نسخه‌ها) را با خطاهای دیده‌شده مقایسه کنید.", "تأیید یا رد ارتباط انتشار با خطاها.", [], ["پس از اصلاح، نرخ سیگنال خطا نسبت به قبل از انتشار مقایسه شود"]),
    future("rel-redeploy", "R2", "در صورت تأیید، نسخهٔ اصلاح‌شده یا آخرین سورس سالم را دوباره مستقر کنید. (API مستندشدهٔ «بازگشت به نسخهٔ قبل» وجود ندارد.)", "بازگرداندن رفتار پیش از انتشار، اگر علّت همان انتشار باشد.", ["سورس سالم در دسترس باشد", "تأیید و تصویب صریح اپراتور"], ["کاهش سیگنال‌های خطا پس از استقرار", "release جدید در وضعیت موفق"], "deploy_release"),
  ],
  release_failed: [
    manual("rel-failed-review", "R0", "لاگ ساخت/استقرار انتشار ناموفق را از کنسول بررسی کنید؛ اگر آن نسخه فعلی نشده، نسخهٔ در حال اجرا از آن تأثیر نمی‌پذیرد.", "مشخص می‌شود شکست مربوط به ساخت، پیکربندی یا اجراست.", [], ["انتشار بعدی با وضعیت موفق ثبت شود"]),
  ],
  http_500: [
    manual("http500-trace", "R0", "اطراف خط‌های صریح HTTP 500 در لاگ‌ها دنبال stack trace یا پیام خطای برنامه بگردید.", "علت 500 معمولاً در پیام خطای برنامه است، نه در پلتفرم.", [], ["پس از رفع، خط جدید HTTP 500 در لاگ‌ها دیده نشود"]),
  ],
};

const INSUFFICIENT_BASE: Tpl = manual("widen", "R0", "بازهٔ زمانی را بزرگ‌تر کنید و مطمئن شوید برنامه لاگ می‌نویسد؛ سپس دوباره عیب‌یابی کنید.", "داده‌ی بیشتر امکان تشخیص را فراهم می‌کند.", [], ["اجرای مجدد عیب‌یابی با بازهٔ بزرگ‌تر"]);

function id(key: string, tpl: string): string {
  return `rec_${createHash("sha1").update(`${key}:${tpl}`).digest("hex").slice(0, 8)}`;
}

/** Parameters for a future operation. Only facts from findings are used (variable NAMES); nothing is invented. */
function paramsFor(h: Hypothesis, op: OpKind): Record<string, unknown> {
  if (op === "update_env") {
    const names = h.observations.filter((f) => f.hypothesis === "missing_configuration").flatMap((f) => (f.data.names as string[]) ?? []);
    return { keys: [...new Set(names)].slice(0, 20), valuesSource: "operator_out_of_band" };
  }
  if (op === "change_plan") return { direction: "review", targetPlanId: null };
  if (op === "deploy_release") return { sourceRef: "operator_supplied_corrected_source" };
  return {};
}

function toRec(h: Hypothesis, t: Tpl): Recommendation {
  const { tplId, op, ...rest } = t;
  return { ...rest, id: id(h.key, tplId), relatedDiagnosis: h.key, evidenceIds: h.evidenceIds, requiresApproval: t.risk !== "R0", executableNow: false, ...(op ? { operation: { kind: op, params: paramsFor(h, op) } } : {}) };
}

export function recommend(d: Diagnosis): Recommendation[] {
  const out: Recommendation[] = [];
  const seen = new Set<string>();
  const push = (r: Recommendation) => {
    if (!seen.has(r.id)) {
      seen.add(r.id);
      out.push(r);
    }
  };
  for (const h of d.hypotheses) {
    if (h.key === "insufficient_evidence") {
      const reasons = d.missingEvidence;
      push(toRec(h, INSUFFICIENT_BASE));
      if (reasons.some((m) => m.availability === "access_denied")) push(toRec(h, manual("access", "R0", "دسترسی توکن API به منبع‌های ردشده (۴۰۱/۴۰۳) را بررسی کنید؛ ۴۰۳ به‌معنی «وجود ندارد» نیست.", "با دسترسی درست، شواهد جمع‌آوری می‌شود.", ["دسترسی به کنسول لیارا"], ["اجرای مجدد عیب‌یابی"])));
      if (reasons.some((m) => m.availability === "unsupported" || m.availability === "contract_mismatch" || m.availability === "no_content")) push(toRec(h, manual("verify", "R0", "قابلیت‌های پشتیبانی‌نشده یا ناسازگار را با npm run verify:liara-readonly بررسی کنید.", "مشخص می‌شود مشکل از API است یا از تنظیمات.", ["اتصال زندهٔ فقط‌خواندنی"], ["گزارش تأیید بدون CONTRACT_MISMATCH"])));
      if (reasons.some((m) => m.availability === "collection_failed")) push(toRec(h, manual("retry", "R0", "جمع‌آوری ناموفق بود (خطا یا زمان‌سنجی)؛ کمی بعد دوباره امتحان کنید.", "خطاهای گذرا معمولاً برطرف می‌شوند.", [], ["اجرای مجدد عیب‌یابی"])));
      continue;
    }
    // components: the hypothesis itself plus whatever it merged (restart_loop_db_* → crash_loop + db_*)
    const components = [h.key, ...h.merged];
    for (const c of components) for (const t of TPL[c] ?? []) {
      if (h.merged.includes("crash_loop") && c !== "crash_loop" && t.risk === "R1") continue;
      push(toRec(h, t));
    }
    // a restart is only suggested AFTER the cause is fixed, for restart loops caused by a database failure
    if (h.merged.includes("crash_loop") && h.merged.some((m) => m.startsWith("db_"))) {
      push(toRec(h, future("restart-after-fix", "R1", "پس از رفع مشکل دیتابیس، ری‌استارت برنامه را برای اتصال دوباره بررسی کنید (راه‌حل تضمینی نیست).", "برنامه ممکن است پس از رفع علت، دوباره وصل شود.", ["مشکل دیتابیس رفع و تأیید شده باشد", "تأیید صریح اپراتور"], [NO_RESTARTS], "restart_app")));
    }
  }
  if (d.status === "NO_ANOMALY_IN_EXAMINED_EVIDENCE") {
    push({ id: id("none", "monitor"), relatedDiagnosis: "none", evidenceIds: [], descriptionFa: "فعلاً اقدامی لازم نیست. بازه را بزرگ‌تر کنید یا پایش را ادامه دهید؛ نبودِ شاهد مشکل به‌معنی سلامت تأییدشده نیست.", expectedImpactFa: "جلوگیری از اقدام بی‌دلیل.", risk: "R0", prerequisitesFa: [], verificationPlanFa: ["اجرای مجدد عیب‌یابی هنگام بروز علائم"], requiresApproval: false, executableNow: false, actor: "operator_manual" });
  }
  return out;
}
