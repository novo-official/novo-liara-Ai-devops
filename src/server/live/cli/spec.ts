import { createHash } from "node:crypto";
import path from "node:path";
import { z } from "zod";
import { canonicalJson } from "../../agent/policy";
import { APP_NAME_REGEX } from "../../config/env";

/**
 * THE ALLOWLISTED COMMAND INTERFACE of the official Liara CLI (`@liara/cli`). There is no generic "run a command" function anywhere: the only thing this module
 * can produce is the argv of ONE command (`deploy`) from a strict, validated parameter object. Everything else is unrepresentable.
 *
 *   node <entry> deploy --app <name> --platform <next|static> --port <n> --path <dir> --detach --no-app-logs --message <agent-op-…> [--team-id <id>]
 *
 *  - `--detach`: the CLI returns right after the release is created (official behaviour: it prints "Deployment created successfully." and exits). It then performs NO
 *    domain lookup, NO log streaming and NO build polling; every fact about the outcome is verified through the REST read layer, never by parsing CLI output.
 *  - `--no-app-logs`: belt and braces against the log follower (which in the official source re-passes the API token on a command line).
 *  - NEVER `--api-token` (it would put the token in the process list), `--account`, `--dev`, `--debug`, `--image`, `--disks`, `--build-arg`, `--liara-json`, …
 *  - Every value is validated, cannot start with `-` (no flag injection) and contains no NUL/newline; the array is passed to `spawn(file, args, {shell:false})`.
 */
export const CLI_PACKAGE_NAME = "@liara/cli";
export const ALLOWED_SUBCOMMANDS = ["deploy"] as const;
export const ALLOWED_FLAGS = ["--app", "--platform", "--port", "--path", "--detach", "--no-app-logs", "--message", "--team-id"] as const;
/** flags that must never appear, listed so a test (and a reader) can see the decision */
export const FORBIDDEN_FLAGS = ["--api-token", "--account", "--dev", "--debug", "--image", "--disks", "-d", "--args", "--build-arg", "--no-cache", "--dockerfile", "-f", "--build-location", "-b", "--liara-json", "--help", "-h"] as const;
export const SOURCE_DIR_PLACEHOLDER = "<SOURCE_DIR>";

const SAFE_VALUE = /^[A-Za-z0-9][A-Za-z0-9._:/@+=-]{0,299}$/;

export const CliDeployParamsSchema = z
  .object({
    app: z.string().regex(APP_NAME_REGEX),
    platform: z.enum(["next", "static"]),
    port: z.number().int().min(1).max(65535),
    /** absolute path of the private directory holding EXACTLY the approved files (or the placeholder when computing the approved argv digest) */
    path: z.string().max(300),
    teamId: z.string().regex(/^[A-Za-z0-9_-]{1,64}$/).nullable(),
    /** deterministic release message: carries the operation id only */
    message: z.string().regex(/^agent-op-[a-z0-9_]{1,60}$/),
  })
  .strict();
export type CliDeployParams = z.infer<typeof CliDeployParamsSchema>;

export class CliSpecError extends Error {
  constructor(public readonly code: "invalid_params" | "forbidden_argument" | "unlisted_flag" | "unsafe_value") {
    super(code);
    this.name = "CliSpecError";
  }
}

const isAbsoluteSafePath = (p: string) => p === SOURCE_DIR_PLACEHOLDER || (path.isAbsolute(p) && !p.split("/").includes("..") && /^\/[A-Za-z0-9._/@+-]{1,299}$/.test(p));

/** Builds the argv ARRAY (never a string). Throws instead of ever returning something outside the allowlist. */
export function buildDeployArgv(input: unknown): string[] {
  const r = CliDeployParamsSchema.safeParse(input);
  if (!r.success) throw new CliSpecError("invalid_params");
  const p = r.data;
  if (!isAbsoluteSafePath(p.path)) throw new CliSpecError("unsafe_value");
  const argv = ["deploy", "--app", p.app, "--platform", p.platform, "--port", String(p.port), "--path", p.path, "--detach", "--no-app-logs", "--message", p.message, ...(p.teamId ? ["--team-id", p.teamId] : [])];
  assertArgvAllowed(argv);
  return argv;
}

/** Defence in depth: re-checks ANY argv (also one supplied by a test or a future caller) against the allowlist. */
export function assertArgvAllowed(argv: readonly string[]): void {
  if (argv.length === 0 || !(ALLOWED_SUBCOMMANDS as readonly string[]).includes(argv[0]!)) throw new CliSpecError("unlisted_flag");
  const flagsWithValue = new Set(["--app", "--platform", "--port", "--path", "--message", "--team-id"]);
  for (let i = 1; i < argv.length; i++) {
    const a = argv[i]!;
    if ((FORBIDDEN_FLAGS as readonly string[]).includes(a) || /api[-_]?token/i.test(a)) throw new CliSpecError("forbidden_argument");
    if (!(ALLOWED_FLAGS as readonly string[]).includes(a)) throw new CliSpecError("unlisted_flag");
    if (flagsWithValue.has(a)) {
      const v = argv[++i];
      if (v === undefined || v.startsWith("-") || v.includes("\0") || v.includes("\n") || (a !== "--path" && !SAFE_VALUE.test(v)) || /[\s;&|`$<>"'\\*?(){}[\]]/.test(a === "--path" ? v.replace(SOURCE_DIR_PLACEHOLDER, "x") : v)) throw new CliSpecError("unsafe_value");
    }
  }
}

/** The digest the approval binds: the exact flags, with the private directory replaced by a placeholder (the directory name is random per run). */
export function argvTemplateDigest(p: Omit<CliDeployParams, "path">): string {
  const argv = buildDeployArgv({ ...p, path: SOURCE_DIR_PLACEHOLDER });
  return createHash("sha256").update(canonicalJson({ domain: "liara-cli-argv-v1", argv })).digest("hex");
}

/**
 * The ENTIRE environment of the child process. Nothing is inherited from the server (no tokens, no proxy variables, no NODE_OPTIONS, no npm/git config).
 *  - HOME points to a private, per-run directory (the CLI reads its credentials from `$HOME/.liara-auth.json`; see auth-file.ts)
 *  - NO_UPDATE_NOTIFIER / CI: the CLI otherwise spawns a background update check that contacts the npm registry
 *  - PATH is only the directory of the fixed Node binary (so `git`, which the CLI shells out to for git metadata, is simply not found: a benign, deliberate failure)
 */
export function buildCliEnv(o: { home: string; nodeDir: string }): Record<string, string> {
  if (!path.isAbsolute(o.home) || !path.isAbsolute(o.nodeDir)) throw new CliSpecError("unsafe_value");
  return { HOME: o.home, PATH: o.nodeDir, NO_UPDATE_NOTIFIER: "1", CI: "1", NO_COLOR: "1", FORCE_COLOR: "0", TERM: "dumb", LANG: "C.UTF-8", TZ: "UTC", NODE_ENV: "production" };
}
export const CLI_ENV_KEYS = ["CI", "FORCE_COLOR", "HOME", "LANG", "NODE_ENV", "NO_COLOR", "NO_UPDATE_NOTIFIER", "PATH", "TERM", "TZ"] as const;

/** `$HOME/.liara-auth.json` in the shape the official CLI reads (`{version, accounts:{<name>:{…, current:true}}}`). The token is written ONLY here (mode 0600, private dir). */
export function buildAuthFile(token: string): string {
  return JSON.stringify({ version: "1", accounts: { agent: { email: "agent@localhost", fullname: "liara-sre-agent", avatar: "", current: true, api_token: token, region: "iran" } } });
}
