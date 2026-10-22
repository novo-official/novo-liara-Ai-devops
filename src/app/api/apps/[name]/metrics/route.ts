import { guardedSection, parseWindow } from "@/server/api-helpers";
import { getService } from "@/server/liara/service";
import { LiaraError } from "@/server/liara/errors";

export const dynamic = "force-dynamic";

type Ctx = { params: Promise<{ name: string }> };

export async function GET(req: Request, { params }: Ctx) {
  const { name } = await params;
  return guardedSection(req, async () => {
    const url = new URL(req.url);
    const kind = url.searchParams.get("kind");
    if (kind !== "cpu" && kind !== "memory") throw new LiaraError("invalid_input", "Invalid metric kind");
    return getService().getMetrics(name, kind, parseWindow(url));
  });
}
