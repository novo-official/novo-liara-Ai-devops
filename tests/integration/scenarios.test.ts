import { describe, expect, it } from "vitest";
import { SCENARIOS } from "../scenarios/scenarios";
import { compose, keepNewerThan, mapEvents, mapLogs, runScenario } from "../helpers/scenario-runner";
import { NOW, RUN } from "../helpers/evidence-builder";
import type { Semantics } from "@/server/diagnostics/types";

describe.each(SCENARIOS)("scenario $title", (s) => {
  it("collects the expected evidence (nothing fabricated)", async () => {
    const { evidence } = await runScenario(s.app, s.intent);
    const got = Object.fromEntries(evidence.items.map((i) => [i.source, i.availability]));
    expect(got).toMatchObject(s.evidence);
    for (const i of evidence.items) {
      expect(i.simulated).toBe(true);
      expect(i.mode).toBe("mock");
      expect(i.verification).not.toBe("LIVE_VERIFIED"); // simulation is never evidence of a verified contract
      if (i.availability === "missing" || i.availability === "unsupported") expect(i.data).toBeNull();
    }
  });

  it("detectors emit the expected hypotheses", async () => {
    const { analysis } = await runScenario(s.app, s.intent);
    expect(analysis.findings.map((f) => f.hypothesis).sort()).toEqual([...s.detectorOutputs].sort());
  });

  it("aggregation yields the expected status and ranking", async () => {
    const { analysis } = await runScenario(s.app, s.intent);
    expect(analysis.diagnosis.status).toBe(s.status);
    expect(analysis.diagnosis.hypotheses.map((h) => [h.key, h.confidence])).toEqual(s.ranking);
  });

  it("recommendations are context-appropriate and read-only", async () => {
    const { analysis } = await runScenario(s.app, s.intent);
    expect([...new Set(analysis.recommendations.map((r) => r.risk))].sort()).toEqual(s.riskClasses);
    for (const r of analysis.recommendations) {
      expect(r.executableNow).toBe(false);
      expect(r.risk).not.toBe("R3");
      if (s.mustNotRecommend) expect(r.descriptionFa, r.id).not.toMatch(s.mustNotRecommend);
    }
  });

  it("states its uncertainty, limitations and caveats", async () => {
    const { analysis } = await runScenario(s.app, s.intent);
    expect(analysis.diagnosis.limitations).toEqual(expect.arrayContaining(s.limitations));
    expect([...analysis.diagnosis.caveats].sort()).toEqual([...s.caveats].sort());
  });
});

describe("scenarios are not solved by one keyword or one canned answer", () => {
  it("every scenario produces a distinct diagnosis signature", async () => {
    const sigs = new Set<string>();
    for (const s of SCENARIOS) {
      const { analysis } = await runScenario(s.app, s.intent);
      sigs.add(`${analysis.diagnosis.status}|${analysis.diagnosis.hypotheses.map((h) => `${h.key}:${h.confidence}`).join(",")}|${analysis.recommendations.map((r) => r.id).join(",")}`);
    }
    // healthy and stale-metrics both legitimately report "no anomaly" with different limitations; everything else is unique
    expect(sigs.size).toBeGreaterThanOrEqual(SCENARIOS.length - 1);
  });

  it("intent matters: the same HTTP-500 logs are not examined by the restart intent", async () => {
    const http = await runScenario("demo-http500", "investigate_http_500");
    const restart = await runScenario("demo-http500", "why_restarting");
    expect(http.analysis.diagnosis.hypotheses.map((h) => h.key)).toEqual(["http_500"]);
    expect(restart.analysis.diagnosis.hypotheses.map((h) => h.key)).not.toContain("http_500");
  });

  it("the DB restart-loop scenario under the HTTP-500 intent finds DB/loop evidence but invents no 500s", async () => {
    const { analysis } = await runScenario("demo-api", "investigate_http_500");
    const keys = analysis.diagnosis.hypotheses.map((h) => h.key);
    expect(keys).not.toContain("http_500");
    expect(keys.some((k) => k.startsWith("restart_loop_db"))).toBe(true);
  });
});

