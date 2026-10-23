import { redactText } from "../security/redact";
import { Pseudonymizer } from "../security/pseudonym";
import type { LogLine } from "../domain/models";

/**
 * Pure text classification over ALREADY SANITISED log/event text. Every function returns a CATEGORY (never a copy of the
 * text) so findings carry facts, not attacker-controlled strings. Excerpts for display go through `excerpt()`.
 */

export const lineMs = (l: { time: string | null }): number | null => {
  if (!l.time) return null;
  const t = Date.parse(l.time);
  return Number.isFinite(t) ? t : null;
};

export const isErrorLine = (s: string): boolean => /\b(error|exception|fatal|panic|traceback|unhandled|failed|failure)\b/i.test(s);

// ---- restarts / exits ----
export const isRestartEvent = (s: string): boolean =>
  /\b(restart(?:ed|ing)?|back-?off|crash(?:ed|ing)?|exited|exit code|terminated|oom-?killed|killed)\b/i.test(s);
export const isExitLine = (s: string): boolean =>
  /\b(?:process|application|app|worker|container|applet|server)\s+exited\s+with\s+(?:code|status)\s+\d+|\bexit(?:ed)?\s+(?:with\s+)?(?:code|status)[ =:]*\d+|segmentation fault|\bOOMKilled\b/i.test(s);

// ---- database ----
export type DbCategory = "refused" | "timeout" | "dns" | "auth";
const DB_CONTEXT =
  /(postgres(?:ql)?|mysql|mariadb|mongo(?:db)?|redis|sqlite|mssql|oracle|\bdatabase\b|\bdb\b|psycopg2?|sequelize|prisma|typeorm|knex|sqlalchemy|\bpdo\b|jdbc|ORA-\d+|:(?:5432|3306|27017|6379|1433)\b)/i;
const AUTH_SPECIFIC =
  /(password authentication failed|Access denied for user|ER_ACCESS_DENIED_ERROR|WRONGPASS|invalid username\/password|SASL authentication failed|role "[^"]+" does not exist)/i;
