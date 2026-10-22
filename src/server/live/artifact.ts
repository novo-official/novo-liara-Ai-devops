import { createHash } from "node:crypto";
import { mkdirSync, writeFileSync } from "node:fs";
import nodePath from "node:path";
import { gzipSync } from "node:zlib";
import { withProject, type ExtractionSummary, type SourceTree } from "../deploy/workspace";

/**
 * DEPLOYMENT ARTIFACT PIPELINE (offline; builds bytes, performs no I/O beyond the isolated temp extraction of `withProject`).
 *
 * Format — taken from the official Liara CLI (`src/utils/create-archive.ts`, read 2026-10 from the public repository; NOT from the OpenAPI, which only says
 * "The .gz file to deploy"): a **tar.gz** (gzip level 9), entries relative to the project root with no wrapper directory.
 * File selection follows the CLI: default ignores + ONE ignore file per directory (`.liaraignore`, else `.dockerignore`, else `.gitignore`).
 * Deliberate differences, all stricter than the CLI: files that may hold secrets (`.env*`, `.npmrc`, keys …) are NEVER packaged (the CLI uploads `.env`
 * unless the user ignores it); symlinks/special files cannot exist (rejected at ZIP validation); packaging is DETERMINISTIC (sorted entries, mtime 0,
 * uid/gid 0, normalised modes, fixed gzip header) so the digest approved by the operator can be re-derived from the same ZIP.
 * Nothing here executes, installs or builds anything.
 */

export const ARTIFACT_FORMAT = "tar.gz;gzip-9;ustar;root-relative;sorted;mtime=0;modes=0644/0755-normalised;deterministic-v1";
/** the lowest documented bundle limit is 128 MB (docs.liara.ir software plans); the CLI's own cap is 256 MiB. We refuse above the lower number. */
export const MAX_ARTIFACT_BYTES = 128 * 1024 * 1024;
export const MAX_ARTIFACT_FILE_BYTES = 8 * 1024 * 1024;

/** The CLI's default ignore list (`DEFAULT_IGNORES`): directory names are applied as path SEGMENTS during extraction, the rest as patterns. */
export const CLI_DEFAULT_IGNORE_SEGMENTS = [".git", ".idea", ".vscode", ".next", "node_modules", "bower_components", ".DS_Store"] as const;
export const CLI_DEFAULT_IGNORE_PATTERNS = [".dockerignore", "*.*~", "liara.json", ".DS_Store"] as const;
const IGNORE_FILES = [".liaraignore", ".dockerignore", ".gitignore"] as const;

export class ArtifactError extends Error {
  override readonly name = "ArtifactError";
  constructor(public readonly code: "empty_after_ignore" | "artifact_too_large" | "path_too_long" | "file_too_large" | "timeout" | "unsupported_ignore_pattern" | "unsafe_path", public readonly detail?: string) {
    super(code);
  }
}
export const isArtifactError = (e: unknown): e is ArtifactError => e instanceof ArtifactError || (typeof e === "object" && e !== null && (e as { name?: unknown }).name === "ArtifactError");

// ---------------------------------------------------------------------------------------------------------------------
// gitignore-subset matcher (what the CLI's `ignore` package provides, for the constructs that matter)
// ---------------------------------------------------------------------------------------------------------------------
interface Rule {
  re: RegExp;
  negate: boolean;
  dirOnly: boolean;
}

