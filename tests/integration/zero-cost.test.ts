import { readdirSync, readFileSync, statSync } from "node:fs";
import path from "node:path";
import { describe, expect, it } from "vitest";
import { loadConfig } from "@/server/config/env";
import { DisabledLiveLLMProvider, MockDiagnosticLLMProvider, resolveProvider, type LLMContext } from "@/server/diagnostics/llm";
import { MemoryRunStore } from "@/server/diagnostics/store";
import { DiagnosticRunManager } from "@/server/diagnostics/workflow";
import { SCENARIOS } from "../scenarios/scenarios";
import { blockedAttempts } from "../helpers/network-guard";
import { NOW } from "../helpers/evidence-builder";
import { mockSvc } from "../helpers/scenario-runner";

/**
 * ZERO-COST GUARANTEE. These tests do not rely on documentation: they prove, by execution and by static scanning, that
 * no paid / live AI endpoint (BoxAPI or otherwise) can be contacted by this build, and that the global network guard
 * that every test runs under really blocks outbound requests.
 */
const ROOT = path.resolve(__dirname, "../..");
const walk = (dir: string): string[] => readdirSync(dir).flatMap((n) => { const p = path.join(dir, n); return statSync(p).isDirectory() ? (n === "node_modules" || n === ".next" ? [] : walk(p)) : [p]; });
const sourceFiles = [...walk(path.join(ROOT, "src")), ...walk(path.join(ROOT, "scripts"))].filter((f) => /\.(ts|tsx|mjs|js)$/.test(f));
const ctx: LLMContext = { intent: "why_restarting", app: "demo", simulatedData: true, status: "ISSUES_FOUND", overallConfidence: "HIGH", hypotheses: [{ key: "crash_loop", titleFa: "حلقه", confidence: "HIGH", evidenceIds: ["run/logs"], observationsFa: ["x"], limitationsFa: [] }], missingFa: [], untrustedExcerpts: [] };

describe("the network guard itself works (so 'no request happened' is meaningful)", () => {
  it("blocks fetch and records the attempt (and the attempt is cleared here so the suite-level check stays honest)", async () => {
    await expect(fetch("https://api.boxapi.example/v1/chat/completions", { method: "POST", body: "{}" })).rejects.toThrow(/NETWORK BLOCKED/);
    expect(blockedAttempts).toEqual(["https://api.boxapi.example/v1/chat/completions"]);
    blockedAttempts.length = 0;
  });

  it("blocks raw sockets too", async () => {
    const net = await import("node:net");
    expect(() => net.connect({ host: "203.0.113.1", port: 443 })).toThrow(/SOCKET BLOCKED/);
    blockedAttempts.length = 0;
  });
});

describe("live AI is disabled by default and needs BOTH explicit opt-ins", () => {
  it("defaults: provider is the offline mock, live requests are off", () => {
    const cfg = loadConfig({});
    expect(cfg.ai).toMatchObject({ provider: "mock", liveRequestsEnabled: false, boxapi: { model: null, apiKey: null, maxOutputTokens: 600 } }); // no implicit model, no key, a small output cap
    const p = resolveProvider(cfg);
    expect(p).toMatchObject({ kind: "mock", simulated: true });
  });

  it.each(["true", "1", "yes", "on", "TRUE", "enabled"])("AI_LIVE_REQUESTS_ENABLED=%s alone (without AI_PROVIDER=boxapi) is REJECTED at startup", (v) => {
    expect(() => loadConfig({ AI_LIVE_REQUESTS_ENABLED: v })).toThrow(/AI_LIVE_REQUESTS_ENABLED/);
    expect(() => loadConfig({ AI_LIVE_REQUESTS_ENABLED: v, AI_PROVIDER: "mock" })).toThrow(/AI_LIVE_REQUESTS_ENABLED/);
  });
  it("AI_PROVIDER=boxapi alone (without the explicit live opt-in) is REJECTED; with both it is accepted — and a missing key/model is NOT silently defaulted", () => {
    expect(() => loadConfig({ AI_PROVIDER: "boxapi" })).toThrow(/AI_LIVE_REQUESTS_ENABLED/);
    expect(() => loadConfig({ AI_PROVIDER: "boxapi", AI_LIVE_REQUESTS_ENABLED: "false" })).toThrow(/AI_LIVE_REQUESTS_ENABLED/);
    const cfg = loadConfig({ AI_PROVIDER: "boxapi", AI_LIVE_REQUESTS_ENABLED: "true" });
    expect(cfg.ai).toMatchObject({ provider: "boxapi", liveRequestsEnabled: true, boxapi: { model: null, apiKey: null } });
  });

  it.each([undefined, "", "false", "0"])("AI_LIVE_REQUESTS_ENABLED=%j is accepted and stays off", (v) => {
    expect(loadConfig({ AI_LIVE_REQUESTS_ENABLED: v }).ai.liveRequestsEnabled).toBe(false);
  });

  it.each(["openai", "anthropic", "live", "gpt", ""])("AI_PROVIDER=%j is not a valid provider", (v) => {
    if (v === "") return expect(loadConfig({ AI_PROVIDER: undefined }).ai.provider).toBe("mock");
    expect(() => loadConfig({ AI_PROVIDER: v })).toThrow();
  });

  it("'disabled' resolves to the fail-closed provider; even a forged 'live' flag cannot produce a live client (only the explicit BoxAPI resolver can)", () => {
    expect(resolveProvider(loadConfig({ AI_PROVIDER: "disabled" }))).toBeInstanceOf(DisabledLiveLLMProvider);
    const forged = { ai: { provider: "mock", liveRequestsEnabled: true } } as never;
    expect(resolveProvider(forged)).toBeInstanceOf(DisabledLiveLLMProvider);
    expect(resolveProvider({ ai: { provider: "live", liveRequestsEnabled: true } } as never)).toBeInstanceOf(DisabledLiveLLMProvider);
  });

  it("the disabled provider fails closed without any I/O", async () => {
    const before = blockedAttempts.length;
    const r = await new DisabledLiveLLMProvider().summarize(ctx, { timeoutMs: 100 });
    expect(r).toEqual({ ok: false, error: "provider_disabled", provider: { id: "disabled", simulated: false } });
    expect(blockedAttempts.length).toBe(before);
  });
});

