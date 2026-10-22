export const dynamic = "force-dynamic";

// Deterministic health endpoint. The exact body is the acceptance marker for the future live verification.
export async function GET() {
  return Response.json({ status: "ok", app: "liara-agent-demo", version: "1" });
}
