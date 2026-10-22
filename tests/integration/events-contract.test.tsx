import { renderToStaticMarkup } from "react-dom/server";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { SectionError } from "@/components/section-card";
import { executeTool, type ToolContext } from "@/server/agent/tools";
import { analyze } from "@/server/diagnostics/engine";
import { collectEvidence } from "@/server/diagnostics/evidence";
import { MockDiagnosticLLMProvider } from "@/server/diagnostics/llm";
import { semanticsFor } from "@/server/diagnostics/semantics";
import { caveatText, availabilityLabel } from "@/i18n/diagnostics-fa";
import { capabilityReport, resetCapabilityState } from "@/server/liara/capabilities";
import { isLiaraError } from "@/server/liara/errors";
import { computeConnectivity } from "@/server/liara/service";
import type { Section } from "@/server/domain/models";
import { LiaraHttpClient } from "@/server/liara/http";
import { z } from "zod";
import { runVerification, type VerifyOptions } from "@/server/liara/verify";
import { __resetApiLimiterForTests } from "@/server/security/guard";
import { __clearSessionsForTests, createSession } from "@/server/security/session";
import { MemoryRunStore } from "@/server/diagnostics/store";
import { DiagnosticRunManager } from "@/server/diagnostics/workflow";
import { ALL_CANARIES, assertNoCanary, CANARY } from "../helpers/canaries";
import { defaultResponder, installService, json, liveService, LIVE_ENV, makeConfig, recordingFetch, resetAll, type Responder } from "../helpers/live";
import * as eventsRoute from "@/app/api/apps/[name]/events/route";

const NOW = Date.UTC(2026, 0, 2, 4, 0, 0);
const APP = "shop-api";
const EVENTS_PATH = `/v1/projects/${APP}/events`;
const VALID = { data: [{ metaData: { secret: CANARY.apiToken }, values: [["1767323045000000000", "Applet started"]] }] };

const withEvents = (events: () => Response): Responder => (url, call) => (url.pathname === EVENTS_PATH ? events() : defaultResponder()(url, call));
const noContent = () => new Response(null, { status: 204 });
/** a response that CLAIMS 204 but carries a body (a real fetch never does this): reading/parsing it must never happen */
function weird204(probe: { read: boolean; cancelled: boolean }): Response {
  return {
    status: 204,
    ok: true,
    headers: new Headers({ "content-type": "application/json" }),
    body: { getReader: () => ((probe.read = true), { read: async () => ({ done: true, value: undefined }) }), cancel: async () => void (probe.cancelled = true) },
    json: async () => {
      probe.read = true;
      throw new Error("must not be parsed");
    },
    text: async () => {
      probe.read = true;
      return `${CANARY.apiToken}`;
    },
  } as unknown as Response;
}
const events = async (responder: Responder, env: Record<string, string | undefined> = {}) => {
  const s = liveService(env, responder);
  return { ...s, section: await s.svc.getEvents(APP, 60) };
};
const errOf = <T,>(s: Section<T>) => (s.ok ? null : s.error);
/** the transport-level error (status and no-content details live here; Sections only carry the code) */
async function transportError(responder: Responder) {
  const rec = recordingFetch(responder);
  const http = new LiaraHttpClient({ baseUrl: new URL("https://api.liara.ir"), token: new (await import("@/server/security/secret")).Secret(CANARY.token), teamId: null, timeoutMs: 5000, maxConcurrency: 2, maxRps: 50, fetchImpl: rec.impl, sleep: async () => undefined, now: () => NOW });
  try {
    await http.get("getEvents", { name: APP, query: { start: 1, end: 2 } }, z.unknown());
    return { err: null, calls: rec.calls };
  } catch (e) {
    return { err: isLiaraError(e) ? e : null, calls: rec.calls };
  }
}

beforeEach(() => {
  resetCapabilityState();
  __clearSessionsForTests();
  __resetApiLimiterForTests();
});
afterEach(resetAll);

