import { injectionSuspect } from "../diagnostics/signals";
import { redactText } from "../security/redact";
import { ANALYZE_LIMITS } from "./limits";
import type { ExtractionSummary, SourceTree } from "./workspace";
import type { DatabaseHint, EnvKey, Finding, FrameworkDetection, FrameworkId, RuntimeFacts, SafeScript, SourceAnalysis } from "./types";

/**
 * SourceAnalyzer — DETERMINISTIC, STATIC inspection of an extracted project.
 *  - it never executes, imports, evaluates, installs or builds anything from the archive
 *  - package.json is parsed as JSON; JS/TS files are scanned with regular expressions only
 *  - only validated tokens leave this module (names matching strict patterns, canonical commands, booleans, counts);
 *    free text from the archive (description, script bodies, config values) is never copied into the result
 *  - env files are never read except `.env.example`-style templates, and only the NAMES are kept
 *  - everything it states is static inference; nothing here proves the project builds or runs
 */

const A = ANALYZE_LIMITS;
const ENV_NAME = /^[A-Z][A-Z0-9_]{1,63}$/;
const APP_NAME = /^[a-z0-9][a-z0-9-]{1,40}[a-z0-9]$/;
const IGNORED_ENV = /^(NODE_ENV|PORT|HOSTNAME|HOST|NEXT_RUNTIME|NEXT_PHASE|NEXT_TELEMETRY_DISABLED|CI|VERCEL|VERCEL_[A-Z0-9_]+|npm_[a-z0-9_]+|PATH|HOME|PWD|TZ|NEXT_PUBLIC_VERCEL_[A-Z0-9_]+|ANALYZE)$/i;
const ENV_TEMPLATES = [".env.example", ".env.sample", ".env.template", ".env.dist"];
const SOURCE_FILE = /\.(?:[cm]?[jt]sx?)$/;
const LOCKFILES: [string, RuntimeFacts["packageManager"]][] = [["package-lock.json", "npm"], ["yarn.lock", "yarn"], ["pnpm-lock.yaml", "pnpm"], ["bun.lockb", "bun"], ["bun.lock", "bun"]];

const DB_DEPS: Record<string, Pick<DatabaseHint, "engine" | "needsService" | "fileBased">> = {
  pg: { engine: "postgresql", needsService: true, fileBased: false },
  postgres: { engine: "postgresql", needsService: true, fileBased: false },
  "pg-promise": { engine: "postgresql", needsService: true, fileBased: false },
  mysql: { engine: "mysql", needsService: true, fileBased: false },
  mysql2: { engine: "mysql", needsService: true, fileBased: false },
  mongodb: { engine: "mongodb", needsService: true, fileBased: false },
  mongoose: { engine: "mongodb", needsService: true, fileBased: false },
  redis: { engine: "redis", needsService: true, fileBased: false },
  ioredis: { engine: "redis", needsService: true, fileBased: false },
  "better-sqlite3": { engine: "sqlite", needsService: false, fileBased: true },
  sqlite3: { engine: "sqlite", needsService: false, fileBased: true },
  "@prisma/client": { engine: "prisma_unknown", needsService: true, fileBased: false },
  prisma: { engine: "prisma_unknown", needsService: true, fileBased: false },
  "drizzle-orm": { engine: "orm_unknown", needsService: true, fileBased: false },
  typeorm: { engine: "orm_unknown", needsService: true, fileBased: false },
  sequelize: { engine: "orm_unknown", needsService: true, fileBased: false },
  knex: { engine: "orm_unknown", needsService: true, fileBased: false },
};
const STORAGE_DEPS = ["multer", "formidable", "busboy", "express-fileupload"];
const BACKGROUND_DEPS = ["node-cron", "cron", "node-schedule", "agenda", "bull", "bullmq", "bee-queue", "pm2"];
const OTHER_FRAMEWORKS: { id: FrameworkId; dep: RegExp; nameFa: string; candidate: string | null }[] = [
  { id: "nuxt", dep: /^nuxt3?$/, nameFa: "Nuxt", candidate: null },
  { id: "sveltekit", dep: /^@sveltejs\/kit$/, nameFa: "SvelteKit", candidate: null },
  { id: "astro", dep: /^astro$/, nameFa: "Astro", candidate: null },
  { id: "remix", dep: /^(@remix-run\/[a-z-]+|@react-router\/[a-z-]+)$/, nameFa: "Remix / React Router", candidate: null },
  { id: "gatsby", dep: /^gatsby$/, nameFa: "Gatsby", candidate: "static" },
  { id: "angular", dep: /^@angular\/core$/, nameFa: "Angular", candidate: "angular" },
  { id: "cra", dep: /^react-scripts$/, nameFa: "Create React App", candidate: "react" },
  { id: "vite", dep: /^vite$/, nameFa: "Vite", candidate: null },
  { id: "node_server", dep: /^(express|fastify|koa|@nestjs\/core|@hapi\/hapi)$/, nameFa: "سرور Node.js", candidate: "node" },
];

const F = (f: Omit<Finding, never>): Finding => f;

interface Manifest {
  ok: boolean;
  deps: Record<string, string>;
  dev: Record<string, string>;
  scripts: Record<string, string>;
  name: string | null;
  engines: string | null;
  packageManagerField: string | null;
  hasWorkspaces: boolean;
  raw: Record<string, unknown>;
}

const isObj = (v: unknown): v is Record<string, unknown> => typeof v === "object" && v !== null && !Array.isArray(v);
const strMap = (v: unknown): Record<string, string> => {
  const out: Record<string, string> = {};
  if (!isObj(v)) return out;
  for (const [k, x] of Object.entries(v).slice(0, 500)) if (typeof x === "string" && k.length <= 214) out[k] = x.slice(0, 300);
  return out;
};

