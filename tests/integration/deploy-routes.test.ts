import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { AgentRunManager } from "@/server/agent/manager";
import { __setAgentManagerForTests } from "@/server/agent/runtime";
import { MemoryAgentStore } from "@/server/agent/store";
import { UPLOAD_LIMITS } from "@/server/deploy/limits";
import { MockDiagnosticLLMProvider } from "@/server/diagnostics/llm";
import { buildService } from "@/server/liara/service";
import { __resetApiLimiterForTests } from "@/server/security/guard";
import { __clearSessionsForTests, createSession } from "@/server/security/session";
import { assertNoCanary, CANARY } from "../helpers/canaries";
import { NOW } from "../helpers/evidence-builder";
import { installService, makeConfig, resetAll } from "../helpers/live";
import { baseFiles, nextZip, withPkg, zipOf, type Files } from "../helpers/projects";
import { buildZip } from "../helpers/zip";

import * as uploads from "@/app/api/agent/deploy/uploads/route";
import * as checklist from "@/app/api/agent/deploy/runs/[id]/checklist/route";
import * as plan from "@/app/api/agent/deploy/runs/[id]/plan/route";
import * as decision from "@/app/api/agent/proposals/[id]/decision/route";
import * as conversation from "@/app/api/agent/conversations/[id]/route";

const ORIGIN = "http://localhost:3000";
beforeEach(() => {
  __clearSessionsForTests();
  __resetApiLimiterForTests();
});
afterEach(() => {
  __setAgentManagerForTests(undefined);
  resetAll();
});

function setup(uploadPerWindow = 50) {
  const cfg = makeConfig();
  const svc = buildService(cfg, { now: () => NOW });
  installService(cfg, svc);
  const store = new MemoryAgentStore();
  const m = new AgentRunManager({ svc, store, provider: new MockDiagnosticLLMProvider("ok"), now: () => NOW, runTimeoutMs: 8000, quotaPerWindow: 99, uploadQuota: { perWindow: uploadPerWindow, windowMs: 600_000 } });
  __setAgentManagerForTests(m);
  const user = () => {
    const s = createSession();
    const cookie = `liara_agent_session=${s.id}`;
    const h = (extra: Record<string, string> = {}) => ({ cookie, origin: ORIGIN, ...extra });
    const upload = (input: BodyInit | Buffer | null, headers: Record<string, string> = {}) => {
      const body = Buffer.isBuffer(input) ? new Uint8Array(input) : input;
      return uploads.POST(new Request(`${ORIGIN}/api/agent/deploy/uploads`, { method: "POST", headers: h({ "content-type": "application/zip", ...headers }), body, ...(body && typeof body === "object" && "getReader" in body ? { duplex: "half" } : {}) } as RequestInit));
    };
    const json = (route: { POST: (r: Request, c: { params: Promise<{ id: string }> }) => Promise<Response> }, url: string, id: string, body: unknown, headers: Record<string, string> = {}) =>
      route.POST(new Request(`${ORIGIN}${url}`, { method: "POST", headers: h({ "content-type": "application/json", ...headers }), body: typeof body === "string" ? body : JSON.stringify(body) }), { params: Promise.resolve({ id }) });
    return {
      cookie,
      upload,
      checklist: (id: string, body: unknown, hd?: Record<string, string>) => json(checklist, `/api/agent/deploy/runs/${id}/checklist`, id, body, hd),
      plan: (id: string, body: unknown, hd?: Record<string, string>) => json(plan, `/api/agent/deploy/runs/${id}/plan`, id, body, hd),
      decide: (id: string, body: unknown) => json(decision as never, `/api/agent/proposals/${id}/decision`, id, body),
      conv: (id: string) => conversation.GET(new Request(`${ORIGIN}/api/agent/conversations/${id}`, { headers: { cookie } }), { params: Promise.resolve({ id }) }),
    };
  };
  return { m, store, user };
}
const body = async (r: Response) => JSON.parse(await r.text());
const buf = (over: Files = {}) => zipOf({ ...baseFiles(), ...over });

