import { existsSync, statSync } from "node:fs";
import path from "node:path";
import { describe, expect, it } from "vitest";
import { UPLOAD_LIMITS } from "@/server/deploy/limits";
import { crc32, isZipError, readEntry, readZipDirectory, safeEntryPath, ZipError } from "@/server/deploy/zip";
import { withProject, workspaceStats } from "@/server/deploy/workspace";
import { buildZip, type ZipSpec } from "../helpers/zip";

const code = (fn: () => unknown): string | null => {
  try {
    fn();
    return null;
  } catch (e) {
    if (!isZipError(e)) throw e;
    return e.code;
  }
};
const rej = (specs: ZipSpec[]) => code(() => readZipDirectory(buildZip(specs)));
const gone = () => workspaceStats.active.size === 0 && workspaceStats.all.every((d) => !existsSync(d));

describe("ZIP reader — valid archives", () => {
  it("lists files and directories with validated, normalised paths", () => {
    const z = buildZip([{ name: "src", dir: true }, { name: "src/a.txt", data: "hello" }, { name: "b.txt", data: "" }]);
    const e = readZipDirectory(z);
    expect(e.map((x) => [x.path, x.isDir])).toEqual([["src", true], ["src/a.txt", false], ["b.txt", false]]);
    expect(readEntry(z, e[1]!).toString()).toBe("hello");
  });
  it("supports stored and deflated entries and verifies CRC", () => {
    const z = buildZip([{ name: "s.txt", data: "stored", method: 0 }, { name: "d.txt", data: "deflated ".repeat(50), method: 8 }]);
    const [s, d] = readZipDirectory(z);
    expect(readEntry(z, s!).toString()).toBe("stored");
    expect(readEntry(z, d!).toString()).toBe("deflated ".repeat(50));
  });
  it("accepts an empty archive and trailing bytes after the EOCD record", () => {
    expect(readZipDirectory(buildZip([]))).toEqual([]);
    expect(readZipDirectory(buildZip([{ name: "a", data: "x" }], { commentTail: 5 })).length).toBe(1);
  });
  it("crc32 matches the known test vector", () => {
    expect(crc32(Buffer.from("123456789"))).toBe(0xcbf43926);
  });
});

