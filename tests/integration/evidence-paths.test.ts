import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { AgentRunManager } from "@/server/agent/manager";
import { __setAgentManagerForTests } from "@/server/agent/runtime";
import { MemoryAgentStore } from "@/server/agent/store";
import { BoxApiLLMProvider } from "@/server/ai/boxapi";
import { __resetAiStatusForTests } from "@/server/ai/status";
import { DiagnosticRunManager } from "@/server/diagnostics/workflow";
import { __setRunManagerForTests } from "@/server/diagnostics/runtime";
import { MemoryRunStore } from "@/server/diagnostics/store";
import { __resetApiLimiterForTests } from "@/server/security/guard";
import { __clearSessionsForTests, createSession } from "@/server/security/session";
import { Secret } from "@/server/security/secret";
import { CANARY } from "../helpers/canaries";
import { completion, FAKE_KEY, MODEL } from "../helpers/boxapi";
import { NOW } from "../helpers/evidence-builder";
import { defaultResponder, installService, json, liveService, resetAll, type Responder } from "../helpers/live";

import * as messages from "@/app/api/agent/messages/route";
import * as conversation from "@/app/api/agent/conversations/[id]/route";
import * as diagRuns from "@/app/api/diagnostic-runs/route";
import * as diagRun from "@/app/api/diagnostic-runs/[id]/route";

/**
 * The two real request paths of the product, driven through their HTTP route handlers: `/agent` (POST /api/agent/messages) and `/assistant`
 * (POST /api/diagnostic-runs). Liara is a recorded, mocked HTTP responder (live mode); the model is a fetch double. No live Liara, no BoxAPI.
 * Pinned: an operational request ALWAYS runs the read-only tools first, the model only ever sees collected evidence, and failures stay visible.
 */
const ORIGIN = "http://localhost:3000";
const ERR_LOGS = [
  { type: "stderr", datetime: "2026-01-02T03:50:00Z", message: "Error: connect ECONNREFUSED 10.0.0.5:5432" },
  { type: "stderr", datetime: "2026-01-02T03:51:00Z", message: "GET /api/orders 500 Internal Server Error" },
];
beforeEach(() => {
  __clearSessionsForTests();
  __resetApiLimiterForTests();
  __resetAiStatusForTests();
});
afterEach(() => {
  __setAgentManagerForTests(undefined);
  __setRunManagerForTests(undefined);
  resetAll();
});

