import "server-only";
import { lookup as dnsLookup } from "node:dns";
import { request as httpsRequest } from "node:https";
import { isIP } from "node:net";
import { APP_NAME_REGEX } from "../config/env";

/**
 * SSRF-SAFE EXTERNAL PROBE. The ONLY place in the project that opens a connection to a user-reachable application host.
 *  - the URL is never supplied by a caller: it is `https://<validated app name>.<operator-configured suffix>` (+ a validated path)
 *  - https only (port 443), GET only, NO redirect is ever followed (a 3xx is a result, not a hop)
 *  - the address that is connected to is validated AT CONNECT TIME inside `lookup` (closes DNS-rebinding); loopback, private, link-local, CGNAT,
 *    multicast, reserved, unspecified and cloud-metadata addresses are refused for IPv4, IPv6 and IPv4-mapped IPv6
 *  - bounded: connect/read timeout, response size cap (4 KiB inspected), no cookies, no credentials, no custom headers from callers
 * Disabled until the operator configures `LIARA_APP_DOMAIN_SUFFIXES` (the default domain pattern is documented but unverified for this account).
 */

export type ProbeOutcome = "ok" | "http_error" | "blocked_address" | "invalid_target" | "timeout" | "network" | "redirect" | "too_large" | "disabled";
export interface ProbeResult {
  outcome: ProbeOutcome;
  status: number | null;
  markerFound: boolean | null;
}

export function ipv4Blocked(a: number, b: number, c: number, d: number): boolean {
  void c;
  if (a === 0 || a === 10 || a === 127) return true;
  if (a === 100 && b >= 64 && b <= 127) return true; // CGNAT (also covers 100.100.100.200, a cloud metadata address)
  if (a === 169 && b === 254) return true; // link-local, incl. 169.254.169.254
  if (a === 172 && b >= 16 && b <= 31) return true;
  if (a === 192 && b === 168) return true;
  if (a === 192 && b === 0 && (c === 0 || c === 2)) return true;
  if (a === 198 && (b === 18 || b === 19)) return true;
  if (a === 198 && b === 51 && c === 100) return true;
  if (a === 203 && b === 0 && c === 113) return true;
  if (a >= 224) return true; // multicast + reserved + broadcast
  void d;
  return false;
}

/** true = must NOT be connected to. Anything that does not parse is blocked. */
export function isBlockedAddress(ip: string): boolean {
  const v = isIP(ip);
  if (v === 4) {
    const p = ip.split(".").map(Number);
    return p.length !== 4 || p.some((n) => !Number.isInteger(n) || n < 0 || n > 255) || ipv4Blocked(p[0]!, p[1]!, p[2]!, p[3]!);
  }
  if (v === 6) {
    const s = ip.toLowerCase().split("%")[0]!;
    if (s === "::" || s === "::1") return true;
    const mapped = /^::ffff:(\d+\.\d+\.\d+\.\d+)$/.exec(s) ?? /^0:0:0:0:0:ffff:(\d+\.\d+\.\d+\.\d+)$/.exec(s);
    if (mapped) return isBlockedAddress(mapped[1]!);
    const mappedHex = /^::ffff:([0-9a-f]{1,4}):([0-9a-f]{1,4})$/.exec(s);
    if (mappedHex) {
      const hi = parseInt(mappedHex[1]!, 16);
      const lo = parseInt(mappedHex[2]!, 16);
      return ipv4Blocked(hi >> 8, hi & 255, lo >> 8, lo & 255);
    }
    const first = parseInt(s.split(":")[0] || "0", 16);
    if ((first & 0xfe00) === 0xfc00) return true; // fc00::/7 unique local (incl. fd00:ec2::254 metadata)
    if ((first & 0xffc0) === 0xfe80) return true; // fe80::/10 link-local
    if ((first & 0xff00) === 0xff00) return true; // multicast
    if (s.startsWith("64:ff9b:") || s.startsWith("2001:db8") || s.startsWith("100::")) return true; // NAT64, documentation, discard
    return false;
  }
  return true;
}

