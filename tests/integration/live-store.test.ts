import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { MemoryLiveStore, SqliteLiveStore, type LiveStore } from "@/server/live/store";
import { harness, OWNER, propose, approved, settle, TEAM } from "../helpers/live-exec";

const dirs: string[] = [];
afterEach(() => {
  for (const d of dirs.splice(0)) rmSync(d, { recursive: true, force: true });
});
const sqlite = () => {
  const d = mkdtempSync(path.join(tmpdir(), "live-store-"));
  dirs.push(d);
  return new SqliteLiveStore(path.join(d, "s.db"));
};
const backends: [string, () => LiveStore][] = [["memory", () => new MemoryLiveStore()], ["sqlite", sqlite]];

describe.each(backends)("live store contract — %s", (_n, make) => {
  it("creates proposal + operation atomically and refuses a second pending/active attempt for the same (team, app)", async () => {
    const store = make();
    const h = await harness({ store });
    const v = await propose(h);
    expect(await store.getOperation(v.operation!.id)).toMatchObject({ state: "AWAITING_LIVE_APPROVAL", proposalId: v.proposal.id });
    const again = await store.createLiveProposal({ ...v.proposal, id: "lprop_20260102040001_aabbccdd", operationId: "lop_20260102040001_aabbccdd" }, { ...v.operation!, id: "lop_20260102040001_aabbccdd", proposalId: "lprop_20260102040001_aabbccdd" });
    expect(again).toEqual({ created: false, reason: "pending_exists" });
  });
  it("transitions are compare-and-set: a stale expectation or an illegal edge changes nothing", async () => {
    const store = make();
    const h = await harness({ store });
    const v = await approved(h);
    const op = (await store.getOperation(v.operation!.id))!;
    expect(op.state).toBe("AWAITING_LIVE_APPROVAL");
    expect(await store.updateOperation({ ...op, state: "DEPLOYED" }, "AWAITING_LIVE_APPROVAL")).toBe(false); // not an edge of LIVE_NEXT
    expect(await store.updateOperation({ ...op, state: "APPROVED" }, "APPROVED")).toBe(false); // stale: it is not in APPROVED
    expect((await store.getOperation(op.id))!.state).toBe("AWAITING_LIVE_APPROVAL");
  });
  it("beginExecution is single-use and refuses an expired or unapproved proposal", async () => {
    const store = make();
    const h = await harness({ store });
    const v = await propose(h);
    const op = (await store.getOperation(v.operation!.id))!;
    const now = new Date(h.clk.now()).toISOString();
    expect(await store.beginExecution({ ...op, state: "APPROVED" }, now)).toMatchObject({ started: false, reason: "proposal_not_approved" });
    await h.svc.decide(v.proposal.id, OWNER, { decision: "approve", digest: v.proposal.digest, confirmAppName: v.proposal.appName, acknowledgeFinancial: true });
    const late = new Date(h.clk.now() + 11 * 60_000).toISOString();
    expect(await store.beginExecution({ ...op, state: "APPROVED" }, late)).toMatchObject({ started: false, reason: "expired" });
    expect(await store.beginExecution({ ...op, state: "APPROVED" }, now)).toEqual({ started: true });
    expect(await store.beginExecution({ ...op, state: "APPROVED" }, now)).toMatchObject({ started: false });
  });
  it("scope bootstrap needs a CONFIRMED creation under a consumed approval, is idempotent and exact", async () => {
    const store = make();
    const h = await harness({ store });
    const v = await approved(h);
    const now = new Date(h.clk.now()).toISOString();
    expect((await store.bootstrapScope(v.operation!.id, now)).ok).toBe(false); // approved but nothing created
    const op = await h.svc.execute(v.proposal.id, OWNER, h.zip);
    await settle(h, op.id);
    expect(store.scopeHas(TEAM, "liara-agent-demo")).toBe(true);
    expect((await store.bootstrapScope(op.id, now)).ok).toBe(true); // idempotent
    expect(store.scopeHas(TEAM, "liara-agent-demo-2")).toBe(false);
    expect(store.scopeHas(null, "liara-agent-demo")).toBe(false);
  });
  it("the audit chain stays intact through a full flow", async () => {
    const store = make();
    const h = await harness({ store });
    const v = await approved(h);
    await settle(h, (await h.svc.execute(v.proposal.id, OWNER, h.zip)).id);
    expect(await store.verifyAudit()).toMatchObject({ ok: true });
  });
});

describe("SQLite specifics", () => {
  it("unique partial indexes exist and a tampered row cannot be loaded (strict schema on read)", async () => {
    const d = mkdtempSync(path.join(tmpdir(), "live-store-"));
    dirs.push(d);
    const file = path.join(d, "t.db");
    const store = new SqliteLiveStore(file);
    const h = await harness({ store });
    const v = await propose(h);
    const { DatabaseSync } = await import("node:sqlite");
    const raw = new DatabaseSync(file);
    const idx = raw.prepare("SELECT name FROM sqlite_master WHERE type='index'").all().map((r) => String((r as { name: string }).name));
    expect(idx).toEqual(expect.arrayContaining(["live_proposals_pending", "live_operations_active"]));
    const rec = JSON.parse(String((raw.prepare("SELECT record_json FROM live_proposals WHERE id=?").get(v.proposal.id) as { record_json: string }).record_json));
    rec.executionMode = "simulation";
    raw.prepare("UPDATE live_proposals SET record_json=? WHERE id=?").run(JSON.stringify(rec), v.proposal.id);
    raw.close();
    await expect(store.getLiveProposal(v.proposal.id)).rejects.toThrow();
  });
  it("state survives a restart: a new store over the same file sees the operation", async () => {
    const d = mkdtempSync(path.join(tmpdir(), "live-store-"));
    dirs.push(d);
    const file = path.join(d, "r.db");
    const h = await harness({ store: new SqliteLiveStore(file) });
    const v = await propose(h);
    const again = new SqliteLiveStore(file);
    expect((await again.getOperation(v.operation!.id))!.state).toBe("AWAITING_LIVE_APPROVAL");
  });
});
