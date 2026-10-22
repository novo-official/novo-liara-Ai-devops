import { UPLOAD_LIMITS } from "@/server/deploy/limits";
import { apiError, guardedUpload } from "@/server/security/guard";
import { getLiveService } from "@/server/live/runtime";

export const dynamic = "force-dynamic";

/**
 * Builds a LIVE deployment proposal — or, with `x-live-kind: preview_existing_app`, a non-persistent offline preview — (it does NOT execute anything and contacts no write endpoint). The ZIP is re-uploaded (never stored) so that its SHA-256,
 * the analysis and the generated artifact digest can be bound into the proposal. Parameters travel in headers; there is no free-text field.
 */
export async function POST(req: Request) {
  return guardedUpload(req, { maxBytes: UPLOAD_LIMITS.maxArchiveBytes, timeoutMs: UPLOAD_LIMITS.readTimeoutMs }, async ({ session, bytes, headers }) => {
    const kind = headers.get("x-live-kind") ?? "create_new_app";
    const backend = headers.get("x-live-backend") ?? "api";
    if ((kind !== "create_new_app" && kind !== "deploy_existing_app" && kind !== "preview_existing_app") || (backend !== "api" && backend !== "cli") || (kind === "create_new_app" && backend !== "api")) return apiError("bad_request");
    const runId = headers.get("x-live-run") ?? "";
    const planId = headers.get("x-live-plan") ?? "";
    const bundle = headers.get("x-live-bundle");
    const appName = headers.get("x-live-app") ?? "";
    if (kind === "preview_existing_app") {
      // OFFLINE preview: same artifact binding, nothing persisted, no write endpoint, no live flag needed
      if (!/^arun_\d{14}_[0-9a-f]{8}$/.test(runId) || !/^[a-z0-9][a-z0-9-]{1,61}[a-z0-9]$/.test(appName)) return apiError("bad_request");
      return getLiveService().previewExisting(session.id, { runId, appName, backend, zip: bytes });
    }
    if (kind === "deploy_existing_app") {
      // a release to an application that ALREADY exists (never creates it): no plan/bundle headers apply
      if (!/^arun_\d{14}_[0-9a-f]{8}$/.test(runId) || !/^[a-z0-9][a-z0-9-]{1,61}[a-z0-9]$/.test(appName)) return apiError("bad_request");
      return getLiveService().createExistingProposal(session.id, { runId, appName, backend, zip: bytes });
    }
    if (!/^arun_\d{14}_[0-9a-f]{8}$/.test(runId) || !/^[A-Za-z0-9][A-Za-z0-9_.-]{0,59}$/.test(planId) || (bundle !== null && !/^[A-Za-z0-9][A-Za-z0-9_.-]{0,59}$/.test(bundle)) || !/^[a-z0-9][a-z0-9-]{1,61}[a-z0-9]$/.test(appName)) return apiError("bad_request");
    return getLiveService().createProposal(session.id, { runId, planId, bundlePlanId: bundle, appName, zip: bytes });
  });
}
