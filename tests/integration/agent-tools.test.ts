import { describe, expect, it } from "vitest";
import { createPlan, MAX_TOOL_CALLS } from "@/server/agent/planner";
import { executeTool, isToolId, TOOLS, toolCatalog, type ToolContext } from "@/server/agent/tools";
import { AGENT_INTENTS, TOOL_IDS } from "@/server/agent/types";
import { MockDiagnosticLLMProvider } from "@/server/diagnostics/llm";
import { semanticsFor } from "@/server/diagnostics/semantics";
import { assertNoCanary } from "../helpers/canaries";
import { collect, mockSvc } from "../helpers/scenario-runner";
import { NOW } from "../helpers/evidence-builder";

function ctx(over: Partial<ToolContext> = {}): ToolContext & { audits: [string, Record<string, unknown>][] } {
  const audits: [string, Record<string, unknown>][] = [];
  return {
    svc: mockSvc(), runId: "run_20260102040000_aabbccdd", app: "demo-api", windowMinutes: 60, now: () => NOW, sourceTimeoutMs: 3000, budget: { max: 12, used: 0 }, evidence: new Map(),
    provider: new MockDiagnosticLLMProvider("ok"), semantics: semanticsFor("demo-api", "mock"), report: { current: null }, audit: async (e, d) => void audits.push([e, d]), actor: "agent", audits, ...over,
  };
}

describe("tool registry", () => {
  it("registers exactly the documented read-only tools", () => {
    expect([...TOOL_IDS].sort()).toEqual(["diagnose_application", "get_app_details", "get_application_logs", "get_cpu_metrics", "get_memory_metrics", "get_recent_events", "get_recent_releases", "get_runtime_status", "list_apps"]);
    expect(Object.keys(TOOLS).sort()).toEqual([...TOOL_IDS].sort());
  });
  it("every tool is R0, session-authorised, bounded and non-sensitive", () => {
    for (const t of toolCatalog()) {
      expect(t.risk).toBe("R0");
      expect(t.timeoutMs).toBeGreaterThan(0);
      expect(t.timeoutMs).toBeLessThanOrEqual(30_000);
      expect(t.budgetCost).toBeGreaterThanOrEqual(0);
    }
    for (const id of TOOL_IDS) expect(TOOLS[id].authz.session).toBe(true);
  });
  it("no tool id suggests a mutation", () => {
    for (const id of TOOL_IDS) expect(id).not.toMatch(/restart|scale|create|delete|update|set_|stop|start_|deploy|remove|write|exec|shell|run_/);
  });
  it("isToolId rejects prototype keys and unknown ids", () => {
    for (const v of ["restart_app", "__proto__", "constructor", "toString", "", 5, null, undefined, {}, ["list_apps"]]) expect(isToolId(v)).toBe(false);
    expect(isToolId("list_apps")).toBe(true);
  });
  it("every input schema is strict (extra keys rejected) and has no free-form url/path/command field", () => {
    for (const id of TOOL_IDS) {
      const shape = (TOOLS[id].input as unknown as { shape: Record<string, unknown> }).shape;
      for (const k of Object.keys(shape)) expect(k).not.toMatch(/url|path|command|shell|script|header|method|body|endpoint/i);
    }
  });
});

