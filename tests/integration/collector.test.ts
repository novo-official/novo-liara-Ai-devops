import { describe, expect, it } from "vitest";
import { availabilityForError, collectEvidence, SOURCES_BY_INTENT } from "@/server/diagnostics/evidence";
import type { EvidenceItem, Intent, SourceKey } from "@/server/diagnostics/types";
import { assertNoCanary, CANARY } from "../helpers/canaries";
import { defaultResponder, json, liveService, RAW, type Responder } from "../helpers/live";
import { NOW } from "../helpers/evidence-builder";

const opts = (over: Partial<Parameters<typeof collectEvidence>[1]> = {}) => ({ runId: "run_20260102040000_aabbccdd", app: "shop-api", intent: "why_restarting" as Intent, windowMinutes: 60 as const, now: () => NOW, sourceTimeoutMs: 2000, maxSources: 8, ...over });
const byPath = (patch: Record<string, () => Response | Promise<Response>>, fallback: Responder = defaultResponder()): Responder => (url, call) => {
  for (const [suffix, fn] of Object.entries(patch)) if (url.pathname.endsWith(suffix)) return fn();
  return fallback(url, call);
};
const collect = async (responder: Responder, o: Partial<Parameters<typeof collectEvidence>[1]> = {}, env: Record<string, string> = {}) => {
  const l = liveService(env, responder);
  const set = await collectEvidence(l.svc, opts(o));
  return { set, ...l };
};
const av = (set: Awaited<ReturnType<typeof collect>>["set"]) => Object.fromEntries(set.items.map((i) => [i.source, i.availability])) as Record<SourceKey, string>;

