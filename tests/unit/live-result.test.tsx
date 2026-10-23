import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it, vi } from "vitest";
import { EvidenceNote, LiveDeploymentView, OperationView, ResultCard } from "@/components/live-deployment";
import { LIVE_CONTEXT_BANNER, SIM_BANNER } from "@/i18n/agent-fa";
import { liveUi } from "@/i18n/live-fa";
import { LADDER_KEYS } from "@/lib/live-ladder";
import { LIVE_STATE_NAMES, mergeResults, parseOperationResponse, toResultView, type LiveResultView } from "@/lib/live-result";
import { LIVE_STATES } from "@/server/live/types";
import { harness, OWNER } from "../helpers/live-exec";
import { findNestingViolations } from "../helpers/html-nesting";

vi.mock("next/navigation", () => ({ useRouter: () => ({ push: () => undefined, refresh: () => undefined }) }));

const OP = "lop_20261022203843_0396e0b4";
const ladderAll = (v: string) => Object.fromEntries(LADDER_KEYS.map((k) => [k, v]));
const record = (over: Record<string, unknown> = {}) => ({ id: OP, kind: "deploy_existing_app", appName: "liara-agent-demo", state: "DEPLOYED", updatedAt: "2026-10-23T08:12:12.640Z", remote: { releaseId: "6ada74737ebf55567c8e9382" }, ladder: ladderAll("ok"), failure: null, recoveryFa: [], evidence: { runtime: "observed", appletsReadable: true }, ...over });
const view = (over: Partial<LiveResultView> = {}): LiveResultView => ({ ...(toResultView(record() as never) as LiveResultView), ...over });

describe("the browser's validation of the /resolve answer (a 200 is never success by itself)", () => {
  it("accepts a well-formed DEPLOYED record and keeps the release id, the ladder and the provenance", () => {
    const r = parseOperationResponse(record({ evidence: { runtime: "inferred", appletsReadable: false } }), OP)!;
    expect(r).toMatchObject({ operationId: OP, state: "DEPLOYED", releaseId: "6ada74737ebf55567c8e9382", runtimeEvidence: "inferred", appletsReadable: false, failureCode: null, abandoned: false });
    expect(Object.values(r.ladder)).toEqual(Array(6).fill("ok"));
  });
  it("rejects (⇒ null ⇒ 'uncertain') anything unexpected: other id, unknown state, bad ladder, wrong types, non-objects", () => {
    for (const bad of [null, "ok", 5, [], {}, record({ id: "lop_20260101000000_00000000" }), record({ state: "SUCCESS" }), record({ state: undefined }), record({ ladder: { ...ladderAll("ok"), httpHealthVerified: "yes" } }), record({ ladder: { apiAcceptedRequest: "ok" } }), record({ remote: "x" }), record({ remote: { releaseId: 12 } }), record({ appName: "" }), record({ failure: { code: 1 } }), record({ evidence: { runtime: "magic", appletsReadable: null } }), record({ evidence: { runtime: "observed", appletsReadable: "yes" } }), record({ recoveryFa: "x" })]) expect(parseOperationResponse(bad, OP), JSON.stringify(bad)?.slice(0, 80)).toBeNull();
  });
  it("optional / missing fields never crash: no release id, no evidence (legacy ⇒ 'unrecorded'), no failure, odd recovery entries are dropped", () => {
    const r = parseOperationResponse(record({ remote: { releaseId: null }, evidence: undefined, recoveryFa: ["ok", 5, null] }), OP)!;
    expect(r).toMatchObject({ releaseId: null, runtimeEvidence: "unrecorded", appletsReadable: null, recoveryFa: ["ok"] });
    expect(parseOperationResponse({ ...record(), remote: {} }, OP)!.releaseId).toBeNull();
  });
  it("FAILED and NEEDS_OPERATOR_REVIEW keep their truthful state and failure text; an abandon is labelled as such", () => {
    expect(parseOperationResponse(record({ state: "NEEDS_OPERATOR_REVIEW", ladder: { ...ladderAll("unknown"), apiAcceptedRequest: "ok" }, failure: { code: "partially_verified", messageFa: "x" } }), OP)).toMatchObject({ state: "NEEDS_OPERATOR_REVIEW", failureCode: "partially_verified" });
    expect(parseOperationResponse(record({ state: "FAILED", failure: { code: "abandoned_by_operator", messageFa: "رها شد" } }), OP)).toMatchObject({ state: "FAILED", abandoned: true });
  });
  it("the browser's state list equals the server's (it may not import server modules, so a test keeps them in sync)", () => {
    expect([...LIVE_STATE_NAMES]).toEqual([...LIVE_STATES]);
  });
});

