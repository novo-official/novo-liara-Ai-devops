import { z } from "zod";
import { apiJson, guardedAction, guardedRead } from "@/server/security/guard";
import { getRunManager } from "@/server/diagnostics/runtime";

export const dynamic = "force-dynamic";

const Body = z.object({ app: z.string().max(80), intent: z.string().max(60), windowMinutes: z.number().int().optional(), retryOf: z.string().max(64).optional() }).strict();

/** Start an OFFLINE diagnostic run. The only supported inputs are an allowlisted app and an enumerated intent. */
export async function POST(req: Request) {
  return guardedAction(req, async ({ session, body }) => {
    const parsed = Body.safeParse(body);
    if (!parsed.success) return apiJson({ error: { code: "bad_request" } }, { status: 400 });
    const run = await getRunManager().start({ sessionId: session.id, app: parsed.data.app, intent: parsed.data.intent, windowMinutes: parsed.data.windowMinutes, retryOf: parsed.data.retryOf });
    return apiJson({ run }, { status: 202 });
  });
}

export async function GET(req: Request) {
  return guardedRead(req, async ({ session }) => ({ runs: (await getRunManager().list(session.id, 20)).map(({ report, ...r }) => ({ ...r, hasReport: report !== null })) }));
}
