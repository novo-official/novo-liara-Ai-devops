import { describe, expect, it } from "vitest";
import { z } from "zod";
import { LiaraHttpClient } from "@/server/liara/http";
import { LiaraError } from "@/server/liara/errors";
import { ENDPOINTS } from "@/server/liara/endpoints";
import { Secret } from "@/server/security/secret";
import { CANARY } from "../helpers/canaries";
import { json, recordingFetch, type Responder } from "../helpers/live";

const BASE = new URL("https://api.liara.ir");

function client(responder: Responder, over: Partial<ConstructorParameters<typeof LiaraHttpClient>[0]> = {}) {
  const rec = recordingFetch(responder);
  const sleeps: number[] = [];
  const c = new LiaraHttpClient({
    baseUrl: BASE,
    token: new Secret(CANARY.token),
    teamId: null,
    timeoutMs: 1000,
    maxConcurrency: 4,
    maxRps: 1000,
    fetchImpl: rec.impl,
    sleep: async (ms) => void sleeps.push(ms),
    ...over,
  });
  return { c, sleeps, ...rec };
}

const anyJson = z.unknown();

describe("LiaraHttpClient is read-only and bounded", () => {
  it("exposes no method other than get()", () => {
    const { c } = client(() => json({}));
    const proto = Object.getOwnPropertyNames(Object.getPrototypeOf(c)).filter((n) => !n.startsWith("#") && n !== "constructor");
    expect(proto.sort()).toEqual(["get", "toJSON"]);
    for (const verb of ["post", "put", "patch", "delete", "request", "fetch"]) expect((c as unknown as Record<string, unknown>)[verb]).toBeUndefined();
  });

  it("sends only GET with bearer auth, no body, pinned host, redirect=manual", async () => {
    const { c, calls } = client(() => json({ ok: 1 }));
    await c.get("listApps", {}, anyJson);
    expect(calls).toHaveLength(1);
    expect(calls[0]!.method).toBe("GET");
    expect(calls[0]!.body).toBeNull();
    expect(calls[0]!.url.origin).toBe("https://api.liara.ir");
    expect(calls[0]!.headers.authorization).toBe(`Bearer ${CANARY.token}`);
  });

  it("adds teamID only when configured and encodes path parameters", async () => {
    const { c, calls } = client(() => json({}), { teamId: "team_9" });
    await c.get("getApp", { name: "shop-api" }, anyJson);
    expect(calls[0]!.url.pathname).toBe("/v1/projects/shop-api");
    expect(calls[0]!.url.searchParams.get("teamID")).toBe("team_9");
    const { c: c2, calls: calls2 } = client(() => json({}));
    await c2.get("getApp", { name: "shop-api" }, anyJson);
    expect(calls2[0]!.url.searchParams.has("teamID")).toBe(false);
  });

  it.each(["../etc", "a/b", "A_B", "x", "-a-", "a b", "a?b=c", "a%2fb", "", "a".repeat(80), "shop-api/../x"])(
    "rejects hostile app name %j before any network call",
    async (name) => {
      const { c, calls } = client(() => json({}));
      await expect(c.get("getApp", { name }, anyJson)).rejects.toMatchObject({ code: "invalid_input" });
      expect(calls).toHaveLength(0);
    },
  );

  it("refuses to be constructed for untrusted hosts / non-https", () => {
    for (const u of ["https://evil.example", "http://api.liara.ir"]) {
      expect(() => new LiaraHttpClient({ baseUrl: new URL(u), token: new Secret("t"), teamId: null, timeoutMs: 1000, maxConcurrency: 1, maxRps: 1 })).toThrow(LiaraError);
    }
  });

  it("never follows redirects (token cannot be forwarded elsewhere)", async () => {
    const { c, calls } = client(() => new Response(null, { status: 302, headers: { location: "https://evil.example/steal" } }));
    await expect(c.get("listApps", {}, anyJson)).rejects.toMatchObject({ code: "upstream_error", status: 302 });
    expect(calls).toHaveLength(1);
    expect(calls.every((x) => x.url.hostname === "api.liara.ir")).toBe(true);
  });

  it("retries a safe GET on 503 with bounded attempts and then gives up", async () => {
    const { c, calls, sleeps } = client(() => new Response("down", { status: 503 }));
    await expect(c.get("listApps", {}, anyJson)).rejects.toMatchObject({ code: "upstream_error", status: 503 });
    expect(calls).toHaveLength(3); // 1 try + 2 retries, never more
    expect(sleeps.filter((ms) => ms >= 250)).toHaveLength(2); // two backoff waits (ignoring RPS pacing)
  });

  it("recovers when a retry succeeds", async () => {
    let n = 0;
    const { c, calls } = client(() => (++n < 2 ? new Response("x", { status: 502 }) : json({ ok: true })));
    await expect(c.get("listApps", {}, anyJson)).resolves.toEqual({ ok: true });
    expect(calls).toHaveLength(2);
  });

  it("honours Retry-After on 429 (capped) and reports rate_limited when exhausted", async () => {
    const { c, calls, sleeps } = client(() => new Response("slow down", { status: 429, headers: { "retry-after": "120" } }));
    await expect(c.get("listApps", {}, anyJson)).rejects.toMatchObject({ code: "rate_limited", status: 429 });
    expect(calls.length).toBeLessThanOrEqual(3);
    expect(Math.max(...sleeps)).toBeLessThanOrEqual(5100); // 5s cap + jitter
  });

  it.each([400, 401, 403, 404, 409, 500])("does not retry HTTP %i", async (status) => {
    const { c, calls } = client(() => new Response("nope", { status }));
    await expect(c.get("listApps", {}, anyJson)).rejects.toBeInstanceOf(LiaraError);
    expect(calls).toHaveLength(1);
  });

  it("maps statuses to typed codes", async () => {
    const codeFor = async (status: number) => {
      const { c } = client(() => new Response("", { status }));
      return c.get("listApps", {}, anyJson).catch((e: LiaraError) => e.code);
    };
    expect(await codeFor(401)).toBe("unauthorized");
    expect(await codeFor(403)).toBe("forbidden");
    expect(await codeFor(404)).toBe("not_found");
    expect(await codeFor(500)).toBe("upstream_error");
  });

  it("maps timeouts and network failures; retries them boundedly", async () => {
    const t = client(() => Promise.reject(Object.assign(new Error("t"), { name: "TimeoutError" })));
    await expect(t.c.get("listApps", {}, anyJson)).rejects.toMatchObject({ code: "timeout" });
    expect(t.calls).toHaveLength(3);
    const n = client(() => Promise.reject(new TypeError("fetch failed: ECONNRESET")));
    await expect(n.c.get("listApps", {}, anyJson)).rejects.toMatchObject({ code: "network" });
    expect(n.calls).toHaveLength(3);
  });

  it("rejects oversized responses (declared and streamed) and non-JSON / malformed JSON", async () => {
    const big = "x".repeat(ENDPOINTS.getApp.maxBytes + 10);
    const a = client(() => new Response(JSON.stringify({ v: big }), { status: 200, headers: { "content-type": "application/json" } }));
    await expect(a.c.get("getApp", { name: "shop-api" }, anyJson)).rejects.toMatchObject({ code: "response_too_large" });
    const b = client(() => new Response("<html>", { status: 200, headers: { "content-type": "text/html" } }));
    await expect(b.c.get("listApps", {}, anyJson)).rejects.toMatchObject({ code: "contract_mismatch" });
    const d = client(() => new Response("{not json", { status: 200, headers: { "content-type": "application/json" } }));
    await expect(d.c.get("listApps", {}, anyJson)).rejects.toMatchObject({ code: "contract_mismatch" });
  });

  it("reports contract mismatch with paths/codes only (no received values)", async () => {
    const { c } = client(() => json({ projects: CANARY.apiToken }));
    const err = await c.get("listApps", {}, z.object({ projects: z.array(z.unknown()) })).catch((e: LiaraError) => e);
    expect(err).toBeInstanceOf(LiaraError);
    expect((err as LiaraError).code).toBe("contract_mismatch");
    expect(JSON.stringify((err as LiaraError).opts)).not.toContain("CANARY");
    expect((err as LiaraError).message).not.toContain("CANARY");
  });

  it("never leaks the token or upstream body in errors, JSON, or inspect output", async () => {
    const { c } = client(() => new Response(`echo ${CANARY.token} secret=${CANARY.apiToken}`, { status: 500 }));
    const err = await c.get("listApps", {}, anyJson).catch((e: LiaraError) => e);
    const dump = JSON.stringify({ err, message: (err as Error).message, stack: (err as Error).stack, opts: (err as LiaraError).opts, c });
    expect(dump).not.toMatch(/CANARY/);
    expect(JSON.stringify(c)).toContain("[REDACTED]");
  });

  it("limits concurrency", async () => {
    let active = 0;
    let peak = 0;
    const { c } = client(async () => {
      active++;
      peak = Math.max(peak, active);
      await new Promise((r) => setTimeout(r, 15));
      active--;
      return json({});
    }, { maxConcurrency: 2 });
    await Promise.all(Array.from({ length: 8 }, () => c.get("listApps", {}, anyJson)));
    expect(peak).toBeLessThanOrEqual(2);
  });

  it("registers only GET endpoints", () => {
    for (const def of Object.values(ENDPOINTS)) expect(def.method).toBe("GET");
    expect(Object.values(ENDPOINTS).filter((e) => e.contract === "observed").map((e) => e.id)).toEqual(["getLogsV2", "listNetworks"]);
  });

  it("enforces a rolling per-minute request budget (every attempt counts) and never retries local exhaustion", async () => {
    let t = 1_000_000;
    const { c, calls } = client(() => json({}), { budgetPerMinute: 3, now: () => t });
    for (let i = 0; i < 3; i++) await c.get("listApps", {}, anyJson);
    await expect(c.get("listApps", {}, anyJson)).rejects.toMatchObject({ code: "rate_limited" });
    expect(calls).toHaveLength(3); // the 4th attempt never reached the network
    t += 61_000;
    await expect(c.get("listApps", {}, anyJson)).resolves.toEqual({});
  });

  it("honours a hard lifetime request cap", async () => {
    const { c, calls } = client(() => json({}), { maxTotalRequests: 2 });
    await c.get("listApps", {}, anyJson);
    await c.get("listApps", {}, anyJson);
    await expect(c.get("listApps", {}, anyJson)).rejects.toMatchObject({ code: "rate_limited" });
    expect(calls).toHaveLength(2);
  });

  it("keeps only the STRUCTURE of upstream error bodies (key names), never their content", async () => {
    const body = JSON.stringify({ message: CANARY.token, statusCode: 403, "weird key!": 1, nested: { secret: CANARY.apiToken } });
    const { c } = client(() => new Response(body, { status: 403, headers: { "content-type": "application/json; charset=utf-8" } }));
    const err = (await c.get("listApps", {}, anyJson).catch((e: LiaraError) => e)) as LiaraError;
    expect(err.code).toBe("forbidden");
    expect(err.opts.errorShape).toEqual({ contentType: "application/json", kind: "json-object", keys: ["message", "statusCode", "nested"], bytes: body.length });
    expect(JSON.stringify(err.opts)).not.toMatch(/CANARY/);
    const text = client(() => new Response(`oops ${CANARY.token}`, { status: 500, headers: { "content-type": "text/plain" } }));
    const e2 = (await text.c.get("listApps", {}, anyJson).catch((e: LiaraError) => e)) as LiaraError;
    expect(e2.opts.errorShape).toMatchObject({ kind: "text", contentType: "text/plain" });
    expect(JSON.stringify(e2.opts)).not.toMatch(/CANARY/);
    const empty = client(() => new Response(null, { status: 404 }));
    expect(((await empty.c.get("listApps", {}, anyJson).catch((e: LiaraError) => e)) as LiaraError).opts.errorShape).toMatchObject({ kind: "empty" });
  });

  it("distinguishes authorization, connectivity and contract failures", async () => {
    const code = async (r: Responder) => (await client(r).c.get("listApps", {}, z.object({ ok: z.literal(true) })).catch((e: LiaraError) => e.code)) as string;
    expect(await code(() => new Response("", { status: 401 }))).toBe("unauthorized");
    expect(await code(() => new Response("", { status: 403 }))).toBe("forbidden");
    expect(await code(() => Promise.reject(new TypeError("fetch failed")))).toBe("network");
    expect(await code(() => json({ ok: false }))).toBe("contract_mismatch");
  });
});
