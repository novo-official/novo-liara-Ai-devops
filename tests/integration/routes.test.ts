import { afterEach, beforeAll, beforeEach, describe, expect, it } from "vitest";
import { __setConfigForTests } from "@/server/config/env";
import { hashPassword } from "@/server/security/password";
import { __clearSessionsForTests, createSession, destroySession } from "@/server/security/session";
import { __resetApiLimiterForTests, clientKey } from "@/server/security/guard";
import { __resetLoginLimitersForTests } from "@/server/security/login";
import { buildService } from "@/server/liara/service";
import { assertNoCanary, CANARY } from "../helpers/canaries";
import { defaultResponder, installService, liveService, makeConfig, resetAll, TEST_PASSWORD, type Responder } from "../helpers/live";

import * as appsRoute from "@/app/api/apps/route";
import * as appRoute from "@/app/api/apps/[name]/route";
import * as appletsRoute from "@/app/api/apps/[name]/applets/route";
import * as releasesRoute from "@/app/api/apps/[name]/releases/route";
import * as eventsRoute from "@/app/api/apps/[name]/events/route";
import * as logsRoute from "@/app/api/apps/[name]/logs/route";
import * as metricsRoute from "@/app/api/apps/[name]/metrics/route";
import * as diagRoute from "@/app/api/diagnostics/route";
import * as loginRoute from "@/app/api/auth/login/route";
import * as logoutRoute from "@/app/api/auth/logout/route";
import * as healthRoute from "@/app/api/health/route";

const ORIGIN = "http://localhost:3000";
let HASH = "";

beforeAll(async () => {
  HASH = await hashPassword(TEST_PASSWORD, { N: 4096, r: 8, p: 1 });
});

beforeEach(() => {
  __clearSessionsForTests();
  __resetApiLimiterForTests();
  __resetLoginLimitersForTests();
});
afterEach(resetAll);

const ctx = (name: string) => ({ params: Promise.resolve({ name }) });

type DataRoute = { path: string; GET: (req: Request, c: { params: Promise<{ name: string }> }) => Promise<Response>; needsName: boolean };
const DATA_ROUTES: DataRoute[] = [
  { path: "/api/apps", GET: appsRoute.GET as never, needsName: false },
  { path: "/api/apps/shop-api", GET: appRoute.GET, needsName: true },
  { path: "/api/apps/shop-api/applets", GET: appletsRoute.GET, needsName: true },
  { path: "/api/apps/shop-api/releases", GET: releasesRoute.GET, needsName: true },
  { path: "/api/apps/shop-api/events?window=60", GET: eventsRoute.GET, needsName: true },
  { path: "/api/apps/shop-api/logs?window=60", GET: logsRoute.GET, needsName: true },
  { path: "/api/apps/shop-api/metrics?kind=cpu&window=60", GET: metricsRoute.GET, needsName: true },
  { path: "/api/diagnostics", GET: diagRoute.GET as never, needsName: false },
];

function authed(cfgEnv: Record<string, string | undefined> = {}, responder?: Responder) {
  const l = liveService({ APP_ACCESS_PASSWORD_HASH: HASH, ...cfgEnv }, responder ?? defaultResponder());
  installService(l.cfg, l.svc);
  const session = createSession();
  const cookie = `liara_agent_session=${session.id}`;
  const get = (path: string, h: Record<string, string> = {}) => {
    const route = DATA_ROUTES.find((r) => r.path.split("?")[0] === path.split("?")[0]);
    const name = /\/api\/apps\/([^/?]+)/.exec(path)?.[1] ?? "";
    return (route ?? DATA_ROUTES[0]!).GET(new Request(`${ORIGIN}${path}`, { headers: { cookie, ...h } }), ctx(decodeURIComponent(name)));
  };
  return { ...l, session, cookie, get };
}

const loginReq = (body: unknown, headers: Record<string, string> = {}) =>
  new Request(`${ORIGIN}/api/auth/login`, {
    method: "POST",
    headers: { "content-type": "application/json", origin: ORIGIN, host: "localhost:3000", ...headers },
    body: typeof body === "string" ? body : JSON.stringify(body),
  });

