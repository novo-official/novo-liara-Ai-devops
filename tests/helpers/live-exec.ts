import { readdirSync, readFileSync, statSync } from "node:fs";
import path from "node:path";
import { AgentRunManager } from "@/server/agent/manager";
import { MockDiagnosticLLMProvider } from "@/server/diagnostics/llm";
import type { PlanProjection } from "@/server/liara/plans";
import type { CreateAppRequest, CreateReleaseRequest, LiveWriteTransport, WriteErrorCode, WriteResult } from "@/server/live/contract";
import type { LiveReader, ReadResult } from "@/server/live/reader";
import { LiveDeploymentService, type LiveServiceOptions } from "@/server/live/service";
import { MemoryLiveStore, type LiveStore } from "@/server/live/store";
import type { PlanUnits } from "@/server/live/units";
import type { ProbeResult } from "@/server/live/probe";
import { CANARY } from "./canaries";
import { NOW } from "./evidence-builder";
import { LIVE_ENV, makeConfig } from "./live";
import { buildZip } from "./zip";
import { mockSvc } from "./scenario-runner";

export const OWNER = "live-session-A-secret";
export const OTHER = "live-session-B-secret";
export const TEAM = "team_demo_1";
export const NETWORK = "net_demo_1";

/** The repository-owned demo project, packed in memory exactly like `npm run demo:zip`. */
export function demoZip(over: Record<string, string | null> = {}): Buffer {
  const root = path.resolve(__dirname, "../../fixtures/demo-app");
  const walk = (dir: string, rel = ""): string[] => readdirSync(dir).flatMap((n) => (["node_modules", ".next"].includes(n) ? [] : statSync(path.join(dir, n)).isDirectory() ? walk(path.join(dir, n), rel ? `${rel}/${n}` : n) : [rel ? `${rel}/${n}` : n]));
  const files = new Map(walk(root).sort().map((f) => [f, readFileSync(path.join(root, f), "utf8")] as [string, string]));
  for (const [k, v] of Object.entries(over)) {
    if (v === null) files.delete(k);
    else files.set(k, v);
  }
  return buildZip([...files.entries()].sort(([a], [b]) => (a < b ? -1 : 1)).map(([name, data]) => ({ name, data })));
}

export const UNITS: PlanUnits = {
  ram: "GB",
  cpu: "cores",
  price: { currency: "IRT", per: "hour" },
  billing: { model: "hourly_from_creation", minimumBalanceToCreate: 50000, otherCostsKnown: ["ترافیک خروجی طبق تعرفه"], otherCostsUnknown: ["هزینهٔ دقیق ساعت اول"] },
  acceptedUnknowns: ["billing_start", "minimum_balance", "zero_balance_behavior", "bundle_plan_price", "vat"],
  verifiedAt: "2026-10-22",
  source: "operator checked liara.ir/pricing on 2026-10-22",
};

export const CATALOGUE: PlanProjection = {
  plans: [
    { id: "g2-tiny", available: true, region: "iran", ramAmount: 0.25, cpuAmount: 0.25, volume: 1, price: 500 },
    // the next four are the PUBLIC pricing-page plans (Mars, Jupiter, Saturn, Uranus) so the units can be corroborated: GB, Toman per HOUR
    { id: "g2-small", available: true, region: "iran", ramAmount: 1, cpuAmount: 1, volume: 5, price: 1805 },
    { id: "g2-medium", available: true, region: "iran", ramAmount: 2, cpuAmount: 1, volume: 5, price: 3194 },
    { id: "g2-big", available: true, region: "iran", ramAmount: 4, cpuAmount: 2, volume: 10, price: 5729 },
    { id: "g2-off", available: false, region: "iran", ramAmount: 8, cpuAmount: 4, volume: 20, price: 10069 },
    { id: "g2-unknown", available: null, region: "iran", ramAmount: 2, cpuAmount: 1, volume: 5, price: 3194 },
    { id: "g2-noregion", available: true, region: null, ramAmount: 8, cpuAmount: 4, volume: 20, price: 10069 },
  ],
  bundles: {
    "g2-tiny": [{ id: "bronze", available: true }],
    "g2-small": [{ id: "bronze", available: true }],
    "g2-medium": [{ id: "bronze", available: true }],
    "g2-big": [{ id: "bronze", available: true }, { id: "silver", available: true }],
    "g2-off": [{ id: "bronze", available: true }],
    "g2-unknown": [{ id: "bronze", available: true }],
    "g2-noregion": [{ id: "bronze", available: true }],
  },
  skipped: 0,
  verified: false,
  unitsVerified: false,
  account: { teamPresent: true, teamBalance: 10_000_000 },
};

