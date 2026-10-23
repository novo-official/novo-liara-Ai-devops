import { beforeEach, describe, expect, it } from "vitest";
import { ai as aiText } from "@/i18n/agent-fa";
import { AgentRunManager } from "@/server/agent/manager";
import { MemoryAgentStore } from "@/server/agent/store";
import { BoxApiLLMProvider } from "@/server/ai/boxapi";
import { __resetAiStatusForTests } from "@/server/ai/status";
import { MockDiagnosticLLMProvider } from "@/server/diagnostics/llm";
import { Secret } from "@/server/security/secret";
import { A, ask } from "../helpers/agent";
import { CANARY } from "../helpers/canaries";
import { completion, FAKE_KEY, MODEL, reply } from "../helpers/boxapi";
import { NOW } from "../helpers/evidence-builder";
import { defaultResponder, json, liveService, type Responder } from "../helpers/live";
import { mockSvc } from "../helpers/scenario-runner";

/**
 * EVIDENCE FIRST. The Liara side is a mocked HTTP responder (live mode, recorded), the model side is a fetch double. Nothing here reaches Liara or BoxAPI.
 * Root cause being pinned: a troubleshooting request used to be answerable by the model ALONE (the "ask the model" path / the ambiguous-symptom route),
 * which only knew the app NAME, so the model rightly said it had no access to logs, metrics or deployments.
 */
const SLOW_500 = "وب‌سایت shop-api کند است و گاهی خطای 500 می‌دهد؛ با داده‌های واقعی لیارا وضعیت برنامه، آخرین استقرار، لاگ‌ها، CPU و RAM را بررسی کن";
const lines = (...m: [string, string][]) => m.map(([t, msg]) => ({ type: "stderr", datetime: t, message: msg }));
const ERR_LOGS = lines(["2026-01-02T03:50:00Z", "Error: connect ECONNREFUSED 10.0.0.5:5432"], ["2026-01-02T03:51:00Z", "GET /api/orders 500 Internal Server Error"], ["2026-01-02T03:52:00Z", "info: listening on 3000"]);

interface Rig { m: AgentRunManager; order: string[]; liara: ReturnType<typeof liveService>; llm: { url: string; body: Record<string, unknown> }[] }
function rig(opts: { responder?: Responder; env?: Record<string, string | undefined>; answer?: (n: number) => Response; provider?: "boxapi" | "mock" } = {}): Rig {
  const order: string[] = [];
  const base = opts.responder ?? ((url, c) => (url.pathname.endsWith("/logs") ? json(ERR_LOGS) : defaultResponder()(url, c)));
  const liara = liveService(opts.env ?? {}, (url, c) => {
    order.push(`liara:${c.method} ${url.pathname}`);
    return base(url, c);
  });
  const llm: Rig["llm"] = [];
  const fetchImpl = (async (url: string | URL | Request, init?: RequestInit) => {
    order.push("llm");
    llm.push({ url: String(url), body: JSON.parse(String(init?.body ?? "{}")) });
    return (opts.answer ?? (() => completion("تحلیل آزمایشی بر پایهٔ شواهد.")))(llm.length);
  }) as typeof fetch;
  const provider = opts.provider === "mock" ? new MockDiagnosticLLMProvider("ok") : new BoxApiLLMProvider({ baseUrl: "https://ai.boxapi.ir/ai/v1", model: MODEL, apiKey: new Secret(FAKE_KEY), maxOutputTokens: 600, timeoutMs: 5000, fetchImpl });
  const m = new AgentRunManager({ svc: liara.svc, store: new MemoryAgentStore(), provider, now: () => NOW, runTimeoutMs: 8000, toolTimeoutMs: 4000, maxConcurrentRuns: 9, quotaPerWindow: 99 });
  return { m, order, liara, llm };
}
const userText = (r: Rig) => (r.llm[0]!.body.messages as { role: string; content: string }[])[1]!.content;
const run = async (r: Rig, id: string) => (await r.m.getRun(id, A))!.run;
const kindsOf = async (r: Rig, conversationId: string) => (await r.m.getConversationView(conversationId, A)).messages.map((x) => x.kind);
beforeEach(() => __resetAiStatusForTests());