interface Rig { order: string[]; llm: Record<string, unknown>[]; liara: ReturnType<typeof liveService>; agent: AgentRunManager; assistant: DiagnosticRunManager }
function rig(responder?: Responder, o: { toolTimeoutMs?: number; env?: Record<string, string> } = {}): Rig {
  const order: string[] = [];
  const base = responder ?? ((url, c) => (url.pathname.endsWith("/logs") ? json(ERR_LOGS) : defaultResponder()(url, c)));
  const liara = liveService({ LIARA_ALLOWED_APPS: "shop-api", ...(o.env ?? {}) }, (url, c) => {
    order.push(`liara:${c.method} ${url.pathname}`);
    return base(url, c);
  });
  installService(liara.cfg, liara.svc);
  const llm: Record<string, unknown>[] = [];
  const fetchImpl = (async (_u: string | URL | Request, init?: RequestInit) => {
    order.push("llm");
    llm.push(JSON.parse(String(init?.body ?? "{}")));
    return completion("تحلیل آزمایشی بر پایهٔ شواهد.");
  }) as typeof fetch;
  const provider = new BoxApiLLMProvider({ baseUrl: "https://ai.boxapi.ir/ai/v1", model: MODEL, apiKey: new Secret(FAKE_KEY), maxOutputTokens: 600, timeoutMs: 5000, fetchImpl });
  const agent = new AgentRunManager({ svc: liara.svc, store: new MemoryAgentStore(), provider, now: () => NOW, runTimeoutMs: 8000, toolTimeoutMs: o.toolTimeoutMs ?? 4000, maxConcurrentRuns: 9, quotaPerWindow: 99 });
  const assistant = new DiagnosticRunManager({ svc: liara.svc, store: new MemoryRunStore(), provider, now: () => NOW, runTimeoutMs: 8000, sourceTimeoutMs: o.toolTimeoutMs ?? 4000, quotaPerWindow: 99 });
  __setAgentManagerForTests(agent);
  __setRunManagerForTests(assistant);
  return { order, llm, liara, agent, assistant };
}
const user = () => {
  const s = createSession();
  const cookie = `liara_agent_session=${s.id}`;
  const hdr = { cookie, origin: ORIGIN, "content-type": "application/json" };
  return {
    say: (text: string, askModel = false, conversationId?: string) => messages.POST(new Request(`${ORIGIN}/api/agent/messages`, { method: "POST", headers: hdr, body: JSON.stringify({ text, ...(askModel ? { askModel: true } : {}), ...(conversationId ? { conversationId } : {}) }) })),
    conv: (id: string) => conversation.GET(new Request(`${ORIGIN}/api/agent/conversations/${id}`, { headers: { cookie } }), { params: Promise.resolve({ id }) }),
    startRun: (app: string, intent: string) => diagRuns.POST(new Request(`${ORIGIN}/api/diagnostic-runs`, { method: "POST", headers: hdr, body: JSON.stringify({ app, intent }) })),
    getRun: (id: string) => diagRun.GET(new Request(`${ORIGIN}/api/diagnostic-runs/${id}`, { headers: { cookie } }), { params: Promise.resolve({ id }) }),
  };
};
const j = async (r: Response) => JSON.parse(await r.text());
const readsOf = (r: Rig) => r.order.filter((x) => x.startsWith("liara:"));
const evidenceOf = (r: Rig) => {
  const u = ((r.llm[0]!.messages as { content: string }[])[1]!).content;
  return JSON.parse(/Facts \(JSON\):\n(.*)\n\n<untrusted_data kind="log_excerpts">/s.exec(u)![1]!) as { dataIsSimulated: boolean; evidenceCollected: { source: string; availability: string; errorCode: string | null; mode: string; simulated: boolean; collectedAt: string }[] };
};

// every phrasing below used to reach the model-only path (found by probing the real router) — each names the authorised app or says "my site"
const FORMERLY_MODEL_ONLY = [
  "لاگ‌های shop-api رو ببین",
  "آیا shop-api سالمه؟",
  "چرا سایت shop-api گاهی ارور می‌ده؟",
  "مصرف منابع shop-api چقدره؟",
  "shop-api خیلی دیر جواب میده",
  "سرویس shop-api گاهی قطع و وصل میشه",
  "memory shop-api بالا رفته",
  "my website is slow, check the logs and cpu",
  "سایتم کنده",
];

