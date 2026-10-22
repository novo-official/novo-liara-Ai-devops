import { readFileSync, readdirSync, statSync } from "node:fs";
import path from "node:path";
import { describe, expect, it } from "vitest";
import { canonicalJson, contentOf, digestsEqual, evaluateProposal, OPERATION_POLICY, proposalDigest, type ProposalSpec } from "@/server/agent/policy";
import { defaultScenario, NOT_REAL_FA, simulate } from "@/server/agent/simulation/simulator";
import { SimulatedExecutionBackend } from "@/server/agent/simulation/backend";
import { OPERATIONS, type ActionProposal } from "@/server/agent/types";

const allow = (app: string) => ["demo-api", "demo-oom"].includes(app);
const spec = (o: Partial<ProposalSpec> = {}): ProposalSpec => ({ app: "demo-api", operation: "restart_app", params: {}, risk: "R1", executionMode: "simulation", confirmation: "click", ...o });

function proposal(o: Partial<ActionProposal> = {}): ActionProposal {
  return {
    id: "prop_20260102040000_aabbccdd", runId: "run_x", conversationId: "conv_x", app: "demo-api", operation: "restart_app", params: {}, risk: "R1", executionMode: "simulation",
    recommendationId: "rec1", relatedDiagnosis: "d1", evidenceIds: ["ev2", "ev1"], stateFingerprint: "a".repeat(64), descriptionFa: "d", impactFa: "i", downtimeFa: "t", preconditionsFa: ["p"], verificationPlanFa: ["v"],
    confirmation: "click", createdAt: "2026-01-02T04:00:00.000Z", expiresAt: "2026-01-02T04:10:00.000Z", digest: "", status: "PENDING", ...o,
  };
}
const withDigest = (p: ActionProposal): ActionProposal => ({ ...p, digest: proposalDigest(contentOf(p)) });

describe("policy table", () => {
  it("every operation has a policy and risks are exactly R1/R2/R3", () => {
    for (const op of OPERATIONS) expect(["R1", "R2", "R3"]).toContain(OPERATION_POLICY[op].risk);
    expect(OPERATION_POLICY.restart_app.risk).toBe("R1");
    expect(OPERATION_POLICY.stop_app.risk).toBe("R2");
    expect(OPERATION_POLICY.delete_resource.risk).toBe("R3");
  });
  it("R2 requires the typed app name, R1 a click, R3 is denied", () => {
    expect(OPERATION_POLICY.change_plan.confirmation).toBe("type_app_name");
    expect(OPERATION_POLICY.update_env.confirmation).toBe("type_app_name");
    expect(OPERATION_POLICY.restart_app.confirmation).toBe("click");
    expect(OPERATION_POLICY.delete_resource.confirmation).toBe("denied");
  });
  it("R2 windows are shorter than R1 windows", () => {
    expect(OPERATION_POLICY.change_plan.ttlSec).toBeLessThan(OPERATION_POLICY.restart_app.ttlSec);
  });
});

describe("evaluateProposal", () => {
  it("accepts a well-formed simulated R1 proposal", () => {
    expect(evaluateProposal(spec(), allow)).toMatchObject({ ok: true });
  });
  it("denies unknown operations (including prototype keys)", () => {
    for (const op of ["format_disk", "__proto__", "constructor", "toString", ""]) expect(evaluateProposal(spec({ operation: op }), allow)).toMatchObject({ ok: false, code: "unknown_operation" });
  });
  it("R3 is always denied", () => {
    expect(evaluateProposal(spec({ operation: "delete_resource", risk: "R3", confirmation: "denied", params: { resourceKind: "app", resourceName: "demo-api" } }), allow)).toMatchObject({ ok: false, code: "operation_denied_r3" });
  });
  it("only simulation execution mode passes", () => {
    for (const m of ["live", "real", "execute", "", "SIMULATION"]) expect(evaluateProposal(spec({ executionMode: m }), allow)).toMatchObject({ ok: false, code: "execution_mode_not_simulation" });
  });
  it("apps outside the allowlist are denied", () => {
    expect(evaluateProposal(spec({ app: "secret-internal-app" }), allow)).toMatchObject({ ok: false, code: "app_not_allowed" });
  });
  it("a declared risk can never lower the table risk", () => {
    expect(evaluateProposal(spec({ operation: "stop_app", risk: "R1", confirmation: "click" }), allow)).toMatchObject({ ok: false, code: "risk_mismatch" });
    expect(evaluateProposal(spec({ operation: "change_plan", risk: "R0", params: { direction: "increase", targetPlanId: null }, confirmation: "type_app_name" }), allow)).toMatchObject({ ok: false });
  });
  it("a weaker confirmation is denied", () => {
    expect(evaluateProposal(spec({ operation: "stop_app", risk: "R2", confirmation: "click" }), allow)).toMatchObject({ ok: false, code: "confirmation_mismatch" });
  });
  it("params are strict: extra keys, wrong types and secrets-looking env names are rejected", () => {
    expect(evaluateProposal(spec({ params: { force: true } }), allow)).toMatchObject({ ok: false, code: "invalid_params" });
    const env = (keys: unknown) => spec({ operation: "update_env", risk: "R2", confirmation: "type_app_name", params: { keys, valuesSource: "operator_out_of_band" } });
    expect(evaluateProposal(env(["DATABASE_URL"]), allow)).toMatchObject({ ok: true });
    expect(evaluateProposal(env(["bad key"]), allow)).toMatchObject({ ok: false, code: "invalid_params" });
    expect(evaluateProposal(env([]), allow)).toMatchObject({ ok: false });
    expect(evaluateProposal({ ...env(["A"]), params: { keys: ["A"], valuesSource: "operator_out_of_band", values: { A: "x" } } }, allow)).toMatchObject({ ok: false, code: "invalid_params" });
  });
});

