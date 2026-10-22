import { describe, expect, it } from "vitest";
import { artifactState, artifactUsable, formatBytes, sha256Hex } from "@/lib/artifact-binding";
import { nextAction, stages, type NextActionInput } from "@/lib/live-next-action";
import { liveUi } from "@/i18n/live-fa";

const base: NextActionInput = {
  mode: "live_disabled", readinessOk: true, runBlockers: [], artifact: "match", hasTargets: true, targetName: "liara-agent-demo", targetReady: true, targetBlocked: [],
  backendReady: false, backendBlockers: ["live_flag", "contract_attested"], preview: "none", previewExecutionBlockers: [], proposal: null, opState: null,
};
const act = (o: Partial<NextActionInput>) => nextAction({ ...base, ...o });

describe("next action for the existing-app path (one answer, strict priority)", () => {
  it("walks the happy path in order: choose ZIP → wait → preview → operator step (live closed) → request → approve → execute → done", () => {
    expect(act({ artifact: "none" }).id).toBe("choose_zip");
    expect(act({ artifact: "hashing" }).id).toBe("wait_hash");
    expect(act({ artifact: "mismatch" }).id).toBe("fix_zip");
    expect(act({}).id).toBe("run_preview");
    expect(act({ preview: "stale" }).id).toBe("run_preview");
    expect(act({ preview: "busy" }).id).toBe("wait_hash");
    const closed = act({ preview: "ok", previewExecutionBlockers: ["live_flag", "contract_attested"] });
    expect(closed).toMatchObject({ id: "operator_enable_live", tone: "blocked" });
    expect(closed.operatorBlockers).toEqual(["live_flag", "contract_attested"]); // deduplicated, in order
    expect(act({ preview: "ok", mode: "live_enabled", backendReady: true, backendBlockers: [] }).id).toBe("create_request");
    expect(act({ proposal: "PENDING" }).id).toBe("approve_pending");
    expect(act({ proposal: "APPROVED" }).id).toBe("execute_approved");
    expect(act({ opState: "VERIFYING_DEPLOYMENT" }).id).toBe("wait_in_progress");
    expect(act({ opState: "DEPLOYED" })).toMatchObject({ id: "done_verified", tone: "done" });
    expect(act({ opState: "NEEDS_OPERATOR_REVIEW" }).id).toBe("review_failure");
  });
  it("source blockers come before anything else about the file or target; a target problem comes before the preview", () => {
    expect(act({ readinessOk: false, artifact: "none" }).id).toBe("fix_source");
    expect(act({ runBlockers: ["environment_values_entry_not_supported_in_phase_2a"] }).id).toBe("fix_source");
    expect(act({ targetReady: false, targetBlocked: ["domain_suffix_expected"] })).toMatchObject({ id: "fix_target", operatorBlockers: ["domain_suffix_expected"] });
    expect(act({ hasTargets: false, targetName: null }).id).toBe("choose_target");
  });
  it("an approved proposal can only be executed with the SAME selected file; a missing or different file blocks it", () => {
    expect(act({ proposal: "APPROVED", artifact: "none" }).id).toBe("choose_zip");
    expect(act({ proposal: "APPROVED", artifact: "mismatch" }).id).toBe("fix_zip");
    expect(act({ proposal: "APPROVED", artifact: "unverifiable" }).id).toBe("execute_approved"); // the server re-hashes anyway
  });
  it("live disabled never offers 'create request'; every state has Persian text; every operator blocker has a step text", () => {
    for (const mode of ["simulation", "live_disabled"] as const) expect(act({ mode, preview: "ok", backendReady: true, backendBlockers: [] }).id).not.toBe("create_request");
    for (const id of ["wait_in_progress", "done_verified", "review_failure", "execute_approved", "approve_pending", "fix_source", "choose_zip", "wait_hash", "fix_zip", "choose_target", "fix_target", "run_preview", "operator_enable_live", "create_request"]) {
      expect(liveUi.flow.next[id], id).toBeTruthy();
      expect(liveUi.flow.next[id]!.detail).toMatch(/[؀-ۿ]/);
    }
    for (const id of ["live_flag", "contract_attested", "data_source_live", "token", "app_domain_suffix", "health_marker", "write_transport", "cli_backend_enabled", "cli_identity_verified"]) expect(liveUi.flow.operatorSteps[id], id).toBeTruthy();
  });
});

describe("stage stepper", () => {
  const st = (o: Partial<NextActionInput>) => Object.fromEntries(stages({ ...base, ...o }).map((s) => [s.id, s.state]));
  it("first unfinished stage is current; later ones are todo", () => {
    expect(st({ artifact: "none" })).toEqual({ analysis: "done", source_target: "current", preview: "todo", approval: "todo", execution: "todo" });
    expect(st({ preview: "ok" })).toEqual({ analysis: "done", source_target: "done", preview: "done", approval: "current", execution: "todo" });
  });
  it("blocked stages are marked as such (bad source, wrong file, unready target, failed operation)", () => {
    expect(st({ readinessOk: false }).analysis).toBe("blocked");
    expect(st({ artifact: "mismatch" }).source_target).toBe("blocked");
    expect(st({ targetReady: false }).source_target).toBe("blocked");
    expect(st({ preview: "ok", proposal: "APPROVED", opState: "FAILED" }).execution).toBe("blocked");
  });
  it("a verified deployment completes every stage", () => {
    expect(Object.values(st({ preview: "ok", proposal: null, opState: "DEPLOYED" }))).toEqual(["done", "done", "done", "done", "done"]);
  });
});

describe("client-side artifact binding helpers", () => {
  const file = { size: 10 };
  it("compares against the analysed 32-hex prefix; hashing / unverifiable are distinct states", () => {
    const sha = "ab12".repeat(16);
    expect(artifactState(null, null, sha.slice(0, 32))).toBe("none");
    expect(artifactState(file, null, sha.slice(0, 32))).toBe("hashing");
    expect(artifactState(file, { sha256: sha }, sha.slice(0, 32))).toBe("match");
    expect(artifactState(file, { sha256: sha }, "0".repeat(32))).toBe("mismatch");
    expect(artifactState(file, { sha256: null }, sha.slice(0, 32))).toBe("unverifiable");
    expect(["none", "hashing", "mismatch"].map((s) => artifactUsable(s as never))).toEqual([false, false, false]);
    expect(artifactUsable("match") && artifactUsable("unverifiable")).toBe(true);
  });
  it("sha256Hex equals the Node digest and formatBytes is stable", async () => {
    const bytes = new Uint8Array([1, 2, 3, 4, 5]);
    const { createHash } = await import("node:crypto");
    expect(await sha256Hex(new Blob([bytes]))).toBe(createHash("sha256").update(bytes).digest("hex"));
    expect(formatBytes(12)).toBe("12 B");
    expect(formatBytes(2048)).toBe("2.0 KB");
    expect(formatBytes(3 * 1024 * 1024)).toBe("3.0 MB");
  });
});