describe("mergeResults: no duplicates, confirmed first, superseded history hidden", () => {
  const a = view({ operationId: "lop_20260101000000_aaaaaaaa", completedAt: "2026-10-23T08:00:00.000Z" });
  const b = view({ operationId: "lop_20260101000000_bbbbbbbb", appName: "other-app", completedAt: "2026-10-22T08:00:00.000Z" });
  it("the same operation in the action response AND the refreshed history is shown once (the confirmed one)", () => {
    const confirmed = view({ operationId: a.operationId, state: "DEPLOYED" });
    expect(mergeResults([confirmed], [a, b], () => false).map((x) => x.operationId)).toEqual([a.operationId, b.operationId]);
    expect(mergeResults([confirmed], [a], () => false)).toHaveLength(1);
  });
  it("a result is hidden once a newer operation of the same app exists in the current run", () => {
    expect(mergeResults([], [a, b], (app, at) => app === "liara-agent-demo" && at < "2026-10-24").map((x) => x.appName)).toEqual(["other-app"]);
  });
});

describe("ResultCard: truthful states", () => {
  const html = (r: LiveResultView, src: "action" | "history" = "action") => renderToStaticMarkup(<ResultCard r={r} source={src} />);
  it("DEPLOYED ⇒ verified success with the release id and all six levels, distinguishable as a RECORD when it is history", () => {
    const h = html(view());
    expect(h).toContain('data-state="DEPLOYED"');
    expect(h).toContain(liveUi.flow.result.headline.DEPLOYED_OBSERVED!);
    expect(h).toContain("6ada74737ebf55567c8e9382");
    expect((h.match(/data-level="[A-Za-z]+" data-value="ok"/g) ?? []).length).toBe(6);
    expect(h).toContain('role="status"');
    const hist = html(view(), "history");
    expect(hist).toContain(liveUi.flow.result.historyTitle);
    expect(hist).toContain(liveUi.flow.result.historyNote);
    expect(hist).toContain('data-testid="live-result-record-badge"');
    expect(hist).not.toContain('role="status"');
    expect(hist).not.toContain('data-testid="live-operation"'); // never rendered as a running operation
    expect(findNestingViolations(h + hist)).toEqual([]);
  });
  it("inferred runtime evidence produces inferred headline and never claims all stages verified", () => {
    const h = html(view({ runtimeEvidence: "inferred", appletsReadable: false }));
    expect(h).toContain('data-state="DEPLOYED"');
    expect(h).toContain(liveUi.flow.result.headline.DEPLOYED_INFERRED!);
    expect(h).not.toContain(liveUi.flow.result.headline.DEPLOYED_OBSERVED!);
    expect(h).not.toContain("همهٔ سطوح");
    const hist = html(view({ runtimeEvidence: "inferred", appletsReadable: false }), "history");
    expect(hist).toContain('data-state="DEPLOYED"');
    expect(hist).toContain('data-source="history"');
    expect(hist).toContain(liveUi.flow.result.headline.DEPLOYED_INFERRED!);
    expect(hist).not.toContain("همهٔ سطوح");
  });
  it("unrecorded runtime evidence produces unrecorded headline and never claims all stages verified", () => {
    const h = html(view({ runtimeEvidence: "unrecorded", appletsReadable: null }));
    expect(h).toContain('data-state="DEPLOYED"');
    expect(h).toContain(liveUi.flow.result.headline.DEPLOYED_UNRECORDED!);
    expect(h).not.toContain(liveUi.flow.result.headline.DEPLOYED_OBSERVED!);
    expect(h).not.toContain("همهٔ سطوح");
    const hist = html(view({ runtimeEvidence: "unrecorded", appletsReadable: null }), "history");
    expect(hist).toContain('data-state="DEPLOYED"');
    expect(hist).toContain('data-source="history"');
    expect(hist).toContain(liveUi.flow.result.headline.DEPLOYED_UNRECORDED!);
    expect(hist).not.toContain("همهٔ سطوح");
  });
  it("directly observed runtime evidence retains full verification claim", () => {
    const h = html(view({ runtimeEvidence: "observed", appletsReadable: true }));
    expect(h).toContain('data-state="DEPLOYED"');
    expect(h).toContain(liveUi.flow.result.headline.DEPLOYED_OBSERVED!);
    expect(h).toContain("همهٔ سطوح");
  });
  it("NEEDS_OPERATOR_REVIEW ⇒ never success, shows the recovery guidance", () => {
    const h = html(view({ state: "NEEDS_OPERATOR_REVIEW", ladder: { ...view().ladder, runtimeStarted: "unknown", httpHealthVerified: "unknown" }, failureCode: "partially_verified", failureFa: "بخشی از سطوح تأیید شد", recoveryFa: ["نشانی را دستی ببینید"], runtimeEvidence: "unknown" }));
    expect(h).toContain(liveUi.flow.result.headline.NEEDS_OPERATOR_REVIEW!);
    expect(h).not.toContain(liveUi.flow.result.headline.DEPLOYED_OBSERVED!);
    expect(h).toContain('data-testid="live-result-failure"');
    expect(h).toContain("نشانی را دستی ببینید");
  });
  it("FAILED ⇒ a failure, with its message; an abandoned operation says it was abandoned and that nothing was deleted", () => {
    const f = html(view({ state: "FAILED", ladder: { ...view().ladder, httpHealthVerified: "failed" }, failureCode: "verification_failed", failureFa: "راستی‌آزمایی شکست خورد" }));
    expect(f).toContain(liveUi.flow.result.headline.FAILED!);
    expect(f).toContain("راستی‌آزمایی شکست خورد");
    expect(f).not.toContain(liveUi.flow.result.headline.DEPLOYED_OBSERVED!);
    const a = html(view({ state: "FAILED", failureCode: "abandoned_by_operator", failureFa: "x", abandoned: true }));
    expect(a).toContain(liveUi.flow.result.abandoned);
  });
  it("minimal data (no release id, unrecorded evidence, no recovery) renders without crashing", () => {
    const h = html(view({ releaseId: null, runtimeEvidence: "unrecorded", appletsReadable: null, recoveryFa: [], failureFa: null }));
    expect(h).toContain("—");
    expect(h).toContain(liveUi.flow.result.evidence.unrecorded!);
    expect(h).toContain(liveUi.flow.result.headline.DEPLOYED_UNRECORDED!);
    expect(h).not.toContain(liveUi.flow.result.headline.DEPLOYED_OBSERVED!);
  });
});

