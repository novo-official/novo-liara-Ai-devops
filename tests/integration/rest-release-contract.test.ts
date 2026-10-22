import { readFileSync } from "node:fs";
import path from "node:path";
import { gunzipSync } from "node:zlib";
import { describe, expect, it } from "vitest";
import { buildDeploymentArtifact } from "@/server/live/artifact";
import { CreateReleaseRequestSchema, NON_REPO_GIT_INFO } from "@/server/live/contract";
import { LiaraWriteClient } from "@/server/live/write-client";
import { Secret } from "@/server/security/secret";
import { CANARY } from "../helpers/canaries";
import { demoZip } from "../helpers/live-exec";

const ROOT = path.resolve(__dirname, "../..");
const spec = readFileSync(path.join(ROOT, "docs/reference/openapi/paas.yaml"), "utf8");

/** What the OFFICIAL CLI (liara-cloud/cli 9.6.0 @ 14ec35f, src/commands/deploy.ts + src/services/upload.ts) sends for a SOURCE deploy of a Next.js app from a non-git directory, with no liara.json. */
const CLI_RELEASE_KEYS = { documented: ["sourceID", "port", "type"], cliOnly: ["build", "platformConfig", "gitInfo"], cliUndefinedOmitted: ["cron", "args", "message", "disks", "envs", "healthCheck"] } as const;

function section(name: string): string {
  const i = spec.indexOf(name);
  return spec.slice(i, i + 1500);
}

describe("REST release contract: documented vs CLI-observed fields (pinned OpenAPI + official CLI)", () => {
  it("the pinned OpenAPI documents exactly sourceID, port, type for the release body and a required multipart `file` for the source upload", () => {
    const rel = section("    Deploy-releases:");
    for (const f of CLI_RELEASE_KEYS.documented) expect(rel, f).toMatch(new RegExp(`\\n        ${f}:`));
    for (const f of [...CLI_RELEASE_KEYS.cliOnly, ...CLI_RELEASE_KEYS.cliUndefinedOmitted]) expect(rel, f).not.toMatch(new RegExp(`\\n        ${f}:`));
    expect(rel).not.toMatch(/required:/); // nothing is documented as required
    const src = section("'/v2/projects/{name}/sources':");
    expect(src).toMatch(/multipart\/form-data/);
    expect(src).toMatch(/required:\s*\n\s*- file/);
    expect(src).toMatch(/format: binary/);
    expect(src).toMatch(/sourceID/);
    expect(section("'/v2/projects/{name}/releases':")).toMatch(/releaseID/);
  });
  it("OUR release body = the documented fields + exactly the CLI-only set the CLI always sends (build, platformConfig, gitInfo) and nothing else", () => {
    const body = { sourceID: "src_1", port: 3000, type: "next", platformConfig: {}, build: { cache: true }, gitInfo: NON_REPO_GIT_INFO };
    expect(CreateReleaseRequestSchema.safeParse(body).success).toBe(true);
    expect(Object.keys(body).sort()).toEqual([...CLI_RELEASE_KEYS.documented, ...CLI_RELEASE_KEYS.cliOnly].sort());
    for (const omitted of CLI_RELEASE_KEYS.cliUndefinedOmitted) expect(CreateReleaseRequestSchema.safeParse({ ...body, [omitted]: "x" }).success, omitted).toBe(false); // never added, never from text
    expect(NON_REPO_GIT_INFO).toEqual({ branch: null, message: null, commit: null, committedAt: null, remote: null, author: { email: null, name: null }, tags: [] });
    expect(CreateReleaseRequestSchema.safeParse({ ...body, gitInfo: { ...NON_REPO_GIT_INFO, branch: "main" } }).success).toBe(false); // no repository data can ever be injected
    expect(CreateReleaseRequestSchema.safeParse({ ...body, build: { cache: false } }).success).toBe(false);
    expect(CreateReleaseRequestSchema.safeParse({ ...body, platformConfig: { version: "22" } }).success).toBe(false);
  });
  it("the wire format of both writes: URL, method, team query, headers, multipart field/filename/type, exact JSON body; no createApp path exists", async () => {
    const seen: { url: URL; method: string; headers: Record<string, string>; body: unknown; redirect: string | undefined }[] = [];
    const fetchImpl = (async (input: RequestInfo | URL, init?: RequestInit) => {
      seen.push({ url: new URL(String(input)), method: String(init?.method), headers: init?.headers as Record<string, string>, body: init?.body, redirect: init?.redirect });
      const u = String(input);
      return new Response(JSON.stringify(u.includes("/sources") ? { sourceID: "src_1" } : { releaseID: "rel_1" }), { status: 200, headers: { "content-type": "application/json" } });
    }) as unknown as typeof fetch;
    const client = new LiaraWriteClient({ baseUrl: new URL("https://api.liara.ir"), token: new Secret(CANARY.token), teamId: "team_demo_1", timeoutMs: 5000, uploadTimeoutMs: 5000, fetchImpl });
    const art = await buildDeploymentArtifact(demoZip());
    expect(await client.uploadSource("liara-agent-demo", art.bytes)).toMatchObject({ ok: true, data: { sourceID: "src_1" } });
    const body = { sourceID: "src_1", port: 3000, type: "next" as const, platformConfig: {}, build: { cache: true as const }, gitInfo: NON_REPO_GIT_INFO };
    expect(await client.createRelease("liara-agent-demo", body)).toMatchObject({ ok: true, data: { releaseID: "rel_1" } });
    expect(seen).toHaveLength(2);
    const [up, rel] = seen;
    expect(up!.method).toBe("POST");
    expect(`${up!.url.pathname}?${up!.url.searchParams}`).toBe("/v2/projects/liara-agent-demo/sources?teamID=team_demo_1"); // CLI: `v2/projects/${project}/sources` + teamID on every request
    expect(up!.headers.Authorization).toBe(`Bearer ${CANARY.token}`);
    expect(up!.headers["Content-Type"]).toBeUndefined(); // multipart boundary is set by fetch
    expect(up!.redirect).toBe("manual");
    const form = up!.body as FormData;
    expect([...form.keys()]).toEqual(["file"]); // OpenAPI + CLI: the single multipart field is `file`
    const file = form.get("file") as File;
    expect(file.name).toBe("source.tar.gz");
    expect(file.type).toBe("application/gzip");
    expect(file.size).toBe(art.size);
    expect(rel!.method).toBe("POST");
    expect(`${rel!.url.pathname}?${rel!.url.searchParams}`).toBe("/v2/projects/liara-agent-demo/releases?teamID=team_demo_1");
    expect(rel!.headers["Content-Type"]).toBe("application/json");
    expect(JSON.parse(String(rel!.body))).toEqual({ sourceID: "src_1", port: 3000, type: "next", platformConfig: {}, build: { cache: true }, gitInfo: NON_REPO_GIT_INFO });
    for (const r of seen) {
      expect(r.url.href).not.toContain(CANARY.token);
      expect(String(typeof r.body === "string" ? r.body : "")).not.toContain(CANARY.token);
      expect(r.url.pathname).not.toBe("/v1/projects"); // never the create endpoint
    }
  });
});