function parseManifest(text: string | null): Manifest | null {
  if (text === null) return null;
  try {
    const raw = JSON.parse(text) as unknown;
    if (!isObj(raw)) return { ok: false, deps: {}, dev: {}, scripts: {}, name: null, engines: null, packageManagerField: null, hasWorkspaces: false, raw: {} };
    const engines = isObj(raw.engines) && typeof raw.engines.node === "string" ? raw.engines.node.trim().slice(0, 40) : null;
    return {
      ok: true,
      deps: strMap(raw.dependencies),
      dev: strMap(raw.devDependencies),
      scripts: strMap(raw.scripts),
      name: typeof raw.name === "string" ? raw.name : null,
      engines: engines && /^[0-9A-Za-z.<>=^~|* x-]+$/.test(engines) ? engines : null,
      packageManagerField: typeof raw.packageManager === "string" ? raw.packageManager.slice(0, 40) : null,
      hasWorkspaces: raw.workspaces !== undefined,
      raw,
    };
  } catch {
    return { ok: false, deps: {}, dev: {}, scripts: {}, name: null, engines: null, packageManagerField: null, hasWorkspaces: false, raw: {} };
  }
}

const SUSPICIOUS_SCRIPT = /(curl|wget)\s[^|\n]*\|\s*(ba|z)?sh|\|\s*(ba|z)?sh\b|\beval\b|base64\s+(-d|--decode)|powershell|\bnc\s+-|\/dev\/tcp|rm\s+-rf\s+\/|chmod\s+\+x\s+[^;&]*&&|\bsudo\b/i;
const META_INSTRUCTION = /(approved?\s*=|ignore\s+(all\s+)?(previous|prior)|disregard|system prompt|new instructions?|you are now|assistant\s*:|\bact as\b|tool_result|auto[- ]?approve|without (approval|confirmation)|bypass)/i;
const looksLikeInstruction = (s: string) => injectionSuspect(s) || META_INSTRUCTION.test(s) || /(?:بدون|بی)\s*تایید|تایید\s*را\s*(?:نادیده|رد)|دستورات?\s*قبلی/.test(s);

