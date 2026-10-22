import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it, vi } from "vitest";
import type { ArtifactBinding } from "@/components/artifact-binding";
import { LiveDeploymentView, PreviewCard } from "@/components/live-deployment";
import { liveUi } from "@/i18n/live-fa";
import { LIVE_STATES } from "@/server/live/types";
import { approved, deploy, harness, OWNER, propose, settle } from "../helpers/live-exec";
import { FakeProcessRunner, makeCliBackend, makeFakeCliPackage } from "../helpers/fake-cli";
import { assertNoCanary } from "../helpers/canaries";

vi.mock("next/navigation", () => ({ useRouter: () => ({ push: () => undefined, refresh: () => undefined }) }));

const render = async (h: Awaited<ReturnType<typeof harness>>, artifact?: ArtifactBinding) => renderToStaticMarkup(<LiveDeploymentView status={await h.svc.status(OWNER, h.runId)} runId={h.runId} defaultApp="" section="new" artifact={artifact} onChanged={() => undefined} />);
const SELECTED: ArtifactBinding = { file: new File([new Uint8Array(4)], "my-site.zip"), sha256: "ab".repeat(32), state: "match", fromUpload: false, set: () => undefined };
/** the CREATE-new-app form only (the existing-app form has its own fieldset) */
const createForm = (html: string) => /<form[^>]*data-testid="live-form"[\s\S]*?<\/form>/.exec(html)?.[0] ?? "";
const tag = (html: string, id: string) => new RegExp(`<(button|input|select|fieldset)[^>]*data-testid="${id}"[^>]*>`).exec(html)?.[0] ?? "";

