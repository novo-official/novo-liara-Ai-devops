import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it, vi } from "vitest";
import { LiveDeploymentView } from "@/components/live-deployment";
import { liveUi } from "@/i18n/live-fa";
import { explainNewAppBlockers } from "@/lib/live-blockers";
import type { LiveStatus } from "@/server/live/service";
import { harness, OWNER } from "../helpers/live-exec";

vi.mock("next/navigation", () => ({ useRouter: () => ({ push: () => undefined, refresh: () => undefined }) }));

const APP = "liara-agent-demo";
type H = Awaited<ReturnType<typeof harness>>;
const ready = { verdict: "READY", frameworkFa: "Next.js" };

/** the REAL status document of the real service. `units`/`network` = the two prerequisites that exist only for creating a NEW application */
async function world(o: { units?: boolean; network?: boolean; env?: Record<string, string | undefined> } = {}) {
  const env: Record<string, string | undefined> = { ...(o.units === false ? { LIARA_PLAN_UNITS_JSON: undefined } : {}), ...(o.network === false ? { LIARA_NETWORK_ID: undefined } : {}), ...o.env };
  const h = await harness({ env });
  h.fake.apps.add(APP);
  h.fake.releaseIds.push("rel_old_1");
  return { h, status: await h.svc.status(OWNER, h.runId) };
}
const render = (h: H, status: LiveStatus, section: "existing" | "new") => renderToStaticMarkup(<LiveDeploymentView status={status} runId={h.runId} defaultApp="" readiness={ready} section={section} onChanged={() => undefined} />);
const badgeTag = (html: string) => /<[a-z]+[^>]*data-testid="live-state-badge"[^>]*>/.exec(html)![0];
const panelState = (html: string) => /data-testid="live-panel" data-state="([A-Z_]+)"/.exec(html)![1];
const badgeState = (html: string) => /data-testid="live-state-badge" data-state="([A-Z_]+)"/.exec(html)![1];

describe("the header badge follows the ACTIVE section", () => {
  it("new-application section: the header is status.uiState — READY when everything for a new app is configured", async () => {
    const { h, status } = await world();
    expect(status.uiState).toBe("READY_FOR_APPROVAL");
    const html = render(h, status, "new");
    expect(badgeState(html)).toBe("READY_FOR_APPROVAL");
    expect(panelState(html)).toBe("READY_FOR_APPROVAL");
    expect(html).toContain(liveUi.states.READY_FOR_APPROVAL);
  });
  it("new-application section: missing units/network ⇒ the header says BLOCKED («مسدود»), label and data-state agree", async () => {
    const { h, status } = await world({ units: false, network: false });
    expect(status.uiState).toBe("BLOCKED");
    const html = render(h, status, "new");
    expect(badgeState(html)).toBe("BLOCKED");
    expect(panelState(html)).toBe("BLOCKED");
    expect(badgeTag(html)).toBeTruthy();
    expect(html).toMatch(/data-testid="live-state-badge"[^>]*>[^<]*مسدود/);
  });
  it("existing-application section: the header is status.existing.uiState — READY even though the new-app prerequisites (units, network) are missing", async () => {
    const { h, status } = await world({ units: false, network: false });
    expect(status.uiState).toBe("BLOCKED"); // the backend contract is unchanged …
    expect(status.existing?.uiState).toBe("READY_FOR_APPROVAL"); // … and the existing-app state is its own
    expect(status.prerequisites.filter((p) => p.blocking && !p.ok).map((p) => p.id).sort()).toEqual(["network_id", "plan_units_verified"]);
    const html = render(h, status, "existing");
    expect(badgeState(html)).toBe("READY_FOR_APPROVAL");
    expect(panelState(html)).toBe("READY_FOR_APPROVAL");
    expect(html).toMatch(/data-testid="live-state-badge"[^>]*>[^<]*آمادهٔ تأیید/);
    expect(html).not.toMatch(/data-testid="live-state-badge"[^>]*>[^<]*مسدود/);
    // the section badge and the header now agree
    expect(/data-testid="live-existing-state" data-state="([A-Z_]+)"/.exec(html)![1]).toBe("READY_FOR_APPROVAL");
  });
  it("a GENUINELY blocked existing workflow stays BLOCKED in its header (nothing is converted to ready)", async () => {
    // the default-address domain of the app (liara.run: it has a network) does not match the configured suffix ⇒ a real target blocker
    const { h, status } = await world({ env: { LIARA_APP_DOMAIN_SUFFIXES: "iran.liara.run" } });
    expect(status.existing?.uiState).toBe("BLOCKED");
    const html = render(h, status, "existing");
    expect(badgeState(html)).toBe("BLOCKED");
    expect(html).toMatch(/data-testid="live-state-badge"[^>]*>[^<]*مسدود/);
    // and with live execution switched off the existing path is not "ready" either (a missing execution prerequisite is not a target problem, the state is the server's)
    const off = await world({ env: { LIARA_LIVE_DEPLOY_ENABLED: "false", LIARA_LIVE_CONTRACT_ATTESTED: "false" } });
    expect(badgeState(render(off.h, off.status, "existing"))).toBe(off.status.existing!.uiState);
  });
  it("fallback: when the existing-specific state is genuinely unavailable the header uses status.uiState", async () => {
    const { h, status } = await world({ units: false, network: false });
    const noExisting: LiveStatus = { ...status, existing: null };
    const html = render(h, noExisting, "existing");
    expect(badgeState(html)).toBe(status.uiState);
    expect(panelState(html)).toBe(status.uiState);
    expect(() => render(h, { ...noExisting, locks: [], lastResults: [] }, "existing")).not.toThrow();
  });
  it("a verified/in-progress/failed operation state of the existing path is shown as such (not overwritten by the new-app aggregate)", async () => {
    const { h, status } = await world({ units: false, network: false });
    for (const st of ["LIVE_VERIFIED", "LIVE_IN_PROGRESS", "LIVE_FAILED", "SIMULATED"] as const) {
      const html = render(h, { ...status, existing: { ...status.existing!, uiState: st } }, "existing");
      expect(badgeState(html), st).toBe(st);
      expect(panelState(html), st).toBe(st);
    }
  });
});

