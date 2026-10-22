import { describe, expect, it } from "vitest";
import { Secret } from "@/server/security/secret";
import { LiaraWriteClient } from "@/server/live/write-client";
import { CreateReleaseRequestSchema, NON_REPO_GIT_INFO, UploadSourceResponseSchema, VENDOR_ID } from "@/server/live/contract";
import { describeResponse, safeContentType } from "@/server/live/response-shape";
import { CANARY } from "../helpers/canaries";
import { __setLogSinkForTests } from "@/server/security/logger";

const mk = (handler: (url: URL, init: RequestInit) => Response | Promise<Response>) => {
  const calls: { url: URL; init: RequestInit }[] = [];
  const fetchImpl = (async (input: URL, init: RequestInit) => {
    calls.push({ url: new URL(String(input)), init });
    return handler(new URL(String(input)), init);
  }) as unknown as typeof fetch;
  return { client: new LiaraWriteClient({ baseUrl: new URL("https://api.liara.ir"), token: new Secret(CANARY.token), teamId: "team_demo_1", timeoutMs: 5000, uploadTimeoutMs: 8000, fetchImpl }), calls };
};
const json = (body: unknown, init: ResponseInit = {}) => new Response(JSON.stringify(body), { status: 200, headers: { "content-type": "application/json; charset=utf-8" }, ...init });
const upload = (r: Response) => mk(() => r).client.uploadSource("liara-agent-demo", Buffer.from("x"));

describe("Liara's sourceID is an opaque string: the official CLI forwards it unvalidated, so this project must not invent a format", () => {
  it.each([
    ["24-hex object id", "6a87f941cb65108a185493e7"],
    ["uuid", "0b9c1e0e-6f8b-4e0a-9d52-1d7c7a1f2a11"],
    ["file-name like (dot)", "1760000000000.tar.gz"],
    ["path like", "6a87f941cb65108a185493e7/1760000000000.tar.gz"],
    ["with colon / plus / equals", "src:ab+cd=="],
    ["short", "a"],
    ["256 chars", "a".repeat(256)],
  ])("accepts %s", async (_n, id) => {
    expect(VENDOR_ID.test(id)).toBe(true);
    expect(await upload(json({ sourceID: id }))).toEqual({ ok: true, status: 200, data: { sourceID: id } });
    expect(CreateReleaseRequestSchema.safeParse({ sourceID: id, port: 3000, type: "next", platformConfig: {}, build: { cache: true }, gitInfo: NON_REPO_GIT_INFO }).success).toBe(true);
  });
  it.each([["empty", ""], ["space", "a b"], ["newline", "a\nb"], ["double quote", 'a"b'], ["single quote", "a'b"], ["backslash", "a\\b"], ["control", "a\u0001b"], ["non-ascii", "آ"], ["257 chars", "a".repeat(257)]])("still refuses %s", (_n, id) => {
    expect(VENDOR_ID.test(id)).toBe(false);
    expect(UploadSourceResponseSchema.safeParse({ sourceID: id }).success).toBe(false);
  });
  it("a non-string sourceID (number / object / null) is refused", () => {
    for (const v of [123, { a: 1 }, null, ["x"]]) expect(UploadSourceResponseSchema.safeParse({ sourceID: v }).success).toBe(false);
  });
});

