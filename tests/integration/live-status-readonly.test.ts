import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { afterAll, describe, expect, it, vi } from "vitest";
import { LIVE_APPROVAL_TTL_MS } from "@/server/live/service";
import { SqliteLiveStore } from "@/server/live/store";
import type { LiveStore as Store } from "@/server/live/store";
import { harness, OWNER, settle } from "../helpers/live-exec";

/**
 * GET /api/agent/live/status is a polled READ. Its one deliberate side effect is lazy cleanup of proposals whose approval window has passed (so a dead proposal
 * never shows up as a lock). These tests pin the contract: with nothing due it writes NOTHING; with something due it finalises exactly once, through the legal transition.
 */
const APP = "liara-agent-demo";
const TTL = LIVE_APPROVAL_TTL_MS;
type H = Awaited<ReturnType<typeof harness>>;
const dirs: string[] = [];
afterAll(() => dirs.forEach((d) => rmSync(d, { recursive: true, force: true })));
const backends: [string, () => Store | undefined][] = [
  ["in-memory store", () => undefined],
  ["SQLite store (temporary file)", () => {
    const d = mkdtempSync(path.join(tmpdir(), "live-status-ro-"));
    dirs.push(d);
    return new SqliteLiveStore(path.join(d, "a.db"));
  }],
];
const WRITERS = ["createLiveProposal", "transitionLiveProposal", "beginExecution", "updateOperation", "bootstrapScope", "appendAudit"] as const;
function watchWrites(h: H) {
  const store = h.store as unknown as Record<string, (...a: unknown[]) => unknown>;
  const spies = WRITERS.map((m) => ({ m, spy: vi.spyOn(store, m) }));
  return { calls: () => spies.flatMap(({ m, spy }) => spy.mock.calls.map(() => m)), reset: () => spies.forEach(({ spy }) => spy.mockClear()), restore: () => spies.forEach(({ spy }) => spy.mockRestore()) };
}
async function world(store?: Store) {
  const h = await harness({ store });
  h.fake.apps.add(APP);
  h.fake.releaseIds.push("rel_old_1");
  return h;
}
const propose = (h: H) => h.svc.createExistingProposal(OWNER, { runId: h.runId, appName: APP, backend: "api", zip: h.zip });
const poll = async (h: H, n = 3) => { for (let i = 0; i < n; i++) await h.svc.status(OWNER, h.runId); };

describe.each(backends)("status reads do not write when nothing is due — %s", (_n, mk) => {
  it("no proposal ⇒ no writes", async () => {
    const h = await world(mk());
    const w = watchWrites(h);
    await poll(h);
    expect(w.calls()).toEqual([]);
    w.restore();
  });
  it("a PENDING proposal inside its window ⇒ no writes, however often it is polled", async () => {
    const h = await world(mk());
    const v = await propose(h);
    const w = watchWrites(h);
    h.clk.advance(TTL - 1_000);
    await poll(h, 5);
    expect(w.calls()).toEqual([]);
    expect((await h.store.getLiveProposal(v.proposal.id))!.status).toBe("PENDING");
    w.restore();
  });
  it("an APPROVED proposal inside its window ⇒ no writes", async () => {
    const h = await world(mk());
    const v = await propose(h);
    await h.svc.decide(v.proposal.id, OWNER, { decision: "approve", digest: v.proposal.digest, confirmAppName: v.proposal.appName });
    const w = watchWrites(h);
    h.clk.advance(TTL - 1_000);
    await poll(h, 3);
    expect(w.calls()).toEqual([]);
    w.restore();
  });
  it("a finished (DEPLOYED) operation ⇒ no writes, even long after its window", async () => {
    const h = await world(mk());
    const v = await propose(h);
    await h.svc.decide(v.proposal.id, OWNER, { decision: "approve", digest: v.proposal.digest, confirmAppName: v.proposal.appName });
    const done = await settle(h, (await h.svc.execute(v.proposal.id, OWNER, h.zip)).id);
    expect(done.state).toBe("DEPLOYED");
    const w = watchWrites(h);
    h.clk.advance(TTL * 10);
    await poll(h, 3);
    expect(w.calls()).toEqual([]);
    w.restore();
  });
  it("a proposal that IS due is finalised by the first poll (one transition, one cancel, one audit row) and later polls write nothing", async () => {
    const h = await world(mk());
    const v = await propose(h);
    h.clk.advance(TTL + 1);
    const w = watchWrites(h);
    await h.svc.status(OWNER, h.runId);
    expect(w.calls().filter((m) => m === "transitionLiveProposal")).toHaveLength(1);
    expect(w.calls().filter((m) => m === "updateOperation")).toHaveLength(1);
    expect(w.calls().filter((m) => m === "appendAudit")).toHaveLength(1);
    expect(w.calls().filter((m) => m === "createLiveProposal" || m === "beginExecution" || m === "bootstrapScope")).toEqual([]);
    expect((await h.store.getLiveProposal(v.proposal.id))!.status).toBe("EXPIRED");
    expect((await h.store.getOperation(v.proposal.operationId))!.state).toBe("CANCELLED");
    w.reset();
    await poll(h, 3);
    expect(w.calls()).toEqual([]);
    w.restore();
  });
});
