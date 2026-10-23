import { describe, expect, it } from "vitest";
import { isLiveError, type LiveOperationRecord } from "@/server/live/types";
import type { ProbeResult } from "@/server/live/probe";
import { parseOperationResponse } from "@/lib/live-result";
import { redactDeep } from "@/server/security/redact";
import { harness, OTHER, OWNER, settle } from "../helpers/live-exec";

const APP = "liara-agent-demo";
type H = Awaited<ReturnType<typeof harness>>;
const OK: ProbeResult = { outcome: "ok", status: 200, markerFound: true, failure: null, durationMs: 37 };
const NETWORK: ProbeResult = { outcome: "network", status: null, markerFound: null, failure: "dns", durationMs: 12 };
const code = async (p: Promise<unknown>) => {
  try {
    await p;
    return null;
  } catch (e) {
    return isLiveError(e) ? e.code : "other";
  }
};

/** a world whose probe answer can be switched per test step; every probe call is recorded */
async function world(initial: ProbeResult = OK, o: { store?: Parameters<typeof harness>[0] extends infer X ? (X extends { store?: infer S } ? S : never) : never; poll?: { verifyBudgetMs: number; pollIntervalMs: number; reverifyBudgetMs?: number } } = {}) {
  const probes: { timeoutMs?: number; signal?: AbortSignal }[] = [];
  let next: ProbeResult | (() => Promise<ProbeResult>) = initial;
  const h = await harness({ store: o.store, poll: o.poll ?? { verifyBudgetMs: 3_000, pollIntervalMs: 1000, reverifyBudgetMs: 3_000 }, probe: async (p) => (probes.push({ timeoutMs: p.timeoutMs, signal: p.signal }), typeof next === "function" ? next() : next) });
  h.fake.apps.add(APP);
  h.fake.releaseIds.push("rel_old_1");
  return { h, probes, setProbe: (r: ProbeResult | (() => Promise<ProbeResult>)) => void (next = r) };
}
async function release(h: H): Promise<LiveOperationRecord> {
  const v = await h.svc.createExistingProposal(OWNER, { runId: h.runId, appName: APP, backend: "api", zip: h.zip });
  await h.svc.decide(v.proposal.id, OWNER, { decision: "approve", digest: v.proposal.digest, confirmAppName: APP });
  return settle(h, (await h.svc.execute(v.proposal.id, OWNER, h.zip)).id);
}
const without = (op: LiveOperationRecord) => ({ ...op, latestCheck: undefined });

describe("evidence recorded WITH the ladder keeps its provenance (source, time, outcome, status, marker, category, duration)", () => {
  it("applets endpoint HTTP 500 + marker-verified health ⇒ DEPLOYED; the health success is NOT downgraded and the applets error is recorded SEPARATELY as 'no information'", async () => {
    const { h } = await world();
    h.fake.runtimeOk = false; // GET /applets → HTTP 500 at Liara
    const op = await release(h);
    expect(op.state).toBe("DEPLOYED");
    expect(op.ladder).toMatchObject({ httpHealthVerified: "ok", runtimeStarted: "ok" });
    expect(op.evidence).toMatchObject({
      runtime: "inferred", // an inference — labelled as such, never "observed"
      appletsReadable: false,
      health: { source: "http_probe", outcome: "ok", status: 200, markerRequired: true, markerMatched: true, failure: null, durationMs: 37 },
      applets: { readable: false, runtimeClass: null, appletCount: null, failure: "upstream_error" },
    });
    expect(op.evidence?.observedAt).toMatch(/^\d{4}-\d{2}-\d{2}T/);
    expect(op.evidence?.health?.observedAt).toBe(op.evidence?.observedAt);
    expect(op.ladder.runtimeStarted).not.toBe("failed");
  });
  it("applets HTTP 500 and NO reliable health evidence ⇒ the runtime is UNKNOWN — never failed, never healthy; the operation is under review, not FAILED", async () => {
    const { h } = await world(NETWORK);
    h.fake.runtimeOk = false;
    const op = await release(h);
    expect(op.state).toBe("NEEDS_OPERATOR_REVIEW");
    expect(op.ladder).toMatchObject({ runtimeStarted: "unknown", httpHealthVerified: "unknown" });
    expect(Object.values(op.ladder)).not.toContain("failed");
    expect(op.evidence).toMatchObject({ runtime: "unknown", appletsReadable: false, health: { outcome: "network", failure: "dns", status: null, markerMatched: null }, applets: { readable: false, failure: "upstream_error" } });
  });
  it("applets readable and running ⇒ 'observed' with the applet class and count recorded", async () => {
    const { h } = await world();
    const op = await release(h);
    expect(op.evidence).toMatchObject({ runtime: "observed", appletsReadable: true, applets: { readable: true, runtimeClass: "running", appletCount: 1, failure: null } });
  });
  it("a failing, slow-to-respond or marker-less probe is recorded with its safe category, never as a pass", async () => {
    for (const [probe, expected] of [
      [{ outcome: "http_error", status: 502, markerFound: null, failure: "http_status", durationMs: 90 }, { status: 502, failure: "http_status" }],
      [{ outcome: "ok", status: 200, markerFound: false, failure: "marker_mismatch", durationMs: 15 }, { status: 200, markerMatched: false, failure: "marker_mismatch" }],
      [{ outcome: "timeout", status: null, markerFound: null, failure: "timeout", durationMs: 8000 }, { status: null, failure: "timeout" }],
    ] as [ProbeResult, Record<string, unknown>][]) {
      const { h } = await world(probe);
      const op = await release(h);
      expect(op.state, probe.outcome).not.toBe("DEPLOYED");
      expect(op.evidence?.health).toMatchObject({ source: "http_probe", outcome: probe.outcome, ...expected });
    }
  });
});

