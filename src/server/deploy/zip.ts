import { inflateRawSync } from "node:zlib";
import { SKIPPED_DIRS, UPLOAD_LIMITS } from "./limits";

/**
 * Minimal, defensive ZIP reader. It never executes anything and never writes to disk: it only parses the central directory,
 * validates every entry against the limits, and (separately) inflates SELECTED entries with a hard output cap.
 * Unsupported on purpose: encryption, ZIP64, multi-disk archives, compression methods other than stored/deflate.
 */

export type ZipErrorCode =
  | "not_a_zip"
  | "too_large"
  | "too_many_entries"
  | "uncompressed_too_large"
  | "file_too_large"
  | "ratio_exceeded"
  | "unsafe_path"
  | "symlink_or_special"
  | "duplicate_entry"
  | "encrypted"
  | "unsupported_zip"
  | "corrupt"
  | "size_mismatch";

export class ZipError extends Error {
  override readonly name = "ZipError";
  constructor(public readonly code: ZipErrorCode, public readonly detail?: string) {
    super(code);
  }
}
export const isZipError = (e: unknown): e is ZipError => e instanceof ZipError || (typeof e === "object" && e !== null && (e as { name?: unknown }).name === "ZipError" && typeof (e as { code?: unknown }).code === "string");

export interface ZipEntry {
  /** normalised, validated, forward-slash relative path (no leading slash, no ".." segments) */
  path: string;
  isDir: boolean;
  method: 0 | 8;
  compressedSize: number;
  size: number;
  crc: number;
  /** offset of the local file header */
  offset: number;
}

const EOCD = 0x06054b50;
const CEN = 0x02014b50;
const LOC = 0x04034b50;
const S_IFMT = 0xf000;
const S_IFREG = 0x8000;
const S_IFDIR = 0x4000;

const CRC_TABLE = (() => {
  const t = new Uint32Array(256);
  for (let n = 0; n < 256; n++) {
    let c = n;
    for (let k = 0; k < 8; k++) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1;
    t[n] = c >>> 0;
  }
  return t;
})();
export function crc32(buf: Uint8Array): number {
  let c = 0xffffffff;
  for (let i = 0; i < buf.length; i++) c = CRC_TABLE[(c ^ buf[i]!) & 0xff]! ^ (c >>> 8);
  return (c ^ 0xffffffff) >>> 0;
}

/** Validates a name and returns the normalised path; throws `unsafe_path` for anything that could escape or confuse. */
export function safeEntryPath(raw: string): string {
  if (raw.length === 0 || raw.length > UPLOAD_LIMITS.maxPathLength) throw new ZipError("unsafe_path", "length");
  if (/[\u0000-\u001f\u007f]/.test(raw)) throw new ZipError("unsafe_path", "control");
  if (raw.includes("\\")) throw new ZipError("unsafe_path", "backslash");
  if (raw.startsWith("/") || /^[A-Za-z]:/.test(raw)) throw new ZipError("unsafe_path", "absolute");
  if (/[‪-‮⁦-⁩​-‏﻿]/.test(raw)) throw new ZipError("unsafe_path", "bidi");
  const noTrail = raw.endsWith("/") ? raw.slice(0, -1) : raw;
  const parts = noTrail.split("/");
  if (parts.length > UPLOAD_LIMITS.maxPathDepth) throw new ZipError("unsafe_path", "depth");
  for (const p of parts) {
    if (p === "" || p === "." || p === "..") throw new ZipError("unsafe_path", "segment");
    if (/[. ]$/.test(p)) throw new ZipError("unsafe_path", "trailing"); // Windows normalisation tricks
    if (/^(con|prn|aux|nul|com[1-9]|lpt[1-9])(\..*)?$/i.test(p)) throw new ZipError("unsafe_path", "device");
  }
  return parts.join("/");
}