describe("the new-application explanation is gated by the ACTUAL blockers", () => {
  it("only units/network missing ⇒ the suggested sentence, in the new-application section only", async () => {
    const { h, status } = await world({ units: false, network: false });
    const html = render(h, status, "new");
    expect(html).toContain('data-testid="live-new-app-blocker-note" data-kind="only_new_app"');
    expect(html).toContain(liveUi.flow.newAppBlocked.only_new_app);
    expect(liveUi.flow.newAppBlocked.only_new_app).toBe("این محدودیت مربوط به ساخت برنامهٔ جدید است. برای انتشار روی برنامهٔ موجود، این پیش‌نیازها لازم نیستند.");
    // never in the existing-application section, even though the aggregate status is BLOCKED
    expect(render(h, status, "existing")).not.toContain("live-new-app-blocker-note");
    expect(render(h, status, "existing")).not.toContain(liveUi.flow.newAppBlocked.only_new_app);
  });
  it("units/network missing AND an unrelated blocker (e.g. no contract attestation) ⇒ the accurate 'mixed' explanation, not the blanket sentence", async () => {
    const { h, status } = await world({ units: false, network: false, env: { LIARA_LIVE_CONTRACT_ATTESTED: "false" } });
    const html = render(h, status, "new");
    expect(html).toContain('data-kind="mixed"');
    expect(html).toContain(liveUi.flow.newAppBlocked.mixed);
    expect(html).not.toContain(liveUi.flow.newAppBlocked.only_new_app);
  });
  it("blocked only by something else (units and network are configured) ⇒ no new-app explanation at all", async () => {
    const { h, status } = await world({ env: { LIARA_LIVE_CONTRACT_ATTESTED: "false" } });
    expect(status.uiState).toBe("BLOCKED");
    expect(render(h, status, "new")).not.toContain("live-new-app-blocker-note");
  });
  it("not blocked ⇒ no explanation; and no sentence ever tells the operator to set a configuration value", async () => {
    const { h, status } = await world();
    expect(render(h, status, "new")).not.toContain("live-new-app-blocker-note");
    for (const text of Object.values(liveUi.flow.newAppBlocked)) expect(text).not.toMatch(/LIARA_|=|JSON|بگذارید|تنظیم کنید/);
  });
  it("explainNewAppBlockers: classification, run blockers count as 'other', sensitive-file notes are ignored, non-blocking entries are ignored", () => {
    const p = (id: string, ok: boolean, blocking = true) => ({ id, ok, blocking });
    expect(explainNewAppBlockers([p("plan_units_verified", false), p("network_id", false), p("token", true)], [])).toMatchObject({ kind: "only_new_app", newAppOnly: ["plan_units_verified", "network_id"], other: [] });
    expect(explainNewAppBlockers([p("network_id", false), p("token", false)], [])).toMatchObject({ kind: "mixed", other: ["token"] });
    expect(explainNewAppBlockers([p("network_id", false)], ["readiness_blocked"])).toMatchObject({ kind: "mixed", other: ["readiness_blocked"] });
    expect(explainNewAppBlockers([p("network_id", false)], ["sensitive_files_in_archive_will_be_excluded"]).kind).toBe("only_new_app");
    expect(explainNewAppBlockers([p("token", false)], []).kind).toBe("none");
    expect(explainNewAppBlockers([p("network_id", false, false)], []).kind).toBe("none");
    expect(explainNewAppBlockers([], []).kind).toBe("none");
  });
});

describe("nothing about approvals or writes changed", () => {
  it("the request button of the existing path is still closed without a file and a fresh preview; the new-app form still needs units", async () => {
    const { h, status } = await world({ units: false, network: false });
    const ex = render(h, status, "existing");
    expect(/<button[^>]*data-testid="live-existing-propose"[^>]*>/.exec(ex)![0]).toMatch(/\sdisabled/);
    const nw = render(h, status, "new");
    expect(/<button[^>]*data-testid="live-propose"[^>]*>/.exec(nw)![0]).toMatch(/\sdisabled/);
    expect(h.fake.calls).toEqual([]); // rendering the page sent nothing
  });
});
