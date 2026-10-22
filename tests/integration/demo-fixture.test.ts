import { createHash } from "node:crypto";
import { gunzipSync } from "node:zlib";
import { existsSync, readdirSync, readFileSync, statSync } from "node:fs";
import path from "node:path";
import { describe, expect, it } from "vitest";
import { analyzeSource } from "@/server/deploy/analyze";
import { buildReadiness } from "@/server/deploy/readiness";
import { withProject } from "@/server/deploy/workspace";
import { buildDeploymentArtifact } from "@/server/live/artifact";
import { safeProbe } from "@/server/live/probe";
import { demoZip } from "../helpers/live-exec";

const ROOT = path.resolve(__dirname, "../../fixtures/demo-app");
const files = (dir = ROOT, rel = ""): string[] => readdirSync(dir).flatMap((n) => (["node_modules", ".next"].includes(n) ? [] : statSync(path.join(dir, n)).isDirectory() ? files(path.join(dir, n), rel ? `${rel}/${n}` : n) : [rel ? `${rel}/${n}` : n])).sort();

describe("demo fixture: minimal, deterministic, safe to deploy later (never deployed in this phase)", () => {
  const pkg = JSON.parse(readFileSync(path.join(ROOT, "package.json"), "utf8")) as { dependencies: Record<string, string>; devDependencies?: unknown; scripts: Record<string, string> };
  it("is only the minimal Next.js files: no database, no background jobs, no env files, no keys, no docker/liara config", () => {
    expect(files()).toEqual([".gitignore", "README.md", "app/health/route.js", "app/layout.js", "app/page.js", "next.config.js", "package-lock.json", "package.json", "public/robots.txt"]);
    for (const f of files()) expect(f, f).not.toMatch(/^\.env|\.pem$|\.key$|id_rsa|credentials|liara\.json|Dockerfile|docker-compose|\.npmrc/i);
  });
  it("has a real public/ directory with a harmless static file (Liara's Next.js build runs `COPY app/public`, which fails when the directory does not exist)", async () => {
    expect(statSync(path.join(ROOT, "public")).isDirectory()).toBe(true);
    expect(files().filter((f) => f.startsWith("public/"))).toEqual(["public/robots.txt"]);
    expect(readFileSync(path.join(ROOT, "public/robots.txt"), "utf8")).toBe("User-agent: *\nDisallow: /\n");
    // the ZIP the operator uploads …
    const names = await withProject(demoZip(), (t) => [...t.files].sort());
    expect(names).toContain("public/robots.txt");
    expect(names).toHaveLength(9);
    // … and the tar.gz that is actually sent to Liara both carry it, at the archive root, with identical bytes
    const art = await buildDeploymentArtifact(demoZip(), { now: () => 0 });
    expect(art.paths).toContain("public/robots.txt");
    expect(art.fileCount).toBe(9);
    const tar = gunzipSync(art.bytes);
    const entries: Record<string, Buffer> = {};
    for (let off = 0; off + 512 <= tar.length && tar[off] !== 0; ) {
      const name = tar.subarray(off, off + 100).toString("utf8").replace(/\0.*$/s, "");
      const size = parseInt(tar.subarray(off + 124, off + 136).toString("utf8").replace(/\0.*$/s, "").trim() || "0", 8);
      entries[name] = tar.subarray(off + 512, off + 512 + size);
      off += 512 + Math.ceil(size / 512) * 512;
    }
    expect(Object.keys(entries).sort()).toEqual(art.paths.slice().sort());
    expect(entries["public/robots.txt"]!.toString("utf8")).toBe("User-agent: *\nDisallow: /\n");
    expect(Object.keys(entries).every((n) => !n.startsWith("/") && !n.startsWith("./") && !n.includes(".."))).toBe(true);
  });
  it("depends on exactly next, react, react-dom (no database client, queue, SDK or paid service)", () => {
    expect(Object.keys(pkg.dependencies).sort()).toEqual(["next", "react", "react-dom"]);
    expect(pkg.devDependencies).toBeUndefined();
    expect(Object.keys(pkg.scripts).sort()).toEqual(["build", "dev", "start"]);
  });
  it("source contains no network call, no env access, no timers/workers and no secrets", () => {
    for (const f of files().filter((x) => /\.js$/.test(x))) {
      const c = readFileSync(path.join(ROOT, f), "utf8");
      expect(c, f).not.toMatch(/process\.env|fetch\(|XMLHttpRequest|setInterval|setTimeout|child_process|Worker\(|require\(|cron|redis|postgres|mongo|mysql|sqlite|stripe|openai|anthropic|API[_-]?KEY|SECRET|TOKEN|PASSWORD/i);
    }
    expect(readFileSync(path.join(ROOT, "next.config.js"), "utf8").replace(/\/\*[\s\S]*?\*\//g, "")).not.toMatch(/rewrites|redirects|images|env\s*:|output\s*:/);
  });
  it("/health returns the exact deterministic body (the acceptance marker of the future live verification)", () => {
    const src = readFileSync(path.join(ROOT, "app/health/route.js"), "utf8");
    expect(src).toContain('Response.json({ status: "ok", app: "liara-agent-demo", version: "1" })');
    expect(src).toContain('dynamic = "force-dynamic"');
  });
  it("the static analyser accepts it (READY, Next.js, no required env) and the packed ZIP and artifact are deterministic", async () => {
    const zip = demoZip();
    const a = await withProject(zip, (t, s) => analyzeSource(t, s));
    expect(a.envKeys.filter((k) => k.required)).toEqual([]);
    const r = buildReadiness(a, { envConfirmed: true, databaseConfirmed: true, storageConfirmed: true, accountReady: true });
    expect(["READY", "READY_WITH_WARNINGS"]).toContain(r.verdict);
    const x = await buildDeploymentArtifact(zip, { now: () => 0 });
    const y = await buildDeploymentArtifact(demoZip(), { now: () => 0 });
    expect(x.sha256).toBe(y.sha256);
    expect(createHash("sha256").update(zip).digest("hex")).toBe(createHash("sha256").update(demoZip()).digest("hex"));
    expect(x.paths.some((p) => /node_modules|\.next|\.env/.test(p))).toBe(false);
    expect(x.size).toBeLessThan(200 * 1024);
  });
  it("its REAL /health body is accepted by the existing SSRF-safe probe with the configured marker, and rejected without it", async () => {
    const body = Buffer.from(JSON.stringify({ status: "ok", app: "liara-agent-demo", version: "1" }));
    const ok = { resolve: async () => ["93.184.216.34"], request: async () => ({ status: 200, body, tooLarge: false }) };
    expect(await safeProbe({ appName: "liara-agent-demo", suffixes: ["liara.run"], path: "/health", marker: "liara-agent-demo", ...ok })).toEqual({ outcome: "ok", status: 200, markerFound: true });
    expect(await safeProbe({ appName: "liara-agent-demo", suffixes: ["liara.run"], path: "/health", marker: "some-other-app", ...ok })).toEqual({ outcome: "ok", status: 200, markerFound: false });
    expect(body.length).toBeLessThan(4096); // within the probe's inspected window
  });
  it("when dist-demo/liara-agent-demo.zip exists it is the CURRENT fixture (a stale ZIP would be uploaded without public/)", () => {
    const zipPath = path.resolve(ROOT, "../../dist-demo/liara-agent-demo.zip");
    if (!existsSync(zipPath)) return; // dist-demo is a git-ignored build output
    expect(createHash("sha256").update(readFileSync(zipPath)).digest("hex")).toBe(createHash("sha256").update(demoZip()).digest("hex"));
  });
  it("the marker is allowed by the configuration validator", async () => {
    const { makeConfig } = await import("../helpers/live");
    const { liveEnv } = await import("../helpers/live-exec");
    expect(() => makeConfig(liveEnv({ LIARA_LIVE_HEALTH_MARKER: "liara-agent-demo" }))).not.toThrow();
    expect(() => makeConfig(liveEnv({ LIARA_LIVE_HEALTH_MARKER: '"app":"liara-agent-demo"' }))).not.toThrow();
  });
  it("is excluded from the main project's lint/typecheck and from git, and no fixture build output is committed", () => {
    expect(existsSync(path.join(ROOT, ".next"))).toBe(false);
    expect(existsSync(path.join(ROOT, "node_modules"))).toBe(false);
    expect(readFileSync(path.resolve(ROOT, "../../tsconfig.json"), "utf8")).toContain("fixtures");
    expect(readFileSync(path.join(ROOT, ".gitignore"), "utf8")).toMatch(/node_modules/);
  });
});
