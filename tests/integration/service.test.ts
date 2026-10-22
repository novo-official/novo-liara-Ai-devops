import { afterEach, describe, expect, it } from "vitest";
import { buildService } from "@/server/liara/service";
import { MOCK_APP_NAMES } from "@/server/liara/fixture-transport";
import { __setLogSinkForTests } from "@/server/security/logger";
import { assertNoCanary, CANARY } from "../helpers/canaries";
import { defaultResponder, json, liveService, makeConfig, recordingFetch, resetAll } from "../helpers/live";

afterEach(resetAll);

const NOW = () => Date.UTC(2026, 0, 2, 4, 0, 0);

describe("allowlist enforcement (live)", () => {
  it("filters the account-wide list down to the allowlist before returning anything", async () => {
    const { svc } = liveService();
    const r = await svc.listApps();
    expect(r.ok).toBe(true);
    if (!r.ok) return;
    expect(r.data.items.map((a) => a.name)).toEqual(["shop-api", "shop-web"]);
    expect(JSON.stringify(r)).not.toContain("secret-internal-app");
    expect(r.data.skipped).toBe(1);
    assertNoCanary(r);
  });

  it.each([
    "secret-internal-app", // exists upstream but not allowlisted
    "SHOP-API", // case change
    " shop-api",
    "shop-api ",
    "shop-api/",
    "shop-api/../secret-internal-app",
    "shop-api?x=1",
    "shop-api%2f..%2fsecret-internal-app",
    "shop-api\u0000",
    "shop-арі", // cyrillic look-alikes
    "shop-api\n",
    "../shop-api",
    "",
    "constructor",
    "__proto__",
  ])("blocks %j before any upstream call", async (name) => {
    const { svc, calls } = liveService();
    for (const fn of [
      () => svc.getApp(name),
      () => svc.getApplets(name),
      () => svc.getReleases(name),
      () => svc.getEvents(name, 60),
      () => svc.getLogs(name, 60),
      () => svc.getMetrics(name, "cpu", 60),
    ]) {
      await expect(fn()).rejects.toMatchObject({ code: "app_not_allowed" });
    }
    expect(calls).toHaveLength(0);
  });

  it("allows exact allowlisted names only", async () => {
    const { svc, calls } = liveService();
    expect((await svc.getApp("shop-web")).ok).toBe(true);
    expect(calls.map((c) => c.url.pathname)).toEqual(["/v1/projects/shop-web"]);
  });

  it("rejects invalid time windows", async () => {
    const { svc, calls } = liveService();
    await expect(svc.getLogs("shop-api", 7 as never)).rejects.toMatchObject({ code: "invalid_input" });
    await expect(svc.getEvents("shop-api", 99999 as never)).rejects.toMatchObject({ code: "invalid_input" });
    expect(calls).toHaveLength(0);
  });
});

describe("mock vs live separation", () => {
  it("mock mode never touches the network and labels everything as mock", async () => {
    const fetchSpy = recordingFetch(() => json({}));
    const svc = buildService(makeConfig({ LIARA_DATA_SOURCE: "mock" }), { fetchImpl: fetchSpy.impl, now: NOW });
    expect(svc.mode).toBe("mock");
    const list = await svc.listApps();
    expect(list.ok && list.meta.mode).toBe("mock");
    expect(list.ok && list.data.items.map((a) => a.name).sort()).toEqual([...MOCK_APP_NAMES].sort());
    const logs = await svc.getLogs("demo-api", 60);
    expect(logs.ok && logs.meta.mode).toBe("mock");
    expect(fetchSpy.calls).toHaveLength(0);
  });

  it("live mode never reads simulated fixtures", async () => {
    const { svc } = liveService();
    expect(svc.mode).toBe("live");
    const list = await svc.listApps();
    expect(list.ok && list.meta.mode).toBe("live");
    expect(JSON.stringify(list)).not.toMatch(/demo-(shop|api|worker)/);
    // an app that exists only in the fixtures is not reachable in live mode
    await expect(svc.getApp("demo-shop")).rejects.toMatchObject({ code: "app_not_allowed" });
  });

  it("mock mode honours an explicit allowlist too", async () => {
    const svc = buildService(makeConfig({ LIARA_ALLOWED_APPS: "demo-shop" }), { now: NOW });
    const list = await svc.listApps();
    expect(list.ok && list.data.items.map((a) => a.name)).toEqual(["demo-shop"]);
    await expect(svc.getApp("demo-api")).rejects.toMatchObject({ code: "app_not_allowed" });
  });

  it("live mode without credentials cannot be built (no silent fallback to mock)", () => {
    expect(() => makeConfig({ LIARA_DATA_SOURCE: "live" })).toThrow();
  });

  it("a failing live upstream yields errors, never fabricated data", async () => {
    const { svc } = liveService({}, () => new Response("", { status: 500 }));
    const list = await svc.listApps();
    expect(list.ok).toBe(false);
    expect(JSON.stringify(list)).not.toMatch(/demo-|items/);
    const d = await svc.diagnostics({ probe: true });
    expect(d.connectivity).toBe("unreachable");
    expect(d.lastSuccessAt).toBeNull();
  });
});

