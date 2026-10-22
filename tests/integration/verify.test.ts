import { describe, expect, it } from "vitest";
import {
  buildPlan,
  observeApp,
  observeApps,
  observeApplets,
  observeEvents,
  observeMetrics,
  observeReleases,
  ordering,
  runVerification,
  timeFormatClass,
  vocabulary,
  type VerifyOptions,
} from "@/server/liara/verify";
import { LiaraError } from "@/server/liara/errors";
import { ALL_CANARIES, CANARY } from "../helpers/canaries";
import { defaultResponder, json, LIVE_ENV, makeConfig, RAW, recordingFetch, type Responder } from "../helpers/live";

const NOW = Date.UTC(2026, 0, 2, 4, 0, 0);
const base: VerifyOptions = { app: "shop-api", probeFormats: false, probeTeam: false, includeV2: false, budget: 25 };
const cfg = (env: Record<string, string | undefined> = {}) => makeConfig({ ...LIVE_ENV, ...env });
const run = (o: Partial<VerifyOptions> = {}, responder: Responder = defaultResponder(), env: Record<string, string | undefined> = {}) => {
  const rec = recordingFetch(responder);
  const p = runVerification(cfg(env), { ...base, ...o }, { fetchImpl: rec.impl, now: () => NOW, sleep: async () => undefined });
  return { p, ...rec };
};
const byId = (r: Awaited<ReturnType<typeof runVerification>>, id: string) => r.checks.find((c) => c.id === id)!;