describe("no AI-related network code, credentials or dependencies exist", () => {
  it("source and scripts mention no OTHER paid-AI hosts, SDK clients or embedding endpoints", () => {
    const banned = /(api\.openai|openai\.com|api\.anthropic|anthropic\.com|generativelanguage|api\.cohere|api\.mistral|groq\.com|openrouter|\/v1\/(embeddings|completions)|embeddings?\.create|new (OpenAI|Anthropic)\b)/i;
    const offenders = sourceFiles.filter((f) => banned.test(readFileSync(f, "utf8"))).map((f) => path.relative(ROOT, f));
    expect(offenders).toEqual([]);
  });

  it("the BoxAPI host and chat endpoint appear in exactly two source files: the provider (egress) and the config (trusted-host allowlist)", () => {
    const hits = sourceFiles.filter((f) => /ai\.boxapi\.ir|\/chat\/completions/i.test(readFileSync(f, "utf8"))).map((f) => path.relative(ROOT, f).split(path.sep).join("/")).sort();
    expect(hits).toEqual(["src/server/ai/boxapi.ts", "src/server/config/env.ts"]);
  });

  it("only src/server/ai/boxapi.ts can send a model request: no other file outside the Liara/own-origin layers calls fetch with a model payload, and the AI layer never touches Liara", () => {
    const aiFiles = walk(path.join(ROOT, "src/server/ai")).filter((f) => f.endsWith(".ts"));
    for (const f of aiFiles) {
      const code = readFileSync(f, "utf8").replace(/\/\*[\s\S]*?\*\//g, "").replace(/(^|[^:])\/\/.*$/gm, "$1");
      expect(code, f).not.toMatch(/from ["'](\.\.\/)+(live|liara)\//);
      expect(code, f).not.toMatch(/liara\.ir|api\.liara|LIARA_/);
      if (!f.endsWith("boxapi.ts")) expect(code, f).not.toMatch(/\bfetch\s*\(|node:(https?|net|tls|dns)/);
    }
  });

  it("no AI SDK or LLM client library is a dependency", () => {
    const pkg = JSON.parse(readFileSync(path.join(ROOT, "package.json"), "utf8")) as { dependencies?: Record<string, string>; devDependencies?: Record<string, string> };
    const all = Object.keys({ ...pkg.dependencies, ...pkg.devDependencies });
    expect(all.filter((d) => /^(openai|@anthropic-ai\/.*|@ai-sdk\/.*|ai|langchain.*|@langchain\/.*|cohere.*|@google\/generative-ai|groq-sdk|ollama|boxapi.*|llamaindex|@mistralai\/.*)$/i.test(d))).toEqual([]);
  });

  it(".env.example holds no AI key, pins live requests off and keeps every BoxAPI variable commented out", () => {
    const env = readFileSync(path.join(ROOT, ".env.example"), "utf8");
    expect(env).toMatch(/^AI_LIVE_REQUESTS_ENABLED=false$/m);
    expect(env).toMatch(/^AI_PROVIDER=mock$/m);
    expect(env).not.toMatch(/^(BOX|OPENAI|ANTHROPIC|LLM|AI)_?[A-Z_]*(API_?KEY|TOKEN|SECRET)\s*=/im); // no active (uncommented) key assignment
    expect(env).not.toMatch(/^BOXAPI_[A-Z_]+\s*=/m); // every BoxAPI line is a comment
    expect(env).not.toMatch(/box-ai-[0-9a-f]{8,}/i); // and no key-shaped value anywhere
  });

  it("the diagnostics layer cannot perform I/O: no fetch, http(s), net, tls, dns, undici, child_process or process.env", () => {
    const files = walk(path.join(ROOT, "src/server/diagnostics")).filter((f) => f.endsWith(".ts") && !f.endsWith("runtime.ts") && !f.endsWith("store.ts"));
    expect(files.length).toBeGreaterThan(10);
    for (const f of files) {
      const code = readFileSync(f, "utf8").replace(/\/\*[\s\S]*?\*\//g, "").replace(/(^|[^:])\/\/.*$/gm, "$1");
      expect(code, f).not.toMatch(/\bfetch\s*\(|from ["'](node:)?(https?|net|tls|dns|dgram|undici|child_process|worker_threads)["']|XMLHttpRequest|WebSocket|process\.env/);
    }
  });

  it("the agent layer cannot perform I/O: no fetch, http(s), net, tls, dns, undici, child_process or process.env (store/runtime excluded)", () => {
    const files = walk(path.join(ROOT, "src/server/agent")).filter((f) => f.endsWith(".ts") && !f.endsWith("runtime.ts") && !f.endsWith("store.ts"));
    expect(files.length).toBeGreaterThan(8);
    for (const f of files) {
      const code = readFileSync(f, "utf8").replace(/\/\*[\s\S]*?\*\//g, "").replace(/(^|[^:])\/\/.*$/gm, "$1");
      expect(code, f).not.toMatch(/\bfetch\s*\(|from ["'](node:)?(https?|net|tls|dns|dgram|undici|child_process|worker_threads|fs)["']|XMLHttpRequest|WebSocket|process\.env/);
    }
  });

  it("the deployment layer has no network, AI or process capability", () => {
    const files = walk(path.join(ROOT, "src/server/deploy")).filter((f) => f.endsWith(".ts"));
    expect(files.length).toBeGreaterThanOrEqual(12);
    for (const f of files) {
      const code = readFileSync(f, "utf8").replace(/\/\*[\s\S]*?\*\//g, "").replace(/(^|[^:])\/\/.*$/gm, "$1");
      expect(code, f).not.toMatch(/\bfetch\s*\(|from ["'](node:)?(https?|net|tls|dns|dgram|undici|child_process|worker_threads)["']|XMLHttpRequest|WebSocket|process\.env|boxapi|openai|anthropic/i);
    }
  });

  it("the LLM provider layer imports nothing but local types and zod", () => {
    for (const f of walk(path.join(ROOT, "src/server/diagnostics/llm"))) {
      const imports = [...readFileSync(f, "utf8").matchAll(/^import .* from ["']([^"']+)["']/gm)].map((m) => m[1]!);
      for (const i of imports) expect(i.startsWith(".") || i === "zod", `${path.relative(ROOT, f)} imports ${i}`).toBe(true);
    }
  });
});

describe("running the agent performs zero outbound requests", () => {
  it("importing every agent module (except the runtime wiring) has no network side effects", async () => {
    const before = blockedAttempts.length;
    for (const f of walk(path.join(ROOT, "src/server/agent")).filter((x) => x.endsWith(".ts") && !x.endsWith("runtime.ts"))) await import(f);
    expect(blockedAttempts.length).toBe(before);
    expect((globalThis as { __agentManager?: unknown }).__agentManager).toBeUndefined();
  });

  it("a full conversation (investigate → propose → approve → simulate) with the offline provider triggers no network attempt and no AI provider call", async () => {
    const { AgentRunManager } = await import("@/server/agent/manager");
    const { MemoryAgentStore } = await import("@/server/agent/store");
    const before = blockedAttempts.length;
    let narrations = 0;
    const inner = new MockDiagnosticLLMProvider("ok");
    const provider = { id: inner.id, kind: inner.kind, simulated: inner.simulated, summarize: async (c: LLMContext, o: { timeoutMs: number; signal?: AbortSignal }) => (narrations++, inner.summarize(c, o)) };
    const m = new AgentRunManager({ svc: mockSvc(), store: new MemoryAgentStore(), provider, now: () => NOW });
    const r = await m.handleMessage({ sessionId: "s1", text: "چرا demo-api مدام ری‌استارت می‌شود؟" });
    await m.waitFor(r.runId!);
    const s = await m.handleMessage({ sessionId: "s1", conversationId: r.conversationId, text: "یک طرح اصلاحی شبیه‌سازی‌شده بساز" });
    const run = (await m.getRun(r.runId!, "s1")).proposals[0]!;
    await m.decide(s.proposalId!, "s1", { decision: "approve", digest: run.proposal.digest });
    expect(blockedAttempts.length).toBe(before);
    expect(narrations).toBeLessThanOrEqual(1); // only the offline mock narrator, once per report
  });

  it("a full first-deployment journey (upload → analyse → plan → approve → simulate) triggers no network attempt and no AI call", async () => {
    const { AgentRunManager } = await import("@/server/agent/manager");
    const { MemoryAgentStore } = await import("@/server/agent/store");
    const { nextZip } = await import("../helpers/projects");
    const before = blockedAttempts.length;
    let narrations = 0;
    const inner = new MockDiagnosticLLMProvider("ok");
    const provider = { id: inner.id, kind: inner.kind, simulated: inner.simulated, summarize: async (c: LLMContext, o: { timeoutMs: number; signal?: AbortSignal }) => (narrations++, inner.summarize(c, o)) };
    const m = new AgentRunManager({ svc: mockSvc(), store: new MemoryAgentStore(), provider, now: () => NOW });
    const up = await m.receiveProject({ sessionId: "s1", archive: nextZip(), filename: "p.zip" });
    const v = await m.prepareDeployment(up.runId, "s1", {});
    await m.decide(v.proposal.id, "s1", { decision: "approve", digest: v.proposal.digest, confirmAppName: v.proposal.app });
    expect(blockedAttempts.length).toBe(before);
    expect(narrations).toBe(0); // the deployment journey never calls any narrator at all
  });

  it("the agent's default provider resolves to the offline mock and live requests stay off", () => {
    const cfg = loadConfig({ NODE_ENV: "test" });
    expect(cfg.ai.liveRequestsEnabled).toBe(false);
    expect(resolveProvider(cfg).kind).not.toBe("live");
  });
});

describe("running the assistant performs zero outbound AI requests", () => {
  it("importing every diagnostics module has no network side effects and creates no manager", async () => {
    const before = blockedAttempts.length;
    for (const f of walk(path.join(ROOT, "src/server/diagnostics")).filter((x) => x.endsWith(".ts") && !x.endsWith("runtime.ts"))) await import(f);
    expect(blockedAttempts.length).toBe(before);
    expect((globalThis as { __runManager?: unknown }).__runManager).toBeUndefined();
  });

  it("all nine scenarios run end-to-end with the offline provider and trigger no network attempt", async () => {
    const before = blockedAttempts.length;
    const m = new DiagnosticRunManager({ svc: mockSvc(), store: new MemoryRunStore(), provider: resolveProvider(loadConfig({})), now: () => NOW, quotaPerWindow: 99, maxConcurrentRuns: 9, runTimeoutMs: 5000 });
    for (const s of SCENARIOS) {
      const run = await m.start({ sessionId: "s", app: s.app, intent: s.intent });
      await m.waitFor(run.id);
      const done = (await m.get(run.id, "s"))!;
      expect(done.report!.narrative.source).toBe("mock-simulated");
      expect(done.report!.narrative.status).toBe("ok");
    }
    await new Promise((r) => setTimeout(r, 50)); // no background AI work trails the runs
    expect(blockedAttempts.length).toBe(before);
  });

  it("the mock provider is deterministic, labelled as simulated, and needs no credentials", async () => {
    const saved = { ...process.env };
    for (const k of Object.keys(process.env)) if (/KEY|TOKEN|SECRET|AI_|LLM|BOX|OPENAI|ANTHROPIC/i.test(k)) delete process.env[k];
    try {
      const p = new MockDiagnosticLLMProvider("ok");
      const a = await p.summarize(ctx, { timeoutMs: 100 });
      const b = await p.summarize(ctx, { timeoutMs: 100 });
      expect(a).toEqual(b);
      expect(a).toMatchObject({ ok: true, provider: { simulated: true } });
      expect((a as { narrativeFa: string }).narrativeFa).toMatch(/شبیه‌سازی‌شده/);
    } finally {
      Object.assign(process.env, saved);
    }
  });

  it("with AI disabled the assistant still produces a complete deterministic report", async () => {
    const m = new DiagnosticRunManager({ svc: mockSvc(), store: new MemoryRunStore(), provider: resolveProvider(loadConfig({ AI_PROVIDER: "disabled" })), now: () => NOW, runTimeoutMs: 5000 });
    const run = await m.start({ sessionId: "s", app: "demo-oom", intent: "why_restarting" });
    await m.waitFor(run.id);
    const done = (await m.get(run.id, "s"))!;
    expect(done.status).toBe("COMPLETED");
    expect(done.report!.narrative).toMatchObject({ status: "disabled", source: "none" });
    expect(done.report!.summary.primaryKey).toBe("restart_loop_oom_kill");
  });
});
