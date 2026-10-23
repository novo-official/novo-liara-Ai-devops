import "server-only";
import { getConfig } from "../config/env";
import { configFingerprint } from "../config/fingerprint";
import { getService } from "../liara/service";
import { resolveAiProvider as resolveProvider } from "../ai/resolve";
import { SqliteLiveStore } from "../live/store";
import type { RunStore } from "./store";
import { DiagnosticRunManager } from "./workflow";

const g = globalThis as unknown as { __runManager?: { m: DiagnosticRunManager; fp: string; cls: typeof DiagnosticRunManager }; __runStore?: RunStore };
let testManager: DiagnosticRunManager | undefined;

/** Lazily builds the process-wide manager. No module-level side effects: importing this file never opens a DB or a socket. */
export function getRunManager(): DiagnosticRunManager {
  if (testManager) return testManager;
  const cfg = getConfig();
  const fp = configFingerprint(cfg);
  const cur = g.__runManager;
  if (cur && cur.fp === fp && cur.cls === DiagnosticRunManager) return cur.m; // rebuilt after a config or code change (see agent/runtime.ts)
  const store = (g.__runStore ??= new SqliteLiveStore(cfg.diagnostics.dbPath));
  const m = new DiagnosticRunManager({
    svc: getService(),
    store,
    provider: resolveProvider(cfg),
    runTimeoutMs: cfg.diagnostics.runTimeoutMs,
    maxConcurrentRuns: cfg.diagnostics.maxConcurrentRuns,
  });
  g.__runManager = { m, fp, cls: DiagnosticRunManager };
  return m;
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
