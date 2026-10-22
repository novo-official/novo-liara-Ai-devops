import { apiError, apiJson, guardedAction } from "@/server/security/guard";
import { getRunManager } from "@/server/diagnostics/runtime";

export const dynamic = "force-dynamic";
type Ctx = { params: Promise<{ id: string }> };

export async function POST(req: Request, { params }: Ctx) {
  const { id } = await params;
  return guardedAction(req, async ({ session }) => {
    if (!/^run_[0-9]{14}_[0-9a-f]{8}$/.test(id)) return apiError("not_found");
    const run = await getRunManager().cancel(id, session.id);
    return run ? apiJson({ run }) : apiError("not_found");
  });
}
