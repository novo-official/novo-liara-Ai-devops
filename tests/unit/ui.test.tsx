import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it } from "vitest";
import { StateBadges } from "@/components/app-status";
import { Freshness } from "@/components/freshness";
import { MetricChart } from "@/components/metric-chart";
import { RuntimePanel } from "@/components/runtime-panel";
import { assessRuntime } from "@/server/domain/runtime";
import type { Applet, MetricResult } from "@/server/domain/models";
import { analyzePoints } from "@/server/liara/schemas";

const applet = (state: string, reason: string | null = null): Applet => ({ id: state, name: "n", since: null, state, reason, releaseTag: null });
const on = { scale: 1, isDeployed: true };
const runtimeBadge = (html: string) => /<[^>]*data-testid="badge-runtime"[^>]*>/.exec(html)![0];

describe("runtime indicators (restarting is never shown as healthy)", () => {
  it("restarting runtime: destructive styling, no success colour, enabled is not green", () => {
    const rt = assessRuntime(on, { items: [applet("restarting", "process exited with code 1")] });
    const html = renderToStaticMarkup(<StateBadges runtime={rt} rawStatus="restarting" />);
    expect(runtimeBadge(html)).toContain('data-runtime="restarting"');
    expect(runtimeBadge(html)).toMatch(/text-destructive/);
    expect(html).not.toMatch(/text-success/);
    expect(html).toMatch(/data-enabled="enabled"/);
  });

  it("running with no failure evidence is the only case that uses the positive colour", () => {
    const ok = renderToStaticMarkup(<StateBadges runtime={assessRuntime(on, { items: [applet("running")] })} />);
    expect(runtimeBadge(ok)).toMatch(/text-success/);
    for (const items of [[applet("running", "OOM killed earlier")], [applet("weird-new-state")], [applet("Pending")], []]) {
      const html = renderToStaticMarkup(<StateBadges runtime={assessRuntime(on, { items })} />);
      expect(runtimeBadge(html), JSON.stringify(items)).not.toMatch(/text-success/);
    }
    const unavailable = renderToStaticMarkup(<StateBadges runtime={assessRuntime(on, null)} />);
    expect(runtimeBadge(unavailable)).toContain('data-runtime="unavailable"');
    expect(runtimeBadge(unavailable)).not.toMatch(/text-success/);
  });

  it("detail panel shows three independent dimensions, reasons, heuristic caveat and 'enabled is not healthy'", () => {
    const html = renderToStaticMarkup(<RuntimePanel a={assessRuntime(on, { items: [applet("restarting", "process exited with code 1")] })} rawStatus="restarting" />);
    expect(html).toContain('data-testid="state-enabled"');
    expect(html).toContain('data-testid="state-runtime"');
    expect(html).toContain('data-testid="state-health"');
    expect(html).toContain('data-health="unavailable"');
    expect(html).toContain("process exited with code 1");
    expect(html).toContain("روشن بودن پیکربندی به معنی سالم بودن نیست");
    expect(html).toContain("تفسیر استنباطی");
    expect(html).toContain("شواهد سلامت");
  });

  it("disabled app is neither green nor blue", () => {
    const html = renderToStaticMarkup(<StateBadges runtime={assessRuntime({ scale: 0, isDeployed: true }, { items: [] })} />);
    expect(html).not.toMatch(/text-success|text-primary/);
  });
});

const T0 = 1_767_000_000;
const series = (pts: [number, number][], applet = "a-1") => {
  const points = pts.map(([t, v]) => ({ t, v }));
  return { applet, points, ...analyzePoints(points) };
};
const result = (over: Partial<MetricResult>): MetricResult => ({ kind: "cpu", unit: null, series: [], windowStart: T0, windowEnd: T0 + 3600, schema: "ok", droppedSeries: 0, droppedPoints: 0, ...over });
const fetchedAt = new Date((T0 + 3600) * 1000).toISOString();

