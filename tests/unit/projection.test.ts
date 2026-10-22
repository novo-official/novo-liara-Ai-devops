import { beforeEach, describe, expect, it } from "vitest";
import {
  AppDetailResponse,
  AppListSchema,
  AppletsSchema,
  EventsSchema,
  LogsV1Schema,
  LogsV2Schema,
  MetricsSchema,
  ReleasesSchema,
  projectEvents,
  toIso,
} from "@/server/liara/schemas";
import { redactText } from "@/server/security/redact";
import { __resetSecretsForTests } from "@/server/security/secret";
import { assertNoCanary, CANARY } from "../helpers/canaries";
import { RAW } from "../helpers/live";

beforeEach(() => __resetSecretsForTests());

describe("safe-field projection (schema evolution cannot leak)", () => {
  it("drops unknown/sensitive fields everywhere, including ones added in the future", () => {
    const apps = AppListSchema.parse(RAW.apps);
    const detail = AppDetailResponse.parse(RAW.app("shop-api"));
    const applets = AppletsSchema.parse(RAW.applets);
    const releases = ReleasesSchema.parse(RAW.releases);
    const events = projectEvents(EventsSchema.parse(RAW.events).data, 50);
    for (const out of [apps, detail, applets, releases, events]) assertNoCanary(out);
    // And the allow-listed output has exactly the documented safe keys:
    expect(Object.keys(detail).sort()).toEqual(
      ["name", "platform", "status", "scale", "planId", "createdAt", "isDeployed", "defaultSubdomain", "zeroDowntime", "readOnlyRootFilesystem", "fixedIpStatus", "envKeys", "instanceId", "networkId"].sort(),
    );
  });

  it("property: random unknown keys injected at every level never appear in output", () => {
    const poison = (v: unknown, depth = 0): unknown => {
      if (Array.isArray(v)) return v.map((x) => poison(x, depth + 1));
      if (v && typeof v === "object") {
        const o: Record<string, unknown> = {};
        for (const [k, x] of Object.entries(v)) o[k] = poison(x, depth + 1);
        o[`zz_unknown_${depth}`] = CANARY.unknownField;
        o.password = CANARY.apiToken;
        o.value = CANARY.envValue;
        return o;
      }
      return v;
    };
    const outputs = [
      AppListSchema.parse(poison(RAW.apps)),
      AppDetailResponse.parse(poison(RAW.app("shop-api"))),
      AppletsSchema.parse(poison(RAW.applets)),
      ReleasesSchema.parse(poison(RAW.releases)),
      MetricsSchema.parse(poison(RAW.metrics)),
    ];
    for (const o of outputs) {
      assertNoCanary(o);
      expect(JSON.stringify(o)).not.toMatch(/zz_unknown/);
    }
  });

  it("never projects env values, only well-formed key names", () => {
    const d = AppDetailResponse.parse(RAW.app("shop-api"));
    expect(d.envKeys).toEqual([{ key: "DATABASE_URL", encrypted: false }]); // "bad key!" rejected
    expect(JSON.stringify(d)).not.toContain(CANARY.envValue);
  });

  it("registers env value digests so echoed values are masked in logs (values are not retained)", () => {
    AppDetailResponse.parse(RAW.app("shop-api"));
    const out = LogsV1Schema.parse([{ type: "stderr", datetime: "2026-01-02T03:04:05Z", message: `boom DATABASE_URL=${CANARY.envValue} end` }]);
    expect(out[0]!.message).not.toContain(CANARY.envValue);
  });

  it("does not project author identity, remotes or image names from releases", () => {
    const r = ReleasesSchema.parse(RAW.releases);
    const rel = r.releases!.items[0]!;
    expect(Object.keys(rel).sort()).toEqual(["branch", "commit", "createdAt", "finishedAt", "id", "message", "port", "sourceAvailable", "state", "tag", "type"].sort());
    expect(rel.commit).toBe("a1b2c3d4e5f6"); // shortened
  });
});

describe("redaction of user-controlled text inside projected fields", () => {
  it("masks secrets in logs, release messages, applet reasons and event text", () => {
    const secretLine = "connect postgres://u:SuperSecret123@db/x token=abc123456789xyz";
    const logs = LogsV1Schema.parse([{ type: "stderr", datetime: "2026-01-02T03:04:05Z", message: secretLine }]);
    const applets = AppletsSchema.parse({ applets: [{ id: "a", name: "n", state: "x", reason: secretLine }] });
    const rel = ReleasesSchema.parse({ releases: [{ _id: "r", gitInfo: { message: secretLine } }] });
    const ev = projectEvents([{ values: [["1767323045000000000", secretLine]] }], 10);
    const all = JSON.stringify([logs, applets, rel, ev]);
    expect(all).not.toMatch(/SuperSecret123|abc123456789xyz/);
  });

  it("strips ANSI/bidi tricks from log text and caps line length", () => {
    const logs = LogsV1Schema.parse([{ type: "stdout", datetime: "2026-01-02T03:04:05Z", message: "\u001b[31mred\u001b[0m‮" + "x".repeat(5000) }]);
    expect(logs[0]!.message.startsWith("red")).toBe(true);
    expect(logs[0]!.message).not.toMatch(/\u001b|‮/);
    expect(logs[0]!.message.length).toBeLessThanOrEqual(1000);
  });
});

