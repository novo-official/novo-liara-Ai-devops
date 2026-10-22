import { apiError, apiJson, guardedRead } from "@/server/security/guard";
import { getLiveService } from "@/server/live/runtime";

export const dynamic = "force-dynamic";
type Ctx = { params: Promise<{ id: string }> };

export async function GET(req: Request, { params }: Ctx) {
  const { id } = await params;
  return guardedRead(req, async ({ session }) => {
    if (!/^lop_\d{14}_[0-9a-f]{8}$/.test(id)) return apiError("live_not_found");
    return apiJson(await getLiveService().getOperation(id, session.id));
  });
}
