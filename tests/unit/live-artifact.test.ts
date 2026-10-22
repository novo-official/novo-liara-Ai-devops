import { createHash } from "node:crypto";
import { gunzipSync } from "node:zlib";
import { describe, expect, it } from "vitest";
import { ARTIFACT_FORMAT, ArtifactError, buildDeploymentArtifact, deterministicGzip, MAX_ARTIFACT_BYTES, parseIgnore, tarEntry } from "@/server/live/artifact";
import { workspaceStats } from "@/server/deploy/workspace";
import { CANARY } from "../helpers/canaries";
import { demoZip } from "../helpers/live-exec";
import { buildZip, type ZipSpec } from "../helpers/zip";

/** minimal independent ustar reader used to verify the produced archive */
function readTar(gz: Buffer): { name: string; data: Buffer; mode: number; mtime: number; uid: number; gid: number; checksumOk: boolean }[] {
  const tar = gunzipSync(gz);
  const out: ReturnType<typeof readTar> = [];
  for (let off = 0; off + 512 <= tar.length; ) {
    const h = tar.subarray(off, off + 512);
    if (h.every((b) => b === 0)) break;
    const str = (a: number, l: number) => h.subarray(a, a + l).toString("utf8").replace(/\0.*$/, "");
    const size = parseInt(str(124, 12), 8);
    const prefix = str(345, 155);
    const chk = parseInt(str(148, 8).trim(), 8);
    const copy = Buffer.from(h);
    copy.fill(0x20, 148, 156);
    out.push({ name: prefix ? `${prefix}/${str(0, 100)}` : str(0, 100), data: tar.subarray(off + 512, off + 512 + size), mode: parseInt(str(100, 8), 8), mtime: parseInt(str(136, 12), 8), uid: parseInt(str(108, 8), 8), gid: parseInt(str(116, 8), 8), checksumOk: copy.reduce((a, b) => a + b, 0) === chk });
    off += 512 + Math.ceil(size / 512) * 512;
  }
  return out;
}
const zipOf = (files: Record<string, string | Buffer>, extra: ZipSpec[] = []) => buildZip([...Object.entries(files).map(([name, data]) => ({ name, data })), ...extra]);
const paths = async (files: Record<string, string>) => (await buildDeploymentArtifact(zipOf(files))).paths;

describe("deployment artifact: format (as confirmed from the official CLI source)", () => {
  it("is a tar.gz with root-relative entries and no wrapper directory", async () => {
    const a = await buildDeploymentArtifact(demoZip());
    expect(a.format).toBe(ARTIFACT_FORMAT);
    expect(a.bytes[0]).toBe(0x1f);
    expect(a.bytes[1]).toBe(0x8b);
    const entries = readTar(a.bytes);
    expect(entries.map((e) => e.name)).toEqual(a.paths);
    expect(entries.map((e) => e.name)).toContain("package.json");
    expect(entries.map((e) => e.name)).toContain("app/health/route.js");
    expect(entries.every((e) => !e.name.startsWith("/") && !e.name.includes(".."))).toBe(true);
    expect(entries.every((e) => e.checksumOk)).toBe(true);
    expect(a.sha256).toBe(createHash("sha256").update(a.bytes).digest("hex"));
  });
  it("preserves file contents byte for byte (including binary)", async () => {
    const bin = Buffer.from([0, 1, 2, 255, 254, 0, 10, 13, 200]);
    const a = await buildDeploymentArtifact(zipOf({ "package.json": "{}", "public/logo.bin": bin, "app/页面.txt": "unicode name ✓" }));
    const e = Object.fromEntries(readTar(a.bytes).map((x) => [x.name, x.data]));
    expect(Buffer.compare(e["public/logo.bin"]!, bin)).toBe(0);
    expect(e["app/页面.txt"]!.toString()).toBe("unicode name ✓");
  });
  it("uses gzip level 9 with a fixed header (mtime 0, OS = unix)", async () => {
    const a = await buildDeploymentArtifact(demoZip());
    expect(a.bytes.readUInt32LE(4)).toBe(0);
    expect(a.bytes[9]).toBe(3);
    expect(a.bytes[8]).toBe(2); // XFL = maximum compression
  });
});