describe("verification run (synthetic upstream)", () => {
  it("passes against a conforming upstream using only bounded GETs, and never leaks names or secrets", async () => {
    const { p, calls } = run();
    const report = await p;
    expect(report.overall).toBe("PASSED");
    expect(report.checks.filter((c) => c.required).every((c) => c.verdict === "LIVE_VERIFIED")).toBe(true);
    expect(calls.length).toBeLessThanOrEqual(base.budget);
    expect(report.requestsMade).toBe(calls.length);
    for (const c of calls) {
      expect(c.method).toBe("GET");
      expect(c.body).toBeNull();
      expect(c.url.hostname).toBe("api.liara.ir");
    }
    const text = JSON.stringify(report);
    for (const canary of ALL_CANARIES) expect(text).not.toContain(canary);
    expect(text).not.toMatch(/shop-api|shop-web|secret-internal-app/); // names never emitted
    expect(report.app).toBe("app-1");
  });

  it("only touches the selected allowlisted app; unrelated apps are never requested", async () => {
    const { p, calls } = run();
    await p;
    const names = new Set(calls.map((c) => /^\/v\d\/projects\/([^/]+)/.exec(c.url.pathname)?.[1]).filter(Boolean));
    expect([...names]).toEqual(["shop-api"]);
  });

  it("refuses an app outside the allowlist before any network call", async () => {
    const { p, calls } = run({ app: "secret-internal-app" });
    await expect(p).rejects.toMatchObject({ code: "app_not_allowed" });
    expect(calls).toHaveLength(0);
  });

  it("classifies 403 as ACCESS_DENIED, 404 as UNAVAILABLE, 5xx as INCONCLUSIVE, bad shape as CONTRACT_MISMATCH", async () => {
    const r = await run({}, (url, call) => {
      if (url.pathname.endsWith("/events")) return new Response(JSON.stringify({ message: CANARY.apiToken, code: 403 }), { status: 403, headers: { "content-type": "application/json" } });
      if (url.pathname.endsWith("/metrics/cpu")) return new Response("", { status: 404 });
      if (url.pathname.endsWith("/metrics/memory")) return new Response("down", { status: 500 });
      if (url.pathname.endsWith("/logs")) return json({ not: "an array" });
      return defaultResponder()(url, call);
    }).p;
    expect(byId(r, "getEvents")).toMatchObject({ verdict: "ACCESS_DENIED", outcome: "forbidden", httpStatus: 403 });
    expect(byId(r, "getMetricsCpu")).toMatchObject({ verdict: "UNAVAILABLE", httpStatus: 404 });
    expect(byId(r, "getMetricsMemory")).toMatchObject({ verdict: "INCONCLUSIVE" });
    expect(byId(r, "getLogsV1")).toMatchObject({ verdict: "CONTRACT_MISMATCH", outcome: "ok" });
    expect(byId(r, "getLogsV1").contractIssues!.length).toBeGreaterThan(0);
    expect(r.overall).toBe("FAILED");
    // error body STRUCTURE is recorded (key names), the content is not
    expect(byId(r, "getEvents").errorShape).toMatchObject({ kind: "json-object", keys: ["message", "code"] });
    expect(JSON.stringify(r)).not.toContain(CANARY.apiToken);
  });

  it("reports INCONCLUSIVE (not FAILED, not PASSED) when only transport errors occur", async () => {
    const r = await run({}, () => Promise.reject(new TypeError("fetch failed"))).p;
    expect(r.overall).toBe("INCONCLUSIVE");
    expect(r.checks.every((c) => c.verdict === "INCONCLUSIVE")).toBe(true);
  });

  it("never exceeds the request budget, retries included", async () => {
    const { p, calls } = run({ budget: 8 }, () => new Response("down", { status: 503 }));
    const r = await p;
    expect(calls.length).toBeLessThanOrEqual(8);
    expect(r.requestsMade).toBeLessThanOrEqual(8 + 8); // attempts counted by the client; per-call retries are inside the budget
    expect(r.overall).toBe("INCONCLUSIVE");
  });

  it("exercises pagination only when more pages exist", async () => {
    const more = (url: URL, call: never) => (url.pathname.endsWith("/releases") ? json({ ...RAW.releases, total: 25 }) : defaultResponder()(url, call));
    const withPaging = await run({}, more as Responder).p;
    expect(byId(withPaging, "getReleases(page2)").outcome).toBe("ok");
    const without = await run().p;
    expect(byId(without, "getReleases(page2)")).toMatchObject({ verdict: "INCONCLUSIVE", outcome: "skipped" });
  });

  it("format and team probes are opt-in and bounded", async () => {
    const plain = run();
    await plain.p;
    expect(plain.calls.filter((c) => c.url.pathname.endsWith("/logs"))).toHaveLength(1);

    const probes = run({ probeFormats: true, probeTeam: true }, defaultResponder(), { LIARA_TEAM_ID: "team_1" });
    const r = await probes.p;
    const logCalls = probes.calls.filter((c) => c.url.pathname.endsWith("/logs"));
    expect(logCalls.map((c) => c.url.searchParams.get("since")).map((v) => (/^\d{10}$/.test(v!) ? "s" : /^\d{13}$/.test(v!) ? "ms" : "iso"))).toEqual(["s", "iso", "ms"]);
    const noTeam = probes.calls.filter((c) => c.url.pathname === "/v1/projects" && !c.url.searchParams.has("teamID"));
    expect(noTeam).toHaveLength(1);
    expect(byId(r, "listApps(no-team)").observations).toMatchObject({ allowlistedAppPresentWithTeamId: true });
    expect(JSON.stringify(r)).not.toMatch(/team_1/);
  });

  it("v2 is verified only with explicit opt-in on BOTH the flag and the environment", async () => {
    expect(buildPlan(cfg(), base).some((p) => p.id === "getLogsV2")).toBe(false);
    const noEnv = run({ includeV2: true });
    await expect(noEnv.p).rejects.toBeInstanceOf(LiaraError);
    const ok = run({ includeV2: true }, defaultResponder(), { LIARA_ALLOW_UNDOCUMENTED_ENDPOINTS: "true" });
    const r = await ok.p;
    expect(byId(r, "getLogsV2")).toMatchObject({ contract: "observed", verdict: "LIVE_VERIFIED" });
    expect(ok.calls.some((c) => c.url.pathname.startsWith("/v2/"))).toBe(true);
    const plain = run();
    await plain.p;
    expect(plain.calls.some((c) => c.url.pathname.startsWith("/v2/"))).toBe(false);
  });

  it("flags when the selected allowlisted app is missing from the list (team/name problem)", async () => {
    const r = await run({}, (url, call) => (url.pathname === "/v1/projects" ? json({ projects: [{ project_id: "other-app" }] }) : defaultResponder()(url, call))).p;
    expect(byId(r, "listApps").notes.join(" ")).toMatch(/NOT present/);
  });
});

