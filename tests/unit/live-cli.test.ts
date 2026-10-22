import { existsSync, statSync } from "node:fs";
import path from "node:path";
import { describe, expect, it } from "vitest";
import { sanitizeCliOutput } from "@/server/live/cli/backend";
import { ALLOWED_FLAGS, argvTemplateDigest, assertArgvAllowed, buildAuthFile, buildCliEnv, buildDeployArgv, CLI_ENV_KEYS, CliSpecError, FORBIDDEN_FLAGS, SOURCE_DIR_PLACEHOLDER } from "@/server/live/cli/spec";
import { materializeApprovedSource } from "@/server/live/artifact";
import { argvDigestOf } from "../helpers/cli-digest";
import { CANARY } from "../helpers/canaries";
import { demoZip } from "../helpers/live-exec";
import { FakeProcessRunner, makeCliBackend, makeFakeCliPackage } from "../helpers/fake-cli";
import { buildZip } from "../helpers/zip";

const P = { app: "liara-agent-demo", platform: "next" as const, port: 3000, path: "/tmp/liara-cli-src-abc123", teamId: "team_demo_1" as string | null, message: "agent-op-lop_20260102040000_aabbccdd" };
const thrown = (f: () => unknown) => {
  try {
    f();
    return null;
  } catch (e) {
    return e instanceof CliSpecError ? e.code : "other";
  }
};

describe("allowlisted command interface: argv is built from validated parameters ONLY", () => {
  it("produces exactly the documented deploy argv (an ARRAY), detached, without app logs, with the team flag only when a team exists", () => {
    expect(buildDeployArgv(P)).toEqual(["deploy", "--app", "liara-agent-demo", "--platform", "next", "--port", "3000", "--path", "/tmp/liara-cli-src-abc123", "--detach", "--no-app-logs", "--message", P.message, "--team-id", "team_demo_1"]);
    expect(buildDeployArgv({ ...P, teamId: null })).not.toContain("--team-id");
    expect(Array.isArray(buildDeployArgv(P))).toBe(true);
  });
  it("NEVER contains the API token flag or any other forbidden flag, for any input", () => {
    const argv = buildDeployArgv(P);
    for (const f of FORBIDDEN_FLAGS) expect(argv, f).not.toContain(f);
    expect(argv.join(" ")).not.toMatch(/token/i);
    expect(argv.filter((a) => a.startsWith("--")).every((a) => (ALLOWED_FLAGS as readonly string[]).includes(a))).toBe(true);
  });
  it("rejects every invalid or hostile parameter (flag/shell injection, traversal, wrong types, extra keys)", () => {
    const bad: Record<string, unknown>[] = [
      { ...P, app: "-rf" }, { ...P, app: "a;b" }, { ...P, app: "Bad Name" }, { ...P, app: "x".repeat(70) },
      { ...P, platform: "docker" }, { ...P, platform: "next --api-token x" },
      { ...P, port: 0 }, { ...P, port: 70000 }, { ...P, port: 3000.5 }, { ...P, port: "3000" },
      { ...P, teamId: "t;rm" }, { ...P, teamId: "-x" }, { ...P, teamId: "" },
      { ...P, message: "agent-op-x; rm -rf /" }, { ...P, message: "--api-token" }, { ...P, message: "hello" },
      { ...P, extra: "--account x" }, { app: P.app },
    ];
    for (const b of bad) expect(thrown(() => buildDeployArgv(b)), JSON.stringify(b)).toMatch(/^(invalid_params|unsafe_value)$/);
    for (const pth of ["relative/dir", "/tmp/../etc", "/tmp/a b", "/tmp/a;b", "/tmp/$(x)", "-/tmp/x", "/tmp/a\nb", "/tmp/a\0b", ""]) expect(thrown(() => buildDeployArgv({ ...P, path: pth })), pth).toMatch(/invalid_params|unsafe_value/);
  });
  it("assertArgvAllowed re-checks ANY argv: unknown subcommands, forbidden or unlisted flags, flag-like values", () => {
    expect(thrown(() => assertArgvAllowed(["app:delete", "--app", "x"]))).toBe("unlisted_flag");
    expect(thrown(() => assertArgvAllowed(["login"]))).toBe("unlisted_flag");
    expect(thrown(() => assertArgvAllowed(["deploy", "--api-token", "t"]))).toBe("forbidden_argument");
    expect(thrown(() => assertArgvAllowed(["deploy", "--api_token=x"]))).toBe("forbidden_argument");
    expect(thrown(() => assertArgvAllowed(["deploy", "--image", "x"]))).toBe("forbidden_argument");
    expect(thrown(() => assertArgvAllowed(["deploy", "--debug"]))).toBe("forbidden_argument");
    expect(thrown(() => assertArgvAllowed(["deploy", "--app", "-x"]))).toBe("unsafe_value");
    expect(thrown(() => assertArgvAllowed(["deploy", "--app"]))).toBe("unsafe_value");
    expect(thrown(() => assertArgvAllowed(["deploy", "--surprise", "1"]))).toBe("unlisted_flag");
    expect(thrown(() => assertArgvAllowed([]))).toBe("unlisted_flag");
    expect(thrown(() => assertArgvAllowed(buildDeployArgv(P)))).toBeNull();
  });
  it("the argv template digest is deterministic, ignores the random directory and changes with every flag", () => {
    const { path: _p, ...rest } = P;
    void _p;
    const d = argvTemplateDigest(rest);
    expect(d).toMatch(/^[0-9a-f]{64}$/);
    expect(argvTemplateDigest(rest)).toBe(d);
    expect(d).toBe(argvDigestOf(rest));
    expect(buildDeployArgv({ ...rest, path: SOURCE_DIR_PLACEHOLDER })).toContain(SOURCE_DIR_PLACEHOLDER);
    for (const over of [{ app: "other-app" }, { port: 3001 }, { teamId: null }, { platform: "static" as const }, { message: "agent-op-lop_other" }]) expect(argvTemplateDigest({ ...rest, ...over })).not.toBe(d);
  });
});