describe("deployment artifact: determinism", () => {
  it("the same ZIP always yields the same bytes and digest", async () => {
    const z = demoZip();
    const [a, b] = [await buildDeploymentArtifact(z), await buildDeploymentArtifact(z)];
    expect(a.sha256).toBe(b.sha256);
    expect(Buffer.compare(a.bytes, b.bytes)).toBe(0);
  });
  it("entry ORDER in the ZIP does not matter; normalised metadata (mtime 0, uid/gid 0, mode 0644)", async () => {
    const files = { "package.json": "{}", "b/x.js": "1", "a/y.js": "2", "z.txt": "3" };
    const fwd = await buildDeploymentArtifact(zipOf(files));
    const rev = await buildDeploymentArtifact(zipOf(Object.fromEntries(Object.entries(files).reverse())));
    expect(fwd.sha256).toBe(rev.sha256);
    for (const e of readTar(fwd.bytes)) expect([e.mtime, e.uid, e.gid, e.mode]).toEqual([0, 0, 0, 0o644]);
    expect(fwd.paths).toEqual(["a/y.js", "b/x.js", "package.json", "z.txt"]);
  });
  it("any content change changes the digest", async () => {
    const a = await buildDeploymentArtifact(zipOf({ "package.json": "{}", "a.js": "1" }));
    const b = await buildDeploymentArtifact(zipOf({ "package.json": "{}", "a.js": "2" }));
    expect(a.sha256).not.toBe(b.sha256);
  });
  it("a wrapping top-level folder is stripped (same artifact as the unwrapped ZIP)", async () => {
    const a = await buildDeploymentArtifact(zipOf({ "package.json": "{}", "a.js": "1" }));
    const w = await buildDeploymentArtifact(zipOf({ "proj/package.json": "{}", "proj/a.js": "1" }));
    expect(w.sha256).toBe(a.sha256);
  });
});

describe("deployment artifact: what is NOT packaged", () => {
  it("never packages secrets or dependency/VCS trees, and reports names only", async () => {
    const a = await buildDeploymentArtifact(
      zipOf({
        "package.json": "{}",
        ".env": `K=${CANARY.envValue}`,
        ".env.local": `T=${CANARY.token}`,
        ".env.production": "X=1",
        ".env.example": "API_KEY=",
        ".npmrc": `//r/:_authToken=${CANARY.token}`,
        "server.pem": CANARY.sshKey,
        "credentials.json": "{}",
        "node_modules/x/index.js": "x",
        ".git/config": "[core]",
        ".next/cache/a": "x",
        "src/ok.js": "1",
      }),
    );
    expect(a.paths).toEqual([".env.example", "package.json", "src/ok.js"]);
    expect(a.excluded.sensitiveNames.sort()).toEqual([".env", ".env.local", ".env.production", ".npmrc", "credentials.json", "server.pem"]);
    expect(gunzipSync(a.bytes).toString("latin1")).not.toContain(CANARY.envValue);
    expect(gunzipSync(a.bytes).toString("latin1")).not.toContain(CANARY.sshKey);
    expect(JSON.stringify({ ...a, bytes: undefined })).not.toContain(CANARY.token);
  });
  it("applies the CLI default ignores: liara.json, .dockerignore, editor files, backup files, .DS_Store", async () => {
    expect(await paths({ "package.json": "{}", "liara.json": "{}", ".dockerignore": "x", ".idea/a": "1", ".vscode/b": "1", "notes.txt~": "1", ".DS_Store": "1", "sub/.DS_Store": "1", "bower_components/x/y": "1", "ok.js": "1" })).toEqual(["ok.js", "package.json"]);
  });
  it("keeps directories named like analysis-skipped folders (dist, build, coverage, .cache) because the CLI does not ignore them", async () => {
    expect(await paths({ "package.json": "{}", "src/build/util.js": "1", "dist/a.js": "1", "coverage/c.txt": "1", ".cache/k": "1" })).toEqual([".cache/k", "coverage/c.txt", "dist/a.js", "package.json", "src/build/util.js"]);
  });
});

