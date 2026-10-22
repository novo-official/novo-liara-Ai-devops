import "server-only";
import { createHash } from "node:crypto";
import { mkdtempSync, readFileSync, rmSync, statSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { redactText } from "../../security/redact";
import { materializeApprovedSource } from "../artifact";
import type { LiveCliBinding } from "../types";
import { argvTemplateDigest, buildAuthFile, buildCliEnv, buildDeployArgv, CLI_PACKAGE_NAME, CliSpecError, type CliDeployParams } from "./spec";
import type { ProcessRunner } from "./process-runner";

/**
 * RESTRICTED OFFICIAL-CLI DEPLOYMENT BACKEND (default DISABLED; never constructed unless the operator sets LIARA_CLI_ENABLED and pins the tool).
 *
 * What it can do: run `liara deploy …` (one allowlisted command, see spec.ts) from a private directory that holds EXACTLY the files the operator approved.
 * What it deliberately does NOT do: parse the CLI's output for success, retry, run any other subcommand, pass the token on a command line or in the environment,
 * inherit the server's environment, or trust a CLI binary whose identity (entry-file SHA-256 + package name/version) differs from the pinned one.
 * The OUTCOME is established afterwards through the REST read layer (releases list), exactly like an unknown-outcome REST write.
 */
export interface CliBackendConfig {
  /** absolute path of the pinned CLI entry script (`…/@liara/cli/bin/run.js`), chosen by the operator */
  entry: string;
  /** SHA-256 (hex) of that file, pinned by the operator */
  entrySha256: string;
  /** exact version expected in the package.json next to the entry's parent directory */
  version: string;
  timeoutMs: number;
  /** the fixed Node binary (absolute); defaults to this process' own */
  nodeFile: string;
}

export type CliRefusal = "cli_entry_unreadable" | "cli_entry_hash_mismatch" | "cli_package_mismatch" | "cli_version_mismatch" | "cli_source_mismatch" | "cli_argv_mismatch" | "cli_params_invalid" | "cli_workspace_failed";
export type CliIdentityResult = { ok: true; identity: { version: string; entrySha256: string } } | { ok: false; code: CliRefusal };

export interface CliDeployRequest {
  params: Omit<CliDeployParams, "path">;
  zip: Buffer;
  /** called once, only to write the private auth file; the token is never stored, logged or passed anywhere else */
  getToken: () => string;
  expected: LiveCliBinding;
}
export type CliDeployOutcome = "exit_zero" | "exit_nonzero" | "timeout" | "spawn_failed" | "refused";
export interface CliDeployResult {
  outcome: CliDeployOutcome;
  refusal: CliRefusal | null;
  exitCode: number | null;
  signal: string | null;
  durationMs: number;
  /** last few output lines, sanitised (tokens, paths, escape codes removed). Never parsed. */
  tail: string[];
  outputTruncated: boolean;
}

const MAX_ENTRY_BYTES = 2 * 1024 * 1024;
const ANSI = /\x1b\[[0-9;?]*[ -/]*[@-~]/g;

export function sanitizeCliOutput(raw: string, secrets: string[], dirs: string[]): string[] {
  let t = raw.replace(ANSI, "").replace(/\r/g, "\n");
  for (const s of secrets) if (s.length >= 6) t = t.split(s).join("[REDACTED]");
  for (const d of dirs) if (d.length >= 6) t = t.split(d).join("<DIR>");
  return t
    .split("\n")
    .map((l) => redactText(l.trim(), { maxLength: 200 }))
    .filter((l) => l.length > 0)
    .slice(-10);
}

export class LiaraCliBackend {
  constructor(
    readonly cfg: CliBackendConfig,
    private readonly runner: ProcessRunner,
  ) {}

  /** Read-only identity check: hashes the entry file and reads (never executes) the sibling package.json. */
  verifyIdentity(): CliIdentityResult {
    let entry: Buffer;
    try {
      if (!path.isAbsolute(this.cfg.entry) || statSync(this.cfg.entry).size > MAX_ENTRY_BYTES) return { ok: false, code: "cli_entry_unreadable" };
      entry = readFileSync(this.cfg.entry);
    } catch {
      return { ok: false, code: "cli_entry_unreadable" };
    }
    const sha = createHash("sha256").update(entry).digest("hex");
    if (sha !== this.cfg.entrySha256.toLowerCase()) return { ok: false, code: "cli_entry_hash_mismatch" };
    let pkg: { name?: unknown; version?: unknown };
    try {
      pkg = JSON.parse(readFileSync(path.resolve(path.dirname(this.cfg.entry), "..", "package.json"), "utf8")) as typeof pkg;
    } catch {
      return { ok: false, code: "cli_package_mismatch" };
    }
    if (pkg.name !== CLI_PACKAGE_NAME) return { ok: false, code: "cli_package_mismatch" };
    if (pkg.version !== this.cfg.version) return { ok: false, code: "cli_version_mismatch" };
    return { ok: true, identity: { version: this.cfg.version, entrySha256: sha } };
  }

  async deploy(req: CliDeployRequest): Promise<CliDeployResult> {
    const refuse = (code: CliRefusal): CliDeployResult => ({ outcome: "refused", refusal: code, exitCode: null, signal: null, durationMs: 0, tail: [], outputTruncated: false });
    // 1. the tool is exactly the pinned one, and exactly the one the operator approved
    const id = this.verifyIdentity();
    if (!id.ok) return refuse(id.code);
    if (id.identity.version !== req.expected.version || id.identity.entrySha256 !== req.expected.entrySha256) return refuse("cli_version_mismatch");
    // 2. the flags are exactly the approved ones (template digest), built only from validated parameters
    let argvDigest: string;
    try {
      argvDigest = argvTemplateDigest(req.params);
    } catch (e) {
      return refuse(e instanceof CliSpecError ? "cli_params_invalid" : "cli_params_invalid");
    }
    if (argvDigest !== req.expected.argvDigest) return refuse("cli_argv_mismatch");

    let srcDir: string | null = null;
    let homeDir: string | null = null;
    try {
      srcDir = mkdtempSync(path.join(tmpdir(), "liara-cli-src-")); // 0700
      homeDir = mkdtempSync(path.join(tmpdir(), "liara-cli-home-")); // 0700
      // 3. the source directory holds EXACTLY the approved files (same safe extraction and ignore rules as the REST artifact; secrets and dependencies never extracted)
      const manifest = await materializeApprovedSource(req.zip, srcDir);
      if (manifest.digest !== req.expected.manifestDigest) return refuse("cli_source_mismatch");
      // 4. credentials: a 0600 file in a private HOME — never argv, never the environment
      const token = req.getToken();
      writeFileSync(path.join(homeDir, ".liara-auth.json"), buildAuthFile(token), { flag: "wx", mode: 0o600 });
      const argv = buildDeployArgv({ ...req.params, path: srcDir });
      const env = buildCliEnv({ home: homeDir, nodeDir: path.dirname(this.cfg.nodeFile) });
      const r = await this.runner.run({ file: this.cfg.nodeFile, args: [this.cfg.entry, ...argv], cwd: srcDir, env, timeoutMs: this.cfg.timeoutMs, maxOutputBytes: 64 * 1024 });
      const tail = sanitizeCliOutput(`${r.stdout}\n${r.stderr}`, [token], [srcDir, homeDir]);
      const outcome: CliDeployOutcome = r.spawnError ? "spawn_failed" : r.timedOut ? "timeout" : r.exitCode === 0 ? "exit_zero" : "exit_nonzero";
      return { outcome, refusal: null, exitCode: r.exitCode, signal: r.signal, durationMs: r.durationMs, tail, outputTruncated: r.truncated };
    } catch (e) {
      if (e instanceof CliSpecError) return refuse("cli_params_invalid");
      return refuse("cli_workspace_failed");
    } finally {
      // the credentials file and the source copy never outlive the run
      for (const d of [homeDir, srcDir]) if (d) rmSync(d, { recursive: true, force: true });
    }
  }
}
