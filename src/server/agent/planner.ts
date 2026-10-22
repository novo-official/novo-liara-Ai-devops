import { randomBytes } from "node:crypto";
import { capabilityReport } from "../liara/capabilities";
import type { LiaraService } from "../liara/service";
import { TOOLS } from "./tools";
import type { AnyEvidence, SourceKey } from "../diagnostics/types";
import { ENGINE_INTENT, type AgentIntent, type AgentPlan, type PlanStep, type SkippedStep, type ToolId } from "./types";

/**
 * Bounded planner. It is a pure function from (authorised app, parsed intent, existing evidence, capability state) to an explicit,
 * finite list of READ-ONLY tool calls. No loop, no model, no invented results. Rules (documented in docs/AGENT_ORCHESTRATION.md):
 *  P1 reuse fresh evidence (same app + window, ≤ 5 min old)      P2 skip tools whose capability a probe found denied/unavailable/mismatched
 *  P3 never exceed the tool-call budget                          P4 no duplicate tools
 *  P5 not authorised → empty plan                                P6 diagnose_application is always last and uses only collected evidence
 *  P7 (runtime, in the manager) if logs AND events are unusable → remaining optional deep dives are skipped
 */

export const MAX_TOOL_CALLS = 12; // upstream-read budget per run
export const EVIDENCE_REUSE_MAX_AGE_MS = 5 * 60_000;

interface Tpl {
  tool: ToolId;
  source: SourceKey | null;
  optional: boolean;
  reason: Partial<Record<AgentIntent, string>> & { default: string };
}

const T = {
  app: { tool: "get_app_details", source: "app", optional: false, reason: { default: "برای شناخت پلتفرم، پلن و نام کلیدهای پیکربندی (بدون مقدار)." } },
  runtime: { tool: "get_runtime_status", source: "runtime", optional: false, reason: { default: "برای جداکردن «روشن بودن پیکربندی» از «وضعیت واقعی اجرا» بر پایهٔ applets.", investigate_restarts: "برای دیدن وضعیت و دلیل خروج نمونه‌های در حال اجرا." } },
  events: { tool: "get_recent_events", source: "events", optional: false, reason: { default: "برای دیدن رویدادهای زمان‌دار (ری‌استارت، استقرار).", investigate_restarts: "برای شمارش چرخه‌های ری‌استارت با زمان‌بندی مشخص.", investigate_deployments: "برای دیدن رویدادهای مرتبط با استقرار." } },
  logs: { tool: "get_application_logs", source: "logs", optional: false, reason: { default: "برای یافتن خطاهای صریح در لاگ‌های پاک‌سازی‌شده.", investigate_http500: "برای یافتن خط‌های صریح HTTP 500 و پیام خطای برنامه.", investigate_restarts: "برای یافتن علت خروج (مثلاً خطای دیتابیس یا نبودِ پیکربندی)." } },
  releases: { tool: "get_recent_releases", source: "releases", optional: true, reason: { default: "برای بررسی هم‌زمانی خطاها با آخرین انتشار (فقط همبستگی).", investigate_deployments: "برای دیدن وضعیت نسخه‌های اخیر و اینکه نسخهٔ ناموفق فعلی شده یا نه." } },
  memory: { tool: "get_memory_metrics", source: "memory", optional: true, reason: { default: "برای تکمیل بررسی OOM (مقدار خام؛ بدون واحد تأییدشده نتیجه‌گیری دربارهٔ اتمام حافظه نمی‌شود)." } },
  cpu: { tool: "get_cpu_metrics", source: "cpu", optional: true, reason: { default: "برای بررسی اشباع CPU (فقط با واحد و سقف تأییدشده ادعا می‌شود)." } },
  diagnose: { tool: "diagnose_application", source: null, optional: false, reason: { default: "اجرای موتور تشخیص قطعی موجود روی شواهد جمع‌آوری‌شده؛ هیچ درخواست جدیدی به لیارا نمی‌فرستد." } },
} satisfies Record<string, Tpl>;

const SETS: Partial<Record<AgentIntent, Tpl[]>> = {
  investigate_restarts: [T.app, T.runtime, T.events, T.logs, T.releases, T.memory, T.diagnose],
  investigate_http500: [T.app, T.runtime, T.logs, T.events, T.releases, T.memory, T.diagnose],
  investigate_slow: [T.app, T.runtime, T.cpu, T.memory, T.logs, T.events, T.releases, T.diagnose],
  investigate_deployments: [T.app, T.runtime, T.releases, T.events, T.logs, T.diagnose],
  inspect_health: [T.app, T.runtime, T.events, T.logs, T.releases, T.diagnose],
};

const VERIFICATION = [
  "هر ادعای گزارش باید به شاهدِ موجود ارجاع بدهد (یکپارچگی ارجاع‌ها بررسی می‌شود).",
  "هیچ درخواست نوشتنی به لیارا ارسال نشود (همهٔ مراحل R0 و فقط‌خواندنی‌اند).",
  "اگر شواهد ناقص یا قدیمی باشد، علتی ادعا نشود و کمبودها فهرست شود.",
];