describe("deployment artifact: ignore files (CLI semantics)", () => {
  it(".liaraignore wins; .dockerignore and .gitignore are then NOT read", async () => {
    const p = await paths({ "package.json": "{}", ".liaraignore": "secret.txt\n", ".gitignore": "keep.txt\n", ".dockerignore": "other.txt\n", "secret.txt": "1", "keep.txt": "1", "other.txt": "1" });
    expect(p).toEqual([".gitignore", ".liaraignore", "keep.txt", "other.txt", "package.json"]);
  });
  it("without .liaraignore: .dockerignore beats .gitignore", async () => {
    expect(await paths({ "package.json": "{}", ".dockerignore": "a.txt\n", ".gitignore": "b.txt\n", "a.txt": "1", "b.txt": "1" })).toEqual([".gitignore", "b.txt", "package.json"]); // (.dockerignore itself is a CLI default ignore)
  });
  it("supports comments, blank lines, *, **, ?, [..], leading /, trailing /, and ! negation", async () => {
    const ign = ["# comment", "", "*.log", "!keep.log", "/root-only.txt", "tmp/", "docs/**/draft.md", "file?.txt", "[ab]x.txt", "**/gen/"].join("\n");
    const p = await paths({
      "package.json": "{}",
      ".gitignore": ign,
      "a.log": "1", "keep.log": "1", "sub/z.log": "1",
      "root-only.txt": "1", "sub/root-only.txt": "1",
      "tmp/x.txt": "1", "src/tmp/y.txt": "1",
      "docs/a/b/draft.md": "1", "docs/other.md": "1",
      "file1.txt": "1", "file12.txt": "1",
      "ax.txt": "1", "cx.txt": "1",
      "a/gen/o.js": "1", "gen/p.js": "1",
    });
    expect(p).toEqual([".gitignore", "cx.txt", "docs/other.md", "file12.txt", "keep.log", "package.json", "sub/root-only.txt"]);
  });
  it("nested ignore files apply to their own directory; an ignored directory cannot be rescued by a negation inside it", async () => {
    const p = await paths({ "package.json": "{}", ".gitignore": "vendor/\n", "vendor/.gitignore": "!keep.js\n", "vendor/keep.js": "1", "app/.gitignore": "*.tmp\n", "app/a.tmp": "1", "app/b.js": "1", "c.tmp": "1" });
    expect(p).toEqual([".gitignore", "app/.gitignore", "app/b.js", "c.tmp", "package.json"]);
  });
  it("ignoring everything is an error (as in the CLI), never an empty upload", async () => {
    await expect(buildDeploymentArtifact(zipOf({ ".gitignore": "*\n!.gitignore\n", "a.js": "1" }))).resolves.toBeDefined();
    await expect(buildDeploymentArtifact(zipOf({ ".liaraignore": "*\n", "a.js": "1" }))).rejects.toMatchObject({ code: "empty_after_ignore" });
  });
  it("parseIgnore tolerates hostile input (huge lines, odd bytes)", () => {
    expect(() => parseIgnore("a".repeat(5000) + "\n[\n\\\n**\n!\n/\n" + "x\u0000y\n")).not.toThrow();
    expect(parseIgnore("a".repeat(5000)).length).toBe(0);
  });
});

describe("deployment artifact: limits and hostile input", () => {
  it("rejects hostile ZIPs exactly like the analysis pipeline (nothing is packaged)", async () => {
    for (const z of [buildZip([{ name: "../x", data: "x" }]), buildZip([{ name: "package.json", data: "{}" }, { name: "l", data: "/etc/passwd", mode: 0o120777 }]), buildZip([{ name: "p", data: Buffer.alloc(7 * 1024 * 1024) }]), Buffer.from("not a zip at all, sorry..........")]) await expect(buildDeploymentArtifact(z)).rejects.toMatchObject({ name: "ZipError" });
  });
  it("leaves no temporary directory behind, success or failure", async () => {
    await buildDeploymentArtifact(demoZip());
    await expect(buildDeploymentArtifact(zipOf({ ".liaraignore": "*\n" }))).rejects.toBeInstanceOf(ArtifactError);
    expect(workspaceStats.active.size).toBe(0);
  });
  it("refuses an artifact above the lowest documented bundle limit", () => {
    expect(MAX_ARTIFACT_BYTES).toBe(128 * 1024 * 1024);
  });
  it("a path that cannot be expressed in ustar is refused rather than truncated", () => {
    expect(() => tarEntry("a".repeat(200), Buffer.from("x"), 0o644)).toThrow();
    expect(() => tarEntry(`${"d".repeat(120)}/${"f".repeat(60)}`, Buffer.from("x"), 0o644)).not.toThrow(); // prefix + name split
  });
  it("deadline: a run that exceeds its time budget stops", async () => {
    let n = 0;
    await expect(buildDeploymentArtifact(demoZip(), { deadlineMs: 5, now: () => (n += 10) })).rejects.toMatchObject({ code: "timeout" });
  });
  it("deterministicGzip output does not depend on the clock", async () => {
    const b = Buffer.from("same payload");
    const x = deterministicGzip(b);
    await new Promise((r) => setTimeout(r, 1100));
    expect(Buffer.compare(x, deterministicGzip(b))).toBe(0);
  });
});

describe("the demo fixture as an artifact", () => {
  it("packages exactly the trusted project files and nothing else", async () => {
    const a = await buildDeploymentArtifact(demoZip());
    expect(a.paths).toEqual([".gitignore", "README.md", "app/health/route.js", "app/layout.js", "app/page.js", "next.config.js", "package-lock.json", "package.json"]);
    expect(a.excluded.sensitiveNames).toEqual([]);
    expect(a.warnings).toEqual([]);
  });
  it("is a deterministic, small archive", async () => {
    const a = await buildDeploymentArtifact(demoZip());
    expect(a.size).toBeLessThan(200 * 1024);
    expect((await buildDeploymentArtifact(demoZip())).sha256).toBe(a.sha256);
  });
});