describe("authentication & authorization of data routes", () => {
  it.each(DATA_ROUTES.map((r) => [r.path, r] as const))("%s rejects unauthenticated requests and makes no upstream call", async (_p, r) => {
    const l = liveService({ APP_ACCESS_PASSWORD_HASH: HASH });
    installService(l.cfg, l.svc);
    const res = await r.GET(new Request(`${ORIGIN}${r.path}`), ctx("shop-api"));
    expect(res.status).toBe(401);
    expect(l.calls).toHaveLength(0);
    const body = await res.text();
    expect(body).toContain("unauthenticated");
    expect(body).not.toMatch(/shop-api|projects/);
  });

  it("rejects forged, malformed, expired and revoked session cookies", async () => {
    const a = authed();
    const bad = ["liara_agent_session=forged", `liara_agent_session=${"A".repeat(43)}`, "liara_agent_session=", "other=1", `x_liara_agent_session=${a.session.id}`];
    for (const cookie of bad) {
      const res = await appsRoute.GET(new Request(`${ORIGIN}/api/apps`, { headers: { cookie } }));
      expect(res.status).toBe(401);
    }
    destroySession(a.session.id);
    expect((await a.get("/api/apps")).status).toBe(401);
    expect(a.calls).toHaveLength(0);
  });

  it("serves authenticated requests, with no-store caching and no secrets", async () => {
    const a = authed();
    for (const r of DATA_ROUTES) {
      const res = await a.get(r.path);
      expect(res.status, r.path).toBe(200);
      expect(res.headers.get("cache-control")).toBe("no-store");
      assertNoCanary(await res.text());
    }
  });

  it("app list contains only allowlisted apps", async () => {
    const a = authed();
    const body = await (await a.get("/api/apps")).text();
    expect(body).toContain("shop-api");
    expect(body).not.toContain("secret-internal-app");
  });

  it("allowlist bypass attempts return the same 404 as a nonexistent app", async () => {
    const a = authed();
    const probe = async (name: string) => {
      const res = await appRoute.GET(new Request(`${ORIGIN}/api/apps/${encodeURIComponent(name)}`, { headers: { cookie: a.cookie } }), ctx(name));
      return { status: res.status, body: await res.text() };
    };
    const ref = await probe("does-not-exist");
    expect(ref.status).toBe(404);
    for (const name of ["secret-internal-app", "SHOP-API", "shop-api/../secret-internal-app", "shop-api%2f..", "..", "shop-api;x", "shop-api\u0000"]) {
      expect(await probe(name)).toEqual(ref);
    }
    expect(a.calls).toHaveLength(0);
  });

  it("validates query parameters", async () => {
    const a = authed();
    expect((await a.get("/api/apps/shop-api/logs?window=9999")).status).toBe(400);
    expect((await a.get("/api/apps/shop-api/logs?window=abc")).status).toBe(400);
    expect((await a.get("/api/apps/shop-api/metrics?kind=disk&window=60")).status).toBe(400);
    expect((await a.get("/api/apps/shop-api/metrics?window=60")).status).toBe(400);
    expect(a.calls).toHaveLength(0);
  });

  it("applies a per-session request limit", async () => {
    const a = authed();
    let last = 200;
    for (let i = 0; i < 125; i++) last = (await appRoute.GET(new Request(`${ORIGIN}/api/apps/nope`, { headers: { cookie: a.cookie } }), ctx("nope"))).status;
    expect(last).toBe(429);
  });
});

describe("upstream failures map to safe, typed responses", () => {
  const cases: Array<[string, Responder, number, string]> = [
    ["upstream 401 (our token rejected) is NOT a browser 401", () => new Response("x", { status: 401 }), 502, "unauthorized"],
    ["upstream 403", () => new Response("x", { status: 403 }), 502, "forbidden"],
    ["upstream 429", () => new Response("x", { status: 429, headers: { "retry-after": "1" } }), 429, "rate_limited"],
    ["upstream 500", () => new Response(`leak ${CANARY.token}`, { status: 500 }), 502, "upstream_error"],
    ["timeout", () => Promise.reject(Object.assign(new Error("t"), { name: "TimeoutError" })), 504, "timeout"],
    ["network", () => Promise.reject(new TypeError("fetch failed")), 502, "network"],
    ["malformed payload", () => new Response(JSON.stringify({ projects: "x" }), { headers: { "content-type": "application/json" } }), 502, "contract_mismatch"],
    ["non-JSON", () => new Response("<html>", { headers: { "content-type": "text/html" } }), 502, "contract_mismatch"],
  ];
  it.each(cases)("%s", async (_n, responder, status, code) => {
    const a = authed({}, responder);
    const res = await a.get("/api/apps");
    expect(res.status).toBe(status);
    const text = await res.text();
    expect(JSON.parse(text).error.code).toBe(code);
    expect(text).not.toMatch(/CANARY|leak|html/);
    if (status === 429) expect(res.headers.get("retry-after")).toBeTruthy();
  });

  it("an unexpected internal exception never reaches the client", async () => {
    const a = authed();
    a.svc.listApps = (async () => {
      throw new Error(`boom ${CANARY.token}`);
    }) as never;
    const res = await a.get("/api/apps");
    expect(res.status).toBe(500);
    expect(await res.text()).not.toMatch(/boom|CANARY/);
  });
});

