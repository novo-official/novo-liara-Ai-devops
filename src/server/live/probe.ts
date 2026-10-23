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

export type ProbeOutcome = "ok" | "http_error" | "blocked_address" | "invalid_target" | "timeout" | "network" | "redirect" | "too_large" | "disabled" | "cancelled";
/** Safe, coarse reason of a probe that did not verify — never a message, address, certificate detail or header of the other side. */
export type ProbeFailure = "dns" | "tls" | "connection" | "timeout" | "cancelled" | "blocked_address" | "redirect" | "http_status" | "too_large" | "marker_mismatch" | "invalid_target" | "disabled";
export interface ProbeResult {
  outcome: ProbeOutcome;
  status: number | null;
  markerFound: boolean | null;
  /** null when the probe verified; otherwise the coarse category */
  failure?: ProbeFailure | null;
  /** wall-clock duration of this probe (ms) */
  durationMs?: number;
}

export function ipv4Blocked(a: number, b: number, c: number, d: number): boolean {
  void d;
  if (a === 0 || a === 10 || a === 127) return true;
  if (a === 100 && b >= 64 && b <= 127) return true; // CGNAT (also covers 100.100.100.200, a cloud metadata address)
  if (a === 169 && b === 254) return true; // link-local, incl. 169.254.169.254
  if (a === 172 && b >= 16 && b <= 31) return true;
  if (a === 192 && b === 168) return true;
  if (a === 192 && b === 0 && (c === 0 || c === 2)) return true; // IETF protocol assignments, TEST-NET-1
  if (a === 192 && b === 88 && c === 99) return true; // deprecated 6to4 relay anycast
  if (a === 198 && (b === 18 || b === 19)) return true;
  if (a === 198 && b === 51 && c === 100) return true;
  if (a === 203 && b === 0 && c === 113) return true;
  if (a >= 224) return true; // multicast + reserved + broadcast
  return false;
}

/** Parses an IPv6 text form (any notation: compressed, expanded, upper/lower case, leading zeros, embedded dotted IPv4) into 16 bytes; null if it is not a valid address. */
export function parseIPv6(input: string): number[] | null {
  let s = input.trim().toLowerCase();
  if (!s || s.includes("%")) return null; // zone ids are link-local scopes: the caller blocks them
  const dotted = /(\d{1,3}\.\d{1,3}\.\d{1,3}\.\d{1,3})$/.exec(s);
  if (dotted) {
    const o = dotted[1]!.split(".").map(Number);
    if (o.some((n) => n > 255)) return null;
    s = s.slice(0, s.length - dotted[1]!.length) + ((o[0]! << 8) | o[1]!).toString(16) + ":" + ((o[2]! << 8) | o[3]!).toString(16);
  }
  const halves = s.split("::");
  if (halves.length > 2) return null;
  const toGroups = (part: string) => (part === "" ? [] : part.split(":"));
  const head = toGroups(halves[0]!);
  const tail = halves.length === 2 ? toGroups(halves[1]!) : [];
  const all = [...head, ...tail];
  if (all.some((g) => !/^[0-9a-f]{1,4}$/.test(g))) return null;
  if (halves.length === 1 ? head.length !== 8 : head.length + tail.length > 7) return null;
  const groups = halves.length === 1 ? head : [...head, ...Array(8 - head.length - tail.length).fill("0"), ...tail];
  return groups.flatMap((g) => [parseInt(g, 16) >> 8, parseInt(g, 16) & 255]);
}

/**
 * true = must NOT be connected to. Anything that does not parse is blocked. IPv6 uses an ALLOWLIST of global unicast (2000::/3) minus every transition / documentation
 * / reserved block, after a real parse, so no textual trick (expanded, upper-case, embedded dotted IPv4, hex-pair IPv4, zone id) can bypass it:
 *  - ::/96 (IPv4-compatible, ::, ::1), ::ffff:0:0/96 (IPv4-mapped) and ::ffff:0:0:0/96 (SIIT) are checked/blocked through their embedded IPv4;
 *  - 64:ff9b::/96 and 64:ff9b:1::/48 (NAT64), 2001::/23 (IETF protocol assignments incl. Teredo 2001::/32), 2001:db8::/32 (documentation), 2002::/16 (6to4),
 *    3ffe::/16 (6bone), fc00::/7, fe80::/10, fec0::/10 (site-local), ff00::/8 and everything outside 2000::/3 are blocked.
 */