describe("a FRESH read-only check of a DEPLOYED operation never rewrites history", () => {
  it("success: persisted next to the deployment with its own provenance; state, ladder, historical evidence, transitions and completion time are untouched; nothing is written to Liara", async () => {
    const { h } = await world();
    const done = await release(h);
    const writes = [...h.fake.calls];
    h.clk.advance(3_600_000);
    const checked = await h.svc.resolve(done.id, OWNER, "recheck");
    expect(checked.latestCheck).toMatchObject({ verdict: "http_ok", runtime: "observed", currentReleaseMatches: true, health: { source: "http_probe", outcome: "ok", status: 200, markerMatched: true, failure: null, durationMs: 37 }, applets: { readable: true } });
    expect(checked.latestCheck!.observedAt > done.evidence!.observedAt!).toBe(true); // fresh ≠ historical: its own, later time
    expect(without(checked)).toEqual(without(done)); // everything else byte-for-byte as the deployment left it (incl. updatedAt, transitions, evidence)
    expect(h.fake.calls).toEqual(writes);
    const events = (await h.store.readAudit(2000)).map((r) => r.event);
    expect(events).toContain("live.operation_recheck");
    expect((await h.store.getOperation(done.id))?.latestCheck?.verdict).toBe("http_ok");
  });
  it("a LATER failing check is a failed CHECK: the deployment stays DEPLOYED/completed (active=0), the old success stays historical with its own time", async () => {
    const { h, setProbe } = await world();
    const done = await release(h);
    h.clk.advance(3_600_000);
    for (const [probe, verdict] of [
      [NETWORK, "unknown"],
      [{ outcome: "http_error", status: 503, markerFound: null, failure: "http_status", durationMs: 40 } as ProbeResult, "http_failed"],
      [{ outcome: "ok", status: 200, markerFound: false, failure: "marker_mismatch", durationMs: 9 } as ProbeResult, "http_failed"],
      [{ outcome: "timeout", status: null, markerFound: null, failure: "timeout", durationMs: 8000 } as ProbeResult, "unknown"],
    ] as [ProbeResult, string][]) {
      setProbe(probe);
      const checked = await h.svc.resolve(done.id, OWNER, "recheck");
      expect(checked.latestCheck?.verdict, probe.outcome).toBe(verdict);
      expect(checked.latestCheck?.health).toMatchObject({ outcome: probe.outcome, failure: probe.failure });
      expect(checked.state).toBe("DEPLOYED");
      expect(checked.evidence).toEqual(done.evidence); // the historical evidence is the same object content, not overwritten
      expect(checked.ladder).toEqual(done.ladder);
      expect(checked.failure).toBeNull();
      expect((await h.store.getOperation(done.id))?.state).toBe("DEPLOYED");
      h.clk.advance(60_000);
    }
    // and the next success replaces only the CHECK
    setProbe(OK);
    const again = await h.svc.resolve(done.id, OWNER, "recheck");
    expect(again.latestCheck?.verdict).toBe("http_ok");
    expect(again.evidence?.observedAt).toBe(done.evidence?.observedAt);
    expect((await h.svc.status(OWNER, await newRun(h))).locks).toEqual([]); // a finished deployment is never a lock, whatever the checks say
  });
  it("applets HTTP 500 during a fresh check is recorded as 'no information' and does NOT turn a successful health answer into a failure", async () => {
    const { h } = await world();
    const done = await release(h);
    h.fake.runtimeOk = false;
    const checked = await h.svc.resolve(done.id, OWNER, "recheck");
    expect(checked.latestCheck).toMatchObject({ verdict: "http_ok", runtime: "inferred", applets: { readable: false, failure: "upstream_error" } });
  });
  it("the returned lastResults carries the latest check and keeps the ORIGINAL completion time", async () => {
    const { h } = await world();
    const done = await release(h);
    h.clk.advance(3_600_000);
    await h.svc.resolve(done.id, OWNER, "recheck");
    const st = await h.svc.status(OWNER, await newRun(h));
    expect(st.lastResults[0]).toMatchObject({ operationId: done.id, state: "DEPLOYED", completedAt: done.transitions.at(-1)!.at, latestCheck: { verdict: "http_ok" }, access: "owner" });
    expect(st.lastResults[0]!.completedAt).not.toBe(st.lastResults[0]!.latestCheck!.observedAt);
  });
  it("only a DEPLOYED operation can be re-checked; the owner (or an explicit orphan adoption) only; unknown run states are refused", async () => {
    const { h } = await world();
    const done = await release(h);
    expect(await code(h.svc.resolve(done.id, OTHER, "recheck"))).toBe("live_not_found"); // another session, owner considered active (strict default)
    const gone = h.rebuild({ isOwnerActive: () => false });
    expect(await code(gone.resolve(done.id, OTHER, "recheck"))).toBe("live_not_found"); // orphan, but no explicit acknowledgement
    expect((await gone.resolve(done.id, OTHER, "recheck", true)).latestCheck?.verdict).toBe("http_ok");
    // under review / failed operations are not re-checked
    const w2 = await world(NETWORK);
    const review = await release(w2.h);
    expect(review.state).toBe("NEEDS_OPERATOR_REVIEW");
    expect(await code(w2.h.svc.resolve(review.id, OWNER, "recheck"))).toBe("live_invalid_state");
    await w2.h.svc.resolve(review.id, OWNER, "abandon");
    expect(await code(w2.h.svc.resolve(review.id, OWNER, "recheck"))).toBe("live_invalid_state");
  });
  it("it works through the strict record schema on SQLite and survives a re-read from a fresh connection; the wire form is accepted by the browser's validator", async () => {
    const { mkdtempSync, rmSync } = await import("node:fs");
    const { tmpdir } = await import("node:os");
    const path = await import("node:path");
    const { SqliteLiveStore } = await import("@/server/live/store");
    const dir = mkdtempSync(path.join(tmpdir(), "live-recheck-"));
    try {
      const db = path.join(dir, "a.db");
      const { h } = await world(OK, { store: new SqliteLiveStore(db) });
      const done = await release(h);
      const checked = await h.svc.resolve(done.id, OWNER, "recheck");
      const reread = await new SqliteLiveStore(db).getOperation(done.id);
      expect(reread?.latestCheck).toEqual(checked.latestCheck);
      expect(reread?.evidence).toEqual(done.evidence);
      const parsed = parseOperationResponse(redactDeep(JSON.parse(JSON.stringify(checked))), done.id);
      expect(parsed).toMatchObject({ state: "DEPLOYED", latestCheck: { verdict: "http_ok", health: { status: 200, markerMatched: true } }, evidenceObservedAt: done.evidence!.observedAt });
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });
});

describe("verification stays bounded, de-duplicated and cancellable", () => {
  it("every probe of a verification gets a bounded timeout (1–8 s) and the run's abort signal; the total never exceeds the re-verify budget", async () => {
    const { h, probes, setProbe } = await world(NETWORK, { poll: { verifyBudgetMs: 60_000, pollIntervalMs: 1000, reverifyBudgetMs: 4_000 } });
    const review = await release(h);
    expect(review.state).toBe("NEEDS_OPERATOR_REVIEW");
    probes.length = 0;
    h.sleeps.length = 0;
    setProbe(NETWORK);
    const again = await h.svc.resolve(review.id, OWNER, "reverify");
    expect(again.state).toBe("NEEDS_OPERATOR_REVIEW"); // still no evidence ⇒ never promoted
    expect(probes.length).toBeGreaterThan(0);
    for (const p of probes) {
      expect(p.timeoutMs!).toBeGreaterThanOrEqual(1_000);
      expect(p.timeoutMs!).toBeLessThanOrEqual(8_000);
      expect(p.signal).toBeInstanceOf(AbortSignal);
    }
    expect(h.sleeps.reduce((a, b) => a + b, 0)).toBeLessThanOrEqual(5_000); // 4 s budget (+ one poll step), not the 60 s post-release budget
    expect(probes.length).toBeLessThanOrEqual(6); // bounded number of sequential probes
  });
  it("a probe that never answers is cancelled by the run's deadline guard and ends as explicit evidence — not a hang, not a success", async () => {
    const { h, setProbe } = await world(NETWORK, { poll: { verifyBudgetMs: 60_000, pollIntervalMs: 1000, reverifyBudgetMs: 100 } });
    const review = await release(h);
    setProbe(NETWORK);
    // from now on the probe hangs until the abort signal fires
    let sawAbort = false;
    const h2 = h.rebuild({ probe: (p) => new Promise((res) => p.signal!.addEventListener("abort", () => ((sawAbort = true), res({ outcome: "cancelled", status: null, markerFound: null, failure: "cancelled", durationMs: 2100 })), { once: true })) });
    const t0 = Date.now();
    const again = await h2.resolve(review.id, OWNER, "reverify");
    expect(Date.now() - t0).toBeLessThan(10_000);
    expect(sawAbort).toBe(true);
    expect(again.state).toBe("NEEDS_OPERATOR_REVIEW");
    expect(again.evidence?.health).toMatchObject({ outcome: "cancelled", failure: "cancelled" });
    expect(again.ladder.httpHealthVerified).toBe("unknown");
  }, 20_000);
  it("concurrent requests are coalesced: two simultaneous re-verifications / re-checks run ONE probe sequence and get the same answer", async () => {
    const { h, probes, setProbe } = await world();
    const done = await release(h);
    let release1!: () => void;
    const gate = new Promise<void>((r) => (release1 = r));
    probes.length = 0;
    setProbe(async () => (await gate, OK));
    const a = h.svc.resolve(done.id, OWNER, "recheck");
    const b = h.svc.resolve(done.id, OWNER, "recheck");
    await new Promise((r) => setTimeout(r, 20));
    release1();
    const [ra, rb] = await Promise.all([a, b]);
    expect(probes).toHaveLength(1);
    expect(ra).toBe(rb);
    // …and the same for re-verification of an operation under review
    const w = await world(NETWORK);
    const review = await release(w.h);
    w.probes.length = 0;
    const [x, y] = await Promise.all([w.h.svc.resolve(review.id, OWNER, "reverify"), w.h.svc.resolve(review.id, OWNER, "reverify")]);
    expect(x).toBe(y);
    const single = await world(NETWORK);
    const r2 = await release(single.h);
    single.probes.length = 0;
    await single.h.svc.resolve(r2.id, OWNER, "reverify");
    expect(w.probes.length).toBe(single.probes.length); // not doubled
  });
});

async function newRun(h: H) {
  const { AgentRunManager } = await import("@/server/agent/manager");
  const { MockDiagnosticLLMProvider } = await import("@/server/diagnostics/llm");
  const { mockSvc } = await import("../helpers/scenario-runner");
  const agent = new AgentRunManager({ svc: mockSvc(), store: h.store, provider: new MockDiagnosticLLMProvider("ok"), now: h.clk.now, quotaPerWindow: 99 });
  return (await agent.receiveProject({ sessionId: OWNER, archive: h.zip, filename: "demo.zip" })).runId;
}
