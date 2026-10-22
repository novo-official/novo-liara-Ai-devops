import { describe, expect, it } from "vitest";
import { assessRuntime, isPositiveRuntime } from "@/server/domain/runtime";
import { classifyAppletState, VERIFIED_APPLET_STATES, VERIFIED_METRIC_UNITS } from "@/server/domain/vocabulary";
import type { Applet } from "@/server/domain/models";
import { analyzePoints, MetricsSchema } from "@/server/liara/schemas";
import { LiaraReadClient, type Transport } from "@/server/liara/read-client";
import { isStaleMeasurement } from "@/components/metric-chart";

const applet = (state: string | null, reason: string | null = null): Applet => ({ id: `a-${state}`, name: "n", since: null, state, reason, releaseTag: null });
const on = { scale: 1, isDeployed: true };

describe("applet state interpretation is cautious and labelled", () => {
  it("has no verified vocabulary yet (nothing may claim live verification)", () => {
    expect(Object.keys(VERIFIED_APPLET_STATES)).toEqual([]);
    expect(Object.keys(VERIFIED_METRIC_UNITS)).toEqual([]);
  });

  it.each([
    ["running", "running"],
    ["Running", "running"],
    ["ready", "running"],
    ["restarting", "restarting"],
    ["CrashLoopBackOff", "restarting"],
    ["Error", "restarting"],
    ["OOMKilled", "restarting"],
    ["Pending", "starting"],
    ["ContainerCreating", "starting"],
    ["stopped", "stopped"],
    ["something-new-and-weird", "unknown"],
    ["", "unknown"],
  ])("%j → %s", (raw, expected) => {
    expect(classifyAppletState(raw).state).toBe(expected);
  });

  it("never labels interpretations as verified while the verified table is empty", () => {
    for (const s of ["running", "restarting", "pending", "stopped"]) expect(classifyAppletState(s).basis).not.toBe("verified");
    expect(classifyAppletState("weird").basis).toBe("none");
    expect(classifyAppletState(null).state).toBe("unknown");
  });

  it("a 'running' applet that reports a failure reason is not healthy evidence", () => {
    expect(classifyAppletState("running", "process exited with code 1").state).toBe("restarting");
    expect(classifyAppletState("running", "").state).toBe("running");
  });
});

describe("runtime assessment: enabled ≠ running ≠ healthy", () => {
  it("scaled-on app with a restarting applet is NOT positive", () => {
    const a = assessRuntime(on, { items: [applet("restarting", "process exited with code 1")] });
    expect(a.enabled).toBe("enabled");
    expect(a.runtime).toBe("restarting");
    expect(isPositiveRuntime(a)).toBe(false);
    expect(a.failureReasons).toEqual(["process exited with code 1"]);
    expect(a.health).toBe("unavailable");
  });

  it("worst applet wins when instances disagree", () => {
    expect(assessRuntime(on, { items: [applet("running"), applet("CrashLoopBackOff")] }).runtime).toBe("restarting");
    expect(assessRuntime(on, { items: [applet("running"), applet("Pending")] }).runtime).toBe("starting");
    expect(assessRuntime(on, { items: [applet("running"), applet("???")] }).runtime).toBe("unknown");
    expect(assessRuntime(on, { items: [applet("running"), applet("stopped")] }).runtime).toBe("unknown"); // mixed: claim nothing
  });

  it("is positive only for enabled + deployed + all running + no failure reasons", () => {
    expect(isPositiveRuntime(assessRuntime(on, { items: [applet("running"), applet("running")] }))).toBe(true);
    expect(isPositiveRuntime(assessRuntime({ scale: 1, isDeployed: false }, { items: [applet("running")] }))).toBe(false);
    expect(isPositiveRuntime(assessRuntime({ scale: 0, isDeployed: true }, { items: [applet("running")] }))).toBe(false);
    expect(isPositiveRuntime(assessRuntime(on, { items: [applet("running", "OOM killed earlier")] }))).toBe(false);
  });

  it("handles disabled, no instances and unavailable applet data distinctly", () => {
    expect(assessRuntime({ scale: 0, isDeployed: true }, { items: [] })).toMatchObject({ enabled: "disabled", runtime: "stopped" });
    expect(assessRuntime(on, { items: [] })).toMatchObject({ enabled: "enabled", runtime: "no_instances" });
    const u = assessRuntime(on, null);
    expect(u).toMatchObject({ runtime: "unavailable", appletsUnavailable: true });
    expect(isPositiveRuntime(u)).toBe(false);
    expect(assessRuntime({ scale: null, isDeployed: null }, { items: [applet("running")] }).enabled).toBe("unknown");
  });

  it("flags heuristic interpretation and keeps raw states", () => {
    const a = assessRuntime(on, { items: [applet("running"), applet("running"), applet("restarting")] });
    expect(a.runtimeIsHeuristic).toBe(true);
    expect(a.byState).toEqual([
      { raw: "running", count: 2, class: "running" },
      { raw: "restarting", count: 1, class: "restarting" },
    ]);
  });
});