describe("evidence: inferred ≠ observed ≠ unknown (never a direct-observation claim without an applets reading)", () => {
  const note = (r: Partial<LiveResultView>) => renderToStaticMarkup(<EvidenceNote r={view(r)} />);
  it("inferred (applets endpoint errored): says so, names the API error, and says it does not invalidate the HTTP check", () => {
    const h = note({ runtimeEvidence: "inferred", appletsReadable: false });
    expect(h).toContain(liveUi.flow.result.evidence.inferred!);
    expect(h).toContain(liveUi.flow.result.appletsFailed);
    expect(h).not.toContain(liveUi.flow.result.evidence.observed!);
    expect(h).toContain('data-runtime-evidence="inferred"');
  });
  it("observed: direct reading, no applets-failure note", () => {
    const h = note({ runtimeEvidence: "observed", appletsReadable: true });
    expect(h).toContain(liveUi.flow.result.evidence.observed!);
    expect(h).not.toContain(liveUi.flow.result.appletsFailed);
  });
  it("unknown and unrecorded (legacy) are distinct and neither claims observation", () => {
    expect(note({ runtimeEvidence: "unknown", appletsReadable: null })).toContain(liveUi.flow.result.evidence.unknown!);
    const legacy = note({ runtimeEvidence: "unrecorded", appletsReadable: null });
    expect(legacy).toContain(liveUi.flow.result.evidence.unrecorded!);
    expect(legacy).not.toContain(liveUi.flow.result.evidence.observed!);
  });
  it("the inferred badge appears on the runtime level of a card only when it was inferred", () => {
    expect(renderToStaticMarkup(<ResultCard r={view({ runtimeEvidence: "inferred" })} source="action" />)).toContain("استنتاج‌شده");
    expect(renderToStaticMarkup(<ResultCard r={view({ runtimeEvidence: "observed", appletsReadable: true })} source="action" />)).not.toContain("استنتاج‌شده");
  });
});

