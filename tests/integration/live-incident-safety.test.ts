import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";
import { isLiveError } from "@/server/live/types";
import type { LiveWriteTransport } from "@/server/live/contract";
import { CreateReleaseRequestSchema, NON_REPO_GIT_INFO, UploadSourceResponseSchema, VENDOR_ID } from "@/server/live/contract";
import { FakeLiara, harness, OTHER, OWNER, settle } from "../helpers/live-exec";
import type { LiveStore } from "@/server/live/store";

const APP = "liara-agent-demo";
const code = async (p: Promise<unknown>) => {
  try {
    await p;
    return null;
  } catch (e) {
    return isLiveError(e) ? e.code : "other";
  }
};

/** reproduces the incident: existing app, REST backend, Liara answers 2xx but the sourceID cannot be read */
async function incident(store?: LiveStore) {
  const h = await harness({ store });
  h.fake.apps.add(APP);
  h.fake.releaseIds.push("rel_old_1");
  h.fake.upload = "malformed";
  const v = await h.svc.createExistingProposal(OWNER, { runId: h.runId, appName: APP, backend: "api", zip: h.zip });
  await h.svc.decide(v.proposal.id, OWNER, { decision: "approve", digest: v.proposal.digest, confirmAppName: APP });
  const op = await h.svc.execute(v.proposal.id, OWNER, h.zip);
  const final = await settle(h, op.id);
  expect(final.state).toBe("NEEDS_OPERATOR_REVIEW");
  return { h, v, final };
}
/** a transport that FAILS THE TEST on any use: proves a code path sends no write */
function forbiddenTransport(hits: string[]): LiveWriteTransport {
  const boom = (name: string) => async () => {
    hits.push(name);
    throw new Error("a write was attempted: " + name);
  };
  return { createApp: boom("createApp"), uploadSource: boom("uploadSource"), createRelease: boom("createRelease") } as unknown as LiveWriteTransport;
}

describe("abandoning the incident operation is local bookkeeping: no Liara write of any kind", () => {
  it("reverify (read-only) and abandon never touch the write transport; the app, its release and the stored source are left alone", async () => {
    const { h, final } = await incident();
    const before = [...h.fake.calls];
    const hits: string[] = [];
    const svc = h.rebuild({ transport: forbiddenTransport(hits) }); // same store, a transport that explodes if used
    const re = await svc.resolve(final.id, OWNER, "reverify");
    expect(re.state).toBe("NEEDS_OPERATOR_REVIEW");
    const ab = await svc.resolve(final.id, OWNER, "abandon");
    expect(ab).toMatchObject({ state: "FAILED", failure: { code: "abandoned_by_operator" } });
    expect(hits).toEqual([]);
    expect(h.fake.calls).toEqual(before);
    expect(h.fake.releaseIds).toEqual(["rel_old_1"]);
    expect(h.fake.apps.has(APP)).toBe(true);
    // the only effects are local: an audit row, the operation row, and the (team, app) slot being released
    const events = (await h.store.readAudit(500)).map((r) => r.event);
    expect(events).toContain("live.operation_abandoned");
    expect(events.filter((e) => e === "live.operation_abandoned")).toHaveLength(1);
    expect((await h.store.getOperation(final.id))?.state).toBe("FAILED");
  });
  it("only the owner can abandon; a stranger gets not-found and nothing changes", async () => {
    const { h, final } = await incident();
    expect(await code(h.svc.resolve(final.id, OTHER, "abandon"))).toBe("live_not_found");
    expect((await h.store.getOperation(final.id))?.state).toBe("NEEDS_OPERATOR_REVIEW");
  });
  it("an unknown action is refused and changes nothing", async () => {
    const { h, final } = await incident();
    expect(await code(h.svc.resolve(final.id, OWNER, "delete" as never))).toBe("live_binding_mismatch");
    expect((await h.store.getOperation(final.id))?.state).toBe("NEEDS_OPERATOR_REVIEW");
  });
});

