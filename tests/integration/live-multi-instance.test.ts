import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { afterAll, describe, expect, it } from "vitest";
import { SqliteLiveStore } from "@/server/live/store";
import type { LiveStore } from "@/server/live/store";
import { harness, OWNER, settle } from "../helpers/live-exec";

const APP = "liara-agent-demo";
type H = Awaited<ReturnType<typeof harness>>;
const dirs: string[] = [];
afterAll(() => dirs.forEach((d) => rmSync(d, { recursive: true, force: true })));
const backends: [string, () => LiveStore | undefined][] = [
  ["in-memory store", () => undefined],
  ["SQLite store (temporary file)", () => {
    const d = mkdtempSync(path.join(tmpdir(), "live-multi-"));
    dirs.push(d);
    return new SqliteLiveStore(path.join(d, "a.db"));
  }],
];
const wait = async (cond: () => Promise<boolean>, ms = 600) => {
  for (let i = 0; i < ms / 10; i++) {
    if (await cond()) return true;
    await new Promise((r) => setTimeout(r, 10));
  }
  return false;
};

/** service A claims and starts an execution whose upload is held open; returns the operation id and a way to let it finish */
async function runningInA(store?: LiveStore) {
  const h = await harness({ store });
  h.fake.apps.add(APP);
  h.fake.releaseIds.push("rel_old_1");
  let open!: () => void;
  const gate = new Promise<void>((r) => (open = r));
  const orig = h.fake.transport.uploadSource;
  h.fake.transport.uploadSource = async (...a) => (await gate, orig(...a));
  const v = await h.svc.createExistingProposal(OWNER, { runId: h.runId, appName: APP, backend: "api", zip: h.zip });
  await h.svc.decide(v.proposal.id, OWNER, { decision: "approve", digest: v.proposal.digest, confirmAppName: APP });
  const op = await h.svc.execute(v.proposal.id, OWNER, h.zip);
  expect(await wait(async () => (await h.store.getOperation(op.id))?.state === "UPLOADING_SOURCE")).toBe(true);
  return { h, op, open };
}
const state = async (h: H, id: string) => (await h.store.getOperation(id))!;

describe.each(backends)("two service instances sharing one store — %s", (_n, mk) => {
  it("the claim is stamped with the executing instance and pid", async () => {
    const { h, op, open } = await runningInA(mk());
    const rec = await state(h, op.id);
    expect(rec.runner).toMatchObject({ pid: process.pid });
    expect(rec.runner!.instance).toMatch(/^[0-9a-f]{12}$/);
    open();
    await settle(h, op.id);
  });

  it("a SECOND service on the same store (another process that is alive) does NOT mark A's genuinely active operation as interrupted; A finishes it; repeated recovery changes nothing", async () => {
    const { h, op, open } = await runningInA(mk());
    const before = JSON.stringify(await state(h, op.id));
    const b = h.rebuild({ instanceId: "second-instance", pid: process.pid + 7, isPidAlive: (pid) => pid === process.pid }); // B is a different process; A's pid is alive
    await b.status(OWNER, h.runId); // awaits B's start-up recovery
    expect(JSON.stringify(await state(h, op.id))).toBe(before);
    h.rebuild({ instanceId: "third-instance", pid: process.pid + 8, isPidAlive: () => true });
    await new Promise((r) => setTimeout(r, 40));
    expect(JSON.stringify(await state(h, op.id))).toBe(before); // idempotent: nothing was touched
    expect((await state(h, op.id)).state).toBe("UPLOADING_SOURCE");
    open();
    const done = await settle(h, op.id);
    expect(done.state).toBe("DEPLOYED"); // the owner could finish: it was never marked interrupted behind its back
    expect(done.transitions.some((t) => t.note === "interrupted_by_restart")).toBe(false);
  });

  it("another service OBJECT in the same live process is also left alone", async () => {
    const { h, op, open } = await runningInA(mk());
    const b = h.rebuild({ instanceId: "hmr-duplicate", isPidAlive: () => false }); // same pid (this process), different instance
    await b.status(OWNER, h.runId);
    expect((await state(h, op.id)).state).toBe("UPLOADING_SOURCE");
    open();
    expect((await settle(h, op.id)).state).toBe("DEPLOYED");
  });

  it("when the runner's process is DEAD (crash/restart) the operation IS marked interrupted exactly once — never retried", async () => {
    const { h, op, open } = await runningInA(mk());
    const calls = [...h.fake.calls];
    const b = h.rebuild({ instanceId: "after-crash", pid: process.pid + 9, isPidAlive: () => false });
    await b.status(OWNER, h.runId);
    const rec = await state(h, op.id);
    expect(rec.state).toBe("NEEDS_OPERATOR_REVIEW");
    expect(rec.failure).toMatchObject({ code: "interrupted_by_restart" });
    const transitions = rec.transitions.length;
    h.rebuild({ instanceId: "after-crash-2", pid: process.pid + 10, isPidAlive: () => false });
    await new Promise((r) => setTimeout(r, 40));
    expect((await state(h, op.id)).transitions).toHaveLength(transitions); // idempotent
    expect(h.fake.calls.filter((c) => c.op === "createRelease")).toEqual([]);
    open(); // the orphaned run of A can no longer move the operation (its compare-and-set fails)
    await new Promise((r) => setTimeout(r, 60));
    expect((await state(h, op.id)).state).toBe("NEEDS_OPERATOR_REVIEW");
    expect(h.fake.calls.length).toBeGreaterThanOrEqual(calls.length);
  });

  it("a stale stamp is not trusted: an operation older than the maximum operation age is recovered even if its pid answers (pid reuse)", async () => {
    const { h, op, open } = await runningInA(mk());
    h.clk.advance(46 * 60_000);
    const b = h.rebuild({ instanceId: "late", pid: process.pid + 11, isPidAlive: () => true });
    await b.status(OWNER, h.runId);
    expect((await state(h, op.id)).state).toBe("NEEDS_OPERATOR_REVIEW");
    open();
    await new Promise((r) => setTimeout(r, 60));
  });

  it("a record with NO stamp (written before this change) keeps the previous behaviour: it is recovered", async () => {
    const { h, op, open } = await runningInA(mk());
    const rec = await state(h, op.id);
    expect(await h.store.updateOperation({ ...rec, runner: undefined }, "UPLOADING_SOURCE")).toBe(true);
    const b = h.rebuild({ instanceId: "legacy-check", pid: process.pid + 12, isPidAlive: () => true });
    await b.status(OWNER, h.runId);
    expect((await state(h, op.id)).state).toBe("NEEDS_OPERATOR_REVIEW");
    open();
    await new Promise((r) => setTimeout(r, 60));
  });
});
