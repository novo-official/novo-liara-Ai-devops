import { z } from "zod";
import { analyze } from "../diagnostics/engine";
import { createSourceCollector } from "../diagnostics/evidence";
import { EvidenceSet } from "../diagnostics/evidence-set";
import { SOURCES_BY_INTENT } from "../diagnostics/evidence";
import type { DiagnosticLLMProvider } from "../diagnostics/llm/provider";
import { buildNarrative, buildReport, llmContext, type DiagnosticReport } from "../diagnostics/report";
import type { AnyEvidence, Intent as EngineIntent, Semantics, SourceKey } from "../diagnostics/types";
import { capabilityReport } from "../liara/capabilities";
import type { LiaraService } from "../liara/service";
import { WINDOWS_MINUTES, type WindowMinutes } from "../liara/read-client";
import { redactText } from "../security/redact";
import { TOOL_IDS, type ToolId } from "./types";

/**
 * Typed, explicit, READ-ONLY tool registry. Only registered tool ids can run; arguments are validated with strict zod schemas;
 * the target app is authorised against the run's app AND the allowlist; there are no URL/path/shell/import arguments anywhere.
 * Outputs are projected through output schemas (unknown fields stripped) and are built from the already-sanitised service layer.
 */

const APP = z.string().min(3).max(63).regex(/^[a-z0-9][a-z0-9-]{1,61}[a-z0-9]$/);
const WINDOW = z.union(WINDOWS_MINUTES.map((w) => z.literal(w)) as unknown as [z.ZodLiteral<number>, z.ZodLiteral<number>, ...z.ZodLiteral<number>[]]);
const ENGINE_INTENTS = z.enum(["why_restarting", "why_slow", "investigate_http_500", "recent_deployment_failures"]);

const Avail = z.object({ availability: z.string().optional(), evidenceId: z.string().optional() });
const num = z.number().nullable();
const str = z.string().max(300).nullable();

export interface ToolBudget {
  max: number;
  used: number;
}
export const takeBudget = (b: ToolBudget, n: number): boolean => (b.used + n <= b.max ? ((b.used += n), true) : false);

export interface ToolContext {
  svc: LiaraService;
  runId: string;
  /** the single app this run is authorised for */
  app: string;
  windowMinutes: WindowMinutes;
  now: () => number;
  sourceTimeoutMs: number;
  signal?: AbortSignal;
  budget: ToolBudget;
  evidence: Map<SourceKey, AnyEvidence>;
  provider: DiagnosticLLMProvider;
  semantics: Semantics;
  report: { current: DiagnosticReport | null };
  audit: (event: string, data: Record<string, unknown>) => Promise<void>;
  actor: string;
}

export interface ToolDef<I extends z.ZodType = z.ZodType, O extends z.ZodType = z.ZodType> {
  id: ToolId;
  descriptionFa: string;
  input: I;
  output: O;
  /** Liara capability this tool depends on (null = none) */
  capability: string | null;
  /** All registered tools are read-only (R0). Mutation tools do not exist. */
  risk: "R0";
  authz: { session: true; appScoped: boolean };
  timeoutMs: number;
  /** number of upstream reads this tool may trigger (counted against the run budget) */
  budgetCost: number;
  audit: { category: "read" | "analysis"; sensitive: false };
  run(ctx: ToolContext, args: z.output<I>): Promise<{ output: z.input<O>; evidence?: AnyEvidence }>;
}

const def = <I extends z.ZodType, O extends z.ZodType>(d: ToolDef<I, O>) => d;

async function collect(ctx: ToolContext, source: SourceKey): Promise<AnyEvidence> {
  const c = createSourceCollector(ctx.svc, { runId: ctx.runId, app: ctx.app, windowMinutes: ctx.windowMinutes, now: ctx.now, sourceTimeoutMs: ctx.sourceTimeoutMs, signal: ctx.signal });
  const item = await c.collect(source);
  ctx.evidence.set(source, item);
  return item;
}
const avail = (e: AnyEvidence) => ({ availability: e.availability, evidenceId: e.id });
const win = (ctx: ToolContext, w: number) => (ctx.windowMinutes = w as WindowMinutes);
const bound = <T,>(xs: T[], n: number) => xs.slice(0, n);

