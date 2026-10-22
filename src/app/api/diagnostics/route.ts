import { guardedRead } from "@/server/security/guard";
import { getService } from "@/server/liara/service";

export const dynamic = "force-dynamic";

export async function GET(req: Request) {
  return guardedRead(req, () => getService().diagnostics({ probe: true }));
}
