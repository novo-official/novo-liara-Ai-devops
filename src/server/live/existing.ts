import { APP_NAME_REGEX } from "../config/env";
import type { LiveExistingBinding } from "./types";
import type { PreflightCheck } from "./preflight";
import { buildProbeHost } from "./probe";
import { createHash } from "node:crypto";

/**
 * EXISTING-APPLICATION FACTS AND CHECKS (Phase 2E). Pure. An existing app is identified by MORE than its name: a deleted-and-recreated application keeps its name,
 * but gets a new instance id and creation time (and an empty release history). Those, the plan, the platform, the network, and the release baseline are bound
 * into the approval; any difference at approval or execution time voids it.
 */
export interface ExistingFacts {
  name: string;
  planId: string | null;
  platform: string | null;
  scale: number | null;
  instanceId: string | null;
  createdAt: string | null;
  networkId: string | null;
  defaultSubdomain: boolean | null;
  baseline: { currentRelease: string | null; total: number | null };
}

/** What the OFFICIAL CLI prints as an app's default address: `.iran.liara.run` for an iran-region app WITHOUT a network, `.liara.run` otherwise (CLI deploy.ts). */
export function expectedDefaultSuffix(networkId: string | null): "liara.run" | "iran.liara.run" {
  return networkId ? "liara.run" : "iran.liara.run";
}

export function bindingOf(f: ExistingFacts): LiveExistingBinding {
  return { instanceId: f.instanceId, createdAt: f.createdAt, networkId: f.networkId, baselineRelease: f.baseline.currentRelease, releaseTotal: f.baseline.total, defaultSubdomain: f.defaultSubdomain };
}

/** A deterministic signature of everything bound about the instance (part of the approved state fingerprint). Short hash of the ids: ids are never exposed in clear. */
export function existingSignature(f: ExistingFacts): string {
  const h = (s: string | null) => (s === null ? "null" : createHash("sha256").update(s).digest("hex").slice(0, 16));
  return ["inst:" + h(f.instanceId), "created:" + h(f.createdAt), "net:" + h(f.networkId), "plan:" + (f.planId ?? "null"), "platform:" + (f.platform ?? "null"), "scale:" + f.scale, "sub:" + String(f.defaultSubdomain), "rel:" + h(f.baseline.currentRelease), "total:" + String(f.baseline.total)].join("|");
}

/** markers that would match almost any page or API answer: never acceptable as the proof of the deployed application */
const GENERIC_MARKERS = new Set(["ok", "okay", "true", "false", "healthy", "health", "status", "up", "alive", "success", "200", "html", "next", "app", "hello", "welcome"]);
export function markerIsSpecific(marker: string | null): boolean {
  if (!marker) return false;
  const m = marker.trim().toLowerCase();
  return m.length >= 8 && !GENERIC_MARKERS.has(m) && !/^[\W_]+$/.test(m);
}

export interface ExistingCheckInput {
  facts: ExistingFacts;
  /** platform of the approved source (from the analysis); null when no analysed source is attached yet (status view) */
  sourcePlatform: string | null;
  config: { suffixes: readonly string[]; healthPath: string; healthMarker: string | null };
}

const check = (id: string, category: PreflightCheck["category"], status: PreflightCheck["status"], evidence: PreflightCheck["evidence"], titleFa: string, detailFa: string): PreflightCheck => ({ id, category, status, evidence, titleFa, detailFa });