describe("fixture mutation: removing the distinguishing evidence changes the verdict", () => {
  const noDb = mapLogs((m) => (/psycopg2|DATABASE_URL/.test(m) ? null : m));

  it("DB loop: without the DB errors the loop stays but no DB cause is claimed", async () => {
    const { analysis } = await runScenario("demo-api", "why_restarting", { mutate: noDb });
    const keys = analysis.diagnosis.hypotheses.map((h) => h.key);
    expect(keys).toContain("crash_loop");
    expect(keys.some((k) => k.includes("db_"))).toBe(false);
    expect(analysis.recommendations.some((r) => /دیتابیس|پایگاه/.test(r.descriptionFa))).toBe(false);
  });

  it("DB loop: a non-database ECONNREFUSED is not database evidence", async () => {
    const { analysis } = await runScenario("demo-api", "why_restarting", { mutate: mapLogs((m) => (/psycopg2/.test(m) ? "Error: connect ECONNREFUSED 127.0.0.1:8080" : m)) });
    expect(analysis.findings.some((f) => f.hypothesis.startsWith("db_"))).toBe(false);
  });

  it("DB loop: keeping only the last two restart cycles is NOT a loop", async () => {
    const { analysis } = await runScenario("demo-api", "why_restarting", { mutate: keepNewerThan(500) }); // cycles at 900s/650s dropped
    expect(analysis.findings.map((f) => f.hypothesis)).not.toContain("crash_loop");
    expect(analysis.findings.find((f) => f.hypothesis === "isolated_restart")?.data.cycles).toBe(2);
    expect(analysis.diagnosis.hypotheses.some((h) => h.key.startsWith("restart_loop_"))).toBe(false);
  });

  it("DB loop: the same DB errors but long BEFORE the restarts are not linked (no merge, no HIGH link)", async () => {
    const { evidence } = await runScenario("demo-api", "why_restarting");
    const shifted = evidence.items.map((i) => (i.source === "logs" && i.data ? { ...i, data: { ...i.data, lines: i.data.lines.map((l) => (/psycopg2/.test(l.message) ? { ...l, time: new Date(Date.parse(l.time!) - 3 * 3_600_000).toISOString() } : l)) } } : i));
    const { analysis } = await runScenario("demo-api", "why_restarting", { mutate: () => shifted as never });
    const keys = analysis.diagnosis.hypotheses.map((h) => h.key);
    expect(keys.some((k) => k.startsWith("restart_loop_"))).toBe(false);
    expect(keys).toEqual(expect.arrayContaining(["crash_loop", "db_connection_refused"]));
  });

  it("OOM: an exit-code-137 is weaker evidence than an explicit OOMKilled signal", async () => {
    const m = compose(
      mapEvents((t) => t.replace(/OOMKilled \(exit code 137\)/, "exited with code 137")),
      (items) => items.map((i) => (i.source === "runtime" && i.data ? ({ ...i, data: { ...i.data, applets: i.data.applets.map((a) => ({ ...a, reason: "process exited with code 137" })) } } as never) : i)),
    );
    const { analysis } = await runScenario("demo-oom", "why_restarting", { mutate: m });
    const top = analysis.diagnosis.hypotheses[0]!;
    expect(top.key).toBe("restart_loop_oom_kill");
    expect(top.confidence).toBe("MEDIUM");
    expect(analysis.diagnosis.limitations).toContain("exit137_not_proof_of_oom");
  });

  it("OOM: with the explicit signals removed, raw memory growth with unknown units proves nothing (LOW only)", async () => {
    const m = compose(mapEvents((t) => (/OOMKilled/.test(t) ? null : t)), (items) => items.map((i) => (i.source === "runtime" && i.data ? ({ ...i, data: { ...i.data, applets: i.data.applets.map((a) => ({ ...a, reason: null })) } } as never) : i)));
    const { analysis } = await runScenario("demo-oom", "why_restarting", { mutate: m });
    const keys = analysis.diagnosis.hypotheses.map((h) => `${h.key}:${h.confidence}`);
    expect(keys).toContain("memory_growth_unverified:LOW");
    expect(keys.some((k) => k.startsWith("oom_kill") || k.includes("memory_pressure") || k.startsWith("restart_loop_oom"))).toBe(false);
  });

  it("OOM with a VERIFIED unit/limit and LOW usage does not claim memory pressure", async () => {
    const sem: Semantics = { memory: { unit: "MiB", limit: 100_000, origin: "test" } };
    const { analysis } = await runScenario("demo-oom", "why_restarting", { semantics: sem });
    expect(analysis.findings.map((f) => f.hypothesis)).not.toContain("memory_pressure");
  });

  it("CPU: the same raw values with PRODUCTION semantics (no verified unit/limit) never produce saturation", async () => {
    const { analysis } = await runScenario("demo-cpu", "why_slow", { semantics: {} });
    expect(analysis.diagnosis.hypotheses).toEqual([]);
    expect(analysis.diagnosis.status).toBe("NO_ANOMALY_IN_EXAMINED_EVIDENCE");
    expect(analysis.diagnosis.limitations).toContain("cpu_units_unverified");
  });

  it("CPU: a larger verified limit turns the same raw values into 'not saturated'", async () => {
    const { analysis } = await runScenario("demo-cpu", "why_slow", { semantics: { cpu: { unit: "cores", limit: 10, origin: "test" } } });
    expect(analysis.diagnosis.hypotheses).toEqual([]);
  });

  it("HTTP 500: swapping status codes removes / changes the finding", async () => {
    const to200 = await runScenario("demo-http500", "investigate_http_500", { mutate: mapLogs((m) => m.replace(/" 500 /g, '" 200 ')) });
    expect(to200.analysis.findings.map((f) => f.hypothesis)).not.toContain("http_500");
    const to502 = await runScenario("demo-http500", "investigate_http_500", { mutate: mapLogs((m) => m.replace(/" 500 /g, '" 502 ')) });
    expect(to502.analysis.findings.map((f) => f.hypothesis)).not.toContain("http_500");
  });

  it("failed release: if the failed release IS the current one, the text says so", async () => {
    const m = (items: never[]) => (items as unknown as import("@/server/diagnostics/types").AnyEvidence[]).map((i) => (i.source === "releases" && i.data ? ({ ...i, data: { ...i.data, currentRelease: "v7" } } as never) : i));
    const { analysis } = await runScenario("demo-badrelease", "recent_deployment_failures", { mutate: m as never });
    const f = analysis.findings.find((x) => x.hypothesis === "release_failed")!;
    expect(f.data.failedIsCurrent).toBe(true);
    expect(f.limitations).not.toContain("failed_release_is_not_current");
  });

  it("conflict: removing the authentication lines removes the contradiction and restores HIGH once the old healthy instance is gone", async () => {
    const noAuth = mapLogs((m) => (/authentication failed/.test(m) ? null : m));
    const a = await runScenario("demo-conflict", "why_restarting", { mutate: noAuth });
    expect(a.analysis.diagnosis.hypotheses.flatMap((h) => h.contradictions.map((c) => c.code))).toEqual(["runtime_running_older_than_restarts"]);
    const young = compose(noAuth, (items) => items.map((i) => (i.source === "runtime" && i.data ? ({ ...i, data: { ...i.data, applets: i.data.applets.map((x) => ({ ...x, since: new Date(NOW - 60_000).toISOString() })) } } as never) : i)));
    const b = await runScenario("demo-conflict", "why_restarting", { mutate: young });
    expect(b.analysis.diagnosis.hypotheses.flatMap((h) => h.contradictions)).toEqual([]);
    expect(b.analysis.diagnosis.hypotheses[0]!.confidence).toBe("HIGH");
  });

  it("stale metrics: even alarming raw values are ignored when stale", async () => {
    const { analysis } = await runScenario("demo-stale", "why_slow", { semantics: { cpu: { unit: "cores", limit: 0.0001, origin: "test" } } });
    expect(analysis.findings).toEqual([]);
  });

  it("insufficient: ONE usable log line is enough to leave the 'insufficient' verdict", async () => {
    const m = (items: import("@/server/diagnostics/types").AnyEvidence[]) =>
      items.map((i) => (i.source === "logs" ? ({ ...i, availability: "available", data: { lines: [{ time: new Date().toISOString(), stream: "stdout", message: "GET / 200" }], truncated: false, source: "v1" } } as never) : i));
    const { analysis } = await runScenario("demo-worker", "why_restarting", { mutate: m });
    expect(analysis.diagnosis.status).toBe("NO_ANOMALY_IN_EXAMINED_EVIDENCE");
  });
});

describe("report citations always resolve to collected evidence", () => {
  it.each(SCENARIOS)("$id", async (s) => {
    const { evidence, analysis } = await runScenario(s.app, s.intent);
    const ids = evidence.ids();
    for (const h of analysis.diagnosis.hypotheses) for (const id of h.evidenceIds) expect(ids.has(id), `${h.key} → ${id}`).toBe(true);
    for (const r of analysis.recommendations) for (const id of r.evidenceIds) expect(ids.has(id)).toBe(true);
    expect([...ids].every((id) => id.startsWith(RUN))).toBe(true);
  });
});
