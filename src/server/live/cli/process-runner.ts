import "server-only";
import { spawn } from "node:child_process";

/**
 * THE ONLY FILE IN THE PROJECT THAT CAN START A PROCESS. It exposes one narrow interface; the real implementation is constructed only when the operator
 * explicitly enables the CLI backend (never by default, never in tests — tests inject a FakeProcessRunner).
 *  - `spawn(file, args, { shell: false })` with an ARRAY of arguments: no shell, no string command, no interpolation, no globbing
 *  - `file` is an absolute path chosen by configuration (never from a request); `cwd` is a private directory; the environment is EXACTLY what the caller passes
 *  - stdin is closed (`ignore`): the CLI can never block on a prompt
 *  - bounded: wall-clock timeout (SIGTERM, then SIGKILL after a grace period) and a hard cap on captured output (excess is dropped, the process keeps running to its timeout)
 *  - the child is never detached and never inherits a TTY
 */
export interface RunSpec {
  /** absolute path of the executable (the fixed Node binary) */
  file: string;
  /** argv array: [entry script, subcommand, flags…] */
  args: readonly string[];
  cwd: string;
  env: Readonly<Record<string, string>>;
  timeoutMs: number;
  maxOutputBytes: number;
}
export interface RunResult {
  exitCode: number | null;
  signal: string | null;
  timedOut: boolean;
  /** the process could not be started at all (nothing ran) */
  spawnError: string | null;
  stdout: string;
  stderr: string;
  truncated: boolean;
  durationMs: number;
}
export interface ProcessRunner {
  run(spec: RunSpec): Promise<RunResult>;
}

const KILL_GRACE_MS = 5_000;

export class NodeProcessRunner implements ProcessRunner {
  run(spec: RunSpec): Promise<RunResult> {
    return new Promise((resolve) => {
      const started = Date.now();
      let out = "";
      let err = "";
      let truncated = false;
      let timedOut = false;
      let settled = false;
      const finish = (r: Omit<RunResult, "stdout" | "stderr" | "truncated" | "durationMs">) => {
        if (settled) return;
        settled = true;
        clearTimeout(timers.kill);
        clearTimeout(timers.main);
        resolve({ ...r, stdout: out, stderr: err, truncated, durationMs: Date.now() - started });
      };
      let child: ReturnType<typeof spawn>;
      const timers: { main?: NodeJS.Timeout; kill?: NodeJS.Timeout } = {};
      try {
        child = spawn(spec.file, [...spec.args], { cwd: spec.cwd, env: { ...spec.env } as NodeJS.ProcessEnv, shell: false, stdio: ["ignore", "pipe", "pipe"], windowsHide: true, detached: false });
      } catch (e) {
        finish({ exitCode: null, signal: null, timedOut: false, spawnError: (e as { code?: string })?.code ?? "spawn_failed" });
        return;
      }
      const cap = (cur: string, chunk: Buffer): string => {
        if (cur.length + chunk.length > spec.maxOutputBytes) {
          truncated = true;
          return cur + chunk.toString("utf8", 0, Math.max(0, spec.maxOutputBytes - cur.length));
        }
        return cur + chunk.toString("utf8");
      };
      child.stdout?.on("data", (c: Buffer) => (out = cap(out, c)));
      child.stderr?.on("data", (c: Buffer) => (err = cap(err, c)));
      child.on("error", (e) => finish({ exitCode: null, signal: null, timedOut, spawnError: (e as { code?: string })?.code ?? "spawn_failed" }));
      child.on("close", (code, signal) => finish({ exitCode: code, signal, timedOut, spawnError: null }));
      timers.main = setTimeout(() => {
        timedOut = true;
        child.kill("SIGTERM");
        timers.kill = setTimeout(() => child.kill("SIGKILL"), KILL_GRACE_MS);
      }, spec.timeoutMs);
    });
  }
}