export function buildExistingChecks(i: ExistingCheckInput): PreflightCheck[] {
  const f = i.facts;
  const out: PreflightCheck[] = [];
  out.push(check("target_in_scope", "security", "ok", ["live_verified"], "برنامه در دامنهٔ مجاز اپراتور است", "فقط برنامه‌هایی که خودتان در فهرست مجاز گذاشته‌اید قابل انتخاب‌اند؛ این عملیات هرگز برنامه‌ای را به فهرست اضافه نمی‌کند."));
  const identifiable = f.instanceId !== null || f.createdAt !== null;
  out.push(check("instance_identifiable", "security", identifiable ? "ok" : "blocked", ["live_verified"], "نمونهٔ برنامه قابل شناسایی است", identifiable ? "شناسهٔ نمونه یا زمان ساخت برنامه از API خوانده شد و در تأیید گره می‌خورد؛ اگر برنامه حذف و دوباره ساخته شود، تأیید قدیمی باطل می‌شود." : "API هیچ شناسهٔ نمونه یا زمان ساختی نداد؛ بدون آن نمی‌توان فهمید برنامه دوباره ساخته شده است یا نه، پس مسدود است."));
  out.push(check("app_running", "configuration", f.scale === 1 ? "ok" : "blocked", ["live_verified"], "برنامه روشن است", f.scale === 1 ? "scale=۱: ساخت نسخه ممکن است." : "برنامه روشن نیست (scale=۰)؛ CLI رسمی و ساخت نسخه برای برنامهٔ خاموش کار نمی‌کند و این ابزار برنامه را خودکار روشن نمی‌کند."));
  out.push(check("plan_known", "configuration", f.planId ? "ok" : "blocked", ["live_verified"], "پلن برنامه مشخص است", f.planId ? "پلن فعلی در تأیید گره می‌خورد و تغییر نمی‌کند." : "پلن برنامه از API خوانده نشد."));
  const platformOk = f.platform === null ? "info" : i.sourcePlatform === null ? "info" : f.platform === i.sourcePlatform ? "ok" : "blocked";
  out.push(check("platform_matches", "configuration", platformOk, ["live_verified"], "پلتفرم برنامه با سورس می‌خواند", platformOk === "blocked" ? `پلتفرم برنامه «${f.platform}» است ولی سورس «${i.sourcePlatform}» است؛ نوع نسخه نباید حدس زده شود.` : platformOk === "ok" ? "هر دو Next.js هستند." : "پلتفرم هنوز با سورس تحلیل‌شده مقایسه نشده است."));
  out.push(check("network_bound", "configuration", "info", ["live_verified", "cli_observed"], "شبکهٔ برنامه", f.networkId ? "برنامه در یک شبکه است؛ شبکه در تأیید گره می‌خورد و تغییر نمی‌کند. نشانی پیش‌فرض: liara.run." : "برنامه در شبکه‌ای نیست؛ نشانی پیش‌فرض طبق CLI رسمی: iran.liara.run."));
  out.push(check("default_subdomain", "configuration", f.defaultSubdomain === false ? "blocked" : f.defaultSubdomain === true ? "ok" : "info", ["live_verified"], "زیردامنهٔ پیش‌فرض فعال است", f.defaultSubdomain === false ? "زیردامنهٔ پیش‌فرض غیرفعال است؛ بررسی سلامت HTTP فقط روی همان نشانی کار می‌کند، پس «DEPLOYED» هرگز اعلام نمی‌شود." : f.defaultSubdomain === true ? "نشانی پیش‌فرض فعال است و برای بررسی سلامت استفاده می‌شود." : "وضعیت زیردامنهٔ پیش‌فرض از API معلوم نشد."));
  const expected = expectedDefaultSuffix(f.networkId);
  const first = i.config.suffixes[0] ?? null;
  const suffixOk = first === expected;
  out.push(check("domain_suffix_expected", "configuration", suffixOk ? "ok" : "blocked", ["cli_observed", "operator_declared"], "دامنهٔ بررسی سلامت درست است", suffixOk ? `LIARA_APP_DOMAIN_SUFFIXES با نشانی پیش‌فرض مورد انتظار (${expected}) یکی است.` : `نشانی پیش‌فرض این برنامه (طبق قاعدهٔ CLI رسمی) «${expected}» است ولی اولین مقدار LIARA_APP_DOMAIN_SUFFIXES ${first ? `«${first}»` : "تنظیم نشده"} است؛ ${expected} را تنظیم کنید (این ابزار .env.local را تغییر نمی‌دهد).`));
  const host = first ? buildProbeHost(f.name, [first]) : null;
  out.push(check("probe_host_valid", "configuration", host ? "ok" : "blocked", ["live_verified"], "نشانی probe معتبر است", host ? "نشانی بررسی سلامت: https://<نام برنامه>." + first + " (فقط همین دامنه، فقط HTTPS و GET)." : "نشانی probe ساخته نشد (نام برنامه یا دامنه نامعتبر است)."));
  const pathOk = /^\/[A-Za-z0-9._~\-/]{0,100}$/.test(i.config.healthPath) && !i.config.healthPath.includes("..") && !i.config.healthPath.includes("//");
  out.push(check("health_path_valid", "configuration", pathOk ? "ok" : "blocked", ["operator_declared"], "مسیر سلامت معتبر است", pathOk ? `مسیر: ${i.config.healthPath}` : "مسیر سلامت نامعتبر است."));
  const specific = markerIsSpecific(i.config.healthMarker);
  out.push(check("health_marker_specific", "configuration", specific ? "ok" : "blocked", ["operator_declared"], "نشانگر سلامت قطعی و اختصاصی است", specific ? "نشانگر طولانی و اختصاصی است و در بدنهٔ پاسخ دقیقاً پیدا می‌شود." : i.config.healthMarker ? "نشانگر خیلی کوتاه یا عمومی است (مثل ok)؛ تقریباً هر صفحه‌ای آن را دارد و چیزی را ثابت نمی‌کند." : "نشانگر سلامت تنظیم نشده است (LIARA_LIVE_HEALTH_MARKER)."));
  out.push(check("release_baseline", "configuration", "info", ["live_verified"], "مبنای نسخه‌های فعلی", f.baseline.total === null ? "تعداد نسخه‌ها خوانده نشد." : f.baseline.total === 0 ? "برنامه هنوز هیچ نسخه‌ای ندارد (مثلاً دوباره ساخته شده)؛ این مبنا گره می‌خورد." : `برنامه ${f.baseline.total} نسخه دارد؛ نسخهٔ فعلی و تعداد در تأیید گره می‌خورد و هر نسخهٔ تازه‌ای تا اجرا، تأیید را باطل می‌کند.`));
  return out;
}

export const isValidAppName = (n: string) => APP_NAME_REGEX.test(n);

/** OFFLINE validation of the health-verification settings (no request, no file written). Used by `npm run check:live-settings`. */
export function validateHealthSettings(i: { appName: string; suffixes: readonly string[]; healthPath: string; healthMarker: string | null }) {
  const known = ["liara.run", "iran.liara.run"] as const;
  const first = i.suffixes[0] ?? null;
  return {
    appNameValid: isValidAppName(i.appName),
    configuredSuffixes: [...i.suffixes],
    firstSuffix: first,
    firstSuffixIsKnownDefault: first !== null && (known as readonly string[]).includes(first),
    /** the probe only ever contacts the FIRST suffix; this is the exact host it would use */
    probeHost: first ? buildProbeHost(i.appName, [first]) : null,
    healthPath: i.healthPath,
    pathValid: /^\/[A-Za-z0-9._~\-/]{0,100}$/.test(i.healthPath) && !i.healthPath.includes("..") && !i.healthPath.includes("//"),
    markerConfigured: !!i.healthMarker,
    markerLength: i.healthMarker?.length ?? 0,
    markerSpecific: markerIsSpecific(i.healthMarker),
    /** what the official CLI prints as the default address, by network presence */
    expectedSuffixWithNetwork: "liara.run",
    expectedSuffixWithoutNetwork: "iran.liara.run",
  };
}
