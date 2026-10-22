import { z } from "zod";
import { apiError, apiJson, guardedAction } from "@/server/security/guard";
import { getAgentManager } from "@/server/agent/runtime";

export const dynamic = "force-dynamic";
type Ctx = { params: Promise<{ id: string }> };
const Body = z.object({ item: z.enum(["env_values", "database", "persistent_storage", "account_ready"]), done: z.boolean() }).strict();

/** Records the operator's own decision for a MANUAL checklist item. Blockers cannot be overridden; nothing is executed. */
export async function POST(req: Request, { params }: Ctx) {
  const { id } = await params;
  return guardedAction(req, async ({ session, body }) => {
    if (!/^arun_\d{14}_[0-9a-f]{8}$/.test(id)) return apiError("not_found");
    const parsed = Body.safeParse(body);
    if (!parsed.success) return apiError("invalid_input");
    return apiJson(await getAgentManager().setChecklist(id, session.id, parsed.data.item, parsed.data.done));
  });
}