describe("/agent (POST /api/agent/messages): operational requests are investigated, never answered by the model alone", () => {
  describe.each([[false], [true]])("ask-the-model button = %s", (button) => {
    it.each(FORMERLY_MODEL_ONLY)("%s", async (text) => {
      const r = rig();
      const u = user();
      const res = await u.say(text, button);
      expect(res.status).toBe(200);
      const b = await j(res);
      expect(b.runId, "an investigation was started").not.toBeNull();
      await r.agent.waitFor(b.runId);
      const view = await j(await u.conv(b.conversationId));
      expect(view.messages.map((m: { kind: string }) => m.kind)).toEqual(["user", "ack", "plan", "report"]);
      expect(view.messages.some((m: { kind: string }) => m.kind === "ai_answer")).toBe(false);
      expect(view.activeRun.report.narrative).toMatchObject({ source: "boxapi", status: "ok" });
      expect(view.activeRun.report.mode).toBe("live");
      expect(readsOf(r).length).toBeGreaterThanOrEqual(5);
      expect(readsOf(r).every((x) => x.startsWith("liara:GET "))).toBe(true);
      const llmAt = r.order.indexOf("llm");
      expect(r.order.slice(llmAt).filter((x) => x.startsWith("liara:"))).toEqual([]); // all evidence first, then the model
      expect(r.llm).toHaveLength(1);
      expect(JSON.stringify(r.llm[0])).not.toMatch(new RegExp([CANARY.apiToken, CANARY.envValue, CANARY.email, FAKE_KEY].map((x) => x.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")).join("|")));
    });
  });

  it("what the model receives: per-source provenance, timestamps, live/simulated, availability and the error-like log lines — never a bare question", async () => {
    const r = rig();
    const u = user();
    const b = await j(await u.say("آیا shop-api سالمه؟ لاگ‌ها و CPU را هم ببین"));
    await r.agent.waitFor(b.runId);
    const f = evidenceOf(r);
    expect(f.dataIsSimulated).toBe(false);
    expect(f.evidenceCollected.length).toBeGreaterThanOrEqual(5);
    for (const e of f.evidenceCollected) {
      expect(e).toMatchObject({ mode: "live", simulated: false });
      expect(e.collectedAt).toMatch(/^2026-01-02T/);
    }
    const text = ((r.llm[0]!.messages as { content: string }[])[1]!).content;
    expect(text).toMatch(/recent_error_log_lines[\s\S]*\[2026-01-02T03:51:00\.000Z\][\s\S]*500 Internal Server Error/);
  });

  it("tool FAILURES (every Liara read returns 500): the failures are preserved in the report, the model is NOT called, and nothing claims a completed investigation", async () => {
    const r = rig((url, c) => (url.pathname === "/v1/projects" ? defaultResponder()(url, c) : json({ error: "boom" }, { status: 500 })));
    const u = user();
    const b = await j(await u.say("چرا سایت shop-api گاهی ارور می‌ده؟ لاگ‌ها و CPU را بررسی کن"));
    await r.agent.waitFor(b.runId);
    const view = await j(await u.conv(b.conversationId));
    const rep = view.activeRun.report;
    expect(rep.summary.status).toBe("INSUFFICIENT_EVIDENCE");
    expect(rep.narrative).toMatchObject({ status: "no_evidence", source: "none" });
    expect(rep.narrative.textFa).toBeUndefined();
    expect(rep.evidence.length).toBeGreaterThanOrEqual(5);
    for (const e of rep.evidence) {
      expect(e.availability).not.toBe("available"); // the real outcome of each tool is kept…
      expect(e.errorCode).toBeTruthy(); // …with its error category
    }
    expect(rep.hypotheses.every((h: { key: string }) => h.key === "insufficient_evidence")).toBe(true);
    expect(r.llm).toHaveLength(0);
    expect(view.messages.some((m: { kind: string }) => m.kind === "ai_answer")).toBe(false);
  });

  it("a TIMEOUT of one tool is a recorded failure of that source only; the rest is analysed as partial evidence", async () => {
    const r = rig((url, c) => (url.pathname.endsWith("/logs") ? new Promise<Response>(() => undefined) : defaultResponder()(url, c)), { toolTimeoutMs: 250 });
    const u = user();
    const b = await j(await u.say("shop-api خیلی دیر جواب میده"));
    await r.agent.waitFor(b.runId);
    const f = evidenceOf(r);
    const logs = f.evidenceCollected.find((e) => e.source === "logs")!;
    expect(logs.availability).not.toBe("available");
    expect(logs.errorCode).toBe("timeout");
    expect(f.evidenceCollected.filter((e) => e.availability === "available" || e.availability === "stale").length).toBeGreaterThanOrEqual(3);
    expect(((r.llm[0]!.messages as { content: string }[])[1]!).content).toContain("(none collected)");
  });

  it("an app outside the allowlist: refused, no lookup for it, no model — even with the button", async () => {
    for (const button of [false, true]) {
      const r = rig();
      const u = user();
      const b = await j(await u.say("secret-internal-app کند است و ارور می‌دهد", button));
      expect(b.runId).toBeNull();
      expect(b.messages.at(-1).kind).toBe("refusal");
      expect(r.order.some((x) => x.includes("secret-internal-app"))).toBe(false);
      expect(r.llm).toHaveLength(0);
    }
  });

  it("general / planning questions stay model advice (labelled as having no access); they never pretend to be an investigation", async () => {
    const r = rig();
    const u = user();
    for (const q of ["پلن‌های لیارا چقدر RAM دارند؟", "چطور دامنه را به برنامه وصل کنم؟", "تفاوت ری‌استارت و ری‌دیپلوی در لیارا چیست؟"]) {
      const b = await j(await u.say(q));
      expect(b.runId).toBeNull();
      expect(b.messages.at(-1)).toMatchObject({ kind: "ai_answer", ai: { source: "boxapi" } });
    }
    expect(readsOf(r).filter((x) => /\/(logs|metrics|events|releases|applets)/.test(x))).toEqual([]);
    expect(JSON.stringify(r.llm[0])).not.toContain("evidenceCollected");
  });
});

describe("/assistant (POST /api/diagnostic-runs): the same evidence-first guarantees", () => {
  const finish = async (r: Rig, id: string) => {
    await r.assistant.waitFor(id);
    return r;
  };
  it("success: the run collects the app's evidence through the read-only tools and only then asks the model, with that evidence", async () => {
    const r = rig();
    const u = user();
    const start = await u.startRun("shop-api", "why_slow");
    expect(start.status).toBe(202);
    const id = (await j(start)).run.id as string;
    await finish(r, id);
    const done = (await j(await u.getRun(id))).run;
    expect(["COMPLETED", "COMPLETED_WITH_GAPS"]).toContain(done.status);
    expect(done.report.mode).toBe("live");
    expect(done.report.simulated).toBe(false);
    expect(done.report.narrative).toMatchObject({ source: "boxapi", status: "ok", model: MODEL });
    expect(readsOf(r).every((x) => x.startsWith("liara:GET "))).toBe(true);
    for (const p of ["/applets", "/releases", "/events", "/logs", "/metrics/cpu", "/metrics/memory"]) expect(readsOf(r).some((x) => x.includes(p)), p).toBe(true);
    expect(r.order.slice(r.order.indexOf("llm")).filter((x) => x.startsWith("liara:"))).toEqual([]);
    const f = evidenceOf(r);
    expect(f.evidenceCollected.length).toBeGreaterThanOrEqual(5);
    expect(f.evidenceCollected.every((e) => e.mode === "live" && e.simulated === false)).toBe(true);
    expect(r.llm).toHaveLength(1);
  });
  it("tool failures: preserved as unavailable evidence with their error category, model not called, report says there was nothing to analyse", async () => {
    const r = rig((url, c) => (url.pathname === "/v1/projects" ? defaultResponder()(url, c) : json({ error: "boom" }, { status: 500 })));
    const u = user();
    const id = (await j(await u.startRun("shop-api", "investigate_http_500"))).run.id as string;
    await finish(r, id);
    const done = (await j(await u.getRun(id))).run;
    expect(done.status).toBe("FAILED"); // the run does not pretend to have succeeded…
    expect(done.errorCode).toBe("no_usable_evidence"); // …and says why
    expect(done.report.summary.status).toBe("INSUFFICIENT_EVIDENCE"); // while the report keeps the per-source outcomes
    expect(done.report.narrative).toMatchObject({ status: "no_evidence", source: "none" });
    expect(done.report.evidence.every((e: { availability: string; errorCode?: string }) => e.availability !== "available" && !!e.errorCode)).toBe(true);
    expect(r.llm).toHaveLength(0);
  });
  it("partial results: unsupported logs are labelled unavailable in what the model sees and no log lines are invented", async () => {
    const r = rig((url, c) => (url.pathname.endsWith("/logs") ? json({}, { status: 404 }) : defaultResponder()(url, c)));
    const u = user();
    const id = (await j(await u.startRun("shop-api", "investigate_http_500"))).run.id as string;
    await finish(r, id);
    const f = evidenceOf(r);
    expect(f.evidenceCollected.find((e) => e.source === "logs")!.availability).not.toBe("available");
    expect(((r.llm[0]!.messages as { content: string }[])[1]!).content).toContain("(none collected)");
  });
  it("an app outside the allowlist cannot be investigated (404-style refusal, no Liara lookup, no model)", async () => {
    const r = rig();
    const u = user();
    const res = await u.startRun("secret-internal-app", "why_slow");
    expect(res.status).toBeGreaterThanOrEqual(400);
    expect(r.order.some((x) => x.includes("secret-internal-app"))).toBe(false);
    expect(r.llm).toHaveLength(0);
  });
});