describe("live panel (server-rendered markup from the real status document)", () => {
  it("default configuration ⇒ BLOCKED: every prerequisite is listed, every control is disabled, Persian only", async () => {
    const h = await harness({ env: { LIARA_LIVE_DEPLOY_ENABLED: "false" }, noTransport: true });
    const html = await render(h);
    expect(html).toContain('data-state="BLOCKED"');
    expect(html).toContain(liveUi.states.BLOCKED);
    for (const id of ["live_flag", "contract_attested", "plan_units_verified", "network_id", "app_domain_suffix"]) expect(html).toMatch(new RegExp(`data-prereq="${id}"[^>]*data-ok="(true|false)"`));
    expect(html).toMatch(/data-prereq="live_flag"[^>]*data-ok="false"/);
    expect(createForm(html)).toMatch(/<fieldset[^>]*\sdisabled=""/);
    expect(tag(html, "live-propose")).toMatch(/\sdisabled/);
    expect(html).toContain('data-testid="live-disabled-note"');
    expect(html).not.toContain('data-testid="live-open-approval"');
    expect(html).not.toContain('data-testid="live-execute"');
  });
  it("units unverified ⇒ plans show raw values only; no price in Toman and no 'recommended' wording; form stays disabled", async () => {
    const h = await harness({ env: { LIARA_PLAN_UNITS_JSON: undefined } });
    const html = await render(h);
    expect(html).toContain('data-testid="live-plan-notes"');
    expect(html).not.toContain('data-testid="live-cost-verified"'); // no cost without the operator document
    expect(createForm(html)).toMatch(/<fieldset[^>]*\sdisabled=""/);
    expect(html).toMatch(/data-prereq="plan_units_verified"[^>]*data-ok="false"/);
  });
  it("fully configured ⇒ READY_FOR_APPROVAL with an ENABLED form", async () => {
    const h = await harness();
    const html = await render(h);
    expect(html).toContain('data-state="READY_FOR_APPROVAL"');
    expect(createForm(html)).not.toMatch(/<fieldset[^>]*\sdisabled=""/);
    expect(tag(html, "live-propose")).toMatch(/\sdisabled/); // …but still no request without the one selected ZIP
    expect(tag(await render(h, SELECTED), "live-propose")).not.toMatch(/\sdisabled=""/);
    expect(html).toContain('data-testid="live-plan-select"');
  });
  it("a pending proposal shows every approval binding, the typed-name input, and the approve button disabled until the name is typed", async () => {
    const h = await harness();
    const v = await propose(h);
    const html = await render(h);
    for (const must of [v.proposal.appName, v.proposal.planId, v.proposal.bundlePlanId, v.proposal.networkId, v.proposal.digest, v.proposal.artifact.zipSha256, v.proposal.artifact.artifactDigest, v.proposal.operationId, "team_demo_1"]) expect(html, must).toContain(must);
    expect(html).toContain('data-testid="live-confirm-input"');
    expect(html).toContain(liveUi.proposal.typeName(v.proposal.appName));
    expect(tag(html, "live-approve")).toMatch(/\sdisabled/);
    expect(html).toContain('data-testid="live-open-approval"');
    expect(html).toContain(liveUi.proposal.effects);
    assertNoCanary(html);
  });
  it("approved ⇒ an execute box that needs the SAME selected ZIP (no second file input anywhere): without it the execute button is disabled", async () => {
    const h = await harness();
    await approved(h);
    const html = await render(h);
    expect(html).toContain('data-testid="live-execute-box"');
    expect(html).toContain('data-testid="live-exec-file"');
    expect(html).not.toContain('data-testid="live-exec-zip"');
    expect(html).toContain(liveUi.flow.binder.missingForExecute);
    expect(tag(html, "live-execute")).toMatch(/\sdisabled/);
    expect((html.match(/type="file"/g) ?? []).length).toBe(1); // the ONE artifact binder
  });
  it("a verified deployment shows LIVE_VERIFIED, the full timeline and all six ladder levels as verified", async () => {
    const h = await harness();
    await deploy(h);
    const html = await render(h);
    expect(html).toContain('data-state="LIVE_VERIFIED"');
    expect(html).toContain(liveUi.states.LIVE_VERIFIED);
    expect((html.match(/data-level="[A-Za-z]+" data-value="ok"/g) ?? []).length).toBe(6);
    expect((html.match(/data-to="/g) ?? []).length).toBeGreaterThanOrEqual(9);
    expect(html).not.toContain('data-testid="live-failure"');
  });
  it("a failure under review shows the cause, the recovery steps and the recovery buttons (no delete/restart/rollback anywhere)", async () => {
    const h = await harness();
    h.fake.create = "timeout_not_created";
    await deploy(h);
    const html = await render(h);
    expect(html).toContain('data-state="LIVE_FAILED"');
    expect(html).toContain('data-testid="live-failure"');
    expect(html).toContain('data-testid="live-recovery"');
    expect(html).toContain('data-testid="live-reverify"');
    expect(html).toContain('data-testid="live-abandon"');
    expect(html).not.toMatch(/حذف برنامه|delete|rollback|restart/i);
  });
  it("every live state and ui state has a Persian label", () => {
    for (const s of LIVE_STATES) expect(liveUi.states_fa[s], s).toMatch(/[؀-ۿ]/);
    for (const s of ["SIMULATED", "READY_FOR_APPROVAL", "LIVE_IN_PROGRESS", "LIVE_VERIFIED", "LIVE_FAILED", "BLOCKED"]) {
      expect(liveUi.states[s as keyof typeof liveUi.states]).toMatch(/[؀-ۿ]/);
      expect(liveUi.stateHelp[s]).toMatch(/[؀-ۿ]/);
    }
  });
  it("uses logical (RTL-safe) utilities only — no physical left/right classes", async () => {
    const { readFileSync } = await import("node:fs");
    const src = readFileSync("src/components/live-deployment.tsx", "utf8");
    expect(src).not.toMatch(/className="[^"]*\b(ml|mr|pl|pr|left|right|text-left|text-right)-/);
  });
});

describe("Phase 2B: final preflight summary in the panel", () => {
  it("a non-technical reader gets: the app, the team, the plan (and why), the expected charges, which steps need approval, what the agent does, how progress is verified, and what happens on failure", async () => {
    const h = await harness();
    await propose(h);
    const html = await render(h);
    for (const must of ["live-preflight", "live-preflight-summary", "live-verify-plan", "live-preflight-missing", "live-preflight-all", "live-verdict"]) expect(html, must).toContain(`data-testid="${must}"`);
    for (const label of Object.values(liveUi.preflight.what)) expect(html, label).toContain(label);
    expect(html).toContain("liara-agent-demo");
    expect(html).toContain('data-testid="live-cost-verified"');
    expect(html).toContain(liveUi.preflight.agentSteps[1]!);
    expect(html).toContain(liveUi.preflight.failureText[0]!);
    expect(html).toContain(liveUi.preflight.approvals[1]!);
    for (const key of ["apiAcceptedRequest", "sourceUploaded", "releaseCreated", "buildCompleted", "runtimeStarted", "httpHealthVerified"]) expect(html).toContain(liveUi.ladderLabels[key]!);
    assertNoCanary(html);
  });
  it("a ready configuration shows READY_FOR_OPERATOR_APPROVAL and 'no blockers'; an unconfigured one lists every missing prerequisite explicitly", async () => {
    const ready = await render(await harness());
    expect(ready).toContain('data-verdict="READY_FOR_OPERATOR_APPROVAL"');
    expect(ready).toContain(liveUi.preflight.none);
    const bare = await render(await harness({ env: { LIARA_PLAN_UNITS_JSON: undefined, LIARA_NETWORK_ID: undefined, LIARA_LIVE_CONTRACT_ATTESTED: "false", LIARA_ALLOW_UNDOCUMENTED_ENDPOINTS: "false" } }));
    expect(bare).toContain('data-verdict="BLOCKED_BY_CONTRACT"');
    for (const id of ["contract_attested", "network_listing", "network_id_configured", "units_operator_document", "units_agree"]) expect(bare, id).toMatch(new RegExp(`data-check="${id}" data-category=`));
    expect(bare).toContain('data-testid="live-cost-unknown"');
  });
  it("every blocking check is shown with its category and every check with its evidence class (documented / live / CLI-only / operator / not tested)", async () => {
    const html = await render(await harness({ env: { LIARA_LIVE_CONTRACT_ATTESTED: "false" } }));
    expect(html).toContain(liveUi.preflight.categories.contract);
    for (const e of ["live_verified", "cli_observed", "operator_declared", "not_tested"]) expect(html, e).toContain(`data-evidence="${e}"`);
    expect(html).toContain(liveUi.preflight.evidence.cli_observed);
  });
  it("the approval dialog requires the explicit financial acknowledgment checkbox before the approve button can work", async () => {
    const h = await harness();
    await propose(h);
    const html = await render(h);
    expect(html).toContain('data-testid="live-ack"');
    expect(html).toContain(liveUi.ack.label);
    expect(html).toContain(liveUi.ack.help);
    expect(tag(html, "live-approve")).toMatch(/\sdisabled/);
  });
  it("a finished operation shows the verification verdict and the evidence source, references and limitation of every level", async () => {
    const h = await harness();
    await deploy(h);
    const html = await render(h);
    expect(html).toContain('data-testid="live-ladder-verdict" data-verdict="DEPLOYED"');
    expect(html).toContain('data-testid="live-ladder-evidence"');
    expect((html.match(/data-evidence-level="/g) ?? []).length).toBe(6);
    expect(html).toContain(liveUi.evidenceShort.cli_observed);
  });
  it("a partially verified deployment is labelled as such and offers recovery buttons, not success", async () => {
    const h = await harness({ poll: { verifyBudgetMs: 3000, pollIntervalMs: 1000 } });
    h.fake.probeResult = { outcome: "timeout", status: null, markerFound: null };
    await deploy(h);
    const html = await render(h);
    expect(html).toContain('data-testid="live-ladder-verdict" data-verdict="PARTIALLY_VERIFIED"');
    expect(html).toContain('data-testid="live-reverify"');
    expect(html).not.toContain('data-verdict="DEPLOYED"');
  });
});

describe("Phase 2E: existing-application deployment UI", () => {
  const APP = "liara-agent-demo";
  const ready = { verdict: "READY", frameworkFa: "Next.js" };
  const renderEx = async (h: Awaited<ReturnType<typeof harness>>, readiness: { verdict: string; frameworkFa: string } | null = ready) => renderToStaticMarkup(<LiveDeploymentView status={await h.svc.status(OWNER, h.runId)} runId={h.runId} defaultApp="" readiness={readiness} onChanged={() => undefined} />);
  const withApp = async (over: Parameters<typeof harness>[0] = {}) => {
    const h = await harness(over);
    h.fake.apps.add(APP);
    h.fake.releaseIds.push("rel_old_1");
    return h;
  };

  it("shows analysis/readiness, authorised targets with identity facts, both backends (REST default, CLI fallback), cost disclosure and the never-create promise", async () => {
    const html = await renderEx(await withApp());
    for (const id of ["live-existing", "live-existing-analysis", "live-existing-targets", "live-existing-identity", "live-existing-backends", "live-existing-cost", "live-existing-form", "live-existing-never-create", "live-existing-checks"]) expect(html, id).toContain(`data-testid="${id}"`);
    expect(html).toContain(liveUi.existing.title);
    expect(html).toContain(liveUi.existing.never);
    expect(html).toContain('data-testid="live-existing-readiness" data-verdict="READY"');
    expect(html).toContain("Next.js");
    expect(html).toMatch(/data-testid="live-existing-target" data-app="liara-agent-demo" data-ready="true"/);
    expect(html).toContain("g2-small");
    expect(html).toMatch(/data-backend="api" data-ready="true"/);
    expect(html).toMatch(/data-backend="cli" data-ready="false"/);
    expect(html).toContain(liveUi.existing.defaultBadge);
    expect(html).toContain(liveUi.existing.fallbackBadge);
    for (const line of liveUi.existing.cost.lines) expect(html).toContain(line);
    assertNoCanary(html);
  });
  it("the identity card shows hints only, never full ids", async () => {
    const h = await withApp();
    const html = await renderEx(h);
    expect(html).not.toContain("inst_0001_demo");
    expect(html).toMatch(/data-testid="live-existing-instance">[0-9a-f]{8}</);
  });
  it("only AUTHORISED apps are offered: an existing app outside the allowlist never appears", async () => {
    const h = await withApp();
    h.fake.apps.add("someone-elses-app");
    const html = await renderEx(h);
    expect(html).toContain('data-app="liara-agent-demo"');
    expect(html).not.toContain("someone-elses-app");
  });
  it("no authorised app ⇒ an explicit empty state telling the operator to allowlist it (nothing is added automatically)", async () => {
    const h = await harness();
    const html = await renderEx(h);
    expect(html).toContain('data-testid="live-existing-empty"');
    expect(html).toContain("LIARA_ALLOWED_APPS");
  });
  it("blocked targets list the reason (suffix, marker, stopped, ...) and the propose button is disabled", async () => {
    const h = await withApp({ env: { LIARA_APP_DOMAIN_SUFFIXES: "iran.liara.run", LIARA_LIVE_HEALTH_MARKER: "ok" } });
    const html = await renderEx(h);
    expect(html).toMatch(/data-check="domain_suffix_expected" data-status="blocked"/);
    expect(html).toMatch(/data-check="health_marker_specific" data-status="blocked"/);
    expect(tag(html, "live-existing-propose")).toMatch(/\sdisabled/);
    expect(html).toContain('data-testid="live-existing-disabled-note"');
  });
  it("the CLI backend is shown as NOT ready (with the reason) unless it is pinned, and is never the selected option", async () => {
    const html = await renderEx(await withApp());
    expect(html).toContain('data-testid="live-existing-backend-blockers"');
    expect(html).toMatch(/<input[^>]*name="live-existing-backend"[^>]*value="api"[^>]*checked=""|<input[^>]*checked=""[^>]*value="api"/);
    expect(html).not.toMatch(/<input[^>]*value="cli"[^>]*checked=""|<input[^>]*checked=""[^>]*value="cli"/);
  });
  it("three modes are visually and textually distinct", async () => {
    const live = await renderEx(await withApp());
    const off = await renderEx(await withApp({ env: { LIARA_LIVE_DEPLOY_ENABLED: "false" } }));
    const sim = await renderEx(await withApp({ env: { LIARA_LIVE_DEPLOY_ENABLED: "false", LIARA_DATA_SOURCE: "mock", LIARA_ALLOWED_APPS: undefined } }));
    const modeOf = (html: string) => /data-testid="live-mode-banner" data-live-mode="([a-z_]+)"/.exec(html)?.[1];
    expect([modeOf(live), modeOf(off), modeOf(sim)]).toEqual(["live_enabled", "live_disabled", "simulation"]);
    expect(live).toContain(liveUi.modes.live_enabled!.label);
    expect(off).toContain(liveUi.modes.live_disabled!.label);
    expect(sim).toContain(liveUi.modes.simulation!.label);
    expect(new Set([liveUi.modes.live_enabled!.label, liveUi.modes.live_disabled!.label, liveUi.modes.simulation!.label]).size).toBe(3);
    expect(live).toContain("border-destructive"); // real writes: red frame
    expect(off).not.toContain('data-live-mode="live_enabled"');
    expect(tag(off, "live-existing-propose")).toMatch(/\sdisabled/);
    expect(tag(sim, "live-existing-propose")).toMatch(/\sdisabled/);
    expect(off).toContain(liveUi.existing.proposeDisabledOff);
    expect(sim).toContain(liveUi.existing.proposeDisabledSim);
  });
  it("an existing-app proposal previews EVERY binding (kind, backend, team, app, plan, platform, instance, creation time, network, baseline, subdomain, artifact digests, CLI binding) with no network/bundle/financial-ack for creation", async () => {
    const h = await withApp();
    await h.svc.createExistingProposal(OWNER, { runId: h.runId, appName: APP, backend: "api", zip: h.zip });
    const html = await renderEx(h);
    expect(html).toContain('data-testid="live-bindings" data-kind="deploy_existing_app"');
    for (const id of ["live-bind-kind", "live-bind-backend", "live-bind-app", "live-bind-instance", "live-existing-bind-cost", "live-real-badge", "live-existing-recreate-note"]) expect(html, id).toContain(`data-testid="${id}"`);
    expect(html).toContain(liveUi.existing.bindings.kindValue);
    expect(html).toContain(liveUi.proposal.effectsExisting);
    expect(html).not.toContain('data-testid="live-ack"'); // no new cost line: the creation acknowledgment does not apply
    expect(html).not.toMatch(/<bdi[^>]*>existing<\/bdi>/); // the placeholder bundle/network values are never shown as rows
    expect(tag(html, "live-approve")).toMatch(/\sdisabled/); // until the exact name is typed
  });
  it("a CLI proposal also previews the pinned tool, argv digest and file-manifest digest", async () => {
    const runner = new FakeProcessRunner();
    const h = await withApp({ cli: makeCliBackend(runner, makeFakeCliPackage()).backend });
    const v = await h.svc.createExistingProposal(OWNER, { runId: h.runId, appName: APP, backend: "cli", zip: h.zip });
    const html = await renderEx(h);
    expect(html).toContain('data-testid="live-bind-cli"');
    expect(html).toContain(v.proposal.cli!.argvDigest);
    expect(html).toContain(v.proposal.cli!.manifestDigest);
    expect(runner.calls).toHaveLength(0);
  });
  it("the execution timeline of an existing app says the identity was verified and that nothing was created", async () => {
    const h = await withApp();
    const v = await h.svc.createExistingProposal(OWNER, { runId: h.runId, appName: APP, backend: "api", zip: h.zip });
    await h.svc.decide(v.proposal.id, OWNER, { decision: "approve", digest: v.proposal.digest, confirmAppName: APP });
    await settle(h, (await h.svc.execute(v.proposal.id, OWNER, h.zip)).id);
    const html = await renderEx(h);
    expect(html).toContain('data-testid="live-operation"');
    expect(html).toContain('data-kind="deploy_existing_app"');
    expect(html).toContain(liveUi.existing.stateLabels.APPLICATION_CREATED!);
    expect(html).toContain(liveUi.existing.timelineTitle);
    expect(html).toContain('data-testid="live-ladder-verdict" data-verdict="DEPLOYED"');
    expect(html).not.toContain(liveUi.states_fa.CREATING_APPLICATION); // the create step never appears
  });
  it("only logical (RTL-safe) utilities in the new markup", async () => {
    const { readFileSync } = await import("node:fs");
    expect(readFileSync("src/components/live-deployment.tsx", "utf8")).not.toMatch(/className="[^"]*\b(ml|mr|pl|pr|left|right|text-left|text-right)-/);
  });
});

describe("existing-app path UX (server-rendered): one next action, one ZIP input, preview separated from execution", () => {
  const ready = { verdict: "READY", frameworkFa: "Next.js" };
  const renderPath = async (h: Awaited<ReturnType<typeof harness>>, artifact?: ArtifactBinding) => renderToStaticMarkup(<LiveDeploymentView status={await h.svc.status(OWNER, h.runId)} runId={h.runId} defaultApp="" readiness={ready} artifact={artifact} onChanged={() => undefined} />);
  const action = (html: string) => /data-testid="live-next-action" data-action="([a-z_]+)"/.exec(html)?.[1];

  it("exactly ONE file input on the primary path, and no create-new-app content at all", async () => {
    const h = await harness();
    const html = await renderPath(h);
    expect((html.match(/type="file"/g) ?? []).length).toBe(1);
    expect(html).toContain('data-testid="artifact-file"');
    expect(html).not.toContain('data-testid="live-existing-zip"');
    expect(html).not.toContain('data-testid="live-create-new"');
    expect(html).not.toContain('data-testid="live-plan-select"');
    expect(html).not.toContain('data-testid="live-preflight"'); // pricing/network blockers belong to the new-app path only
    expect(html).not.toMatch(/data-prereq="(plan_units_verified|network_id)"/);
  });
  it("the new-app path is a separate section that carries the pricing/network prerequisites and also has exactly one file input", async () => {
    const h = await harness();
    const html = renderToStaticMarkup(<LiveDeploymentView status={await h.svc.status(OWNER, h.runId)} runId={h.runId} defaultApp="" readiness={ready} section="new" onChanged={() => undefined} />);
    expect(html).toContain('data-testid="live-create-new"');
    expect(html).not.toContain('data-testid="live-existing"');
    expect(html).toMatch(/data-prereq="plan_units_verified"/);
    expect((html.match(/type="file"/g) ?? []).length).toBe(1);
  });
  it("without a selected file the next action is 'choose the ZIP'; with the matching file it is 'run the offline preview' — and preview is enabled even though live execution is OFF", async () => {
    const h = await harness({ env: { LIARA_LIVE_DEPLOY_ENABLED: "false", LIARA_LIVE_CONTRACT_ATTESTED: "false" } });
    h.fake.apps.add("liara-agent-demo");
    h.fake.releaseIds.push("rel_old_1");
    const none = await renderPath(h);
    expect(action(none)).toBe("choose_zip");
    expect(tag(none, "live-existing-preview-btn")).toMatch(/\sdisabled/);
    const withFile = await renderPath(h, SELECTED);
    expect(action(withFile)).toBe("run_preview");
    expect(tag(withFile, "live-existing-preview-btn")).not.toMatch(/\sdisabled=""/);
    expect(tag(withFile, "live-existing-propose")).toMatch(/\sdisabled/); // …but an approval request stays closed
  });
  it("a different file than the analysed one blocks preview and request and says so", async () => {
    const h = await harness();
    h.fake.apps.add("liara-agent-demo");
    const html = await renderPath(h, { ...SELECTED, state: "mismatch" });
    expect(action(html)).toBe("fix_zip");
    expect(html).toContain(liveUi.flow.binder.states.mismatch);
    expect(tag(html, "live-existing-preview-btn")).toMatch(/\sdisabled/);
    expect(tag(html, "live-existing-propose")).toMatch(/\sdisabled/);
  });
  it("target readiness and execution prerequisites are two separate lists", async () => {
    const h = await harness({ env: { LIARA_LIVE_DEPLOY_ENABLED: "false" } });
    h.fake.apps.add("liara-agent-demo");
    const html = await renderPath(h, SELECTED);
    const target = /data-testid="live-gate-target"[\s\S]*?<\/ul>/.exec(html)?.[0] ?? "";
    const execution = /data-testid="live-gate-execution"[\s\S]*?<\/ul>/.exec(html)?.[0] ?? "";
    expect(target).toContain(liveUi.flow.binder.title);
    expect(target).not.toContain(liveUi.prereqLabels.live_flag!);
    expect(execution).toContain(liveUi.prereqLabels.live_flag!);
    expect(execution).not.toContain(liveUi.flow.binder.title);
  });
  it("a pending request says 'review and approve'; an approved one 'execute' and needs the SAME file", async () => {
    const h = await harness();
    h.fake.apps.add("liara-agent-demo");
    h.fake.releaseIds.push("rel_old_1");
    const v = await h.svc.createExistingProposal(OWNER, { runId: h.runId, appName: "liara-agent-demo", backend: "api", zip: h.zip });
    expect(action(await renderPath(h, SELECTED))).toBe("approve_pending");
    await h.svc.decide(v.proposal.id, OWNER, { decision: "approve", digest: v.proposal.digest, confirmAppName: "liara-agent-demo" });
    expect(action(await renderPath(h, SELECTED))).toBe("execute_approved");
    expect(action(await renderPath(h))).toBe("choose_zip");
    expect(tag(await renderPath(h), "live-execute")).toMatch(/\sdisabled/);
    expect(tag(await renderPath(h, SELECTED), "live-execute")).not.toMatch(/\sdisabled=""/);
  });
  it("the offline preview card shows the bindings, says it is NOT an approval, and separates target readiness from execution blockers", async () => {
    const h = await harness({ env: { LIARA_LIVE_DEPLOY_ENABLED: "false", LIARA_LIVE_CONTRACT_ATTESTED: "false" } });
    h.fake.apps.add("liara-agent-demo");
    h.fake.releaseIds.push("rel_old_1");
    const p = await h.svc.previewExisting(OWNER, { runId: h.runId, appName: "liara-agent-demo", backend: "api", zip: h.zip });
    const html = renderToStaticMarkup(<PreviewCard preview={p} />);
    for (const must of [p.artifact.zipSha256, p.artifact.analysisDigest, p.artifact.artifactDigest, liveUi.flow.preview.notApproval, liveUi.flow.preview.targetReady, liveUi.flow.preview.executableNo, liveUi.prereqLabels.live_flag!]) expect(html, must).toContain(must);
    expect(html).toContain('data-executable="false"');
    expect(html).toContain('data-target-ready="true"');
    assertNoCanary(html);
  });
});
