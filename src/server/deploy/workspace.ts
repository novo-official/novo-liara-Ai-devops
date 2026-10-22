import { createHash } from "node:crypto";
import { constants as fsc, closeSync, fstatSync, mkdirSync, mkdtempSync, openSync, readSync, realpathSync, rmSync, writeSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { SENSITIVE_FILE, SKIPPED_DIRS, UPLOAD_LIMITS } from "./limits";
import { readEntry, readZipDirectory, ZipError, type ZipEntry } from "./zip";

/**
 * Isolated, short-lived workspace for ONE uploaded archive.
 *  - validated central directory first (limits, traversal, symlinks, ratio) — nothing is written before that passes
 *  - only non-sensitive, non-dependency files are extracted (0700 dir, 0600 files, O_EXCL|O_NOFOLLOW, realpath re-check)
 *  - nothing is ever executed, installed or built
 *  - the directory is removed in `finally`, success or failure
 */

export interface SourceTree {
  /** relative paths of extracted files */
  files: ReadonlySet<string>;
  has(p: string): boolean;
  /** UTF-8 text of an extracted file (BOM stripped); null if absent or larger than `maxBytes` */
  read(p: string, maxBytes: number): string | null;
  /** raw bytes of an extracted file (deployment packaging); null if absent or larger than `maxBytes` */
  readBytes(p: string, maxBytes: number): Buffer | null;
  /** extracted files directly or indirectly under a prefix ("" = all) */
  under(prefix: string): string[];
}

export interface ExtractionSummary {
  artifactDigest32: string;
  archiveBytes: number;
  entryCount: number;
  fileCount: number;
  extractedFileCount: number;
  totalDeclaredBytes: number;
  skippedDependencyEntries: number;
  /** NAMES only of files that may hold secrets; never read or stored */
  sensitiveFiles: string[];
  strippedRoot: string | null;
}

export const WORKSPACE_PREFIX = "liara-src-";

export function artifactDigest(buf: Buffer): string {
  return createHash("sha256").update(buf).digest("hex").slice(0, 32);
}

const isSkippedBy = (skip: readonly string[]) => (p: string) => p.split("/").some((s) => skip.includes(s));

export interface ProjectOptions {
  /** path SEGMENTS that are never extracted. Default: the analysis profile (SKIPPED_DIRS). The deployment profile uses the official CLI's default ignores. */
  skipSegments?: readonly string[];
}

function planExtraction(entries: ZipEntry[], isSkippedPath: (p: string) => boolean) {
  // a single wrapping top-level folder (typical for "download as ZIP") is stripped when there is no root package.json
  const live = entries.filter((e) => !isSkippedPath(e.path));
  const tops = new Set(live.map((e) => e.path.split("/")[0]!));
  const hasRootManifest = live.some((e) => !e.isDir && e.path === "package.json");
  let strip: string | null = null;
  if (!hasRootManifest && tops.size === 1) {
    const top = [...tops][0]!;
    if (live.some((e) => e.path.startsWith(top + "/"))) strip = top;
  }
  return strip;
}

export async function withProject<T>(archive: Buffer, fn: (tree: SourceTree, summary: ExtractionSummary) => Promise<T> | T, opts: ProjectOptions = {}): Promise<T> {
  const isSkippedPath = isSkippedBy(opts.skipSegments ?? SKIPPED_DIRS);
  const entries = readZipDirectory(archive); // throws ZipError before any disk access
  const root = mkdtempSync(path.join(tmpdir(), WORKSPACE_PREFIX), { encoding: "utf8" });
  workspaceStats.created++;
  workspaceStats.active.add(root);
  if (workspaceStats.all.length < 200) workspaceStats.all.push(root);
  try {
    const strip = planExtraction(entries, isSkippedPath);
    const rootReal = realpathSync(root);
    const files = new Set<string>();
    const sensitive: string[] = [];
    let skippedDeps = 0;
    let extractedBytes = 0;
    let declared = 0;
    let fileCount = 0;
    for (const e of entries) {
      declared += e.size;
      if (!e.isDir) fileCount++;
      let rel = e.path;
      if (strip) {
        if (rel === strip) continue;
        rel = rel.slice(strip.length + 1);
      }
      if (isSkippedPath(rel)) {
        skippedDeps++;
        continue;
      }
      if (e.isDir) continue;
      if (SENSITIVE_FILE.test(rel)) {
        if (sensitive.length < 20) sensitive.push(rel);
        continue; // never inflated, never written
      }
      const data = readEntry(archive, e);
      extractedBytes += data.length;
      if (extractedBytes > UPLOAD_LIMITS.maxTotalUncompressedBytes) throw new ZipError("uncompressed_too_large");
      const dest = path.join(rootReal, ...rel.split("/"));
      if (!dest.startsWith(rootReal + path.sep)) throw new ZipError("unsafe_path", "escape"); // belt and braces after safeEntryPath
      mkdirSync(path.dirname(dest), { recursive: true, mode: 0o700 });
      const realDir = realpathSync(path.dirname(dest));
      if (realDir !== rootReal && !realDir.startsWith(rootReal + path.sep)) throw new ZipError("unsafe_path", "escape");
      const fd = openSync(dest, fsc.O_WRONLY | fsc.O_CREAT | fsc.O_EXCL | fsc.O_NOFOLLOW, 0o600);
      try {
        writeSync(fd, data);
      } finally {
        closeSync(fd);
      }
      files.add(rel);
    }
    const tree: SourceTree = {
      files,
      has: (p) => files.has(p),
      under: (prefix) => [...files].filter((f) => prefix === "" || f === prefix || f.startsWith(prefix.endsWith("/") ? prefix : prefix + "/")).sort(),
      readBytes(p, maxBytes) {
        if (!files.has(p)) return null;
        const fd = openSync(path.join(rootReal, ...p.split("/")), fsc.O_RDONLY | fsc.O_NOFOLLOW);
        try {
          const size = fstatSync(fd).size;
          if (size > maxBytes) return null;
          const buf = Buffer.alloc(size);
          let off = 0;
          while (off < size) {
            const n = readSync(fd, buf, off, size - off, off);
            if (n <= 0) break;
            off += n;
          }
          return buf.subarray(0, off);
        } finally {
          closeSync(fd);
        }
      },
      read(p, maxBytes) {
        if (!files.has(p)) return null;
        const fd = openSync(path.join(rootReal, ...p.split("/")), fsc.O_RDONLY | fsc.O_NOFOLLOW);
        try {
          const size = fstatSync(fd).size;
          if (size > maxBytes) return null;
          const buf = Buffer.alloc(size);
          let off = 0;
          while (off < size) {
            const n = readSync(fd, buf, off, size - off, off);
            if (n <= 0) break;
            off += n;
          }
          const text = buf.subarray(0, off).toString("utf8");
          return text.charCodeAt(0) === 0xfeff ? text.slice(1) : text;
        } finally {
          closeSync(fd);
        }
      },
    };
    const summary: ExtractionSummary = {
      artifactDigest32: artifactDigest(archive),
      archiveBytes: archive.length,
      entryCount: entries.length,
      fileCount,
      extractedFileCount: files.size,
      totalDeclaredBytes: declared,
      skippedDependencyEntries: skippedDeps,
      sensitiveFiles: sensitive,
      strippedRoot: strip,
    };
    return await fn(tree, summary);
  } finally {
    rmSync(root, { recursive: true, force: true, maxRetries: 3 });
    workspaceStats.active.delete(root);
    workspaceStats.removed++;
  }
}

/** Bookkeeping (module-local, so it is also a test seam): every workspace created and whether it is gone again. */
export const workspaceStats = { created: 0, removed: 0, active: new Set<string>(), all: [] as string[] };
