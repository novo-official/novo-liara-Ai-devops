/**
 * Verification-ladder vocabulary shared by the server and the browser (pure data; no server imports).
 * The ladder's six levels are separate facts and none substitutes for another: a created release is NOT a completed build.
 */
export type LadderLevel = "unknown" | "ok" | "failed";
export const LADDER_KEYS = ["apiAcceptedRequest", "sourceUploaded", "releaseCreated", "buildCompleted", "runtimeStarted", "httpHealthVerified"] as const;
export type LadderKey = (typeof LADDER_KEYS)[number];
export type Ladder = Record<LadderKey, LadderLevel>;

export type EvidenceClass = "documented" | "cli_observed" | "own_probe";
export interface LadderEvidence {
  source: EvidenceClass;
  /** where the evidence comes from (spec operation / CLI behaviour / own code) */
  refs: string[];
  limitationFa: string;
}
export const LADDER_EVIDENCE: Record<LadderKey, LadderEvidence> = {
  apiAcceptedRequest: { source: "documented", refs: ["paas.yaml POST /v1/projects → 200 (empty body)", "GET /v1/projects name list", "GET /v1/projects/{name} identity"], limitationFa: "پاسخ ۲۰۰ ساخت بدنه ندارد؛ وجود برنامه فقط با خواندن فهرست و هویت دقیق آن ثابت می‌شود." },
  sourceUploaded: { source: "documented", refs: ["paas.yaml POST /v2/projects/{name}/sources → {sourceID}"], limitationFa: "راهی برای فهرست‌کردن یا تأیید سورس‌های بارگذاری‌شده وجود ندارد؛ فقط پاسخ ۲۰۰ دارای sourceID مبنا است." },
  releaseCreated: { source: "documented", refs: ["paas.yaml POST /v2/projects/{name}/releases → {releaseID}", "GET /v1/projects/{name}/releases"], limitationFa: "ساخت نسخه به‌معنای تکمیل ساخت (build) نیست." },
  buildCompleted: { source: "cli_observed", refs: ["CLI GET v1/releases/{id} → release.state", "واژگان READY/DEPLOYING/UNHEALTHY/FAILED/CANCELED/TIMEDOUT از CLI رسمی", "CLI GET v2/releases/{id}/build-logs (مستند نیست؛ استفاده نمی‌شود)"], limitationFa: "وضعیت نسخه از فهرست مستند نسخه‌ها خوانده می‌شود اما واژگان آن فقط از CLI آمده و زنده راستی‌آزمایی نشده است؛ وضعیت ناشناخته موفقیت نیست." },
  runtimeStarted: { source: "cli_observed", refs: ["paas.yaml GET /v1/projects/{name}/applets", "واژگان وضعیت اپلت (heuristic)"], limitationFa: "مستندات واژگان وضعیت اپلت را مشخص نکرده‌اند؛ فقط «running» با حداقل یک اپلت موفقیت است." },
  httpHealthVerified: { source: "own_probe", refs: ["probe امن HTTPS این پروژه (GET، بدون redirect، دامنهٔ مورد اعتماد)", "نشانگر قطعی پاسخ /health"], limitationFa: "شاهد توسط همین ابزار ساخته می‌شود و زنده آزموده نشده؛ بدون دامنهٔ تنظیم‌شده هرگز موفقیت نیست." },
};

export type VerificationVerdict = "DEPLOYED" | "PARTIALLY_VERIFIED" | "NEEDS_OPERATOR_REVIEW" | "FAILED";
/**
 *  DEPLOYED              all six levels verified
 *  FAILED                at least one level definitely failed
 *  PARTIALLY_VERIFIED    the API accepted everything (create, upload, release) and SOME of {build, runtime, health} is verified, the rest still unknown
 *  NEEDS_OPERATOR_REVIEW anything else (an earlier level is unknown, or nothing beyond release creation is verified)
 */
export function ladderVerdict(l: Ladder): VerificationVerdict {
  const all = LADDER_KEYS.map((k) => l[k]);
  if (all.every((x) => x === "ok")) return "DEPLOYED";
  if (all.some((x) => x === "failed")) return "FAILED";
  const accepted = l.apiAcceptedRequest === "ok" && l.sourceUploaded === "ok" && l.releaseCreated === "ok";
  const later = [l.buildCompleted, l.runtimeStarted, l.httpHealthVerified];
  if (accepted && later.some((x) => x === "ok")) return "PARTIALLY_VERIFIED";
  return "NEEDS_OPERATOR_REVIEW";
}