describe("metric analysis (no interpolation, no invented units)", () => {
  it("finds the median step, last observation and gaps larger than 3 steps", () => {
    const pts = [0, 60, 120, 180, 600, 660, 720].map((t) => ({ t: 1_767_000_000 + t, v: t }));
    const a = analyzePoints(pts);
    expect(a.stepSeconds).toBe(60);
    expect(a.lastObservation).toEqual(pts[6]);
    expect(a.gapsAfter).toEqual([3]); // gap after the 4th point
  });

  it("handles 0, 1 and 2 points", () => {
    expect(analyzePoints([])).toEqual({ lastObservation: null, gapsAfter: [], stepSeconds: null });
    expect(analyzePoints([{ t: 1_767_000_000, v: 1 }])).toMatchObject({ stepSeconds: null, gapsAfter: [] });
    expect(analyzePoints([{ t: 1_767_000_000, v: 1 }, { t: 1_767_000_060, v: 2 }]).stepSeconds).toBe(60);
  });

  it("projects dropped points and keeps the last point when downsampling", () => {
    const values = Array.from({ length: 1000 }, (_, i) => [1_767_000_000 + i * 10, String(i)]);
    values.push([1_767_010_000, "NaN"], [0, "1"], ["x", "2"]);
    const m = MetricsSchema.parse({ result: [{ applet: "a", values }] });
    expect(m.droppedPoints).toBe(3);
    expect(m.series[0]!.points.length).toBeLessThanOrEqual(241);
    expect(m.series[0]!.lastObservation!.v).toBe(999);
  });

  const client = (payload: unknown, kind: "cpu" | "memory" = "cpu") => {
    const t: Transport = { mode: "live", get: (async () => MetricsSchema.parse(payload)) as Transport["get"] };
    return new LiaraReadClient(t, { logsApi: "v1", allowUndocumented: false, now: () => 1_767_000_000_000 }).getMetrics("some-app", kind, 60);
  };

  it("distinguishes ok / empty / unsupported", async () => {
    expect((await client({ result: [{ applet: "a", values: [[1_766_999_990, "1.5"]] }] })).schema).toBe("ok");
    expect((await client({ result: [] })).schema).toBe("empty");
    // data was sent but none of it is interpretable → NOT "no data"
    expect((await client({ result: [{ applet: "a", values: [["x", "y"], [1]] }] })).schema).toBe("unsupported");
    expect((await client({ result: [{ nope: true }, 5] })).schema).toBe("unsupported");
  });

  it("claims no unit unless it is in the verified table", async () => {
    const m = await client({ result: [{ applet: "a", values: [[1_766_999_990, "1.5"]] }] });
    expect(m.unit).toBeNull();
    const memory = await client({ result: [{ applet: "a", values: [[1_766_999_990, "100000000"]] }] }, "memory");
    expect(memory.unit).toBeNull();
  });

  it("flags stale measurements relative to the sampling step", () => {
    expect(isStaleMeasurement(120, 60)).toBe(false);
    expect(isStaleMeasurement(301, 60)).toBe(true);
    expect(isStaleMeasurement(1000, 300)).toBe(false); // 5 steps of 300 s = 1500 s
    expect(isStaleMeasurement(2000, 300)).toBe(true);
    expect(isStaleMeasurement(400, null)).toBe(true);
  });
});
