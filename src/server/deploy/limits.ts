/** Hard bounds for untrusted source archives. Every limit is enforced BEFORE bytes are inflated or written. */
export const UPLOAD_LIMITS = {
  /** raw request body (compressed archive) */
  maxArchiveBytes: 20 * 1024 * 1024,
  /** entries in the central directory (files + directories), counted before extraction */
  maxEntries: 5000,
  /** sum of DECLARED uncompressed sizes of all entries (also re-checked against actual inflated bytes) */
  maxTotalUncompressedBytes: 80 * 1024 * 1024,
  /** a single extracted file */
  maxFileBytes: 8 * 1024 * 1024,
  /** per-entry and overall compression ratio (zip-bomb guard) */
  maxEntryRatio: 200,
  maxTotalRatio: 100,
  maxPathLength: 240,
  maxPathDepth: 24,
  /** wall-clock budget for reading the body, parsing and analysing */
  readTimeoutMs: 20_000,
  analyzeTimeoutMs: 10_000,
  /** per session */
  maxUploadsPerWindow: 6,
  uploadWindowMs: 10 * 60_000,
} as const;

/** Analyzer read budget (static inspection only). */
export const ANALYZE_LIMITS = {
  maxManifestBytes: 256 * 1024,
  maxConfigBytes: 128 * 1024,
  maxSourceFileBytes: 200 * 1024,
  maxSourceFiles: 400,
  maxSourceTotalBytes: 6 * 1024 * 1024,
  maxEnvKeys: 60,
  maxFindings: 80,
} as const;

/** Directories that are counted but never extracted or read (dependency trees, VCS data, build output). */
export const SKIPPED_DIRS = ["node_modules", ".git", ".next", ".vercel", ".turbo", ".cache", "dist", "build", "coverage", ".svn", ".hg", ".idea", ".vscode", "__MACOSX"] as const;

/** Files that may hold secrets: never extracted, never read; only their NAME is reported as a warning. */
export const SENSITIVE_FILE = /(^|\/)(\.env(\.(?!example$|sample$|template$|dist$)[^/]*)?|\.npmrc|\.yarnrc(\.yml)?|\.netrc|\.pypirc|id_(rsa|dsa|ecdsa|ed25519)|[^/]*\.(pem|key|p12|pfx|jks|keystore|ppk)|credentials(\.json)?|secrets?\.(json|ya?ml|toml)|service-account[^/]*\.json|\.aws\/credentials|\.git-credentials)$/i;