describe("malformed and partial payloads", () => {
  it("skips malformed list items but counts them", () => {
    const r = AppListSchema.parse(RAW.apps);
    expect(r.projects.items.map((a) => a.name)).toEqual(["shop-api", "shop-web", "secret-internal-app"]);
    expect(r.projects.skipped).toBe(1);
  });

  it.each([null, "string", 42, [], { projects: "nope" }, { projects: null }])("rejects non-conforming list payload %j", (bad) => {
    expect(AppListSchema.safeParse(bad).success).toBe(false);
  });

  it("rejects an app detail without the expected envelope", () => {
    expect(AppDetailResponse.safeParse({ nope: 1 }).success).toBe(false);
    expect(AppDetailResponse.safeParse({ project: { project_id: 5 } }).success).toBe(false);
  });

  it("tolerates missing optional fields (missing release information)", () => {
    expect(ReleasesSchema.parse({})).toMatchObject({ total: null, currentRelease: null });
    const r = ReleasesSchema.parse({ releases: [{ _id: "r1" }] });
    expect(r.releases!.items[0]).toMatchObject({ id: "r1", tag: null, state: null, branch: null, commit: null, createdAt: null });
    expect(ReleasesSchema.parse({ releases: [] }).releases!.items).toEqual([]);
    expect(ReleasesSchema.parse({ releases: null }).releases).toBeNull();
  });

  it("handles empty / garbage metrics without inventing data", () => {
    expect(MetricsSchema.parse({ end: 1, result: [] }).series).toEqual([]);
    const m = MetricsSchema.parse({ result: [{ applet: "a", values: [[1767323040, "NaN"], [1767323040, "x"], ["bad", 1], [1], [1767323100, "0.5"], [1767323160, 0.7]] }, { nope: 1 }] });
    expect(m.series).toHaveLength(1);
    expect(m.series[0]!.points).toEqual([{ t: 1767323100, v: 0.5 }, { t: 1767323160, v: 0.7 }]);
  });

  it("bounds series count and points per series", () => {
    const values = Array.from({ length: 5000 }, (_, i) => [1767320000 + i * 10, String(i)]);
    const m = MetricsSchema.parse({ result: Array.from({ length: 30 }, (_, i) => ({ applet: `a${i}`, values })) });
    expect(m.series.length).toBeLessThanOrEqual(10);
    for (const s of m.series) expect(s.points.length).toBeLessThanOrEqual(240);
  });

  it("normalises epoch units to ISO and rejects absurd timestamps", () => {
    const iso = "2026-01-02T03:04:05.000Z";
    const s = Date.parse(iso) / 1000;
    expect(toIso(s)).toBe(iso);
    expect(toIso(s * 1000)).toBe(iso);
    expect(toIso(String(BigInt(Math.floor(s)) * 1_000_000_000n))).toBe(iso);
    expect(toIso("2026-01-02T03:04:05Z")).toBe(iso);
    expect(toIso("1999-01-01")).toBeNull();
    expect(toIso("not a date")).toBeNull();
    expect(toIso({})).toBeNull();
    expect(toIso("x".repeat(100))).toBeNull();
  });

  it("events: infers time only from a numeric first column and flags it; tolerates odd shapes", () => {
    const rows = projectEvents([{ values: [["1767323045000000000", "a"], ["no time here", "b"]] }, "garbage", { values: "nope" }], 10).rows;
    expect(rows.find((r) => r.text === "a")).toMatchObject({ timeInferred: true });
    expect(rows.find((r) => r.text.includes("no time here"))).toMatchObject({ time: null, timeInferred: false });
    expect(projectEvents([], 10)).toEqual({ rows: [], truncated: false });
  });

  it("v1 logs must be an array; v2 logs are parsed from the observed shape and sorted", () => {
    expect(LogsV1Schema.safeParse({ not: "array" }).success).toBe(false);
    const v2 = LogsV2Schema.parse({ data: [{ metaData: { releaseId: "r" }, values: [["1767323050000000000", "later"], ["1767323045000000000", "earlier"]] }, { values: [["bad"]] }] });
    expect(v2.map((l) => l.message)).toEqual(["earlier", "later"]);
    expect(LogsV2Schema.safeParse([]).success).toBe(false);
  });
});

describe("misc", () => {
  it("redactText export is idempotent", () => {
    const once = redactText("token=abcdefghijk123");
    expect(redactText(once)).toBe(once);
  });
});