export function buildProbeHost(appName: string, suffixes: readonly string[]): string | null {
  if (!APP_NAME_REGEX.test(appName) || suffixes.length === 0) return null;
  const host = `${appName}.${suffixes[0]!}`;
  return /^[a-z0-9-]+(\.[a-z0-9-]+)+$/.test(host) && host.length <= 253 ? host : null;
}
const PATH_RE = /^\/[A-Za-z0-9._~\-/]{0,100}$/;

export type LookupFn = (host: string) => Promise<string[]>;
export type RequestFn = (opts: { host: string; path: string; timeoutMs: number; lookup: (host: string, options: unknown, cb: (err: Error | null, address?: string, family?: number) => void) => void }) => Promise<{ status: number; body: Buffer; tooLarge: boolean } | { error: "timeout" | "network" | "blocked" }>;

export interface ProbeOptions {
  appName: string;
  suffixes: readonly string[];
  path: string;
  marker?: string;
  timeoutMs?: number;
  /** test seams (defaults use the real resolver and node:https) */
  resolve?: LookupFn;
  request?: RequestFn;
}

const defaultResolve: LookupFn = (host) =>
  new Promise((res, rej) => dnsLookup(host, { all: true, verbatim: true }, (err, addrs) => (err ? rej(err) : res(addrs.map((a) => a.address)))));

const defaultRequest: RequestFn = (o) =>
  new Promise((resolve) => {
    const req = httpsRequest(
      { host: o.host, port: 443, path: o.path, method: "GET", agent: false, timeout: o.timeoutMs, headers: { "User-Agent": "liara-devops-agent/0.1 (verify)", Accept: "*/*", Connection: "close" }, lookup: o.lookup as never },
      (res) => {
        const chunks: Buffer[] = [];
        let total = 0;
        let tooLarge = false;
        res.on("data", (c: Buffer) => {
          total += c.length;
          if (total > 4096) {
            tooLarge = true;
            res.destroy();
            return;
          }
          chunks.push(c);
        });
        const done = () => resolve({ status: res.statusCode ?? 0, body: Buffer.concat(chunks), tooLarge });
        res.on("end", done);
        res.on("close", done);
        res.on("error", () => resolve({ error: "network" }));
      },
    );
    req.on("timeout", () => {
      req.destroy();
      resolve({ error: "timeout" });
    });
    req.on("error", (e) => resolve({ error: (e as { code?: string }).code === "ESSRF" ? "blocked" : "network" }));
    req.end();
  });

export async function safeProbe(o: ProbeOptions): Promise<ProbeResult> {
  if (o.suffixes.length === 0) return { outcome: "disabled", status: null, markerFound: null };
  const host = buildProbeHost(o.appName, o.suffixes);
  if (!host || !PATH_RE.test(o.path) || o.path.includes("..") || o.path.includes("//")) return { outcome: "invalid_target", status: null, markerFound: null };
  const resolve = o.resolve ?? defaultResolve;
  const request = o.request ?? defaultRequest;
  // connect-time validation: the address used for the socket is the one validated here
  const guarded = (h: string, _options: unknown, cb: (err: Error | null, address?: string, family?: number) => void) => {
    resolve(h).then(
      (addrs) => {
        if (addrs.length === 0 || addrs.some(isBlockedAddress)) return cb(Object.assign(new Error("blocked address"), { code: "ESSRF" }));
        cb(null, addrs[0]!, isIP(addrs[0]!));
      },
      () => cb(Object.assign(new Error("dns"), { code: "EDNS" })),
    );
  };
  const r = await request({ host, path: o.path, timeoutMs: o.timeoutMs ?? 8000, lookup: guarded });
  if ("error" in r) return { outcome: r.error === "blocked" ? "blocked_address" : r.error, status: null, markerFound: null };
  if (r.status >= 300 && r.status < 400) return { outcome: "redirect", status: r.status, markerFound: null };
  if (r.tooLarge) return { outcome: "too_large", status: r.status, markerFound: null };
  if (r.status < 200 || r.status >= 300) return { outcome: "http_error", status: r.status, markerFound: null };
  return { outcome: "ok", status: r.status, markerFound: o.marker ? r.body.toString("utf8").includes(o.marker) : null };
}
