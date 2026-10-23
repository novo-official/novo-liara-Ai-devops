import "server-only";
import { getConfig } from "../config/env";
import { configFingerprint } from "../config/fingerprint";
import { getSharedStore } from "../diagnostics/runtime";
import { ownerHashOf } from "../diagnostics/store";
import { hasActiveSession } from "../security/session";
import { getService } from "../liara/service";
import { liveReaderFrom } from "./reader";
import { LiveDeploymentService } from "./service";
import { LiaraCliBackend } from "./cli/backend";
import { NodeProcessRunner } from "./cli/process-runner";
import { createLiveWriteClient } from "./write-client";

const g = globalThis as unknown as { __liveService?: { s: LiveDeploymentService; fp: string; cls: typeof LiveDeploymentService } };
let testService: LiveDeploymentService | undefined;

/**
 * Lazily builds the process-wide live service. With the default configuration NO write client exists (`createLiveWriteClient` returns null), so every live
 * operation fails closed with `live_execution_disabled`. Importing this file opens nothing.
 */
export function getLiveService(): LiveDeploymentService {
  if (testService) return testService;
  const cfg = getConfig();
  const fp = configFingerprint(cfg);
  const cur = g.__liveService;
  if (cur && cur.fp === fp && cur.cls === LiveDeploymentService) return cur.s; // rebuilt after a config or code change (see agent/runtime.ts)
  const s = new LiveDeploymentService({ cfg, store: getSharedStore(), reader: liveReaderFrom(getService()), transport: createLiveWriteClient(cfg), cliBackend: createCliBackend(cfg), isOwnerActive: (ownerHash) => hasActiveSession((id) => ownerHashOf(id) === ownerHash) });
  g.__liveService = { s, fp, cls: LiveDeploymentService };
  return s;
}

/**
 * The restricted CLI backend exists ONLY when the operator enabled it AND pinned the tool (absolute entry path, SHA-256, exact version), in live mode with a token.
 * Default configuration ⇒ null: no process can ever be started.
 */
export function createCliBackend(cfg: ReturnType<typeof getConfig>): LiaraCliBackend | null {
  const c = cfg.cli;
  if (!c.enabled || cfg.dataSource !== "live" || !cfg.liara.token || !c.entry || !c.entrySha256 || !c.version) return null;
  return new LiaraCliBackend({ entry: c.entry, entrySha256: c.entrySha256, version: c.version, timeoutMs: c.timeoutMs, nodeFile: process.execPath }, new NodeProcessRunner());
}

export function __setLiveServiceForTests(s: LiveDeploymentService | undefined): void {
  testService = s;
  if (!s) g.__liveService = undefined;
}
