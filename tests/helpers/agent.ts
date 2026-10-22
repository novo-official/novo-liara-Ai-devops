import { AgentRunManager, type ManagerOptions } from "@/server/agent/manager";
import { MemoryAgentStore, type AgentStore } from "@/server/agent/store";
import { MockDiagnosticLLMProvider } from "@/server/diagnostics/llm";
import { NOW } from "./evidence-builder";
import { mockSvc } from "./scenario-runner";

export const A = "agent-session-A-secret";
export const B = "agent-session-B-secret";

/** Controllable clock so approval expiry can be tested deterministically. */
export function clock(start: number = NOW) {
  let t = start;
  return { now: () => t, advance: (ms: number) => (t += ms), set: (v: number) => (t = v) };
}

export function mkAgent(over: Partial<ManagerOptions> & { store?: AgentStore } = {}) {
  const clk = clock();
  const store = over.store ?? new MemoryAgentStore();
  const m = new AgentRunManager({ svc: mockSvc(), store, provider: new MockDiagnosticLLMProvider("ok"), now: clk.now, runTimeoutMs: 8000, toolTimeoutMs: 4000, maxConcurrentRuns: 9, quotaPerWindow: 99, ...over });
  return { m, store, clk };
}

/** Sends a message and waits for the resulting investigation (if any). */
export async function ask(m: AgentRunManager, text: string, sessionId = A, conversationId?: string | null) {
  const r = await m.handleMessage({ sessionId, conversationId: conversationId ?? null, text });
  if (r.runId) await m.waitFor(r.runId);
  return r;
}

/** Runs a full conversation until a pending proposal exists for the given prompt. */
export async function toProposal(m: AgentRunManager, prompt: string, sessionId = A) {
  const first = await ask(m, prompt, sessionId);
  const second = await ask(m, "یک طرح اصلاحی شبیه‌سازی‌شده بساز", sessionId, first.conversationId);
  if (!second.proposalId) throw new Error("no proposal: " + JSON.stringify(second.messages.map((x) => x.textFa)));
  const run = await m.getRun(first.runId!, sessionId);
  return { conversationId: first.conversationId, runId: first.runId!, proposalId: second.proposalId, view: run.proposals.find((p) => p.proposal.id === second.proposalId)! };
}