describe("Events adapter: every documented and undocumented answer is represented explicitly", () => {
  it("HTTP 200 with valid data → rows (the documented contract)", async () => {
    const { section, calls } = await events(withEvents(() => json(VALID)));
    expect(section.ok && section.data.rows.map((r) => r.text)).toEqual(["Applet started"]);
    expect(calls.filter((c) => c.url.pathname === EVENTS_PATH)).toHaveLength(1);
    assertNoCanary(JSON.stringify(section));
  });
  it("HTTP 200 with data: [] → a SUCCESSFUL empty list (distinct from 204)", async () => {
    const { section } = await events(withEvents(() => json({ data: [] })));
    expect(section.ok && section.data.rows).toEqual([]);
  });
  it("HTTP 204 with no body → explicit no_content: status kept, one request (no retry), nothing parsed, not an empty list", async () => {
    const { section, calls } = await events(withEvents(noContent));
    expect(section.ok).toBe(false);
    const e = errOf(section)!;
    expect(e.code).toBe("no_content");
    expect(e.code).not.toBe("contract_mismatch");
    const t = await transportError(withEvents(noContent));
    expect(t.err).toMatchObject({ code: "no_content", status: 204 });
    expect(t.err!.opts.noContent).toEqual({ unexpectedBody: false });
    expect(calls.filter((c) => c.url.pathname === EVENTS_PATH)).toHaveLength(1); // 204 is not retryable
    expect(calls.every((c) => c.method === "GET" && c.body === null)).toBe(true);
    expect(JSON.stringify(section)).not.toMatch(/"rows"/); // an empty history is never invented
  });
  it("HTTP 204 with an unexpected body → still no_content; the body is cancelled, never read or parsed, never echoed", async () => {
    const probe = { read: false, cancelled: false };
    const { section } = await events(withEvents(() => weird204(probe)));
    expect(errOf(section)!.code).toBe("no_content");
    expect(probe).toEqual({ read: false, cancelled: true });
    const probe2 = { read: false, cancelled: false };
    const t = await transportError(withEvents(() => weird204(probe2)));
    expect(t.err).toMatchObject({ code: "no_content", status: 204 });
    expect(t.err!.opts.noContent).toEqual({ unexpectedBody: true });
    expect(probe2).toEqual({ read: false, cancelled: true });
    assertNoCanary(JSON.stringify(section));
  });
  it("HTTP 205 is treated the same (no content)", async () => {
    const { section } = await events(withEvents(() => new Response(null, { status: 205 })));
    expect(errOf(section)!.code).toBe("no_content");
  });
  it("401 / 403 / 404 / 500 keep their existing meanings", async () => {
    const codes: [number, string][] = [[401, "unauthorized"], [403, "forbidden"], [404, "not_found"], [500, "upstream_error"]];
    for (const [status, code] of codes) {
      const { section } = await events(withEvents(() => new Response(JSON.stringify({ message: CANARY.apiToken }), { status, headers: { "content-type": "application/json" } })));
      expect(errOf(section)!.code, String(status)).toBe(code);
      assertNoCanary(JSON.stringify(section)); // upstream error bodies are never copied
    }
  });
  it("invalid JSON and malformed schemas are contract_mismatch (distinct from no_content)", async () => {
    const bad: (() => Response)[] = [() => new Response("{not json", { status: 200, headers: { "content-type": "application/json" } }), () => json({}), () => json({ data: "nope" }), () => json([1, 2]), () => new Response("<html>", { status: 200, headers: { "content-type": "text/html" } })];
    for (const r of bad) {
      const { section } = await events(withEvents(r));
      expect(errOf(section)!.code).toBe("contract_mismatch");
    }
  });
  it("a 200 with an EMPTY body is a contract mismatch, not no_content (only 204/205 mean no content)", async () => {
    const { section } = await events(withEvents(() => new Response("", { status: 200, headers: { "content-type": "application/json" } })));
    expect(errOf(section)!.code).toBe("contract_mismatch");
  });
});

