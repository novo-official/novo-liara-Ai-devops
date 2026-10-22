import { createHash, timingSafeEqual } from "node:crypto";
import { z } from "zod";
import type { ActionProposal, OperationKind, Risk } from "./types";
import { OPERATIONS } from "./types";
import { DeployParams, NEW_APP_NAME } from "../deploy/params";

/**
 * Approval policy engine (explicit, table-driven, code — never prompt text).
 * Risk classes follow docs/SECURITY_POLICY.md: R1 = restart-class (click), R2 = availability/cost/config/deploy (typed app name),
 * R3 = destructive (NEVER proposable). `executionMode` is "simulation" only: no approval can ever reach a real Liara operation.
 */

const ENV_NAME = z.string().regex(/^[A-Za-z_][A-Za-z0-9_]{0,63}$/);

export interface OperationPolicy {
  risk: Risk;
  confirmation: "click" | "type_app_name" | "denied";
  ttlSec: number;
  labelFa: string;
  downtimeFa: string;
  preconditionsFa: string[];
  params: z.ZodType<Record<string, unknown>>;
}

const none = z.object({}).strict() as unknown as z.ZodType<Record<string, unknown>>;

export const OPERATION_POLICY: Record<OperationKind, OperationPolicy> = {
  restart_app: { risk: "R1", confirmation: "click", ttlSec: 600, labelFa: "ری‌استارت برنامه", downtimeFa: "قطعی کوتاه هنگام راه‌اندازی مجدد (از چند ثانیه تا چند دقیقه)؛ در واقع زمان دقیق مستند نشده است.", preconditionsFa: ["علت مشکل شناسایی و رفع شده باشد (ری‌استارت راه‌حل تضمینی نیست)."], params: none },
  start_app: { risk: "R1", confirmation: "click", ttlSec: 600, labelFa: "روشن‌کردن برنامه", downtimeFa: "برنامه از حالت خاموش به روشن می‌رود؛ تا آماده‌شدن در دسترس نیست.", preconditionsFa: ["برنامه خاموش است و دلیل خاموشی بررسی شده است."], params: none },
  stop_app: { risk: "R2", confirmation: "type_app_name", ttlSec: 300, labelFa: "خاموش‌کردن برنامه", downtimeFa: "برنامه کاملاً از دسترس خارج می‌شود تا روشن شدن دوباره.", preconditionsFa: ["اطمینان از اینکه قطع سرویس قابل‌قبول است."], params: none },
  change_plan: { risk: "R2", confirmation: "type_app_name", ttlSec: 300, labelFa: "تغییر پلن", downtimeFa: "ممکن است ری‌استارت و هزینهٔ جدید به‌همراه داشته باشد؛ رفتار دقیق در API مستند نشده است.", preconditionsFa: ["فهرست و قیمت پلن‌ها از API تأیید شده باشد (فعلاً در دسترس نیست).", "تأیید هزینه توسط اپراتور."], params: z.object({ direction: z.enum(["increase", "review"]), targetPlanId: z.string().regex(/^[A-Za-z0-9_.-]{1,40}$/).nullable() }).strict() as unknown as z.ZodType<Record<string, unknown>> },
  update_env: { risk: "R2", confirmation: "type_app_name", ttlSec: 300, labelFa: "به‌روزرسانی متغیرهای محیطی", downtimeFa: "طبق مشاهدهٔ CLI، به‌روزرسانی متغیرها برنامه را ری‌استارت می‌کند (تأییدنشده)؛ کل مجموعهٔ متغیرها بازنویسی می‌شود.", preconditionsFa: ["مقدارها را اپراتور خارج از این ابزار وارد می‌کند؛ این ابزار آن‌ها را نمی‌بیند و ذخیره نمی‌کند.", "رفتار «جایگزینی کل مجموعه» و پوشش متغیرهای رمزشده تأیید شده باشد."], params: z.object({ keys: z.array(ENV_NAME).min(1).max(20), valuesSource: z.literal("operator_out_of_band") }).strict() as unknown as z.ZodType<Record<string, unknown>> },
  deploy_release: { risk: "R2", confirmation: "type_app_name", ttlSec: 300, labelFa: "استقرار نسخهٔ اصلاح‌شده", downtimeFa: "نسخهٔ در حال اجرا جایگزین می‌شود؛ زمان قطعی به zero-downtime بستگی دارد.", preconditionsFa: ["سورس اصلاح‌شده توسط اپراتور فراهم شده باشد.", "API مستندشدهٔ بازگشت به نسخهٔ قبل وجود ندارد."], params: z.object({ sourceRef: z.literal("operator_supplied_corrected_source") }).strict() as unknown as z.ZodType<Record<string, unknown>> },
  first_deploy: {
    risk: "R2",
    confirmation: "type_app_name",
    ttlSec: 900,
    labelFa: "استقرار اولیهٔ برنامه (شبیه‌سازی‌شده)",
    downtimeFa: "برنامه‌ای جدید ساخته می‌شود؛ برنامهٔ موجودی جایگزین یا متوقف نمی‌شود. در یک اجرای واقعی آینده تا آماده‌شدن نسخه در دسترس نیست.",
    preconditionsFa: ["گزارش آمادگی بدون مانع است.", "این تأیید فقط برای شبیه‌سازی معتبر است و هرگز اجرای واقعی را مجاز نمی‌کند."],
    params: DeployParams as unknown as z.ZodType<Record<string, unknown>>,
  },
  delete_resource: { risk: "R3", confirmation: "denied", ttlSec: 0, labelFa: "حذف منبع زیرساختی", downtimeFa: "غیرقابل‌بازگشت", preconditionsFa: [], params: z.object({ resourceKind: z.string().max(30), resourceName: z.string().max(80) }).strict() as unknown as z.ZodType<Record<string, unknown>> },
};

