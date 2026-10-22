import type { NextResponse } from "next/server";
import { apiError, apiJson, guardedRead } from "./security/guard";
import { LiaraError } from "./liara/errors";
import { WINDOWS_MINUTES, type WindowMinutes } from "./liara/read-client";
import type { Section } from "./domain/models";

export function parseWindow(url: URL, dflt: WindowMinutes = 60): WindowMinutes {
  const raw = url.searchParams.get("window");
  if (raw === null) return dflt;
  const n = Number(raw);
  if (!(WINDOWS_MINUTES as readonly number[]).includes(n)) throw new LiaraError("invalid_input", "Invalid time window");
  return n as WindowMinutes;
}

/** Section -> HTTP: ok => 200 with provenance; failure => mapped status with a Persian message. */
export function sectionResponse<T>(s: Section<T>): NextResponse {
  return s.ok ? apiJson(s) : apiError(s.error.code, { retryAfterSec: s.error.retryAfterSec });
}

/** Standard wrapper for data routes: auth + rate limit + Section -> HTTP. Read (GET) only. */
export function guardedSection<T>(req: Request, handler: () => Promise<Section<T>>): Promise<NextResponse> {
  return guardedRead(req, async () => sectionResponse(await handler()));
}
