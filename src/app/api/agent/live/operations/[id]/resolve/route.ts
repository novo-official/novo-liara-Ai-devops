import { z } from "zod";
import { apiError, apiJson, guardedAction } from "@/server/security/guard";
import { getLiveService } from "@/server/live/runtime";

export const dynamic = "force-dynamic";
type Ctx = { params: Promise<{ id: string }> };
const Body = z.object({ action: z.enum(["cancel", "reverify", "abandon"]) }).strict();

/** The recovery workflow: cancel (only before anything remote), re-verify (read-only) or abandon (remote resources are KEPT; nothing is deleted). */
export async function POST(req: Request, { params }: Ctx) {
  const { id } = await params;
  return guardedAction(req, async ({ session, body }) => {
    if (!/^lop_\d{14}_[0-9a-f]{8}$/.test(id)) return apiError("live_not_found");
    const parsed = Body.safeParse(body);
    if (!parsed.success) return apiError("bad_request");
    const svc = getLiveService();
    return apiJson(parsed.data.action === "cancel" ? await svc.cancel(id, session.id) : await svc.resolve(id, session.id, parsed.data.action));
  });
}
