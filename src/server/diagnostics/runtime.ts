import "server-only";
import { getConfig } from "../config/env";
import { getService } from "../liara/service";
import { resolveProvider } from "./llm";
import { SqliteLiveStore } from "../live/store";
import type { RunStore } from "./store";
import { DiagnosticRunManager } from "./workflow";

const g = globalThis as unknown as { __runManager?: DiagnosticRunManager; __runStore?: RunStore };
let testManager: DiagnosticRunManager | undefined;

/** Lazily builds the process-wide manager. No module-level side effects: importing this file never opens a DB or a socket. */
export function getRunManager(): DiagnosticRunManager {
  if (testManager) return testManager;
  if (g.__runManager) return g.__runManager;
  const cfg = getConfig();
  const store = (g.__runStore ??= new SqliteLiveStore(cfg.diagnostics.dbPath));
  g.__runManager = new DiagnosticRunManager({
    svc: getService(),
    store,
    provider: resolveProvider(cfg),
    runTimeoutMs: cfg.diagnostics.runTimeoutMs,
    maxConcurrentRuns: cfg.diagnostics.maxConcurrentRuns,
  });
  return g.__runManager;
}

export function __setRunManagerForTests(m: DiagnosticRunManager | undefined): void {
  testManager = m;
  if (!m) g.__runManager = undefined;
}

/** The single process-wide store (diagnostic runs + agent conversations/proposals share one DB and one audit chain). */
export function getSharedStore(): SqliteLiveStore {
  const cfg = getConfig();
  return (g.__runStore ??= new SqliteLiveStore(cfg.diagnostics.dbPath)) as SqliteLiveStore;
}