describe("mock data cases", () => {
  const svc = () => buildService(makeConfig(), { now: NOW });

  it("stopped app: empty metrics and no applets are reported honestly", async () => {
    const m = await svc().getMetrics("demo-worker", "cpu", 60);
    expect(m.ok && m.data.series).toEqual([]);
    const a = await svc().getApplets("demo-worker");
    expect(a.ok && a.data.items).toEqual([]);
  });

  it("running app yields deterministic bounded series with no claimed unit", async () => {
    const a = await svc().getMetrics("demo-shop", "memory", 60);
    const b = await svc().getMetrics("demo-shop", "memory", 60);
    expect(a).toEqual(b);
    expect(a.ok && a.data.unit).toBeNull(); // no unit is claimed without live-verified evidence
    expect(a.ok && a.data.schema).toBe("ok");
    expect(a.ok && a.data.series.length).toBe(2);
    expect(a.ok && a.data.series[0]!.points.length).toBeGreaterThan(30);
  });

  it("release information may be absent", async () => {
    const r = await svc().getReleases("demo-worker");
    expect(r.ok && r.data.releases).toEqual([]);
    expect(r.ok && r.data.currentRelease).toBeNull();
  });

  it("redacts secret-looking text that exists in mock logs", async () => {
    const l = await svc().getLogs("demo-api", 60);
    expect(l.ok).toBe(true);
    const text = JSON.stringify(l);
    expect(text).not.toMatch(/S3cretPass99|abcdef1234567890SIMULATEDTOKEN|admin@example\.invalid/);
    expect(text).toContain("REDACTED");
  });

  it("never exposes env values from mock app details", async () => {
    const d = await svc().getApp("demo-shop");
    expect(JSON.stringify(d)).not.toContain("SIMULATED-NOT-A-REAL-VALUE");
    expect(d.ok && d.data.envKeys.map((k) => k.key)).toEqual(["NODE_ENV", "PORT", "PAYMENT_API_KEY"]);
  });

  it("unknown app in mock → not allowed (same as non-allowlisted)", async () => {
    await expect(svc().getApp("nonexistent")).rejects.toMatchObject({ code: "app_not_allowed" });
  });
});

describe("v1 / v2 logs contract handling", () => {
  it("default strategy uses only the documented v1 endpoint", async () => {
    const { svc, calls } = liveService();
    const r = await svc.getLogs("shop-api", 60);
    expect(r.ok && r.data.source).toBe("v1");
    expect(r.ok && r.meta.contract).toBe("documented");
    expect(calls.map((c) => c.url.pathname)).toEqual(["/v1/projects/shop-api/logs"]);
    expect(calls[0]!.url.searchParams.get("since")).toMatch(/^\d+$/);
  });

  it("v1 contract failure is surfaced, not papered over, when v2 is not enabled", async () => {
    const { svc, calls } = liveService({}, (url) => (url.pathname.includes("/v1/") && url.pathname.endsWith("/logs") ? json({ unexpected: "shape" }) : defaultResponder()(url, undefined as never)));
    const r = await svc.getLogs("shop-api", 60);
    expect(r.ok).toBe(false);
    expect(!r.ok && r.error.code).toBe("contract_mismatch");
    expect(calls.some((c) => c.url.pathname.startsWith("/v2/"))).toBe(false); // never silently tries undocumented endpoints
    const d = await svc.diagnostics({ probe: false });
    // An ordinary page load records the failure but does NOT change the verification level (only explicit probes do).
    expect(d.capabilities.find((c) => c.id === "getLogsV1")).toMatchObject({ health: "failing", lastErrorCode: "contract_mismatch", verification: "DOCUMENTED_UNVERIFIED" });
    expect(d.capabilities.find((c) => c.id === "getLogsV2")!.health).toBe("disabled");
  });

  it("v2 only runs when explicitly enabled, and is labelled observed/undocumented", async () => {
    const { svc, calls } = liveService({ LIARA_LOGS_API: "v2", LIARA_ALLOW_UNDOCUMENTED_ENDPOINTS: "true" });
    const r = await svc.getLogs("shop-api", 60);
    expect(r.ok && r.data.source).toBe("v2");
    expect(r.ok && r.meta.contract).toBe("observed");
    expect(calls.map((c) => c.url.pathname)).toEqual(["/v2/projects/shop-api/logs"]);
    expect(calls[0]!.url.searchParams.get("direction")).toBe("forward");
  });

  it("auto falls back to v2 only on contract-type failures and records why", async () => {
    const { svc, calls } = liveService(
      { LIARA_LOGS_API: "auto", LIARA_ALLOW_UNDOCUMENTED_ENDPOINTS: "true" },
      (url, call) => (url.pathname === "/v1/projects/shop-api/logs" ? new Response("", { status: 404 }) : defaultResponder()(url, call)),
    );
    const r = await svc.getLogs("shop-api", 60);
    expect(r.ok && r.data.source).toBe("v2");
    expect(calls.map((c) => c.url.pathname)).toEqual(["/v1/projects/shop-api/logs", "/v2/projects/shop-api/logs"]);
    const d = await svc.diagnostics({ probe: false });
    expect(d.capabilities.find((c) => c.id === "getLogsV1")).toMatchObject({ health: "failing", lastErrorCode: "not_found" });
    expect(d.capabilities.find((c) => c.id === "getLogsV2")).toMatchObject({ health: "ok", contract: "observed", verification: "CLI_ONLY_UNVERIFIED" });
  });

  it("auto does NOT fall back on server errors (would hide outages)", async () => {
    const { svc, calls } = liveService(
      { LIARA_LOGS_API: "auto", LIARA_ALLOW_UNDOCUMENTED_ENDPOINTS: "true" },
      (url, call) => (url.pathname === "/v1/projects/shop-api/logs" ? new Response("", { status: 401 }) : defaultResponder()(url, call)),
    );
    const r = await svc.getLogs("shop-api", 60);
    expect(r.ok).toBe(false);
    expect(calls.some((c) => c.url.pathname.startsWith("/v2/"))).toBe(false);
  });
});

