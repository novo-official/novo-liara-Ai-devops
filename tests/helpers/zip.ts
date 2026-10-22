import { deflateRawSync } from "node:zlib";
import { crc32 } from "@/server/deploy/zip";

/** Test-only ZIP WRITER (the production code only reads ZIPs). Supports deliberately malformed archives. */
export interface ZipSpec {
  name: string;
  data?: Buffer | string;
  dir?: boolean;
  /** unix file mode (default 0o100644 file / 0o040755 dir); use 0o120777 for a symlink */
  mode?: number;
  method?: 0 | 8;
  /** header lies */
  lieSize?: number;
  lieCompressed?: number;
  lieCrc?: number;
  encrypted?: boolean;
  /** write DOS-style attributes (no unix mode) */
  dos?: boolean;
}

export function buildZip(specs: ZipSpec[], opts: { commentTail?: number } = {}): Buffer {
  const locals: Buffer[] = [];
  const centrals: Buffer[] = [];
  let offset = 0;
  for (const s of specs) {
    const name = Buffer.from(s.name + (s.dir && !s.name.endsWith("/") ? "/" : ""), "utf8");
    const raw = s.dir ? Buffer.alloc(0) : Buffer.isBuffer(s.data) ? s.data : Buffer.from(s.data ?? "", "utf8");
    const method = s.method ?? (raw.length > 0 ? 8 : 0);
    const comp = method === 8 ? deflateRawSync(raw) : raw;
    const crc = s.lieCrc ?? crc32(raw);
    const flags = 0x800 | (s.encrypted ? 1 : 0);
    const size = s.lieSize ?? raw.length;
    const csize = s.lieCompressed ?? comp.length;
    const lh = Buffer.alloc(30);
    lh.writeUInt32LE(0x04034b50, 0);
    lh.writeUInt16LE(20, 4);
    lh.writeUInt16LE(flags, 6);
    lh.writeUInt16LE(method, 8);
    lh.writeUInt32LE(crc, 14);
    lh.writeUInt32LE(csize, 18);
    lh.writeUInt32LE(size, 22);
    lh.writeUInt16LE(name.length, 26);
    locals.push(lh, name, comp);
    const mode = s.mode ?? (s.dir ? 0o040755 : 0o100644);
    const ch = Buffer.alloc(46);
    ch.writeUInt32LE(0x02014b50, 0);
    ch.writeUInt16LE(s.dos ? 20 : (3 << 8) | 20, 4);
    ch.writeUInt16LE(20, 6);
    ch.writeUInt16LE(flags, 8);
    ch.writeUInt16LE(method, 10);
    ch.writeUInt32LE(crc, 16);
    ch.writeUInt32LE(csize, 20);
    ch.writeUInt32LE(size, 24);
    ch.writeUInt16LE(name.length, 28);
    ch.writeUInt32LE(s.dos ? (s.dir ? 0x10 : 0) : (mode << 16) >>> 0, 38);
    ch.writeUInt32LE(offset, 42);
    centrals.push(ch, name);
    offset += 30 + name.length + comp.length;
  }
  const cd = Buffer.concat(centrals);
  const eocd = Buffer.alloc(22);
  eocd.writeUInt32LE(0x06054b50, 0);
  eocd.writeUInt16LE(specs.length, 8);
  eocd.writeUInt16LE(specs.length, 10);
  eocd.writeUInt32LE(cd.length, 12);
  eocd.writeUInt32LE(offset, 16);
  return Buffer.concat([...locals, cd, eocd, Buffer.alloc(opts.commentTail ?? 0)]);
}
