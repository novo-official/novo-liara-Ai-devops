import { fa } from "@/i18n/fa";
import { faCompact, faDateTime, faTime, relativeFa } from "@/lib/format";
import type { MetricResult } from "@/server/domain/models";
import { isStaleMeasurement } from "@/lib/metrics";

const COLORS = ["var(--chart-1)", "var(--chart-2)", "var(--chart-3)", "var(--chart-4)", "var(--chart-5)"];
const W = 600;
const H = 140;
const PAD = 6;

export { isStaleMeasurement };

/**
 * Dependency-free SVG line chart.
 *  - raw values only: no smoothing, no resampling, no interpolation (lines are broken at gaps, lone points are dots)
 *  - no unit is shown unless it is in the verified-units table
 *  - distinguishes "no data" from "data we cannot interpret"
 *  - the time axis stays left→right (numeric axis convention)
 */
export function MetricChart({ result, label, fetchedAt }: { result: MetricResult; label: string; fetchedAt: string }) {
  if (result.schema === "unsupported") {
    return (
      <p role="alert" data-testid="metric-unsupported" className="rounded-lg border border-warning/40 bg-warning/10 p-4 text-sm text-warning">
        {fa.metrics.unsupported}
      </p>
    );
  }
  const series = result.series.filter((s) => s.points.length > 0);
  if (result.schema === "empty" || series.length === 0) {
    return (
      <p data-testid="metric-empty" className="rounded-lg border border-dashed p-4 text-sm text-muted-foreground">
        {fa.metrics.empty}
      </p>
    );
  }
  const pts = series.flatMap((s) => s.points);
  const tMin = Math.min(...pts.map((p) => p.t));
  const tMax = Math.max(...pts.map((p) => p.t));
  const vMin = Math.min(0, ...pts.map((p) => p.v));
  let vMax = Math.max(...pts.map((p) => p.v));
  if (vMax === vMin) vMax = vMin + 1;
  const x = (t: number) => PAD + ((t - tMin) / Math.max(1, tMax - tMin)) * (W - 2 * PAD);
  const y = (v: number) => H - PAD - ((v - vMin) / (vMax - vMin)) * (H - 2 * PAD);
  const iso = (t: number) => new Date(t * 1000).toISOString();
  const nowSec = Date.parse(fetchedAt) / 1000;
  const unit = result.unit;
  const anyGap = series.some((s) => s.gapsAfter.length > 0);
  const fewPoints = series.some((s) => s.points.length < 3);

  return (
    <figure className="flex flex-col gap-3" data-testid="metric-chart" data-unit={unit ?? "unknown"}>
      <div dir="ltr" className="overflow-hidden rounded-lg bg-muted/40 p-2">
        <svg viewBox={`0 0 ${W} ${H}`} role="img" aria-label={`${label}: ${faCompact(vMin)} – ${faCompact(vMax)}${unit ? ` ${unit}` : ""}`} className="h-36 w-full">
          <title>{label}</title>
          {[0, 0.5, 1].map((f) => (
            <line key={f} x1={PAD} x2={W - PAD} y1={PAD + f * (H - 2 * PAD)} y2={PAD + f * (H - 2 * PAD)} stroke="currentColor" strokeOpacity={0.12} />
          ))}
          {series.map((s, i) => {
            // split into runs at gaps: nothing is drawn across missing data
            const runs: typeof s.points[] = [];
            let cur: typeof s.points = [];
            s.points.forEach((p, idx) => {
              cur.push(p);
              if (s.gapsAfter.includes(idx)) {
                runs.push(cur);
                cur = [];
              }
            });
            if (cur.length) runs.push(cur);
            const color = COLORS[i % COLORS.length];
            return (
              <g key={s.applet ?? i} data-testid="metric-series">
                {runs.map((run, k) =>
                  run.length === 1 ? (
                    <circle key={k} cx={x(run[0]!.t)} cy={y(run[0]!.v)} r={2.5} fill={color} />
                  ) : (
                    <polyline key={k} fill="none" stroke={color} strokeWidth={2} strokeLinejoin="round" vectorEffect="non-scaling-stroke" points={run.map((p) => `${x(p.t).toFixed(1)},${y(p.v).toFixed(1)}`).join(" ")} />
                  ),
                )}
              </g>
            );
          })}
        </svg>
        <div className="mt-1 flex justify-between text-[0.7rem] text-muted-foreground">
          <span>{faTime(iso(tMin))}</span>
          <span>{faTime(iso(tMax))}</span>
        </div>
      </div>
      <figcaption className="flex flex-col gap-2 text-xs text-muted-foreground">
        <span data-testid="metric-unit-note">{unit ? fa.metrics.unit(unit) : fa.metrics.unitUnknown}</span>
        <span>
          {fa.metrics.min}: {faCompact(vMin)} · {fa.metrics.max}: {faCompact(vMax)}
        </span>
        <ul className="flex flex-col gap-1">
          {series.map((s, i) => {
            const last = s.lastObservation;
            const age = last ? nowSec - last.t : null;
            const stale = age !== null && isStaleMeasurement(age, s.stepSeconds);
            return (
              <li key={s.applet ?? i} className="flex flex-wrap items-center gap-x-2 gap-y-0.5" data-testid="metric-last" data-stale={stale ? "true" : "false"}>
                <span aria-hidden className="inline-block size-2.5 rounded-full" style={{ background: COLORS[i % COLORS.length] }} />
                <bdi className="ltr-isolate">{s.applet ?? "—"}</bdi>
                {last ? (
                  <span>
                    {fa.metrics.lastObservation}: {faCompact(last.v)}
                    {unit ? ` ${unit}` : ""} — {faDateTime(iso(last.t))}
                    {age !== null && ` (${relativeFa(age, fa.fresh.ago)})`}
                  </span>
                ) : (
                  <span>{fa.metrics.noObservation}</span>
                )}
                {stale && <strong className="text-warning">{fa.metrics.staleMeasurement}</strong>}
              </li>
            );
          })}
        </ul>
        {anyGap && <span data-testid="metric-sparse">{fa.metrics.sparse}</span>}
        {fewPoints && <span>{fa.metrics.fewPoints}</span>}
        {result.droppedSeries + result.droppedPoints > 0 && <span>{fa.metrics.dropped(result.droppedSeries + result.droppedPoints)}</span>}
      </figcaption>
    </figure>
  );
}
