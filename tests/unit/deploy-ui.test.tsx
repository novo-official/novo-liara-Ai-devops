import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it, vi } from "vitest";
import { DeploymentPanel, UploadCard } from "@/components/deploy-journey";
import { deployUi } from "@/i18n/deploy-fa";
import { A, mkAgent } from "../helpers/agent";
import { baseFiles, nextZip, withPkg, zipOf, type Files } from "../helpers/projects";

vi.mock("next/navigation", () => ({ useRouter: () => ({ push: () => undefined, refresh: () => undefined }) }));

const tag = (html: string, id: string) => new RegExp(`<button[^>]*data-testid="${id}"[^>]*>`).exec(html)?.[0] ?? "";

async function scene(over: Files = {}, steps: ("plan" | "approve")[] = [], opts: Record<string, unknown> = {}) {
  const { m } = mkAgent();
  const up = await m.receiveProject({ sessionId: A, archive: zipOf({ ...baseFiles(), ...over }), filename: "p.zip" });
  let view = null;
  if (steps.includes("plan")) view = await m.prepareDeployment(up.runId, A, opts);
  if (steps.includes("approve") && view) await m.decide(view.proposal.id, A, { decision: "approve", digest: view.proposal.digest, confirmAppName: view.proposal.app });
  const { run, proposals } = await m.getRun(up.runId, A);
  return renderToStaticMarkup(<DeploymentPanel run={run} proposals={proposals} onChanged={() => undefined} />);
}

describe("upload card", () => {
  it("has an accessible labelled file input, the limits hint and the 'nothing is executed' promise", () => {
    const html = renderToStaticMarkup(<UploadCard conversationId={null} onUploaded={() => undefined} />);
    expect(html).toContain('data-testid="deploy-file"');
    expect(html).toContain(deployUi.upload.label);
    expect(html).toMatch(/for="zip-m"/);
    expect(html).toContain(deployUi.upload.notExecuted);
    expect(html).toContain("۲۰ مگابایت");
  });
});

describe("deployment panel", () => {
  it("READY: verdict, static-analysis notice, stepper, checklist, preliminary recommendation (no price), enabled plan button", async () => {
    const html = await scene();
    expect(html).toContain('data-verdict="READY"');
    expect(html).toContain('data-testid="deploy-static-notice"');
    expect(html).toContain('data-testid="deploy-stepper"');
    expect(html).toContain('aria-current="step"');
    expect(html).toContain('data-testid="deploy-checklist"');
    expect(html).toContain(deployUi.rec.preliminary);
    expect(html).not.toMatch(/تومان|ریال/);
    expect(tag(html, "plan-prepare")).not.toMatch(/\sdisabled=""/);
    expect(html).toContain('data-testid="deploy-advanced"');
    expect(html).toContain('data-testid="github-note"');
  });
  it("BLOCKED: shows the blocker, disables planning and explains why", async () => {
    const html = await scene(withPkg((p) => delete (p.scripts as Record<string, string>).start));
    expect(html).toContain('data-verdict="BLOCKED"');
    expect(html).toContain("اسکریپت start تعریف نشده است");
    expect(tag(html, "plan-prepare")).toMatch(/\sdisabled=""/);
    expect(html).toContain('data-testid="plan-disabled-note"');
  });
  it("NEEDS_CONFIGURATION: manual items are checkboxes with accessible labels; state is text, not colour alone", async () => {
    const html = await scene({ ".env.example": "API_KEY=\n" });
    expect(html).toContain('data-verdict="NEEDS_CONFIGURATION"');
    expect(html).toContain('data-testid="check-env_values"');
    expect(html).toMatch(/<label[^>]*for="chk-env_values"/);
    expect(html).toContain(`data-testid="state-env_values"`);
    expect(html).toContain(deployUi.state.pending);
  });
  it("UNSUPPORTED is described as unsupported, not as failed", async () => {
    const html = await scene({ "package.json": JSON.stringify({ name: "x-site", dependencies: { astro: "4" } }), "app/page.tsx": null, "app/layout.tsx": null });
    expect(html).toContain('data-verdict="UNSUPPORTED"');
    expect(html).toContain(deployUi.verdictHelp.UNSUPPORTED);
    expect(html).not.toContain('data-testid="deploy-recommendation"');
  });
  it("with an open plan: approval card, simulation-only notice and a re-plan (not a second approve) path", async () => {
    const html = await scene({}, ["plan"]);
    expect(html).toContain('data-testid="deploy-proposals"');
    expect(html).toContain('data-testid="proposal-card"');
    expect(html).toContain(deployUi.plan.simOnly);
    expect(html).toContain('data-testid="confirm-input"');
    expect(html).toContain(deployUi.plan.replan);
  });
  it("after a successful simulation: timeline with simulated labels, no URL, final banner, next steps", async () => {
    const html = await scene({}, ["plan", "approve"]);
    expect(html).toContain('data-testid="deploy-timeline"');
    expect(html).toContain('data-testid="stage-build"');
    expect(html).toContain('data-testid="deploy-final"');
    expect(html).toContain('data-outcome="succeeded"');
    expect(html).toContain('data-testid="deploy-no-url"');
    expect(html).not.toMatch(/https?:\/\/(?!www\.w3\.org)/);
    expect(html).toContain(deployUi.result.success);
    expect(html).toContain(deployUi.result.nextSuccess[0]!);
  });
  it("a simulated failure is amber/warning (never success-coloured), stops the timeline and offers recovery", async () => {
    const html = await scene({}, ["plan", "approve"], { scenario: "build_failure" });
    expect(html).toContain('data-outcome="failed"');
    expect(html).toMatch(/data-testid="stage-build"[^>]*data-status="failed"/);
    expect(html).toMatch(/data-testid="stage-runtime_startup"[^>]*data-status="not_run"/);
    expect(html).toContain(deployUi.result.failed);
    expect(html).toContain(deployUi.result.nextFailed[0]!);
    expect(html).toContain(deployUi.plan.replan);
    expect(html).not.toMatch(/text-green|bg-green|emerald/);
  });
  it("shows nothing that claims a real deployment happened", async () => {
    const html = await scene({}, ["plan", "approve"]);
    expect(html).not.toMatch(/با موفقیت مستقر شد|سایت شما آنلاین شد|منتشر شد(?!ه‌ایم)/);
  });
  it("pre-existing UI test helper exports stay valid", () => {
    expect(nextZip().length).toBeGreaterThan(100);
  });
});