describe("metric chart", () => {
  it("unsupported schema is shown as such — not as 'no data'", () => {
    const html = renderToStaticMarkup(<MetricChart result={result({ schema: "unsupported" })} label="CPU" fetchedAt={fetchedAt} />);
    expect(html).toContain('data-testid="metric-unsupported"');
    expect(html).not.toContain("metric-empty");
  });

  it("empty is distinct from unsupported", () => {
    const html = renderToStaticMarkup(<MetricChart result={result({ schema: "empty" })} label="CPU" fetchedAt={fetchedAt} />);
    expect(html).toContain('data-testid="metric-empty"');
  });

  it("no verified unit → says so and prints no unit; raw min/max only", () => {
    const html = renderToStaticMarkup(<MetricChart result={result({ series: [series([[T0 + 3000, 0.5], [T0 + 3060, 0.7], [T0 + 3120, 0.6]])] })} label="CPU" fetchedAt={fetchedAt} />);
    expect(html).toContain('data-unit="unknown"');
    expect(html).toContain("واحد این متریک در API مستند نشده");
    expect(html).not.toMatch(/millicore|cores|bytes|MiB|%/);
  });

  it("a verified unit is displayed (only when provided by the verified table)", () => {
    const html = renderToStaticMarkup(<MetricChart result={result({ unit: "cores", series: [series([[T0 + 3000, 0.5], [T0 + 3060, 0.7], [T0 + 3120, 0.6]])] })} label="CPU" fetchedAt={fetchedAt} />);
    expect(html).toContain('data-unit="cores"');
    expect(html).toContain("واحد (تأییدشده)");
  });

  it("does not draw across gaps; isolated points become dots; sparse note is shown", () => {
    const s = series([[T0, 1], [T0 + 60, 2], [T0 + 120, 3], [T0 + 1800, 4], [T0 + 1860, 5], [T0 + 3500, 6]]);
    expect(s.gapsAfter.length).toBe(2);
    const html = renderToStaticMarkup(<MetricChart result={result({ series: [s] })} label="CPU" fetchedAt={fetchedAt} />);
    expect((html.match(/<polyline/g) ?? []).length).toBe(2); // two runs with ≥2 points
    expect((html.match(/<circle/g) ?? []).length).toBe(1); // the lone last point
    expect(html).toContain('data-testid="metric-sparse"');
  });

  it("shows the last successful observation and flags stale measurements", () => {
    const stale = series([[T0 + 100, 1], [T0 + 160, 2], [T0 + 220, 3]]); // ends ~55 min before fetchedAt
    const html = renderToStaticMarkup(<MetricChart result={result({ series: [stale] })} label="CPU" fetchedAt={fetchedAt} />);
    expect(html).toContain("آخرین مشاهدهٔ موفق");
    expect(html).toMatch(/data-testid="metric-last" data-stale="true"/);
    expect(html).toContain("اندازه‌گیری قدیمی");
    const fresh = series([[T0 + 3480, 1], [T0 + 3540, 2], [T0 + 3600, 3]]);
    expect(renderToStaticMarkup(<MetricChart result={result({ series: [fresh] })} label="CPU" fetchedAt={fetchedAt} />)).toMatch(/data-stale="false"/);
  });

  it("reports dropped data instead of hiding it", () => {
    const html = renderToStaticMarkup(<MetricChart result={result({ series: [series([[T0 + 3000, 1], [T0 + 3060, 2], [T0 + 3120, 3]])], droppedPoints: 4 })} label="CPU" fetchedAt={fetchedAt} />);
    expect(html).toContain("نامعتبر نادیده گرفته شد");
  });
});

describe("freshness badge", () => {
  it("renders the absolute fetch time before hydration, never a claim of being 'now'", () => {
    const html = renderToStaticMarkup(<Freshness fetchedAt="2026-01-02T03:04:05.000Z" />);
    expect(html).toContain('data-testid="freshness"');
    expect(html).toContain('dateTime="2026-01-02T03:04:05.000Z"');
    expect(html).not.toContain("هم‌اکنون");
  });
});