export type PolicyDenial = "target_app_exists" | "unknown_operation" | "invalid_params" | "risk_mismatch" | "operation_denied_r3" | "app_not_allowed" | "execution_mode_not_simulation" | "confirmation_mismatch";

export interface ProposalSpec {
  app: string;
  operation: string;
  params: unknown;
  risk: string;
  executionMode: string;
  confirmation: string;
}

/** Validates a proposal spec against the policy table. Any mismatch is a denial: declared risk can never lower the table risk. */
export function evaluateProposal(spec: ProposalSpec, isAllowed: (app: string) => boolean): { ok: true; policy: OperationPolicy; params: Record<string, unknown> } | { ok: false; code: PolicyDenial } {
  if (!(OPERATIONS as readonly string[]).includes(spec.operation) || !Object.hasOwn(OPERATION_POLICY, spec.operation)) return { ok: false, code: "unknown_operation" };
  const policy = OPERATION_POLICY[spec.operation as OperationKind];
  if (policy.confirmation === "denied") return { ok: false, code: "operation_denied_r3" };
  if (spec.executionMode !== "simulation") return { ok: false, code: "execution_mode_not_simulation" };
  if (spec.operation === "first_deploy") {
    // a NEW app: the name must be valid and must not collide with an app that already exists (allowlisted here = exists)
    if (!NEW_APP_NAME.test(spec.app)) return { ok: false, code: "invalid_params" };
    if (isAllowed(spec.app)) return { ok: false, code: "target_app_exists" };
  } else if (!isAllowed(spec.app)) return { ok: false, code: "app_not_allowed" };
  if (spec.risk !== policy.risk) return { ok: false, code: "risk_mismatch" };
  if (spec.confirmation !== policy.confirmation) return { ok: false, code: "confirmation_mismatch" };
  const p = policy.params.safeParse(spec.params);
  if (!p.success) return { ok: false, code: "invalid_params" };
  if (spec.operation === "first_deploy" && (p.data as { appName?: unknown }).appName !== spec.app) return { ok: false, code: "invalid_params" };
  return { ok: true, policy, params: p.data };
}

// ---------- digest ----------
export function canonicalJson(v: unknown): string {
  if (v === null || typeof v !== "object") return JSON.stringify(v);
  if (Array.isArray(v)) return `[${v.map(canonicalJson).join(",")}]`;
  const o = v as Record<string, unknown>;
  return `{${Object.keys(o).sort().map((k) => `${JSON.stringify(k)}:${canonicalJson(o[k])}`).join(",")}}`;
}

export type ProposalContent = Omit<ActionProposal, "digest" | "status">;

/** SHA-256 over EVERY immutable field of the proposal (exact app, operation, params, risk, mode, texts, expiry, state fingerprint …). */
export function proposalDigest(p: ProposalContent): string {
  return createHash("sha256").update(canonicalJson({ v: 1, ...p, evidenceIds: [...p.evidenceIds].sort() })).digest("hex");
}

export function digestsEqual(a: string, b: string): boolean {
  const x = Buffer.from(String(a));
  const y = Buffer.from(String(b));
  return x.length === y.length && timingSafeEqual(x, y);
}

export function contentOf(p: ActionProposal): ProposalContent {
  const { digest: _d, status: _s, ...rest } = p;
  void _d;
  void _s;
  return rest;
}
