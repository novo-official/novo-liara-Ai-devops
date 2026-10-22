import { afterEach, describe, expect, it } from "vitest";
import {
  baselineVerification,
  capabilityReport,
  lastSuccessAt,
  recordOutcome,
  resetCapabilityState,
  verificationForError,
} from "@/server/liara/capabilities";
import { computeConnectivity, STALE_AFTER_SEC } from "@/server/liara/service";

afterEach(resetCapabilityState);

const live = { mode: "live" as const };
const get = (id: string, mode: "live" | "mock" = "live") => capabilityReport(mode, false).find((c) => c.id === id)!;

describe("verification status model", () => {
  it("starts from documented / CLI-only baselines, never LIVE_VERIFIED", () => {
    expect(baselineVerification("documented")).toBe("DOCUMENTED_UNVERIFIED");
    expect(baselineVerification("observed")).toBe("CLI_ONLY_UNVERIFIED");
    expect(get("getApp").verification).toBe("DOCUMENTED_UNVERIFIED");
    expect(get("getLogsV2").verification).toBe("CLI_ONLY_UNVERIFIED");
  });

  it("maps probe outcomes precisely — 401/403 is ACCESS_DENIED, never UNAVAILABLE", () => {
    expect(verificationForError("unauthorized")).toBe("ACCESS_DENIED");
    expect(verificationForError("forbidden")).toBe("ACCESS_DENIED");
    expect(verificationForError("not_found")).toBe("UNAVAILABLE");
    expect(verificationForError("contract_mismatch")).toBe("CONTRACT_MISMATCH");
    for (const inconclusive of ["timeout", "network", "upstream_error", "rate_limited", "response_too_large"]) {
      expect(verificationForError(inconclusive)).toBeNull();
    }
  });

  it("only explicit probes change the verification level", () => {
    recordOutcome("getApp", { ok: true }, live); // ordinary page load
    expect(get("getApp")).toMatchObject({ health: "ok", verification: "DOCUMENTED_UNVERIFIED" });
    recordOutcome("getApp", { ok: true }, { ...live, probe: true });
    expect(get("getApp")).toMatchObject({ health: "ok", verification: "LIVE_VERIFIED" });
    expect(get("getApp").verifiedAt).not.toBeNull();
  });

  it("probe failures record the right status; transport failures stay inconclusive", () => {
    recordOutcome("getEvents", { ok: false, code: "forbidden" }, { ...live, probe: true });
    expect(get("getEvents")).toMatchObject({ verification: "ACCESS_DENIED", health: "failing", lastErrorCode: "forbidden" });
    recordOutcome("getReleases", { ok: false, code: "not_found" }, { ...live, probe: true });
    expect(get("getReleases").verification).toBe("UNAVAILABLE");
    recordOutcome("getApplets", { ok: false, code: "contract_mismatch" }, { ...live, probe: true });
    expect(get("getApplets").verification).toBe("CONTRACT_MISMATCH");
    recordOutcome("getLogsV1", { ok: false, code: "timeout" }, { ...live, probe: true });
    expect(get("getLogsV1")).toMatchObject({ verification: "DOCUMENTED_UNVERIFIED", health: "failing" });
  });

  it("a later successful probe supersedes an earlier failure", () => {
    recordOutcome("getApp", { ok: false, code: "forbidden" }, { ...live, probe: true });
    recordOutcome("getApp", { ok: true }, { ...live, probe: true });
    expect(get("getApp")).toMatchObject({ verification: "LIVE_VERIFIED", health: "ok", lastErrorCode: null });
  });

  it("simulation can never produce evidence", () => {
    recordOutcome("getApp", { ok: true }, { mode: "mock", probe: true });
    expect(get("getApp", "mock")).toMatchObject({ verification: "DOCUMENTED_UNVERIFIED", health: "simulated" });
    expect(lastSuccessAt()).toBeNull();
    // and mock-mode reports ignore any stored live state
    recordOutcome("getApp", { ok: true }, { ...live, probe: true });
    expect(get("getApp", "mock").verification).toBe("DOCUMENTED_UNVERIFIED");
  });

  it("undocumented endpoints are disabled until explicitly enabled", () => {
    expect(capabilityReport("live", false).find((c) => c.id === "getLogsV2")!.health).toBe("disabled");
    expect(capabilityReport("live", true).find((c) => c.id === "getLogsV2")!.health).toBe("not_probed");
  });
});

describe("connection state classification", () => {
  const ok = (id: string, over: object = {}) => ({ id, endpoint: "", contract: "documented" as const, verification: "LIVE_VERIFIED" as const, health: "ok" as const, lastOkAt: "x", lastErrorCode: null, verifiedAt: "x", ...over });
  const bad = (id: string, code: string) => ok(id, { health: "failing", lastErrorCode: code, verification: "DOCUMENTED_UNVERIFIED" });
  const notProbed = (id: string) => ok(id, { health: "not_probed", lastOkAt: null, verification: "DOCUMENTED_UNVERIFIED" });

  it("mock is always simulated", () => {
    expect(computeConnectivity("mock", [ok("listApps")], 0).connectivity).toBe("simulated");
  });

  it.each([
    [[notProbed("listApps")], null, "unknown"],
    [[ok("listApps"), ok("getApp")], 10, "connected"],
    [[ok("listApps"), ok("getApp")], STALE_AFTER_SEC + 1, "stale"],
    [[ok("listApps"), bad("getLogsV1", "contract_mismatch")], 5, "degraded"],
    [[bad("listApps", "unauthorized")], null, "auth_failure"],
    [[bad("listApps", "forbidden")], null, "auth_failure"],
    [[bad("listApps", "not_found")], null, "endpoint_unavailable"],
    [[bad("listApps", "contract_mismatch")], null, "contract_mismatch"],
    [[bad("listApps", "timeout")], null, "unreachable"],
    [[bad("listApps", "network")], null, "unreachable"],
    [[bad("listApps", "upstream_error")], null, "unreachable"],
    [[bad("listApps", "rate_limited")], null, "unreachable"],
  ] as const)("%j (age %j) → %s", (caps, age, expected) => {
    expect(computeConnectivity("live", caps as never, age).connectivity).toBe(expected);
  });

  it("lists per-capability issues with their kind (403 is auth, not 'absent')", () => {
    const r = computeConnectivity("live", [ok("listApps"), bad("getEvents", "forbidden"), bad("getMetricsCpu", "not_found"), bad("getLogsV1", "contract_mismatch"), bad("getReleases", "timeout")] as never, 1);
    expect(r.connectivity).toBe("degraded");
    expect(Object.fromEntries(r.issues.map((i) => [i.capability, i.kind]))).toEqual({
      getEvents: "auth_failure",
      getMetricsCpu: "endpoint_unavailable",
      getLogsV1: "contract_mismatch",
      getReleases: "unreachable",
    });
  });
});
