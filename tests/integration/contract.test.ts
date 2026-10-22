import { existsSync, readdirSync, readFileSync } from "node:fs";
import path from "node:path";
import { describe, expect, it } from "vitest";
import { ENDPOINTS } from "@/server/liara/endpoints";
import { APPROVED_FIELDS, validateRecordedSample } from "@/server/liara/recorder";
import { AppDetailResponse, AppListSchema, AppletsSchema, EventsSchema, LogsV1Schema, LogsV2Schema, MetricsSchema, ReleasesSchema, projectEvents } from "@/server/liara/schemas";
import { buildService } from "@/server/liara/service";
import { __resetSecretsForTests } from "@/server/security/secret";
import { makeConfig, RAW } from "../helpers/live";

const ROOT = path.resolve(__dirname, "../..");

describe("contract regression: pinned spec vs endpoint registry", () => {
  const spec = readFileSync(path.join(ROOT, "docs/reference/openapi/paas.yaml"), "utf8");
  const meSpec = readFileSync(path.join(ROOT, "docs/reference/openapi/me.yaml"), "utf8");
  // paths under /v1/me* are documented in the pinned account spec (me.yaml), everything else in paas.yaml
  const billingSpec = readFileSync(path.join(ROOT, "docs/reference/openapi/billing.yaml"), "utf8");
  // paths under /v1/me* are documented in me.yaml, /v1/billing in billing.yaml (pinned in Phase 2B), everything else in paas.yaml
  const specFor = (p: string) => (p.startsWith("/v1/me") ? meSpec : p === "/v1/billing" ? billingSpec : spec);
  const inSpec = (p: string) => new RegExp(`^  ['"]?${p.replace(/[{}]/g, "\\$&")}['"]?:\\s*$`, "m").test(specFor(p));

  it("every DOCUMENTED endpoint exists in the pinned OpenAPI spec, with a GET operation", () => {
    for (const e of Object.values(ENDPOINTS).filter((x) => x.contract === "documented")) {
      expect(inSpec(e.path), e.path).toBe(true);
      const src = specFor(e.path);
      const block = src.slice(src.search(new RegExp(`^  ['"]?${e.path.replace(/[{}]/g, "\\$&")}['"]?:`, "m")));
      expect(block.slice(0, 200), e.path).toMatch(/^[^\n]*\n    get:/);
    }
  });

  it("every OBSERVED (CLI-only) endpoint is absent from the pinned spec — it must never be mistaken for documented", () => {
    for (const e of Object.values(ENDPOINTS).filter((x) => x.contract === "observed")) expect(inSpec(e.path), e.path).toBe(false);
  });

  it("the pinned billing.yaml documents GET /v1/billing with `user.balance` (number) and states NO unit", () => {
    const b = readFileSync(path.join(ROOT, "docs/reference/openapi/billing.yaml"), "utf8");
    expect(b).toContain("operationId: getBilling");
    expect(b).toMatch(/balance:\s*\n\s*type: number/);
    expect(b).not.toMatch(/toman|rial|IRT|IRR|currency/i); // the spec states no unit: a unit must never be assumed from it
  });

  it("the live write contract matches the official CLI facts reviewed in Phase 2B (create body, upload field, release body)", async () => {
    const { CreateAppRequestSchema, CreateReleaseRequestSchema } = await import("@/server/live/contract");
    expect(Object.keys(CreateAppRequestSchema.shape).sort()).toEqual(["bundlePlanID", "name", "network", "planID", "platform", "readOnlyRootFilesystem"]);
    // the CLI sends build.cache (default true) — NOT an empty build object
    expect(CreateReleaseRequestSchema.shape.build.parse({ cache: true })).toEqual({ cache: true });
    expect(CreateReleaseRequestSchema.shape.build.safeParse({ args: "x" }).success).toBe(false);
  });

  it("the log endpoint documents a required `since` query parameter (the v1/v2 discrepancy is real, not assumed)", () => {
    const i = spec.indexOf("operationId: getAppLogs");
    const block = spec.slice(i, i + 900);
    expect(block).toMatch(/name: since[\s\S]*required: true/);
  });
});