describe("the page with results (real status document from the real state machine)", () => {
  async function prepared(review = false) {
    const h = await harness();
    if (review) h.fake.upload = "malformed"; // the real incident: a 2xx upload answer whose sourceID cannot be read ⇒ NEEDS_OPERATOR_REVIEW
    h.fake.apps.add("liara-agent-demo");
    h.fake.releaseIds.push("rel_old_1");
    const v = await h.svc.createExistingProposal(OWNER, { runId: h.runId, appName: "liara-agent-demo", backend: "api", zip: h.zip });
    await h.svc.decide(v.proposal.id, OWNER, { decision: "approve", digest: v.proposal.digest, confirmAppName: "liara-agent-demo" });
    const { settle } = await import("../helpers/live-exec");
    await settle(h, (await h.svc.execute(v.proposal.id, OWNER, h.zip)).id);
    const { AgentRunManager } = await import("@/server/agent/manager");
    const { MockDiagnosticLLMProvider } = await import("@/server/diagnostics/llm");
    const { mockSvc } = await import("../helpers/scenario-runner");
    const agent = new AgentRunManager({ svc: mockSvc(), store: h.store, provider: new MockDiagnosticLLMProvider("ok"), now: h.clk.now, quotaPerWindow: 99 });
    const run2 = (await agent.receiveProject({ sessionId: OWNER, archive: h.zip, filename: "demo.zip" })).runId;
    return { h, run2 };
  }
  const page = async (h: Awaited<ReturnType<typeof harness>>, runId: string, extra: Record<string, unknown> = {}) =>
    renderToStaticMarkup(<LiveDeploymentView status={await h.svc.status(OWNER, runId)} runId={runId} defaultApp="" readiness={{ verdict: "READY", frameworkFa: "Next.js" }} onChanged={() => undefined} {...extra} />);
  const action = (html: string) => /data-testid="live-next-action" data-action="([a-z_]+)"/.exec(html)?.[1];

  it("a NEW run with no proposal still shows the latest DEPLOYED result of the app (as a record), and the next step is not 'run the offline preview'", async () => {
    const { h, run2 } = await prepared();
    const st = await h.svc.status(OWNER, run2);
    expect(st.proposals).toEqual([]);
    expect(st.locks).toEqual([]); // history is not a lock
    expect(st.lastResults.map((r) => [r.appName, r.state, r.runtimeEvidence])).toEqual([["liara-agent-demo", "DEPLOYED", "observed"]]);
    const html = await page(h, run2);
    expect(html).toContain('data-testid="live-result"');
    expect(html).toContain('data-source="history"');
    expect(html).toContain(liveUi.flow.result.historyTitle);
    expect(html).not.toContain('data-testid="live-operation"');
    expect(html).not.toContain('data-testid="live-locks"');
    expect(action(html)).toBe("deployed_previously");
    expect(html).toContain(liveUi.flow.next.deployed_previously!.title);
    expect(findNestingViolations(html)).toEqual([]);
  });
  it("an operation under review is a LOCK (resolve_previous), never a success card; a confirmed NEEDS_OPERATOR_REVIEW stays a warning", async () => {
    const { h, run2 } = await prepared(true);
    const html = await page(h, run2, { confirmed: [view({ state: "NEEDS_OPERATOR_REVIEW", ladder: { ...view().ladder, runtimeStarted: "unknown" }, failureFa: "x", recoveryFa: [], runtimeEvidence: "unknown" })] });
    expect(action(html)).toBe("resolve_previous");
    expect(html).not.toContain(liveUi.flow.result.headline.DEPLOYED_OBSERVED!);
  });
  it("a confirmed DEPLOYED result stays on the page when the refreshed status no longer lists the operation, and a failed refresh keeps it and says so", async () => {
    const { h, run2 } = await prepared();
    const confirmed = view({ appName: "liara-agent-demo" });
    const withRefreshError = await page(h, run2, { confirmed: [confirmed], refreshError: "network" });
    expect(withRefreshError).toContain('data-source="action"');
    expect(withRefreshError).toContain(liveUi.flow.result.headline.DEPLOYED_OBSERVED!);
    expect(withRefreshError).toContain('data-testid="live-refresh-error"');
    expect(withRefreshError).toContain(liveUi.flow.result.refreshError);
    expect(await page(h, run2, { confirmed: [confirmed] })).not.toContain('data-testid="live-refresh-error"');
  });
});