describe("the previous operation can never be replayed", () => {
  it("its proposal is CONSUMED: execute again, approve again and reject again are all refused, before and after abandoning", async () => {
    const { h, v, final } = await incident();
    const calls = [...h.fake.calls];
    expect((await h.store.getLiveProposal(v.proposal.id))?.status).toBe("CONSUMED");
    for (const phase of ["before", "after"]) {
      expect(await code(h.svc.execute(v.proposal.id, OWNER, h.zip)), phase).toBe("live_not_approved");
      expect(await code(h.svc.decide(v.proposal.id, OWNER, { decision: "approve", digest: v.proposal.digest, confirmAppName: APP })), phase).toBe("live_already_decided");
      expect(await code(h.svc.decide(v.proposal.id, OWNER, { decision: "reject", digest: v.proposal.digest })), phase).toBe("live_already_decided");
      if (phase === "before") await h.svc.resolve(final.id, OWNER, "abandon");
    }
    expect(h.fake.calls).toEqual(calls); // not a single extra request
  });
  it("an abandoned (terminal) operation cannot be resolved again, and a stale digest cannot approve a NEW proposal", async () => {
    const { h, v, final } = await incident();
    // while the old operation is still under review it holds the (team, app) slot: no new proposal at all
    expect(await code(h.svc.createExistingProposal(OWNER, { runId: h.runId, appName: APP, backend: "api", zip: h.zip }))).toBe("live_operation_in_progress");
    await h.svc.resolve(final.id, OWNER, "abandon");
    expect(await code(h.svc.resolve(final.id, OWNER, "abandon"))).toBe("live_invalid_state");
    expect(await code(h.svc.resolve(final.id, OWNER, "reverify"))).toBe("live_invalid_state");
    // a fresh start is possible only as a brand-new proposal/operation/digest that needs its own approval
    h.fake.upload = "ok";
    const fresh = await h.svc.createExistingProposal(OWNER, { runId: h.runId, appName: APP, backend: "api", zip: h.zip });
    expect(fresh.proposal.id).not.toBe(v.proposal.id);
    expect(fresh.operation?.id).not.toBe(final.id);
    expect(fresh.proposal.digest).not.toBe(v.proposal.digest);
    expect(fresh.proposal.status).toBe("PENDING");
    expect(await code(h.svc.execute(fresh.proposal.id, OWNER, h.zip))).toBe("live_not_approved"); // pending ≠ approved
    expect(await code(h.svc.decide(fresh.proposal.id, OWNER, { decision: "approve", digest: v.proposal.digest, confirmAppName: APP }))).toBe("live_digest_mismatch"); // the old digest is worthless
    expect((await h.store.getLiveProposal(fresh.proposal.id))?.status).toBe("PENDING");
    expect(h.fake.calls.map((c) => c.op)).toEqual(["uploadSource"]); // only the original, single upload ever happened
  });
  it("a server restart (startup recovery) never resumes or re-sends a reviewed operation", async () => {
    const { h, final } = await incident();
    const calls = [...h.fake.calls];
    const hits: string[] = [];
    const restarted = h.rebuild({ transport: forbiddenTransport(hits) });
    const st = await restarted.status(OWNER, h.runId);
    expect(st.proposals.at(-1)?.operation?.state).toBe("NEEDS_OPERATOR_REVIEW");
    expect(hits).toEqual([]);
    expect(h.fake.calls).toEqual(calls);
    expect((await h.store.getOperation(final.id))?.state).toBe("NEEDS_OPERATOR_REVIEW");
  });
});