function globToRegex(glob: string, anchored: boolean): RegExp {
  let re = "";
  for (let i = 0; i < glob.length; i++) {
    const c = glob[i]!;
    if (c === "*") {
      if (glob[i + 1] === "*") {
        const slashBefore = i === 0 || glob[i - 1] === "/";
        if (slashBefore && glob[i + 2] === "/") {
          re += "(?:.*/)?";
          i += 2;
        } else if (slashBefore && i + 2 === glob.length) {
          re += ".*";
          i += 1;
        } else {
          re += "[^/]*";
          i += 1;
        }
      } else re += "[^/]*";
    } else if (c === "?") re += "[^/]";
    else if (c === "[") {
      const end = glob.indexOf("]", i + 1);
      if (end > i + 1) {
        const body = glob.slice(i + 1, end).replace(/^!/, "^").replace(/\\/g, "\\\\");
        re += `[${body}]`;
        i = end;
      } else re += "\\[";
    } else if (c === "\\" && i + 1 < glob.length) {
      re += glob[i + 1]!.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
      i++;
    } else re += c.replace(/[.*+?^${}()|[\]\\/]/g, (m) => (m === "/" ? "/" : "\\" + m));
  }
  return new RegExp(`^${anchored ? "" : "(?:.*/)?"}${re}$`);
}