describe("strict verification report: reachability is not schema verification", () => {
  const base: VerifyOptions = { app: APP, probeFormats: false, probeTeam: false, includeV2: false, budget: 25 };
  const run = (responder: Responder) => {
    const rec = recordingFetch(responder);
    return runVerification(makeConfig({ ...LIVE_ENV }), base, { fetchImpl: rec.impl, now: () => NOW, sleep: async () => undefined }).then((r) => ({ r, ...rec }));
  };
  const check = (r: Awaited<ReturnType<typeof runVerification>>, id: string) => r.checks.find((c) => c.id === id)!;

  it("the live observation: seven endpoints verified, events 204 → INCONCLUSIVE (reached, schema unverified, undocumented status), overall INCONCLUSIVE — never PASSED, never silently FAILED", async () => {
    const { r, calls } = await run(withEvents(noContent));
    const ev = check(r, "getEvents");
    expect(ev).toMatchObject({ verdict: "INCONCLUSIVE", outcome: "no_content", httpStatus: 204, reachability: "reached", schemaVerification: "unverified", undocumentedStatus: 204 });
    expect(ev.verdict).not.toBe("LIVE_VERIFIED");
    expect(ev.notes.join(" ")).toMatch(/does NOT prove/);
    expect(ev.notes.join(" ")).toMatch(/NOT validated/);
    for (const id of ["listApps", "getApp", "getApplets", "getReleases", "getLogsV1", "getMetricsCpu", "getMetricsMemory"]) expect(check(r, id), id).toMatchObject({ verdict: "LIVE_VERIFIED", reachability: "reached", schemaVerification: "verified" });
    expect(r.overall).toBe("INCONCLUSIVE");
    expect(r.requestsMade).toBe(calls.length);
    const reach = r.findings.reachability as { endpointsReached: string[]; schemaVerified: string[]; reachedButSchemaUnverified: { id: string; httpStatus: number | null }[]; undocumentedStatuses: { id: string; httpStatus: number }[] };
    expect(reach.endpointsReached).toContain("getEvents");
    expect(reach.schemaVerified).not.toContain("getEvents");
    expect(reach.reachedButSchemaUnverified).toEqual([{ id: "getEvents", outcome: "no_content", httpStatus: 204 }]);
    expect(reach.undocumentedStatuses).toEqual([{ id: "getEvents", httpStatus: 204 }]);
    for (const c of ALL_CANARIES) expect(JSON.stringify(r)).not.toContain(c);
  });
  it("a conforming events answer still PASSES: 200 with data and 200 with data: [] are LIVE_VERIFIED", async () => {
    for (const body of [VALID, { data: [] }]) {
      const { r } = await run(withEvents(() => json(body)));
      expect(check(r, "getEvents")).toMatchObject({ verdict: "LIVE_VERIFIED", schemaVerification: "verified" });
      expect(r.overall).toBe("PASSED");
    }
  });
  it("other statuses keep their verdicts and report reachability honestly", async () => {
    const mk = (status: number) => () => new Response("{}", { status, headers: { "content-type": "application/json" } });
    const cases: [number, string, string][] = [[401, "ACCESS_DENIED", "reached"], [403, "ACCESS_DENIED", "reached"], [404, "UNAVAILABLE", "reached"], [500, "INCONCLUSIVE", "reached"]];
    for (const [status, verdict, reach] of cases) {
      const { r } = await run(withEvents(mk(status)));
      expect(check(r, "getEvents"), String(status)).toMatchObject({ verdict, reachability: reach, schemaVerification: "unverified" });
    }
    const { r } = await run(withEvents(() => json({ data: "x" })));
    expect(check(r, "getEvents")).toMatchObject({ verdict: "CONTRACT_MISMATCH", reachability: "reached", schemaVerification: "mismatch" });
    const net = await run((url, call) => {
      if (url.pathname === EVENTS_PATH) throw new TypeError("network down");
      return defaultResponder()(url, call);
    });
    expect(check(net.r, "getEvents")).toMatchObject({ verdict: "INCONCLUSIVE", reachability: "not_reached" });
  });
  it("historical reports (without the new optional fields) remain valid objects of the same shape", () => {
    const old = { id: "getEvents", endpoint: "GET …", contract: "documented", required: true, verdict: "CONTRACT_MISMATCH", outcome: "contract_mismatch", durationMs: 1, notes: [] };
    expect(old).not.toHaveProperty("reachability");
    expect(() => JSON.stringify(old)).not.toThrow();
  });
});