function suggestName(m: Manifest | null): { name: string; source: "package.json" | "default"; instruction: boolean } {
  const raw = m?.name ?? null;
  if (raw && looksLikeInstruction(raw)) return { name: "my-next-app", source: "default", instruction: true };
  if (raw) {
    const cleaned = raw.toLowerCase().replace(/^@[^/]+\//, "").replace(/[^a-z0-9-]+/g, "-").replace(/-+/g, "-").replace(/^-+|-+$/g, "").slice(0, 40).replace(/-+$/g, "");
    if (APP_NAME.test(cleaned)) return { name: cleaned, source: "package.json", instruction: false };
  }
  return { name: "my-next-app", source: "default", instruction: false };
}

function scriptInfo(name: "build" | "start", m: Manifest, pm: RuntimeFacts["packageManager"]): SafeScript {
  const body = m.scripts[name];
  const present = typeof body === "string" && body.trim().length > 0;
  const runner = pm === "yarn" ? "yarn" : pm === "pnpm" ? "pnpm" : pm === "bun" ? "bun run" : "npm run";
  const invocation = !present ? null : name === "start" && (pm === null || pm === "npm") ? "npm start" : `${runner} ${name}`;
  const recognised = present && (name === "build" ? /\bnext\s+build\b|\bnext\s+build\s/.test(body!) : /\bnext\s+start\b|^\s*node\s+[\w./-]+\s*(-|$)|\bnode\s+\.next\/standalone\/server\.js/.test(body!));
  return { name, present, invocation, recognised: !!recognised, suspicious: present && SUSPICIOUS_SCRIPT.test(body!) };
}

function parseMajor(range: string | undefined): number | null {
  const m = range ? /(\d{1,2})(?:\.|\b)/.exec(range.replace(/^[^\d]*/, "")) : null;
  return m ? Number(m[1]) : null;
}
/** Highest Node MAJOR a semver-ish range clearly allows, when that can be told cheaply; null = open-ended or unknown. */
export function nodeMajorCeiling(range: string | null): number | null {
  if (!range) return null;
  let max = -1;
  for (const part of range.split("||")) {
    const p = part.trim();
    const exact = /^[\s^~v=]*(\d{1,2})(?:\.[x*\d]+){0,2}$/.exec(p);
    if (exact) {
      max = Math.max(max, Number(exact[1]));
      continue;
    }
    const lt = /<(=?)\s*v?(\d{1,2})/.exec(p);
    if (lt) {
      max = Math.max(max, Number(lt[2]) - (lt[1] ? 0 : 1));
      continue;
    }
    return null; // open-ended (">=18", "*", "x") or not understood
  }
  return max < 0 ? null : max;
}

function readSource(tree: SourceTree, p: string, max: number): string | null {
  try {
    return tree.read(p, max);
  } catch {
    return null;
  }
}

export function analyzeSource(tree: SourceTree, summary: ExtractionSummary): SourceAnalysis {
  const findings: Finding[] = [];
  const add = (f: Finding) => {
    if (findings.length < A.maxFindings && !findings.some((x) => x.id === f.id)) findings.push(f);
  };

  const manifestText = readSource(tree, "package.json", A.maxManifestBytes);
  const manifest = parseManifest(manifestText);
  const has = (p: string) => tree.has(p);
  const lockfiles = LOCKFILES.filter(([f]) => has(f));
  const pmField = manifest?.packageManagerField ? /^(npm|yarn|pnpm|bun)@/.exec(manifest.packageManagerField)?.[1] : null;
  const packageManager = (pmField as RuntimeFacts["packageManager"]) ?? lockfiles[0]?.[1] ?? (manifest?.ok ? "npm" : null);
  const nameInfo = suggestName(manifest);

  // ---- framework detection (ONLY from manifest dependency names and well-known file names) ----
  const allDeps = { ...(manifest?.dev ?? {}), ...(manifest?.deps ?? {}) };
  const hasNextDep = "next" in (manifest?.deps ?? {});
  const hasNextDevOnly = !hasNextDep && "next" in (manifest?.dev ?? {});
  const nextConfigFile = ["next.config.js", "next.config.mjs", "next.config.cjs", "next.config.ts"].find((f) => has(f)) ?? null;
  const others = OTHER_FRAMEWORKS.filter((o) => Object.keys(manifest?.deps ?? {}).some((d) => o.dep.test(d)) && o.id !== "vite" && o.id !== "node_server");
  const framework = detectFramework({ tree, manifest, hasNextDep, hasNextDevOnly, nextConfigFile, others });

  // ---- project-level findings ----
  if (!manifest) {
    // nothing readable at the root
  } else if (!manifest.ok) {
    add(F({ id: "manifest_invalid", kind: "blocker", severity: "high", titleFa: "فایل package.json معتبر نیست", detailFa: "ساختار JSON فایل package.json قابل خواندن نیست؛ بدون آن نمی‌توان وابستگی‌ها و اسکریپت‌ها را بررسی کرد.", source: "package.json", basis: "file_present" }));
  }

  const runtime: RuntimeFacts = {
    packageManager,
    lockfile: lockfiles[0]?.[0] ?? null,
    nodeRange: manifest?.engines ?? null,
    nodeRangeSource: manifest?.engines ? "package.json engines" : null,
    nextMajor: parseMajor(manifest?.deps.next ?? manifest?.dev.next),
    router: "none",
    output: "server",
    port: null,
    scripts: { build: scriptInfo("build", manifest ?? emptyManifest(), packageManager), start: scriptInfo("start", manifest ?? emptyManifest(), packageManager) },
    hasDockerfile: has("Dockerfile") || has("dockerfile"),
    hasLiaraJson: has("liara.json"),
    hasLiaraIgnore: has(".liaraignore"),
    hasGitIgnore: has(".gitignore"),
    installHooks: manifest ? ["preinstall", "install", "postinstall", "prepare"].filter((h) => typeof manifest.scripts[h] === "string") : [],
  };

  if (!runtime.nodeRange) {
    for (const f of [".nvmrc", ".node-version"]) {
      const t = readSource(tree, f, 64)?.trim();
      if (t && /^v?\d{1,2}(\.\d+){0,2}$/.test(t)) {
        runtime.nodeRange = t.replace(/^v/, "");
        runtime.nodeRangeSource = f as RuntimeFacts["nodeRangeSource"];
        break;
      }
    }
  }

  const envKeys: EnvKey[] = [];
  const database: DatabaseHint[] = [];
  const storageHints: string[] = [];
  const backgroundHints: string[] = [];

  // metadata hygiene: instruction-like text in manifest fields is flagged and never used
  if (manifest?.ok) {
    for (const field of ["name", "description", "keywords", "author", "homepage", "repository"]) {
      const v = manifest.raw[field];
      const s = typeof v === "string" ? v : Array.isArray(v) ? v.filter((x) => typeof x === "string").join(" ") : isObj(v) ? JSON.stringify(v).slice(0, 400) : "";
      if (s && looksLikeInstruction(s)) {
        add(F({ id: `metadata_instruction_${field}`, kind: "security", severity: "medium", titleFa: "متن شبیه «دستور» در فراداده‌های پروژه نادیده گرفته شد", detailFa: `در فیلد «${field}» فایل package.json متنی شبیه دستور به یک دستیار هوشمند دیده شد. این متن فقط یک داده است؛ نه خوانده می‌شود، نه ذخیره می‌شود و نه روی هیچ تصمیمی اثر دارد.`, source: `package.json › ${field}`, basis: "static_inference" }));
      }
    }
    for (const [k, v] of Object.entries(manifest.scripts)) {
      if (SUSPICIOUS_SCRIPT.test(v) || (looksLikeInstruction(v) && !/^(next|node|tsc|eslint|prettier|vitest|jest|prisma)\b/.test(v))) {
        add(F({ id: `script_suspicious_${k.replace(/[^a-z0-9]/gi, "_").slice(0, 24)}`, kind: "security", severity: "high", titleFa: `اسکریپت «${k.replace(/[^\w:.-]/g, "").slice(0, 30)}» مشکوک به اجرای دستور خطرناک است`, detailFa: "این اسکریپت الگوی دانلود-و-اجرا یا دستور مخرب دارد. این دستیار هیچ اسکریپتی را اجرا نمی‌کند؛ پیش از هر استقرار واقعی آن را دستی بررسی کنید.", source: `package.json › scripts.${k.replace(/[^\w:.-]/g, "").slice(0, 30)}`, basis: "static_inference" }));
      }
    }
    if (nameInfo.instruction) add(F({ id: "name_ignored", kind: "warning", severity: "low", titleFa: "نام پروژه در package.json پذیرفته نشد", detailFa: "نام شامل متن نامعتبر بود؛ نام پیش‌فرض پیشنهاد می‌شود. نام برنامه را می‌توانید خودتان تعیین کنید.", source: "package.json › name", basis: "static_inference" }));
    for (const [d, v] of Object.entries(allDeps)) {
      if (/^(git\+|git:|github:|https?:|file:|link:)/.test(v)) add(F({ id: `dep_remote_${d.replace(/[^a-z0-9]/gi, "_").slice(0, 30)}`, kind: "warning", severity: "low", titleFa: `وابستگی «${d.slice(0, 40)}» از منبع غیر registry نصب می‌شود`, detailFa: "وابستگی‌هایی که از Git یا لینک مستقیم می‌آیند قابل بازتولید نیستند و باید پیش از استقرار بازبینی شوند.", source: "package.json › dependencies", basis: "declared_in_manifest" }));
    }
    for (const d of Object.keys(allDeps)) {
      const hint = DB_DEPS[d];
      if (hint && !database.some((x) => x.viaDependency === d)) database.push({ ...hint, viaDependency: d });
      if (STORAGE_DEPS.includes(d)) storageHints.push(`dependency:${d}`);
      if (BACKGROUND_DEPS.includes(d)) backgroundHints.push(`dependency:${d}`);
      if (d === "socket.io" || d === "ws") backgroundHints.push(`long_lived_connections:${d}`);
    }
  }

  const sensitive = summary.sensitiveFiles;
  if (sensitive.length) {
    add(F({ id: "sensitive_files_in_archive", kind: "security", severity: "high", titleFa: "فایل‌های حساس در آرشیو هستند", detailFa: `فایل‌هایی مثل ${sensitive.slice(0, 5).join("، ")} در آرشیو دیده شد. این فایل‌ها هرگز خوانده یا ذخیره نشدند. آن‌ها را از بستهٔ استقرار حذف کنید و اگر رمزی در آن‌ها بود، رمز را تعویض کنید.`, source: "archive", basis: "file_present" }));
  }

  if (!framework.supported || !manifest?.ok) {
    finishUnsupported(add, framework, manifest, tree, summary);
    return finalize(summary, framework, runtime, nameInfo, envKeys, database, storageHints, backgroundHints, sensitive, findings);
  }

  // =============================== Next.js analysis ===============================
  add(F({ id: "framework_next", kind: "detected", severity: "info", titleFa: "پروژهٔ Next.js شناسایی شد", detailFa: `نسخهٔ اعلام‌شده: ${runtime.nextMajor ? `${runtime.nextMajor}.x` : "نامشخص"}.`, source: "package.json › dependencies.next", basis: "declared_in_manifest" }));

  // router / routes
  const hasApp = tree.under("app").some((f) => /(^|\/)(page|route)\.[cm]?[jt]sx?$/.test(f)) || tree.under("src/app").some((f) => /(^|\/)(page|route)\.[cm]?[jt]sx?$/.test(f));
  const hasPages = [...tree.under("pages"), ...tree.under("src/pages")].some((f) => /\.[cm]?[jt]sx?$/.test(f) && !/\/_(app|document|error)\./.test(f));
  runtime.router = hasApp && hasPages ? "both" : hasApp ? "app" : hasPages ? "pages" : "none";
  if (runtime.router === "none") add(F({ id: "no_routes", kind: "blocker", severity: "high", titleFa: "هیچ صفحه یا مسیری پیدا نشد", detailFa: "پوشهٔ app یا pages (یا src/app و src/pages) با فایل صفحه وجود ندارد. شاید پروژه در زیرپوشه است یا آرشیو ناقص است.", source: "app/, pages/", basis: "file_present" }));
  else add(F({ id: "router_detected", kind: "detected", severity: "info", titleFa: runtime.router === "app" ? "از App Router استفاده می‌شود" : runtime.router === "pages" ? "از Pages Router استفاده می‌شود" : "هر دو App Router و Pages Router وجود دارد", detailFa: "بر پایهٔ ساختار پوشه‌ها (استنباط ایستا).", source: runtime.router === "pages" ? "pages/" : "app/", basis: "static_inference" }));

  // next.config (regex only, never evaluated)
  if (nextConfigFile) {
    const cfg = readSource(tree, nextConfigFile, A.maxConfigBytes);
    if (cfg === null) add(F({ id: "next_config_unreadable", kind: "warning", severity: "low", titleFa: "فایل پیکربندی Next.js بزرگ یا غیرقابل‌خواندن است", detailFa: "محتوای آن بررسی نشد؛ حالت خروجی (standalone/export) نامعلوم است.", source: nextConfigFile, basis: "not_verifiable" }));
    else {
      const out = /\boutput\s*:\s*['"`](standalone|export)['"`]/.exec(cfg)?.[1];
      if (out === "standalone" || out === "export") runtime.output = out;
      if (/\bbasePath\s*:/.test(cfg)) add(F({ id: "base_path", kind: "warning", severity: "low", titleFa: "basePath در پیکربندی تنظیم شده است", detailFa: "نشانی برنامه زیر یک مسیر فرعی خواهد بود؛ هنگام تنظیم دامنه این را در نظر بگیرید.", source: nextConfigFile, basis: "static_inference" }));
      if (/\bi18n\s*:/.test(cfg) && runtime.output === "export") add(F({ id: "export_i18n", kind: "blocker", severity: "high", titleFa: "i18n با خروجی استاتیک (export) سازگار نیست", detailFa: "Next.js این ترکیب را پشتیبانی نمی‌کند؛ یکی را حذف کنید.", source: nextConfigFile, basis: "static_inference" }));
    }
  }
  if (runtime.output === "export") add(F({ id: "static_export", kind: "detected", severity: "info", titleFa: "خروجی استاتیک (export) انتخاب شده است", detailFa: "برنامه به‌صورت فایل‌های ثابت ساخته می‌شود و سرور Next.js لازم ندارد؛ پلتفرم «static» مناسب‌تر است (شناسهٔ پلتفرم فقط از CLI رسمی مشاهده شده و تأیید زنده نشده).", source: nextConfigFile ?? "next.config", basis: "static_inference" }));
  if (runtime.output === "standalone") add(F({ id: "standalone_output", kind: "info", severity: "info", titleFa: "خروجی standalone انتخاب شده است", detailFa: "فرمان start باید سرور تولیدشده را اجرا کند؛ این مورد تأیید زنده نشده است.", source: nextConfigFile ?? "next.config", basis: "static_inference" }));

  // build / start scripts
  const b = runtime.scripts.build;
  const s = runtime.scripts.start;
  if (!b.present) add(F({ id: "missing_build_script", kind: "blocker", severity: "high", titleFa: "اسکریپت build تعریف نشده است", detailFa: "در package.json بخش scripts باید فرمان build (مثلاً next build) داشته باشد تا نسخهٔ تولید ساخته شود.", source: "package.json › scripts.build", basis: "declared_in_manifest" }));
  else if (!b.recognised) add(F({ id: "unusual_build_script", kind: "warning", severity: "low", titleFa: "فرمان build معمول Next.js نیست", detailFa: "فرمان build شامل «next build» نیست؛ مطمئن شوید همین فرمان پروژه را می‌سازد.", source: "package.json › scripts.build", basis: "static_inference" }));
  if (runtime.output !== "export") {
    if (!s.present) add(F({ id: "missing_start_script", kind: "blocker", severity: "high", titleFa: "اسکریپت start تعریف نشده است", detailFa: "برای اجرای برنامه روی سرور، package.json باید فرمان start (مثلاً next start) داشته باشد.", source: "package.json › scripts.start", basis: "declared_in_manifest" }));
    else if (!s.recognised) add(F({ id: "unusual_start_script", kind: "warning", severity: "medium", titleFa: "فرمان start معمول Next.js نیست", detailFa: "فرمان start شامل «next start» یا اجرای مستقیم node نیست؛ رفتار آن بررسی نمی‌شود و باید دستی تأیید شود.", source: "package.json › scripts.start", basis: "static_inference" }));
    const portMatch = s.present ? /(?:-p|--port)[ =](\d{2,5})\b/.exec(manifest.scripts.start ?? "") : null;
    if (portMatch && Number(portMatch[1]) > 0 && Number(portMatch[1]) < 65536) runtime.port = Number(portMatch[1]);
  }
  if (b.suspicious || s.suspicious) add(F({ id: "suspicious_build_start", kind: "security", severity: "high", titleFa: "فرمان build یا start الگوی خطرناک دارد", detailFa: "پیش از هر استقرار واقعی آن را دستی بررسی کنید؛ هیچ فرمانی توسط این دستیار اجرا نشده است.", source: "package.json › scripts", basis: "static_inference" }));
  if (runtime.installHooks.length) add(F({ id: "install_hooks", kind: "warning", severity: "low", titleFa: "اسکریپت‌های نصب (hook) وجود دارند", detailFa: `اسکریپت‌های ${runtime.installHooks.join("، ")} هنگام نصب وابستگی‌ها روی سرور ساخت اجرا می‌شوند. این دستیار هرگز آن‌ها را اجرا نکرده است.`, source: "package.json › scripts", basis: "declared_in_manifest" }));

  // next dep placement / version
  if (hasNextDevOnly) add(F({ id: "next_dev_dependency", kind: "warning", severity: "medium", titleFa: "next در devDependencies است", detailFa: "اگر ساخت با نصب فقط وابستگی‌های تولید انجام شود، next پیدا نمی‌شود. آن را به dependencies ببرید.", source: "package.json › devDependencies.next", basis: "declared_in_manifest" }));
  if (runtime.nextMajor !== null && runtime.nextMajor < 13) add(F({ id: "old_next", kind: "warning", severity: "medium", titleFa: "نسخهٔ Next.js قدیمی است", detailFa: "نسخه‌های قدیمی بررسی نشده‌اند و ممکن است هشدار امنیتی داشته باشند.", source: "package.json › dependencies.next", basis: "declared_in_manifest" }));

  // node engine
  if (!runtime.nodeRange) add(F({ id: "no_node_engine", kind: "warning", severity: "low", titleFa: "نسخهٔ Node.js مشخص نشده است", detailFa: "فیلد engines.node (یا .nvmrc) را تنظیم کنید تا نسخهٔ اجرا قابل‌پیش‌بینی باشد.", source: "package.json › engines", basis: "not_verifiable" }));
  else {
    const ceiling = nodeMajorCeiling(runtime.nodeRange);
    if (ceiling !== null && ceiling < 18 && (runtime.nextMajor ?? 14) >= 14) add(F({ id: "node_engine_incompatible", kind: "blocker", severity: "high", titleFa: "نسخهٔ Node.js اعلام‌شده با Next.js سازگار نیست", detailFa: "Next.js 14 به بعد به Node.js 18 یا بالاتر نیاز دارد، اما engines نسخهٔ پایین‌تری را اعلام کرده است.", source: `${runtime.nodeRangeSource ?? "engines"}`, basis: "declared_in_manifest" }));
  }

  // lockfile
  if (lockfiles.length > 1) add(F({ id: "multiple_lockfiles", kind: "warning", severity: "low", titleFa: "بیش از یک lockfile وجود دارد", detailFa: "فقط یکی را نگه دارید تا نصب وابستگی‌ها قطعی باشد.", source: lockfiles.map(([f]) => f).join(", "), basis: "file_present" }));
  if (!lockfiles.length) add(F({ id: "no_lockfile", kind: "warning", severity: "low", titleFa: "lockfile پیدا نشد", detailFa: "بدون lockfile نسخهٔ وابستگی‌ها در هر ساخت ممکن است عوض شود.", source: "package-lock.json / yarn.lock / pnpm-lock.yaml", basis: "file_present" }));

  // docker / liara.json / ignore files
  if (runtime.hasDockerfile) add(F({ id: "dockerfile_present", kind: "warning", severity: "low", titleFa: "Dockerfile وجود دارد", detailFa: "این تحلیل برای استقرار با پلتفرم Next.js است؛ Dockerfile بررسی یا اجرا نمی‌شود و ممکن است با استقرار پلتفرمی تداخل داشته باشد.", source: "Dockerfile", basis: "file_present" }));
  if (runtime.hasLiaraJson) {
    const lj = readSource(tree, "liara.json", 64 * 1024);
    let note = "فایل liara.json خوانده نمی‌شود و روی طرح اثری ندارد؛ فقط وجودش گزارش می‌شود.";
    try {
      if (lj) JSON.parse(lj);
    } catch {
      note += " (ساختار JSON آن هم نامعتبر است.)";
    }
    add(F({ id: "liara_json_present", kind: "info", severity: "info", titleFa: "فایل liara.json وجود دارد", detailFa: note, source: "liara.json", basis: "file_present" }));
  }
  if (runtime.hasGitIgnore) {
    const gi = readSource(tree, ".gitignore", 64 * 1024) ?? "";
    if (!/(^|\n)\s*\/?\.env(\*|\.local)?\s*(\n|$)/.test(gi) && !/(^|\n)\s*\.env\*/.test(gi)) add(F({ id: "env_not_gitignored", kind: "warning", severity: "medium", titleFa: ".env در .gitignore نیست", detailFa: "ممکن است فایل‌های محیطی به مخزن یا آرشیو راه پیدا کنند. آن را به .gitignore (و .liaraignore) اضافه کنید.", source: ".gitignore", basis: "static_inference" }));
  } else add(F({ id: "no_gitignore", kind: "warning", severity: "low", titleFa: ".gitignore وجود ندارد", detailFa: "بدون آن احتمال همراه‌شدن فایل‌های غیرضروری یا حساس بیشتر است.", source: ".gitignore", basis: "file_present" }));
  if (!runtime.hasLiaraIgnore && summary.skippedDependencyEntries > 0) add(F({ id: "deps_in_archive", kind: "warning", severity: "low", titleFa: "پوشه‌های وابستگی یا ساخت در آرشیو بودند", detailFa: "پوشه‌هایی مثل node_modules یا .next نادیده گرفته شدند. در استقرار واقعی آن‌ها را در .liaraignore قرار دهید تا حجم بسته کم شود.", source: "archive", basis: "file_present" }));

  // env keys: templates (names only) + code references (regex only)
  const keys = new Map<string, EnvKey>();
  for (const t of ENV_TEMPLATES) {
    const text = readSource(tree, t, A.maxConfigBytes);
    if (text === null) continue;
    let secretLike = false;
    for (const line of text.split(/\r?\n/).slice(0, 400)) {
      const m = /^\s*(?:export\s+)?([A-Z][A-Z0-9_]{1,63})\s*=(.*)$/.exec(line);
      if (!m) continue;
      const name = m[1]!;
      const value = (m[2] ?? "").trim().replace(/^['"]|['"]$/g, "");
      if (value.length >= 12 && redactText(value) !== value) secretLike = true; // the VALUE is dropped here, only the fact is kept
      if (IGNORED_ENV.test(name) || !ENV_NAME.test(name)) continue;
      keys.set(name, { name, source: "env_example", required: true, buildTime: name.startsWith("NEXT_PUBLIC_") });
    }
    if (secretLike) add(F({ id: "env_template_secret_like", kind: "security", severity: "high", titleFa: "فایل نمونهٔ env شبیه مقدار واقعی رمز دارد", detailFa: `در ${t} مقداری شبیه توکن یا رمز واقعی دیده شد. مقدار هرگز ذخیره نشد؛ آن را از فایل حذف و رمز را تعویض کنید.`, source: t, basis: "static_inference" }));
  }
  let scanned = 0;
  let scannedBytes = 0;
  let truncatedScan = false;
  for (const f of tree.under("")) {
    if (!SOURCE_FILE.test(f) || /(^|\/)(node_modules|\.next)\//.test(f)) continue;
    if (scanned >= A.maxSourceFiles || scannedBytes >= A.maxSourceTotalBytes) {
      truncatedScan = true;
      break;
    }
    const text = readSource(tree, f, A.maxSourceFileBytes);
    if (text === null) continue;
    scanned++;
    scannedBytes += text.length;
    for (const m of text.matchAll(/process\.env\.([A-Z][A-Z0-9_]{1,63})(\s*(?:\?\?|\|\|))?/g)) addCodeKey(keys, m[1]!, !m[2]);
    for (const m of text.matchAll(/process\.env\[\s*['"]([A-Z][A-Z0-9_]{1,63})['"]\s*\](\s*(?:\?\?|\|\|))?/g)) addCodeKey(keys, m[1]!, !m[2]);
    if (/\b(?:writeFile|writeFileSync|createWriteStream|appendFile|appendFileSync)\s*\(/.test(text) && !/node_modules/.test(f)) storageHints.push(`fs_write:${f}`);
    if (/\/(?:public\/)?uploads\b/.test(text)) storageHints.push(`uploads_path:${f}`);
    if (/\bnode-cron\b|\bsetInterval\s*\(/.test(text) && /(?:app|pages)\/api\//.test(f)) backgroundHints.push(`timer_in_route:${f}`);
  }
  if (truncatedScan) add(F({ id: "scan_truncated", kind: "warning", severity: "low", titleFa: "بررسی کد به‌دلیل حجم کامل نشد", detailFa: "فقط بخشی از فایل‌های کد برای یافتن نام متغیرهای محیطی پیمایش شد؛ فهرست ممکن است ناقص باشد.", source: "source files", basis: "not_verifiable" }));
  envKeys.push(...[...keys.values()].sort((x, y) => x.name.localeCompare(y.name)).slice(0, A.maxEnvKeys));

  // prisma provider (regex) → engine
  const schema = readSource(tree, "prisma/schema.prisma", 64 * 1024);
  if (schema) {
    const prov = /provider\s*=\s*"(postgresql|postgres|mysql|sqlite|mongodb|sqlserver|cockroachdb)"/.exec(schema)?.[1];
    for (const d of database) {
      if (d.engine === "prisma_unknown") {
        if (prov === "postgresql" || prov === "postgres" || prov === "cockroachdb") Object.assign(d, { engine: "postgresql", fileBased: false, needsService: true });
        else if (prov === "mysql") Object.assign(d, { engine: "mysql", fileBased: false, needsService: true });
        else if (prov === "mongodb") Object.assign(d, { engine: "mongodb", fileBased: false, needsService: true });
        else if (prov === "sqlite") Object.assign(d, { engine: "sqlite", fileBased: true, needsService: false });
      }
    }
    if (!database.length) database.push({ engine: prov === "sqlite" ? "sqlite" : prov === "mysql" ? "mysql" : prov === "mongodb" ? "mongodb" : prov ? "postgresql" : "prisma_unknown", viaDependency: "prisma/schema.prisma", needsService: prov !== "sqlite", fileBased: prov === "sqlite" });
  }

  // reports derived from the above
  const needsFiles = database.filter((d) => d.fileBased);
  if (needsFiles.length) add(F({ id: "file_database", kind: "warning", severity: "medium", titleFa: "پایگاه‌داده مبتنی بر فایل (SQLite) استفاده می‌شود", detailFa: "فایل‌های برنامه روی سرور پایدار نیستند مگر دیسک دائمی بگیرید؛ بدون آن داده‌ها با هر استقرار یا ری‌استارت از بین می‌روند.", source: `package.json › ${needsFiles[0]!.viaDependency}`, basis: "static_inference" }));
  if (database.some((d) => d.needsService)) add(F({ id: "database_detected", kind: "detected", severity: "medium", titleFa: "پروژه به پایگاه‌داده نیاز دارد", detailFa: `وابستگی‌های دیده‌شده: ${database.map((d) => d.viaDependency).slice(0, 4).join("، ")}. یک سرویس پایگاه‌داده باید جداگانه ساخته شود؛ این دستیار آن را نمی‌سازد و ساخت آن از مسیر API مورد استفادهٔ این پروژه تأیید نشده است.`, source: "package.json › dependencies", basis: "declared_in_manifest" }));
  if (storageHints.length && !needsFiles.length) add(F({ id: "storage_hint", kind: "warning", severity: "low", titleFa: "نشانه‌هایی از نوشتن فایل روی دیسک وجود دارد", detailFa: "اگر برنامه فایل آپلودی یا دادهٔ پایدار روی دیسک می‌نویسد، دیسک دائمی لازم است (در لیارا یک مرحلهٔ جداگانه است). این یک استنباط ایستا است.", source: "source files", basis: "static_inference" }));
  if (backgroundHints.length) add(F({ id: "background_hint", kind: "info", severity: "info", titleFa: "نشانه‌هایی از کار پس‌زمینه یا اتصال طولانی وجود دارد", detailFa: "کارهای زمان‌بندی‌شده یا اتصال‌های پایدار (وب‌سوکت) در یک برنامهٔ Next.js معمولاً به معماری جداگانه نیاز دارند؛ این مورد بررسی نشد.", source: "package.json / source", basis: "static_inference" }));
  const required = envKeys.filter((k) => k.required);
  if (required.length) add(F({ id: "env_required", kind: "detected", severity: "medium", titleFa: `${required.length} متغیر محیطی لازم شناسایی شد`, detailFa: "فقط نام متغیرها خوانده شده است، نه مقدارها. مقدارها را خودتان و خارج از این ابزار باید وارد کنید.", source: ".env.example / source code", basis: "static_inference" }));

  return finalize(summary, framework, runtime, nameInfo, envKeys, database, [...new Set(storageHints)].slice(0, 12), [...new Set(backgroundHints)].slice(0, 12), sensitive, findings);
}

function addCodeKey(keys: Map<string, EnvKey>, name: string, required: boolean) {
  if (IGNORED_ENV.test(name) || !ENV_NAME.test(name)) return;
  const cur = keys.get(name);
  if (cur) {
    if (cur.source === "code_reference") cur.required = cur.required || required;
    return;
  }
  keys.set(name, { name, source: "code_reference", required, buildTime: name.startsWith("NEXT_PUBLIC_") });
}

function emptyManifest(): Manifest {
  return { ok: false, deps: {}, dev: {}, scripts: {}, name: null, engines: null, packageManagerField: null, hasWorkspaces: false, raw: {} };
}

interface DetectInput {
  tree: SourceTree;
  manifest: Manifest | null;
  hasNextDep: boolean;
  hasNextDevOnly: boolean;
  nextConfigFile: string | null;
  others: typeof OTHER_FRAMEWORKS;
}
function detectFramework(i: DetectInput): FrameworkDetection {
  const { tree, manifest, others } = i;
  const base = { ambiguousWith: [] as FrameworkId[] };
  if (manifest?.ok && (i.hasNextDep || i.hasNextDevOnly)) {
    const evidence = ["package.json › next"];
    if (i.nextConfigFile) evidence.push(i.nextConfigFile);
    if (tree.under("app").length || tree.under("src/app").length) evidence.push("app/");
    if (tree.under("pages").length || tree.under("src/pages").length) evidence.push("pages/");
    if (others.length) return { id: "next", nameFa: "Next.js", confidence: "low", evidence, supported: false, liaraPlatformCandidate: "next", ambiguousWith: others.map((o) => o.id) };
    return { id: "next", nameFa: "Next.js", confidence: i.hasNextDep && evidence.length >= 2 ? "high" : "medium", evidence, supported: true, liaraPlatformCandidate: "next", ...base };
  }
  if (manifest?.ok) {
    const deps = Object.keys(manifest.deps);
    const all = Object.keys({ ...manifest.dev, ...manifest.deps });
    const hit = OTHER_FRAMEWORKS.find((o) => o.id !== "vite" && o.id !== "node_server" && all.some((d) => o.dep.test(d))) ?? OTHER_FRAMEWORKS.find((o) => o.id === "vite" && all.some((d) => o.dep.test(d))) ?? OTHER_FRAMEWORKS.find((o) => o.id === "node_server" && deps.some((d) => o.dep.test(d)));
    if (hit) return { id: hit.id, nameFa: hit.nameFa, confidence: "medium", evidence: [`package.json › ${all.find((d) => hit.dep.test(d)) ?? hit.id}`], supported: false, liaraPlatformCandidate: hit.candidate, ...base };
  }
  const probe: [string, FrameworkId, string, string | null][] = [
    ["requirements.txt", "python", "Python", "python"], ["pyproject.toml", "python", "Python", "python"], ["Pipfile", "python", "Python", "python"],
    ["composer.json", "php", "PHP / Laravel", "php"], ["go.mod", "go", "Go", "go"], ["pom.xml", "java", "Java", null], ["build.gradle", "java", "Java", null], ["Gemfile", "ruby", "Ruby", null],
  ];
  for (const [file, id, nameFa, cand] of probe) if (tree.has(file)) return { id, nameFa, confidence: "medium", evidence: [file], supported: false, liaraPlatformCandidate: cand, ...base };
  const csproj = tree.under("").find((f) => /\.csproj$/.test(f));
  if (csproj) return { id: "dotnet", nameFa: ".NET", confidence: "medium", evidence: [csproj], supported: false, liaraPlatformCandidate: "dotnet", ...base };
  if (manifest?.ok) return { id: "unknown", nameFa: "پروژهٔ Node.js (چارچوب نامشخص)", confidence: "low", evidence: ["package.json"], supported: false, liaraPlatformCandidate: null, ...base };
  if (tree.has("Dockerfile")) return { id: "docker", nameFa: "Docker", confidence: "low", evidence: ["Dockerfile"], supported: false, liaraPlatformCandidate: "docker", ...base };
  return { id: "unknown", nameFa: "نامشخص", confidence: "low", evidence: [], supported: false, liaraPlatformCandidate: null, ...base };
}

function finishUnsupported(add: (f: Finding) => void, fw: FrameworkDetection, manifest: Manifest | null, tree: SourceTree, summary: ExtractionSummary) {
  void summary;
  if (!manifest && fw.id === "unknown") {
    const sub = tree.under("").filter((f) => /^[^/]+\/package\.json$|^(apps|packages)\/[^/]+\/package\.json$/.test(f));
    if (sub.length) add(F({ id: "monorepo_or_subfolder", kind: "blocker", severity: "high", titleFa: "package.json در ریشه نیست", detailFa: "پروژه در زیرپوشه یا monorepo است. در این نسخه فقط پروژه‌ای پشتیبانی می‌شود که package.json آن در ریشهٔ آرشیو باشد؛ فقط پوشهٔ همان برنامه را فشرده کنید.", source: sub[0]!, basis: "file_present" }));
    else add(F({ id: "no_manifest", kind: "blocker", severity: "high", titleFa: "فایل package.json پیدا نشد", detailFa: "برای تحلیل پروژهٔ Next.js وجود package.json در ریشهٔ آرشیو لازم است.", source: "package.json", basis: "file_present" }));
    return;
  }
  if (fw.ambiguousWith.length) {
    add(F({ id: "framework_ambiguous", kind: "blocker", severity: "high", titleFa: "چارچوب پروژه مبهم است", detailFa: `هم Next.js و هم ${fw.ambiguousWith.join("، ")} در dependencies هستند؛ این دستیار حدس نمی‌زند. پروژه را به یک برنامهٔ مشخص تقسیم کنید.`, source: "package.json › dependencies", basis: "declared_in_manifest" }));
    return;
  }
  add(F({ id: "framework_unsupported", kind: "blocker", severity: "high", titleFa: `تحلیل کامل برای «${fw.nameFa}» هنوز پشتیبانی نمی‌شود`, detailFa: `چارچوب شناسایی‌شده: ${fw.nameFa} (اطمینان ${fw.confidence === "medium" ? "متوسط" : "پایین"}). در این نسخه فقط پروژه‌های Next.js تحلیل کامل می‌شوند. ${fw.liaraPlatformCandidate ? `شناسهٔ پلتفرم احتمالی در CLI رسمی «${fw.liaraPlatformCandidate}» است، اما تأیید زنده نشده.` : "پلتفرم متناظر در لیارا مشخص نیست."}`, source: fw.evidence[0] ?? "archive", basis: "static_inference" }));
}

function finalize(summary: ExtractionSummary, framework: FrameworkDetection, runtime: RuntimeFacts, nameInfo: ReturnType<typeof suggestName>, envKeys: EnvKey[], database: DatabaseHint[], storageHints: string[], backgroundHints: string[], sensitive: string[], findings: Finding[]): SourceAnalysis {
  return {
    schemaVersion: 1,
    project: { archiveBytes: summary.archiveBytes, fileCount: summary.fileCount, extractedFileCount: summary.extractedFileCount, artifactDigest32: summary.artifactDigest32, strippedRoot: !!summary.strippedRoot, suggestedAppName: nameInfo.name, nameSource: nameInfo.source, skippedDependencyEntries: summary.skippedDependencyEntries },
    framework,
    runtime,
    envKeys,
    database,
    storageHints,
    backgroundHints,
    sensitiveFilesPresent: sensitive,
    findings,
  };
}