const AUTH_GENERIC = /(authentication failed|auth failed|authorization failed)/i;
const DNS = /(ENOTFOUND|EAI_AGAIN|getaddrinfo|Name or service not known|could not translate host name|unknown host|dns (?:lookup|resolution) failed)/i;
const TIMEOUT = /(ETIMEDOUT|connection timed out|connect timeout|connection timeout|timeout expired|timed out connecting|Connection attempt timed out)/i;
const REFUSED = /(ECONNREFUSED|connection refused|could not connect to server|can't connect to|Connection reset by peer|server closed the connection unexpectedly)/i;

export function classifyDb(s: string): DbCategory | null {
  if (AUTH_SPECIFIC.test(s)) return "auth";
  const ctx = DB_CONTEXT.test(s);
  if (!ctx) return null; // generic network errors without database context are NOT database evidence
  if (AUTH_GENERIC.test(s)) return "auth";
  if (DNS.test(s)) return "dns";
  if (TIMEOUT.test(s)) return "timeout";
  if (REFUSED.test(s)) return "refused";
  return null;
}

// ---- configuration ----
const ENV_NAME = /^[A-Z][A-Z0-9_]{1,63}$/;
const CONFIG_PATTERNS: RegExp[] = [
  /KeyError:\s*['"]([A-Z][A-Z0-9_]{1,63})['"]/,
  /process\.env\.([A-Z][A-Z0-9_]{1,63})\s*(?:is\s+)?(?:undefined|not set|missing)/i,
  /(?:Environment variable|Env(?:ironment)? var(?:iable)?|Config(?:uration)? (?:key|variable|value))\s+['"`]?([A-Z][A-Z0-9_]{1,63})['"`]?\s+(?:is\s+)?(?:required|missing|not set|not defined|undefined|empty)/i,
  /Missing required (?:env(?:ironment)? )?(?:var(?:iable)?s?)?[:\s]+['"`]?([A-Z][A-Z0-9_]{1,63})['"`]?/i,
  /['"`]?([A-Z][A-Z0-9_]{1,63})['"`]?\s+(?:is\s+)?(?:required but )?(?:not set|not defined|is undefined|must be set)\b/,
  /The ([A-Z][A-Z0-9_]{1,63}) setting must not be empty/,
  /(?:getenv|os\.environ(?:\.get)?)\(['"]([A-Z][A-Z0-9_]{1,63})['"]\)[^\n]{0,40}(?:None|null|missing)/i,
];
const CONFIG_GENERIC = /(missing (?:required )?(?:configuration|config|environment variables?)|ImproperlyConfigured|configuration (?:error|missing)|required (?:config|configuration) not found)/i;

/** Returns the NAMES of missing variables (never values) or `generic` when only a vague config error is visible. */
export function extractMissingConfig(s: string): { names: string[]; generic: boolean } | null {
  const names: string[] = [];
  for (const re of CONFIG_PATTERNS) {
    const m = re.exec(s);
    if (m?.[1] && ENV_NAME.test(m[1]) && !names.includes(m[1])) names.push(m[1]);
  }
  if (names.length) return { names, generic: false };
  if (CONFIG_GENERIC.test(s)) return { names: [], generic: true };
  return null;
}

// ---- memory ----
export type OomKind = "explicit" | "process_heap" | "exit137";
export function classifyOom(s: string): OomKind | null {
  if (/(java\.lang\.OutOfMemoryError|JavaScript heap out of memory|\bMemoryError\b|FATAL ERROR: .*allocation failed)/i.test(s)) return "process_heap";
  if (/(OOMKilled|oom[-_ ]?kill(?:ed|er)?|out of memory|Killed process \d+|Memory cgroup out of memory|Cannot allocate memory|\bENOMEM\b)/i.test(s)) return "explicit";
  if (/(exit(?:ed)?(?:\s+with)?\s+(?:code|status)[ =:]*137\b|\bSIGKILL\b)/i.test(s)) return "exit137";
  return null;
}

// ---- HTTP ----
const METHODS = "GET|POST|PUT|PATCH|DELETE|HEAD|OPTIONS";
/** Explicit 5xx status codes found in a log line (access-log style, framework messages, status fields). */
export function http5xx(s: string): number[] {
  const out = new Set<number>();
  const push = (v: string | undefined) => {
    const n = Number(v);
    if (n >= 500 && n <= 599) out.add(n);
  };
  for (const m of s.matchAll(new RegExp(`(?:"(?:${METHODS}) [^"]*"|\\b(?:${METHODS}) \\S+)\\s+(?:HTTP/[\\d.]+"?\\s+)?(5\\d\\d)\\b`, "g"))) push(m[1]);
  for (const m of s.matchAll(/\bstatus(?:Code| code)?\s*[=:]\s*(5\d\d)\b/gi)) push(m[1]);
  for (const m of s.matchAll(/\b(5\d\d)\s+Internal Server Error\b|\bHTTP\/[\d.]+\s+(5\d\d)\b/g)) push(m[1] ?? m[2]);
  if (/\bInternal Server Error\b/i.test(s)) out.add(500);
  return [...out];
}

// ---- prompt injection (data hygiene only; never used to decide actions) ----
export const injectionSuspect = (s: string): boolean =>
  /((ignore|disregard|forget)\s+(all\s+)?(the\s+)?(previous|prior|above|earlier)\s+(instructions?|prompts?|rules?)|system prompt|you are now\b|new instructions?\s*:|\bact as\b|\bsudo\b|rm\s+-rf|curl\s+[^|\n]*\|\s*(?:ba)?sh|(delete|remove|destroy)\s+(the\s+)?(app|application|database)|(restart|redeploy|scale)\s+(the\s+)?(app|application)\b|<\/?(system|assistant|user)>|\[INST\])/i.test(s);

/**
 * A model must never CLAIM to have performed or approved something: nothing it writes is executed, and the only record of an action is the backend's own.
 * First-person completion claims (Persian/English) and approval/forged-flag strings are withheld rather than shown. Defence in depth — the real guarantee is that
 * model text has no path to the policy engine, proposals or the executor.
 */
export const actionClaimSuspect = (s: string): boolean =>
  /((?:ری‌?استارت|ریبوت|اجرا|دیپلوی|مستقر|حذف|پاک|تغییر|مقیاس|خاموش|روشن|متوقف|ارتقا|اعمال|فعال|غیرفعال|تنظیم|تایید|تأیید)\s*(?:را|رو)?\s*(?:ثبت\s*)?(?:کردم|دادم|زدم|نمودم)|انجام\s*دادم|approved?\s*=\s*true|auto[\s-]?approv|\bI(?:\s+have|'ve)?\s+(?:just\s+)?(?:restarted|rebooted|deployed|redeployed|scaled|deleted|removed|changed|applied|executed|ran|approved|stopped|started)\b)/i.test(s);

// ---- display excerpts ----
const pseudo = new Pseudonymizer();
/** Shareable-redacted, capped excerpt of untrusted text. Hosts/IPs/paths are pseudonymised. */
export function excerpt(s: string, max = 200, p: Pseudonymizer = pseudo): string {
  return redactText(s, { shareable: true, pseudo: p, maxLength: max });
}

export function linesOf(lines: LogLine[]): { text: string; ms: number | null }[] {
  return lines.map((l) => ({ text: l.message, ms: lineMs(l) }));
}
