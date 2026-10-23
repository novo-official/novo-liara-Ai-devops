import { readdirSync, readFileSync, statSync } from "node:fs";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { createSession, __clearSessionsForTests } from "@/server/security/session";
import { __resetApiLimiterForTests } from "@/server/security/guard";
import { ENDPOINTS } from "@/server/liara/endpoints";
import { installService, liveService, resetAll } from "../helpers/live";

import * as appsRoute from "@/app/api/apps/route";
import * as appRoute from "@/app/api/apps/[name]/route";
import * as appletsRoute from "@/app/api/apps/[name]/applets/route";
import * as releasesRoute from "@/app/api/apps/[name]/releases/route";
import * as eventsRoute from "@/app/api/apps/[name]/events/route";
import * as logsRoute from "@/app/api/apps/[name]/logs/route";
import * as metricsRoute from "@/app/api/apps/[name]/metrics/route";
import * as diagRoute from "@/app/api/diagnostics/route";

const ROOT = path.resolve(__dirname, "../..");
const SRC = path.join(ROOT, "src");

function walk(dir: string): string[] {
  return readdirSync(dir).flatMap((n) => {
    const p = path.join(dir, n);
    return statSync(p).isDirectory() ? walk(p) : [p];
  });
}
const stripComments = (s: string) => s.replace(/\/\*[\s\S]*?\*\//g, "").replace(/(^|[^:])\/\/.*$/gm, "$1");
const files = walk(SRC).filter((f) => /\.(ts|tsx)$/.test(f));
const rel = (f: string) => path.relative(ROOT, f);

describe("static guarantees (source scan)", () => {
  it("no shell/process execution or dynamic code in application code", () => {
    const banned = /(child_process|worker_threads|\bnode:vm\b|from ["']vm["']|\beval\s*\(|new Function\s*\(|\bexecSync\b|\bspawn(Sync)?\b)/;
    // Phase 2D: exactly ONE file may start a process — the restricted runner of the optional official-CLI backend (see live-cli.test.ts for its own static guarantees)
    const offenders = files.filter((f) => banned.test(stripComments(readFileSync(f, "utf8"))) && !rel(f).split(path.sep).join("/").endsWith("src/server/live/cli/process-runner.ts"));
    expect(offenders.map(rel)).toEqual([]);
  });

  it("the only fetch() call sites are own-origin UI components (auth + diagnostic runs); Liara egress goes through http.ts only", () => {
    const callers = files.filter((f) => /\bfetch\s*\(/.test(stripComments(readFileSync(f, "utf8")))).map(rel).sort();
    expect(callers).toEqual(["src/components/agent-workspace.tsx", "src/components/approval-card.tsx", "src/components/deploy-journey.tsx", "src/components/diagnostic-form.tsx", "src/components/live-deployment.tsx", "src/components/login-form.tsx", "src/components/logout-button.tsx", "src/components/run-view.tsx", "src/components/server-runtime-panel.tsx"]);
    for (const f of callers) {
      const code = stripComments(readFileSync(path.join(ROOT, f), "utf8"));
      // live-deployment.tsx funnels every request through one `api(url)` helper: its literal URLs are the call sites
      const urls = f.endsWith("live-deployment.tsx") ? [...code.matchAll(/\bapi(?:<[^>]*>)?\(\s*[`"']([^`"'$]+)/g)].map((m) => m[1]) : [...code.matchAll(/fetch\(\s*[`"']([^`"']+)/g)].map((m) => m[1]);
      if (f.endsWith("live-deployment.tsx")) expect(urls.every((u) => u!.startsWith("/api/agent/live/")), urls.join(",")).toBe(true);
      expect(urls.length).toBeGreaterThan(0);
      expect(urls.every((u) => u!.startsWith("/api/auth/") || u!.startsWith("/api/diagnostic-runs") || u!.startsWith("/api/agent/")), `${f}: ${urls.join(",")}`).toBe(true);
    }
    const http = stripComments(readFileSync(path.join(SRC, "server/liara/http.ts"), "utf8"));
    expect(http.match(/fetchImpl\(/g)).toHaveLength(1);
  });

  it("the Liara client contains no write HTTP verb and no request body", () => {
    for (const f of ["server/liara/http.ts", "server/liara/endpoints.ts", "server/liara/read-client.ts", "server/liara/service.ts", "server/liara/verify.ts", "server/liara/recorder.ts"]) {
      const code = stripComments(readFileSync(path.join(SRC, f), "utf8"));
      expect(code, f).not.toMatch(/\b(POST|PUT|PATCH|DELETE)\b/);
      expect(code, f).not.toMatch(/\bbody\s*:/);
    }
    const http = stripComments(readFileSync(path.join(SRC, "server/liara/http.ts"), "utf8"));
    expect([...http.matchAll(/method\s*:\s*"([A-Z]+)"/g)].map((m) => m[1])).toEqual(["GET"]);
  });

  it("every registered endpoint is a GET and none targets a mutating path", () => {
    for (const e of Object.values(ENDPOINTS)) {
      expect(e.method).toBe("GET");
      expect(e.path).toMatch(/^(\/v[12]\/projects|\/v1\/me(\/subscription|\/free-credit)?$|\/v1\/billing$|\/v1\/networks$)/); // app endpoints + the read-only account endpoints (+ Phase 2B billing and CLI-observed networks)
      expect(e.path).not.toMatch(/actions|resize|update-envs|sources|zero-downtime|default-subdomain|fixed-ip|read-only|disks|domains|ftp|backups/);
    }
    expect(Object.keys(ENDPOINTS).sort()).toEqual(
      ["getApp", "getApplets", "getEvents", "getLogsV1", "getLogsV2", "getMe", "getMeFreeCredit", "getBilling", "getMeSubscription", "getMetricsCpu", "getMetricsMemory", "getReleases", "listApps", "listNetworks"].sort(),
    );
  });

  it("API routes export only the allowed methods", () => {
    const routes = files.filter((f) => /src\/app\/api\/.*route\.ts$/.test(f.split(path.sep).join("/")));
    expect(routes.length).toBeGreaterThanOrEqual(20);
    for (const f of routes) {
      const code = stripComments(readFileSync(f, "utf8"));
      const methods = [...code.matchAll(/export\s+(?:async\s+)?(?:function|const)\s+(GET|POST|PUT|PATCH|DELETE|HEAD|OPTIONS)\b/g)].map((m) => m[1]);
      const p = rel(f).split(path.sep).join("/");
      const expected =
        p.endsWith("auth/login/route.ts") || p.endsWith("auth/logout/route.ts") || p.endsWith("diagnostic-runs/[id]/cancel/route.ts") ||
        p.endsWith("api/agent/messages/route.ts") || p.endsWith("agent/deploy/uploads/route.ts") || p.endsWith("agent/deploy/runs/[id]/checklist/route.ts") || p.endsWith("agent/deploy/runs/[id]/plan/route.ts") || p.endsWith("agent/runs/[id]/cancel/route.ts") || p.endsWith("agent/runs/[id]/retry/route.ts") || p.endsWith("agent/proposals/[id]/decision/route.ts") ||
        // Phase 2A live API: own-origin, default-disabled; every POST fails closed unless the live executor is explicitly enabled and approved
        /api\/agent\/live\/(proposals\/route|proposals\/\[id\]\/(decision|execute)\/route|operations\/\[id\]\/resolve\/route)\.ts$/.test(p)
          ? ["POST"]
          : p.endsWith("api/diagnostic-runs/route.ts")
            ? ["GET", "POST"] // GET = list own runs, POST = start an OFFLINE read-only analysis
            : ["GET"];
      expect([...methods].sort(), p).toEqual(expected);
    }
  });

  it("auth POST routes cannot reach Liara (they import no Liara module)", () => {
    for (const f of ["server/security/login.ts", "app/api/auth/login/route.ts", "app/api/auth/logout/route.ts"]) {
      expect(readFileSync(path.join(SRC, f), "utf8"), f).not.toMatch(/liara\/(service|http|read-client)/);
    }
  });

  it("the diagnostics layer contains no write HTTP verb, no request body and no Liara mutation vocabulary", () => {
    const dFiles = files.filter((f) => rel(f).split(path.sep).join("/").startsWith("src/server/diagnostics/"));
    expect(dFiles.length).toBeGreaterThan(12);
    for (const f of dFiles) {
      const code = stripComments(readFileSync(f, "utf8"));
      // signals.ts is the one exception: it lists HTTP method names only to PARSE access-log lines (text), it never issues requests
      if (!rel(f).endsWith("diagnostics/signals.ts")) expect(code, rel(f)).not.toMatch(/\b(POST|PUT|PATCH|DELETE)\b/);
      expect(code, rel(f)).not.toMatch(/\bfetch\s*\(|\bbody\s*:|\/v[12]\/|actions\/(restart|scale)|update-envs|\/resize/);
    }
  });

  it("diagnostic routes reach Liara only through the read-only LiaraService (never the HTTP client or the recorder)", () => {
    for (const f of ["app/api/diagnostic-runs/route.ts", "app/api/diagnostic-runs/[id]/route.ts", "app/api/diagnostic-runs/[id]/cancel/route.ts", "server/diagnostics/runtime.ts"]) {
      const code = readFileSync(path.join(SRC, f), "utf8");
      expect(code, f).not.toMatch(/liara\/(http|recorder|verify|endpoints)/);
    }
    const workflow = readFileSync(path.join(SRC, "server/diagnostics/workflow.ts"), "utf8");
    expect(workflow).toMatch(/from "\.\.\/liara\/service"/);
    expect(workflow).not.toMatch(/liara\/http/);
  });

  it("the agent layer contains no write HTTP verb, no request body, no fetch and no Liara mutation vocabulary", () => {
    const aFiles = files.filter((f) => rel(f).split(path.sep).join("/").startsWith("src/server/agent/"));
    expect(aFiles.length).toBeGreaterThan(10);
    for (const f of aFiles) {
      const code = stripComments(readFileSync(f, "utf8"));
      expect(code, rel(f)).not.toMatch(/\b(POST|PUT|PATCH|DELETE)\b/);
      expect(code, rel(f)).not.toMatch(/\bfetch\s*\(|\bbody\s*:|\/v[12]\/|actions\/(restart|scale)|update-envs|\/resize|create-release|createRelease/);
    }
  });

  it("the agent layer reaches Liara only through the read-only LiaraService / diagnostics collector (never http, recorder, endpoints or verify)", () => {
    const aFiles = files.filter((f) => /src\/(server\/agent|app\/api\/agent)\//.test(f.split(path.sep).join("/")));
    for (const f of aFiles) {
      const code = readFileSync(f, "utf8");
      expect(code, rel(f)).not.toMatch(/liara\/(http|recorder|verify|endpoints|fixture-transport)/);
      // the read-client may be imported for its window constants only, never to construct a client
      for (const m of code.matchAll(/import\s*\{([^}]*)\}\s*from\s*["'][^"']*liara\/read-client["']/g)) expect(m[1]!.split(",").map((x) => x.trim()).filter(Boolean).every((x) => /^(type\s+)?(WINDOWS_MINUTES|WindowMinutes)$/.test(x)), rel(f)).toBe(true);
    }
  });

  it("no module constructs a write-capable Liara client: the transport interface exposes only get()", () => {
    const rc = stripComments(readFileSync(path.join(SRC, "server/liara/read-client.ts"), "utf8"));
    const iface = /export interface Transport \{[\s\S]*?\n\}/.exec(rc)![0];
    expect(iface).toMatch(/\bget</);
    expect(iface).not.toMatch(/\b(post|put|patch|delete|request|send|write|mutate|restart|scale)\b/i);
  });

  it("agent routes never read an 'approved' flag from the client", () => {
    for (const f of files.filter((x) => /src\/app\/api\/agent\//.test(x.split(path.sep).join("/")))) {
      expect(stripComments(readFileSync(f, "utf8")), rel(f)).not.toMatch(/\bapproved\b/);
    }
  });

  it("the deployment layer never executes, imports or evaluates uploaded code and has no network or Liara access", () => {
    const dFiles = files.filter((f) => rel(f).split(path.sep).join("/").startsWith("src/server/deploy/"));
    expect(dFiles.length).toBeGreaterThanOrEqual(12);
    for (const f of dFiles) {
      const code = stripComments(readFileSync(f, "utf8"));
      const name = rel(f).split(path.sep).join("/");
      expect(code, name).not.toMatch(/\bfetch\s*\(|\bbody\s*:|actions\/(restart|scale)|\bXMLHttpRequest\b|WebSocket/);
      // strategy.ts is DOCUMENTATION DATA (it names the future API operations as strings); no other deploy module may mention an endpoint
      if (!name.endsWith("deploy/strategy.ts")) expect(code, name).not.toMatch(/\/v[12]\/|update-envs|create-release/);
      expect(code, name).not.toMatch(/child_process|worker_threads|\bnode:vm\b|\beval\s*\(|new Function\s*\(|\bexecSync?\b|\bspawn(Sync)?\b|\brequire\s*\(|\bimport\s*\(|node:(https?|net|tls|dns|dgram)|from ["'](https?|net|tls|dns|undici)["']/);
      expect(code, name).not.toMatch(/liara\/(service|http|read-client|recorder|endpoints|verify|fixture-transport)/);
      // filesystem access is confined to the isolated workspace module
      if (!name.endsWith("deploy/workspace.ts")) expect(code, name).not.toMatch(/from ["'](node:)?fs(\/promises)?["']/);
    }
  });

  it("the deployment routes cannot reach Liara (they only use the agent manager and the upload guard)", () => {
    for (const f of files.filter((x) => /src\/app\/api\/agent\/deploy\//.test(x.split(path.sep).join("/")))) {
      expect(readFileSync(f, "utf8"), rel(f)).not.toMatch(/liara\/(service|http|read-client|recorder|endpoints|verify)/);
    }
  });

  it("only the config module reads process.env", () => {
    const offenders = files.filter((f) => !rel(f).includes("server/config/") && /process\.env/.test(stripComments(readFileSync(f, "utf8"))));
    expect(offenders.map(rel)).toEqual([]);
  });

  it("no module outside the integration layer imports NEXT_PUBLIC token variables", () => {
    const all = files.map((f) => readFileSync(f, "utf8")).join("\n");
    expect(all).not.toMatch(/NEXT_PUBLIC_[A-Z_]*(TOKEN|KEY|SECRET|PASSWORD)/);
  });
});

describe("runtime guarantee: hostile requests through every route never produce a non-GET upstream call", () => {
  beforeEach(() => {
    __clearSessionsForTests();
    __resetApiLimiterForTests();
  });
  afterEach(resetAll);

  it("replays method-override tricks, odd params and every route; all upstream calls are bodiless GETs to allowed read paths", async () => {
    const l = liveService({ LIARA_LOGS_API: "auto", LIARA_ALLOW_UNDOCUMENTED_ENDPOINTS: "true" });
    installService(l.cfg, l.svc);
    const cookie = `liara_agent_session=${createSession().id}`;
    const overrides = {
      "x-http-method-override": "DELETE",
      "x-method-override": "POST",
      "x-http-method": "PUT",
      "content-type": "application/json",
    };
    const routes: Array<[(req: Request, c: { params: Promise<{ name: string }> }) => Promise<Response>, string]> = [
      [appsRoute.GET as never, "/api/apps?_method=DELETE&method=POST"],
      [appRoute.GET, "/api/apps/shop-api?_method=DELETE"],
      [appletsRoute.GET, "/api/apps/shop-api/applets?method=PUT"],
      [releasesRoute.GET, "/api/apps/shop-api/releases?page=9&count=9&action=restart"],
      [eventsRoute.GET, "/api/apps/shop-api/events?window=60&search=;DROP"],
      [logsRoute.GET, "/api/apps/shop-api/logs?window=360&since=0"],
      [metricsRoute.GET, "/api/apps/shop-api/metrics?kind=cpu&window=15&_method=DELETE"],
      [metricsRoute.GET, "/api/apps/shop-api/metrics?kind=memory&window=1440"],
      [diagRoute.GET as never, "/api/diagnostics?restart=1"],
    ];
    for (const [handler, url] of routes) {
      // Even if a client (or proxy) sends a non-GET verb with a body, the handlers never forward it.
      for (const method of ["GET", "POST"]) {
        const init: RequestInit = method === "POST" ? { method, body: JSON.stringify({ restart: true, scale: 0 }) } : {};
        const res = await handler(new Request(`http://localhost:3000${url}`, { ...init, headers: { cookie, ...overrides } }), { params: Promise.resolve({ name: "shop-api" }) });
        expect(res.status, `${method} ${url}`).toBeLessThan(500);
      }
    }
    expect(l.calls.length).toBeGreaterThan(10);
    const allowedPath = /^\/v[12]\/projects(\/[a-z0-9-]+(\/(applets|releases|events|logs|metrics\/(cpu|memory)))?)?$/;
    for (const c of l.calls) {
      expect(c.method).toBe("GET");
      expect(c.body).toBeNull();
      expect(c.url.hostname).toBe("api.liara.ir");
      expect(c.url.pathname).toMatch(allowedPath);
      expect([...c.url.searchParams.keys()].filter((k) => /method|action|restart|scale|delete/i.test(k))).toEqual([]);
      expect(Object.keys(c.headers).some((h) => /override|x-http-method/i.test(h))).toBe(false);
    }
  });

  it("an attacker-supplied path segment cannot select another Liara endpoint", async () => {
    const l = liveService();
    installService(l.cfg, l.svc);
    const cookie = `liara_agent_session=${createSession().id}`;
    for (const name of ["shop-api/actions/restart", "shop-api/../shop-web", "shop-api%2Factions%2Fscale", "shop-api/resize"]) {
      const res = await appRoute.GET(new Request("http://localhost:3000/api/apps/x", { headers: { cookie } }), { params: Promise.resolve({ name }) });
      expect(res.status).toBe(404);
    }
    expect(l.calls).toHaveLength(0);
  });
});