export function isBlockedAddress(ip: string): boolean {
  const v = isIP(ip);
  if (v === 4) {
    const p = ip.split(".").map(Number);
    return p.length !== 4 || p.some((n) => !Number.isInteger(n) || n < 0 || n > 255) || ipv4Blocked(p[0]!, p[1]!, p[2]!, p[3]!);
  }
  if (v === 6) {
    if (ip.includes("%")) return true; // scoped (link-local) address
    const b = parseIPv6(ip);
    if (!b) return true;
    const zero = (from: number, to: number) => b.slice(from, to).every((x) => x === 0);
    const embedded = () => ipv4Blocked(b[12]!, b[13]!, b[14]!, b[15]!);
    if (zero(0, 10) && b[10] === 255 && b[11] === 255) return embedded(); // ::ffff:a.b.c.d (IPv4-mapped, any notation)
    if (zero(0, 12)) return true; // ::/96: unspecified, loopback, IPv4-compatible (deprecated)
    if (zero(0, 8) && b[8] === 255 && b[9] === 255 && b[10] === 0 && b[11] === 0) return true; // SIIT ::ffff:0:a.b.c.d
    if ((b[0]! & 0xe0) !== 0x20) return true; // not global unicast (fc00::/7, fe80::/10, fec0::/10, ff00::/8, 100::/64, …)
    const g0 = (b[0]! << 8) | b[1]!;
    const g1 = (b[2]! << 8) | b[3]!;
    if (g0 === 0x2001 && g1 < 0x0200) return true; // 2001::/23: IETF protocol assignments, Teredo (2001::/32), ORCHID, …
    if (g0 === 0x2001 && g1 === 0x0db8) return true; // documentation
    if (g0 === 0x2002) return true; // 6to4
    if (g0 === 0x3ffe) return true; // 6bone (deprecated)
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
type LookupCb = (err: Error | null, address?: string | { address: string; family: number }[], family?: number) => void;

/**
 * The `lookup` handed to node:https. CONTRACT (Node ≥ 20, `autoSelectFamily` on by default — Node 24 here): the socket layer calls `lookup(host, { all: true, … })`
 * and REQUIRES an ARRAY of `{ address, family }`; only with `all` falsy does it take `(address, family)`. The first version always answered `(address, family)`, so
 * on Node 24 every probe died with ERR_INVALID_IP_ADDRESS before a byte was sent (outcome "network" ⇒ health "unknown" ⇒ a healthy app was never verified).
 * EVERY resolved address must pass the SSRF check, and exactly the validated addresses are handed back (optionally filtered by the requested family).
 */
export function makeGuardedLookup(resolve: LookupFn, blocked: (ip: string) => boolean = isBlockedAddress) {
  return (h: string, options: unknown, cb: LookupCb): void => {
    const opt = (options && typeof options === "object" ? options : {}) as { all?: boolean; family?: number | string };
    const want = opt.family === 4 || opt.family === "IPv4" ? 4 : opt.family === 6 || opt.family === "IPv6" ? 6 : 0;
    resolve(h).then(
      (addrs) => {
        if (addrs.length === 0 || addrs.some(blocked)) return cb(Object.assign(new Error("blocked address"), { code: "ESSRF" }));
        const usable = addrs.filter((a) => !want || isIP(a) === want);
        if (usable.length === 0) return cb(Object.assign(new Error("no address of the requested family"), { code: "EDNS" }));
        if (opt.all) return cb(null, usable.map((a) => ({ address: a, family: isIP(a) })));
        cb(null, usable[0]!, isIP(usable[0]!));
      },
      () => cb(Object.assign(new Error("dns"), { code: "EDNS" })),
    );
  };
}
export type RequestFn = (opts: { host: string; path: string; timeoutMs: number; signal?: AbortSignal; lookup: (host: string, options: unknown, cb: LookupCb) => void }) => Promise<{ status: number; body: Buffer; tooLarge: boolean } | { error: "timeout" | "network" | "blocked" | "cancelled"; detail?: "dns" | "tls" | "connection" }>;

export interface ProbeOptions {
  appName: string;
  suffixes: readonly string[];
  path: string;
  marker?: string;
  /** TOTAL deadline of the probe (connect + TLS + response), not an idle timeout; default 8 s */
  timeoutMs?: number;
  /** aborting stops the probe at once (outcome "cancelled") */
  signal?: AbortSignal;
  /** test seams (clock for durationMs) */
  now?: () => number;
  /** test seams (defaults use the real resolver and node:https) */
  resolve?: LookupFn;
  request?: RequestFn;
}

const defaultResolve: LookupFn = (host) =>
  new Promise((res, rej) => dnsLookup(host, { all: true, verbatim: true }, (err, addrs) => (err ? rej(err) : res(addrs.map((a) => a.address)))));

/** Maps a socket/TLS error CODE to a coarse category. Only the code is looked at; nothing of the error text is kept. */
export function classifyRequestError(code: string | undefined): { error: "network" | "blocked"; detail?: "dns" | "tls" | "connection" } {
  const c = code ?? "";
  if (c === "ESSRF") return { error: "blocked" };
  if (c === "EDNS" || c === "ENOTFOUND" || c === "EAI_AGAIN" || c === "EAI_FAIL" || c === "ENODATA") return { error: "network", detail: "dns" };
  if (c.startsWith("ERR_TLS") || c.startsWith("ERR_SSL") || c.startsWith("ERR_OSSL") || c.includes("CERT") || c === "UNABLE_TO_VERIFY_LEAF_SIGNATURE" || c === "DEPTH_ZERO_SELF_SIGNED_CERT" || c === "SELF_SIGNED_CERT_IN_CHAIN" || c === "HOSTNAME_MISMATCH") return { error: "network", detail: "tls" };
  return { error: "network", detail: "connection" };
}

const defaultRequest: RequestFn = (o) =>
  new Promise((resolve) => {
    let settled = false;
    const finish = (v: Parameters<typeof resolve>[0]) => {
      if (settled) return;
      settled = true;
      clearTimeout(deadline);
      o.signal?.removeEventListener("abort", onAbort);
      resolve(v);
    };
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
        // a response that was cut off (reset / closed before its end) is a network failure, never a partial "answer" that could pass as healthy
        const done = () => (tooLarge || res.complete ? finish({ status: res.statusCode ?? 0, body: Buffer.concat(chunks), tooLarge }) : finish({ error: "network", detail: "connection" }));
        res.on("end", done);
        res.on("close", done);
        res.on("error", () => finish({ error: "network", detail: "connection" }));
      },
    );
    // a TOTAL deadline: the socket's idle timeout alone would let a slow-drip answer run on for ever
    const deadline = setTimeout(() => {
      req.destroy();
      finish({ error: "timeout" });
    }, o.timeoutMs);
    const onAbort = () => {
      req.destroy();
      finish({ error: "cancelled" });
    };
    if (o.signal?.aborted) return onAbort();
    o.signal?.addEventListener("abort", onAbort, { once: true });
    req.on("timeout", () => {
      req.destroy();
      finish({ error: "timeout" });
    });
    req.on("error", (e) => finish(classifyRequestError((e as { code?: string }).code)));
    req.end();
  });