describe("executeTool — validation & authorization", () => {
  it("unknown / non-registered tools never run", async () => {
    const c = ctx();
    for (const t of ["restart_app", "delete_app", "__proto__", "fetch", 42]) expect(await executeTool(c, t, {})).toMatchObject({ ok: false, error: "unknown_tool" });
  });
  it("strict args: extra keys, wrong types and missing fields are rejected", async () => {
    const c = ctx();
    expect(await executeTool(c, "get_app_details", { app: "demo-api", extra: 1 })).toMatchObject({ ok: false, error: "invalid_arguments" });
    expect(await executeTool(c, "get_app_details", { app: 5 })).toMatchObject({ ok: false, error: "invalid_arguments" });
    expect(await executeTool(c, "get_app_details", {})).toMatchObject({ ok: false, error: "invalid_arguments" });
    expect(await executeTool(c, "get_application_logs", { app: "demo-api", windowMinutes: 7, limit: 10 })).toMatchObject({ ok: false, error: "invalid_arguments" });
    expect(await executeTool(c, "get_application_logs", { app: "demo-api", windowMinutes: 60, limit: 99999 })).toMatchObject({ ok: false, error: "invalid_arguments" });
    expect(await executeTool(c, "list_apps", { url: "http://evil" })).toMatchObject({ ok: false, error: "invalid_arguments" });
  });
  it("path/URL smuggling in the app name is rejected before any request", async () => {
    const c = ctx();
    for (const app of ["../demo-api", "demo-api/../x", "demo-api?x=1", "demo-api%2f", "https://evil.example", "demo api"]) expect(await executeTool(c, "get_app_details", { app })).toMatchObject({ ok: false });
  });
  it("cross-app access is refused even for another allowlisted app", async () => {
    const c = ctx({ app: "demo-api" });
    expect(await executeTool(c, "get_app_details", { app: "demo-shop" })).toMatchObject({ ok: false, error: "app_not_allowed" });
    expect(await executeTool(c, "get_runtime_status", { app: "secret-internal-app" })).toMatchObject({ ok: false, error: "app_not_allowed" });
  });
  it("an app outside the allowlist is refused even if the run claims it", async () => {
    const c = ctx({ app: "not-in-allowlist" });
    expect(await executeTool(c, "get_app_details", { app: "not-in-allowlist" })).toMatchObject({ ok: false, error: "app_not_allowed" });
  });
  it("budget: calls beyond the budget are refused", async () => {
    const c = ctx({ budget: { max: 1, used: 0 } });
    expect(await executeTool(c, "get_app_details", { app: "demo-api" })).toMatchObject({ ok: true });
    expect(await executeTool(c, "get_runtime_status", { app: "demo-api" })).toMatchObject({ ok: false, error: "budget_exceeded" });
  });
  it("cancelled signal stops before upstream work", async () => {
    const ac = new AbortController();
    ac.abort();
    expect(await executeTool(ctx({ signal: ac.signal }), "get_app_details", { app: "demo-api" })).toMatchObject({ ok: false, error: "cancelled" });
  });
  it("audits every call (success and failure) with metadata only", async () => {
    const c = ctx();
    await executeTool(c, "get_app_details", { app: "demo-api" });
    await executeTool(c, "nope", {});
    expect(c.audits.map(([e]) => e)).toEqual(["tool_call", "tool_call"]);
    expect(c.audits[0]![1]).toMatchObject({ tool: "get_app_details", outcome: "succeeded" });
    expect(c.audits[1]![1]).toMatchObject({ outcome: "unknown_tool" });
    assertNoCanary(JSON.stringify(c.audits));
  });
});

describe("executeTool — outputs", () => {
  it("each read tool returns a projected, evidence-linked output in mock mode", async () => {
    const c = ctx();
    for (const [tool, args] of [["list_apps", {}], ["get_app_details", { app: "demo-api" }], ["get_runtime_status", { app: "demo-api" }], ["get_recent_releases", { app: "demo-api" }], ["get_recent_events", { app: "demo-api", windowMinutes: 60 }], ["get_application_logs", { app: "demo-api", windowMinutes: 60, limit: 50 }], ["get_cpu_metrics", { app: "demo-api", windowMinutes: 60 }], ["get_memory_metrics", { app: "demo-api", windowMinutes: 60 }]] as const) {
      const r = await executeTool(c, tool, args);
      expect(r, tool).toMatchObject({ ok: true });
    }
    expect(c.evidence.size).toBeGreaterThanOrEqual(5);
  });
  it("list_apps exposes only allowlisted names", async () => {
    const r = await executeTool(ctx(), "list_apps", {});
    expect(r.ok && (r.output as { apps: { name: string }[] }).apps.map((a) => a.name)).not.toContain("secret-internal-app");
  });
  it("diagnose_application builds the same report the diagnostic engine would (reuses it, no second engine)", async () => {
    const c = ctx({ app: "demo-api" });
    for (const t of ["get_app_details", "get_runtime_status", "get_recent_releases", "get_recent_events"] as const) await executeTool(c, t, { app: "demo-api" });
    await executeTool(c, "get_application_logs", { app: "demo-api", windowMinutes: 60, limit: 200 });
    await executeTool(c, "get_cpu_metrics", { app: "demo-api", windowMinutes: 60 });
    await executeTool(c, "get_memory_metrics", { app: "demo-api", windowMinutes: 60 });
    const r = await executeTool(c, "diagnose_application", { app: "demo-api", intent: "why_restarting" });
    expect(r).toMatchObject({ ok: true });
    expect(c.report.current?.summary.primaryKey).toBe("restart_loop_db_connection_refused");
  });
  it("diagnose_application rejects intents outside the four engine intents", async () => {
    expect(await executeTool(ctx(), "diagnose_application", { app: "demo-api", intent: "restart_now" })).toMatchObject({ ok: false, error: "invalid_arguments" });
  });
});

