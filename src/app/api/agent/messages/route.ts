import { z } from "zod";
import { apiJson, guardedAction } from "@/server/security/guard";
import { getAgentManager } from "@/server/agent/runtime";

export const dynamic = "force-dynamic";

const Body = z.object({ text: z.string().min(1).max(500), conversationId: z.string().regex(/^conv_\d{14}_[0-9a-f]{8}$/).optional(), askModel: z.boolean().optional() }).strict();

/** One operator message. Parsed deterministically; at most a READ-ONLY investigation or a SIMULATED proposal can follow. */
export async function POST(req: Request) {
  return guardedAction(req, async ({ session, body }) => {
    const parsed = Body.safeParse(body);
    if (!parsed.success) return apiJson({ error: { code: "bad_request" } }, { status: 400 });
    return apiJson(await getAgentManager().handleMessage({ sessionId: session.id, conversationId: parsed.data.conversationId ?? null, text: parsed.data.text, askModel: parsed.data.askModel === true }));
  });
}