describe("the mode banner never calls a live context a simulation", () => {
  async function banner(mode: "mock" | "live") {
    const { AgentWorkspace } = await import("@/components/agent-workspace");
    return renderToStaticMarkup(<AgentWorkspace apps={[]} provider="mock" mode={mode} />);
  }
  it("mock data ⇒ the simulation banner (unchanged); live data ⇒ the live-context banner and NO simulation assertion", async () => {
    const mock = await banner("mock");
    expect(mock).toContain('data-testid="sim-banner"');
    expect(mock).toContain(SIM_BANNER);
    expect(mock).not.toContain('data-testid="live-context-banner"');
    const live = await banner("live");
    expect(live).toContain('data-testid="live-context-banner"');
    expect(live).toContain(LIVE_CONTEXT_BANNER);
    expect(live).not.toContain('data-testid="sim-banner"');
    expect(live).not.toContain(SIM_BANNER);
    expect(live).toContain("تأیید جداگانه"); // the safety statement stays: nothing is written without a separate approval
    expect(live).toContain('role="status"');
  });
});

describe("evidence provenance and historical-vs-fresh in the result card", () => {
  const AT = "2026-10-23T08:12:12.640Z";
  const health = { observedAt: AT, outcome: "ok", status: 200, markerRequired: true, markerMatched: true, failure: null, durationMs: 37 };
  const applets500 = { observedAt: AT, readable: false, runtimeClass: null, appletCount: null, failure: "upstream_error" };
  const rich = (over: Partial<LiveResultView> = {}) => view({ evidenceObservedAt: AT, health, applets: applets500, runtimeEvidence: "inferred", appletsReadable: false, ...over });
  const html = (r: LiveResultView, onResolved?: () => void) => renderToStaticMarkup(<ResultCard r={r} source="history" onResolved={onResolved} />);

  it("shows the evidence SOURCE, TIME, status, marker match and duration of the recorded health probe, and says the evidence is historical", () => {
    const h = html(rich());
    expect(h).toContain(liveUi.flow.result.historicalTitle);
    expect(h).toContain('data-testid="live-evidence-time"');
    expect(h).toContain(liveUi.flow.result.health.title);
    expect(h).toContain(liveUi.flow.result.health.ok);
    expect(h).toContain(liveUi.flow.result.health.marker.matched);
    expect(h).toContain("۲۰۰");
    expect(h).toContain(liveUi.flow.result.health.ms);
    expect(h).toContain('data-testid="live-result-deploy-note"'); // "deployed" ≠ "healthy now"
    expect(h).toContain(liveUi.flow.result.deployNote);
  });
  it("the applets error is a SEPARATE line that says 'no information', never 'the app is down', next to a successful health line", () => {
    const h = html(rich());
    expect(h).toContain('data-testid="live-applets" data-kind="unreadable"');
    expect(h).toContain("نه اینکه برنامه خاموش باشد");
    expect(h).toContain('data-testid="live-health" data-kind="ok"');
    expect(h).not.toMatch(/برنامه خاموش است|runtime.*down/i);
  });
  it("unrecorded (legacy), 'no probe ran' and a verified failure are three different statements", () => {
    expect(html(view())).toContain('data-kind="unrecorded"'); // health undefined
    expect(html(rich({ health: null }))).toContain('data-testid="live-health" data-kind="not_probed"');
    const failed = html(rich({ health: { ...health, outcome: "http_error", status: 502, failure: "http_status", markerMatched: null } }));
    expect(failed).toContain('data-testid="live-health" data-kind="not_ok" data-outcome="http_error" data-failure="http_status"');
    expect(failed).toContain(liveUi.flow.result.health.failure.http_status!);
    const dns = html(rich({ health: { ...health, outcome: "network", status: null, failure: "dns", markerMatched: null } }));
    expect(dns).toContain(liveUi.flow.result.health.failure.dns!);
    expect(html(view({ evidenceObservedAt: null }))).toContain(liveUi.flow.result.timeUnrecorded);
  });
  it("no fresh check ⇒ it says so (only historical evidence exists); a fresh check is a SEPARATE block with its own time and never claims to change the deployment", () => {
    expect(html(rich())).toContain('data-testid="live-check" data-kind="none"');
    const check = { observedAt: "2026-10-24T09:00:00.000Z", verdict: "http_ok" as const, runtime: "inferred" as const, currentReleaseMatches: true, health: { ...health, observedAt: "2026-10-24T09:00:00.000Z" }, applets: { ...applets500, observedAt: "2026-10-24T09:00:00.000Z" } };
    const h = html(rich({ latestCheck: check }));
    expect(h).toContain('data-testid="live-check" data-kind="fresh" data-verdict="http_ok"');
    expect(h).toContain(liveUi.flow.result.check.verdicts.http_ok!);
    expect(h).toContain(liveUi.flow.result.check.unchanged);
    expect(h.indexOf('data-evidence-kind="historical"')).toBeLessThan(h.indexOf('data-kind="fresh"'));
    expect(h).toContain(liveUi.flow.result.headline.DEPLOYED_INFERRED!); // the deployment result is still the headline
    expect(h).not.toContain(liveUi.flow.result.headline.DEPLOYED_OBSERVED!);
    expect(html(rich({ runtimeEvidence: "observed", appletsReadable: true, latestCheck: check }))).toContain(liveUi.flow.result.headline.DEPLOYED_OBSERVED!);
  });
  it("a FAILED or INCONCLUSIVE fresh check keeps the DEPLOYED headline, and 'unknown' is not worded as 'down'", () => {
    const base = { observedAt: "2026-10-24T09:00:00.000Z", runtime: "unknown" as const, currentReleaseMatches: true as boolean | null, applets: null };
    const bad = html(rich({ latestCheck: { ...base, verdict: "http_failed", health: { ...health, outcome: "http_error", status: 503, failure: "http_status", markerMatched: null } } }));
    expect(bad).toContain('data-verdict="http_failed"');
    expect(bad).toContain(liveUi.flow.result.headline.DEPLOYED_INFERRED!);
    expect(bad).not.toContain(liveUi.flow.result.headline.DEPLOYED_OBSERVED!);
    expect(bad).toContain(liveUi.flow.result.check.verdicts.http_failed!);
    const unknown = html(rich({ latestCheck: { ...base, verdict: "unknown", health: { ...health, outcome: "timeout", status: null, failure: "timeout", markerMatched: null } } }));
    expect(unknown).toContain(liveUi.flow.result.check.verdicts.unknown!);
    expect(liveUi.flow.result.check.verdicts.unknown).toContain("نه لزوماً خاموش");
    expect(unknown).toContain(liveUi.flow.result.headline.DEPLOYED_INFERRED!);
    expect(unknown).not.toContain(liveUi.flow.result.headline.DEPLOYED_OBSERVED!);
    expect(html(rich({ latestCheck: { ...base, verdict: "unknown", health: null, currentReleaseMatches: false } }))).toContain(liveUi.flow.result.check.notCurrent);
  });
  it("the read-only re-check button is offered for DEPLOYED history that this session may act on — and nowhere else", () => {
    expect(html(rich({ access: "owner" }), () => undefined)).toContain('data-testid="live-recheck"');
    expect(html(rich({ access: "orphan" }), () => undefined)).toContain('data-testid="live-recheck"');
    expect(html(rich({ access: undefined }), () => undefined)).not.toContain('data-testid="live-recheck"');
    expect(html(rich({ access: "owner" }))).not.toContain('data-testid="live-recheck"'); // no handler
    expect(html(rich({ state: "FAILED", access: "owner" }), () => undefined)).not.toContain('data-testid="live-recheck"');
    expect(html(rich({ state: "NEEDS_OPERATOR_REVIEW", access: "owner" }), () => undefined)).not.toContain('data-testid="live-recheck"');
    expect(findNestingViolations(html(rich({ access: "owner" }), () => undefined))).toEqual([]);
  });
});