describe("upload route — authentication, CSRF, content type, size", () => {
  it("rejects unauthenticated, cross-origin and wrongly typed requests before reading anything", async () => {
    const { user } = setup();
    const un = await uploads.POST(new Request(`${ORIGIN}/api/agent/deploy/uploads`, { method: "POST", headers: { origin: ORIGIN, "content-type": "application/zip" }, body: new Uint8Array(nextZip()) }));
    expect(un.status).toBe(401);
    const u = user();
    expect((await u.upload(nextZip(), { origin: "https://evil.example" })).status).toBe(403);
    for (const type of ["application/json", "text/plain", "multipart/form-data", "image/png", ""]) {
      const r = await u.upload(nextZip(), { "content-type": type });
      expect(r.status, type).toBe(422);
      expect((await body(r)).error.reason).toBe("bad_content_type");
    }
  });
  it("a cross-site form post (no Origin, not same-origin) is refused", async () => {
    const { user } = setup();
    const u = user();
    const r = await uploads.POST(new Request(`${ORIGIN}/api/agent/deploy/uploads`, { method: "POST", headers: { cookie: u.cookie, "content-type": "application/zip", "sec-fetch-site": "cross-site" }, body: new Uint8Array(nextZip()) }));
    expect(r.status).toBe(403);
  });
  it("empty body, over-large declared length and over-large STREAMED body (no content-length) are refused", async () => {
    const { user, store } = setup();
    const u = user();
    expect((await body(await u.upload(new Uint8Array(0)))).error.reason).toBe("empty");
    const declared = await u.upload(nextZip(), { "content-length": String(UPLOAD_LIMITS.maxArchiveBytes + 1) });
    expect(declared.status).toBe(422);
    expect((await body(declared)).error.reason).toBe("too_large");
    let pulled = 0;
    const stream = new ReadableStream<Uint8Array>({
      pull(c) {
        if (pulled++ >= 40) return c.close();
        c.enqueue(new Uint8Array(1024 * 1024));
      },
    });
    const streamed = await u.upload(stream);
    expect(streamed.status).toBe(422);
    expect((await body(streamed)).error.reason).toBe("too_large");
    expect(pulled).toBeLessThan(40); // reading stopped as soon as the cap was exceeded
    expect(await store.countRunningAgentRuns()).toBe(0);
  });
});

