import { apiError, apiJson, guardedRead } from "@/server/security/guard";
import { getAgentManager } from "@/server/agent/runtime";

export const dynamic = "force-dynamic";
type Ctx = { params: Promise<{ id: string }> };

export async function GET(req: Request, { params }: Ctx) {
  const { id } = await params;
  return guardedRead(req, async ({ session }) => {
    if (!/^arun_\d{14}_[0-9a-f]{8}$/.test(id)) return apiError("not_found");
    return apiJson(await getAgentManager().getRun(id, session.id));
  });
}
