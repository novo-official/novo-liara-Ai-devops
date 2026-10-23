import { extractApps, normalize } from "./intent";
import type { AgentIntent } from "./types";

/**
 * Is this message ABOUT THE OPERATOR'S OWN SERVICE (so any answer must rest on collected evidence), or a general / planning question the model may answer as advice?
 *
 * Root cause this fixes: the keyword parser maps only a few phrasings to an investigation, and everything else it could not map used to fall through to the
 * model-only path — which knows nothing but the question and the app NAMES. So "لاگ‌های liara-agent-demo را ببین", "آیا … سالم است؟" or "مصرف منابع … چقدر است؟" were
 * answered by a model that (correctly) said it had no access. Here "operational" is decided structurally — an authorised app is named, the operator says "my site/app",
 * or a service word comes with a symptom/data word — not by a list of exact phrasings. Pure and deterministic.
 */
const OWN = /(سایتم|وبسایتم|برنامهام|اپم|اپلیکیشنم|سرویسم|سرورم|پروژهام|سایتمن|وبسایتمن|برنامهمن|اپمن|اپلیکیشنمن|سرویسمن|سرورمن)/;
const OWN_EN = /\bmy (?:site|website|app|application|service|server|project)\b/i;
const SITE = /(سایت|وبسایت|برنامه|اپلیکیشن|سرویس|سرور|website|\bsite\b|\bapp\b|\bservice\b|\bserver\b)/;
/** short tokens are matched as WHOLE words (a substring "رم" would hit unrelated words) */
const SYMPTOM_WORD = /(^| )(رم|ram|cpu|سیپییو|لاگ|لاگها|log|logs|5\d\d|http)( |$)/;
const SYMPTOM = /(کند|کندی|دیرجواب|دیربالا|دیرباز|دیرلود|تاخیر|latency|slow|ارور|خطا|error|قطعو{1,2}صل|قطعمیشه|قطعمیشود|قطعشد|ریاستارت|ریستارت|restart|کرش|crash|بالانمیاد|بالانمیا|نمیاد|حافظه|منابع|متریک|metric|سالم|سلامت|وضعیت|health|status|مشکل|down\b|timeout|بالارفته|مصرف)/;
/** planning / pricing / "how does X work" questions: advice, not an investigation (unless the operator names their own app) */
const KNOWLEDGE = /(پلن|plan|قیمت|هزینه|تعرفه|تفاوت|difference|مقایسه|آموزش|چیست|what is|how to|چگونه|راهنما)/;

export function isOperational(text: string, apps: string[]): boolean {
  const { spaced, compact } = normalize(text);
  if (extractApps(spaced, apps).found.length > 0) return true; // names one of the operator's authorised apps
  if (OWN.test(compact) || OWN_EN.test(spaced)) return true; // "my site / my app"
  const symptom = SYMPTOM.test(compact) || SYMPTOM_WORD.test(spaced);
  return SITE.test(compact) && symptom && !KNOWLEDGE.test(compact) && !KNOWLEDGE.test(spaced);
}

/** the same, but for a refused-by-name request: does it read as "my service has a problem"? (used to keep an unknown-app refusal deterministic) */
export function mentionsOwnServiceProblem(text: string): boolean {
  const { spaced, compact } = normalize(text);
  return OWN.test(compact) || OWN_EN.test(spaced) || ((SYMPTOM.test(compact) || SYMPTOM_WORD.test(spaced)) && SITE.test(compact) && !KNOWLEDGE.test(compact));
}

/** Which read-only investigation fits the wording? The sets are supersets: `investigate_slow` collects status, releases, events, logs, CPU and RAM. */
export function broadIntent(text: string): AgentIntent {
  const { spaced, compact } = normalize(text);
  if (/(cpu|سیپییو|پردازنده|حافظه|منابع|مصرف|متریک|metric|کند|دیرجواب|دیربالا|دیرباز|دیرلود|تاخیر|latency|slow)/.test(compact) || /(^| )(رم|ram)( |$)/.test(spaced)) return "investigate_slow";
  if (/(خطا|ارور|error|5\d\d|http)/.test(compact)) return "investigate_http500";
  if (/(ریاستارت|ریستارت|restart|کرش|crash|قطعو{1,2}صل|قطعمیشه|قطعشد|بالانمیاد|بالانمیا|نمیاد)/.test(compact)) return "investigate_restarts";
  if (/(دیپلوی|استقرار|انتشار|deploy|release|ریلیز|بیلد|build)/.test(compact)) return "investigate_deployments";
  return "inspect_health";
}