describe("login / logout", () => {
  const configure = (env: Record<string, string | undefined> = {}) => __setConfigForTests(makeConfig({ APP_ACCESS_PASSWORD_HASH: HASH, ...env }));

  it("fails closed when no password hash is configured", async () => {
    __setConfigForTests(makeConfig());
    const res = await loginRoute.POST(loginReq({ password: TEST_PASSWORD }));
    expect(res.status).toBe(503);
    expect(res.headers.get("set-cookie")).toBeNull();
  });

  it("rejects invalid credentials without a cookie", async () => {
    configure();
    const res = await loginRoute.POST(loginReq({ password: "wrong-password-123" }));
    expect(res.status).toBe(401);
    expect(res.headers.get("set-cookie")).toBeNull();
    expect(await res.text()).not.toContain(HASH);
  });

  it("issues a hardened session cookie that authorises data routes, and logout revokes it", async () => {
    const cfg = makeConfig({ APP_ACCESS_PASSWORD_HASH: HASH });
    installService(cfg, buildService(cfg)); // mock data, real authentication
    const res = await loginRoute.POST(loginReq({ password: TEST_PASSWORD }));
    expect(res.status).toBe(200);
    const setCookie = res.headers.get("set-cookie")!;
    expect(setCookie).toMatch(/HttpOnly/);
    expect(setCookie).toMatch(/SameSite=Strict/);
    expect(setCookie).toMatch(/Path=\//);
    const cookie = setCookie.split(";")[0]!;
    const ok = await appsRoute.GET(new Request(`${ORIGIN}/api/apps`, { headers: { cookie } }));
    expect(ok.status).toBe(200);
    const out = await logoutRoute.POST(new Request(`${ORIGIN}/api/auth/logout`, { method: "POST", headers: { cookie, origin: ORIGIN, "content-type": "application/json", host: "localhost:3000" }, body: "{}" }));
    expect(out.status).toBe(200);
    expect(out.headers.get("set-cookie")).toMatch(/Max-Age=0/);
    expect((await appsRoute.GET(new Request(`${ORIGIN}/api/apps`, { headers: { cookie } }))).status).toBe(401);
  });

  it("production cookies are Secure with the __Host- prefix", async () => {
    __setConfigForTests(makeConfig({ NODE_ENV: "production", APP_ACCESS_PASSWORD_HASH: HASH }));
    const res = await loginRoute.POST(loginReq({ password: TEST_PASSWORD }));
    const setCookie = res.headers.get("set-cookie")!;
    expect(setCookie.startsWith("__Host-")).toBe(true);
    expect(setCookie).toMatch(/; Secure/);
  });

  it("throttles repeated failures (even for the correct password afterwards)", async () => {
    configure();
    for (let i = 0; i < 5; i++) expect((await loginRoute.POST(loginReq({ password: `wrong-password-${i}x` }))).status).toBe(401);
    const blocked = await loginRoute.POST(loginReq({ password: TEST_PASSWORD }));
    expect(blocked.status).toBe(429);
    expect(Number(blocked.headers.get("retry-after"))).toBeGreaterThan(0);
    expect(blocked.headers.get("set-cookie")).toBeNull();
  });

  describe("throttle key (documented behaviour: never weakened by client-controlled headers)", () => {
    const from = (xff: string, pw: string) => loginRoute.POST(loginReq({ password: pw }, { "x-forwarded-for": xff }));
    it("without a trusted proxy every client shares ONE bucket, so rotating X-Forwarded-For cannot buy extra attempts", async () => {
      configure();
      for (let i = 0; i < 5; i++) expect((await from(`198.51.100.${i + 1}`, `wrong-password-${i}x`)).status).toBe(401);
      expect((await from("198.51.100.99", TEST_PASSWORD)).status).toBe(429);
    });
    it("with a trusted proxy the RIGHTMOST (proxy-appended) address is the key; a spoofed leftmost value is ignored; an unparsable one falls back to the shared bucket", async () => {
      configure({ TRUST_PROXY_HEADERS: "true" });
      for (let i = 0; i < 5; i++) expect((await from(`6.6.6.${i}, 203.0.113.7`, `wrong-password-${i}x`)).status).toBe(401);
      expect((await from("1.1.1.1, 203.0.113.7", TEST_PASSWORD)).status, "same real client, new spoofed prefix").toBe(429);
      expect((await from("1.1.1.1, 203.0.113.8", TEST_PASSWORD)).status, "a different real client is not locked out by it").toBe(200);
      for (let i = 0; i < 5; i++) expect((await from("garbage;drop", `wrong-password-${i}y`)).status).toBe(401);
      expect((await from("not an ip", TEST_PASSWORD)).status, "unparsable ⇒ shared bucket").toBe(429);
    });
    it("a global ceiling still applies across many distinct clients (distributed guessing is bounded too)", async () => {
      configure({ TRUST_PROXY_HEADERS: "true" });
      for (let i = 0; i < 20; i++) expect((await from(`203.0.113.${100 + Math.floor(i / 4)}`, `wrong-password-${i}z`)).status).toBe(401);
      const r = await from("203.0.113.250", TEST_PASSWORD);
      expect(r.status).toBe(429);
      expect(r.headers.get("set-cookie")).toBeNull();
    });
  });

  it("enforces same-origin + JSON on state-changing auth routes", async () => {
    configure();
    const cases: Array<[string, Request]> = [
      ["cross-origin", loginReq({ password: TEST_PASSWORD }, { origin: "https://evil.example" })],
      ["origin lookalike", loginReq({ password: TEST_PASSWORD }, { origin: "http://localhost:3000.evil.example" })],
      ["malformed origin", loginReq({ password: TEST_PASSWORD }, { origin: "not a url" })],
      ["wrong content type", loginReq({ password: TEST_PASSWORD }, { "content-type": "text/plain" })],
      ["form post", loginReq("password=x", { "content-type": "application/x-www-form-urlencoded" })],
      ["no origin and no fetch-metadata", new Request(`${ORIGIN}/api/auth/login`, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ password: TEST_PASSWORD }) })],
    ];
    for (const [label, req] of cases) {
      const res = await loginRoute.POST(req);
      expect(res.status, label).toBe(403);
      expect(res.headers.get("set-cookie"), label).toBeNull();
    }
    const logout = await logoutRoute.POST(new Request(`${ORIGIN}/api/auth/logout`, { method: "POST", headers: { origin: "https://evil.example", "content-type": "application/json" }, body: "{}" }));
    expect(logout.status).toBe(403);
  });

  it("rejects malformed, oversized and over-specified bodies", async () => {
    configure();
    for (const body of ["{not json", JSON.stringify({ password: "x".repeat(300) }), JSON.stringify({ password: "a-valid-password-1", admin: true }), JSON.stringify({}), JSON.stringify({ password: 123 }), "x".repeat(5000)]) {
      expect((await loginRoute.POST(loginReq(body))).status).toBe(400);
    }
  });

  it("client key honours the rightmost X-Forwarded-For only when proxy headers are trusted", () => {
    const req = new Request(ORIGIN, { headers: { "x-forwarded-for": "6.6.6.6, 203.0.113.9" } });
    __setConfigForTests(makeConfig());
    expect(clientKey(req)).toBe("global");
    __setConfigForTests(makeConfig({ TRUST_PROXY_HEADERS: "true" }));
    expect(clientKey(req)).toBe("203.0.113.9");
    expect(clientKey(new Request(ORIGIN, { headers: { "x-forwarded-for": "garbage;drop" } }))).toBe("global");
  });
});

describe("health & method surface", () => {
  it("health endpoint is public and reveals nothing", async () => {
    const res = healthRoute.GET();
    expect(await res.json()).toEqual({ status: "ok" });
  });

  it("data routes export no write handlers", () => {
    for (const mod of [appsRoute, appRoute, appletsRoute, releasesRoute, eventsRoute, logsRoute, metricsRoute, diagRoute, healthRoute]) {
      for (const m of ["POST", "PUT", "PATCH", "DELETE"]) expect((mod as Record<string, unknown>)[m], m).toBeUndefined();
    }
  });
});
