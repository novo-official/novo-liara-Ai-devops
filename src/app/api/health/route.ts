import { NextResponse } from "next/server";

export const dynamic = "force-dynamic";

/** Unauthenticated liveness probe. Intentionally reveals nothing about configuration. */
export function GET() {
  return NextResponse.json({ status: "ok" }, { headers: { "Cache-Control": "no-store" } });
}