describe("narrowly scoped events-only re-check (GET-only; needs explicit operator approval at the script)", () => {
  const only: VerifyOptions = { app: APP, probeFormats: false, probeTeam: false, includeV2: false, only: "getEvents", budget: 8 };
  const go = async (responder: Responder) => {
    const rec = recordingFetch(responder);
    const r = await runVerification(makeConfig({ ...LIVE_ENV }), only, { fetchImpl: rec.impl, now: () => NOW, sleep: async () => undefined });
    return { r, ...rec };
  };
  it("the plan is exactly ONE documented GET of the events endpoint", async () => {
    const { buildPlan } = await import("@/server/liara/verify");
    const plan = buildPlan(makeConfig({ ...LIVE_ENV }), only);
    expect(plan).toHaveLength(1);
    expect(plan[0]).toMatchObject({ id: "getEvents", contract: "documented", required: true });
    expect(plan[0]!.endpoint).toMatch(/events\?start&end/);
  });
  it("it performs exactly one request (GET, no body, one app), and reports INCONCLUSIVE on 204 / PASSED on a conforming 200", async () => {
    const a = await go(withEvents(noContent));
    expect(a.calls.map((c) => `${c.method} ${c.url.pathname}`)).toEqual([`GET ${EVENTS_PATH}`]);
    expect(a.calls[0]!.body).toBeNull();
    expect(a.r.overall).toBe("INCONCLUSIVE");
    expect(a.r.checks).toHaveLength(1);
    expect(a.r.checks[0]).toMatchObject({ verdict: "INCONCLUSIVE", outcome: "no_content", httpStatus: 204 });
    expect(a.r.findings.scopeOfRun).toMatch(/events-only/);
    const b = await go(withEvents(() => json({ data: [] })));
    expect(b.calls).toHaveLength(1);
    expect(b.r.overall).toBe("PASSED");
    for (const c of ALL_CANARIES) expect(JSON.stringify([a.r, b.r])).not.toContain(c);
  });
  it("it refuses an app outside the allowlist before any request", async () => {
    const rec = recordingFetch(withEvents(noContent));
    await expect(runVerification(makeConfig({ ...LIVE_ENV }), { ...only, app: "secret-internal-app" }, { fetchImpl: rec.impl, now: () => NOW })).rejects.toMatchObject({ code: "app_not_allowed" });
    expect(rec.calls).toHaveLength(0);
  });
});

describe("capability state, connectivity and the dashboard: partial availability, honest labels", () => {
  it("after a probe that gets 204 the capability is 'no_content' (not failing, not ok), its verification does NOT change, and connectivity is degraded — not unusable", async () => {
    const { svc } = liveService({}, withEvents(noContent));
    await svc.listApps({ probe: true });
    await svc.getEvents(APP, 60, { probe: true });
    const d = await svc.diagnostics({ probe: false });
    const ev = d.capabilities.find((c) => c.id === "getEvents")!;
    expect(ev.health).toBe("no_content");
    expect(ev.verification).toBe("DOCUMENTED_UNVERIFIED");
    expect(ev.lastErrorCode).toBe("no_content");
    expect(d.capabilities.find((c) => c.id === "listApps")!.health).toBe("ok");
    expect(d.connectivity).toBe("degraded");
    expect(d.issues).toEqual([{ capability: "getEvents", kind: "no_content", code: "no_content" }]);
  });
  it("a later conforming answer clears the state", async () => {
    let mode: "204" | "200" = "204";
    const { svc } = liveService({}, withEvents(() => (mode === "204" ? noContent() : json(VALID))));
    await svc.getEvents(APP, 60);
    mode = "200";
    await svc.getEvents(APP, 60);
    expect(capabilityReport("live", false).find((c) => c.id === "getEvents")!.health).toBe("ok");
  });
  it("computeConnectivity never reports 'connected' while a capability is in no_content", () => {
    const caps = capabilityReport("live", false).map((c) => (c.id === "listApps" ? { ...c, health: "ok" as const } : c.id === "getEvents" ? { ...c, health: "no_content" as const, lastErrorCode: "no_content" } : c));
    expect(computeConnectivity("live", caps, 5).connectivity).toBe("degraded");
  });
  it("the events API route answers 502 no_content with a Persian explanation (other routes keep working)", async () => {
    const { cfg, svc } = liveService({ LIARA_ALLOWED_APPS: APP, APP_ACCESS_PASSWORD_HASH: LIVE_ENV.APP_ACCESS_PASSWORD_HASH }, withEvents(noContent));
    installService(cfg, svc);
    const s = createSession();
    const res = await eventsRoute.GET(new Request(`http://localhost:3000/api/apps/${APP}/events?window=60`, { headers: { cookie: `liara_agent_session=${s.id}` } }), { params: Promise.resolve({ name: APP }) });
    expect(res.status).toBe(502);
    const text = await res.text();
    expect(JSON.parse(text).error.code).toBe("no_content");
    expect(text).toMatch(/۲۰۴|204/);
    assertNoCanary(text);
  });
  it("the dashboard shows a WARNING panel (not an error, not 'no events') for no_content", () => {
    const html = renderToStaticMarkup(<SectionError code="no_content" />);
    expect(html).toContain('data-code="no_content"');
    expect(html).toContain('data-severity="warning"');
    expect(html).toContain("محتوایی نفرستاد");
    expect(html).not.toContain("رویدادی ثبت نشده"); // never rendered as an empty history
    expect(renderToStaticMarkup(<SectionError code="contract_mismatch" />)).toContain('data-severity="error"');
  });
});

