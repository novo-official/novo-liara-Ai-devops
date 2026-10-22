import "server-only";
import { cookies } from "next/headers";
import { redirect } from "next/navigation";
import { getSession, sessionCookieName, type Session } from "./security/session";

/** Data-access-layer guard: every dashboard page calls this itself (layouts alone are not an auth boundary). */
export async function getOptionalSession(): Promise<Session | null> {
  const jar = await cookies();
  return getSession(jar.get(sessionCookieName())?.value);
}

export async function requireSession(): Promise<Session> {
  const s = await getOptionalSession();
  if (!s) redirect("/login");
  return s;
}