// ------------------------------------------------------------------------------------------------ a fake "Liara"
export type CreateBehavior = "rejected_409_but_created" | "ok" | "rejected_409" | "rejected_402" | "rejected_403" | "rejected_400" | "timeout_created" | "timeout_not_created" | "ok_invisible" | "server_error_created";
export type UploadBehavior = "ok" | "rejected_413" | "rejected_400" | "timeout" | "malformed";
export type ReleaseBehavior = "rejected_400_but_created" | "ok" | "rejected_400" | "timeout_created" | "timeout_not_created" | "timeout_two_created";

export class FakeLiara {
  apps = new Set<string>();
  /** state of the release the fake "builds" */
  releaseStates: (string | null)[] = ["DEPLOYING", "READY"];
  releaseIds: string[] = [];
  appScale: number | null = 1;
  runtime: { runtime: string; appletCount: number; heuristic: boolean; enabled: string } = { runtime: "running", appletCount: 1, heuristic: true, enabled: "enabled" };
  catalogue: PlanProjection = CATALOGUE;
  catalogueOk = true;
  nameListOk = true;
  /** the account's other applications (names only matter for the count) */
  otherApps = 0;
  balance: number | null = 10_000_000;
  billingOk = true;
  networksOk = true;
  networks: { id: string; name: string | null }[] = [{ id: NETWORK, name: "demo-network" }];
  /** Phase 2D: plan id the API reports for EXISTING applications, and the operator's allowlist (names in scope) */
  existingPlanId: string | null = "g2-small";
  existingPlatform: string | null = "next";
  existingInstanceId: string | null = "inst_0001_demo";
  existingCreatedAt: string | null = "2026-10-20T08:00:00.000Z";
  existingNetworkId: string | null = NETWORK;
  existingDefaultSubdomain: boolean | null = true;
  baselineOk = true;
  scope = new Set<string>(["liara-agent-demo"]);
  /** what GET /v1/projects/{name} reports as the application's name */
  identity: "exact" | "wrong_name" | "unreadable" | "no_name" = "exact";
  create: CreateBehavior = "ok";
  upload: UploadBehavior = "ok";
  release: ReleaseBehavior = "ok";
  probeResult: ProbeResult = { outcome: "ok", status: 200, markerFound: true };
  pollsSeen = 0;
  calls: { op: "createApp" | "uploadSource" | "createRelease"; app: string; body?: unknown; bytes?: number }[] = [];
  readCalls = 0;
  private releaseSeq = 0;

  transport: LiveWriteTransport = {
    createApp: async (req: CreateAppRequest) => {
      this.calls.push({ op: "createApp", app: req.name, body: req });
      switch (this.create) {
        case "ok": this.apps.add(req.name); return ok({ accepted: true as const });
        case "ok_invisible": return ok({ accepted: true as const });
        case "rejected_409": return rej(409, "already_exists");
        case "rejected_409_but_created": this.apps.add(req.name); return rej(409, "already_exists");
        case "rejected_402": return rej(402, "insufficient_balance");
        case "rejected_403": return rej(403, "forbidden");
        case "rejected_400": return rej(400, "bad_request");
        case "timeout_created": this.apps.add(req.name); return unk("timeout");
        case "timeout_not_created": return unk("timeout");
        case "server_error_created": this.apps.add(req.name); return unk("server_error", 500);
      }
    },
    uploadSource: async (app: string, archive: Buffer) => {
      this.calls.push({ op: "uploadSource", app, bytes: archive.length });
      switch (this.upload) {
        case "ok": return ok({ sourceID: "src_0001_demo" });
        case "rejected_413": return rej(413, "payload_too_large");
        case "rejected_400": return rej(400, "bad_request");
        case "timeout": return unk("timeout");
        case "malformed": return unk("malformed_response", 200);
      }
    },
    createRelease: async (app: string, req: CreateReleaseRequest) => {
      this.calls.push({ op: "createRelease", app, body: req });
      switch (this.release) {
        case "ok": this.releaseIds.push(`rel_${++this.releaseSeq}_demo`); return ok({ releaseID: this.releaseIds.at(-1)! });
        case "rejected_400": return rej(400, "bad_request");
        case "rejected_400_but_created": this.releaseIds.push(`rel_${++this.releaseSeq}_demo`); return rej(400, "bad_request");
        case "timeout_created": this.releaseIds.push(`rel_${++this.releaseSeq}_demo`); return unk("timeout");
        case "timeout_not_created": return unk("timeout");
        case "timeout_two_created": this.releaseIds.push(`rel_${++this.releaseSeq}_demo`, `rel_${++this.releaseSeq}_demo`); return unk("timeout");
      }
    },
  };