describe("limits & pagination", () => {
  it("clamps release page/count and log limit before calling upstream", async () => {
    const { svc, calls } = liveService();
    await svc.getReleases("shop-api", 9999, 9999);
    const q = calls[0]!.url.searchParams;
    expect(Number(q.get("page"))).toBeLessThanOrEqual(50);
    expect(Number(q.get("count"))).toBeLessThanOrEqual(20);
    const many = Array.from({ length: 900 }, (_, i) => ({ type: "stdout", datetime: "2026-01-02T03:04:05Z", message: `line ${i}` }));
    const { svc: s2 } = liveService({}, (u, c) => (u.pathname.endsWith("/logs") ? json(many) : defaultResponder()(u, c)));
    const logs = await s2.getLogs("shop-api", 60, 100_000);
    expect(logs.ok && logs.data.lines.length).toBe(500);
    expect(logs.ok && logs.data.truncated).toBe(true);
    expect(logs.ok && logs.data.lines.at(-1)!.message).toBe("line 899"); // keeps the most recent lines
  });
});

describe("diagnostics", () => {
  it("never contains the token or upstream secrets, and reports what is unavailable", async () => {
    const { svc } = liveService({ LIARA_TEAM_ID: "team_1" });
    const d = await svc.diagnostics({ probe: true });
    expect(JSON.stringify(d)).not.toMatch(/CANARY|eyJ/);
    expect(d).toMatchObject({ mode: "live", host: "api.liara.ir", tokenConfigured: true, teamScoped: true, connectivity: "connected", allowlistSize: 2 });
    expect(d.lastSuccessAt).not.toBeNull();
    expect(d.capabilities.filter((c) => c.verification === "LIVE_VERIFIED").length).toBe(8); // explicit probe succeeded for all 8 base capabilities
    expect(d.capabilities.find((c) => c.id === "getLogsV2")).toMatchObject({ verification: "CLI_ONLY_UNVERIFIED", health: "disabled" });
    expect(d.notAvailable.map((n) => n.id)).toEqual(expect.arrayContaining(["horizontalScaling", "rollback", "httpStatusMetrics", "mutations"]));
  });

  it("mock diagnostics are explicitly simulated with no host or token", async () => {
    const svc = buildService(makeConfig(), { now: NOW });
    const d = await svc.diagnostics({ probe: true });
    expect(d).toMatchObject({ mode: "mock", connectivity: "simulated", host: null, tokenConfigured: false, lastSuccessAt: null });
    expect(d.capabilities.every((c) => ["simulated", "disabled"].includes(c.health))).toBe(true);
    expect(d.capabilities.some((c) => c.verification === "LIVE_VERIFIED")).toBe(false); // simulation can never be evidence
    expect(d.verifiedCount).toBe(0);
  });

  it("probe is read-only GET and rate-limited by a short cache", async () => {
    const { svc, calls } = liveService();
    await svc.diagnostics({ probe: true });
    const first = calls.length;
    await svc.diagnostics({ probe: true });
    expect(calls.length).toBe(first); // cached within 20 s
    expect(calls.every((c) => c.method === "GET")).toBe(true);
  });
});

describe("logging never leaks secrets", () => {
  it("log lines from failing upstream calls contain no token / bodies", async () => {
    const lines: string[] = [];
    __setLogSinkForTests((l) => lines.push(l));
    const { svc } = liveService({}, () => new Response(`${CANARY.token} ${CANARY.apiToken}`, { status: 500 }));
    await svc.listApps();
    __setLogSinkForTests(undefined);
    expect(lines.length).toBeGreaterThan(0);
    expect(lines.join("\n")).not.toMatch(/CANARY/);
  });
});