describe("the trusted demo artifact (fixtures/demo-app → ZIP → tar.gz)", () => {
  it("is deterministic, small, contains exactly the 8 repository-owned files as regular files, and no secrets, dependencies or build output", async () => {
    const zip = demoZip();
    const a = await buildDeploymentArtifact(zip);
    const b = await buildDeploymentArtifact(demoZip());
    expect(a.sha256).toBe(b.sha256);
    expect(a.paths).toEqual([".gitignore", "README.md", "app/health/route.js", "app/layout.js", "app/page.js", "next.config.js", "package-lock.json", "package.json"]);
    expect(a.excluded).toEqual({ byIgnoreRules: 0, sensitiveNames: [], dependencyEntries: 0 });
    expect(a.size).toBeLessThan(20 * 1024); // limit for the lowest bundle plan is 128 MB
    expect(a.bytes.subarray(0, 2).toString("hex")).toBe("1f8b"); // gzip
    const tar = gunzipSync(a.bytes);
    const names: string[] = [];
    const types = new Set<string>();
    for (let o = 0; o + 512 <= tar.length; ) {
      const h = tar.subarray(o, o + 512);
      if (h.every((x) => x === 0)) break;
      names.push(h.subarray(0, 100).toString().replace(/\0.*$/, ""));
      types.add(String.fromCharCode(h[156] || 48));
      o += 512 + Math.ceil(parseInt(h.subarray(124, 136).toString().replace(/\0.*$/, "").trim() || "0", 8) / 512) * 512;
    }
    expect(names).toEqual(a.paths);
    expect([...types]).toEqual(["0"]); // regular files only (the CLI's own tar also adds directory entries; extraction creates parents)
    expect(names.some((n) => /^\.env|node_modules|\.next|\.git\/|\.pem$|id_rsa|credentials|liara\.json|Dockerfile/.test(n))).toBe(false);
    expect(names.every((n) => !n.startsWith("/") && !n.includes("..") && !n.startsWith("./"))).toBe(true);
  });
  it("the fixture's package.json has the three scripts Liara's Next.js builder needs, pinned dependencies only, and the /health route returns the verified marker", () => {
    const pkg = JSON.parse(readFileSync(path.join(ROOT, "fixtures/demo-app/package.json"), "utf8")) as { scripts: Record<string, string>; dependencies: Record<string, string>; engines: Record<string, string> };
    expect(pkg.scripts).toEqual({ dev: "next dev", build: "next build", start: "next start" });
    expect(Object.keys(pkg.dependencies).sort()).toEqual(["next", "react", "react-dom"]);
    for (const v of Object.values(pkg.dependencies)) expect(v).toMatch(/^\d+\.\d+\.\d+$/); // exact versions
    const lock = readFileSync(path.join(ROOT, "fixtures/demo-app/package-lock.json"), "utf8");
    for (const m of lock.matchAll(/"resolved":\s*"([^"]+)"/g)) expect(m[1], m[1]).toMatch(/^https:\/\/registry\.npmjs\.org\//);
    expect(readFileSync(path.join(ROOT, "fixtures/demo-app/app/health/route.js"), "utf8")).toContain('Response.json({ status: "ok", app: "liara-agent-demo", version: "1" })');
  });
});
