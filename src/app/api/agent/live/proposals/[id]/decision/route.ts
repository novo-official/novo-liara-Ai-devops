import { z } from "zod";
import { apiError, apiJson, guardedAction } from "@/server/security/guard";
import { getLiveService } from "@/server/live/runtime";

export const dynamic = "force-dynamic";
type Ctx = { params: Promise<{ id: string }> };
// strict: no "approved" flag exists; the decision names the digest of the exact LIVE proposal the operator reviewed
const Body = z.object({ decision: z.enum(["approve", "reject"]), digest: z.string().regex(/^[0-9a-f]{64}$/), confirmAppName: z.string().max(80).optional(), acknowledgeFinancial: z.boolean().optional() }).strict();

export async function POST(req: Request, { params }: Ctx) {
  const { id } = await params;
  return guardedAction(req, async ({ session, body }) => {
    if (id.startsWith("prop_")) return apiError("live_simulation_approval_rejected"); // a simulation proposal id is never valid on the live route
    if (!/^lprop_\d{14}_[0-9a-f]{8}$/.test(id)) return apiError("live_not_found");
    const parsed = Body.safeParse(body);
    if (!parsed.success) return apiError("bad_request");
    return apiJson(await getLiveService().decide(id, session.id, parsed.data));
  });
}