describe("the browser validates provenance fields strictly", () => {
  const AT = "2026-10-23T08:12:12.640Z";
  const h = { source: "http_probe", observedAt: AT, outcome: "ok", status: 200, markerRequired: true, markerMatched: true, failure: null, durationMs: 37 };
  const a = { observedAt: AT, readable: false, runtimeClass: null, appletCount: null, failure: "upstream_error" };
  const withEvidence = (e: Record<string, unknown>) => record({ evidence: { runtime: "inferred", appletsReadable: false, observedAt: AT, ...e }, transitions: [{ at: "2026-10-22T20:39:15.830Z" }, { at: AT }] });
  it("accepts well-formed health/applets/latestCheck and takes the completion time from the LAST transition", () => {
    const r = parseOperationResponse(record({ ...withEvidence({ health: h, applets: a }), latestCheck: { observedAt: "2026-10-24T00:00:00.000Z", verdict: "http_failed", runtime: "unknown", currentReleaseMatches: null, health: { ...h, outcome: "http_error", status: 503, failure: "http_status", markerMatched: null }, applets: null } }), OP)!;
    expect(r).toMatchObject({ evidenceObservedAt: AT, health: { status: 200, markerMatched: true, durationMs: 37 }, applets: { readable: false, failure: "upstream_error" }, completedAt: AT, latestCheck: { verdict: "http_failed", health: { failure: "http_status" } } });
  });
  it("rejects malformed observations (wrong outcome/failure/source/types, absurd numbers) ⇒ 'uncertain', never a half-trusted result", () => {
    for (const bad of [{ health: { ...h, outcome: "great" } }, { health: { ...h, failure: "boom" } }, { health: { ...h, source: "other" } }, { health: { ...h, status: "200" } }, { health: { ...h, durationMs: -1 } }, { health: { ...h, durationMs: 1e12 } }, { health: "ok" }, { applets: { ...a, readable: "no" } }, { applets: { ...a, failure: "x".repeat(80) } }, { observedAt: 5 }]) expect(parseOperationResponse(withEvidence(bad), OP), JSON.stringify(bad).slice(0, 60)).toBeNull();
    expect(parseOperationResponse(record({ latestCheck: { observedAt: AT, verdict: "healthy", runtime: "observed", currentReleaseMatches: true, health: null, applets: null } }), OP)).toBeNull();
    expect(parseOperationResponse(record({ latestCheck: "yes" }), OP)).toBeNull();
  });
  it("evidence members that are simply absent (older record) parse fine and stay 'unrecorded'", () => {
    const r = parseOperationResponse(record({ evidence: undefined }), OP)!;
    expect(r).toMatchObject({ runtimeEvidence: "unrecorded", evidenceObservedAt: null, latestCheck: null });
    expect(r.health).toBeUndefined();
  });
});