describe("evidence and diagnosis: the event source is no_content, never an invented empty history", () => {
  const collect = (responder: Responder, intent: "why_restarting" | "investigate_http_500" = "why_restarting") => {
    const { svc } = liveService({}, responder);
    return collectEvidence(svc, { runId: "run_20260102040000_aabbccdd", app: APP, intent, windowMinutes: 60, now: () => NOW, sourceTimeoutMs: 5000, maxSources: 8 }).then((evidence) => ({ evidence, svc }));
  };
  it("events evidence is 'no_content' with provenance kept; every other source is collected normally; nothing is simulated", async () => {
    const { evidence } = await collect(withEvents(noContent));
    const ev = evidence.item("events")!;
    expect(ev.availability).toBe("no_content");
    expect(ev.errorCode).toBe("no_content");
    expect(ev.data).toBeNull();
    expect(ev.notes).not.toContain("empty_response"); // 'missing' (empty success) is a different state
    expect(ev.mode).toBe("live");
    expect(ev.simulated).toBe(false);
    expect(ev.verification).toBe("DOCUMENTED_UNVERIFIED");
    expect(ev.capability).toBe("getEvents");
    for (const k of ["app", "runtime", "releases", "logs"] as const) expect(evidence.item(k)!.availability, k).toBe("available");
    expect(evidence.items.every((i) => !i.simulated && i.mode === "live")).toBe(true);
  });
  it("200 with data: [] stays 'missing' (answered, nothing observed) — different from no_content", async () => {
    const { evidence } = await collect(withEvents(() => json({ data: [] })));
    expect(evidence.item("events")!.availability).toBe("missing");
    expect(evidence.item("events")!.notes).toContain("empty_response");
  });
  it("the diagnosis lists the event source as missing evidence with its availability, adds the no_content caveat, and is NOT a healthy verdict", async () => {
    const { evidence } = await collect(withEvents(noContent));
    const a = analyze({ runId: "run_20260102040000_aabbccdd", intent: "why_restarting", evidence, semantics: semanticsFor(APP, "live"), now: NOW });
    expect(a.diagnosis.missingEvidence).toContainEqual({ source: "events", availability: "no_content", evidenceId: evidence.item("events")!.id });
    expect(a.diagnosis.caveats).toContain("no_content_observed");
    expect(a.diagnosis.caveats).toContain("contract_unverified");
    expect(a.diagnosis.status).not.toBe("ISSUES_FOUND"); // nothing was invented from the missing events
    if (a.diagnosis.status === "NO_ANOMALY_IN_EXAMINED_EVIDENCE") expect(a.diagnosis.overallConfidence).toBe("LOW");
    expect(caveatText.no_content_observed).toMatch(/سالم/);
    expect(availabilityLabel.no_content).toMatch(/۲۰۴/);
  });
  it("with events no_content AND logs failing, the diagnosis is INSUFFICIENT_EVIDENCE, never a false 'no anomaly'", async () => {
    const r: Responder = (url, call) => (url.pathname === EVENTS_PATH ? noContent() : url.pathname === `/v1/projects/${APP}/logs` ? new Response("{}", { status: 500 }) : defaultResponder()(url, call));
    const { evidence } = await collect(r);
    expect(evidence.item("events")!.availability).toBe("no_content");
    expect(evidence.item("logs")!.availability).toBe("collection_failed");
    const a = analyze({ runId: "run_20260102040000_aabbccdd", intent: "why_restarting", evidence, semantics: semanticsFor(APP, "live"), now: NOW });
    expect(a.diagnosis.status).toBe("INSUFFICIENT_EVIDENCE");
    expect(a.diagnosis.overallConfidence).toBe("INSUFFICIENT_EVIDENCE");
    expect(a.recommendations.some((x) => /verify:liara-readonly/.test(JSON.stringify(x)))).toBe(true);
  });
  it("restart claims cannot come from events that were never observed", async () => {
    const { evidence } = await collect(withEvents(noContent));
    const a = analyze({ runId: "run_20260102040000_aabbccdd", intent: "why_restarting", evidence, semantics: semanticsFor(APP, "live"), now: NOW });
    expect(a.findings.filter((f) => f.evidenceIds.includes(evidence.item("events")!.id))).toEqual([]);
  });
  it("the agent tool returns availability 'no_content' and NO events (null), not an empty list", async () => {
    const { svc } = liveService({}, withEvents(noContent));
    const ctx: ToolContext = { svc, runId: "run_20260102040000_aabbccdd", app: APP, windowMinutes: 60, now: () => NOW, sourceTimeoutMs: 3000, budget: { max: 12, used: 0 }, evidence: new Map(), provider: new MockDiagnosticLLMProvider("ok"), semantics: semanticsFor(APP, "live"), report: { current: null }, audit: async () => undefined, actor: "agent" };
    const res = await executeTool(ctx, "get_recent_events", { app: APP, windowMinutes: 60 });
    expect(res).toMatchObject({ ok: true, availability: "no_content" });
    expect((res as { output: { events: unknown } }).output.events).toBeNull();
  });
});

