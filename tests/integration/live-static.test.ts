import { readdirSync, readFileSync } from "node:fs";
import path from "node:path";
import { describe, expect, it } from "vitest";

const SRC = path.resolve(__dirname, "../../src");
const walk = (d: string, out: string[] = []): string[] => {
  for (const e of readdirSync(d, { withFileTypes: true })) {
    const p = path.join(d, e.name);
    if (e.isDirectory()) walk(p, out);
    else if (/\.(ts|tsx)$/.test(e.name)) out.push(p);
  }
  return out;
};
const rel = (f: string) => path.relative(SRC, f).replaceAll(path.sep, "/");
const code = (f: string) => readFileSync(f, "utf8").replace(/\/\*[\s\S]*?\*\//g, "").replace(/(^|[^:])\/\/.*$/gm, "$1");
const live = walk(path.join(SRC, "server/live"));

describe("Phase 2A static guarantees", () => {
  it("the HTTP verb POST appears in server code in exactly ONE place for Liara egress: live/write-client.ts", () => {
    const hits = walk(path.join(SRC, "server")).filter((f) => /["'`]POST["'`]/.test(code(f))).map(rel).sort();
    expect(hits).toEqual(expect.arrayContaining(["server/live/write-client.ts"]));
    // the only other server files naming "POST" are own-origin guards, never Liara egress
    for (const h of hits.filter((x) => x !== "server/live/write-client.ts")) expect(/^server\/(agent|security|auth)\//.test(h), h).toBe(true);
  });
  it("no other live module can send a request: fetch/http/https/dns/net are confined to write-client.ts and probe.ts", () => {
    for (const f of live) {
      const c = code(f);
      const name = rel(f);
      if (name !== "server/live/write-client.ts" && name !== "server/live/probe.ts") expect(c, name).not.toMatch(/\bfetch\s*\(|from\s+["']node:(https?|dns|net|tls)["']|from\s+["'](https?|undici)["']/);
      if (name !== "server/live/probe.ts") expect(c, name).not.toMatch(/node:(https|dns|net|tls)/);
    }
  });
  it("the live layer never imports the simulator and the simulator never imports the live layer", () => {
    for (const f of live) expect(code(f), rel(f)).not.toMatch(/deploy\/simulator|agent\/simulation/);
    for (const f of walk(path.join(SRC, "server/agent/simulation")).concat(walk(path.join(SRC, "server/deploy")).filter((x) => /simulator/.test(x)))) expect(code(f), rel(f)).not.toMatch(/server\/live|\.\.\/live/);
  });
  it("the write transport exposes exactly three typed operations and no generic request method", () => {
    const c = code(path.join(SRC, "server/live/contract.ts"));
    const m = c.match(/interface LiveWriteTransport\s*\{([\s\S]*?)\n\}/);
    expect(m).not.toBeNull();
    const names = [...m![1]!.matchAll(/^\s*(\w+)\s*[(:]/gm)].map((x) => x[1]);
    expect(names).toEqual(["createApp", "uploadSource", "createRelease"]);
    const wc = code(path.join(SRC, "server/live/write-client.ts"));
    expect(wc).not.toMatch(/\b(PUT|PATCH|DELETE)\b/);
    expect(wc).not.toMatch(/request\(\s*(method|url|path)\b/);
  });
  it("live modules contain no LLM/AI provider code and no network-capable AI SDK", () => {
    for (const f of live) expect(code(f), rel(f)).not.toMatch(/anthropic|openai|boxapi|embedding|generateText|chat\.completions|AI_LIVE_REQUESTS/i);
  });
  it("live modules never read process.env directly (configuration is parsed once, centrally)", () => {
    for (const f of live) expect(code(f), rel(f)).not.toMatch(/process\.env/);
  });
  it("only `live/store.ts` writes the allowlist table", () => {
    for (const f of walk(path.join(SRC, "server"))) if (rel(f) !== "server/live/store.ts") expect(code(f), rel(f)).not.toMatch(/(INSERT\s+(OR\s+\w+\s+)?INTO|UPDATE|DELETE\s+FROM)\s+app_scope\b/i);
  });
  it("the live API routes are exactly the documented set and only the documented verbs", () => {
    const base = path.join(SRC, "app/api/agent/live");
    const routes = walk(base).filter((f) => f.endsWith("route.ts")).map((f) => path.relative(base, f).replaceAll(path.sep, "/")).sort();
    expect(routes).toEqual(["operations/[id]/resolve/route.ts", "operations/[id]/route.ts", "proposals/[id]/decision/route.ts", "proposals/[id]/execute/route.ts", "proposals/route.ts", "status/route.ts"]);
    for (const r of routes) {
      const verbs = [...code(path.join(base, r)).matchAll(/export\s+async\s+function\s+(GET|POST|PUT|PATCH|DELETE)\b/g)].map((m) => m[1]);
      expect(verbs, r).toEqual(r.startsWith("status") || r === "operations/[id]/route.ts" ? ["GET"] : ["POST"]);
    }
  });
  it("no UI component imports a live server module at runtime (type-only imports are fine) — the browser can only reach the live API", () => {
    for (const f of walk(path.join(SRC, "components"))) for (const m of code(f).matchAll(/^import\s+(?!type\b)[^;]*from\s+["']@\/server\/live\//gm)) expect.fail(`${rel(f)}: ${m[0]}`);
  });
  it("importing every live module performs no network request and builds no write client", async () => {
    const { blockedAttempts } = await import("../helpers/network-guard");
    const before = blockedAttempts.length;
    for (const f of live) await import(f);
    const { createLiveWriteClient } = await import("@/server/live/write-client");
    const { makeConfig } = await import("../helpers/live");
    expect(createLiveWriteClient(makeConfig())).toBeNull();
    expect(blockedAttempts.length).toBe(before);
  });
});