describe("OperationView ladder verdict: truthful claims", () => {
  const opRecord = (runtime: "observed" | "inferred" | "unknown" | null = "observed") => ({
    id: OP,
    kind: "deploy_existing_app" as const,
    backend: "api" as const,
    appName: "liara-agent-demo",
    state: "DEPLOYED" as const,
    updatedAt: "2026-10-23T08:12:12.640Z",
    remote: { releaseId: "6ada74737ebf55567c8e9382" },
    ladder: ladderAll("ok") as never,
    failure: null,
    recoveryFa: [],
    transitions: [{ from: "VERIFYING_DEPLOYMENT", to: "DEPLOYED", at: "2026-10-23T08:12:12.640Z" }],
    evidence: runtime ? { runtime, appletsReadable: runtime === "observed" } : undefined,
  });
  const renderOp = (rec: Parameters<typeof OperationView>[0]["op"]) => renderToStaticMarkup(<OperationView op={rec} onChanged={() => undefined} />);

  it("observed runtime produces 'کاملاً راستی‌آزمایی‌شده'", () => {
    const html = renderOp(opRecord("observed") as never);
    expect(html).toContain('data-testid="live-ladder-verdict" data-verdict="DEPLOYED"');
    expect(html).toContain(liveUi.verification.verdict.DEPLOYED_OBSERVED!);
    expect(html).toContain("کاملاً راستی‌آزمایی‌شده");
  });

  it("inferred runtime produces inferred verdict and does NOT claim 'کاملاً راستی‌آزمایی‌شده'", () => {
    const html = renderOp(opRecord("inferred") as never);
    expect(html).toContain('data-testid="live-ladder-verdict" data-verdict="DEPLOYED"');
    expect(html).toContain(liveUi.verification.verdict.DEPLOYED_INFERRED!);
    expect(html).not.toContain("کاملاً راستی‌آزمایی‌شده");
  });

  it("unrecorded runtime produces unrecorded verdict and does NOT claim 'کاملاً راستی‌آزمایی‌شده'", () => {
    const html = renderOp(opRecord(null) as never);
    expect(html).toContain('data-testid="live-ladder-verdict" data-verdict="DEPLOYED"');
    expect(html).toContain(liveUi.verification.verdict.DEPLOYED_UNRECORDED!);
    expect(html).not.toContain("کاملاً راستی‌آزمایی‌شده");
  });
});


