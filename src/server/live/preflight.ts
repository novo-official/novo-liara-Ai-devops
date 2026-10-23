import type { PlanProjection, RawPlan } from "../liara/plans";
import { balanceStatus, cliOffersPlan, corroborateUnits, PUBLIC_PRICING_SNAPSHOT, unitsAgreement, type BalanceStatus, type UnitsAgreement, type UnitsCorroboration } from "./pricing";
import { DEFAULT_ESTIMATE_HOURS } from "./plans";
import type { PlanUnits } from "./units";
import { APP_NAME_REGEX } from "../config/env";
import { markerIsSpecific } from "./existing";

/**
 * FINAL LIVE-DEPLOYMENT PREFLIGHT (Phase 2B). A PURE function: it receives what the read-only layer already observed and the operator's configuration, and
 * returns a sanitised, shareable report. It performs no I/O, creates nothing and contains no balance/amount that would be private (only classes).
 * Every check carries its EVIDENCE class so "documented", "live-verified", "CLI-observed", "operator-declared" and "not tested" are never conflated.
 */
export type Evidence = "documented" | "live_verified" | "cli_observed" | "operator_declared" | "not_tested";
export type PreflightCategory = "security" | "contract" | "pricing" | "configuration";
export type PreflightVerdict = "READY_FOR_OPERATOR_APPROVAL" | "BLOCKED_BY_PRICING" | "BLOCKED_BY_CONTRACT" | "BLOCKED_BY_CONFIGURATION" | "BLOCKED_BY_SECURITY";
/** highest priority first: a security gap outranks everything, then an unverified contract, then money, then plain configuration */
export const VERDICT_PRIORITY: readonly PreflightCategory[] = ["security", "contract", "pricing", "configuration"];
const VERDICT_OF: Record<PreflightCategory, PreflightVerdict> = { security: "BLOCKED_BY_SECURITY", contract: "BLOCKED_BY_CONTRACT", pricing: "BLOCKED_BY_PRICING", configuration: "BLOCKED_BY_CONFIGURATION" };

export interface PreflightCheck {
  id: string;
  category: PreflightCategory;
  /** `blocked` stops live deployment; `info` is shown but never blocks; `ok` is satisfied */
  status: "ok" | "blocked" | "info";
  evidence: Evidence[];
  titleFa: string;
  detailFa: string;
}

type Read<T> = ({ ok: true } & T) | { ok: false; code: string };
export interface PreflightInput {
  config: {
    liveEnabled: boolean;
    dataSourceLive: boolean;
    tokenPresent: boolean;
    teamId: string | null;
    planUnits: PlanUnits | null;
    contractAttested: boolean;
    networkId: string | null;
    appDomainSuffixes: readonly string[];
    healthMarker: string | null;
    allowUndocumented: boolean;
    mutationsEnabled: boolean;
    aiLiveEnabled: boolean;
  };
  catalogue: PlanProjection | null;
  /** not attempted (e.g. offline) = null */
  billing: Read<{ balance: number | null }> | null;
  networks: Read<{ items: { id: string; name: string | null }[] }> | null;
  apps: Read<{ count: number }> | null;
  selection: { planId: string | null; bundlePlanId: string | null; appName: string | null; nameExists: boolean | null; minRamMb: number | null } | null;
  runBlockers: string[];
  nowIso: string;
}

