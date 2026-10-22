import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it, vi } from "vitest";
import { DeploymentPanel, UploadCard } from "@/components/deploy-journey";
import { LiveDeploymentView, PreviewCard } from "@/components/live-deployment";
import { A, mkAgent } from "../helpers/agent";
import { findNestingViolations } from "../helpers/html-nesting";
import { harness, OWNER, settle } from "../helpers/live-exec";
import { baseFiles, zipOf } from "../helpers/projects";

vi.mock("next/navigation", () => ({ useRouter: () => ({ push: () => undefined, refresh: () => undefined }) }));

describe("the checker itself", () => {
  it("flags the exact bug that produced '3 Issues' (<details>/<summary> inside <p>) and other classic violations", () => {
    expect(findNestingViolations("<p><details><summary>x</summary></details></p>")).toEqual(expect.arrayContaining(["<details> inside <p>", "<summary> inside <p>"]));
    expect(findNestingViolations("<p><div>x</div></p>")).toContain("<div> inside <p>");
    expect(findNestingViolations("<button><div>x</div></button>")).toContain("<div> inside <button>");
    expect(findNestingViolations("<a><button>x</button></a>")).toContain("<button> inside <a>");
    expect(findNestingViolations("<div><li>x</li></div>")).toContain("<li> not directly inside ul/ol");
    expect(findNestingViolations("<details><div>x</div></details>")).toEqual([]);
    expect(findNestingViolations("<div><p>a<br/>b<span>c</span></p><ul><li>x</li></ul><details><summary>s</summary>t</details></div>")).toEqual([]);
  });
});

describe("server-rendered markup of the deployment UI is valid HTML (no hydration errors / dev-overlay issues)", () => {
  it("the deployment panel (checklist with <details>, analysis, plan form, proposals)", async () => {
    const { m } = mkAgent();
    const up = await m.receiveProject({ sessionId: A, archive: zipOf(baseFiles()), filename: "p.zip" });
    const { run, proposals } = await m.getRun(up.runId, A);
    const html = renderToStaticMarkup(<DeploymentPanel run={run} proposals={proposals} onChanged={() => undefined} />);
    expect(html).toContain('data-testid="deploy-checklist"');
    expect(html).toContain('role="tablist"'); // the three paths
    expect(findNestingViolations(html)).toEqual([]);
    expect(findNestingViolations(renderToStaticMarkup(<UploadCard conversationId={null} onUploaded={() => undefined} />))).toEqual([]);
  });
  it("the live panel in every mode and state (blocked, preview, pending proposal, finished operation, existing-app flows)", async () => {
    const h = await harness();
    h.fake.apps.add("liara-agent-demo");
    h.fake.releaseIds.push("rel_old_1");
    const view = async (hh: typeof h) => renderToStaticMarkup(<LiveDeploymentView status={await hh.svc.status(OWNER, hh.runId)} runId={hh.runId} defaultApp="" readiness={{ verdict: "READY", frameworkFa: "Next.js" }} onChanged={() => undefined} />);
    expect(findNestingViolations(await view(h))).toEqual([]);
    const v = await h.svc.createExistingProposal(OWNER, { runId: h.runId, appName: "liara-agent-demo", backend: "api", zip: h.zip });
    expect(findNestingViolations(await view(h))).toEqual([]);
    await h.svc.decide(v.proposal.id, OWNER, { decision: "approve", digest: v.proposal.digest, confirmAppName: "liara-agent-demo" });
    await settle(h, (await h.svc.execute(v.proposal.id, OWNER, h.zip)).id);
    expect(findNestingViolations(await view(h))).toEqual([]);
    const off = await harness({ env: { LIARA_LIVE_DEPLOY_ENABLED: "false" } });
    expect(findNestingViolations(await view(off))).toEqual([]);
    // the new-app path and the offline preview card
    const newPath = renderToStaticMarkup(<LiveDeploymentView status={await h.svc.status(OWNER, h.runId)} runId={h.runId} defaultApp="" section="new" onChanged={() => undefined} />);
    expect(findNestingViolations(newPath)).toEqual([]);
    off.fake.apps.add("liara-agent-demo");
    const pv = await off.svc.previewExisting(OWNER, { runId: off.runId, appName: "liara-agent-demo", backend: "api", zip: off.zip });
    expect(findNestingViolations(renderToStaticMarkup(<PreviewCard preview={pv} />))).toEqual([]);
  });
});