describe("ZIP reader — hostile archives are rejected before anything is written", () => {
  it("not a zip at all", () => {
    for (const b of [Buffer.from("hello world, this is not a zip file at all.."), Buffer.alloc(0), Buffer.alloc(100, 0x41), Buffer.from("PK\u0003\u0004")]) expect(code(() => readZipDirectory(b))).toBe("not_a_zip");
  });
  it("path traversal and unsafe names", () => {
    const bad = ["../evil.txt", "a/../../evil.txt", "/etc/passwd", "C:/Windows/x", "c:evil", "a\\b.txt", "..\\evil", "a/./b", "a//b", "a/b/", "./x", "x/..", "con", "aux.txt", "a/nul.js", "trailing.", "trail ", "a\u0000b", "a\nb", "a\u202eb", "\u200bhidden"];
    for (const name of bad) {
      const c = rej([{ name: name === "a/b/" ? "a/b/../.." : name, data: "x" }]);
      expect(c, JSON.stringify(name)).toBe("unsafe_path");
    }
  });
  it("overlong and too deep paths", () => {
    expect(rej([{ name: "a".repeat(UPLOAD_LIMITS.maxPathLength + 1), data: "x" }])).toBe("unsafe_path");
    expect(rej([{ name: Array(UPLOAD_LIMITS.maxPathDepth + 2).fill("d").join("/") + "/f", data: "x" }])).toBe("unsafe_path");
  });
  it("safeEntryPath normalises directory names", () => {
    expect(safeEntryPath("a/b/")).toBe("a/b");
    expect(() => safeEntryPath("")).toThrow(ZipError);
  });
  it("symlinks and special files (unix modes) are rejected", () => {
    for (const mode of [0o120777, 0o010644, 0o020644, 0o060644, 0o140755]) expect(rej([{ name: "link", data: "target", mode }]), mode.toString(8)).toBe("symlink_or_special");
  });
  it("a regular file and directory unix modes are fine", () => {
    expect(rej([{ name: "ok", data: "x", mode: 0o100755 }, { name: "d", dir: true, mode: 0o040700 }])).toBeNull();
  });
  it("duplicate entry names, including case-insensitive duplicates", () => {
    expect(rej([{ name: "a.txt", data: "1" }, { name: "a.txt", data: "2" }])).toBe("duplicate_entry");
    expect(rej([{ name: "Readme.md", data: "1" }, { name: "README.md", data: "2" }])).toBe("duplicate_entry");
  });
  it("encrypted archives", () => {
    expect(rej([{ name: "secret.txt", data: "x", encrypted: true }])).toBe("encrypted");
  });
  it("zip64 / multi-disk / unsupported compression methods", () => {
    const z = buildZip([{ name: "a", data: "x" }]);
    const eocd = z.length - 22;
    const z64 = Buffer.from(z);
    z64.writeUInt16LE(0xffff, eocd + 10);
    z64.writeUInt16LE(0xffff, eocd + 8);
    expect(code(() => readZipDirectory(z64))).toBe("unsupported_zip");
    const multi = Buffer.from(z);
    multi.writeUInt16LE(1, eocd + 4);
    expect(code(() => readZipDirectory(multi))).toBe("unsupported_zip");
    const meth = Buffer.from(z);
    const cen = meth.readUInt32LE(eocd + 16);
    meth.writeUInt16LE(12, cen + 10); // bzip2
    expect(code(() => readZipDirectory(meth))).toBe("unsupported_zip");
  });
  it("too many entries (checked before parsing the directory)", () => {
    const specs = Array.from({ length: UPLOAD_LIMITS.maxEntries + 1 }, (_, i) => ({ name: `f${i}`, data: "" }));
    expect(rej(specs)).toBe("too_many_entries");
  });
  it("declared uncompressed size beyond the total limit", () => {
    const specs = Array.from({ length: 12 }, (_, i) => ({ name: `big${i}.bin`, data: "x", lieSize: 7 * 1024 * 1024, lieCompressed: 7 * 1024 * 1024 / 2 }));
    expect(["uncompressed_too_large", "ratio_exceeded"]).toContain(rej(specs));
  });
  it("a single file declared larger than the per-file limit", () => {
    expect(rej([{ name: "huge.js", data: "x", lieSize: UPLOAD_LIMITS.maxFileBytes + 1, lieCompressed: 1024 * 1024 }])).toBe("file_too_large");
  });
  it("zip bomb: absurd per-entry compression ratio", () => {
    expect(rej([{ name: "zeros.bin", data: Buffer.alloc(7 * 1024 * 1024, 0) }])).toBe("ratio_exceeded");
    expect(["file_too_large", "ratio_exceeded"]).toContain(rej([{ name: "zeros.bin", data: Buffer.alloc(40 * 1024 * 1024, 0) }]));
  });
  it("many medium entries that add up to an extreme overall ratio", () => {
    const chunk = Buffer.alloc(3 * 1024 * 1024, 0);
    const specs = Array.from({ length: 8 }, (_, i) => ({ name: `z${i}.bin`, data: chunk }));
    expect(["ratio_exceeded", "uncompressed_too_large"]).toContain(rej(specs));
  });
  it("oversized archive bytes", () => {
    expect(code(() => readZipDirectory(Buffer.alloc(UPLOAD_LIMITS.maxArchiveBytes + 1)))).toBe("too_large");
  });
  it("corrupt central directory bounds", () => {
    const z = buildZip([{ name: "a", data: "x" }]);
    const bad = Buffer.from(z);
    bad.writeUInt32LE(bad.length + 1000, bad.length - 22 + 16);
    expect(code(() => readZipDirectory(bad))).toBe("corrupt");
    const truncated = z.subarray(0, z.length - 10);
    expect(code(() => readZipDirectory(truncated))).toBe("not_a_zip");
  });
});

