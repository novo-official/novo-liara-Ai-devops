/**
 * E2E fixture (runs once, before the production server starts): writes the state of the real incident into the e2e database with the project's OWN state machine —
 * an operation for the mock target `demo-worker` that ended in NEEDS_OPERATOR_REVIEW after a 2xx upload answer whose sourceID could not be read, owned by a login
 * session that will never exist on the e2e server (the "old login"). Nothing here talks to a network: the transport and reader are the recording fakes.
 */
import { SqliteLiveStore } from "../../src/server/live/store";
import { harness, OWNER } from "../helpers/live-exec";

async function seed(dbPath: string, APP: string) {
  const h = await harness({ store: new SqliteLiveStore(dbPath), env: { LIARA_TEAM_ID: undefined }, owner: OWNER });
  h.fake.apps.add(APP);
  h.fake.scope.add(APP);
  h.fake.releaseIds.push("rel_old_1");
  h.fake.upload = "malformed";
  const v = await h.svc.createExistingProposal(OWNER, { runId: h.runId, appName: APP, backend: "api", zip: h.zip });
  await h.svc.decide(v.proposal.id, OWNER, { decision: "approve", digest: v.proposal.digest, confirmAppName: APP });
  const op = await h.svc.execute(v.proposal.id, OWNER, h.zip);
  for (let i = 0; i < 400; i++) {
    const cur = await h.svc.getOperation(op.id, OWNER);
    if (cur.state === "NEEDS_OPERATOR_REVIEW") {
      console.log(JSON.stringify({ seeded: op.id, state: cur.state, app: APP }));
      return;
    }
    await new Promise((r) => setTimeout(r, 5));
  }
  throw new Error("seed did not reach NEEDS_OPERATOR_REVIEW");
}

async function main() {
  const dbPath = process.env.DIAGNOSTICS_DB_PATH;
  if (!dbPath) throw new Error("DIAGNOSTICS_DB_PATH is required");
  // `demo-worker`: recovered for real by zz-lock-recovery.spec.ts · `demo-api`: left untouched; zz-result-persistence.spec.ts only STUBS the network answers for it
  // (one of the mock targets, but not the first one, so the other specs' default target is unaffected)
  await seed(dbPath, "demo-worker");
  await seed(dbPath, "demo-api");
}
main().then(() => process.exit(0), (e) => { console.error(e); process.exit(1); });