  reader: LiveReader = {
    appNameExists: async (name) => {
      this.readCalls++;
      return this.nameListOk ? good({ exists: this.apps.has(name) }) : bad("list_incomplete");
    },
    getApp: async (name) => (this.apps.has(name) ? good({ name, scale: this.appScale, status: "running", defaultSubdomain: true }) : bad("not_found")),
    appInventory: async (name) => {
      this.readCalls++;
      return this.nameListOk ? good({ count: this.apps.size + this.otherApps, exists: name === null ? null : this.apps.has(name) }) : bad("list_incomplete");
    },
    appIdentity: async (name) => {
      if (!this.apps.has(name) || this.identity === "unreadable") return bad("not_found");
      return good({ name: this.identity === "wrong_name" ? "someone-elses-app" : this.identity === "no_name" ? null : name, scale: this.appScale, planId: this.existingPlanId, platform: this.existingPlatform, instanceId: this.existingInstanceId, createdAt: this.existingCreatedAt, networkId: this.existingNetworkId, defaultSubdomain: this.existingDefaultSubdomain });
    },
    releaseBaseline: async (name) => {
      if (!this.apps.has(name)) return bad("not_found");
      return this.baselineOk ? good({ currentRelease: this.releaseIds.at(-1) ?? null, total: this.releaseIds.length, count: this.releaseIds.length }) : bad("upstream_error");
    },
    authorizedApps: async () => good({ names: [...this.apps].filter((n) => this.scope.has(n)).sort() }),
    inScope: (name) => this.scope.has(name),
    billing: async () => (this.billingOk ? good({ balance: this.balance }) : bad("upstream_error")),
    networks: async () => (this.networksOk ? good({ items: this.networks }) : bad("upstream_error")),
    getReleases: async (name) => {
      if (!this.apps.has(name)) return bad("not_found");
      const state = this.releaseStates[Math.min(this.pollsSeen, this.releaseStates.length - 1)] ?? null;
      return good({ currentRelease: this.releaseIds.at(-1) ?? null, releases: this.releaseIds.map((id) => ({ id, state })) });
    },
    getRuntime: async () => {
      this.pollsSeen++;
      return good(this.runtime);
    },
    getRecentLogs: async () => good({ lines: ["ready"], count: 1 }),
    planCatalogue: async () => (this.catalogueOk ? good(this.catalogue) : bad("upstream_error")),
  };
}
const ok = <T,>(data: T): WriteResult<T> => ({ ok: true, status: 200, data });
const rej = (status: number, code: WriteErrorCode): WriteResult<never> => ({ ok: false, kind: "rejected", status, code });
const unk = (code: WriteErrorCode, status: number | null = null): WriteResult<never> => ({ ok: false, kind: "unknown_outcome", status, code });
const good = <T,>(data: T): ReadResult<T> => ({ ok: true, data });
const bad = (code: string): ReadResult<never> => ({ ok: false, code });

// ------------------------------------------------------------------------------------------------ the harness
export function liveEnv(over: Record<string, string | undefined> = {}) {
  return {
    ...LIVE_ENV,
    LIARA_API_TOKEN: CANARY.token,
    LIARA_ALLOWED_APPS: "other-existing-app",
    LIARA_TEAM_ID: TEAM,
    LIARA_LIVE_DEPLOY_ENABLED: "true",
    LIARA_LIVE_CONTRACT_ATTESTED: "true",
    LIARA_NETWORK_ID: NETWORK,
    LIARA_APP_DOMAIN_SUFFIXES: "liara.run",
    LIARA_ALLOW_UNDOCUMENTED_ENDPOINTS: "true",
    LIARA_LIVE_HEALTH_MARKER: "liara-agent-demo",
    LIARA_PLAN_UNITS_JSON: JSON.stringify(UNITS),
    ...over,
  } as Record<string, string | undefined>;
}