describe("controlled environment and credentials file", () => {
  it("the environment is EXACTLY the documented keys; nothing is inherited; the token is in none of them", () => {
    process.env.LIARA_API_TOKEN = CANARY.token;
    process.env.HTTPS_PROXY = "http://proxy.invalid";
    process.env.NODE_OPTIONS = "--require /evil.js";
    try {
      const env = buildCliEnv({ home: "/tmp/h", nodeDir: "/opt/node/bin" });
      expect(Object.keys(env).sort()).toEqual([...CLI_ENV_KEYS].sort());
      expect(env).toMatchObject({ HOME: "/tmp/h", PATH: "/opt/node/bin", NO_UPDATE_NOTIFIER: "1", CI: "1" });
      expect(JSON.stringify(env)).not.toContain(CANARY.token);
      expect(env).not.toHaveProperty("NODE_OPTIONS");
      expect(env).not.toHaveProperty("HTTPS_PROXY");
    } finally {
      delete process.env.LIARA_API_TOKEN;
      delete process.env.HTTPS_PROXY;
      delete process.env.NODE_OPTIONS;
    }
    expect(thrown(() => buildCliEnv({ home: "relative", nodeDir: "/x" }))).toBe("unsafe_value");
  });
  it("the auth file has the shape the official CLI reads, with the token ONLY inside it", () => {
    const j = JSON.parse(buildAuthFile("tok-123456")) as { version: string; accounts: Record<string, { current: boolean; api_token: string; region: string }> };
    expect(j.version).toBe("1");
    expect(Object.values(j.accounts)).toHaveLength(1);
    expect(Object.values(j.accounts)[0]).toMatchObject({ current: true, api_token: "tok-123456", region: "iran" });
  });
});

describe("source materialisation: exactly the approved files, no secrets, no dependencies", () => {
  it("writes only the approved file set (0600), derives a deterministic manifest digest, and never extracts .env / keys / node_modules", async () => {
    const zip = demoZip({ ".env": `SECRET=${CANARY.envValue}`, "server.pem": CANARY.sshKey, "node_modules/x/index.js": "x" });
    const a = await materializeApprovedSource(zip, null);
    const b = await materializeApprovedSource(demoZip({ ".env": "OTHER", "server.pem": "OTHER", "node_modules/y.js": "y" }), null);
    expect(a.digest).toBe(b.digest); // secrets and dependencies never take part
    expect(a.files.map((f) => f.path)).not.toEqual(expect.arrayContaining([".env", "server.pem"]));
    expect(a.files.some((f) => /node_modules/.test(f.path))).toBe(false);
    const { mkdtempSync, readdirSync } = await import("node:fs");
    const { tmpdir } = await import("node:os");
    const dir = mkdtempSync(path.join(tmpdir(), "mat-"));
    const m = await materializeApprovedSource(zip, dir);
    expect(m.digest).toBe(a.digest);
    expect(readdirSync(dir).sort()).toEqual(expect.arrayContaining(["package.json", "app"]));
    expect(statSync(path.join(dir, "package.json")).mode & 0o777).toBe(0o600);
    expect(existsSync(path.join(dir, ".env"))).toBe(false);
    expect((await materializeApprovedSource(demoZip({ "README.md": "changed" }), null)).digest).not.toBe(a.digest);
    expect(await materializeApprovedSource(buildZip([{ name: "package.json", data: "{}" }]), null)).toMatchObject({ files: [{ path: "package.json" }] });
  });
});

