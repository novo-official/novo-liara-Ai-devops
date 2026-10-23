import { describe, expect, it } from "vitest";
import { isBlockedAddress, makeGuardedLookup, safeProbe } from "@/server/live/probe";
import { evaluateLadder, verdictOf } from "@/server/live/verify";

type Out = { err: (Error & { code?: string }) | null; address?: unknown; family?: number };
const call = (lk: ReturnType<typeof makeGuardedLookup>, host: string, options: unknown) => new Promise<Out>((res) => lk(host, options, (err, address, family) => res({ err: err as Out["err"], address, family })));

describe("the probe's DNS lookup honours Node's contract (the real cause of 'HTTP health verification failed' for a healthy app)", () => {
  const pub = makeGuardedLookup(async () => ["185.208.1.1", "185.208.1.2"]);
  it("`all: true` (what Node ≥ 20 / 24 sends when autoSelectFamily is on) ⇒ an ARRAY of {address, family}", async () => {
    expect(await call(pub, "x.liara.run", { all: true, hints: 32 })).toEqual({ err: null, address: [{ address: "185.208.1.1", family: 4 }, { address: "185.208.1.2", family: 4 }], family: undefined });
  });
  it("`all` falsy ⇒ the classic (address, family) form", async () => {
    expect(await call(pub, "x.liara.run", {})).toEqual({ err: null, address: "185.208.1.1", family: 4 });
    expect(await call(pub, "x.liara.run", undefined)).toEqual({ err: null, address: "185.208.1.1", family: 4 });
  });
  it("family filtering is honoured; no address of that family is an error, not a silent fallback", async () => {
    const mixed = makeGuardedLookup(async () => ["185.208.1.1", "2a01:4f8::1"]);
    expect((await call(mixed, "h", { all: true, family: 6 })).address).toEqual([{ address: "2a01:4f8::1", family: 6 }]);
    expect((await call(pub, "h", { all: true, family: 6 })).err?.code).toBe("EDNS");
  });
  it("EVERY address is SSRF-checked in both shapes: one private address among public ones refuses the whole answer; DNS errors stay errors", async () => {
    const poisoned = makeGuardedLookup(async () => ["185.208.1.1", "10.0.0.5"]);
    for (const o of [{ all: true }, {}]) expect((await call(poisoned, "h", o)).err?.code, JSON.stringify(o)).toBe("ESSRF");
    for (const ip of ["127.0.0.1", "169.254.169.254", "::1", "fd00:ec2::254", "100.100.100.200", "::ffff:10.0.0.1"]) expect((await call(makeGuardedLookup(async () => [ip]), "h", { all: true })).err?.code, ip).toBe("ESSRF");
    expect((await call(makeGuardedLookup(async () => []), "h", { all: true })).err?.code).toBe("ESSRF");
    expect((await call(makeGuardedLookup(async () => { throw new Error("nx"); }), "h", { all: true })).err?.code).toBe("EDNS");
  });
});

describe("the exact verified response of liara-agent-demo", () => {
  const body = Buffer.from(JSON.stringify({ status: "ok", app: "liara-agent-demo", version: "1" }));
  const ok = { resolve: async () => ["185.208.1.1"], request: async () => ({ status: 200, body, tooLarge: false }) };
  const probe = (marker: string | undefined, over: Record<string, unknown> = {}) => safeProbe({ appName: "liara-agent-demo", suffixes: ["liara.run"], path: "/health", marker, ...ok, ...over });
  it("HTTP 200 + body {status:ok, app:liara-agent-demo, version:1} verifies with the marker and not with another marker", async () => {
    expect(await probe("liara-agent-demo")).toMatchObject({ outcome: "ok", status: 200, markerFound: true, failure: null });
    expect(await probe("some-other-app")).toMatchObject({ outcome: "ok", status: 200, markerFound: false, failure: "marker_mismatch" });
  });
  it("the failure condition: a network-level error (what the lookup bug produced) is an UNKNOWN outcome, never a pass — and the ladder then stays partial", async () => {
    const r = await probe("liara-agent-demo", { request: async () => ({ error: "network" as const }) });
    expect(r).toMatchObject({ outcome: "network", status: null, markerFound: null, failure: "connection" });
    const l = evaluateLadder({ apiAcceptedRequest: true, sourceUploaded: true, releaseId: "6ada74737ebf55567c8e9382", releaseState: "READY", currentReleaseMatches: true, runtime: null, health: { outcome: r.outcome, status: r.status, markerFound: r.markerFound, markerRequired: true }, probeConfigured: true });
    expect(l).toMatchObject({ buildCompleted: "ok", runtimeStarted: "unknown", httpHealthVerified: "unknown" }); // exactly the persisted ladder of the incident
    expect(verdictOf(l, { stillPolling: false })).toBe("needs_review");
  });
  it("…and with the probe working and the applets endpoint answering HTTP 500 (the real state) the same release verifies completely", async () => {
    const r = await probe("liara-agent-demo");
    const l = evaluateLadder({ apiAcceptedRequest: true, sourceUploaded: true, releaseId: "6ada74737ebf55567c8e9382", releaseState: "READY", currentReleaseMatches: true, runtime: null, health: { outcome: r.outcome, status: r.status, markerFound: r.markerFound, markerRequired: true }, probeConfigured: true });
    expect(verdictOf(l, { stillPolling: false })).toBe("deployed");
  });
  it("redirects, 5xx and an oversized body are still not health (nothing was loosened)", async () => {
    expect((await probe("liara-agent-demo", { request: async () => ({ status: 302, body, tooLarge: false }) })).outcome).toBe("redirect");
    expect((await probe("liara-agent-demo", { request: async () => ({ status: 502, body, tooLarge: false }) })).outcome).toBe("http_error");
    expect((await probe("liara-agent-demo", { request: async () => ({ status: 200, body, tooLarge: true }) })).outcome).toBe("too_large");
    expect(isBlockedAddress("185.208.1.1")).toBe(false);
  });
});
