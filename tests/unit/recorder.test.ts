import { describe, expect, it } from "vitest";
import { APPROVED_FIELDS, assertSafeToWrite, Pseudonymizer, recordPayload, RecordingRefused, reviewManifest, validateRecordedSample } from "@/server/liara/recorder";
import { ENDPOINTS, type EndpointId } from "@/server/liara/endpoints";
import { assertNoCanary, CANARY } from "../helpers/canaries";
import { RAW } from "../helpers/live";

const ctx = () => ({ now: Date.UTC(2026, 0, 2, 4, 0, 0), pseudo: new Pseudonymizer() });

describe("fixture recorder (approved fields only)", () => {
  it("has an explicit approved-field spec for every readable endpoint", () => {
    expect(Object.keys(APPROVED_FIELDS).sort()).toEqual(Object.keys(ENDPOINTS).sort());
  });

  const payloads: Array<[EndpointId, unknown]> = [
    ["listApps", RAW.apps],
    ["getApp", RAW.app("shop-api")],
    ["getApplets", RAW.applets],
    ["getReleases", RAW.releases],
    ["getEvents", RAW.events],
    ["getLogsV1", RAW.logsV1],
    ["getMetricsCpu", RAW.metrics],
  ];

  it.each(payloads)("%s: unknown, sensitive and free-text fields never reach the recording", (id, raw) => {
    const out = recordPayload(id, raw, ctx());
    assertNoCanary(out);
    const s = JSON.stringify(out);
    expect(s).not.toMatch(/shop-api|shop-web|secret-internal-app/); // real names are pseudonymised
    expect(s).not.toMatch(/hello|Applet started|init"/); // free text is shape-only
  });

  it("records no env values, only pseudonymised key names and flags", () => {
    const out = recordPayload("getApp", RAW.app("shop-api"), ctx()) as { project: { envs: unknown[] } };
    expect(out.project.envs).toEqual([{ key: "ENV_KEY-1", encrypted: false }, { key: "ENV_KEY-2", encrypted: false }]);
  });

  it("pseudonyms are stable within a run and times become relative markers", () => {
    const c = ctx();
    const list = recordPayload("listApps", RAW.apps, c) as { projects: Array<{ project_id: string; created_at: string }> };
    const detail = recordPayload("getApp", RAW.app("shop-api"), c) as { project: { project_id: string } };
    expect(list.projects[0]!.project_id).toBe("app-1");
    expect(detail.project.project_id).toBe("app-1");
    expect(list.projects[0]!.created_at).toMatch(/^\$ago:\d+$/);
  });

  it("log/event content is reduced to shape (lengths / column counts)", () => {
    expect(recordPayload("getLogsV1", RAW.logsV1, ctx())).toEqual([{ type: "stdout", datetime: expect.stringMatching(/^\$ago:/), message: { type: "string", length: 5 } }]);
    expect(recordPayload("getEvents", RAW.events, ctx())).toEqual({ data: [{ values: { rows: 1, columns: [2] } }] });
  });

  it("redacts secret-looking text even inside approved scalar fields", () => {
    const out = recordPayload("listApps", { projects: [{ project_id: "a-b", status: `Bearer ${CANARY.token} token=abc123456789` }] }, ctx());
    expect(JSON.stringify(out)).not.toMatch(/CANARY|abc123456789/);
  });

  it("bounds array sizes", () => {
    const out = recordPayload("listApps", { projects: Array.from({ length: 500 }, (_, i) => ({ project_id: `app-${i}x` })) }, ctx()) as { projects: unknown[] };
    expect(out.projects.length).toBeLessThanOrEqual(20);
  });

  it("tolerates garbage payloads without throwing or leaking", () => {
    for (const bad of [null, "str", 5, [], { projects: "x" }, { projects: [null, 1, "x"] }]) {
      expect(() => recordPayload("listApps", bad, ctx())).not.toThrow();
    }
  });
});

describe("assertSafeToWrite", () => {
  it("refuses output containing the token, a JWT or a private key", () => {
    expect(() => assertSafeToWrite(`{"x":"${CANARY.token}"}`, [CANARY.token])).toThrow();
    expect(() => assertSafeToWrite(`{"x":"eyJhbGciOiJIUzI1NiJ9.abcdefgh.sig"}`, [])).toThrow();
    expect(() => assertSafeToWrite("-----BEGIN PRIVATE KEY-----", [])).toThrow();
    expect(() => assertSafeToWrite('{"ok":1}', [CANARY.token])).not.toThrow();
  });
});

describe("fail-closed validation of recorded samples", () => {
  const c = () => ({ now: Date.UTC(2026, 0, 2, 4, 0, 0), pseudo: new Pseudonymizer() });

  it("accepts sanitised output for every endpoint", () => {
    for (const [id, raw] of [["listApps", RAW.apps], ["getApp", RAW.app("shop-api")], ["getApplets", RAW.applets], ["getReleases", RAW.releases], ["getEvents", RAW.events], ["getLogsV1", RAW.logsV1], ["getMetricsCpu", RAW.metrics]] as const) {
      expect(() => validateRecordedSample(recordPayload(id, raw, c()))).not.toThrow();
    }
  });

  it("refuses sensitive-looking leaves instead of repairing them", () => {
    for (const bad of [
      { status: "postgres://u:p@db.internal/x" },
      { status: "10.0.0.5" },
      { status: "https://customer.example.com" },
      { status: "someone@example.com" },
      { status: "/home/alice/app" },
      { status: "x".repeat(61) },
      { "bad key": 1 },
    ]) {
      expect(() => validateRecordedSample(bad), JSON.stringify(bad)).toThrow(RecordingRefused);
    }
  });

  it("refuses an over-deep structure", () => {
    let o: Record<string, unknown> = { a: 1 };
    for (let i = 0; i < 15; i++) o = { n: o };
    expect(() => validateRecordedSample(o)).toThrow(RecordingRefused);
  });

  it("allows only markers, pseudonyms and clean short scalars", () => {
    expect(() => validateRecordedSample({ t: "$ago:3600", n: "app-1", s: "RUNNING", k: "ENV_KEY-12", ok: true, num: 3 })).not.toThrow();
  });

  it("writes a review manifest that says NOT PROMOTED", () => {
    const md = reviewManifest([{ id: "listApps", keys: ["projects"], bytes: 120 }], "2026-01-02T04:00:00.000Z");
    expect(md).toMatch(/NOT REVIEWED \/ NOT PROMOTED/);
    expect(md).toContain("listApps");
  });
});
