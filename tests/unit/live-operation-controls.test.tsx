import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it, vi } from "vitest";
import { OperationView, ResultCard } from "@/components/live-deployment";
import { fa } from "@/i18n/fa";
import { liveUi } from "@/i18n/live-fa";
import { LADDER_KEYS } from "@/lib/live-ladder";
import { toResultView, type LiveResultView } from "@/lib/live-result";
import { LIVE_STATES, type LiveState } from "@/server/live/types";

vi.mock("next/navigation", () => ({ useRouter: () => ({ push: () => undefined, refresh: () => undefined }) }));

const OP = "lop_20261022203843_0396e0b4";
const op = (state: LiveState) => ({
  id: OP,
  kind: "deploy_existing_app" as const,
  backend: "api" as const,
  appName: "liara-agent-demo",
  state,
  updatedAt: "2026-10-23T08:12:12.640Z",
  remote: { releaseId: "6ada74737ebf55567c8e9382" },
  ladder: Object.fromEntries(LADDER_KEYS.map((k) => [k, "unknown"])),
  failure: null,
  recoveryFa: [],
  transitions: [],
});
const render = (state: LiveState) => renderToStaticMarkup(<OperationView op={op(state) as never} onChanged={() => undefined} />);

describe("the cancel control is shown only while cancelling is a real option (nothing consumed, nothing started)", () => {
  it.each(LIVE_STATES.map((s) => [s]))("%s", (state) => {
    const html = render(state);
    expect(html.includes('data-testid="live-cancel"'), state).toBe(state === "AWAITING_LIVE_APPROVAL");
  });
  it("APPROVED means execution was claimed (the proposal is consumed): no cancel button, no recovery controls, just progress", () => {
    const html = render("APPROVED");
    for (const id of ["live-cancel", "live-reverify", "live-abandon"]) expect(html).not.toContain(`data-testid="${id}"`);
  });
  it("re-verify / abandon stay available for NEEDS_OPERATOR_REVIEW only", () => {
    for (const s of LIVE_STATES) {
      const html = render(s);
      expect(html.includes('data-testid="live-reverify"'), s).toBe(s === "NEEDS_OPERATOR_REVIEW");
      expect(html.includes('data-testid="live-abandon"'), s).toBe(s === "NEEDS_OPERATOR_REVIEW");
    }
  });
});

describe("release identifier wording: a release id is an identifier, never proof", () => {
  it("the hint says so in Persian and does not claim verification or health", () => {
    for (const hint of [fa.detail.releaseHint, liveUi.flow.result.releaseHint]) {
      expect(hint).toContain("شناسهٔ نسخه");
      expect(hint).toContain("اثبات نمی‌کند");
      expect(hint).not.toMatch(/تأیید شد|راستی‌آزمایی شد|مستقر و/);
    }
  });
  it("the result card shows the hint right next to the release id", () => {
    const view = toResultView({ ...op("DEPLOYED"), evidence: { runtime: "observed", appletsReadable: true } } as never) as LiveResultView;
    const html = renderToStaticMarkup(<ResultCard r={view} source="history" />);
    expect(html).toContain('data-testid="live-result-release"');
    expect(html).toContain('data-testid="live-result-release-hint"');
    expect(html).toContain(liveUi.flow.result.releaseHint);
  });
});