describe("EvidenceCollector (live, synthetic upstream)", () => {
  it("collects every needed source with full metadata and honest provenance", async () => {
    const { set } = await collect(defaultResponder());
    expect(set.items.map((i) => i.source).sort()).toEqual([...SOURCES_BY_INTENT.why_restarting].sort());
    for (const i of set.items) {
      expect(i.id).toBe(`run_20260102040000_aabbccdd/${i.source}`);
      expect(i).toMatchObject({ app: "shop-api", runId: "run_20260102040000_aabbccdd", mode: "live", simulated: false, collectedAt: new Date(NOW).toISOString() });
      expect(i.capability).toMatch(/^get/);
      expect(typeof i.verification).toBe("string");
      expect(i.freshness).toHaveProperty("state");
    }
    expect(new Set(set.items.map((i) => i.id)).size).toBe(set.items.length);
  });

  it("windowed sources carry the time window; app/runtime/releases do not", async () => {
    const { set } = await collect(defaultResponder());
    for (const s of ["logs", "events", "memory"] as const) expect(set.item(s)!.window).toEqual({ from: new Date(NOW - 3_600_000).toISOString(), to: new Date(NOW).toISOString() });
    for (const s of ["app", "runtime", "releases"] as const) expect(set.item(s)!.window).toBeNull();
  });

  it("contract verification status reflects reality: unverified until an explicit probe, LIVE_VERIFIED after one", async () => {
    const l = liveService();
    const before = await collectEvidence(l.svc, opts());
    expect(before.items.every((i) => i.verification === "DOCUMENTED_UNVERIFIED")).toBe(true);
    await l.svc.diagnostics({ probe: true });
    const after = await collectEvidence(l.svc, opts());
    expect(after.items.every((i) => i.verification === "LIVE_VERIFIED")).toBe(true);
  });

  it("each failure kind is a DISTINCT availability state with no data", async () => {
    const status = (code: number) => () => new Response("", { status: code });
    const cases: [string, Record<string, () => Response>, SourceKey, string][] = [
      ["401", { "/logs": status(401) }, "logs", "access_denied"],
      ["403", { "/events": status(403) }, "events", "access_denied"],
      ["404", { "/releases": status(404) }, "releases", "unsupported"],
      ["500", { "/applets": status(500) }, "runtime", "collection_failed"],
      ["429", { "/metrics/memory": status(429) }, "memory", "collection_failed"],
      ["mismatch", { "/logs": () => json({ not: "an array" }) }, "logs", "contract_mismatch"],
    ];
    for (const [label, patch, source, expected] of cases) {
      const { set } = await collect(byPath(patch));
      const item = set.item(source) as EvidenceItem;
      expect(item.availability, label).toBe(expected);
      expect(item.data, label).toBeNull();
      expect(item.errorCode, label).toBeTruthy();
    }
  });

  it("timeouts and network errors are collection failures; other sources are unaffected", async () => {
    const { set } = await collect(byPath({ "/events": () => Promise.reject(Object.assign(new Error("t"), { name: "TimeoutError" })), "/logs": () => Promise.reject(new TypeError("fetch failed")) }));
    expect(av(set)).toMatchObject({ events: "collection_failed", logs: "collection_failed", app: "available", releases: "available" });
  });

  it("empty successful responses are 'missing', not 'available' and not errors", async () => {
    const { set } = await collect(byPath({ "/logs": () => json([]), "/events": () => json({ data: [] }), "/metrics/memory": () => json({ end: 1, result: [] }) }));
    for (const s of ["logs", "events", "memory"] as const) {
      expect(set.item(s)!.availability).toBe("missing");
      expect(set.item(s)!.notes).toContain("empty_response");
      expect(set.item(s)!.data).toBeNull();
    }
  });

  it("metrics with an uninterpretable schema are 'unsupported', distinct from empty", async () => {
    const { set } = await collect(byPath({ "/metrics/memory": () => json({ result: [{ applet: "a", values: [["x", "y"]] }] }) }));
    expect(set.item("memory")).toMatchObject({ availability: "unsupported", data: null, notes: ["metric_schema_unsupported"] });
  });

  it("stale metrics are retained but flagged stale (with age) and unit_unverified", async () => {
    const old = { end: 1, result: [{ applet: "a-1", values: Array.from({ length: 12 }, (_, i) => [Math.floor(NOW / 1000) - 3600 + i * 60, String(100 + i)]) }] };
    const { set } = await collect(byPath({ "/metrics/memory": () => json(old) }));
    const m = set.item("memory")!;
    expect(m.availability).toBe("stale");
    expect(m.freshness.state).toBe("stale");
    expect(m.freshness.ageSec).toBeGreaterThan(2000);
    expect(m.notes).toContain("unit_unverified");
    expect(m.data).not.toBeNull();
  });

  it("fresh metrics are 'available' with no claimed unit", async () => {
    const fresh = { end: 1, result: [{ applet: "a-1", values: [[Math.floor(NOW / 1000) - 120, "1.5"], [Math.floor(NOW / 1000) - 60, "1.6"]] }] };
    const { set } = await collect(byPath({ "/metrics/memory": () => json(fresh) }));
    expect(set.item("memory")).toMatchObject({ availability: "available", data: { unit: null, schema: "ok" } });
  });

  it("is bounded: max sources, one attempt per source, ≤200 log lines, only GET", async () => {
    const many = Array.from({ length: 900 }, (_, i) => ({ type: "stdout", datetime: "2026-01-02T03:30:00Z", message: `line ${i}` }));
    const { set, calls } = await collect(byPath({ "/logs": () => json(many) }), { intent: "why_slow", maxSources: 3 });
    expect(set.items).toHaveLength(3);
    expect(set.item("logs")?.data?.lines.length ?? 0).toBeLessThanOrEqual(200);
    expect(calls.length).toBeLessThanOrEqual(6);
    expect(calls.every((c) => c.method === "GET" && c.body === null)).toBe(true);

    const full = await collect(byPath({ "/logs": () => json(many) }), { intent: "why_slow" });
    expect(full.set.item("logs")!.data!.lines).toHaveLength(200);
    expect(full.set.item("logs")!.data!.truncated).toBe(true);
    expect(full.calls.length).toBeLessThanOrEqual(8); // app fetched once and shared by runtime
    expect(full.calls.filter((c) => c.url.pathname === "/v1/projects/shop-api")).toHaveLength(1);
  });

  it("a hung source times out individually without blocking the run", async () => {
    const hang = () => new Promise<Response>(() => undefined);
    const t0 = Date.now();
    const { set } = await collect(byPath({ "/logs": hang }), { sourceTimeoutMs: 80 });
    expect(Date.now() - t0).toBeLessThan(1500);
    expect(set.item("logs")).toMatchObject({ availability: "collection_failed", errorCode: "timeout" });
    expect(set.item("app")!.availability).toBe("available");
  });

  it("cancellation stops collection with a distinct error", async () => {
    const ac = new AbortController();
    const slow = () => new Promise<Response>((r) => setTimeout(() => r(json(RAW.apps)), 200));
    const l = liveService({}, byPath({ "/applets": slow, "/events": slow, "/logs": slow, "/releases": slow, "/metrics/memory": slow }));
    const p = collectEvidence(l.svc, opts({ signal: ac.signal }));
    setTimeout(() => ac.abort(), 20);
    await expect(p).rejects.toMatchObject({ code: "cancelled" });
  });

  it("never lets sensitive upstream fields into evidence (strict projection + redaction)", async () => {
    const { set } = await collect(defaultResponder());
    assertNoCanary(set.items);
    expect(JSON.stringify(set.item("app")!.data)).not.toContain(CANARY.envValue);
    expect(set.item("app")!.data!.envKeys).toEqual(["DATABASE_URL"]); // keys only; invalid key names dropped
  });

  it("a non-allowlisted app yields no data and makes NO upstream request", async () => {
    const { set, calls } = await collect(defaultResponder(), { app: "secret-internal-app" });
    expect(calls).toHaveLength(0);
    expect(set.items.every((i) => i.availability === "collection_failed" && i.data === null && i.errorCode === "app_not_allowed")).toBe(true);
  });

  it("maps error codes to availability states", () => {
    expect(availabilityForError("unauthorized")).toBe("access_denied");
    expect(availabilityForError("forbidden")).toBe("access_denied");
    expect(availabilityForError("not_found")).toBe("unsupported");
    expect(availabilityForError("unsupported")).toBe("unsupported");
    expect(availabilityForError("contract_mismatch")).toBe("contract_mismatch");
    for (const c of ["timeout", "network", "upstream_error", "rate_limited", "response_too_large", "cancelled", "internal", "anything"]) expect(availabilityForError(c)).toBe("collection_failed");
  });

  it("sources per intent are explicit and bounded", () => {
    for (const intent of Object.keys(SOURCES_BY_INTENT) as Intent[]) {
      expect(SOURCES_BY_INTENT[intent].length).toBeLessThanOrEqual(7);
      expect(new Set(SOURCES_BY_INTENT[intent]).size).toBe(SOURCES_BY_INTENT[intent].length);
    }
  });
});