export async function safeProbe(o: ProbeOptions): Promise<ProbeResult> {
  const now = o.now ?? Date.now;
  const started = now();
  const done = (r: ProbeResult): ProbeResult => ({ ...r, durationMs: Math.max(0, Math.round(now() - started)) });
  if (o.suffixes.length === 0) return done({ outcome: "disabled", status: null, markerFound: null, failure: "disabled" });
  const host = buildProbeHost(o.appName, o.suffixes);
  if (!host || !PATH_RE.test(o.path) || o.path.includes("..") || o.path.includes("//")) return done({ outcome: "invalid_target", status: null, markerFound: null, failure: "invalid_target" });
  if (o.signal?.aborted) return done({ outcome: "cancelled", status: null, markerFound: null, failure: "cancelled" });
  const resolve = o.resolve ?? defaultResolve;
  const request = o.request ?? defaultRequest;
  // connect-time validation: the address used for the socket is the one validated here
  const guarded = makeGuardedLookup(resolve);
  const r = await request({ host, path: o.path, timeoutMs: o.timeoutMs ?? 8000, signal: o.signal, lookup: guarded });
  if ("error" in r) {
    if (r.error === "blocked") return done({ outcome: "blocked_address", status: null, markerFound: null, failure: "blocked_address" });
    if (r.error === "cancelled") return done({ outcome: "cancelled", status: null, markerFound: null, failure: "cancelled" });
    if (r.error === "timeout") return done({ outcome: "timeout", status: null, markerFound: null, failure: "timeout" });
    return done({ outcome: "network", status: null, markerFound: null, failure: r.detail ?? "connection" });
  }
  if (r.status >= 300 && r.status < 400) return done({ outcome: "redirect", status: r.status, markerFound: null, failure: "redirect" });
  if (r.tooLarge) return done({ outcome: "too_large", status: r.status, markerFound: null, failure: "too_large" });
  if (r.status < 200 || r.status >= 300) return done({ outcome: "http_error", status: r.status, markerFound: null, failure: "http_status" });
  const markerFound = o.marker ? r.body.toString("utf8").includes(o.marker) : null;
  return done({ outcome: "ok", status: r.status, markerFound, failure: markerFound === false ? "marker_mismatch" : null });
}
