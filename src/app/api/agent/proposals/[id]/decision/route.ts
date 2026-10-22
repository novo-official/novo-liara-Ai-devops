import { z } from "zod";
import { apiError, apiJson, guardedAction } from "@/server/security/guard";
import { getAgentManager } from "@/server/agent/runtime";

export const dynamic = "force-dynamic";
type Ctx = { params: Promise<{ id: string }> };

// The body is NOT an "approved: true" flag: it names the decision AND the digest of the exact proposal the operator reviewed.
const Body = z.object({ decision: z.enum(["approve", "reject"]), digest: z.string().regex(/^[0-9a-f]{64}$/), confirmAppName: z.string().max(80).optional() }).strict();

/** Server-validated decision (owner, expiry, digest, policy, typed confirmation, drift, single use). Can only ever trigger a SIMULATION. */
export async function POST(req: Request, { params }: Ctx) {
  const { id } = await params;
  return guardedAction(req, async ({ session, body }) => {
    if (!/^prop_\d{14}_[0-9a-f]{8}$/.test(id)) return apiError("not_found");
    const parsed = Body.safeParse(body);
    if (!parsed.success) return apiJson({ error: { code: "bad_request", message: "درخواست نامعتبر است." } }, { status: 400 });
    return apiJson(await getAgentManager().decide(id, session.id, parsed.data));
  });
}