describe("upload route — happy path and hostile archives", () => {
  it("analyses a valid project and returns a sanitised readiness report (no secrets, no raw bytes)", async () => {
    const { user } = setup();
    const u = user();
    const r = await u.upload(buf({ ".env": `X=${CANARY.envValue}`, ".env.example": "API_KEY=\n" }), { "x-upload-filename": "my site.zip" });
    expect(r.status).toBe(200);
    const j = await body(r);
    expect(j).toMatchObject({ conversationId: expect.stringMatching(/^conv_/), runId: expect.stringMatching(/^arun_/) });
    assertNoCanary(JSON.stringify(j));
    const v = await body(await u.conv(j.conversationId));
    expect(v.activeRun.deployment.readiness.verdict).toBe("NEEDS_CONFIGURATION");
    expect(v.activeRun.deployment.project.filename).toBe("my site.zip");
    expect(JSON.stringify(v)).not.toMatch(/UEsDB/);
  });
  it("a malformed or unsafe X-Upload-Filename is dropped; a malformed X-Conversation-Id is ignored", async () => {
    const { user } = setup();
    const u = user();
    const j = await body(await u.upload(nextZip(), { "x-upload-filename": "../../etc/passwd", "x-conversation-id": "../../x" }));
    expect(j.conversationId).toMatch(/^conv_\d{14}_[0-9a-f]{8}$/);
    const v = await body(await u.conv(j.conversationId));
    expect(v.activeRun.deployment.project.filename).toBeNull();
  });
  const hostile: [string, Buffer, string][] = [
    ["path traversal", buildZip([{ name: "../../x", data: "x" }]), "unsafe_path"],
    ["symlink", buildZip([{ name: "l", data: "/etc/passwd", mode: 0o120777 }]), "symlink_or_special"],
    ["bomb", buildZip([{ name: "z", data: Buffer.alloc(7 * 1024 * 1024) }]), "ratio_exceeded"],
    ["garbage", Buffer.from("definitely not a zip file, just some text bytes"), "not_a_zip"],
  ];
  for (const [label, data, reason] of hostile) {
    it(`${label}: 422 with a machine reason and a Persian message; nothing stored`, async () => {
      const { user, store } = setup();
      const u = user();
      const r = await u.upload(data);
      expect(r.status).toBe(422);
      const j = await body(r);
      expect(j.error).toMatchObject({ code: "upload_rejected", reason });
      expect(j.error.message).toMatch(/[؀-ۿ]/);
      expect(JSON.stringify(j)).not.toMatch(/at \w+ \(|node_modules|\.ts:\d+/);
      expect((await store.readAudit(20)).some((x) => x.event === "agent.conversation_created")).toBe(false);
    });
  }
  it("upload quota → 429 per session only", async () => {
    const { user } = setup(2);
    const a = user();
    const b = user();
    expect((await a.upload(nextZip())).status).toBe(200);
    expect((await a.upload(nextZip())).status).toBe(200);
    const third = await a.upload(nextZip());
    expect(third.status).toBe(429);
    expect((await body(third)).error.code).toBe("upload_quota_exceeded");
    expect((await b.upload(nextZip())).status).toBe(200);
  });
  it("a second session cannot upload into, or read, someone else's conversation", async () => {
    const { user } = setup();
    const a = user();
    const b = user();
    const j = await body(await a.upload(nextZip()));
    expect((await b.upload(nextZip(), { "x-conversation-id": j.conversationId })).status).toBe(404);
    expect((await b.conv(j.conversationId)).status).toBe(404);
  });
});

describe("checklist and plan routes", () => {
  it("require auth + same-origin JSON, strict bodies and valid ids", async () => {
    const { user } = setup();
    const u = user();
    const id = "arun_20260102040000_aabbccdd";
    const unauth = await checklist.POST(new Request(`${ORIGIN}/api/agent/deploy/runs/${id}/checklist`, { method: "POST", headers: { origin: ORIGIN, "content-type": "application/json" }, body: "{}" }), { params: Promise.resolve({ id }) });
    expect(unauth.status).toBe(401);
    expect((await u.checklist(id, { item: "env_values", done: true }, { origin: "https://evil.example" })).status).toBe(403);
    for (const b of [{}, { item: "env_values" }, { item: "env_values", done: "yes" }, { item: "nope", done: true }, { item: "env_values", done: true, extra: 1 }, "not json"]) expect((await u.checklist(id, b)).status, JSON.stringify(b)).toBe(400);
    expect((await u.checklist("../x", { item: "env_values", done: true })).status).toBe(404);
    for (const b of [{ scenario: "launch" }, { traffic: "huge" }, { appName: "x" }, { appName: "a".repeat(50) }, { approved: true }, { appName: 5 }]) expect((await u.plan(id, b)).status, JSON.stringify(b)).toBe(400);
    expect((await u.plan("../x", {})).status).toBe(404);
    expect((await u.plan(id, {})).status).toBe(404); // unknown run
  });
  it("full HTTP journey: upload → checklist → plan → approve (typed name + digest) → simulated result; replay and cross-session refused", async () => {
    const { user, m } = setup();
    const u = user();
    const other = user();
    const up = await body(await u.upload(buf({ ".env.example": "API_KEY=\n" })));
    // plan refused until the operator confirms
    const refused = await u.plan(up.runId, {});
    expect(refused.status).toBe(409);
    expect((await body(refused)).error).toMatchObject({ code: "plan_refused", reason: "needs_configuration" });
    expect((await other.checklist(up.runId, { item: "env_values", done: true })).status).toBe(404);
    const ck = await u.checklist(up.runId, { item: "env_values", done: true });
    expect(ck.status).toBe(200);
    expect((await body(ck)).readiness.verdict).toBe("READY_WITH_WARNINGS");
    expect((await other.plan(up.runId, {})).status).toBe(404);
    const pl = await u.plan(up.runId, { appName: "web-shop", traffic: "medium", scenario: "success" });
    expect(pl.status).toBe(200);
    const view = await body(pl);
    expect(view.proposal).toMatchObject({ operation: "first_deploy", risk: "R2", app: "web-shop", status: "PENDING" });
    expect(view.proposal.digest).toMatch(/^[0-9a-f]{64}$/); // survives response redaction
    expect(view.proposal.params.artifactDigest).toMatch(/^[0-9a-f]{32}$/);
    expect((await other.decide(view.proposal.id, { decision: "approve", digest: view.proposal.digest, confirmAppName: "web-shop" })).status).toBe(404);
    const noName = await u.decide(view.proposal.id, { decision: "approve", digest: view.proposal.digest });
    expect(noName.status).toBe(400);
    expect((await body(noName)).error.code).toBe("confirmation_required");
    const ok = await u.decide(view.proposal.id, { decision: "approve", digest: view.proposal.digest, confirmAppName: "web-shop" });
    expect(ok.status).toBe(200);
    const done = await body(ok);
    expect(done.proposal.status).toBe("SIMULATED_OK");
    expect(done.result.simulated).toBe(true);
    expect(done.result.deployment.reached).toBe("completed");
    expect(JSON.stringify(done)).not.toMatch(/https?:\/\//);
    const replay = await u.decide(view.proposal.id, { decision: "approve", digest: view.proposal.digest, confirmAppName: "web-shop" });
    expect(replay.status).toBe(409);
    expect((await body(replay)).error.code).toBe("already_decided");
    await expect(m.requestLiveExecution(view.proposal.id, createSession().id)).rejects.toMatchObject({ code: "not_found" });
  });
  it("a plan for an existing app name is a 409 with a clear message", async () => {
    const { user } = setup();
    const u = user();
    const up = await body(await u.upload(nextZip()));
    const r = await u.plan(up.runId, { appName: "demo-shop" });
    expect(r.status).toBe(409);
    expect((await body(r)).error.code).toBe("app_name_taken");
  });
  it("blocked projects cannot be planned over HTTP either", async () => {
    const { user } = setup();
    const u = user();
    const up = await body(await u.upload(buf(withPkg((p) => delete (p.scripts as Record<string, string>).start))));
    const r = await u.plan(up.runId, {});
    expect(r.status).toBe(409);
    expect((await body(r)).error.reason).toBe("blocked");
  });
});