describe("observations record structure, not content", () => {
  it("time format classes", () => {
    const cases: [unknown, string][] = [
      [1767323045, "epoch-seconds"],
      [1767323045.5, "epoch-seconds-fractional"],
      [1767323045000, "epoch-milliseconds"],
      [1767323045000000, "epoch-microseconds"],
      ["1767323045000000000", "epoch-nanoseconds-string"],
      ["2026-01-02T03:04:05Z", "iso8601-utc"],
      ["2026-01-02T03:04:05.123+03:30", "iso8601-offset"],
      ["2026-01-02 03:04:05", "iso8601-no-zone"],
      ["yesterday", "other"],
      [null, "missing"],
    ];
    for (const [v, c] of cases) expect(timeFormatClass(v), String(v)).toBe(c);
  });

  it("vocabulary keeps short sanitised values and summarises the rest", () => {
    const v = vocabulary(["RUNNING", "RUNNING", "x".repeat(60), 5, "token=abcdefghij123", "Pending"]);
    expect(v.values).toMatchObject({ RUNNING: 2, Pending: 1 });
    expect(v.other).toBe(2);
    expect(JSON.stringify(v)).not.toContain("abcdefghij123");
  });

  it("ordering detection", () => {
    expect(ordering([1, 2, 3])).toBe("ascending");
    expect(ordering([3, 2, 1])).toBe("descending");
    expect(ordering([1, 3, 2])).toBe("unsorted");
    expect(ordering([1, 1])).toBe("constant");
    expect(ordering([1])).toBe("insufficient-data");
  });

  it("answers 'are encrypted env values masked?' without recording values", () => {
    const o = observeApp({ project: { status: "RUNNING", scale: 1, envs: [{ key: "A", value: "********", encrypted: true }, { key: "B", value: CANARY.envValue, encrypted: true }, { key: "C", value: CANARY.envValue, encrypted: false }] } });
    expect(o.encryptedValueKinds).toEqual({ values: { "masked-looking": 1, "non-empty-unmasked": 1 }, other: 0 });
    expect(JSON.stringify(o)).not.toContain(CANARY.envValue);
    expect(o.envCount).toBe(3);
  });

  it("metrics: reports units only if the API states one, and never infers one", () => {
    const raw = { end: 1767323100, result: [{ applet: "a-1", values: [[1767323040, "0.12"], [1767323100, "0.15"]] }] };
    const o = observeMetrics(raw, 1767323160_000, 3600, ["a-1"]);
    expect(o.unitKeysFoundInResponse).toEqual([]);
    expect(String(o.unit)).toMatch(/NOT STATED/);
    expect(o).toMatchObject({ timestampFormats: ["epoch-seconds"], valueTypes: ["string"], pairLengths: [2], stepSeconds: { median: 60 }, lastObservationAgeSeconds: 60, seriesLabelsMatchAppletNames: "1/1" });
    const withUnit = observeMetrics({ unit: "cores", result: [] }, NOW, 3600, []);
    expect(withUnit.unitKeysFoundInResponse).toEqual(["unit"]); // reported as evidence, still not applied automatically
  });

  it("apps/applets/releases/events observations", () => {
    expect(observeApps(RAW.apps, "shop-api")).toMatchObject({ itemCount: 4, allowlistedAppPresent: true, createdAtFormat: ["iso8601-utc", "missing"] });
    expect(observeApplets(RAW.applets)).toMatchObject({ count: 1, stateVocabulary: { values: { running: 1 } } });
    expect(observeReleases(RAW.releases, 10)).toMatchObject({ returned: 1, totalVsReturned: "complete", currentReleaseKind: "matches-a-release-tag", gitInfoKeys: ["author", "branch", "commit", "message", "remote", "tags"] });
    const ev = observeEvents(RAW.events, NOW - 3_600_000, NOW);
    expect(ev).toMatchObject({ rowCount: 1, columnCounts: [2], firstCellFormat: ["epoch-nanoseconds-string"] });
    for (const o of [observeApps(RAW.apps, "shop-api"), observeApplets(RAW.applets), observeReleases(RAW.releases, 10), ev]) {
      for (const canary of ALL_CANARIES) expect(JSON.stringify(o)).not.toContain(canary);
    }
  });
});
