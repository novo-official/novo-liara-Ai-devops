import { UPLOAD_LIMITS } from "@/server/deploy/limits";
import { getAgentManager } from "@/server/agent/runtime";
import { guardedUpload } from "@/server/security/guard";

export const dynamic = "force-dynamic";

/**
 * Receives an UNTRUSTED source ZIP (raw body). It is validated, analysed STATICALLY (never executed, installed or built), and only a
 * sanitised analysis is stored. A deployment is never started here: this route cannot reach Liara at all.
 */
export async function POST(req: Request) {
  return guardedUpload(req, { maxBytes: UPLOAD_LIMITS.maxArchiveBytes, timeoutMs: UPLOAD_LIMITS.readTimeoutMs }, async ({ session, bytes, filename, conversationId }) => {
    return getAgentManager().receiveProject({ sessionId: session.id, conversationId, archive: bytes, filename });
  });
}