export const TOOLS = {
  list_apps: def({
    id: "list_apps",
    descriptionFa: "فهرست برنامه‌های مجاز (فقط فهرست سفید)",
    input: z.object({}).strict(),
    output: z.object({ apps: z.array(z.object({ name: z.string(), platform: str, enabled: z.enum(["enabled", "disabled", "unknown"]), deployed: z.boolean().nullable() })).max(500) }),
    capability: "listApps",
    risk: "R0",
    authz: { session: true, appScoped: false },
    timeoutMs: 10_000,
    budgetCost: 1,
    audit: { category: "read", sensitive: false },
    async run(ctx) {
      const r = await ctx.svc.listApps();
      if (!r.ok) throw Object.assign(new Error(r.error.code), { code: r.error.code });
      return { output: { apps: r.data.items.map((a) => ({ name: a.name, platform: a.platform, enabled: (a.scale === 1 ? "enabled" : a.scale === 0 ? "disabled" : "unknown") as "enabled" | "disabled" | "unknown", deployed: a.isDeployed })) } };
    },
  }),
  get_app_details: def({
    id: "get_app_details",
    descriptionFa: "جزئیات برنامه (نام کلیدهای پیکربندی بدون مقدار)",
    input: z.object({ app: APP }).strict(),
    output: Avail.extend({ details: z.object({ name: z.string(), platform: str, status: str, scale: num, planId: str, isDeployed: z.boolean().nullable(), envKeys: z.array(z.string()).max(200) }).nullable() }),
    capability: "getApp",
    risk: "R0",
    authz: { session: true, appScoped: true },
    timeoutMs: 10_000,
    budgetCost: 1,
    audit: { category: "read", sensitive: false },
    async run(ctx) {
      const e = await collect(ctx, "app");
      return { output: { ...avail(e), details: e.source === "app" ? e.data : null }, evidence: e };
    },
  }),
  get_runtime_status: def({
    id: "get_runtime_status",
    descriptionFa: "وضعیت اجرا از روی applets (پیکربندی، اجرا و شواهد سلامت جدا از هم)",
    input: z.object({ app: APP }).strict(),
    output: Avail.extend({ runtime: z.object({ enabled: z.string(), runtime: z.string(), runtimeIsHeuristic: z.boolean(), appletCount: z.number(), byState: z.array(z.object({ raw: z.string(), count: z.number(), class: z.string() })).max(20), failureReasons: z.array(z.string().max(200)).max(5) }).nullable() }),
    capability: "getApplets",
    risk: "R0",
    authz: { session: true, appScoped: true },
    timeoutMs: 10_000,
    budgetCost: 2,
    audit: { category: "read", sensitive: false },
    async run(ctx) {
      const e = await collect(ctx, "runtime");
      const a = e.source === "runtime" && e.data ? e.data.assessment : null;
      return { output: { ...avail(e), runtime: a ? { enabled: a.enabled, runtime: a.runtime, runtimeIsHeuristic: a.runtimeIsHeuristic, appletCount: a.appletCount, byState: a.byState, failureReasons: a.failureReasons } : null }, evidence: e };
    },
  }),
  get_recent_releases: def({
    id: "get_recent_releases",
    descriptionFa: "نسخه‌های اخیر و وضعیت آن‌ها",
    input: z.object({ app: APP, count: z.number().int().min(1).max(10).optional() }).strict(),
    output: Avail.extend({ releases: z.object({ total: num, currentRelease: str, items: z.array(z.object({ tag: str, state: str, createdAt: str, finishedAt: str })).max(10) }).nullable() }),
    capability: "getReleases",
    risk: "R0",
    authz: { session: true, appScoped: true },
    timeoutMs: 10_000,
    budgetCost: 1,
    audit: { category: "read", sensitive: false },
    async run(ctx, args) {
      const e = await collect(ctx, "releases");
      const d = e.source === "releases" ? e.data : null;
      return { output: { ...avail(e), releases: d ? { total: d.total, currentRelease: d.currentRelease, items: bound(d.releases, args.count ?? 10).map((r) => ({ tag: r.tag, state: r.state, createdAt: r.createdAt, finishedAt: r.finishedAt })) } : null }, evidence: e };
    },
  }),
  get_recent_events: def({
    id: "get_recent_events",
    descriptionFa: "رویدادهای اخیر برنامه",
    input: z.object({ app: APP, windowMinutes: WINDOW }).strict(),
    output: Avail.extend({ events: z.object({ rowCount: z.number(), rows: z.array(z.object({ time: str, text: z.string().max(300) })).max(20) }).nullable() }),
    capability: "getEvents",
    risk: "R0",
    authz: { session: true, appScoped: true },
    timeoutMs: 10_000,
    budgetCost: 1,
    audit: { category: "read", sensitive: false },
    async run(ctx, args) {
      win(ctx, args.windowMinutes);
      const e = await collect(ctx, "events");
      const d = e.source === "events" ? e.data : null;
      return { output: { ...avail(e), events: d ? { rowCount: d.rows.length, rows: bound(d.rows, 20).map((r) => ({ time: r.time, text: r.text })) } : null }, evidence: e };
    },
  }),
  get_application_logs: def({
    id: "get_application_logs",
    descriptionFa: "لاگ‌های اخیر برنامه (پاک‌سازی‌شده، حداکثر ۲۰۰ خط)",
    input: z.object({ app: APP, windowMinutes: WINDOW, limit: z.number().int().min(1).max(200).optional() }).strict(),
    output: Avail.extend({ logs: z.object({ lineCount: z.number(), truncated: z.boolean(), source: z.string(), tail: z.array(z.object({ time: str, message: z.string().max(300) })).max(20) }).nullable() }),
    capability: "getLogsV1",
    risk: "R0",
    authz: { session: true, appScoped: true },
    timeoutMs: 10_000,
    budgetCost: 1,
    audit: { category: "read", sensitive: false },
    async run(ctx, args) {
      win(ctx, args.windowMinutes);
      const e = await collect(ctx, "logs");
      const d = e.source === "logs" ? e.data : null;
      return { output: { ...avail(e), logs: d ? { lineCount: d.lines.length, truncated: d.truncated, source: d.source, tail: d.lines.slice(-20).map((l) => ({ time: l.time, message: redactText(l.message, { maxLength: 300 }) })) } : null }, evidence: e };
    },
  }),
  get_cpu_metrics: def({
    id: "get_cpu_metrics",
    descriptionFa: "متریک CPU (مقدار خام؛ بدون واحد تأییدشده)",
    input: z.object({ app: APP, windowMinutes: WINDOW }).strict(),
    output: Avail.extend({ metrics: z.object({ unit: str, schema: z.string(), series: z.array(z.object({ applet: str, count: z.number(), stepSeconds: num, gaps: z.number(), min: num, max: num })).max(10) }).nullable() }),
    capability: "getMetricsCpu",
    risk: "R0",
    authz: { session: true, appScoped: true },
    timeoutMs: 10_000,
    budgetCost: 1,
    audit: { category: "read", sensitive: false },
    async run(ctx, args) {
      win(ctx, args.windowMinutes);
      const e = await collect(ctx, "cpu");
      const d = e.source === "cpu" ? e.data : null;
      return { output: { ...avail(e), metrics: d ? { unit: d.unit, schema: d.schema, series: d.series.map((s) => ({ applet: s.applet, count: s.count, stepSeconds: s.stepSeconds, gaps: s.gaps, min: s.min, max: s.max })) } : null }, evidence: e };
    },
  }),
  get_memory_metrics: def({
    id: "get_memory_metrics",
    descriptionFa: "متریک حافظه (مقدار خام؛ بدون واحد تأییدشده)",
    input: z.object({ app: APP, windowMinutes: WINDOW }).strict(),
    output: Avail.extend({ metrics: z.object({ unit: str, schema: z.string(), series: z.array(z.object({ applet: str, count: z.number(), stepSeconds: num, gaps: z.number(), min: num, max: num })).max(10) }).nullable() }),
    capability: "getMetricsMemory",
    risk: "R0",
    authz: { session: true, appScoped: true },
    timeoutMs: 10_000,
    budgetCost: 1,
    audit: { category: "read", sensitive: false },
    async run(ctx, args) {
      win(ctx, args.windowMinutes);
      const e = await collect(ctx, "memory");
      const d = e.source === "memory" ? e.data : null;
      return { output: { ...avail(e), metrics: d ? { unit: d.unit, schema: d.schema, series: d.series.map((s) => ({ applet: s.applet, count: s.count, stepSeconds: s.stepSeconds, gaps: s.gaps, min: s.min, max: s.max })) } : null }, evidence: e };
    },
  }),
  diagnose_application: def({
    id: "diagnose_application",
    descriptionFa: "تشخیص با موتور قطعی موجود روی شواهد جمع‌آوری‌شده (بدون درخواست جدید به لیارا)",
    input: z.object({ app: APP, intent: ENGINE_INTENTS }).strict(),
    output: z.object({ status: z.string(), hypotheses: z.array(z.object({ key: z.string(), confidence: z.string() })).max(20), recommendationCount: z.number(), evidenceCount: z.number(), narrativeStatus: z.string() }),
    capability: null,
    risk: "R0",
    authz: { session: true, appScoped: true },
    timeoutMs: 10_000,
    budgetCost: 0,
    audit: { category: "analysis", sensitive: false },
    async run(ctx, args) {
      const intent = args.intent as EngineIntent;
      const order = SOURCES_BY_INTENT[intent];
      const items = order.map((s) => ctx.evidence.get(s)).filter((x): x is AnyEvidence => !!x);
      const evidence = new EvidenceSet(items);
      const analysis = analyze({ runId: ctx.runId, intent, evidence, semantics: ctx.semantics, now: ctx.now() });
      const narrative = await buildNarrative(ctx.provider, llmContext({ app: ctx.app, intent, analysis, simulated: ctx.svc.mode === "mock" }), evidence.ids(), { timeoutMs: 3000, signal: ctx.signal });
      ctx.report.current = buildReport({ runId: ctx.runId, app: ctx.app, intent, evidence, analysis, narrative, now: ctx.now() });
      return { output: { status: analysis.diagnosis.status, hypotheses: analysis.diagnosis.hypotheses.map((h) => ({ key: h.key, confidence: h.confidence })), recommendationCount: analysis.recommendations.length, evidenceCount: items.length, narrativeStatus: narrative.status } };
    },
  }),
} as const satisfies Record<ToolId, ToolDef>;