describe("contract regression: projections of canonical payloads are stable", () => {
  it("projection snapshot", () => {
    __resetSecretsForTests();
    const snapshot = {
      apps: AppListSchema.parse(RAW.apps),
      app: AppDetailResponse.parse(RAW.app("shop-api")),
      applets: AppletsSchema.parse(RAW.applets),
      releases: ReleasesSchema.parse(RAW.releases),
      events: projectEvents(EventsSchema.parse(RAW.events).data, 50),
      logsV1: LogsV1Schema.parse(RAW.logsV1),
      logsV2: LogsV2Schema.parse({ data: [{ metaData: { releaseId: "r1" }, values: [["1767323045000000000", "line"]] }] }),
      metrics: MetricsSchema.parse(RAW.metrics),
    };
    expect(snapshot).toMatchSnapshot();
  });
});

describe("contract regression: simulated fixtures conform to the production schemas", () => {
  it("every mock endpoint parses with zero skipped items and zero dropped points", async () => {
    const svc = buildService(makeConfig(), { now: () => Date.UTC(2026, 0, 2, 4, 0, 0) });
    const list = await svc.listApps();
    expect(list.ok && list.data.skipped).toBe(0);
    for (const a of list.ok ? list.data.items : []) {
      const [app, applets, rel, ev, logs, cpu, mem] = await Promise.all([
        svc.getApp(a.name), svc.getApplets(a.name), svc.getReleases(a.name), svc.getEvents(a.name, 60), svc.getLogs(a.name, 60), svc.getMetrics(a.name, "cpu", 60), svc.getMetrics(a.name, "memory", 60),
      ]);
      for (const s of [app, applets, rel, ev, logs, cpu, mem]) expect(s.ok, a.name).toBe(true);
      expect(applets.ok && applets.data.skipped).toBe(0);
      expect(rel.ok && rel.data.skipped).toBe(0);
      for (const m of [cpu, mem]) {
        expect(m.ok && m.data.droppedPoints).toBe(0);
        expect(m.ok && m.data.schema).not.toBe("unsupported");
      }
    }
  });

  it("the sparse/stale demo app really has a gap and a stale last observation", async () => {
    const svc = buildService(makeConfig(), { now: () => Date.UTC(2026, 0, 2, 4, 0, 0) });
    const cpu = await svc.getMetrics("demo-stale", "cpu", 60);
    expect(cpu.ok && cpu.data.series[0]!.gapsAfter.length).toBeGreaterThan(0);
    const last = cpu.ok ? cpu.data.series[0]!.lastObservation!.t : 0;
    expect(Date.UTC(2026, 0, 2, 4, 0, 0) / 1000 - last).toBeGreaterThan(2000); // ≈ 40 min old
  });
});

describe("reviewed live fixtures (promoted by a human only)", () => {
  const dir = path.join(ROOT, "fixtures/reviewed");
  const files = existsSync(dir) ? readdirSync(dir).filter((f) => f.endsWith(".json")) : [];

  it("the review directory exists and states that nothing has been promoted", () => {
    const readme = readFileSync(path.join(dir, "README.md"), "utf8");
    expect(readme).toMatch(/No fixtures have been promoted/);
  });

  it("no recorded (unreviewed) live data is committed under fixtures/mock or fixtures/reviewed unless documented in the README", () => {
    const readme = readFileSync(path.join(dir, "README.md"), "utf8");
    for (const f of files) expect(readme, `${f} lacks a review entry`).toContain(f);
    for (const f of readdirSync(path.join(ROOT, "fixtures/mock"))) expect(f.endsWith(".json")).toBe(true);
    expect(existsSync(path.join(ROOT, "fixtures/mock/verification-report.json"))).toBe(false);
  });

  it.each(files.length ? files : ["(none)"])("reviewed fixture %s has the approved structure and passes fail-closed validation", (f) => {
    if (f === "(none)") return expect(files).toEqual([]); // honest: nothing to replay yet
    const doc = JSON.parse(readFileSync(path.join(dir, f), "utf8")) as { _recorded: { endpoint: keyof typeof APPROVED_FIELDS }; sample: unknown };
    expect(Object.keys(APPROVED_FIELDS)).toContain(doc._recorded.endpoint);
    expect(() => validateRecordedSample(doc.sample)).not.toThrow();
  });
});
