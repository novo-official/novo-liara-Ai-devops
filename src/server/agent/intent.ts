import { injectionSuspect } from "../diagnostics/signals";
import type { AgentIntent } from "./types";

/**
 * Deterministic, constrained Persian intent parser. It resolves a FIXED set of eight request types from keyword families,
 * spelling variants and simple follow-up references. It does NOT understand arbitrary natural language and never guesses:
 *  - ambiguous input  → clarification question
 *  - unsupported      → explanation + supported examples
 *  - imperative orders for real operations ("ری‌استارت کن") → refused (nothing real is ever executed in this phase)
 *  - attempts to override safety policy / approval → refused
 *  - app names are only ever taken from the AUTHORISED list; unknown names are refused, never invented or looked up.
 */

export const MAX_MESSAGE_CHARS = 500;
export const WINDOW_OPTIONS = [15, 60, 360, 1440] as const;

export interface ParseContext {
  /** the operator's authorised apps (allowlist) — the only names the parser will ever resolve */
  apps: string[];
  lastApp?: string | null;
  lastIntent?: AgentIntent | null;
  /** hypotheses of the most recent report in this conversation (for follow-ups) */
  lastReportHypotheses?: { key: string; titleFa: string }[] | null;
  /** true when the conversation already has a diagnostic report */
  hasReport?: boolean;
}

export interface Option {
  labelFa: string;
  text: string;
}

export type ParseResult =
  | { kind: "resolved"; intent: AgentIntent; app: string | null; windowMinutes: number | null; windowNoteFa?: string; ref: { index: number } | null; rules: string[] }
  | { kind: "clarify"; reason: "ambiguous_intent" | "missing_app" | "multiple_apps" | "no_context"; questionFa: string; options: Option[];
      /** ambiguous_intent only: the symptom families found in the message, the authorised app it resolved to (or null) and the window — lets the caller run ONE read-only investigation instead of asking which symptom comes first */
      candidates?: AgentIntent[]; app?: string | null; windowMinutes?: number | null }
  | { kind: "unsupported"; reason: "empty" | "too_long" | "unsupported_request" | "blocked_action" | "policy_override" | "unknown_app"; messageFa: string; suggestions: string[] };

export const SUGGESTED_PROMPTS: Option[] = [
  { labelFa: "بررسی ری‌استارت‌ها", text: "چرا برنامه‌ام مدام ری‌استارت می‌شود؟" },
  { labelFa: "بررسی خطای ۵۰۰", text: "برنامه‌ام خطای ۵۰۰ می‌دهد، بررسی کن" },
  { labelFa: "بررسی کندی", text: "چرا وب‌سایتم کند است؟" },
  { labelFa: "شکست استقرار", text: "استقرار اخیر چرا شکست خورد؟" },
  { labelFa: "بررسی سلامت", text: "وضعیت سلامت برنامه را بررسی کن" },
  { labelFa: "استقرار پروژهٔ من", text: "می‌خوام پروژه‌ام رو دیپلوی کنم" },
  { labelFa: "کمبودهای پیش از انتشار", text: "قبل از انتشار چه چیزهایی کم دارم؟" },
];

const FOLLOW_UPS: Option[] = [
  { labelFa: "توضیح یافتهٔ اول", text: "علت اول را توضیح بده" },
  { labelFa: "بررسی اقدام پیشنهادی", text: "اقدام پیشنهادی را بررسی کن" },
  { labelFa: "طرح شبیه‌سازی اقدام", text: "یک طرح شبیه‌سازی اقدام بساز" },
];
export const FOLLOW_UP_PROMPTS = FOLLOW_UPS;

// ---------- normalisation ----------
const DIGITS: Record<string, string> = { "۰": "0", "۱": "1", "۲": "2", "۳": "3", "۴": "4", "۵": "5", "۶": "6", "۷": "7", "۸": "8", "۹": "9", "٠": "0", "١": "1", "٢": "2", "٣": "3", "٤": "4", "٥": "5", "٦": "6", "٧": "7", "٨": "8", "٩": "9" };

