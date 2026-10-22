import { createHash } from "node:crypto";
import type { AppConfig } from "../config/env";
import { buildExistingChecks, existingSignature, expectedDefaultSuffix, type ExistingFacts } from "./existing";
import { VERDICT_PRIORITY, type PreflightCategory, type PreflightCheck, type PreflightVerdict } from "./preflight";
import type { LiveReader } from "./reader";

/**
 * EXISTING-APPLICATION live preflight (read-only). Reads, for ONE exact application: its presence in the configured team, its instance identity (instance id,
 * creation time), plan, platform, network, default-domain flag, scale and release baseline — everything a `deploy_existing_app` approval would bind. It trusts NOTHING
 * captured earlier (no stored fingerprint, proposal or approval is read here): every fact is read now, and a fresh signature is derived for comparison.
 * The report holds hints and classes only: no full instance/release/network id, no account value.
 */
export interface ExistingPreflightReport {
  schemaVersion: 1;
  generatedAt: string;
  mode: "existing_app";
  verdict: PreflightVerdict;
  blockerCategories: PreflightCategory[];
  checks: PreflightCheck[];
  team: { configured: boolean; accountShowsTeam: boolean | null };
  target: {
    listedInTeam: boolean | null;
    inScope: boolean;
    facts: { planId: string | null; platform: string | null; scale: number | null; hasInstanceId: boolean; hasCreatedAt: boolean; hasNetwork: boolean; defaultSubdomain: boolean | null; releaseTotal: number | null; hasCurrentRelease: boolean } | null;
    expectedSuffix: string | null;
    /** a FRESH digest of the identity facts read now (first 12 hex); compare with the proposal's binding, never with an old fingerprint */
    freshIdentityDigest: string | null;
  };
  trustedPriorState: "none";
}

const check = (id: string, category: PreflightCategory, status: PreflightCheck["status"], evidence: PreflightCheck["evidence"], titleFa: string, detailFa: string): PreflightCheck => ({ id, category, status, evidence, titleFa, detailFa });

