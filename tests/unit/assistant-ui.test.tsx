import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it, vi } from "vitest";
import { DiagnosticReportView } from "@/components/diagnostic-report";
import { RunView } from "@/components/run-view";
import { analyze } from "@/server/diagnostics/engine";
import { buildReport } from "@/server/diagnostics/report";
import type { RunRecord } from "@/server/diagnostics/store";
import type { Intent } from "@/server/diagnostics/types";
import { ev, NOW, RUN, type Spec } from "../helpers/evidence-builder";

vi.mock("next/navigation", () => ({ useRouter: () => ({ push: () => undefined, refresh: () => undefined, replace: () => undefined }) }));

const iso = new Date(NOW).toISOString();
const report = (spec: Spec, narrative: Parameters<typeof buildReport>[0]["narrative"] = { status: "ok", source: "mock-simulated", textFa: "[متن شبیه‌سازی‌شده] x", citedEvidenceIds: [] }, intent: Intent = "why_restarting") => {
  const evidence = ev(spec);
  return buildReport({ runId: RUN, app: "demo-app", intent, evidence, analysis: analyze({ runId: RUN, intent, evidence, semantics: {}, now: NOW }), narrative, now: NOW });
};
const run = (over: Partial<RunRecord> = {}): RunRecord => ({
  id: RUN, app: "demo-app", intent: "why_restarting", windowMinutes: 60, mode: "mock", status: "RUNNING", phase: "COLLECTING_EVIDENCE", createdAt: iso, updatedAt: iso, finishedAt: null, retryOf: null, errorCode: null, report: null, transitions: [],
  steps: [{ key: "collect_logs", status: "done" }, { key: "inspect_runtime", status: "running" }, { key: "review_releases", status: "pending" }, { key: "analyze_metrics", status: "skipped" }, { key: "identify_hypotheses", status: "pending" }, { key: "prepare_report", status: "pending" }],
  ...over,
});
const view = (r: RunRecord) => renderToStaticMarkup(<RunView initial={r} />);

describe("live workflow timeline", () => {
  it("shows every step with its state, an aria-live region, and a cancel button while running", () => {
    const html = view(run());
    expect(html).toContain('data-testid="timeline"');
    expect(html).toContain('aria-live="polite"');
    for (const k of ["collect_logs", "inspect_runtime", "review_releases", "analyze_metrics", "identify_hypotheses", "prepare_report"]) expect(html).toContain(`data-step="${k}"`);
    for (const label of ["جمع‌آوری لاگ‌ها و رویدادها", "بررسی وضعیت اجرا", "مرور نسخه‌ها", "تحلیل متریک‌ها", "شناسایی فرضیه‌ها", "آماده‌سازی گزارش"]) expect(html).toContain(label);
    expect(html).toContain('data-status="running"');
    expect(html).toContain("برای این درخواست لازم نیست"); // skipped step
    expect(html).toContain('data-testid="cancel-run"');
    expect(html).not.toContain('data-testid="report"');
    expect(html).toContain("motion-reduce:animate-none"); // spinners respect reduced motion
  });
});

