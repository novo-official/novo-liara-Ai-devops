import { UPLOAD_LIMITS } from "@/server/deploy/limits";
import { apiError, apiJson, guardedUpload } from "@/server/security/guard";
import { toPublicLive } from "@/lib/live-public";
import { getLiveService } from "@/server/live/runtime";

export const dynamic = "force-dynamic";
type Ctx = { params: Promise<{ id: string }> };

/**
 * Starts the REAL deployment of an APPROVED live proposal. Disabled by default (fails closed with `live_execution_disabled`). The operator re-uploads the same
 * ZIP; it is verified against the approved digests, consumed once, and never stored. The executor then runs in the background; poll the operation.
 */
export async function POST(req: Request, { params }: Ctx) {
  const { id } = await params;
  return guardedUpload(req, { maxBytes: UPLOAD_LIMITS.maxArchiveBytes, timeoutMs: UPLOAD_LIMITS.readTimeoutMs }, async ({ session, bytes }) => {
    if (id.startsWith("prop_")) return apiError("live_simulation_approval_rejected");
    if (!/^lprop_\d{14}_[0-9a-f]{8}$/.test(id)) return apiError("live_not_found");
    return apiJson(toPublicLive(await getLiveService().execute(id, session.id, bytes)));
  });
}