describe("no contradictory verification claims anywhere on the rendered existing-app page (headline, header badge, ladder verdict, help, next action)", () => {
  const OVERCLAIMS = ["همهٔ سطوح", "کاملاً راستی‌آزمایی", "واقعاً مستقر و راستی‌آزمایی‌شده", "مستقر و راستی‌آزمایی‌شده"];
  async function deployedPage(variant: "observed" | "inferred" | "unrecorded") {
    const h = await harness();
    h.fake.apps.add("liara-agent-demo");
    h.fake.releaseIds.push("rel_old_1");
    if (variant === "inferred") h.fake.runtimeOk = false; // GET /applets answers an error; the marker-verified HTTP answer is the only runtime evidence
    const v = await h.svc.createExistingProposal(OWNER, { runId: h.runId, appName: "liara-agent-demo", backend: "api", zip: h.zip });
    await h.svc.decide(v.proposal.id, OWNER, { decision: "approve", digest: v.proposal.digest, confirmAppName: "liara-agent-demo" });
    const { settle } = await import("../helpers/live-exec");
    const op = await settle(h, (await h.svc.execute(v.proposal.id, OWNER, h.zip)).id);
    expect(op.state).toBe("DEPLOYED");
    if (variant === "unrecorded") {
      expect(await h.store.updateOperation({ ...op, evidence: undefined }, "DEPLOYED")).toBe(true); // a record written before provenance existed
    }
    const status = await h.svc.status(OWNER, h.runId);
    const html = renderToStaticMarkup(<LiveDeploymentView status={status} runId={h.runId} defaultApp="" readiness={{ verdict: "READY", frameworkFa: "Next.js" }} onChanged={() => undefined} />);
    return { html, status, op };
  }
  it("observed runtime: verification language is allowed (headline and verdict say so) and the header stays neutral", async () => {
    const { html, status } = await deployedPage("observed");
    expect(status.existing?.uiState).toBe("LIVE_VERIFIED");
    expect(html).toContain('data-state="LIVE_VERIFIED"');
    expect(html).toContain(liveUi.flow.result.headline.DEPLOYED_OBSERVED!);
    expect(html).toContain(liveUi.verification.verdict.DEPLOYED_OBSERVED!);
    expect(html).toContain(">" + liveUi.states.LIVE_VERIFIED + "<"); // the header badge text itself
    expect(liveUi.states.LIVE_VERIFIED).toBe("استقرار انجام شد");
  });
  it.each(["inferred", "unrecorded"] as const)("%s runtime: headline, verdict and header agree, and NOTHING on the page claims all levels were verified", async (variant) => {
    const { html, op } = await deployedPage(variant);
    expect(op.state).toBe("DEPLOYED"); // the historical deployment state is preserved
    const head = variant === "inferred" ? liveUi.flow.result.headline.DEPLOYED_INFERRED! : liveUi.flow.result.headline.DEPLOYED_UNRECORDED!;
    const verdict = variant === "inferred" ? liveUi.verification.verdict.DEPLOYED_INFERRED! : liveUi.verification.verdict.DEPLOYED_UNRECORDED!;
    expect(html).toContain(head);
    expect(html).toContain(verdict);
    expect(html).toContain('data-testid="live-result-deploy-note"');
    for (const claim of OVERCLAIMS) expect(html, claim).not.toContain(claim);
    expect(html).toContain(`data-runtime-evidence="${variant}"`);
    // the historical evidence is labelled historical and there is no fresh check yet
    expect(html).toContain('data-evidence-kind="historical"');
    expect(html).toContain('data-testid="live-check" data-kind="none"');
    expect(findNestingViolations(html)).toEqual([]);
  });
  it("every generic (evidence-less) label is neutral — it says the deployment completed, never that it was verified", () => {
    for (const text of [liveUi.states.LIVE_VERIFIED, liveUi.stateHelp.LIVE_VERIFIED!, liveUi.states_fa.DEPLOYED, liveUi.flow.result.headline.DEPLOYED!, liveUi.verification.verdict.DEPLOYED!, liveUi.flow.next.done_verified!.detail, liveUi.flow.next.deployed_previously!.title]) {
      for (const claim of [...OVERCLAIMS, "راستی‌آزمایی‌شده", "راستی‌آزمایی شده"]) expect(text, claim).not.toContain(claim);
    }
  });
});