export function readZipDirectory(buf: Buffer): ZipEntry[] {
  if (buf.length > UPLOAD_LIMITS.maxArchiveBytes) throw new ZipError("too_large");
  if (buf.length < 22 || buf.readUInt32LE(0) !== LOC) {
    // an empty archive starts with the EOCD record; anything else is not a ZIP
    if (!(buf.length >= 22 && buf.readUInt32LE(0) === EOCD)) throw new ZipError("not_a_zip");
  }
  // locate the end-of-central-directory record (search the last 64 KiB + 22)
  let eocd = -1;
  for (let i = buf.length - 22; i >= Math.max(0, buf.length - 22 - 0xffff); i--) {
    if (buf.readUInt32LE(i) === EOCD) {
      eocd = i;
      break;
    }
  }
  if (eocd < 0) throw new ZipError("not_a_zip");
  const diskNo = buf.readUInt16LE(eocd + 4);
  const cdDisk = buf.readUInt16LE(eocd + 6);
  const entriesOnDisk = buf.readUInt16LE(eocd + 8);
  const total = buf.readUInt16LE(eocd + 10);
  const cdSize = buf.readUInt32LE(eocd + 12);
  const cdOffset = buf.readUInt32LE(eocd + 16);
  if (diskNo !== 0 || cdDisk !== 0 || entriesOnDisk !== total) throw new ZipError("unsupported_zip", "multi-disk");
  if (total === 0xffff || cdSize === 0xffffffff || cdOffset === 0xffffffff) throw new ZipError("unsupported_zip", "zip64");
  if (total > UPLOAD_LIMITS.maxEntries) throw new ZipError("too_many_entries");
  if (cdOffset + cdSize > eocd) throw new ZipError("corrupt", "central directory bounds");

  const entries: ZipEntry[] = [];
  const seen = new Set<string>();
  let pos = cdOffset;
  let sumSize = 0;
  let sumCompressed = 0;
  for (let n = 0; n < total; n++) {
    if (pos + 46 > eocd || buf.readUInt32LE(pos) !== CEN) throw new ZipError("corrupt", "central header");
    const versionMadeBy = buf.readUInt16LE(pos + 4);
    const flags = buf.readUInt16LE(pos + 8);
    const method = buf.readUInt16LE(pos + 10);
    const crc = buf.readUInt32LE(pos + 16);
    const compressedSize = buf.readUInt32LE(pos + 20);
    const size = buf.readUInt32LE(pos + 24);
    const nameLen = buf.readUInt16LE(pos + 28);
    const extraLen = buf.readUInt16LE(pos + 30);
    const commentLen = buf.readUInt16LE(pos + 32);
    const diskStart = buf.readUInt16LE(pos + 34);
    const externalAttrs = buf.readUInt32LE(pos + 38);
    const offset = buf.readUInt32LE(pos + 42);
    if (pos + 46 + nameLen + extraLen + commentLen > eocd) throw new ZipError("corrupt", "central header bounds");
    if (flags & 0x1 || flags & 0x40) throw new ZipError("encrypted");
    if (diskStart !== 0) throw new ZipError("unsupported_zip", "multi-disk");
    if (compressedSize === 0xffffffff || size === 0xffffffff || offset === 0xffffffff) throw new ZipError("unsupported_zip", "zip64");
    const rawName = buf.subarray(pos + 46, pos + 46 + nameLen).toString(flags & 0x800 ? "utf8" : "latin1");
    pos += 46 + nameLen + extraLen + commentLen;

    // type from the unix mode when the archive was made on a unix host (host byte 3); otherwise from the DOS directory bit
    const hostUnix = versionMadeBy >>> 8 === 3;
    const mode = externalAttrs >>> 16;
    const dosDir = (externalAttrs & 0x10) !== 0 || rawName.endsWith("/");
    let isDir = dosDir;
    if (hostUnix && mode !== 0) {
      const t = mode & S_IFMT;
      if (t === S_IFDIR) isDir = true;
      else if (t !== S_IFREG && t !== 0) throw new ZipError("symlink_or_special", rawName.slice(0, 40)); // symlink, fifo, device, socket
    }
    if ((externalAttrs & 0x400) !== 0 && !hostUnix) throw new ZipError("symlink_or_special", "reparse point");
    if (method !== 0 && method !== 8) throw new ZipError("unsupported_zip", `method ${method}`);

    const path = safeEntryPath(rawName);
    const key = path.toLowerCase();
    if (seen.has(key)) throw new ZipError("duplicate_entry", path.slice(0, 40));
    seen.add(key);

    if (!isDir) {
      if (size > UPLOAD_LIMITS.maxFileBytes && !isSkippable(path)) throw new ZipError("file_too_large", path.slice(0, 40));
      if (compressedSize > 0 && size / compressedSize > UPLOAD_LIMITS.maxEntryRatio && size > 1024 * 1024) throw new ZipError("ratio_exceeded", path.slice(0, 40));
      if (compressedSize === 0 && size > 0 && method === 8) throw new ZipError("corrupt", "size");
    }
    sumSize += size;
    sumCompressed += compressedSize;
    if (sumSize > UPLOAD_LIMITS.maxTotalUncompressedBytes) throw new ZipError("uncompressed_too_large");
    entries.push({ path, isDir, method: method as 0 | 8, compressedSize, size, crc, offset });
  }
  if (sumSize > 4 * 1024 * 1024 && sumCompressed > 0 && sumSize / sumCompressed > UPLOAD_LIMITS.maxTotalRatio) throw new ZipError("ratio_exceeded", "total");
  return entries;
}

// large dependency/VCS entries are skipped (never inflated), so the per-file cap only matters for entries we would extract
function isSkippable(path: string): boolean {
  return path.split("/").some((s) => (SKIPPED_DIRS as readonly string[]).includes(s));
}

/** Inflates ONE entry with a hard output cap, verifying the declared size and CRC (lying headers are rejected). */
export function readEntry(buf: Buffer, e: ZipEntry): Buffer {
  if (e.isDir) return Buffer.alloc(0);
  if (e.offset + 30 > buf.length || buf.readUInt32LE(e.offset) !== LOC) throw new ZipError("corrupt", "local header");
  const flags = buf.readUInt16LE(e.offset + 6);
  if (flags & 0x1) throw new ZipError("encrypted");
  const nameLen = buf.readUInt16LE(e.offset + 26);
  const extraLen = buf.readUInt16LE(e.offset + 28);
  const start = e.offset + 30 + nameLen + extraLen;
  const end = start + e.compressedSize;
  if (end > buf.length) throw new ZipError("corrupt", "entry bounds");
  const data = buf.subarray(start, end);
  let out: Buffer;
  if (e.method === 0) {
    if (data.length !== e.size) throw new ZipError("size_mismatch", e.path.slice(0, 40));
    out = Buffer.from(data);
  } else {
    try {
      // maxOutputLength is the real defence: a header that lies about the size cannot make us allocate more
      out = inflateRawSync(data, { maxOutputLength: Math.min(e.size, UPLOAD_LIMITS.maxFileBytes) + 1 });
    } catch (err) {
      if ((err as { code?: string }).code === "ERR_BUFFER_TOO_LARGE") throw new ZipError("size_mismatch", e.path.slice(0, 40));
      throw new ZipError("corrupt", "inflate");
    }
    if (out.length !== e.size) throw new ZipError("size_mismatch", e.path.slice(0, 40));
  }
  if (crc32(out) !== e.crc) throw new ZipError("corrupt", "crc");
  return out;
}
