import { loadConfig, __setConfigForTests, type AppConfig } from "@/server/config/env";
import { buildService, __setServiceForTests, type LiaraService } from "@/server/liara/service";
import { resetCapabilityState } from "@/server/liara/capabilities";
import { __resetSecretsForTests } from "@/server/security/secret";
import { CANARY } from "./canaries";

export const TEST_PASSWORD = "correct horse battery staple 42";

export function makeConfig(env: Record<string, string | undefined> = {}): AppConfig {
  return loadConfig({ NODE_ENV: "test", ...env });
}

export const LIVE_ENV = {
  LIARA_DATA_SOURCE: "live",
  LIARA_API_TOKEN: CANARY.token,
  LIARA_ALLOWED_APPS: "shop-api,shop-web",
  LIARA_MAX_RPS: "20",
  APP_ACCESS_PASSWORD_HASH: "scrypt$4096$8$1$AAAAAAAAAAAAAAAAAAAAAA$AAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA",
};

export interface Call {
  url: URL;
  method: string;
  headers: Record<string, string>;
  body: unknown;
}

export type Responder = (url: URL, call: Call) => Response | Promise<Response>;

export function json(body: unknown, init: ResponseInit = {}): Response {
  return new Response(JSON.stringify(body), { status: 200, headers: { "content-type": "application/json" }, ...init });
}

/** A fake fetch that records every call. */
export function recordingFetch(responder: Responder) {
  const calls: Call[] = [];
  const impl = (async (input: RequestInfo | URL, init?: RequestInit) => {
    const url = input instanceof URL ? input : new URL(String(input));
    const call: Call = {
      url,
      method: (init?.method ?? "GET").toUpperCase(),
      headers: Object.fromEntries(new Headers(init?.headers as HeadersInit).entries()),
      body: init?.body ?? null,
    };
    calls.push(call);
    return responder(url, call);
  }) as typeof fetch;
  return { calls, impl };
}

/** Hostile-but-plausible raw Liara payloads: documented shapes plus extra sensitive/unknown fields. */
export const RAW = {
  apps: {
    projects: [
      { _id: "1", project_id: "shop-api", type: "node", status: "RUNNING", scale: 1, planID: "p1", created_at: "2026-01-02T03:04:05Z", isDeployed: true, api_token: CANARY.apiToken, owner_email: CANARY.email },
      { _id: "2", project_id: "shop-web", type: "next", status: "RUNNING", scale: 1, planID: "p1", created_at: "2026-01-02T03:04:05Z", isDeployed: true },
      { _id: "3", project_id: "secret-internal-app", type: "node", status: "RUNNING", scale: 1, planID: "p1", created_at: "2026-01-02T03:04:05Z", isDeployed: true },
      { bogus: true },
    ],
  },
  app: (name: string) => ({
    project: {
      _id: "1",
      project_id: name,
      type: "node",
      status: "RUNNING",
      scale: 1,
      planID: "p1",
      created_at: "2026-01-02T03:04:05Z",
      isDeployed: true,
      defaultSubdomain: true,
      zeroDowntime: false,
      readOnlyRootFilesystem: false,
      fixedIPStatus: "disabled",
      envs: [
        { key: "DATABASE_URL", value: CANARY.envValue, encrypted: false, _id: "e1" },
        { key: "bad key!", value: "x", encrypted: false },
      ],
      node: { _id: "n", IP: CANARY.nodeIp },
      hourlyPrice: 12,
      sshPrivateKey: CANARY.sshKey,
      brandNewFutureField: CANARY.unknownField,
    },
  }),
  applets: {
    applets: [
      { id: "a1", name: "shop-api-1", timestamp: "2026-01-02T03:04:05Z", state: "running", reason: "", release: { releaseID: "r1", tag: "v1" }, secretToken: CANARY.apiToken },
    ],
  },
  releases: {
    total: 1,
    currentRelease: "v1",
    platform: "node",
    releases: [
      {
        _id: "r1", type: "source", imageName: "registry.example.invalid/x", state: "READY", port: 3000, tag: "v1",
        createdAt: "2026-01-02T03:04:05Z", finishedAt: "2026-01-02T03:05:05Z", sourceAvailable: true,
        gitInfo: { branch: "main", commit: "a1b2c3d4e5f60718293a4b5c6d7e8f9012345678", message: "init", remote: CANARY.remote, author: { name: CANARY.author, email: CANARY.email }, tags: [] },
      },
    ],
  },
  events: { data: [{ metaData: { secret: CANARY.apiToken }, values: [["1767323045000000000", "Applet started"]] }] },
  logsV1: [{ type: "stdout", datetime: "2026-01-02T03:04:05Z", message: "hello" }],
  metrics: { end: 1767323100, result: [{ applet: "shop-api-1", values: [[1767323040, "0.12"], [1767323100, "0.15"]] }] },
};

export function defaultResponder(): Responder {
  return (url) => {
    const p = url.pathname;
    if (p === "/v1/projects") return json(RAW.apps);
    const m = /^\/v([12])\/projects\/([^/]+)(?:\/(.*))?$/.exec(p);
    if (!m) return json({}, { status: 404 });
    const name = decodeURIComponent(m[2]!);
    switch (m[3]) {
      case undefined:
        return json(RAW.app(name));
      case "applets":
        return json(RAW.applets);
      case "releases":
        return json(RAW.releases);
      case "events":
        return json(RAW.events);
      case "logs":
        return m[1] === "1"
          ? json(RAW.logsV1)
          : json({ data: [{ metaData: { releaseId: "r1" }, values: [["1767323045000000000", "v2 line"]] }] });
      case "metrics/cpu":
      case "metrics/memory":
        return json(RAW.metrics);
      default:
        return json({}, { status: 404 });
    }
  };
}

export function liveService(env: Record<string, string | undefined> = {}, responder: Responder = defaultResponder()) {
  const cfg = makeConfig({ ...LIVE_ENV, ...env });
  const rec = recordingFetch(responder);
  const svc = buildService(cfg, { fetchImpl: rec.impl, sleep: async () => undefined, now: () => Date.UTC(2026, 0, 2, 4, 0, 0) });
  return { cfg, svc, ...rec };
}

export function installService(cfg: AppConfig, svc: LiaraService) {
  __setConfigForTests(cfg);
  __setServiceForTests(svc);
}

export function resetAll() {
  __setConfigForTests(undefined);
  __setServiceForTests(undefined);
  resetCapabilityState();
  __resetSecretsForTests();
}