export interface PricingRow {
  planId: string;
  available: boolean | null;
  cliOffered: boolean;
  region: string | null;
  ramRaw: number | null;
  cpuRaw: number | null;
  priceRaw: number | null;
  diskRaw: number | null;
  /** only when the units are corroborated AND agree with the operator document */
  ramGbVerified: number | null;
  hourlyTomanVerified: number | null;
  /** price corroborated for THIS plan (RAM, CPU and exact price matched a published plan) */
  priceCorroborated: boolean;
  bundles: { id: string; available: boolean | null }[];
}
export interface PricingSummary {
  snapshot: { source: string; capturedAt: string };
  corroboration: UnitsCorroboration;
  agreement: UnitsAgreement;
  rows: PricingRow[];
  selected: null | { planId: string; hourlyToman: number | null; estimate: { oneHour: number | null; oneDay: number | null; thirtyDays: number | null; currency: "IRT"; basis: string } };
  balance: BalanceStatus;
  /** facts no official source states and the operator has NOT accepted */
  unresolved: string[];
  accepted: string[];
  bundleCostsFa: string;
}
export interface PreflightReport {
  schemaVersion: 1;
  generatedAt: string;
  verdict: PreflightVerdict;
  /** every category that currently blocks, highest priority first */
  blockerCategories: PreflightCategory[];
  checks: PreflightCheck[];
  pricing: PricingSummary | null;
  network: { listing: "verified" | "unavailable" | "not_opted_in"; count: number | null; configuredIdPresent: boolean | null };
  team: { configured: boolean; consistency: "consistent" | "mismatch" | "unknown" };
  account: { appCount: number | null; firstApp: boolean | null; balance: BalanceStatus };
}

const UNKNOWN_FA: Record<string, string> = {
  billing_start: "زمان شروع صورتحساب برنامه (از لحظهٔ ساخت؟)",
  minimum_balance: "حداقل موجودی لازم برای ساخت برنامه",
  zero_balance_behavior: "رفتار لیارا هنگام صفرشدن موجودی",
  bundle_plan_price: "هزینهٔ بستهٔ امکانات (bundle)",
  vat: "شمول یا عدم شمول مالیات بر ارزش افزوده",
};

const check = (id: string, category: PreflightCategory, status: PreflightCheck["status"], evidence: Evidence[], titleFa: string, detailFa: string): PreflightCheck => ({ id, category, status, evidence, titleFa, detailFa });