export async function runExistingPreflight(o: { reader: LiveReader; cfg: AppConfig; app: string; includeNetworks: boolean; nowIso: string }): Promise<ExistingPreflightReport> {
  const { reader, cfg: c } = o;
  const checks: PreflightCheck[] = [];
  const inScope = reader.inScope(o.app);

  const inv = await reader.appInventory(o.app); // GET /v1/projects (team-scoped)
  const me = await reader.planCatalogue(); // GET /v1/me
  const accountShowsTeam = me.ok ? (me.data.account?.teamPresent ?? null) : null;
  let facts: ExistingFacts | null = null;
  let identityOk = false;
  if (inScope) {
    const id = await reader.appIdentity(o.app); // GET /v1/projects/{app}
    const base = await reader.releaseBaseline(o.app); // GET /v1/projects/{app}/releases
    identityOk = id.ok && id.data.name === o.app;
    if (id.ok && identityOk) facts = { name: o.app, planId: id.data.planId, platform: id.data.platform, scale: id.data.scale, instanceId: id.data.instanceId, createdAt: id.data.createdAt, networkId: id.data.networkId, defaultSubdomain: id.data.defaultSubdomain, baseline: base.ok ? { currentRelease: base.data.currentRelease, total: base.data.total } : { currentRelease: null, total: null } };
    checks.push(check("identity_read", "configuration", id.ok ? (identityOk ? "ok" : "blocked") : "blocked", ["live_verified"], "هویت برنامه خوانده شد", !id.ok ? "خواندن مشخصات برنامه ناموفق بود." : identityOk ? "نام گزارش‌شدهٔ API دقیقاً با نام مقصد یکی است." : "نام گزارش‌شدهٔ API با نام مقصد نمی‌خواند."));
    checks.push(check("baseline_read", "configuration", base.ok ? "ok" : "blocked", ["live_verified"], "مبنای نسخه‌ها خوانده شد", base.ok ? "نسخهٔ فعلی و تعداد نسخه‌ها خوانده شد." : "فهرست نسخه‌ها خوانده نشد؛ بدون مبنا نمی‌توان انتشار را راستی‌آزمایی کرد."));
  }

  // ---------------------------------------------------------------- security: exact team
  const configured = c.liara.teamId !== null;
  const teamStatus = configured ? (accountShowsTeam === true ? "ok" : accountShowsTeam === false ? "blocked" : "info") : accountShowsTeam === true ? "blocked" : "ok";
  checks.push(check("team_scope", "security", teamStatus, accountShowsTeam === null ? ["not_tested"] : ["live_verified", "cli_observed"], "هم‌خوانی تیم", teamStatus === "blocked" ? "تیم پیکربندی‌شده و پاسخ حساب هم‌خوان نیستند؛ هیچ انتشاری انجام نمی‌شود." : teamStatus === "info" ? "پاسخ حساب خوانده نشد؛ هم‌خوانی تیم تأیید نشد." : configured ? "پاسخ حساب شامل تیم است و شناسهٔ تیم به همهٔ درخواست‌ها پیوست می‌شود (مقدار نمایش داده نمی‌شود)." : "حساب شخصی است و هیچ تیمی تنظیم نشده."));
  const listed = inv.ok ? inv.data.exists : null;
  checks.push(check("target_listed_in_team", "security", listed === true ? "ok" : "blocked", ["live_verified", "documented"], "برنامه در همین تیم/حساب دیده می‌شود", listed === true ? "نام دقیق در فهرست برنامه‌های همین دامنه (تیم) هست." : listed === false ? "برنامه‌ای با این نام در این تیم/حساب پیدا نشد؛ شاید در تیم دیگری یا حذف‌شده است." : "فهرست برنامه‌ها خوانده نشد یا ناقص بود."));
  checks.push(check("target_in_scope", "security", inScope ? "ok" : "blocked", ["operator_declared"], "برنامه در فهرست مجاز اپراتور است", inScope ? "نام در LIARA_ALLOWED_APPS است؛ این ابزار چیزی به فهرست اضافه نمی‌کند." : "نام در LIARA_ALLOWED_APPS نیست؛ هویت و نسخه‌های آن خوانده نشد و انتشار ممکن نیست (فهرست را خودتان تغییر دهید)."));

  // ---------------------------------------------------------------- configuration
  checks.push(check("data_source_live", "configuration", c.dataSource === "live" ? "ok" : "blocked", ["live_verified"], "منبع داده زنده", c.dataSource === "live" ? "داده از لیارای واقعی خوانده می‌شود." : "داده شبیه‌سازی است."));
  checks.push(check("token_present", "configuration", c.liara.token ? "ok" : "blocked", ["operator_declared"], "توکن لیارا", c.liara.token ? "توکن پیکربندی شده است (نمایش داده نمی‌شود)." : "توکن پیکربندی نشده است."));
  if (facts) {
    checks.push(...buildExistingChecks({ facts, sourcePlatform: null, config: { suffixes: c.live.appDomainSuffixes, healthPath: c.live.healthPath, healthMarker: c.live.healthMarker } }).filter((k) => k.id !== "target_in_scope"));
    if (o.includeNetworks && c.liara.allowUndocumented && facts.networkId) {
      const nets = await reader.networks(); // GET /v1/networks (CLI-observed)
      const present = nets.ok ? nets.data.items.some((n) => n.id === facts.networkId) : null;
      checks.push(check("network_exists", "contract", present === true ? "ok" : "blocked", ["cli_observed", "live_verified"], "شبکهٔ برنامه در فهرست شبکه‌ها هست", present === true ? "شناسهٔ شبکهٔ برنامه در فهرست شبکه‌های حساب دیده شد." : present === false ? "شناسهٔ شبکهٔ برنامه در فهرست شبکه‌ها نیست." : "فهرست شبکه‌ها خوانده نشد."));
    }
  }

  // ---------------------------------------------------------------- contract: the REST release fields stay an explicit operator attestation
  checks.push(check("contract_attested_rest", "contract", c.live.contractAttested ? "ok" : "blocked", ["cli_observed", "operator_declared"], "فیلدهای فقط‌CLI ساخت نسخه (REST) تأیید شده‌اند", c.live.contractAttested ? "اپراتور تأیید کرده platformConfig={}، build={cache:true} و gitInfo (همه null، tags=[]) را با CLI رسمی مقایسه کرده است (هنوز زنده آزموده نشده)." : "ساخت نسخه با REST سه فیلد دارد (platformConfig، build.cache و gitInfo) که فقط در CLI رسمی دیده شده‌اند، نه در OpenAPI. این ابزار آن‌ها را به‌جای شما تأیید نمی‌کند: پس از مرور سورس CLI، خودتان LIARA_LIVE_CONTRACT_ATTESTED=true بگذارید. (بک‌اند CLI به این تأیید نیاز ندارد ولی جداگانه و پیش‌فرض خاموش است.)"));
  checks.push(check("live_flag", "configuration", "info", ["operator_declared"], "اجرای واقعی", c.live.enabled ? "پرچم روشن است؛ این اسکریپت هیچ نوشتنی انجام نمی‌دهد." : "اجرای واقعی خاموش است (مورد انتظار)."));
  checks.push(check("cli_fallback", "configuration", "info", ["operator_declared"], "CLI فال‌بک", c.cli.enabled ? "در پیکربندی فعال است (به‌صورت خودکار انتخاب نمی‌شود)." : "خاموش است و هرگز خودکار فعال نمی‌شود."));

  const blocked = new Set(checks.filter((k) => k.status === "blocked").map((k) => k.category));
  const blockerCategories = VERDICT_PRIORITY.filter((k) => blocked.has(k));
  const map: Record<PreflightCategory, PreflightVerdict> = { security: "BLOCKED_BY_SECURITY", contract: "BLOCKED_BY_CONTRACT", pricing: "BLOCKED_BY_PRICING", configuration: "BLOCKED_BY_CONFIGURATION" };
  const verdict: PreflightVerdict = blockerCategories.length ? map[blockerCategories[0]!] : "READY_FOR_OPERATOR_APPROVAL";
  return {
    schemaVersion: 1,
    generatedAt: o.nowIso,
    mode: "existing_app",
    verdict,
    blockerCategories,
    checks,
    team: { configured, accountShowsTeam },
    target: {
      listedInTeam: listed,
      inScope,
      facts: facts ? { planId: facts.planId, platform: facts.platform, scale: facts.scale, hasInstanceId: facts.instanceId !== null, hasCreatedAt: facts.createdAt !== null, hasNetwork: facts.networkId !== null, defaultSubdomain: facts.defaultSubdomain, releaseTotal: facts.baseline.total, hasCurrentRelease: facts.baseline.currentRelease !== null } : null,
      expectedSuffix: facts ? expectedDefaultSuffix(facts.networkId) : null,
      freshIdentityDigest: facts ? createHash("sha256").update(existingSignature(facts)).digest("hex").slice(0, 12) : null,
    },
    trustedPriorState: "none",
  };
}