describe("an unreadable 2xx keeps its EVIDENCE (status + sanitised shape), never its content", () => {
  it("JSON without a usable sourceID: key names and kinds, the sourceID's type/length/format class — no value", async () => {
    const secret = "SECRET-VALUE with spaces and a token " + CANARY.token;
    const r = await upload(json({ sourceID: secret, note: "do not leak me", n: 5, nested: { a: 1 } }));
    expect(r).toMatchObject({ ok: false, kind: "unknown_outcome", status: 200, code: "malformed_response" });
    const shape = (r as { shape: unknown }).shape;
    expect(shape).toMatchObject({ status: 200, contentType: "application/json", body: "json", lead: "object", expected: { key: "sourceID", present: true, type: "string", length: secret.length, format: "has_space" } });
    expect((shape as { keys: { name: string; type: string }[] }).keys.map((k) => `${k.name}:${k.type}`)).toEqual(["sourceID:string", "[other]:string", "[other]:number", "[other]:object"]);
    const text = JSON.stringify(shape);
    for (const leak of ["SECRET-VALUE", "do not leak", CANARY.token]) expect(text).not.toContain(leak);
  });
  it("sourceID missing / wrong type / different member name are told apart", async () => {
    expect(((await upload(json({}))) as { shape: { expected: unknown } }).shape.expected).toEqual({ key: "sourceID", present: false, type: null, length: null, format: null });
    expect(((await upload(json({ sourceID: 7 }))) as { shape: { expected: { type: string } } }).shape.expected.type).toBe("number");
    const other = (await upload(json({ sourceId: "abc123" }))) as { shape: { expected: { present: boolean }; keys: { name: string }[] } };
    expect(other.shape.expected.present).toBe(false);
    expect(other.shape.keys.map((k) => k.name)).toEqual(["sourceId"]); // the near-miss is visible
  });
  it("empty body, non-JSON (html / text / invalid JSON), oversized and array bodies are classified without keeping any text", async () => {
    const empty = (await upload(new Response("", { status: 200 }))) as { shape: { body: string; bytes: number } };
    expect(empty.shape).toMatchObject({ body: "empty", bytes: 0 });
    const html = (await upload(new Response("<html>SECRET-HTML</html>", { status: 200, headers: { "content-type": "text/html; charset=utf-8" } }))) as { shape: unknown };
    expect(html.shape).toMatchObject({ body: "non_json", lead: "html_like", contentType: "text/html", bytes: 24 });
    expect(JSON.stringify(html.shape)).not.toContain("SECRET-HTML");
    expect(((await upload(new Response("OK", { status: 200 }))) as { shape: { lead: string } }).shape.lead).toBe("text_like");
    expect(((await upload(new Response("{broken", { status: 200 }))) as { shape: { body: string } }).shape.body).toBe("non_json");
    expect(((await upload(new Response("x".repeat(70_000), { status: 200 }))) as { shape: { body: string } }).shape.body).toBe("too_large");
    expect(((await upload(json([{ sourceID: "abc" }]))) as { shape: { lead: string; keys: unknown[] } }).shape).toMatchObject({ lead: "array", keys: [] });
  });
  it("hostile key names and content types are sanitised and bounded", async () => {
    const body: Record<string, unknown> = { ["<script>alert(1)</script>".repeat(5)]: 1 };
    for (let i = 0; i < 30; i++) body["k" + i] = i;
    const shape = ((await upload(json(body, { headers: { "content-type": "application/json; boundary=" + "z".repeat(500) } }))) as { shape: { keys: { name: string }[]; contentType: string } }).shape;
    expect(shape.keys.length).toBe(12);
    expect(shape.keys[0]!.name).toBe("[other]");
    expect(shape.contentType).toMatch(/^[a-z0-9!#$&^_.+-]+\/[a-z0-9!#$&^_.+-]+$|^\?$/);
    expect(safeContentType(null)).toBeNull();
    expect(safeContentType("garbage")).toBe("?");
  });
  it("never retains secrets encoded as syntactically valid key names or media types, including in logs", async () => {
    const secret = "UNRECOGNIZED_PRIVATE_VALUE";
    const logs: string[] = [];
    __setLogSinkForTests((line) => logs.push(line));
    try {
      const r = await upload(json({ [secret]: secret, sourceID: 42 }, { headers: { "content-type": `application/${secret}` } }));
      expect(r).toMatchObject({ ok: false, shape: { contentType: "?", keys: [{ name: "[other]" }, { name: "sourceID" }] } });
      expect(logs.some((line) => line.includes("liara.write_unreadable"))).toBe(true);
      expect(JSON.stringify({ r, logs })).not.toContain(secret);
      expect(safeContentType(`application/json${secret}`)).toBe("?");
      expect(safeContentType(" APPLICATION/JSON ; token=private")).toBe("application/json");
      expect(describeResponse({ status: 200, contentType: `text/${secret}`, bytes: 1, body: "non_json" }, undefined, "sourceID").contentType).toBe("?");
    } finally {
      __setLogSinkForTests(() => undefined);
    }
  });
  it("describeResponse is pure and a 2xx is never treated as a retryable failure (one request only)", async () => {
    const s = describeResponse({ status: 200, contentType: null, bytes: 2, body: "json" }, { releaseID: "r" }, "releaseID");
    expect(s.expected).toMatchObject({ present: true, type: "string", length: 1 });
    const m = mk(() => json({}));
    await m.client.uploadSource("liara-agent-demo", Buffer.from("x"));
    expect(m.calls).toHaveLength(1);
  });
  it("createRelease: an unreadable 2xx also keeps its shape (releaseID)", async () => {
    const body = { sourceID: "x.y", port: 3000, type: "next" as const, platformConfig: {}, build: { cache: true as const }, gitInfo: NON_REPO_GIT_INFO };
    const r = (await mk(() => json({ id: "r1" })).client.createRelease("liara-agent-demo", body)) as { shape: { expected: { key: string; present: boolean } } };
    expect(r.shape.expected).toMatchObject({ key: "releaseID", present: false });
  });
});

describe("the multipart request on the wire (compared with the official CLI's form-data upload)", () => {
  it("POST /v2/projects/<app>/sources?teamID=…, bearer auth, ONE field `file` with the gzip bytes, boundary set by fetch (no hand-made Content-Type)", async () => {
    const archive = Buffer.from([0x1f, 0x8b, 8, 0, 1, 2, 3, 4]);
    const m = mk(() => json({ sourceID: "abc123def" }));
    await m.client.uploadSource("liara-agent-demo", archive);
    const c = m.calls[0]!;
    expect(c.url.pathname).toBe("/v2/projects/liara-agent-demo/sources");
    expect(c.url.searchParams.get("teamID")).toBe("team_demo_1");
    expect(c.init.method).toBe("POST");
    const headers = c.init.headers as Record<string, string>;
    expect(Object.keys(headers).map((k) => k.toLowerCase())).not.toContain("content-type"); // fetch must add `multipart/form-data; boundary=…` itself
    expect(headers.Authorization).toBe(`Bearer ${CANARY.token}`);
    const wire = new Response(c.init.body as FormData); // serialise exactly as fetch does
    expect(wire.headers.get("content-type")).toMatch(/^multipart\/form-data; boundary=/);
    const raw = Buffer.from(await wire.arrayBuffer());
    const text = raw.toString("latin1");
    expect((text.match(/Content-Disposition: form-data/g) ?? []).length).toBe(1);
    expect(text).toContain('name="file"; filename="source.tar.gz"');
    expect(text).toContain("Content-Type: application/gzip");
    expect(raw.includes(archive)).toBe(true);
  });
});