describe("overall read workflow: partial success is reported, nothing becomes unusable", () => {
  it("a full diagnostic run with events no_content COMPLETES WITH GAPS (not failed), cites the gap, and says it is not a health confirmation", async () => {
    const { svc } = liveService({}, withEvents(noContent));
    const m = new DiagnosticRunManager({ svc, store: new MemoryRunStore(), provider: new MockDiagnosticLLMProvider("ok"), now: () => NOW, runTimeoutMs: 5000, sourceTimeoutMs: 2000 });
    const started = await m.start({ sessionId: "session-A-secret-id", app: APP, intent: "why_restarting" });
    await m.waitFor(started.id);
    const run = (await m.get(started.id, "session-A-secret-id"))!;
    expect(run.status).toBe("COMPLETED_WITH_GAPS");
    expect(run.report!.missingEvidence.some((x) => x.source === "events" && x.availability === "no_content")).toBe(true);
    expect(run.report!.evidence.find((e) => e.source === "events")!.availability).toBe("no_content");
    expect(run.report!.evidence.filter((e) => e.source !== "events").every((e) => ["available", "stale"].includes(e.availability))).toBe(true); // other sources keep working (metrics are merely stale with the fixed test clock)
    expect(JSON.stringify(run.report)).toContain("no_content_observed");
    assertNoCanary(JSON.stringify(run));
  });
  it("the dashboard service still serves apps, app details, applets, releases, logs and metrics while events answers 204", async () => {
    const { svc } = liveService({}, withEvents(noContent));
    const results = await Promise.all([svc.listApps(), svc.getApp(APP), svc.getApplets(APP), svc.getReleases(APP), svc.getLogs(APP, 60), svc.getMetrics(APP, "cpu", 60), svc.getMetrics(APP, "memory", 60), svc.getEvents(APP, 60)]);
    expect(results.map((r) => r.ok)).toEqual([true, true, true, true, true, true, true, false]);
  });
});

describe("no silent mock fallback and no secret leakage", () => {
  it("live mode with a 204 never consults the mock fixtures: the service stays live and the simulated event text never appears", async () => {
    const { svc, calls, section } = await events(withEvents(noContent));
    expect(svc.mode).toBe("live");
    expect(section.ok).toBe(false);
    expect(calls.some((c) => c.url.pathname === EVENTS_PATH)).toBe(true);
    const mock = makeConfig();
    expect(mock.dataSource).toBe("mock"); // a different, explicit configuration — never reached by fallback
    expect(JSON.stringify(section)).not.toMatch(/simulated|demo-/i);
  });
  it("a hostile 204/error body, token and canaries are in no output of the adapter, evidence, report or route", async () => {
    const probe = { read: false, cancelled: false };
    const { svc } = liveService({}, withEvents(() => weird204(probe)));
    const ev = await collectEvidence(svc, { runId: "run_20260102040000_aabbccdd", app: APP, intent: "why_restarting", windowMinutes: 60, now: () => NOW, sourceTimeoutMs: 5000, maxSources: 8 });
    const a = analyze({ runId: "run_20260102040000_aabbccdd", intent: "why_restarting", evidence: ev, semantics: semanticsFor(APP, "live"), now: NOW });
    assertNoCanary(JSON.stringify([ev.items, a]));
    expect(isLiaraError(new Error("x"))).toBe(false);
  });
});
