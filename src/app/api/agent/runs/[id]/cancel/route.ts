import { apiError, apiJson, guardedAction } from "@/server/security/guard";
import { getAgentManager } from "@/server/agent/runtime";

export const dynamic = "force-dynamic";
type Ctx = { params: Promise<{ id: string }> };

export async function POST(req: Request, { params }: Ctx) {
  const { id } = await params;
  return guardedAction(req, async ({ session }) => {
    if (!/^arun_\d{14}_[0-9a-f]{8}$/.test(id)) return apiError("not_found");
    return apiJson({ run: await getAgentManager().cancel(id, session.id) });
  });
}