describe("entry inflation cannot be tricked by lying headers", () => {
  it("declared size smaller than the real content is caught by the output cap (no over-allocation)", () => {
    const real = Buffer.from("a".repeat(5000));
    const z = buildZip([{ name: "x.txt", data: real, lieSize: 10 }]);
    const [e] = readZipDirectory(z);
    expect(code(() => readEntry(z, e!))).toBe("size_mismatch");
  });
  it("declared size larger than the real content", () => {
    const z = buildZip([{ name: "x.txt", data: "short", lieSize: 4000 }]);
    const [e] = readZipDirectory(z);
    expect(code(() => readEntry(z, e!))).toBe("size_mismatch");
  });
  it("wrong CRC is rejected", () => {
    const z = buildZip([{ name: "x.txt", data: "hello world", lieCrc: 123 }]);
    const [e] = readZipDirectory(z);
    expect(code(() => readEntry(z, e!))).toBe("corrupt");
  });
  it("stored entry with a size lie", () => {
    const z = buildZip([{ name: "x.txt", data: "hello", method: 0, lieSize: 99 }]);
    const [e] = readZipDirectory(z);
    expect(code(() => readEntry(z, e!))).toBe("size_mismatch");
  });
});

describe("isolated workspace", () => {
  it("extracts only non-sensitive, non-dependency files with restrictive permissions and removes the directory afterwards", async () => {
    const z = buildZip([
      { name: "proj/package.json", data: "{}" },
      { name: "proj/src/a.ts", data: "export {}" },
      { name: "proj/.env", data: "SECRET=value" },
      { name: "proj/.env.local", data: "X=1" },
      { name: "proj/.env.example", data: "API_KEY=" },
      { name: "proj/.npmrc", data: "//registry:_authToken=abc" },
      { name: "proj/id_rsa", data: "-----BEGIN-----" },
      { name: "proj/deploy.pem", data: "x" },
      { name: "proj/node_modules/x/index.js", data: "x" },
      { name: "proj/.git/config", data: "[remote]" },
      { name: "proj/.next/cache/a", data: "x" },
    ]);
    const out = await withProject(z, (tree, s) => {
      expect([...tree.files].sort()).toEqual([".env.example", "package.json", "src/a.ts"]);
      expect(s.sensitiveFiles.sort()).toEqual([".env", ".env.local", ".npmrc", "deploy.pem", "id_rsa"]);
      expect(s.skippedDependencyEntries).toBe(3);
      expect(s.strippedRoot).toBe("proj");
      expect(tree.read(".env", 1000)).toBeNull(); // never extracted, never readable
      const dir = [...workspaceStats.active][0]!;
      expect(statSync(dir).mode & 0o777).toBe(0o700);
      expect(statSync(path.join(dir, "package.json")).mode & 0o777).toBe(0o600);
      expect(existsSync(path.join(dir, ".env"))).toBe(false);
      expect(existsSync(path.join(dir, "node_modules"))).toBe(false);
      return "ok";
    });
    expect(out).toBe("ok");
    expect(gone()).toBe(true);
  });
  it("removes the temp directory even when analysis throws, and writes nothing when the archive is rejected", async () => {
    const created = workspaceStats.created;
    await expect(withProject(buildZip([{ name: "a.txt", data: "x" }]), () => { throw new Error("boom"); })).rejects.toThrow("boom");
    expect(gone()).toBe(true);
    await expect(withProject(buildZip([{ name: "../x", data: "x" }]), () => "never")).rejects.toMatchObject({ code: "unsafe_path" });
    expect(workspaceStats.created).toBe(created + 1); // the hostile archive never even got a directory
    expect(gone()).toBe(true);
  });
  it("a lying entry discovered DURING extraction aborts and still cleans up", async () => {
    const z = buildZip([{ name: "ok.txt", data: "fine" }, { name: "bad.txt", data: "x".repeat(2000), lieSize: 5 }]);
    await expect(withProject(z, () => "never")).rejects.toMatchObject({ code: "size_mismatch" });
    expect(gone()).toBe(true);
  });
  it("tree.read honours the size cap and strips a BOM", async () => {
    await withProject(buildZip([{ name: "big.txt", data: "x".repeat(500) }, { name: "bom.txt", data: "\ufeffhello" }]), (tree) => {
      expect(tree.read("big.txt", 100)).toBeNull();
      expect(tree.read("bom.txt", 100)).toBe("hello");
      expect(tree.read("missing", 100)).toBeNull();
    });
  });
  it("the wrapping top-level folder is stripped only when there is no root package.json", async () => {
    await withProject(buildZip([{ name: "wrap/package.json", data: "{}" }]), (t) => expect(t.has("package.json")).toBe(true));
    await withProject(buildZip([{ name: "package.json", data: "{}" }, { name: "sub/a.txt", data: "x" }]), (t) => expect(t.has("sub/a.txt")).toBe(true));
  });
});
