import "server-only";
import { getConfig } from "../config/env";
import { configFingerprint } from "../config/fingerprint";
import { getSharedStore } from "../diagnostics/runtime";
import { resolveAiProvider as resolveProvider } from "../ai/resolve";
import { getService } from "../liara/service";
import { AgentRunManager } from "./manager";

const g = globalThis as unknown as { __agentManager?: { m: AgentRunManager; fp: string; cls: typeof AgentRunManager } };
let testManager: AgentRunManager | undefined;

/** Lazily builds the process-wide agent manager (no module-level side effects: importing this file opens nothing). */
export function getAgentManager(): AgentRunManager {
  if (testManager) return testManager;
  const cfg = getConfig();
  const fp = configFingerprint(cfg);
  // reuse only while BOTH the configuration and the code are the ones this instance was built from: after an edit of .env.local or (in dev) of the manager's code, the
  // old instance — with its old routing, provider and data source — must not keep answering requests.
  const cur = g.__agentManager;
  if (cur && cur.fp === fp && cur.cls === AgentRunManager) return cur.m;
  const m = new AgentRunManager({ svc: getService(), store: getSharedStore(), provider: resolveProvider(cfg), runTimeoutMs: cfg.diagnostics.runTimeoutMs, maxConcurrentRuns: cfg.diagnostics.maxConcurrentRuns });
  g.__agentManager = { m, fp, cls: AgentRunManager };
  return m;
}

export function __setAgentManagerForTests(m: AgentRunManager | undefined): void {
  testManager = m;
  if (!m) g.__agentManager = undefined;
}
