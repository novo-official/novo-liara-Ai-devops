import { describe, expect, it } from "vitest";
import { classifyRequestError, safeProbe, type RequestFn } from "@/server/live/probe";

const body = Buffer.from(JSON.stringify({ status: "ok", app: "liara-agent-demo", version: "1" }));
const resolveOk = async () => ["185.208.1.1"];
const base = { appName: "liara-agent-demo", suffixes: ["liara.run"], path: "/health", marker: "liara-agent-demo", resolve: resolveOk };
const answer = (status: number, b: Buffer = body, tooLarge = false): RequestFn => async () => ({ status, body: b, tooLarge });
const clock = (steps: number[]) => {
  let i = 0;
  return () => steps[Math.min(i++, steps.length - 1)]!;
};

describe("the probe's DNS guard is exercised THROUGH safeProbe with Node's callback conventions", () => {
  it("the socket layer's lookup call (options.all = true) gets an array of validated addresses; the classic form gets (address, family)", async () => {
    const seen: unknown[] = [];
    const request: RequestFn = async (o) => {
      await new Promise<void>((res) => o.lookup(o.host, { all: true, hints: 32 }, (err, addr) => (seen.push(err, addr), res())));
      await new Promise<void>((res) => o.lookup(o.host, {}, (err, addr, fam) => (seen.push(err, addr, fam), res())));
      return { status: 200, body, tooLarge: false };
    };
    const r = await safeProbe({ ...base, request });
    expect(r).toMatchObject({ outcome: "ok", failure: null });
    expect(seen).toEqual([null, [{ address: "185.208.1.1", family: 4 }], null, "185.208.1.1", 4]);
  });
  it("a private address behind the name is refused at connect time in BOTH call shapes and surfaces as blocked_address (the answer is never used)", async () => {
    const request: RequestFn = async (o) => {
      const errs: (string | undefined)[] = [];
      for (const opt of [{ all: true }, {}]) await new Promise<void>((res) => o.lookup(o.host, opt, (err) => (errs.push((err as { code?: string } | null)?.code), res())));
      expect(errs).toEqual(["ESSRF", "ESSRF"]);
      return { error: "blocked" };
    };
    expect(await safeProbe({ ...base, resolve: async () => ["10.0.0.7"], request })).toMatchObject({ outcome: "blocked_address", failure: "blocked_address", status: null });
  });
});