export const isToolId = (v: unknown): v is ToolId => typeof v === "string" && Object.hasOwn(TOOLS, v) && (TOOL_IDS as readonly string[]).includes(v);

export type ToolErrorCode = "unknown_tool" | "invalid_arguments" | "app_not_allowed" | "budget_exceeded" | "capability_unavailable" | "timeout" | "cancelled" | "tool_failed";
export type ToolResult =
  | { ok: true; tool: ToolId; output: unknown; availability?: string; evidenceId?: string; durationMs: number }
  | { ok: false; tool: ToolId | null; error: ToolErrorCode; durationMs: number; detail?: string[] };

/**
 * Single entry point for tool execution. NOTHING else may call a tool's `run`.
 * Order: registry lookup → strict argument validation → app authorisation → capability check → budget → timeout/cancel → output projection → audit.
 */
export async function executeTool(ctx: ToolContext, toolId: unknown, rawArgs: unknown): Promise<ToolResult> {
  const t0 = ctx.now();
  const dt = () => Math.max(0, ctx.now() - t0);
  const fail = async (tool: ToolId | null, error: ToolErrorCode, detail?: string[]): Promise<ToolResult> => {
    await ctx.audit("tool_call", { tool: tool ?? "(unregistered)", outcome: error, ms: dt() });
    return { ok: false, tool, error, durationMs: dt(), detail };
  };
  if (!isToolId(toolId)) return fail(null, "unknown_tool");
  const tool = TOOLS[toolId] as unknown as ToolDef;

  const parsed = tool.input.safeParse(rawArgs ?? {});
  if (!parsed.success) return fail(toolId, "invalid_arguments", parsed.error.issues.slice(0, 5).map((i) => i.path.join(".") || "(root)"));
  const args = parsed.data as Record<string, unknown>;

  if (tool.authz.appScoped) {
    const app = args.app;
    // cross-app and non-allowlisted access are indistinguishable and never reach the service
    if (typeof app !== "string" || app !== ctx.app || !ctx.svc.isAllowed(app)) return fail(toolId, "app_not_allowed");
  }
  if (tool.capability) {
    const cap = capabilityReport(ctx.svc.mode, false).find((c) => c.id === tool.capability);
    if (cap && (cap.verification === "ACCESS_DENIED" || cap.verification === "UNAVAILABLE" || cap.verification === "CONTRACT_MISMATCH")) return fail(toolId, "capability_unavailable");
  }
  if (!takeBudget(ctx.budget, tool.budgetCost)) return fail(toolId, "budget_exceeded");
  if (ctx.signal?.aborted) return fail(toolId, "cancelled");

  let timer: ReturnType<typeof setTimeout> | undefined;
  try {
    const raced = await Promise.race([
      tool.run(ctx, args),
      new Promise<never>((_, rej) => {
        timer = setTimeout(() => rej(Object.assign(new Error("timeout"), { code: "timeout" })), tool.timeoutMs);
      }),
      new Promise<never>((_, rej) => ctx.signal?.addEventListener("abort", () => rej(Object.assign(new Error("cancelled"), { code: "cancelled" })), { once: true })),
    ]);
    const output = tool.output.parse(raced.output); // projection: unknown fields stripped, shapes enforced
    const meta = output as { availability?: string; evidenceId?: string };
    await ctx.audit("tool_call", { tool: toolId, outcome: "succeeded", availability: meta.availability ?? null, ms: dt(), argKeys: Object.keys(args).sort() });
    return { ok: true, tool: toolId, output, availability: meta.availability, evidenceId: meta.evidenceId, durationMs: dt() };
  } catch (e) {
    const code = (e as { code?: string })?.code;
    return fail(toolId, code === "timeout" ? "timeout" : code === "cancelled" ? "cancelled" : "tool_failed");
  } finally {
    if (timer) clearTimeout(timer);
  }
}

/** Static catalogue for UI/docs/tests (no functions). */
export function toolCatalog() {
  return (TOOL_IDS as readonly ToolId[]).map((id) => {
    const t = TOOLS[id] as unknown as ToolDef;
    return { id, descriptionFa: t.descriptionFa, capability: t.capability, risk: t.risk, appScoped: t.authz.appScoped, timeoutMs: t.timeoutMs, budgetCost: t.budgetCost, category: t.audit.category };
  });
}