describe("failure and empty states explain themselves in Persian", () => {
  it("authentication failure (access denied on every source)", () => {
    const html = view(run({ status: "FAILED", phase: "GENERATING_REPORT", errorCode: "access_denied", finishedAt: iso, report: report({ availability: { app: "access_denied", runtime: "access_denied", logs: "access_denied", events: "access_denied", releases: "access_denied", memory: "access_denied" } }) }));
    expect(html).toContain('data-code="access_denied"');
    expect(html).toContain("توکن API");
    expect(html).toContain('data-testid="retry-run"');
    expect(html).toContain("شواهد برای تشخیص کافی نیست");
    expect(html).toContain("دسترسی رد شد");
  });

  it("request timeout: clear message, no report, retry offered", () => {
    const html = view(run({ status: "TIMED_OUT", errorCode: "run_timeout", finishedAt: iso }));
    expect(html).toContain("از زمان مجاز بیشتر طول کشید");
    expect(html).toContain('data-testid="no-report"');
    expect(html).toContain('data-testid="retry-run"');
  });

  it("cancelled by the operator: no retry button, no report", () => {
    const html = view(run({ status: "CANCELLED", errorCode: "cancelled_by_operator", finishedAt: iso }));
    expect(html).toContain("توسط شما لغو شد");
    expect(html).not.toContain('data-testid="retry-run"');
    expect(html).not.toContain('data-testid="cancel-run"');
  });

  it("interrupted by a server restart is explained", () => {
    expect(view(run({ status: "FAILED", errorCode: "interrupted_by_restart", finishedAt: iso }))).toContain("راه‌اندازی مجدد");
  });

  it("no evidence at all: a full 'insufficient' report with reasons", () => {
    const html = renderToStaticMarkup(<DiagnosticReportView report={report({})} />);
    expect(html).toContain('data-status="INSUFFICIENT_EVIDENCE"');
    expect(html).toContain("بدون داده (پاسخ موفق ولی خالی)");
    expect(html).toContain('data-testid="missing-evidence"');
  });

  it("unsupported capability and stale data are labelled distinctly", () => {
    const html = renderToStaticMarkup(<DiagnosticReportView report={report({ logs: [{ ago: 5, msg: "x" }], availability: { releases: "unsupported", cpu: "stale" }, omit: ["memory"] })} />);
    expect(html).toContain("پشتیبانی نمی‌شود / در دسترس نیست");
    expect(html).toContain("قدیمی");
    expect(html).toContain('data-availability="unsupported"');
    expect(html).toContain('data-availability="stale"');
  });

  it("every narrative state has its own Persian explanation; the deterministic report is always present", () => {
    for (const [status, text] of [["disabled", "غیرفعال است"], ["timeout", "در زمان مجاز پاسخ نداد"], ["error", "خطا داد"], ["invalid", "معتبر نبود"]] as const) {
      const html = renderToStaticMarkup(<DiagnosticReportView report={report({ logs: [{ ago: 5, msg: "x" }] }, { status, source: status === "disabled" ? "none" : "mock-simulated", citedEvidenceIds: [] })} />);
      expect(html).toContain(`data-testid="narrative" data-status="${status}"`);
      expect(html).toContain(text);
      expect(html).toContain('data-testid="report-summary"');
    }
  });
});

describe("simulated vs real is always explicit", () => {
  it("mock evidence → simulated banner + 'simulation' tags on every evidence item", () => {
    const html = renderToStaticMarkup(<DiagnosticReportView report={report({ logs: [{ ago: 5, msg: "x" }] })} />);
    expect(html).toContain('data-testid="report-mode" data-mode="mock"');
    expect(html).toContain("شبیه‌سازی‌شده");
    expect(html).not.toContain('data-simulated="false"'); // no item is presented as real
    expect(html.match(/data-simulated="true"/g)!.length).toBeGreaterThan(3);
  });

  it("live evidence → real tag, and the contract is still shown as unverified", () => {
    const r = report({ logs: [{ ago: 5, msg: "x" }] });
    const live = { ...r, mode: "live" as const, simulated: false, evidence: r.evidence.map((e) => ({ ...e, mode: "live" as const, simulated: false })) };
    const html = renderToStaticMarkup(<DiagnosticReportView report={live} />);
    expect(html).toContain('data-mode="live"');
    expect(html).toContain("مشاهدهٔ واقعی");
    expect(html).toContain("تأییدنشده");
    expect(html).toContain("DOCUMENTED_UNVERIFIED");
  });

  it("evidence details expose sanitised summaries and excerpts only (never whole logs)", () => {
    const r = report({ logs: [...[10, 20, 30].map((a) => ({ ago: a, msg: `10.0.0.5 - - "GET /x HTTP/1.1" 500 1` })), { ago: 40, msg: "UNIQUE-BENIGN-LINE-777" }], events: [{ ago: 50, msg: "x" }] }, undefined, "investigate_http_500");
    const html = renderToStaticMarkup(<DiagnosticReportView report={r} />);
    expect(html).toContain("[PRIVATE_IP]");
    expect(html).not.toContain("UNIQUE-BENIGN-LINE-777");
    expect(html).not.toContain("10.0.0.5");
    expect(html).toContain("lineCount");
  });
});
