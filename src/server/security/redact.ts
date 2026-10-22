import { Pseudonymizer } from "./pseudonym";
import { isRegisteredSecret } from "./secret";

/**
 * Redaction for any text that originates outside our trust boundary (logs, events, release
 * messages, URLs, error strings). Lossy and fail-closed by design — see SECURITY_POLICY §3.
 */

export const REDACTED = "[REDACTED]";
const defaultPseudo = new Pseudonymizer();

const ANSI = /\u001b\[[0-9;?]*[ -/]*[@-~]|\u001b\][^\u0007\u001b]*(?:\u0007|\u001b\\)/g;
const CONTROL = /[\u0000-\u0008\u000b\u000c\u000e-\u001f\u007f-\u009f‎‏‪-‮⁦-⁩]/g;

const SENSITIVE_KEY =
  "(?:pass(?:word|wd|phrase)?|pwd|secret|token|api[_-]?key|apikey|private[_-]?key|credential|authorization|auth|cookie|session(?:id)?|access[_-]?key|signature|bearer|dsn|connection[_-]?string)";

const PATTERNS: Array<[RegExp, string | ((...m: string[]) => string)]> = [
  // PEM blocks (also unterminated ones, which are common in truncated logs)
  [/-----BEGIN [A-Z0-9 ]*PRIVATE KEY-----[\s\S]*?(?:-----END [A-Z0-9 ]*PRIVATE KEY-----|$)/g, REDACTED],
  // scheme://user:pass@host, scheme://:pass@host (redis), scheme://token@host
  [/\b([a-z][a-z0-9+.-]*:\/\/)[^\s/:@]*:[^\s/@]+@/gi, `$1${REDACTED}@`],
  [/\b([a-z][a-z0-9+.-]*:\/\/)[^\s/:@[\]]+@/gi, `$1${REDACTED}@`],
  // Cookie / Set-Cookie headers: mask the whole header value (several name=value pairs)
  [/\b((?:set-)?cookie\s*:\s*)[^\r\n]+/gi, `$1${REDACTED}`],
  // sensitive query-string parameters that are not caught by the generic key rule
  [/([?&](?:sig|key|sas|sid|jwt|ticket|auth|session|code|state|signature)=)[^&\s"'#]+/gi, `$1${REDACTED}`],
  // JWT-shaped
  [/\beyJ[A-Za-z0-9_-]{6,}\.[A-Za-z0-9_-]{6,}\.[A-Za-z0-9_-]{3,}/g, REDACTED],
  // Authorization: Basic xxx / Bearer xxx / Token xxx
  [/\b(authorization\s*[:=]\s*)(?:(?:bearer|basic|token)\s+)?[^\s,;"']+/gi, `$1${REDACTED}`],
  [/\b(bearer|basic)\s+[A-Za-z0-9._~+/=-]{8,}/gi, `$1 ${REDACTED}`],
  // key=value / "key": "value" with sensitive key names
  [
    new RegExp(`((?<![\\w.-])["']?[\\w.-]*${SENSITIVE_KEY}[\\w.-]*["']?\\s*[:=]\\s*)(?!"?\\[REDACTED)("[^"]*"|'[^']*'|[^\\s,;&"'}\\]]+)`, "gi"),
    (_m, k) => `${k}"${REDACTED}"`,
  ],
  // Well-known vendor formats
  [/\bAKIA[0-9A-Z]{16}\b/g, REDACTED],
  [/\bgh[pousr]_[A-Za-z0-9]{30,}\b/g, REDACTED],
  [/\bgithub_pat_[A-Za-z0-9_]{30,}\b/g, REDACTED],
  [/\bglpat-[A-Za-z0-9_-]{16,}\b/g, REDACTED],
  [/\bxox[abprs]-[A-Za-z0-9-]{10,}\b/g, REDACTED],
  [/\bsk-[A-Za-z0-9_-]{20,}\b/g, REDACTED],
  [/\bAIza[0-9A-Za-z_-]{35}\b/g, REDACTED],
  [/\bnpm_[A-Za-z0-9]{36}\b/g, REDACTED],
  // Long hex (>=64: sha256 etc.; 40-char git SHAs are deliberately preserved)
  [/\b[A-Fa-f0-9]{64,}\b/g, REDACTED],
  // Long mixed-case alphanumeric blobs (likely keys)
  [/\b(?=[A-Za-z0-9+_-]{40,}\b)(?=[^\s]*[A-Z])(?=[^\s]*[a-z])(?=[^\s]*\d)[A-Za-z0-9+_-]{40,}\b/g, REDACTED],
  // E-mail addresses (PII)
  [/\b[A-Za-z0-9._%+-]+@[A-Za-z0-9.-]+\.[A-Za-z]{2,}\b/g, "[REDACTED:EMAIL]"],
];

const TOKEN_SPLIT = /([\s"'`=:,;(){}[\]<>|&?]+)/;

export interface RedactOptions {
  maxLength?: number;
  /**
   * "Shareable" output (fixtures, verification reports): additionally pseudonymises hostnames, private/public IPs
   * and local user paths, keeping the diagnostic shape (e.g. `postgres://[REDACTED]@host-1:5432/shop`).
   */
  shareable?: boolean;
  pseudo?: Pseudonymizer;
}

const URL_HOST = /\b([a-z][a-z0-9+.-]*:\/\/(?:[^\s/@]*@)?)([^\s/:?#@[\]]+)/gi;
const INTERNAL_HOST = /\b[a-z0-9][a-z0-9-]*(?:\.[a-z0-9-]+)*\.(?:internal|local|svc|lan|corp|intranet|cluster\.local)\b/gi;
const IPV4 = /\b(?:(?:25[0-5]|2[0-4]\d|1?\d?\d)\.){3}(?:25[0-5]|2[0-4]\d|1?\d?\d)\b/g;
const HOME_PATH = /(\/(?:home|Users)\/)[^/\s:]+|([A-Za-z]:\\Users\\)[^\\\s:]+/g;

function isPrivateIp(ip: string): boolean {
  const [a, b] = ip.split(".").map(Number) as [number, number];
  return a === 10 || a === 127 || (a === 172 && b >= 16 && b <= 31) || (a === 192 && b === 168) || (a === 169 && b === 254) || a === 0;
}

function shareableTransform(s: string, pseudo: Pseudonymizer): string {
  return s
    .replace(URL_HOST, (_m, pre: string, host: string) => (host.startsWith("[") ? _m : `${pre}${pseudo.name("host", host.toLowerCase())}`))
    .replace(INTERNAL_HOST, (h) => pseudo.name("host", h.toLowerCase()))
    .replace(IPV4, (ip) => (isPrivateIp(ip) ? "[PRIVATE_IP]" : "[IP]"))
    .replace(HOME_PATH, (_m, a: string | undefined, b: string | undefined) => `${a ?? b}[user]`);
}

export function stripUnsafeChars(s: string): string {
  return s.replace(ANSI, "").replace(CONTROL, "");
}

export function redactText(input: unknown, opts: RedactOptions = {}): string {
  if (typeof input !== "string") return "";
  let s = stripUnsafeChars(input);
  // Bound work on pathological inputs before running regexes.
  const hardCap = Math.max((opts.maxLength ?? 2000) * 2, 4096);
  if (s.length > hardCap) s = s.slice(0, hardCap);

  // 1) exact-token masking of registered secrets (token, env values — digests only)
  s = s
    .split(TOKEN_SPLIT)
    .map((part, i) => (i % 2 === 0 && part && isRegisteredSecret(part) ? REDACTED : part))
    .join("");

  // 2) patterns
  for (const [re, rep] of PATTERNS) {
    s = s.replace(re, rep as string);
  }

  if (opts.shareable) s = shareableTransform(s, opts.pseudo ?? defaultPseudo);

  const max = opts.maxLength;
  if (max !== undefined && s.length > max) s = s.slice(0, Math.max(0, max - 1)) + "…";
  return s;
}

const SENSITIVE_KEY_RE = new RegExp(SENSITIVE_KEY, "i");

/**
 * Integrity hashes of PUBLIC proposal content (never of a secret): the only 64-hex values allowed to pass, and only under these exact keys. Besides the
 * proposal digest they are the content digests of the operator's OWN source archive / analysis / generated artifact / CLI argv template / file manifest, which the
 * live approval dialog and the offline preview must SHOW so a human can compare what they approve (before this, the browser received "[REDACTED]" for them).
 */
const INTEGRITY_HASH_KEYS = new Set(["digest", "stateFingerprint", "zipSha256", "analysisDigest", "artifactDigest", "argvDigest", "manifestDigest", "entrySha256"]);
const SHA256_HEX = /^[0-9a-f]{64}$/;

/** Deep-redacts any JSON-like structure: masks sensitive key names and scrubs every string. */
export function redactDeep<T>(value: T, depth = 0): T {
  if (depth > 12) return REDACTED as unknown as T;
  if (typeof value === "string") return redactText(value, { maxLength: 5000 }) as unknown as T;
  if (Array.isArray(value)) return value.map((v) => redactDeep(v, depth + 1)) as unknown as T;
  if (value && typeof value === "object") {
    const out: Record<string, unknown> = {};
    for (const [k, v] of Object.entries(value as Record<string, unknown>)) {
      if (INTEGRITY_HASH_KEYS.has(k) && typeof v === "string" && SHA256_HEX.test(v)) {
        out[k] = v;
        continue;
      }
      out[k] = SENSITIVE_KEY_RE.test(k) && typeof v === "string" ? REDACTED : redactDeep(v, depth + 1);
    }
    return out as T;
  }
  return value;
}

const SENSITIVE_PARAM = new RegExp(`^${SENSITIVE_KEY}$|${SENSITIVE_KEY}`, "i");

/** Normalises a URL for display: drops credentials/fragment, masks sensitive query values. */
export function redactUrl(raw: string): string {
  try {
    const u = new URL(raw);
    u.username = "";
    u.password = "";
    u.hash = "";
    for (const k of [...u.searchParams.keys()]) {
      if (SENSITIVE_PARAM.test(k)) u.searchParams.set(k, REDACTED);
    }
    return redactText(u.toString(), { maxLength: 300 });
  } catch {
    return redactText(raw, { maxLength: 300 });
  }
}
