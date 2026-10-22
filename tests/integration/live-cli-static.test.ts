import { readdirSync, readFileSync } from "node:fs";
import path from "node:path";
import { describe, expect, it } from "vitest";
import { createCliBackend } from "@/server/live/runtime";
import { __setLiveServiceForTests } from "@/server/live/runtime";
import { __resetApiLimiterForTests } from "@/server/security/guard";
import { __clearSessionsForTests, createSession } from "@/server/security/session";
import { LIVE_ENV, makeConfig, resetAll } from "../helpers/live";
import { harness, liveEnv } from "../helpers/live-exec";
import { makeFakeCliPackage } from "../helpers/fake-cli";
import * as proposals from "@/app/api/agent/live/proposals/route";

const ROOT = path.resolve(__dirname, "../..");
const walk = (d: string, out: string[] = []): string[] => {
  for (const e of readdirSync(d, { withFileTypes: true })) {
    const p = path.join(d, e.name);
    if (e.isDirectory()) {
      if (!["node_modules", ".next", "fixtures", "dist-demo"].includes(e.name)) walk(p, out);
    } else if (/\.(ts|tsx)$/.test(e.name)) out.push(p);
  }
  return out;
};
const rel = (f: string) => path.relative(ROOT, f).replaceAll(path.sep, "/");
const code = (f: string) => readFileSync(f, "utf8").replace(/\/\*[\s\S]*?\*\//g, "").replace(/(^|[^:])\/\/.*$/gm, "$1");
const src = walk(path.join(ROOT, "src"));
const tests = walk(path.join(ROOT, "tests"));
const RUNNER = "src/server/live/cli/process-runner.ts";

describe("Phase 2D static guarantees: exactly one file can start a process, and it cannot start a shell", () => {
  it("child_process is imported ONLY by the restricted runner", () => {
    expect(src.filter((f) => /child_process/.test(code(f))).map(rel)).toEqual([RUNNER]);
  });
  it("the runner uses spawn with an argv ARRAY, shell:false and a closed stdin — never exec/execSync/execFile/fork/shell:true", () => {
    const c = code(path.join(ROOT, RUNNER));
    expect(c).toMatch(/spawn\(spec\.file, \[\.\.\.spec\.args\]/);
    expect(c).toMatch(/shell: false/);
    expect(c).toMatch(/stdio: \["ignore", "pipe", "pipe"\]/);
    expect(c).not.toMatch(/shell:\s*(true|process|\w*\))|\bexec\s*\(|\bexecSync\b|\bexecFile(Sync)?\b|\bfork\s*\(|\bspawnSync\b|detached:\s*true/);
    expect(c).not.toMatch(/process\.env/);
  });
  it("no other source file mentions a way to run a command string (spawn/exec/execa/shelljs/sh -c)", () => {
    for (const f of src.filter((x) => rel(x) !== RUNNER)) expect(code(f), rel(f)).not.toMatch(/\bspawn(Sync)?\s*\(|\bexecSync?\s*\(|\bexecFile|\bexeca\b|shelljs|\bsh\s+-c\b|bash\s+-c\b|\bchild_process\b/);
  });
  it("the real NodeProcessRunner is constructed in exactly one place (runtime.ts, behind createCliBackend) and NEVER in any test", () => {
    expect(src.filter((f) => /new NodeProcessRunner\(/.test(code(f))).map(rel)).toEqual(["src/server/live/runtime.ts"]);
    for (const f of tests.filter((x) => rel(x) !== "tests/integration/live-cli-static.test.ts")) expect(code(f), rel(f)).not.toMatch(/new NodeProcessRunner\(/);
  });
  it("the CLI modules never read process.env, never open a connection and never embed a token flag", () => {
    for (const f of src.filter((x) => rel(x).startsWith("src/server/live/cli/"))) {
      const c = code(f);
      expect(c, rel(f)).not.toMatch(/process\.env|\bfetch\s*\(|node:(https?|net|tls|dns)/);
    }
    const spec = code(path.join(ROOT, "src/server/live/cli/spec.ts"));
    expect(spec.match(/["']--api-token["']/g)?.length ?? 0).toBe(1); // only in the FORBIDDEN list
    expect(spec).not.toMatch(/buildDeployArgv[\s\S]{0,400}api-token[\s\S]{0,60}push/);
  });
  it("the default configuration constructs NO CLI backend; enabling it needs a pinned tool in live mode; a flag alone is not enough", () => {
    expect(createCliBackend(makeConfig())).toBeNull();
    expect(createCliBackend(makeConfig({ ...LIVE_ENV }))).toBeNull();
    const pkg = makeFakeCliPackage();
    const base = { ...liveEnv(), LIARA_CLI_ENABLED: "true", LIARA_CLI_ENTRY: pkg.entry, LIARA_CLI_ENTRY_SHA256: pkg.sha256, LIARA_CLI_VERSION: "9.6.0" };
    expect(createCliBackend(makeConfig(base))).not.toBeNull(); // constructing the object starts nothing
    const { LIARA_CLI_ENTRY: _e, ...noEntry } = base;
    void _e;
    expect(() => makeConfig(noEntry)).toThrow(/pinned/);
    expect(() => makeConfig({ ...base, LIARA_CLI_ENTRY: "relative/run.js" })).toThrow(/absolute path/);
    expect(() => makeConfig({ ...base, LIARA_CLI_ENTRY: "/a/../b/run.js" })).toThrow(/absolute path/);
    expect(() => makeConfig({ ...base, LIARA_CLI_ENTRY_SHA256: "xyz" })).toThrow(/64 hex/);
    expect(() => makeConfig({ ...base, LIARA_CLI_VERSION: "latest" })).toThrow(/exact version/);
    expect(() => makeConfig({ ...base, LIARA_DATA_SOURCE: "mock" })).toThrow(/requires LIARA_DATA_SOURCE=live/);
    expect(makeConfig(liveEnv()).cli).toEqual({ enabled: false, entry: null, entrySha256: null, version: null, timeoutMs: 120_000 });
  });
});

describe("existing-app proposals over HTTP: strict header combinations, fail closed", () => {
  const ORIGIN = "http://localhost:3000";
  it("create+cli, unknown kinds/backends and missing parameters are 400; the default configuration answers 403 for a valid request", async () => {
    __clearSessionsForTests();
    __resetApiLimiterForTests();
    const s = createSession();
    const h = await harness({ env: { LIARA_LIVE_DEPLOY_ENABLED: "false" }, noTransport: true, owner: s.id });
    __setLiveServiceForTests(h.svc);
    try {
      const post = (headers: Record<string, string>) => proposals.POST(new Request(`${ORIGIN}/api/agent/live/proposals`, { method: "POST", headers: { cookie: `liara_agent_session=${s.id}`, origin: ORIGIN, "content-type": "application/zip", ...headers }, body: new Uint8Array(h.zip) }));
      const base = { "x-live-run": h.runId, "x-live-app": "liara-agent-demo" };
      expect((await post({ ...base, "x-live-kind": "create_new_app", "x-live-backend": "cli", "x-live-plan": "g2-small" })).status).toBe(400);
      expect((await post({ ...base, "x-live-kind": "rebuild", "x-live-backend": "api" })).status).toBe(400);
      expect((await post({ ...base, "x-live-kind": "deploy_existing_app", "x-live-backend": "shell" })).status).toBe(400);
      expect((await post({ "x-live-run": "nope", "x-live-app": "liara-agent-demo", "x-live-kind": "deploy_existing_app", "x-live-backend": "api" })).status).toBe(400);
      expect((await post({ ...base, "x-live-kind": "deploy_existing_app", "x-live-backend": "api" })).status).toBe(403);
      expect((await post({ ...base, "x-live-kind": "deploy_existing_app", "x-live-backend": "cli" })).status).toBe(403);
      expect(h.fake.calls).toEqual([]);
    } finally {
      __setLiveServiceForTests(undefined);
      resetAll();
    }
  });
});
