import { guardedSection } from "@/server/api-helpers";
import { getService } from "@/server/liara/service";

export const dynamic = "force-dynamic";

type Ctx = { params: Promise<{ name: string }> };

export async function GET(req: Request, { params }: Ctx) {
  const { name } = await params;
  return guardedSection(req, async () => {
    return getService().getApp(name);
  });
}