export function buildPreflight(i: PreflightInput): PreflightReport {
  const c = i.config;
  const checks: PreflightCheck[] = [];
  const corroboration = corroborateUnits(i.catalogue);
  const agreement = unitsAgreement(c.planUnits, corroboration);
  const accepted = c.planUnits?.acceptedUnknowns ?? [];
  const unresolved = Object.keys(UNKNOWN_FA).filter((k) => !accepted.includes(k as never));

  // ------------------------------------------------------------ security
  checks.push(check("mutations_flag_off", "security", c.mutationsEnabled ? "blocked" : "ok", ["live_verified"], "پرچم عمومی تغییرات خاموش است", c.mutationsEnabled ? "ENABLE_MUTATIONS روشن است؛ باید خاموش باشد." : "هیچ مسیر نوشتن عمومی وجود ندارد؛ تنها مسیر نوشتن، اجراکنندهٔ تایپ‌شدهٔ استقرار است."));
  checks.push(check("ai_live_off", "security", c.aiLiveEnabled ? "blocked" : "ok", ["live_verified"], "هوش مصنوعی پولی خاموش است", c.aiLiveEnabled ? "پرچم درخواست زندهٔ هوش مصنوعی روشن است؛ باید خاموش باشد." : "هیچ درخواست هوش مصنوعی پولی ارسال نمی‌شود."));
  checks.push(check("allowlist_exact", "security", "ok", ["live_verified"], "فهرست مجاز دقیق می‌ماند", "پس از ساخت، فقط همان نام برنامه (در همان تیم) و فقط پس از راستی‌آزمایی هویت آن به دامنهٔ دسترسی اضافه می‌شود؛ هیچ wildcard وجود ندارد."));
  const teamPresent = i.catalogue?.account?.teamPresent ?? null;
  const teamConsistency: PreflightReport["team"]["consistency"] = c.teamId === null ? (teamPresent === true ? "mismatch" : "consistent") : teamPresent === null ? "unknown" : teamPresent ? "consistent" : "mismatch";
  checks.push(
    check(
      "team_scope",
      "security",
      teamConsistency === "mismatch" ? "blocked" : teamConsistency === "consistent" ? "ok" : "info",
      teamConsistency === "consistent" ? ["live_verified", "cli_observed"] : ["not_tested"],
      "هم‌خوانی تیم",
      teamConsistency === "mismatch" ? "حساب در حالت تیمی است اما شناسهٔ تیم تنظیم نشده، یا شناسهٔ تیم تنظیم شده ولی پاسخ حساب شامل تیم نیست؛ هیچ‌چیز ساخته نمی‌شود." : teamConsistency === "unknown" ? "هنوز با یک خواندن زنده بررسی نشده است (teamID به‌صورت پارامتر query ارسال می‌شود)." : c.teamId ? "پاسخ حساب شامل تیم است و شناسهٔ تیم به همهٔ درخواست‌ها پیوست می‌شود." : "حساب شخصی است و هیچ تیمی تنظیم نشده.",
    ),
  );

  // ------------------------------------------------------------ contract
  checks.push(check("contract_attested", "contract", c.contractAttested ? "ok" : "blocked", ["cli_observed", "operator_declared"], "فیلدهای فقط‌CLI تأیید شده‌اند", c.contractAttested ? "اپراتور تأیید کرده bundlePlanID، network، platformConfig و build.cache با CLI رسمی مقایسه شده‌اند (هنوز زنده آزموده نشده‌اند)." : "bundlePlanID، network (همیشه ارسال می‌شود)، platformConfig و build.cache فقط در CLI رسمی دیده شده‌اند، نه در مستندات؛ تا تأیید اپراتور (LIARA_LIVE_CONTRACT_ATTESTED) مسدود است."));
  const listing: PreflightReport["network"]["listing"] = !c.allowUndocumented ? "not_opted_in" : i.networks?.ok ? "verified" : "unavailable";
  checks.push(
    check(
      "network_listing",
      "contract",
      listing === "verified" ? "ok" : "blocked",
      listing === "verified" ? ["live_verified", "cli_observed"] : ["cli_observed", "not_tested"],
      "فهرست شبکه‌ها (GET /v1/networks)",
      listing === "verified" ? "این مسیر در مستندات و OpenAPI نیست و فقط از CLI رسمی دیده شده؛ با فعال‌سازی صریح خوانده شد." : listing === "not_opted_in" ? "این مسیر مستند نیست؛ بدون فعال‌سازی صریح (LIARA_ALLOW_UNDOCUMENTED_ENDPOINTS=true) خوانده نمی‌شود، پس شناسهٔ شبکه راستی‌آزمایی نمی‌شود." : "خواندن فهرست شبکه‌ها ناموفق بود.",
    ),
  );
  checks.push(check("release_state_vocabulary", "contract", "info", ["cli_observed", "not_tested"], "واژگان وضعیت نسخه", "READY / FAILED / CANCELED / TIMEDOUT / DEPLOYING / UNHEALTHY فقط از CLI رسمی آمده و زنده راستی‌آزمایی نشده است؛ وضعیت ناشناخته هرگز موفقیت حساب نمی‌شود."));
  checks.push(check("request_conventions", "contract", "info", ["cli_observed", "not_tested"], "قراردادهای درخواست", "CLI رسمی ساخت برنامه را به «v1/projects/» (با اسلش پایانی) می‌فرستد و teamID را همیشه (حتی خالی) به‌صورت query می‌افزاید؛ مستندات نوع انتقال teamID را مشخص نکرده‌اند."));

  // ------------------------------------------------------------ configuration
  checks.push(check("data_source_live", "configuration", c.dataSourceLive ? "ok" : "blocked", ["live_verified"], "منبع داده زنده", c.dataSourceLive ? "منبع داده: لیارای واقعی (فقط‌خواندنی تا فعال‌سازی صریح)." : "داده شبیه‌سازی است؛ ارزیابی پیش‌پرواز با داده شبیه‌سازی معتبر نیست."));
  checks.push(check("token_present", "configuration", c.tokenPresent ? "ok" : "blocked", ["operator_declared"], "توکن لیارا", c.tokenPresent ? "توکن پیکربندی شده است (مقدار نمایش داده نمی‌شود)." : "توکن پیکربندی نشده است."));
  checks.push(check("live_flag", "configuration", "info", ["operator_declared"], "فعال‌سازی اجرای واقعی", c.liveEnabled ? "پرچم روشن است؛ تنها یک تأیید تازه و دقیق برای هر عملیات اجازهٔ نوشتن می‌دهد." : "اجرای واقعی خاموش است (حالت مورد انتظار پیش از تأیید اپراتور)."));
  checks.push(check("catalogue_readable", "configuration", i.catalogue ? "ok" : "blocked", i.catalogue ? ["documented", "live_verified"] : ["not_tested"], "فهرست پلن‌ها خوانده شد", i.catalogue ? `${i.catalogue.plans.length} پلن در پاسخ GET /v1/me دیده شد.` : "فهرست پلن‌ها خوانده نشد."));
  checks.push(check("network_id_configured", "configuration", c.networkId ? "ok" : "blocked", ["operator_declared"], "شناسهٔ شبکه تنظیم شده", c.networkId ? "LIARA_NETWORK_ID تنظیم شده است." : "شناسهٔ شبکه (_id) که CLI همیشه می‌فرستد تنظیم نشده است؛ این ابزار هیچ شناسه‌ای نمی‌سازد و شبکه‌ای ایجاد نمی‌کند."));
  const nets = i.networks?.ok ? i.networks.items : null;
  const idPresent = nets && c.networkId ? nets.some((n) => n.id === c.networkId) : null;
  checks.push(check("network_exists", "configuration", nets === null ? "info" : nets.length === 0 ? "blocked" : idPresent === false ? "blocked" : idPresent === true ? "ok" : "info", nets ? ["live_verified", "cli_observed"] : ["not_tested"], "شبکهٔ انتخاب‌شده وجود دارد", nets === null ? "بدون خواندن فهرست شبکه‌ها قابل بررسی نیست." : nets.length === 0 ? "هیچ شبکه‌ای در حساب نیست؛ CLI رسمی در این حالت ساخت را رد می‌کند. شبکه را دستی (کنسول یا CLI) بسازید — این ابزار شبکه نمی‌سازد." : idPresent === false ? "شناسهٔ تنظیم‌شده در فهرست شبکه‌ها نیست." : idPresent === true ? "شناسهٔ تنظیم‌شده دقیقاً در فهرست شبکه‌های حساب هست." : "شناسهٔ شبکه تنظیم نشده."));
  checks.push(check("app_domain_suffix", "configuration", c.appDomainSuffixes.length ? "ok" : "blocked", ["operator_declared"], "دامنهٔ بررسی سلامت", c.appDomainSuffixes.length ? "دامنهٔ مورد اعتماد برای بررسی سلامت HTTP تنظیم شده است." : "دامنهٔ پیش‌فرض برنامه برای بررسی سلامت تنظیم نشده؛ بدون آن «DEPLOYED» اعلام نمی‌شود."));
  const markerSpecific = markerIsSpecific(c.healthMarker); // same rule as the existing-app check: a marker that matches almost any page proves nothing
  checks.push(check("health_marker", "configuration", markerSpecific ? "ok" : "blocked", ["operator_declared"], "نشانگر سلامت قطعی", markerSpecific ? "پاسخ /health باید این نشانگر را داشته باشد." : c.healthMarker ? "نشانگر تنظیم‌شده عمومی یا کوتاه است و تقریباً در هر پاسخی پیدا می‌شود؛ برای اولین استقرار باید LIARA_LIVE_HEALTH_MARKER را به عبارتی اختصاصی (دست‌کم ۸ نویسه، مثلاً نام برنامه) تغییر دهید." : "بدون نشانگر قطعی، فقط کد ۲۰۰ بررسی می‌شود؛ برای اولین استقرار باید LIARA_LIVE_HEALTH_MARKER تنظیم شود."));
  const sensitive = i.runBlockers.filter((b) => !b.startsWith("sensitive_files"));
  checks.push(check("project_ready", "configuration", sensitive.length ? "blocked" : "ok", ["live_verified"], "آمادگی پروژه", sensitive.length ? `موانع پروژه: ${sensitive.join("، ")}` : "تحلیل ایستا مانعی نیافت."));

  // first-app bootstrap + name
  const appCount = i.apps?.ok ? i.apps.count : null;
  checks.push(check("apps_readable", "configuration", i.apps?.ok ? "ok" : "blocked", i.apps?.ok ? ["documented", "live_verified"] : ["not_tested"], "فهرست برنامه‌ها خوانده شد", i.apps?.ok ? `${i.apps.count} برنامه در حساب دیده شد.` : "بدون خواندن فهرست برنامه‌ها، تصادم نام و ساخت تکراری قابل رد کردن نیست."));
  checks.push(check("first_app_bootstrap", "configuration", "info", ["live_verified"], "مسیر راه‌اندازی اولین برنامه", appCount === 0 ? "حساب هیچ برنامه‌ای ندارد؛ فهرست مجاز می‌تواند خالی باشد. پس از ساخت و راستی‌آزمایی هویت دقیق برنامه، فقط همان نام به دامنهٔ دسترسی اضافه می‌شود." : "برنامه‌های موجود دست‌نخورده می‌مانند؛ فقط نام جدید پس از ساخت و راستی‌آزمایی به دامنهٔ دسترسی اضافه می‌شود."));
  const sel = i.selection;
  if (sel?.appName) {
    const valid = APP_NAME_REGEX.test(sel.appName);
    checks.push(check("app_name", "configuration", !valid || sel.nameExists !== false ? "blocked" : "ok", ["live_verified"], "نام برنامه", !valid ? "نام نامعتبر است." : sel.nameExists === true ? "برنامه‌ای با این نام وجود دارد؛ ساخت تکراری انجام نمی‌شود." : sel.nameExists === null ? "وجود یا عدم وجود نام قابل بررسی نبود." : "نام معتبر است و تصادمی ندارد."));
  } else checks.push(check("app_name", "configuration", "info", [], "نام برنامه", "هنوز نامی انتخاب نشده است."));

  // ------------------------------------------------------------ pricing
  checks.push(check("units_operator_document", "pricing", c.planUnits ? "ok" : "blocked", ["operator_declared"], "سند واحدهای اپراتور", c.planUnits ? `ثبت‌شده در ${c.planUnits.verifiedAt}؛ تنها پس از تطبیق با داده‌های مستقل معتبر است.` : "LIARA_PLAN_UNITS_JSON وجود ندارد؛ هیچ هزینه‌ای محاسبه نمی‌شود."));
  checks.push(
    check(
      "units_corroborated",
      "pricing",
      corroboration.status === "corroborated" ? "ok" : "blocked",
      corroboration.status === "corroborated" ? ["live_verified", "documented"] : ["not_tested"],
      "تطبیق واحدها با صفحهٔ قیمت عمومی",
      corroboration.status === "corroborated" ? `RAM (${corroboration.hypothesis!.ram}) و قیمت (به ازای ${corroboration.hypothesis!.per === "hour" ? "ساعت" : "ماه"}، تومان) با ${corroboration.matchedPlanIds.length} پلن کاتالوگ و صفحهٔ قیمت (${corroboration.snapshot.capturedAt}) هم‌خوان شد. این فقط واحدها را تأیید می‌کند، نه نگاشت نام پلن‌ها به شناسه‌ها.` : corroboration.status === "contradicted" ? "داده‌های کاتالوگ با صفحهٔ قیمت عمومی تناقض دارند؛ واحدها تأیید نمی‌شوند." : corroboration.status === "no_catalogue" ? "کاتالوگ خوانده نشده است." : "هیچ ترکیب RAM، CPU و قیمت کاتالوگ با صفحهٔ قیمت عمومی دست‌کم دو بار هم‌خوان نشد؛ واحدها تأیید نمی‌شوند (تنظیم دستی کافی نیست).",
    ),
  );
  checks.push(check("units_agree", "pricing", agreement === "agree" ? "ok" : "blocked", ["operator_declared", "live_verified"], "سند اپراتور با شواهد مستقل یکی است", agreement === "agree" ? "واحدهای اعلام‌شده دقیقاً همان واحدهای تأییدشده‌اند." : agreement === "disagree" ? "واحدهای سند اپراتور با واحدهای تأییدشده نمی‌خوانند." : agreement === "no_operator_units" ? "سند اپراتور وجود ندارد." : "بدون تأیید مستقل، سند اپراتور پذیرفته نمی‌شود."));
  checks.push(check("billing_semantics", "pricing", unresolved.length ? "blocked" : "ok", ["not_tested", "operator_declared"], "معنای صورتحساب", unresolved.length ? `هیچ منبع رسمی این موارد را بیان نمی‌کند و اپراتور هم آن‌ها را آگاهانه نپذیرفته است: ${unresolved.map((k) => UNKNOWN_FA[k]).join("؛ ")}` : "موارد نامعلوم، به‌عنوان ریسک پذیرفته‌شدهٔ اپراتور ثبت شده‌اند (نامعلوم می‌مانند و در تأیید نمایش داده می‌شوند)."));

  const billingOk = i.billing?.ok ? i.billing.balance : null;
  const teamBalance = i.catalogue?.account?.teamBalance ?? null;
  const balanceRaw = c.teamId ? teamBalance : billingOk;

  const rows: PricingRow[] = (i.catalogue?.plans ?? [])
    .filter((p) => p.available === true)
    .slice(0, 30)
    .map((p) => rowOf(p, i.catalogue!, corroboration, agreement));
  let selected: PricingSummary["selected"] = null;
  let balance: BalanceStatus = "unknown";
  if (sel?.planId) {
    const plan = i.catalogue?.plans.find((p) => p.id === sel.planId) ?? null;
    const row = rows.find((r) => r.planId === sel.planId) ?? (plan ? rowOf(plan, i.catalogue!, corroboration, agreement) : null);
    const reasons: string[] = [];
    if (!plan) reasons.push("پلن در کاتالوگ نیست");
    else {
      if (plan.available !== true) reasons.push("پلن در دسترس نیست");
      if (!cliOffersPlan(plan)) reasons.push("CLI رسمی این پلن را برای ساخت پیشنهاد نمی‌دهد (باید در دسترس، منطقهٔ iran و شناسهٔ free یا حاوی g2 باشد)");
      if (!row?.priceCorroborated) reasons.push("قیمت این پلن با صفحهٔ قیمت عمومی تطبیق داده نشد");
      const ramGb = row?.ramGbVerified ?? null;
      if (ramGb !== null && sel.minRamMb !== null && ramGb * 1024 < sel.minRamMb) reasons.push("حافظهٔ پلن از حداقل برآوردی کمتر است");
      const avail = (i.catalogue?.bundles[plan.id] ?? []).filter((b) => b.available === true);
      if (sel.bundlePlanId ? !avail.some((b) => b.id === sel.bundlePlanId) : avail.length !== 1) reasons.push("بستهٔ امکانات (bundle) یکتا و در دسترس نیست");
    }
    const hourly = row?.hourlyTomanVerified ?? null;
    const est = (h: number) => (hourly === null ? null : Math.round(hourly * h));
    selected = { planId: sel.planId, hourlyToman: hourly, estimate: { oneHour: est(1), oneDay: est(24), thirtyDays: est(DEFAULT_ESTIMATE_HOURS), currency: "IRT", basis: "ساعتی از لحظهٔ ساخت (فرض اعلام‌شدهٔ اپراتور؛ در منابع رسمی ذکر نشده)" } };
    balance = balanceStatus(balanceRaw, est(24));
    checks.push(check("selected_plan", "pricing", reasons.length ? "blocked" : "ok", ["live_verified", "cli_observed"], "پلن انتخاب‌شده", reasons.length ? reasons.join("؛ ") : "پلن در دسترس است، توسط CLI پیشنهاد می‌شود و قیمت آن با شواهد مستقل تطبیق دارد."));
    checks.push(check("balance", "pricing", balance === "sufficient" ? "ok" : "blocked", billingOk !== null || teamBalance !== null ? ["live_verified", "documented"] : ["not_tested"], "موجودی حساب", balance === "sufficient" ? "موجودی حتی با بدترین تفسیر واحد (ریال) هزینهٔ ۲۴ ساعت را پوشش می‌دهد." : balance === "insufficient" ? "موجودی حتی با بهترین تفسیر واحد (تومان) هزینهٔ ۲۴ ساعت را پوشش نمی‌دهد؛ حساب را دستی شارژ کنید." : balance === "ambiguous" ? "واحد موجودی در API مشخص نیست (صفحهٔ صورتحساب: تومان، صفحهٔ افزایش اعتبار: ریال)؛ موجودی فقط با تفسیر تومان کافی است، پس مسدود می‌ماند." : "موجودی خوانده نشد یا هزینهٔ قابل‌اتکا وجود ندارد."));
  } else {
    balance = "unknown";
    checks.push(check("selected_plan", "pricing", "info", [], "پلن انتخاب‌شده", "هنوز پلنی انتخاب نشده است."));
    checks.push(check("balance", "pricing", "info", [], "موجودی حساب", "تا انتخاب پلن، کفایت موجودی ارزیابی نمی‌شود."));
  }

  const blocked = new Set(checks.filter((k) => k.status === "blocked").map((k) => k.category));
  const blockerCategories = VERDICT_PRIORITY.filter((k) => blocked.has(k));
  const verdict: PreflightVerdict = blockerCategories.length ? VERDICT_OF[blockerCategories[0]!] : "READY_FOR_OPERATOR_APPROVAL";

  const pricing: PricingSummary | null = i.catalogue
    ? { snapshot: corroboration.snapshot, corroboration, agreement, rows, selected, balance, unresolved: unresolved.map((k) => UNKNOWN_FA[k]!), accepted: accepted.map((k) => UNKNOWN_FA[k]!), bundleCostsFa: accepted.includes("bundle_plan_price") ? "هزینهٔ بستهٔ امکانات نامعلوم است و به‌عنوان ریسک پذیرفته شده." : "هزینهٔ بستهٔ امکانات (bronze/silver/gold) در هیچ منبع رسمی ذکر نشده؛ هزینهٔ اضافی احتمالی است." }
    : null;
  return {
    schemaVersion: 1,
    generatedAt: i.nowIso,
    verdict,
    blockerCategories,
    checks,
    pricing,
    network: { listing, count: nets ? nets.length : null, configuredIdPresent: idPresent },
    team: { configured: c.teamId !== null, consistency: teamConsistency },
    account: { appCount, firstApp: appCount === null ? null : appCount === 0, balance },
  };
}

function rowOf(p: RawPlan, cat: PlanProjection, corr: UnitsCorroboration, agree: UnitsAgreement): PricingRow {
  const ok = agree === "agree" && corr.hypothesis !== null;
  const h = corr.hypothesis;
  const priceCorroborated = ok && corr.matchedPlanIds.includes(p.id);
  return {
    planId: p.id,
    available: p.available,
    cliOffered: cliOffersPlan(p),
    region: p.region,
    ramRaw: p.ramAmount,
    cpuRaw: p.cpuAmount,
    priceRaw: p.price,
    diskRaw: p.volume,
    ramGbVerified: ok && p.ramAmount !== null ? (h!.ram === "GB" ? p.ramAmount : p.ramAmount / 1024) : null,
    hourlyTomanVerified: priceCorroborated && p.price !== null ? (h!.per === "hour" ? p.price : p.price / 720) : null,
    priceCorroborated,
    bundles: (cat.bundles[p.id] ?? []).map((b) => ({ id: b.id, available: b.available })),
  };
}

export { PUBLIC_PRICING_SNAPSHOT };
