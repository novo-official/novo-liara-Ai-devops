import { guardedSection } from "@/server/api-helpers";
import { getService } from "@/server/liara/service";

export const dynamic = "force-dynamic";

export async function GET(req: Request) {
  return guardedSection(req, () => getService().listApps());
}
