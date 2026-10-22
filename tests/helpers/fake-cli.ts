import { createHash } from "node:crypto";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, statSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { LiaraCliBackend, type CliBackendConfig } from "@/server/live/cli/backend";
import type { ProcessRunner, RunResult, RunSpec } from "@/server/live/cli/process-runner";

/** A FAKE process runner: records every spec, can inspect the private directories WHILE the "CLI" runs, and never starts a process. */
export interface Seen {
  spec: RunSpec;
  homeFiles: string[];
  authFile: { exists: boolean; mode: number | null; json: unknown | null };
  srcFiles: string[];
}
export class FakeProcessRunner implements ProcessRunner {
  calls: Seen[] = [];
  /** what the fake "CLI" prints and how it ends */
  result: Partial<RunResult> = { exitCode: 0, stdout: "Deployment created successfully.\n" };
  /** simulates the CLI's remote effect (e.g. a release appearing in the fake Liara) */
  onRun: (spec: RunSpec) => void | Promise<void> = () => undefined;
  throwOnRun = false;

  async run(spec: RunSpec): Promise<RunResult> {
    const home = spec.env.HOME ?? "";
    const auth = path.join(home, ".liara-auth.json");
    const walk = (dir: string, rel = ""): string[] => (existsSync(dir) ? readdirSync(dir).flatMap((n) => (statSync(path.join(dir, n)).isDirectory() ? walk(path.join(dir, n), rel ? `${rel}/${n}` : n) : [rel ? `${rel}/${n}` : n])).sort() : []);
    this.calls.push({
      spec: { ...spec, args: [...spec.args], env: { ...spec.env } },
      homeFiles: walk(home),
      authFile: { exists: existsSync(auth), mode: existsSync(auth) ? statSync(auth).mode & 0o777 : null, json: existsSync(auth) ? JSON.parse(readFileSync(auth, "utf8")) : null },
      srcFiles: walk(spec.cwd),
    });
    if (this.throwOnRun) throw new Error("runner exploded");
    await this.onRun(spec);
    return { exitCode: 0, signal: null, timedOut: false, spawnError: null, stdout: "", stderr: "", truncated: false, durationMs: 5, ...this.result };
  }
}

/** A minimal fake `@liara/cli` package on disk: `<root>/bin/run.js` + `<root>/package.json` (never executed). */
export function makeFakeCliPackage(over: { name?: string; version?: string; entryBody?: string } = {}) {
  const root = mkdtempSync(path.join(tmpdir(), "fake-liara-cli-"));
  mkdirSync(path.join(root, "bin"));
  const entry = path.join(root, "bin", "run.js");
  const body = over.entryBody ?? "#!/usr/bin/env node\n// fake entry (never executed)\n";
  writeFileSync(entry, body);
  writeFileSync(path.join(root, "package.json"), JSON.stringify({ name: over.name ?? "@liara/cli", version: over.version ?? "9.6.0" }));
  return { root, entry, sha256: createHash("sha256").update(body).digest("hex"), version: over.version ?? "9.6.0", rewriteEntry: (b: string) => writeFileSync(entry, b) };
}

export function makeCliBackend(runner: ProcessRunner, pkg = makeFakeCliPackage(), over: Partial<CliBackendConfig> = {}) {
  const backend = new LiaraCliBackend({ entry: pkg.entry, entrySha256: pkg.sha256, version: pkg.version, timeoutMs: 30_000, nodeFile: "/opt/fixed/node/bin/node", ...over }, runner);
  return { backend, pkg };
}
