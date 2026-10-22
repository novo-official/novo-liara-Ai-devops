/** Shared types of the first-deployment assistant (Phase 1E). Everything here is derived from STATIC inspection of an untrusted archive. */

export type Verdict = "READY" | "READY_WITH_WARNINGS" | "NEEDS_CONFIGURATION" | "BLOCKED" | "UNSUPPORTED";
export const VERDICTS: Verdict[] = ["READY", "READY_WITH_WARNINGS", "NEEDS_CONFIGURATION", "BLOCKED", "UNSUPPORTED"];

export type FrameworkId = "next" | "nuxt" | "sveltekit" | "astro" | "remix" | "gatsby" | "angular" | "cra" | "vite" | "node_server" | "python" | "php" | "go" | "dotnet" | "java" | "ruby" | "docker" | "unknown";

/** how a statement was obtained — static reading never proves runtime behaviour */
export type Basis = "declared_in_manifest" | "file_present" | "static_inference" | "not_verifiable";

export type FindingKind = "detected" | "missing" | "blocker" | "warning" | "security" | "info";
export interface Finding {
  id: string;
  kind: FindingKind;
  severity: "info" | "low" | "medium" | "high";
  titleFa: string;
  detailFa: string;
  /** file or manifest field the statement comes from (a relative path label, never a value) */
  source: string;
  basis: Basis;
}

export interface SafeScript {
  name: "build" | "start";
  present: boolean;
  /** canonical invocation (`npm run build`), derived from the package manager — NEVER the script body from the archive */
  invocation: string | null;
  /** body invokes next/node as expected */
  recognised: boolean;
  suspicious: boolean;
}

export interface EnvKey {
  name: string;
  source: "env_example" | "code_reference";
  required: boolean;
  /** NEXT_PUBLIC_* values are inlined at BUILD time */
  buildTime: boolean;
}

export interface DatabaseHint {
  engine: "postgresql" | "mysql" | "mongodb" | "redis" | "sqlite" | "prisma_unknown" | "orm_unknown";
  viaDependency: string;
  /** a separate database service would have to exist (not created by this assistant) */
  needsService: boolean;
  fileBased: boolean;
}

export interface FrameworkDetection {
  id: FrameworkId;
  nameFa: string;
  confidence: "high" | "medium" | "low";
  evidence: string[];
  /** this build can analyse it end to end */
  supported: boolean;
  /** Liara platform id that is OBSERVED in the official CLI (not verified live); null when none is known */
  liaraPlatformCandidate: string | null;
  ambiguousWith: FrameworkId[];
}

export interface RuntimeFacts {
  packageManager: "npm" | "yarn" | "pnpm" | "bun" | null;
  lockfile: string | null;
  nodeRange: string | null;
  nodeRangeSource: "package.json engines" | ".nvmrc" | ".node-version" | null;
  nextMajor: number | null;
  router: "app" | "pages" | "both" | "none";
  output: "server" | "standalone" | "export";
  port: number | null;
  scripts: { build: SafeScript; start: SafeScript };
  hasDockerfile: boolean;
  hasLiaraJson: boolean;
  hasLiaraIgnore: boolean;
  hasGitIgnore: boolean;
  installHooks: string[];
}

export interface SourceAnalysis {
  schemaVersion: 1;
  project: { archiveBytes: number; fileCount: number; extractedFileCount: number; artifactDigest32: string; strippedRoot: boolean; suggestedAppName: string; nameSource: "package.json" | "default"; skippedDependencyEntries: number };
  framework: FrameworkDetection;
  runtime: RuntimeFacts;
  envKeys: EnvKey[];
  database: DatabaseHint[];
  storageHints: string[];
  backgroundHints: string[];
  sensitiveFilesPresent: string[];
  findings: Finding[];
}

export interface ChecklistItem {
  id: string;
  titleFa: string;
  detailFa: string;
  kind: "auto" | "manual";
  /** a pending blocking item keeps the verdict at NEEDS_CONFIGURATION */
  blocking: boolean;
  state: "ok" | "pending" | "done" | "not_applicable" | "blocked";
  /** where the underlying capability comes from: A documented API · B observed in official CLI only · C manual user step · D unavailable/unverified */
  class: "A" | "B" | "C" | "D";
}

export interface UserDecisions {
  envConfirmed: boolean;
  databaseConfirmed: boolean;
  storageConfirmed: boolean;
  accountReady: boolean;
}
export const NO_DECISIONS: UserDecisions = { envConfirmed: false, databaseConfirmed: false, storageConfirmed: false, accountReady: false };
export const DECISION_FOR_ITEM: Record<string, keyof UserDecisions> = { env_values: "envConfirmed", database: "databaseConfirmed", persistent_storage: "storageConfirmed", account_ready: "accountReady" };

export interface ReadinessReport {
  schemaVersion: 1;
  verdict: Verdict;
  verdictFa: string;
  summaryFa: string;
  staticNoticeFa: string;
  framework: { id: FrameworkId; nameFa: string; confidence: "high" | "medium" | "low"; supported: boolean };
  findings: Finding[];
  checklist: ChecklistItem[];
  nextActionsFa: string[];
  limitations: string[];
  decisions: UserDecisions;
}