export function parseIgnore(text: string): Rule[] {
  const rules: Rule[] = [];
  for (const raw of text.split(/\r?\n/).slice(0, 2000)) {
    let line = raw.replace(/(?<!\\)\s+$/, "");
    if (!line || line.startsWith("#")) continue;
    let negate = false;
    if (line.startsWith("!")) {
      negate = true;
      line = line.slice(1);
    } else if (line.startsWith("\\!") || line.startsWith("\\#")) line = line.slice(1);
    let dirOnly = false;
    if (line.endsWith("/")) {
      dirOnly = true;
      line = line.slice(0, -1);
    }
    if (!line || line.length > 300) continue;
    const anchored = line.startsWith("/") || line.slice(0, -1).includes("/");
    line = line.replace(/^\//, "");
    try {
      rules.push({ re: globToRegex(line, anchored), negate, dirOnly });
    } catch {
      throw new ArtifactError("unsupported_ignore_pattern");
    }
  }
  return rules;
}

class Ignorer {
  /** base directory ("" = root) → rules */
  private byDir = new Map<string, Rule[]>();
  private defaults = parseIgnore(CLI_DEFAULT_IGNORE_PATTERNS.join("\n"));
  constructor(tree: SourceTree) {
    const dirs = new Set<string>([""]);
    for (const f of tree.files) {
      const parts = f.split("/");
      for (let i = 1; i < parts.length; i++) dirs.add(parts.slice(0, i).join("/"));
    }
    for (const d of dirs) {
      for (const name of IGNORE_FILES) {
        const p = d ? `${d}/${name}` : name;
        if (tree.has(p)) {
          const text = tree.read(p, 256 * 1024);
          if (text !== null) this.byDir.set(d, parseIgnore(text));
          break; // the CLI uses ONLY the first ignore file found in a directory
        }
      }
    }
  }

  private dirOrFileIgnored(path: string, isDir: boolean): boolean {
    let ignored = false;
    for (const r of this.defaults) if (r.re.test(path) && (!r.dirOnly || isDir)) ignored = !r.negate;
    const parts = path.split("/");
    for (const [base, rules] of [...this.byDir.entries()].sort((a, b) => a[0].length - b[0].length)) {
      if (base && !path.startsWith(base + "/")) continue;
      const rel = base ? path.slice(base.length + 1) : path;
      if (!rel) continue;
      for (const r of rules) if (r.re.test(rel) && (!r.dirOnly || isDir)) ignored = !r.negate;
    }
    void parts;
    return ignored;
  }

  /** a file is ignored if it, or any ancestor directory, is ignored (gitignore: a re-include cannot rescue a file inside an ignored directory) */
  isIgnored(file: string): boolean {
    const parts = file.split("/");
    for (let i = 1; i < parts.length; i++) if (this.dirOrFileIgnored(parts.slice(0, i).join("/"), true)) return true;
    return this.dirOrFileIgnored(file, false);
  }
}

// ---------------------------------------------------------------------------------------------------------------------
// deterministic tar writer (ustar)
// ---------------------------------------------------------------------------------------------------------------------
const oct = (n: number, len: number) => n.toString(8).padStart(len - 1, "0") + "\0";

function splitUstarName(name: string): { name: string; prefix: string } {
  const b = Buffer.byteLength(name);
  if (b <= 100) return { name, prefix: "" };
  // split at a '/' so that the name part is ≤ 100 and the prefix ≤ 155 bytes
  for (let i = name.indexOf("/"); i !== -1; i = name.indexOf("/", i + 1)) {
    const prefix = name.slice(0, i);
    const rest = name.slice(i + 1);
    if (Buffer.byteLength(prefix) <= 155 && Buffer.byteLength(rest) <= 100 && rest.length > 0) return { name: rest, prefix };
  }
  throw new ArtifactError("path_too_long", "path cannot be expressed in ustar");
}

export function tarEntry(path: string, data: Buffer, mode: number): Buffer {
  const { name, prefix } = splitUstarName(path);
  const h = Buffer.alloc(512);
  h.write(name, 0, 100, "utf8");
  h.write(oct(mode, 8), 100, 8, "ascii");
  h.write(oct(0, 8), 108, 8, "ascii"); // uid
  h.write(oct(0, 8), 116, 8, "ascii"); // gid
  h.write(oct(data.length, 12), 124, 12, "ascii");
  h.write(oct(0, 12), 136, 12, "ascii"); // mtime = 0 (deterministic)
  h.fill(0x20, 148, 156); // checksum placeholder
  h.write("0", 156, 1, "ascii"); // regular file
  h.write("ustar\0", 257, 6, "ascii");
  h.write("00", 263, 2, "ascii");
  h.write(prefix, 345, 155, "utf8");
  let sum = 0;
  for (const byte of h) sum += byte;
  h.write(sum.toString(8).padStart(6, "0") + "\0 ", 148, 8, "ascii");
  const pad = (512 - (data.length % 512)) % 512;
  return Buffer.concat([h, data, Buffer.alloc(pad)]);
}

/** gzip with a FIXED header (mtime 0, OS = unix) so the bytes do not depend on the platform or the clock */
export function deterministicGzip(buf: Buffer): Buffer {
  const out = Buffer.from(gzipSync(buf, { level: 9 }));
  out.writeUInt32LE(0, 4); // MTIME
  out[9] = 3; // OS: Unix
  return out;
}

export interface ArtifactResult {
  bytes: Buffer;
  sha256: string;
  size: number;
  fileCount: number;
  uncompressedBytes: number;
  format: string;
  /** files left out and why (counts only) */
  excluded: { byIgnoreRules: number; sensitiveNames: string[]; dependencyEntries: number };
  /** the packaged paths, sorted (NAMES only; used for review and tests) */
  paths: string[];
  warnings: string[];
}

export interface ArtifactOptions {
  deadlineMs?: number;
  now?: () => number;
}

/** Re-derivable from the same ZIP: identical input ⇒ identical bytes ⇒ identical digest. The ZIP itself is never persisted by this function. */
export async function buildDeploymentArtifact(zip: Buffer, opts: ArtifactOptions = {}): Promise<ArtifactResult> {
  const now = opts.now ?? Date.now;
  const deadline = now() + (opts.deadlineMs ?? 20_000);
  return withProject(
    zip,
    (tree: SourceTree, summary: ExtractionSummary) => {
      const ign = new Ignorer(tree);
      const all = tree.under("");
      const kept = all.filter((f) => !ign.isIgnored(f)).sort((a, b) => (Buffer.from(a) < Buffer.from(b) ? -1 : a === b ? 0 : 1));
      if (kept.length === 0) throw new ArtifactError("empty_after_ignore");
      const chunks: Buffer[] = [];
      let uncompressed = 0;
      const warnings: string[] = [];
      for (const f of kept) {
        if (now() > deadline) throw new ArtifactError("timeout");
        const data = tree.readBytes(f, MAX_ARTIFACT_FILE_BYTES);
        if (data === null) throw new ArtifactError("file_too_large", f.slice(0, 60));
        uncompressed += data.length;
        chunks.push(tarEntry(f, data, 0o644));
      }
      chunks.push(Buffer.alloc(1024)); // end-of-archive
      const tar = Buffer.concat(chunks);
      const padded = Buffer.concat([tar, Buffer.alloc((10240 - (tar.length % 10240)) % 10240)]); // GNU/node-tar record size
      const gz = deterministicGzip(padded);
      if (gz.length > MAX_ARTIFACT_BYTES) throw new ArtifactError("artifact_too_large");
      if (!kept.includes("package.json")) warnings.push("no_root_package_json_in_artifact");
      return {
        bytes: gz,
        sha256: createHash("sha256").update(gz).digest("hex"),
        size: gz.length,
        fileCount: kept.length,
        uncompressedBytes: uncompressed,
        format: ARTIFACT_FORMAT,
        excluded: { byIgnoreRules: all.length - kept.length, sensitiveNames: summary.sensitiveFiles, dependencyEntries: summary.skippedDependencyEntries },
        paths: kept,
        warnings,
      } satisfies ArtifactResult;
    },
    { skipSegments: CLI_DEFAULT_IGNORE_SEGMENTS },
  );
}

// ---------------------------------------------------------------------------------------------------------------------------------------------------------
// Phase 2D: the CLI backend packages a DIRECTORY itself (its tarball is not deterministic and cannot be hashed in advance), so what the approval binds is the exact
// FILE SET: every path with the SHA-256 of its bytes. It is derived from the same safe extraction and the same ignore rules as the REST artifact.
export interface SourceManifest {
  /** sha256 over the sorted `path \0 sha256 \n` lines — the digest the approval binds */
  digest: string;
  files: { path: string; sha256: string; size: number }[];
  uncompressedBytes: number;
}

/**
 * Computes the manifest of the approved source and, when `destDir` is given, writes EXACTLY those files into it (a private directory created by the caller, mode 0600
 * files). Sensitive files (`.env*`, keys, credentials), dependency trees and ignored files are never extracted, so the CLI cannot upload them.
 */
export async function materializeApprovedSource(zip: Buffer, destDir: string | null, opts: ArtifactOptions = {}): Promise<SourceManifest> {
  const now = opts.now ?? Date.now;
  const deadline = now() + (opts.deadlineMs ?? 20_000);
  return withProject(
    zip,
    (tree: SourceTree) => {
      const ign = new Ignorer(tree);
      const kept = tree.under("").filter((f) => !ign.isIgnored(f)).sort((a, b) => (Buffer.from(a) < Buffer.from(b) ? -1 : a === b ? 0 : 1));
      if (kept.length === 0) throw new ArtifactError("empty_after_ignore");
      const files: SourceManifest["files"] = [];
      let total = 0;
      const root = destDir === null ? null : nodePath.resolve(destDir);
      for (const f of kept) {
        if (now() > deadline) throw new ArtifactError("timeout");
        const data = tree.readBytes(f, MAX_ARTIFACT_FILE_BYTES);
        if (data === null) throw new ArtifactError("file_too_large", f.slice(0, 60));
        total += data.length;
        files.push({ path: f, sha256: createHash("sha256").update(data).digest("hex"), size: data.length });
        if (root !== null) {
          const target = nodePath.resolve(root, f);
          if (!target.startsWith(root + nodePath.sep)) throw new ArtifactError("unsafe_path", f.slice(0, 60));
          mkdirSync(nodePath.dirname(target), { recursive: true, mode: 0o700 });
          writeFileSync(target, data, { flag: "wx", mode: 0o600 });
        }
      }
      const digest = createHash("sha256").update(files.map((x) => `${x.path}\0${x.sha256}\n`).join("")).digest("hex");
      return { digest, files, uncompressedBytes: total } satisfies SourceManifest;
    },
    { skipSegments: CLI_DEFAULT_IGNORE_SEGMENTS },
  );
}