function argsFor(tool: ToolId, app: string, windowMinutes: number, intent: AgentIntent): Record<string, unknown> {
  switch (tool) {
    case "get_app_details":
    case "get_runtime_status":
      return { app };
    case "get_recent_releases":
      return { app, count: 10 };
    case "get_recent_events":
    case "get_cpu_metrics":
    case "get_memory_metrics":
      return { app, windowMinutes };
    case "get_application_logs":
      return { app, windowMinutes, limit: 200 };
    case "diagnose_application":
      return { app, intent: ENGINE_INTENT[intent] };
    default:
      return {};
  }
}

export interface PlanInput {
  svc: LiaraService;
  app: string;
  intent: AgentIntent;
  windowMinutes: number;
  /** evidence already collected in this conversation (any app/window; the planner filters) */
  existingEvidence?: AnyEvidence[];
  now: () => number;
  maxToolCalls?: number;
}

export function createPlan(input: PlanInput): AgentPlan {
  const { svc, app, intent, windowMinutes, now } = input;
  const maxCalls = input.maxToolCalls ?? MAX_TOOL_CALLS;
  const base = { id: `plan_${now().toString(36)}_${randomBytes(3).toString("hex")}`, intent, engineIntent: ENGINE_INTENT[intent] ?? null, app, windowMinutes, risk: "R0" as const, budget: { maxToolCalls: maxCalls }, createdAt: new Date(now()).toISOString() };

  // P5: not authorised → nothing is planned
  if (!svc.isAllowed(app)) {
    return { ...base, steps: [], skipped: [{ tool: "get_app_details", reasonFa: "برنامه در فهرست مجاز نیست؛ هیچ ابزاری اجرا نمی‌شود.", code: "not_authorized" }], expectedEvidence: [], prerequisitesFa: ["برنامه باید در فهرست مجاز باشد."], missingInformationFa: ["برنامهٔ مجاز"], verificationCriteriaFa: VERIFICATION };
  }

  const tpls = SETS[intent];
  if (!tpls) {
    // explain / review / simulate operate on the existing report: no tool calls
    return { ...base, steps: [], skipped: [], expectedEvidence: [], prerequisitesFa: ["یک گزارش تشخیص در همین گفتگو وجود داشته باشد (از شواهد و پیشنهادهای همان گزارش استفاده می‌شود)."], missingInformationFa: [], verificationCriteriaFa: VERIFICATION };
  }

  const caps = capabilityReport(svc.mode, false);
  const reusable = new Map<SourceKey, AnyEvidence>();
  for (const e of input.existingEvidence ?? []) {
    const age = now() - Date.parse(e.collectedAt);
    const sameWindow = e.window === null || Math.round((Date.parse(e.window.to) - Date.parse(e.window.from)) / 60_000) === windowMinutes;
    if (e.app === app && sameWindow && age >= 0 && age <= EVIDENCE_REUSE_MAX_AGE_MS && e.availability === "available") reusable.set(e.source, e);
  }

  const steps: PlanStep[] = [];
  const skipped: SkippedStep[] = [];
  const missing: string[] = [];
  const seen = new Set<ToolId>();
  let cost = 0;
  for (const t of tpls) {
    if (seen.has(t.tool)) continue; // P4
    seen.add(t.tool);
    const toolDef = TOOLS[t.tool];
    if (t.source && reusable.has(t.source)) {
      skipped.push({ tool: t.tool, code: "reused_evidence", reasonFa: "شاهد تازه (کمتر از ۵ دقیقه) از قبل موجود است و دوباره استفاده می‌شود." });
      continue;
    }
    if (toolDef.capability) {
      const cap = caps.find((c) => c.id === toolDef.capability);
      if (cap && (cap.verification === "ACCESS_DENIED" || cap.verification === "UNAVAILABLE" || cap.verification === "CONTRACT_MISMATCH")) {
        skipped.push({ tool: t.tool, code: "capability_unavailable", reasonFa: `قابلیت «${toolDef.capability}» بر پایهٔ بررسی قبلی در دسترس نیست (${cap.verification}).` });
        missing.push(`قابلیت ${toolDef.capability} در دسترس نیست.`);
        continue;
      }
    }
    if (cost + toolDef.budgetCost > maxCalls) {
      skipped.push({ tool: t.tool, code: "budget", reasonFa: "سقف بودجهٔ درخواست‌های این اجرا پر شده است." });
      continue;
    }
    cost += toolDef.budgetCost;
    const args = argsFor(t.tool, app, windowMinutes, intent);
    steps.push({ id: `s${steps.length + 1}`, tool: t.tool, args, reasonFa: t.reason[intent] ?? t.reason.default, expectedEvidence: t.source, risk: "R0", optional: t.optional });
  }
  missing.push("قرارداد API زندهٔ لیارا هنوز تأیید نشده است؛ برداشت‌ها مشروط‌اند.");
  return {
    ...base,
    steps,
    skipped,
    expectedEvidence: steps.map((s) => s.expectedEvidence).filter((x): x is SourceKey => !!x),
    prerequisitesFa: ["برنامه در فهرست مجاز است.", "جلسهٔ معتبر و بدون درخواست هم‌زمان دیگری برای همین برنامه.", "همهٔ مراحل فقط‌خواندنی (R0) هستند."],
    missingInformationFa: missing,
    verificationCriteriaFa: VERIFICATION,
  };
}