describe("digest", () => {
  it("canonical JSON is key-order independent", () => {
    expect(canonicalJson({ b: 1, a: [{ d: 1, c: 2 }] })).toBe(canonicalJson({ a: [{ c: 2, d: 1 }], b: 1 }));
  });
  it("is stable and 64 hex", () => {
    const p = proposal();
    expect(proposalDigest(contentOf(p))).toMatch(/^[0-9a-f]{64}$/);
    expect(proposalDigest(contentOf(p))).toBe(proposalDigest(contentOf(proposal())));
  });
  it("is independent of evidence id order", () => {
    expect(proposalDigest(contentOf(proposal({ evidenceIds: ["a", "b"] })))).toBe(proposalDigest(contentOf(proposal({ evidenceIds: ["b", "a"] }))));
  });
  it("any change to an immutable field changes the digest", () => {
    const base = proposalDigest(contentOf(proposal()));
    const variants: Partial<ActionProposal>[] = [
      { app: "demo-oom" }, { operation: "stop_app" }, { params: { x: 1 } }, { risk: "R2" }, { stateFingerprint: "b".repeat(64) }, { expiresAt: "2026-01-02T05:00:00.000Z" }, { createdAt: "2026-01-02T03:00:00.000Z" },
      { descriptionFa: "other" }, { impactFa: "other" }, { downtimeFa: "other" }, { preconditionsFa: [] }, { verificationPlanFa: [] }, { confirmation: "type_app_name" }, { recommendationId: "r2" }, { runId: "run_y" }, { conversationId: "c2" }, { evidenceIds: ["x"] },
    ];
    for (const v of variants) expect(proposalDigest(contentOf(proposal(v))), JSON.stringify(v)).not.toBe(base);
  });
  it("status and digest themselves are not part of the digest input", () => {
    expect(proposalDigest(contentOf(proposal({ status: "APPROVED", digest: "zzz" })))).toBe(proposalDigest(contentOf(proposal())));
  });
  it("digestsEqual is exact and length safe", () => {
    expect(digestsEqual("a", "a")).toBe(true);
    expect(digestsEqual("a", "b")).toBe(false);
    expect(digestsEqual("a", "aa")).toBe(false);
  });
});

describe("simulator", () => {
  const p = withDigest(proposal());
  it("is deterministic per scenario and always stamped simulated", () => {
    for (const s of ["ok", "operation_failure", "verification_failure"] as const) {
      const r = simulate(p, s, "2026-01-02T04:00:00.000Z");
      expect(r.simulated).toBe(true);
      expect(r.noteFa).toBe(NOT_REAL_FA);
      expect(r).toEqual(simulate(p, s, "2026-01-02T04:00:00.000Z"));
    }
  });
  it("ok scenario succeeds with passing synthetic verification", () => {
    const r = simulate(p, "ok", "t");
    expect(r.outcome).toBe("succeeded");
    expect(r.verification?.outcome).toBe("success");
    expect(r.verification?.criteria.every((c) => c.passed)).toBe(true);
  });
  it("operation_failure fails and does not run verification", () => {
    const r = simulate(p, "operation_failure", "t");
    expect(r.outcome).toBe("failed");
    expect(r.verification?.outcome).toBe("not_run");
    expect(r.steps.at(-1)?.status).toBe("failed");
  });
  it("verification_failure completes the operation but fails verification", () => {
    const r = simulate(p, "verification_failure", "t");
    expect(r.outcome).toBe("succeeded");
    expect(r.verification?.outcome).toBe("failure");
    expect(r.verification?.criteria.some((c) => !c.passed)).toBe(true);
  });
  it("default scenario mapping is deterministic", () => {
    expect(defaultScenario({ app: "demo-conflict", operation: "restart_app" })).toBe("verification_failure");
    expect(defaultScenario({ app: "demo-oom", operation: "change_plan" })).toBe("operation_failure");
    expect(defaultScenario({ app: "demo-api", operation: "restart_app" })).toBe("ok");
  });
  it("backend kind is simulation and executes without side effects", async () => {
    const b = new SimulatedExecutionBackend();
    expect(b.kind).toBe("simulation");
    expect((await b.execute(p, "t")).simulated).toBe(true);
  });
  it("result never claims real execution (no 'real operation performed' wording)", () => {
    const txt = JSON.stringify(simulate(p, "ok", "t"));
    expect(txt).toContain("هیچ عملیات واقعی انجام نشد");
  });
});

describe("static proof: the simulation module is isolated", () => {
  const dir = path.resolve(__dirname, "../../src/server/agent/simulation");
  const files = readdirSync(dir).filter((f) => f.endsWith(".ts"));
  it("has files to scan", () => expect(files.length).toBeGreaterThanOrEqual(2));
  for (const f of files) {
    const src = readFileSync(path.join(dir, f), "utf8");
    it(`${f}: imports nothing from the Liara layer, network, fs or process APIs`, () => {
      const imports = [...src.matchAll(/from\s+["']([^"']+)["']/g)].map((m) => m[1]!);
      for (const i of imports) expect(i, `${f} imports ${i}`).toMatch(/^(\.\.?\/|\.\.\/types)/);
      expect(imports.some((i) => /liara|http|client|fetch|node:/.test(i))).toBe(false);
      expect(src).not.toMatch(/\bfetch\s*\(|XMLHttpRequest|child_process|node:|process\.env|require\(/);
    });
  }
  it("directory contains no subdirectories with hidden code", () => {
    for (const e of readdirSync(dir)) expect(statSync(path.join(dir, e)).isDirectory()).toBe(false);
  });
});