/** Spaced form (words kept, ZWNJ → space) and compact form (no spaces/ZWNJ) so that "ری‌استارت", "ری استارت" and "ریاستارت" all match. */
export function normalize(input: string): { spaced: string; compact: string } {
  let s = input.normalize("NFKC").replace(/[\u0000-\u0008\u000b\u000c\u000e-\u001f\u007f\u200b\u200e\u200f\u202a-\u202e\u2060\u2066-\u2069\ufeff]/g, ""); // control + bidi/invisible characters
  s = s.replace(/[٠-٩۰-۹]/g, (d) => DIGITS[d] ?? d);
  s = s.replace(/ي/g, "ی").replace(/ك/g, "ک").replace(/ۀ|ة/g, "ه").replace(/[أإٱ]/g, "ا").replace(/ؤ/g, "و");
  s = s.replace(/[ً-ٰٟـ]/g, ""); // harakat, tatweel
  s = s.toLowerCase();
  s = s.replace(/[‌‍]/g, " ").replace(/[؟?!.,،؛;:()«»"'`]/g, " ");
  const spaced = s.replace(/\s+/g, " ").trim();
  return { spaced, compact: spaced.replace(/ /g, "") };
}

// ---------- keyword families (compact form) ----------
const F = {
  restart: /(ری?ا?ستارت|ریبوت|restart|reboot|کرش|crash|بالانمیاد|بالانمیا|ازکارمیافته|مدامقطع|دائمقطع|مدامخاموش)/,
  http500: /(internalservererror|خطایسرور|خطای500|ارور500|http500)/,
  slow: /(کند|کندی|slow|آهسته|اهسته|تاخیر|latency|دیرلود|دیرباز|زمانپاسخ|لگ)/,
  deploy: /(استقرار|دیپلوی|deploy|انتشار|ریلیز|release|بیلد|build|نسخهجدید|نسخهیجدید|بروزرسانی|بهروزرسانی)/,
  health: /(سلامت|health|وضعیت|چطوره|حالش|status|چککن|بازرسی|مشکلدارد|مشکلداره)/,
  explain: /(توضیح|یعنیچی|explain|شرحبده|بیشتربگو|دلیلاین|دلیلش)/,
  review: /(بررسیپیشنهاد|اقدامپیشنهادی|راهحل|چهکارکنم|چیکارکنم|چهبایدبکنم|پیشنهادچیه|پیشنهاد|توصیه|remediation|اقدامپیشنهادی)/,
  simulate: /(شبیهسازی|شبیه ?سازی|simulate|simulation|سیمولیت|آزمایشی)/,
};
const has500 = (spaced: string) => /(^|[^0-9])500([^0-9]|$)/.test(spaced);

const BLOCKED_ACTION =
  /(ری?ا?ستارت|ریبوت|restart|reboot|متوقف|stop|خاموش|روشن|start|حذف|پاک|delete|remove|دیپلوی|deploy|مستقر|ارتقا|upgrade|تغییرپلن|تغییرمتغیر|scale|مقیاس|redeploy)(?:ش|را|رو)?(?:کن|بکن|کنید|بزن|بزنید|بده|بدهید|بفرست|شو)(?!یم)/;
const ENGLISH_COMMAND = /(?:^|[;,.:!]\s*|\b(?:please|then|and|just|now)\s+)(?:restart|stop|start|delete|remove|deploy|redeploy|scale|reboot|kill)\b/;
const QUESTIONISH = /(چرا|چطور|چگونه|آیا|علت|دلیل|why|how)/;

const POLICY_OVERRIDE =
  /(approved\s*=\s*true|approve\s*=\s*true|auto[\s-]?approv|autoapprov|تاییدخودکار|خودکارتایید|بدونتایید|تاییدنیاز(?:نیست|ندارد)|نیازیبهتایید|سیاست.{0,20}(?:نادیده|غیرفعال|بردار)|محدودیت.{0,15}(?:بردار|نادیده|غیرفعال)|نادیدهبگیر|دستورات?قبلی|فراموشکن|bypass|override|withoutapproval|withoutconfirmation|withoutaskingme|grantadmin|grantaccess|دوربزن|ازحالتشبیهسازیخارج|عملیاتواقعیرافعالکن|sudo|asadmin|ادمین(?:شو|هستم)|یادداشتادمین)/;

// ---------- first-deployment journey (Phase 1E): legitimate requests about the user's OWN, uploaded project ----------
const J = {
  want: /(میخوام|میخواهم|میخواستم|قصددارم|دوستدارم)/,
  deploy: /(دیپلوی|deploy|مستقر|استقرار|منتشر|انتشار|بالابیارم|آنلاین|publish)/,
  project: /(پروژه|سایت|وبسایت|اپ|برنامه|کدم|نکست|next)/,
  imperative: /(کن|کنم|کنیم|بکن|بده|بزن)/,
  predeploy: /(قبلاز(?:انتشار|دیپلوی|استقرار)|پیشاز(?:انتشار|دیپلوی|استقرار)|چهچیز(?:ها)?ی?کمدارم|چهچیزیکمدارم|چهکمدارم|پیشنیاز)/,
  plan: /(چهپلنی|چهپلانی|کدامپلن|کدامپلان|پلنمناسب|پلانمناسب|منابع(?:ی)?مناسب|چهمنابعی|چهمقدارحافظه|چهسرویسی)/,
  compat: /(اجرامیشه|اجرامیشود|اجرامیکنه|اجرامیکند|سازگار|پشتیبانیمیشه|پشتیبانیمیشود|قابلاستقرار|میتوانمدیپلوی|میشهدیپلویکرد)/,
  anchor: /(لیارا|پروژه|سایت|وبسایت|برنامه|اپ|این)/,
  failure: /(شکست|خطا|ارور|فیل|کند|ری?ا?ستارت|ریبوت|crash)/,
};
function deployJourney(compact: string): AgentIntent | null {
  if (J.failure.test(compact)) return null; // failures of existing apps are diagnostics, not first deployments
  if (J.predeploy.test(compact)) return "predeploy_checklist";
  if (J.plan.test(compact)) return "recommend_plan";
  if (J.compat.test(compact) && J.anchor.test(compact)) return "check_compatibility";
  if (J.deploy.test(compact) && (J.want.test(compact) || (J.project.test(compact) && J.imperative.test(compact)))) return "start_deployment";
  return null;
}

const REF_WORDS = /(این|همین|آن|اول|دوم|سوم|چهارم|آخر|یکم|دومی|اولی|سومی)/;

const ORDINALS: [RegExp, number][] = [
  [/(^| )(اول|اولی|یکم|1)( |$)/, 1],
  [/(^| )(دوم|دومی|2)( |$)/, 2],
  [/(^| )(سوم|سومی|3)( |$)/, 3],
  [/(^| )(چهارم|4)( |$)/, 4],
];

function windowOf(spaced: string): { minutes: number | null; noteFa?: string } {
  const m = /(\d+)\s*(دقیقه|ساعت|روز)/.exec(spaced);
  const words: [RegExp, number][] = [
    [/ربع ساعت/, 15],
    [/(^| )(یک|1) ساعت/, 60],
    [/(^| )(شش|6) ساعت/, 360],
    [/(^| )(یک|1) روز|دیروز|24 ساعت|بیست و چهار ساعت|شبانه/, 1440],
  ];
  for (const [re, v] of words) if (re.test(spaced)) return { minutes: v };
  if (m) {
    const n = Number(m[1]);
    const unit = m[2]!;
    const min = unit === "دقیقه" ? n : unit === "ساعت" ? n * 60 : n * 1440;
    if ((WINDOW_OPTIONS as readonly number[]).includes(min)) return { minutes: min };
    return { minutes: null, noteFa: "بازهٔ خواسته‌شده پشتیبانی نمی‌شود؛ از بازهٔ پیش‌فرض ۱ ساعت استفاده شد (بازه‌های مجاز: ۱۵ دقیقه، ۱ ساعت، ۶ ساعت، ۲۴ ساعت)." };
  }
  return { minutes: null };
}

const APP_KEYWORD = /(?:^|\s)(?:برنامه|اپ|اپلیکیشن|سرویس|app|application)\s+([a-z0-9][a-z0-9-]{1,61}[a-z0-9])(?=\s|$)/g;
const HYPHEN_NAME = /(?:^|\s)([a-z0-9]+(?:-[a-z0-9]+)+)(?=\s|$)/g;

export function extractApps(spaced: string, apps: string[]): { found: string[]; unknown: string[] } {
  const allowed = new Set(apps);
  const found = new Set<string>();
  const unknown = new Set<string>();
  const tokens = spaced.split(/[^a-z0-9-]+/).filter(Boolean);
  for (const t of tokens) if (allowed.has(t)) found.add(t);
  for (const re of [APP_KEYWORD, HYPHEN_NAME]) {
    for (const m of spaced.matchAll(re)) {
      const name = m[1]!;
      if (!allowed.has(name)) unknown.add(name);
    }
  }
  return { found: [...found], unknown: [...unknown] };
}

const supportedList = () => SUGGESTED_PROMPTS.map((s) => s.text);

/** Parse one operator message. Pure and deterministic. */
export function parseIntent(text: string, ctx: ParseContext): ParseResult {
  if (typeof text !== "string" || text.trim() === "") return { kind: "unsupported", reason: "empty", messageFa: "پیام خالی است. یکی از درخواست‌های پشتیبانی‌شده را بنویسید.", suggestions: supportedList() };
  if (text.length > MAX_MESSAGE_CHARS) return { kind: "unsupported", reason: "too_long", messageFa: `پیام بیش از ${MAX_MESSAGE_CHARS} نویسه است. لطفاً کوتاه‌تر و مشخص‌تر بنویسید.`, suggestions: supportedList() };
  const norm = normalize(text);
  const { spaced } = norm;
  let compact = norm.compact;

  // 1) attempts to override safety policy / approval are refused outright (and audited by the caller)
  if (POLICY_OVERRIDE.test(compact) || POLICY_OVERRIDE.test(spaced) || injectionSuspect(text)) {
    return { kind: "unsupported", reason: "policy_override", messageFa: "این درخواست تلاش برای دور زدن سیاست‌های امنیتی یا تأیید است و پذیرفته نمی‌شود. هیچ متنی نمی‌تواند تأیید را جایگزین کند: تأیید فقط از دکمهٔ تأیید معتبرِ مرتبط با یک پیشنهاد مشخص انجام می‌شود، و در این نسخه همهٔ عملیات فقط شبیه‌سازی‌اند.", suggestions: supportedList() };
  }

  // 2) apps: only names from the authorised list; unknown names are refused (no existence oracle)
  const { found, unknown } = extractApps(spaced, ctx.apps);
  if (unknown.length > 0 && found.length === 0) {
    return { kind: "unsupported", reason: "unknown_app", messageFa: "برنامه‌ای با این نام در فهرست برنامه‌های مجاز شما نیست. فقط برنامه‌های مجاز قابل بررسی‌اند؛ نام را از فهرست انتخاب کنید.", suggestions: ctx.apps.slice(0, 5).map((a) => `وضعیت سلامت ${a} را بررسی کن`) };
  }
  if (found.length > 1) {
    return { kind: "clarify", reason: "multiple_apps", questionFa: "چند برنامه نام برده شد. کدام را بررسی کنم؟", options: found.map((a) => ({ labelFa: a, text: `${text.trim()} (${a})` })).slice(0, 5) };
  }
  // app names must not feed the keyword families (an app called "demo-http500" is not a report of HTTP 500)
  for (const a of [...found, ...unknown]) compact = compact.split(a.replace(/-/g, "")).join("").split(a).join("");
  const kwSpaced = [...found, ...unknown].reduce((acc, a) => acc.split(a).join(" "), spaced);
  const win = windowOf(spaced);
  const askedWords = REF_WORDS.test(spaced);

  // 2b) the first-deployment journey (own, uploaded project; no existing app named): a legitimate request that yields a SAFE PLAN, not a refusal
  if (found.length === 0 && unknown.length === 0) {
    const j = deployJourney(compact);
    if (j) return { kind: "resolved", intent: j, app: null, windowMinutes: null, ref: null, rules: ["family:deploy_journey"] };
  }

  // 3) imperative orders for real operations are never executed or silently converted (unless a SIMULATION is explicitly requested)
  const simulate = F.simulate.test(compact);
  const imperative = (BLOCKED_ACTION.test(compact) || ENGLISH_COMMAND.test(spaced)) && !QUESTIONISH.test(spaced) && !simulate;
  if (imperative) {
    return { kind: "unsupported", reason: "blocked_action", messageFa: "من در این نسخه هیچ عملیات واقعی (ری‌استارت، توقف، تغییر پلن، استقرار، حذف …) انجام نمی‌دهم و دستور مستقیم هم اجرا نمی‌شود. می‌توانم علت مشکل را بررسی کنم، اقدام‌های ممکن را توضیح دهم و فقط یک «طرح شبیه‌سازی‌شده» بسازم که هیچ تأثیر واقعی ندارد.", suggestions: [...FOLLOW_UPS.map((f) => f.text), ...supportedList().slice(0, 2)] };
  }

  // 4) intent families
  const rules: string[] = [];
  const strong: AgentIntent[] = [];
  if (F.http500.test(compact) || has500(kwSpaced)) { strong.push("investigate_http500"); rules.push("family:http500"); }
  if (F.restart.test(compact)) { strong.push("investigate_restarts"); rules.push("family:restart"); }
  if (F.slow.test(compact)) { strong.push("investigate_slow"); rules.push("family:slow"); }
  if (F.deploy.test(compact)) { strong.push("investigate_deployments"); rules.push("family:deploy"); }

  const ordinal = ORDINALS.find(([re]) => re.test(spaced));
  const ref = ordinal ? { index: ordinal[1] } : askedWords ? { index: 1 } : null;
  const appFromText = found[0] ?? null;
  const app = appFromText ?? ctx.lastApp ?? (ctx.apps.length === 1 ? ctx.apps[0]! : null);
  const base = { app, windowMinutes: win.minutes, windowNoteFa: win.noteFa, ref, rules };

  const needReport = (intent: AgentIntent): ParseResult =>
    ctx.hasReport
      ? { kind: "resolved", intent, ...base, app: appFromText ?? ctx.lastApp ?? app }
      : { kind: "clarify", reason: "no_context", questionFa: "برای این درخواست ابتدا باید یک بررسی انجام شده باشد. کدام بررسی را شروع کنم؟", options: SUGGESTED_PROMPTS.slice(0, 4) };

  // simulated remediation plan (explicit word, with or without an action noun)
  if (simulate) return needReport("simulate_remediation_plan");

  if (strong.length >= 2) {
    const labels: Record<string, string> = { investigate_http500: "خطای HTTP 500", investigate_restarts: "ری‌استارت‌های مکرر", investigate_slow: "کندی", investigate_deployments: "شکست استقرار" };
    const texts: Record<string, string> = { investigate_http500: SUGGESTED_PROMPTS[1]!.text, investigate_restarts: SUGGESTED_PROMPTS[0]!.text, investigate_slow: SUGGESTED_PROMPTS[2]!.text, investigate_deployments: SUGGESTED_PROMPTS[3]!.text };
    return { kind: "clarify", reason: "ambiguous_intent", candidates: strong, app, windowMinutes: win.minutes, questionFa: "چند موضوع متفاوت در پیام شما هست. کدام را اول بررسی کنم؟ (من هیچ اقدامی را خودکار انتخاب نمی‌کنم.)", options: strong.map((s) => ({ labelFa: labels[s]!, text: texts[s]! })) };
  }

  const explain = F.explain.test(compact);
  const review = F.review.test(compact);
  // follow-ups about the current report take priority when a reference is used
  if (explain && (askedWords || ordinal) && ctx.hasReport) return needReport("explain_finding");
  if (review && !strong.length) return needReport("review_remediation");
  if (explain && !strong.length) return needReport("explain_finding");

  if (strong.length === 1) {
    if (!app) return { kind: "clarify", reason: "missing_app", questionFa: "کدام برنامه را بررسی کنم؟", options: ctx.apps.slice(0, 6).map((a) => ({ labelFa: a, text: `${text.trim()} (${a})` })) };
    return { kind: "resolved", intent: strong[0]!, ...base, app };
  }

  if (F.health.test(compact) || (compact === "چرا" && ctx.hasReport)) {
    if (compact === "چرا" && ctx.hasReport) return needReport("explain_finding");
    if (!app) return { kind: "clarify", reason: "missing_app", questionFa: "سلامت کدام برنامه را بررسی کنم؟", options: ctx.apps.slice(0, 6).map((a) => ({ labelFa: a, text: `وضعیت سلامت ${a} را بررسی کن` })) };
    rules.push("family:health");
    return { kind: "resolved", intent: "inspect_health", ...base, app };
  }

  return { kind: "unsupported", reason: "unsupported_request", messageFa: "این درخواست را متوجه نشدم. این دستیار فقط چند درخواست مشخص را پشتیبانی می‌کند (فهم زبان آزاد پیاده‌سازی نشده است). یکی از نمونه‌های زیر را امتحان کنید.", suggestions: supportedList() };
}