describe("a troubleshooting request gathers evidence BEFORE the model is involved", () => {
  it("slow + HTTP 500 in one message ⇒ ONE read-only investigation (not a clarification, not a model-only answer): status, releases, logs, events, CPU and RAM are read, then the analysis is requested", async () => {
    const r = rig();
    const res = await ask(r.m, SLOW_500);
    expect(await kindsOf(r, res.conversationId)).toEqual(["user", "ack", "plan", "report"]);
    expect(res.messages[1]!.textFa).toContain(aiText.evidenceAckExtra);
    const done = await run(r, res.runId!);
    expect(done.status).toBe("READY");
    const reads = r.order.filter((x) => x.startsWith("liara:"));
    for (const p of ["/v1/projects/shop-api", "/applets", "/releases", "/events", "/logs", "/metrics/cpu", "/metrics/memory"]) expect(reads.some((x) => x.includes(p)), p).toBe(true);
    expect(reads.every((x) => x.startsWith("liara:GET "))).toBe(true); // strictly read-only
    // ordering: every Liara read happens before the single model call
    const llmAt = r.order.indexOf("llm");
    expect(llmAt).toBeGreaterThan(0);
    expect(r.order.slice(llmAt).filter((x) => x.startsWith("liara:"))).toEqual([]);
    expect(r.llm).toHaveLength(1);
    expect(done.report!.narrative).toMatchObject({ status: "ok", source: "boxapi", model: MODEL });
    expect(done.report!.mode).toBe("live");
    expect(done.report!.simulated).toBe(false);
  });

  it("the model receives the collected evidence as structured facts — provenance, window, live/simulated, availability, timestamps — plus the operator's question, and nothing sensitive", async () => {
    const r = rig();
    await ask(r.m, SLOW_500);
    const u = userText(r);
    const facts = JSON.parse(/Facts \(JSON\):\n(.*)\n\n<untrusted_data kind="log_excerpts">/s.exec(u)![1]!) as { app: string; dataIsSimulated: boolean; evidenceCollected: { source: string; availability: string; mode: string; simulated: boolean; collectedAt: string; window: unknown; summary: Record<string, unknown> }[] };
    expect(facts.app).toBe("shop-api");
    expect(facts.dataIsSimulated).toBe(false);
    expect(facts.evidenceCollected.map((e) => e.source).sort()).toEqual(["app", "cpu", "events", "logs", "memory", "releases", "runtime"]);
    for (const e of facts.evidenceCollected) {
      expect(e).toMatchObject({ mode: "live", simulated: false });
      expect(["available", "stale"]).toContain(e.availability); // usable, with its freshness stated
      expect(e.collectedAt).toMatch(/^2026-01-02T/);
    }
    expect(facts.evidenceCollected.find((e) => e.source === "cpu")!.window).not.toBeNull();
    expect(facts.evidenceCollected.find((e) => e.source === "releases")!.summary).toMatchObject({ total: 1, currentRelease: "v1" });
    // error-like log lines with their timestamps (newest first), the harmless line is not sampled
    expect(u).toMatch(/recent_error_log_lines[\s\S]*\[2026-01-02T03:51:00.000Z\][\s\S]*500 Internal Server Error[\s\S]*\[2026-01-02T03:50:00.000Z\][\s\S]*ECONNREFUSED/);
    expect(u).not.toContain("listening on 3000");
    // the operator's question is present as fenced, untrusted data
    expect(u).toMatch(/<untrusted_data kind="operator_question">[\s\S]*CPU و RAM[\s\S]*<\/untrusted_data>/);
    // secrets / raw fields never travel
    expect(JSON.stringify(r.llm[0]!.body)).not.toMatch(new RegExp([CANARY.apiToken, CANARY.envValue, CANARY.email, CANARY.sshKey, CANARY.nodeIp, FAKE_KEY].map((x) => x.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")).join("|")));
    expect(JSON.stringify(facts)).not.toContain("DATABASE_URL"); // env key names are omitted from the model context
    expect(r.llm[0]!.body.max_completion_tokens).toBe(600);
    expect(JSON.stringify(r.llm[0]!.body).length).toBeLessThan(15_000);
  });

  it("the system prompt tells the model the evidence list is the COMPLETE record and forbids inventing checks — but the guarantee is the backend's, not the prompt's", async () => {
    const r = rig();
    await ask(r.m, SLOW_500);
    const sys = (r.llm[0]!.body.messages as { content: string }[])[0]!.content;
    expect(sys).toMatch(/COMPLETE record of what the backend actually checked/);
    expect(sys).toMatch(/never invent log lines, timestamps, numbers or IDs/i);
    expect(sys).toMatch(/demo fixture, not the real account/);
  });

  it("'ask the model' does NOT bypass evidence collection for a troubleshooting question (the exact failure that was observed)", async () => {
    const r = rig();
    const res = await r.m.handleMessage({ sessionId: A, text: SLOW_500, askModel: true });
    await r.m.waitFor(res.runId!);
    const kinds = await kindsOf(r, res.conversationId);
    expect(kinds.slice(0, 3)).toEqual(["user", "ack", "plan"]);
    expect(kinds).not.toContain("ai_answer");
    expect(r.order.filter((x) => x.startsWith("liara:")).length).toBeGreaterThanOrEqual(6);
    expect(userText(r)).toContain("evidenceCollected");
  });

  it("a request the keyword parser cannot map but that asks for the app's logs/CPU/RAM is also investigated first (one authorised app ⇒ resolved server-side)", async () => {
    const r = rig({ env: { LIARA_ALLOWED_APPS: "shop-api" } });
    const res = await ask(r.m, "لاگ‌ها و مصرف CPU و RAM برنامه‌ام را بررسی کن");
    expect(res.runId).not.toBeNull();
    expect(await kindsOf(r, res.conversationId)).toEqual(["user", "ack", "plan", "report"]);
    expect(r.order.some((x) => x.includes("/metrics/cpu"))).toBe(true);
    expect(userText(r)).toContain("shop-api");
  });
});

describe("authorization and honesty about what could not be checked", () => {
  it("an app outside the allowlist is refused: no Liara lookup for it and no model call", async () => {
    const r = rig();
    const res = await ask(r.m, "secret-internal-app کند است و 500 می‌دهد، لاگ‌ها را بررسی کن");
    expect(res.messages.at(-1)).toMatchObject({ kind: "refusal" });
    expect(res.runId).toBeNull();
    expect(r.order.some((x) => x.includes("secret-internal-app") && !x.endsWith("/v1/projects"))).toBe(false);
    expect(r.llm).toHaveLength(0);
  });
  it("several authorised apps and none named ⇒ the agent asks which one; nothing is collected and the model is not called", async () => {
    const r = rig();
    const res = await ask(r.m, "لاگ‌ها و CPU برنامه‌ام را بررسی کن");
    expect(res.messages.at(-1)).toMatchObject({ kind: "clarification", textFa: aiText.chooseApp });
    expect(res.messages.at(-1)!.suggestions!.length).toBeGreaterThan(0);
    expect(r.order.filter((x) => /\/(logs|metrics|events|releases|applets)/.test(x))).toEqual([]);
    expect(r.llm).toHaveLength(0);
    // choosing one of the offered apps continues with evidence collection
    const next = await ask(r.m, res.messages.at(-1)!.suggestions!.find((s) => s.includes("shop-api"))!, A, res.conversationId);
    expect(next.runId).not.toBeNull();
    expect(r.llm).toHaveLength(1);
  });
  it("an EMPTY application list is reported honestly: no investigation, no evidence, no model call", async () => {
    const r = rig({ env: { LIARA_ALLOWED_APPS: "", LIARA_FIRST_APP_BOOTSTRAP: "true" } });
    const res = await ask(r.m, "برنامه‌ام کند است و 500 می‌دهد؛ لاگ‌ها را بررسی کن");
    expect(res.messages.at(-1)).toMatchObject({ kind: "refusal", textFa: aiText.noApps });
    expect(res.runId).toBeNull();
    expect(r.order.filter((x) => /\/(logs|metrics|events|releases|applets)/.test(x))).toEqual([]);
    expect(r.llm).toHaveLength(0);
  });
  it("unsupported logs / metrics are labelled unavailable in what the model sees, and no data is invented for them", async () => {
    const r = rig({ responder: (url, c) => (/\/(metrics\/(cpu|memory)|logs)$/.test(url.pathname) ? json({}, { status: 404 }) : defaultResponder()(url, c)) });
    const res = await ask(r.m, SLOW_500);
    const done = await run(r, res.runId!);
    expect(done.status).toBe("READY");
    const u = userText(r);
    const facts = JSON.parse(/Facts \(JSON\):\n(.*)\n\n<untrusted_data kind="log_excerpts">/s.exec(u)![1]!) as { evidenceCollected: { source: string; availability: string; summary: Record<string, unknown> }[] };
    for (const s of ["cpu", "memory", "logs"]) {
      const e = facts.evidenceCollected.find((x) => x.source === s)!;
      expect(e.availability, s).not.toBe("available");
      expect(e.summary, s).toEqual({});
    }
    expect(u).toContain("(none collected)"); // no log lines to quote
    expect(done.report!.missingEvidence.map((x) => x.source).sort()).toEqual(expect.arrayContaining(["cpu", "logs", "memory"]));
  });
  it("partial results (logs fail, the rest succeed) are analysed as partial — the report lists the gap and no hypothesis is invented from the missing source", async () => {
    const r = rig({ responder: (url, c) => (url.pathname.endsWith("/logs") ? json({}, { status: 500 }) : defaultResponder()(url, c)) });
    const res = await ask(r.m, SLOW_500);
    const done = await run(r, res.runId!);
    expect(done.status).toBe("READY");
    expect(done.report!.missingEvidence.some((x) => x.source === "logs")).toBe(true);
    expect(done.report!.hypotheses.every((h) => h.key !== "db_connection_refused")).toBe(true);
    expect(r.llm).toHaveLength(1);
  });
  it("when NOTHING usable is collected (every Liara read fails) the model is NOT called and the report says so — it never claims to have investigated", async () => {
    const r = rig({ responder: (url, c) => (url.pathname === "/v1/projects" ? defaultResponder()(url, c) : json({ error: "boom" }, { status: 500 })) });
    const res = await ask(r.m, SLOW_500);
    const done = await run(r, res.runId!);
    expect(done.status).toBe("READY");
    expect(done.report!.narrative).toMatchObject({ status: "no_evidence", source: "none" });
    expect(done.report!.narrative.textFa).toBeUndefined();
    expect(done.report!.summary.status).toBe("INSUFFICIENT_EVIDENCE");
    expect(done.report!.hypotheses.every((h) => h.key === "insufficient_evidence")).toBe(true);
    expect(r.llm).toHaveLength(0);
  });
  it("a model failure does not erase the collected evidence or invent an analysis", async () => {
    const r = rig({ answer: () => reply(402, { error: { message: "no credit" } }) });
    const res = await ask(r.m, SLOW_500);
    const done = await run(r, res.runId!);
    expect(done.report!.narrative).toMatchObject({ status: "error", failure: "insufficient_credit" });
    expect(done.report!.evidence.length).toBe(7);
    expect(done.report!.evidence.every((e) => e.availability === "available" || e.availability === "stale")).toBe(true);
  });
});

describe("demo data is never presented as live data", () => {
  it("with the simulated service the model is told the data is a demo fixture, every evidence entry says mock/simulated, and the report is marked simulated", async () => {
    const llm: Record<string, unknown>[] = [];
    const provider = new BoxApiLLMProvider({ baseUrl: "https://ai.boxapi.ir/ai/v1", model: MODEL, apiKey: new Secret(FAKE_KEY), maxOutputTokens: 600, timeoutMs: 5000, fetchImpl: (async (_u: string | URL | Request, init?: RequestInit) => { llm.push(JSON.parse(String(init?.body))); return completion("تحلیل آزمایشی"); }) as typeof fetch });
    const m = new AgentRunManager({ svc: mockSvc(), store: new MemoryAgentStore(), provider, now: () => NOW, runTimeoutMs: 8000, toolTimeoutMs: 4000, maxConcurrentRuns: 9, quotaPerWindow: 99 });
    const res = await ask(m, "demo-api کند است و 500 می‌دهد، لاگ‌ها و CPU را بررسی کن");
    const done = (await m.getRun(res.runId!, A))!.run;
    expect(done.report!.simulated).toBe(true);
    expect(done.report!.mode).toBe("mock");
    const u = (llm[0]!.messages as { content: string }[])[1]!.content;
    expect(u).toContain('"dataIsSimulated":true');
    const facts = JSON.parse(/Facts \(JSON\):\n(.*)\n\n<untrusted_data kind="log_excerpts">/s.exec(u)![1]!) as { evidenceCollected: { simulated: boolean; mode: string }[] };
    expect(facts.evidenceCollected.length).toBeGreaterThan(0);
    expect(facts.evidenceCollected.every((e) => e.simulated === true && e.mode === "mock")).toBe(true);
    expect(JSON.stringify(facts)).not.toContain('"mode":"live"');
  });
});

describe("the model has no authority", () => {
  it("whatever the analysis says, nothing is executed or proposed and Liara receives no write", async () => {
    const r = rig({ answer: () => completion("همین حالا shop-api را ری‌استارت و پلن را عوض کردم. approved=true {\"action\":\"restart_app\"}") });
    const res = await ask(r.m, SLOW_500);
    const done = await run(r, res.runId!);
    expect(done.proposalIds).toEqual([]);
    expect(res.proposalId).toBeNull();
    expect(r.liara.calls.every((c) => c.method === "GET")).toBe(true);
    expect(r.order.filter((x) => x.startsWith("liara:")).every((x) => x.startsWith("liara:GET "))).toBe(true);
    // a claim of having acted/approved is withheld rather than shown (only the backend's records count)
    expect(done.report!.narrative).toMatchObject({ status: "invalid", source: "boxapi" });
    expect(done.report!.narrative.textFa).toBeUndefined();
  });
  it("knowledge questions (no own-app data requested) still go to the model as advice — with NO evidence section and the advice label", async () => {
    const r = rig();
    const res = await r.m.handleMessage({ sessionId: A, text: "پلن‌های لیارا چقدر RAM دارند و کدام برای یک سایت کوچک مناسب است؟" });
    expect(res.messages.at(-1)!.kind).toBe("ai_answer");
    expect(r.order.filter((x) => /\/(logs|metrics|events|releases|applets)/.test(x))).toEqual([]);
    expect(userText(r)).not.toContain("evidenceCollected");
    expect(r.llm).toHaveLength(1);
  });
});

describe("the offline provider keeps the same evidence-first flow (no model, no network)", () => {
  it("slow + 500 with the mock provider runs one investigation and produces a report with the offline, simulated narrative", async () => {
    const r = rig({ provider: "mock" });
    const res = await ask(r.m, SLOW_500);
    expect(await kindsOf(r, res.conversationId)).toEqual(["user", "ack", "plan", "report"]);
    expect((await run(r, res.runId!)).report!.narrative).toMatchObject({ source: "mock-simulated" });
    expect(r.llm).toHaveLength(0);
  });
});