describe("planner", () => {
  const plan = (intent: (typeof AGENT_INTENTS)[number], over: Partial<Parameters<typeof createPlan>[0]> = {}) => createPlan({ svc: mockSvc(), app: "demo-api", intent, windowMinutes: 60, now: () => NOW, ...over });
  it("is bounded, read-only and starts from verified-allowlist steps", () => {
    for (const intent of ["investigate_restarts", "investigate_http500", "investigate_slow", "investigate_deployments", "inspect_health"] as const) {
      const p = plan(intent);
      expect(p.risk).toBe("R0");
      expect(p.steps.length).toBeGreaterThan(0);
      expect(p.steps.length).toBeLessThanOrEqual(MAX_TOOL_CALLS);
      for (const s of p.steps) {
        expect(isToolId(s.tool)).toBe(true);
        expect(s.risk).toBe("R0");
        expect(TOOLS[s.tool].input.safeParse(s.args).success, `${intent}/${s.tool}`).toBe(true);
      }
      const ids = p.steps.map((s) => s.tool);
      expect(new Set(ids).size).toBe(ids.length);
      expect(ids.at(-1)).toBe("diagnose_application");
    }
  });
  it("each plan carries explanations, expected evidence and verification criteria", () => {
    const p = plan("investigate_restarts");
    expect(p.steps.every((s) => s.reasonFa.length > 5)).toBe(true);
    expect(p.expectedEvidence.length).toBeGreaterThan(0);
    expect(p.verificationCriteriaFa.length).toBeGreaterThan(0);
    expect(p.missingInformationFa.join(" ")).toContain("قرارداد");
  });
  it("follow-up intents plan no tool calls", () => {
    for (const i of ["explain_finding", "review_remediation", "simulate_remediation_plan"] as const) expect(plan(i).steps).toEqual([]);
  });
  it("a non-allowlisted app plans nothing", () => {
    const p = plan("investigate_restarts", { app: "secret-internal-app" });
    expect(p.steps).toEqual([]);
    expect(p.skipped[0]).toMatchObject({ code: "not_authorized" });
  });
  it("budget caps the number of steps and records skipped steps", () => {
    const p = plan("investigate_restarts", { maxToolCalls: 3 });
    expect(p.steps.reduce((n, s) => n + TOOLS[s.tool].budgetCost, 0)).toBeLessThanOrEqual(3);
    expect(p.skipped.some((s) => s.code === "budget")).toBe(true);
  });
  it("fresh evidence of the same app and window is reused instead of re-fetched", async () => {
    const ev = await collect("demo-api", "why_restarting");
    const p = plan("investigate_restarts", { existingEvidence: ev.items });
    expect(p.skipped.some((s) => s.code === "reused_evidence")).toBe(true);
    expect(p.steps.length).toBeLessThan(plan("investigate_restarts").steps.length);
  });
  it("evidence of another app is never reused and window-bound evidence of another window is not either", async () => {
    const other = await collect("demo-shop", "why_restarting");
    expect(plan("investigate_restarts", { existingEvidence: other.items }).skipped.some((s) => s.code === "reused_evidence")).toBe(false);
    const ev = await collect("demo-api", "why_restarting");
    const reused = plan("investigate_restarts", { existingEvidence: ev.items, windowMinutes: 360 }).skipped.filter((s) => s.code === "reused_evidence").map((s) => s.tool);
    for (const windowBound of ["get_application_logs", "get_cpu_metrics", "get_memory_metrics", "get_recent_events"]) expect(reused).not.toContain(windowBound);
  });
  it("stale evidence is not reused", async () => {
    const ev = await collect("demo-api", "why_restarting");
    expect(plan("investigate_restarts", { existingEvidence: ev.items, now: () => NOW + 10 * 60_000 }).skipped.some((s) => s.code === "reused_evidence")).toBe(false);
  });
});
