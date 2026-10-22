import { describe, expect, it } from "vitest";
import { isLiveError } from "@/server/live/types";
import { harness, OWNER, propose, TEAM } from "../helpers/live-exec";

const code = async (p: Promise<unknown>) => {
  try {
    await p;
    return null;
  } catch (e) {
    return isLiveError(e) ? e.code : "other";
  }
};

/**
 * Phase 2C audit (still true): the CREATE flow (`createProposal`) supports only NEW applications. An application that already exists (for example one created by hand
 * in the console, such as `liara-agent-demo`) is never silently treated as new there. Phase 2D adds a SEPARATE, explicit operation kind for existing applications
 * (`createExistingProposal`, see live-existing-deploy.test.ts) that never sends a create request.
 */
describe("existing application: refused, never adopted, never re-created", () => {
  it("an application that already exists cannot be proposed: live_duplicate_app, zero writes", async () => {
    const h = await harness();
    h.fake.apps.add("liara-agent-demo"); // created manually in the console
    expect(await code(propose(h))).toBe("live_duplicate_app");
    expect(h.fake.calls).toEqual([]);
  });
  it("being on the allowlist does not turn an existing app into a deployable target", async () => {
    const h = await harness({ env: { LIARA_ALLOWED_APPS: "liara-agent-demo" } });
    h.fake.apps.add("liara-agent-demo");
    expect(await code(propose(h))).toBe("live_duplicate_app");
    expect(h.fake.calls).toEqual([]);
  });
  it("an existing app appearing AFTER the proposal blocks approval (drift) and execution; createApplication is never sent", async () => {
    const h = await harness();
    const v = await propose(h);
    h.fake.apps.add("liara-agent-demo");
    expect(await code(h.svc.decide(v.proposal.id, OWNER, { decision: "approve", digest: v.proposal.digest, confirmAppName: v.proposal.appName, acknowledgeFinancial: true }))).toBe("live_blocked_drift");
    expect(h.fake.calls).toEqual([]);
  });
  it("no scope is ever granted to a pre-existing application", async () => {
    const h = await harness();
    h.fake.apps.add("liara-agent-demo");
    await code(propose(h));
    expect(h.store.scopeHas(TEAM, "liara-agent-demo")).toBe(false);
  });
  it("the REST write surface is still exactly three typed methods; there is no 'adopt by renaming' path (an existing app is a different, explicit kind)", async () => {
    const x = await harness();
    expect(Object.keys(x.fake.transport).sort()).toEqual(["createApp", "createRelease", "uploadSource"]);
    expect(Object.getOwnPropertyNames(Object.getPrototypeOf(x.svc)).filter((k) => /adopt|attach|import|rename/i.test(k))).toEqual([]);
  });
});
