import { apiError, apiJson, guardedRead } from "@/server/security/guard";
import { getRunManager } from "@/server/diagnostics/runtime";

export const dynamic = "force-dynamic";
type Ctx = { params: Promise<{ id: string }> };

export async function GET(req: Request, { params }: Ctx) {
  const { id } = await params;
  return guardedRead(req, async ({ session }) => {
    if (!/^run_[0-9]{14}_[0-9a-f]{8}$/.test(id)) return apiError("not_found");
    const run = await getRunManager().get(id, session.id);
    return run ? apiJson({ run }) : apiError("not_found"); // other sessions' runs are indistinguishable from missing ones
  });
}