export interface Harness {
  fake: FakeLiara;
  store: LiveStore;
  svc: LiveDeploymentService;
  clk: { now: () => number; advance: (ms: number) => number };
  runId: string;
  zip: Buffer;
  sleeps: number[];
  rebuild: (over?: Partial<LiveServiceOptions>) => LiveDeploymentService;
}

export async function harness(o: { env?: Record<string, string | undefined>; store?: LiveStore; zip?: Buffer; noTransport?: boolean; fake?: FakeLiara; poll?: Partial<{ verifyBudgetMs: number; pollIntervalMs: number }>; probe?: LiveServiceOptions["probe"]; owner?: string; cli?: LiveServiceOptions["cliBackend"] } = {}): Promise<Harness> {
  const fake = o.fake ?? new FakeLiara();
  const store = o.store ?? new MemoryLiveStore();
  let t = NOW;
  const clk = { now: () => t, advance: (ms: number) => (t += ms) };
  const sleeps: number[] = [];
  const zip = o.zip ?? demoZip();
  // a Phase 1E deployment run (static analysis of the demo ZIP) lives in the same store
  const agent = new AgentRunManager({ svc: mockSvc(), store, provider: new MockDiagnosticLLMProvider("ok"), now: clk.now, quotaPerWindow: 99 });
  const up = await agent.receiveProject({ sessionId: o.owner ?? OWNER, archive: zip, filename: "demo.zip" });
  const cfg = makeConfig(liveEnv(o.env));
  const opts = (over: Partial<LiveServiceOptions> = {}): LiveServiceOptions => ({
    cfg,
    store,
    reader: fake.reader,
    transport: o.noTransport ? null : fake.transport,
    cliBackend: o.cli ?? null,
    now: clk.now,
    sleep: async (ms) => void (sleeps.push(ms), clk.advance(ms)),
    executor: { verifyBudgetMs: 60_000, pollIntervalMs: 1000, reconcileAttempts: 2, reconcileDelayMs: 10, ...o.poll },
    probe: o.probe ?? (async () => fake.probeResult),
    ...over,
  });
  return { fake, store, svc: new LiveDeploymentService(opts()), clk, runId: up.runId, zip, sleeps, rebuild: (over) => new LiveDeploymentService(opts(over)) };
}

export const PROPOSE = { planId: "g2-small", appName: "liara-agent-demo" };
export async function propose(h: Harness, over: Partial<{ planId: string; appName: string; bundlePlanId: string | null; zip: Buffer; runId: string }> = {}, session = OWNER) {
  return h.svc.createProposal(session, { runId: over.runId ?? h.runId, planId: over.planId ?? PROPOSE.planId, bundlePlanId: over.bundlePlanId ?? null, appName: over.appName ?? PROPOSE.appName, zip: over.zip ?? h.zip });
}
export async function approved(h: Harness) {
  const v = await propose(h);
  const d = await h.svc.decide(v.proposal.id, OWNER, { decision: "approve", digest: v.proposal.digest, confirmAppName: v.proposal.appName, acknowledgeFinancial: true });
  return d;
}
/** waits for the background executor to leave every in-flight state */
export async function settle(h: Harness, opId: string, session = OWNER) {
  for (let i = 0; i < 400; i++) {
    const op = await h.svc.getOperation(opId, session);
    if (!["APPROVED", "CREATING_APPLICATION", "APPLICATION_CREATED", "UPLOADING_SOURCE", "SOURCE_UPLOADED", "CREATING_RELEASE", "RELEASE_CREATED", "VERIFYING_DEPLOYMENT"].includes(op.state) && !h.svc.executor?.isRunning(opId)) return op;
    await new Promise((r) => setTimeout(r, 5));
  }
  throw new Error("operation did not settle");
}
export async function deploy(h: Harness) {
  const v = await approved(h);
  const op = await h.svc.execute(v.proposal.id, OWNER, h.zip);
  return { v, op, final: await settle(h, op.id) };
}
