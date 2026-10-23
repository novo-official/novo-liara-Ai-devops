import { describe, expect, it } from "vitest";
import { toPublicLive } from "@/lib/live-public";

describe("toPublicLive", () => {
  it("drops ownerHash / actorHash and replaces teamId by teamScope, at any depth and inside arrays, without touching other fields", () => {
    const owner = "a".repeat(64);
    const out = toPublicLive({
      proposal: { id: "lprop_1", ownerHash: owner, teamId: "team_x", appName: "demo", nested: [{ actorHash: owner, ok: true }] },
      operation: { id: "lop_1", ownerHash: owner, teamId: null, state: "DEPLOYED" },
      mode: { teamId: "team_x", enabled: true },
    });
    expect(out).toEqual({
      proposal: { id: "lprop_1", teamScope: "team", appName: "demo", nested: [{ ok: true }] },
      operation: { id: "lop_1", teamScope: "personal", state: "DEPLOYED" },
      mode: { teamScope: "team", enabled: true },
    });
    expect(JSON.stringify(out)).not.toContain(owner);
    expect(JSON.stringify(out)).not.toContain("team_x");
  });
  it("passes primitives, null and records without those keys through unchanged, and does not mutate its input", () => {
    expect(toPublicLive(null)).toBeNull();
    expect(toPublicLive("x")).toBe("x");
    const input = { ownerHash: "h", list: [1, 2] };
    toPublicLive(input);
    expect(input).toEqual({ ownerHash: "h", list: [1, 2] });
  });
});