describe("opaque sourceIDs follow the pinned contract within an explicit local safety policy", () => {
  const yaml = readFileSync("docs/reference/openapi/paas.yaml", "utf8");
  it("the pinned OpenAPI says `sourceID: type: string` with NO pattern/format/enum/length; the local bound is not a vendor requirement", () => {
    const block = yaml.slice(yaml.indexOf("'/v2/projects/{name}/sources'"), yaml.indexOf("'/v2/projects/{name}/releases'"));
    const m = /sourceID:\s*\n\s*type: string\s*\n/.exec(block);
    expect(m, "sourceID declared as a plain string").not.toBeNull();
    const after = block.slice(m!.index, m!.index + 200).split("\n").slice(0, 4).join("\n");
    expect(after).not.toMatch(/pattern|format|enum|maxLength|minLength/);
    const rel = yaml.slice(yaml.indexOf("Deploy-releases:"), yaml.indexOf("Update-envs:"));
    expect(/sourceID:\s*\n\s*type: string/.test(rel)).toBe(true);
    expect(rel.slice(0, 400)).not.toMatch(/pattern|enum|maxLength/);
  });
  it("property: every accepted value satisfies the local ASCII policy and round-trips unchanged through the actual JSON release sink (other sinks still need escaping)", () => {
    let seed = 1234567;
    const rnd = () => (seed = (seed * 1664525 + 1013904223) >>> 0) / 2 ** 32;
    const pool = Array.from({ length: 140 }, (_, i) => String.fromCharCode(i)).concat(["آ", "é", "\u2028", "\u200e", "😀"]);
    let accepted = 0;
    for (let n = 0; n < 30_000; n++) {
      const len = 1 + Math.floor(rnd() * 12);
      const s = Array.from({ length: len }, () => pool[Math.floor(rnd() * pool.length)]).join("");
      if (!VENDOR_ID.test(s)) continue;
      accepted++;
      expect(/^[\x21-\x7e]+$/.test(s) && !/["'\\]/.test(s), JSON.stringify(s)).toBe(true);
      expect(JSON.stringify(s)).toBe(`"${s}"`); // nothing needs escaping
      const body = CreateReleaseRequestSchema.parse({ sourceID: s, port: 3000, type: "next", platformConfig: {}, build: { cache: true }, gitInfo: NON_REPO_GIT_INFO });
      expect(JSON.parse(JSON.stringify(body)).sourceID).toBe(s);
      expect(UploadSourceResponseSchema.parse({ sourceID: s }).sourceID).toBe(s);
    }
    expect(accepted).toBeGreaterThan(1000);
  });
  it("hostile ids are refused: header/CRLF injection, markup, path traversal separators with whitespace, NUL, unicode controls, oversize", () => {
    for (const bad of ["a\r\nX-Evil: 1", "a b", "<img src=x onerror=1>".replace(/ /g, "\t"), "a\u0000b", "a\u2028b", "a\u200eb", "a".repeat(257), "", " ", "'; DROP TABLE x;--".replace(/ /g, "")+"'" ]) expect(VENDOR_ID.test(bad), JSON.stringify(bad)).toBe(false);
    // …while exotic-but-printable ids (what a vendor could plausibly return) are fine
    for (const good of ["../x", "a.b/c:d", "<b>", "a;b"]) expect(VENDOR_ID.test(good), good).toBe(true);
  });
  it("FakeLiara-style end to end: an id with dots/slashes flows upload → release body unchanged", async () => {
    const h = await harness();
    const id = "6a87/abc.def:1";
    h.fake.apps.add(APP);
    h.fake.releaseIds.push("rel_old_1");
    const orig = h.fake.transport.uploadSource;
    h.fake.transport.uploadSource = async (a: string, b: Buffer) => {
      await orig(a, b);
      return { ok: true, status: 200, data: { sourceID: id } };
    };
    const v = await h.svc.createExistingProposal(OWNER, { runId: h.runId, appName: APP, backend: "api", zip: h.zip });
    await h.svc.decide(v.proposal.id, OWNER, { decision: "approve", digest: v.proposal.digest, confirmAppName: APP });
    const fin = await settle(h, (await h.svc.execute(v.proposal.id, OWNER, h.zip)).id);
    expect(fin.failure, JSON.stringify(fin)).toBeNull();
    const rel = h.fake.calls.find((c) => c.op === "createRelease");
    expect((rel?.body as { sourceID: string }).sourceID).toBe(id);
  });
});

describe("incident recovery survives SQLite persistence", () => {
  it("the HTTP client diagnostics reach SQLite audit without response values, unknown key names or arbitrary media types", async () => {
    const { mkdtempSync, rmSync } = await import("node:fs");
    const { tmpdir } = await import("node:os");
    const path = await import("node:path");
    const { SqliteLiveStore } = await import("@/server/live/store");
    const { LiaraWriteClient } = await import("@/server/live/write-client");
    const { Secret } = await import("@/server/security/secret");
    const dir = mkdtempSync(path.join(tmpdir(), "live-incident-diagnostics-"));
    try {
      const store = new SqliteLiveStore(path.join(dir, "audit.sqlite"));
      const h = await harness({ store });
      const secret = "PRIVATE_UPSTREAM_DIAGNOSTIC_CANARY";
      let attempts = 0;
      const client = new LiaraWriteClient({
        baseUrl: new URL("https://api.liara.ir"), token: new Secret("offline-fake-token"), teamId: null, timeoutMs: 1000, uploadTimeoutMs: 1000,
        fetchImpl: (async () => {
          attempts++;
          return new Response(JSON.stringify({ sourceID: 42, message: secret, [secret]: secret }), { status: 201, headers: { "content-type": `application/${secret}` } });
        }) as typeof fetch,
      });
      h.fake.apps.add(APP);
      h.fake.transport.uploadSource = (app, bytes) => client.uploadSource(app, bytes);
      const v = await h.svc.createExistingProposal(OWNER, { runId: h.runId, appName: APP, backend: "api", zip: h.zip });
      await h.svc.decide(v.proposal.id, OWNER, { decision: "approve", digest: v.proposal.digest, confirmAppName: APP });
      const final = await settle(h, (await h.svc.execute(v.proposal.id, OWNER, h.zip)).id);
      expect(final.state).toBe("NEEDS_OPERATOR_REVIEW");
      expect(attempts).toBe(1);
      expect(h.fake.calls).toEqual([]); // neither createApp nor createRelease
      const audit = await store.readAudit(500);
      const row = audit.find((r) => r.event === "live.operation_needs_review");
      expect(JSON.parse(row!.data)).toMatchObject({ httpStatus: 201, shape: { status: 201, contentType: "?", body: "json", expected: { key: "sourceID", present: true, type: "number" } } });
      expect(JSON.stringify({ final, audit })).not.toContain(secret);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it("concurrent abandon changes one local row once; a reopened store still rejects replay without touching the write transport", async () => {
    const { mkdtempSync, rmSync } = await import("node:fs");
    const { tmpdir } = await import("node:os");
    const path = await import("node:path");
    const { SqliteLiveStore } = await import("@/server/live/store");
    const dir = mkdtempSync(path.join(tmpdir(), "live-incident-recovery-"));
    try {
      const db = path.join(dir, "incident.sqlite");
      const { h, v, final } = await incident(new SqliteLiveStore(db));
      const calls = [...h.fake.calls];
      const hits: string[] = [];
      const svc = h.rebuild({ transport: forbiddenTransport(hits) });
      const outcomes = await Promise.allSettled([svc.resolve(final.id, OWNER, "abandon"), svc.resolve(final.id, OWNER, "abandon")]);
      expect(outcomes.filter((r) => r.status === "fulfilled")).toHaveLength(1);
      expect(outcomes.filter((r) => r.status === "rejected")).toHaveLength(1);
      const store = new SqliteLiveStore(db);
      const restarted = h.rebuild({ store, transport: forbiddenTransport(hits) });
      expect((await store.getOperation(final.id))?.failure?.code).toBe("abandoned_by_operator");
      expect((await store.getLiveProposal(v.proposal.id))?.status).toBe("CONSUMED");
      expect(await code(restarted.execute(v.proposal.id, OWNER, h.zip))).toBe("live_not_approved");
      expect(await code(restarted.decide(v.proposal.id, OWNER, { decision: "approve", digest: v.proposal.digest, confirmAppName: APP }))).toBe("live_already_decided");
      expect(await code(restarted.resolve(final.id, OWNER, "abandon"))).toBe("live_invalid_state");
      expect((await store.readAudit(500)).filter((r) => r.event === "live.operation_abandoned")).toHaveLength(1);
      expect(hits).toEqual([]);
      expect(h.fake.calls).toEqual(calls);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });
});

describe("vendor-style ids survive PERSISTENCE (the SQLite record schema used to be stricter than the client)", () => {
  it("a sourceID / releaseID with dots, slashes and colons is stored, re-read from disk and the operation reaches DEPLOYED", async () => {
    const { mkdtempSync, rmSync } = await import("node:fs");
    const { tmpdir } = await import("node:os");
    const path = await import("node:path");
    const { SqliteLiveStore } = await import("@/server/live/store");
    const dir = mkdtempSync(path.join(tmpdir(), "live-vendor-id-"));
    try {
      const db = path.join(dir, "a.db");
      const h = await harness({ store: new SqliteLiveStore(db) });
      h.fake.apps.add(APP);
      h.fake.releaseIds.push("rel_old_1");
      const SRC = "6a87f9/1760000000000.tar.gz";
      const REL = "r.2026:10/22";
      h.fake.transport.uploadSource = async (a: string, b: Buffer) => {
        h.fake.calls.push({ op: "uploadSource", app: a, bytes: b.length });
        return { ok: true, status: 200, data: { sourceID: SRC } };
      };
      h.fake.transport.createRelease = async (a: string, body: unknown) => {
        h.fake.calls.push({ op: "createRelease", app: a, body });
        h.fake.releaseIds.push(REL);
        return { ok: true, status: 200, data: { releaseID: REL } };
      };
      const v = await h.svc.createExistingProposal(OWNER, { runId: h.runId, appName: APP, backend: "api", zip: h.zip });
      await h.svc.decide(v.proposal.id, OWNER, { decision: "approve", digest: v.proposal.digest, confirmAppName: APP });
      const final = await settle(h, (await h.svc.execute(v.proposal.id, OWNER, h.zip)).id);
      expect(final.failure).toBeNull();
      expect(final.state).toBe("DEPLOYED");
      expect(final.remote).toMatchObject({ sourceId: SRC, releaseId: REL });
      const again = await new SqliteLiveStore(db).getOperation(final.id); // a fresh connection parses the row with the strict schema
      expect(again?.remote).toMatchObject({ sourceId: SRC, releaseId: REL });
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });
});
void FakeLiara;
