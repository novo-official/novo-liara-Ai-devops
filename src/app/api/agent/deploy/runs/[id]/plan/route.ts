import { z } from "zod";
import { SIM_SCENARIOS } from "@/server/deploy/params";
import { TRAFFIC_VALUES } from "@/server/deploy/recommend";
import { apiError, apiJson, guardedAction } from "@/server/security/guard";
import { getAgentManager } from "@/server/agent/runtime";

export const dynamic = "force-dynamic";
type Ctx = { params: Promise<{ id: string }> };
const Body = z
  .object({
    appName: z.string().min(3).max(42).optional(),
    traffic: z.enum(TRAFFIC_VALUES as [string, ...string[]]).optional(),
    scenario: z.enum(SIM_SCENARIOS).optional(),
  })
  .strict();

/** Builds an immutable, SIMULATION-ONLY deployment plan (same policy/digest/approval gate as every proposal). Never contacts Liara. */
export async function POST(req: Request, { params }: Ctx) {
  const { id } = await params;
  return guardedAction(req, async ({ session, body }) => {
    if (!/^arun_\d{14}_[0-9a-f]{8}$/.test(id)) return apiError("not_found");
    const parsed = Body.safeParse(body);
    if (!parsed.success) return apiError("invalid_input");
    return apiJson(await getAgentManager().prepareDeployment(id, session.id, parsed.data));
  });
}
