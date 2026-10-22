import { apiError, apiJson, guardedRead } from "@/server/security/guard";
import { getLiveService } from "@/server/live/runtime";

export const dynamic = "force-dynamic";

/** Read-only: prerequisites, plan candidates and the live-deployment state of one deployment run. Changes nothing, writes nothing. */
export async function GET(req: Request) {
  return guardedRead(req, async ({ session }) => {
    const runId = new URL(req.url).searchParams.get("runId");
    if (runId !== null && !/^arun_\d{14}_[0-9a-f]{8}$/.test(runId)) return apiError("not_found");
    return apiJson(await getLiveService().status(session.id, runId));
  });
}