describe("health outcomes are typed, with a safe failure category and a duration", () => {
  it("HTTP 200 with the expected marker ⇒ ok, no failure, marker matched, status and duration recorded", async () => {
    const r = await safeProbe({ ...base, request: answer(200), now: clock([1_000, 1_042]) });
    expect(r).toEqual({ outcome: "ok", status: 200, markerFound: true, failure: null, durationMs: 42 });
  });
  it("HTTP 200 with a missing or incorrect marker ⇒ ok transport but marker_mismatch (never a pass)", async () => {
    expect(await safeProbe({ ...base, marker: "another-app", request: answer(200) })).toMatchObject({ outcome: "ok", markerFound: false, failure: "marker_mismatch" });
    expect(await safeProbe({ ...base, request: answer(200, Buffer.from("{}")) })).toMatchObject({ markerFound: false, failure: "marker_mismatch" });
    expect(await safeProbe({ ...base, marker: undefined, request: answer(200) })).toMatchObject({ outcome: "ok", markerFound: null, failure: null }); // nothing to compare ⇒ nothing claimed
  });
  it("non-2xx, redirect and oversized answers ⇒ their own categories", async () => {
    expect(await safeProbe({ ...base, request: answer(502) })).toMatchObject({ outcome: "http_error", status: 502, failure: "http_status", markerFound: null });
    expect(await safeProbe({ ...base, request: answer(404) })).toMatchObject({ outcome: "http_error", failure: "http_status" });
    expect(await safeProbe({ ...base, request: answer(302) })).toMatchObject({ outcome: "redirect", failure: "redirect" });
    expect(await safeProbe({ ...base, request: answer(200, body, true) })).toMatchObject({ outcome: "too_large", failure: "too_large" });
  });
  it("DNS failure, TLS failure and a refused/reset connection are told apart (by error CODE only)", async () => {
    const seam = (detail: "dns" | "tls" | "connection"): RequestFn => async () => ({ error: "network", detail });
    expect(await safeProbe({ ...base, request: seam("dns") })).toMatchObject({ outcome: "network", failure: "dns", status: null });
    expect(await safeProbe({ ...base, request: seam("tls") })).toMatchObject({ outcome: "network", failure: "tls" });
    expect(await safeProbe({ ...base, request: seam("connection") })).toMatchObject({ outcome: "network", failure: "connection" });
    for (const c of ["EDNS", "ENOTFOUND", "EAI_AGAIN"]) expect(classifyRequestError(c)).toEqual({ error: "network", detail: "dns" });
    for (const c of ["CERT_HAS_EXPIRED", "DEPTH_ZERO_SELF_SIGNED_CERT", "UNABLE_TO_VERIFY_LEAF_SIGNATURE", "ERR_TLS_CERT_ALTNAME_INVALID", "ERR_SSL_WRONG_VERSION_NUMBER", "HOSTNAME_MISMATCH"]) expect(classifyRequestError(c), c).toEqual({ error: "network", detail: "tls" });
    for (const c of ["ECONNREFUSED", "ECONNRESET", "EPIPE", undefined, "WHATEVER"]) expect(classifyRequestError(c as string | undefined), String(c)).toEqual({ error: "network", detail: "connection" });
    expect(classifyRequestError("ESSRF")).toEqual({ error: "blocked" });
  });
  it("a real DNS failure inside the guarded lookup is reported as a DNS failure (the code travels through the request seam, no text does)", async () => {
    const request: RequestFn = (o) => new Promise((res) => o.lookup(o.host, { all: true }, (err) => res(err ? { ...classifyRequestError((err as { code?: string }).code) } : { status: 200, body, tooLarge: false })));
    expect(await safeProbe({ ...base, resolve: async () => { throw new Error("getaddrinfo ENOTFOUND secret-internal-name"); }, request })).toMatchObject({ outcome: "network", failure: "dns" });
  });
  it("the result never carries error text, an address or a header — only the typed fields", async () => {
    const r = await safeProbe({ ...base, request: async () => ({ error: "network", detail: "tls" }) });
    expect(Object.keys(r).sort()).toEqual(["durationMs", "failure", "markerFound", "outcome", "status"]);
    expect(JSON.stringify(r)).not.toMatch(/185\.208|authorization|cookie/i);
  });
});

describe("timeouts and cancellation are explicit, typed results", () => {
  it("a timeout from the request layer ⇒ outcome timeout / failure timeout (no exception, no success); the default total deadline is 8 s and an explicit one is passed through", async () => {
    const asked: number[] = [];
    const request: RequestFn = async (o) => (asked.push(o.timeoutMs), { error: "timeout" });
    expect(await safeProbe({ ...base, request })).toMatchObject({ outcome: "timeout", failure: "timeout", status: null, markerFound: null });
    await safeProbe({ ...base, request, timeoutMs: 1500 });
    expect(asked).toEqual([8000, 1500]);
  });
  it("an abort signal stops a probe in flight at once ⇒ outcome cancelled; an already-aborted signal never starts a request", async () => {
    const ac = new AbortController();
    const hanging: RequestFn = (o) => new Promise((res) => o.signal?.addEventListener("abort", () => res({ error: "cancelled" }), { once: true }));
    const p = safeProbe({ ...base, request: hanging, signal: ac.signal });
    ac.abort();
    expect(await p).toMatchObject({ outcome: "cancelled", failure: "cancelled" });
    let called = 0;
    expect(await safeProbe({ ...base, signal: ac.signal, request: async () => (called++, { status: 200, body, tooLarge: false }) })).toMatchObject({ outcome: "cancelled" });
    expect(called).toBe(0);
  });
  it("disabled and invalid targets are typed too", async () => {
    expect(await safeProbe({ ...base, suffixes: [] })).toMatchObject({ outcome: "disabled", failure: "disabled" });
    expect(await safeProbe({ ...base, path: "/../x", request: answer(200) })).toMatchObject({ outcome: "invalid_target", failure: "invalid_target" });
    expect(await safeProbe({ ...base, appName: "Bad Name!", request: answer(200) })).toMatchObject({ outcome: "invalid_target" });
  });
});
