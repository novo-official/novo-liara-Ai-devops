import "server-only";
import { getConfig } from "../config/env";
import { getSharedStore } from "../diagnostics/runtime";
import { resolveProvider } from "../diagnostics/llm";
import { getService } from "../liara/service";
import { AgentRunManager } from "./manager";

const g = globalThis as unknown as { __agentManager?: AgentRunManager };
let testManager: AgentRunManager | undefined;

/** Lazily builds the process-wide agent manager (no module-level side effects: importing this file opens nothing). */
export function getAgentManager(): AgentRunManager {
  if (testManager) return testManager;
  if (g.__agentManager) return g.__agentManager;
  const cfg = getConfig();
  g.__agentManager = new AgentRunManager({ svc: getService(), store: getSharedStore(), provider: resolveProvider(cfg), runTimeoutMs: cfg.diagnostics.runTimeoutMs, maxConcurrentRuns: cfg.diagnostics.maxConcurrentRuns });
  return g.__agentManager;
}

export function __setAgentManagerForTests(m: AgentRunManager | undefined): void {
  testManager = m;
  if (!m) g.__agentManager = undefined;
}