describe("restricted CLI backend (fake process runner — nothing is ever executed)", () => {
  const params = { app: "liara-agent-demo", platform: "next" as const, port: 3000, teamId: "team_demo_1", message: "agent-op-lop_20260102040000_aabbccdd" };
  const setup = async (over: { zip?: Buffer } = {}) => {
    const runner = new FakeProcessRunner();
    const { backend, pkg } = makeCliBackend(runner);
    const zip = over.zip ?? demoZip();
    const manifest = await materializeApprovedSource(zip, null);
    const id = backend.verifyIdentity();
    if (!id.ok) throw new Error("identity");
    const expected = { version: id.identity.version, entrySha256: id.identity.entrySha256, argvDigest: argvDigestOf(params), manifestDigest: manifest.digest };
    return { runner, backend, pkg, zip, expected };
  };
  const go = (s: Awaited<ReturnType<typeof setup>>, over: Partial<{ zip: Buffer; expected: typeof s.expected; getToken: () => string }> = {}) => s.backend.deploy({ params, zip: over.zip ?? s.zip, getToken: over.getToken ?? (() => CANARY.token), expected: over.expected ?? s.expected });

  it("identity: the pinned entry hash, package name and exact version must match; the entry is read and hashed, never executed", async () => {
    const s = await setup();
    expect(s.backend.verifyIdentity()).toEqual({ ok: true, identity: { version: "9.6.0", entrySha256: s.pkg.sha256 } });
    const wrong = (over: Partial<Parameters<typeof makeCliBackend>[2]>, pkg = s.pkg) => makeCliBackend(s.runner, pkg, over).backend.verifyIdentity();
    expect(wrong({ entrySha256: "0".repeat(64) })).toEqual({ ok: false, code: "cli_entry_hash_mismatch" });
    expect(wrong({ version: "9.6.1" })).toEqual({ ok: false, code: "cli_version_mismatch" });
    expect(wrong({ entry: "/nonexistent/bin/run.js" })).toEqual({ ok: false, code: "cli_entry_unreadable" });
    expect(wrong({ entry: "relative/run.js" })).toEqual({ ok: false, code: "cli_entry_unreadable" });
    const other = makeFakeCliPackage({ name: "evil-cli" });
    expect(makeCliBackend(s.runner, other).backend.verifyIdentity()).toEqual({ ok: false, code: "cli_package_mismatch" });
    s.pkg.rewriteEntry("// tampered");
    expect(s.backend.verifyIdentity()).toEqual({ ok: false, code: "cli_entry_hash_mismatch" });
    expect(s.runner.calls).toHaveLength(0);
  });
  it("happy path: one run, fixed node binary + pinned entry + exact argv, controlled env, credentials only in a private 0600 file that is gone afterwards", async () => {
    const s = await setup();
    const r = await go(s);
    expect(r.outcome).toBe("exit_zero");
    expect(s.runner.calls).toHaveLength(1);
    const c = s.runner.calls[0]!;
    expect(c.spec.file).toBe("/opt/fixed/node/bin/node");
    expect(c.spec.args[0]).toBe(s.pkg.entry);
    expect(c.spec.args.slice(1)).toEqual(buildDeployArgv({ ...params, path: c.spec.cwd }));
    expect(c.spec.args.join(" ")).not.toContain(CANARY.token);
    expect(Object.keys(c.spec.env).sort()).toEqual([...CLI_ENV_KEYS].sort());
    expect(JSON.stringify(c.spec.env)).not.toContain(CANARY.token);
    expect(c.spec.timeoutMs).toBe(30_000);
    expect(c.spec.maxOutputBytes).toBeLessThanOrEqual(64 * 1024);
    // credentials: file in the private HOME, owner-only, token inside it and nowhere else
    expect(c.homeFiles).toEqual([".liara-auth.json"]);
    expect(c.authFile).toMatchObject({ exists: true, mode: 0o600 });
    expect(JSON.stringify(c.authFile.json)).toContain(CANARY.token);
    // the source directory holds exactly the approved files
    expect(c.srcFiles).toEqual(expect.arrayContaining(["package.json", "app/health/route.js"]));
    expect(c.srcFiles.some((f) => /^\.env|node_modules|\.pem$/.test(f))).toBe(false);
    // both private directories are gone after the run
    expect(existsSync(c.spec.cwd)).toBe(false);
    expect(existsSync(c.spec.env.HOME!)).toBe(false);
    expect(JSON.stringify(r)).not.toContain(CANARY.token);
  });
  it("secret-bearing zips never expose their secrets to the CLI's directory", async () => {
    const s = await setup({ zip: demoZip({ ".env": `SECRET=${CANARY.envValue}`, ".env.production": "X=1", "id_rsa": CANARY.sshKey }) });
    const m = await materializeApprovedSource(s.zip, null);
    await go({ ...s, expected: { ...s.expected, manifestDigest: m.digest } });
    expect(s.runner.calls[0]!.srcFiles.some((f) => /\.env|id_rsa|pem/.test(f))).toBe(false);
  });
  it("REFUSES before running anything when the source, the flags or the tool differ from what was approved", async () => {
    const s = await setup();
    expect(await go(s, { zip: demoZip({ "README.md": "changed after approval" }) })).toMatchObject({ outcome: "refused", refusal: "cli_source_mismatch" });
    expect(await go(s, { expected: { ...s.expected, argvDigest: "0".repeat(64) } })).toMatchObject({ outcome: "refused", refusal: "cli_argv_mismatch" });
    expect(await go(s, { expected: { ...s.expected, entrySha256: "1".repeat(64) } })).toMatchObject({ outcome: "refused", refusal: "cli_version_mismatch" });
    expect(await go(s, { expected: { ...s.expected, version: "9.0.0" } })).toMatchObject({ outcome: "refused", refusal: "cli_version_mismatch" });
    s.pkg.rewriteEntry("// swapped after approval");
    expect(await go(s)).toMatchObject({ outcome: "refused", refusal: "cli_entry_hash_mismatch" });
    expect(s.runner.calls).toHaveLength(0);
  });
  it("invalid parameters are refused by the spec, never passed to a process", async () => {
    const s = await setup();
    const r = await s.backend.deploy({ params: { ...params, app: "a;rm -rf /" }, zip: s.zip, getToken: () => CANARY.token, expected: s.expected });
    expect(r).toMatchObject({ outcome: "refused", refusal: "cli_params_invalid" });
    expect(s.runner.calls).toHaveLength(0);
  });
  it("maps process results to outcomes (exit 0 / non-zero / timeout / spawn failure) and never trusts exit 0 as success", async () => {
    const cases: [Partial<import("@/server/live/cli/process-runner").RunResult>, string][] = [
      [{ exitCode: 0 }, "exit_zero"], [{ exitCode: 1 }, "exit_nonzero"], [{ exitCode: 2 }, "exit_nonzero"], [{ exitCode: null, signal: "SIGKILL", timedOut: true }, "timeout"], [{ exitCode: null, spawnError: "ENOENT" }, "spawn_failed"],
    ];
    for (const [result, outcome] of cases) {
      const s = await setup();
      s.runner.result = result;
      const r = await go(s);
      expect(r.outcome, JSON.stringify(result)).toBe(outcome);
      expect(r.refusal).toBeNull();
    }
  });
  it("output is sanitised: the token, private paths, ANSI codes and secret-like text never come back; only the last 10 short lines", async () => {
    const s = await setup();
    s.runner.onRun = (spec) => {
      s.runner.result = {
        exitCode: 1,
        stdout: `\x1b[31mError\x1b[0m using token ${CANARY.token}\nsrc ${spec.cwd}/package.json\n${Array.from({ length: 30 }, (_, i) => `line ${i}`).join("\n")}\n`,
        stderr: `Authorization: Bearer ${CANARY.token}\nhome ${spec.env.HOME}\n${"x".repeat(5000)}\n`,
      };
    };
    const r = await go(s);
    const text = JSON.stringify(r);
    expect(text).not.toContain(CANARY.token);
    expect(text).not.toMatch(/liara-cli-(src|home)-/);
    expect(text).not.toContain("\x1b");
    expect(r.tail.length).toBeLessThanOrEqual(10);
    expect(r.tail.every((l) => l.length <= 200)).toBe(true);
    expect(sanitizeCliOutput("tok abcdef end", ["abcdef"], [])).toEqual(["tok [REDACTED] end"]);
  });
  it("a crashing runner still cleans up both private directories and reports a refusal (no leak, no hang)", async () => {
    const s = await setup();
    s.runner.throwOnRun = true;
    const r = await go(s);
    expect(r).toMatchObject({ outcome: "refused", refusal: "cli_workspace_failed" });
    const c = s.runner.calls[0]!;
    expect(existsSync(c.spec.cwd)).toBe(false);
    expect(existsSync(c.spec.env.HOME!)).toBe(false);
  });
});
