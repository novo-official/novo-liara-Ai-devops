import { createHash } from "node:crypto";
import { canonicalJson, digestsEqual } from "../agent/policy";
import type { LiveStore } from "./store";
import { LiveError, type LiveOperationRecord, type LiveProposal, type LiveProposalContent, type LiveState } from "./types";

/** The digest domain makes a live digest impossible to confuse with (or replay as) a simulation digest. */
export const LIVE_DIGEST_DOMAIN = "liara-live-deploy-v1";

export function contentOfLive(p: LiveProposal): LiveProposalContent {
  const { digest: _d, status: _s, ...rest } = p;
  void _d;
  void _s;
  return rest;
}
export function liveDigest(c: LiveProposalContent): string {
  return createHash("sha256").update(canonicalJson({ domain: LIVE_DIGEST_DOMAIN, ...c, envKeys: [...c.envKeys].sort() })).digest("hex");
}

export interface LiveGate {
  /** LIARA_LIVE_DEPLOY_ENABLED — necessary, NEVER sufficient */
  enabled: boolean;
  /** operator attested the CLI-observed write fields (Phase 2B verification) */
  contractAttested: boolean;
  /** operator supplied verified plan units + billing semantics */
  unitsVerified: boolean;
  networkId: string | null;
  teamId: string | null;
  /** Phase 2D: the CLI backend is configured (LIARA_CLI_ENABLED + pinned tool) — necessary for a `cli` operation, never sufficient */
  cliEnabled: boolean;
  /** Phase 2D: the identity of the pinned CLI as verified RIGHT NOW (entry hash + version); null = not verifiable */
  cliIdentity: { version: string; entrySha256: string } | null;
}

/**
 * Re-validated, SERVER-SIDE, immediately before EVERY mutating step. Everything is reloaded from storage; nothing is taken from the caller.
 * A flag alone never passes: the operation must also be bound (exact team, app, plan, network, artifact) to a live proposal whose stored digest still
 * matches its content, that was approved by the owner under the LIVE scope (never a simulation approval) and consumed exactly once.
 */
export async function assertStepAuthorized(store: LiveStore, op: LiveOperationRecord, gate: LiveGate, expected: LiveState): Promise<LiveProposal> {
  if (!gate.enabled) throw new LiveError("live_execution_disabled");
  const missing: string[] = [];
  if (op.kind === "create_new_app") {
    if (!gate.contractAttested) missing.push("contract_attestation");
    if (!gate.unitsVerified) missing.push("plan_units_and_billing_verified");
    if (!gate.networkId) missing.push("network_id");
  } else {
    // a release to an EXISTING app creates nothing: no plan units, no network. The REST backend still needs the attested CLI-only release fields; the CLI backend needs the pinned tool.
    if (op.backend === "api" && !gate.contractAttested) missing.push("contract_attestation");
    if (op.backend === "cli" && !gate.cliEnabled) missing.push("cli_backend_enabled");
    if (op.backend === "cli" && !gate.cliIdentity) missing.push("cli_identity_verified");
  }
  if (missing.length) throw new LiveError("live_prerequisite_missing", missing);

  const fresh = await store.getOperation(op.id);
  if (!fresh || fresh.state !== expected) throw new LiveError("live_invalid_state", [fresh?.state ?? "none", expected]);
  const p = await store.getLiveProposal(fresh.proposalId);
  if (!p) throw new LiveError("live_not_found");
  if (p.status !== "CONSUMED" || p.environment !== "live" || p.executionMode !== "live") throw new LiveError("live_not_approved");
  if (!digestsEqual(liveDigest(contentOfLive(p)), p.digest)) throw new LiveError("live_tampered");
  const approvals = await store.listLiveApprovals(p.id);
  const ok = approvals.find((a) => a.outcome === "accepted" && a.decision === "approve" && a.scope === "live" && a.operationId === fresh.id && p.digest.startsWith(a.digest12));
  if (!ok) throw new LiveError("live_not_approved");
  // exact bindings
  if (fresh.kind !== op.kind || fresh.backend !== op.backend || p.kind !== fresh.kind || p.backend !== fresh.backend) throw new LiveError("live_binding_mismatch", ["kind_or_backend"]);
  if (p.teamId !== gate.teamId || fresh.teamId !== gate.teamId || (p.kind === "create_new_app" && p.networkId !== gate.networkId)) throw new LiveError("live_binding_mismatch", ["team_or_network"]);
  if (p.backend === "cli" && (!p.cli || !gate.cliIdentity || p.cli.version !== gate.cliIdentity.version || p.cli.entrySha256 !== gate.cliIdentity.entrySha256)) throw new LiveError("live_binding_mismatch", ["cli_identity"]);
  if (fresh.appName !== p.appName || fresh.planId !== p.planId || fresh.platform !== p.platform || fresh.ownerHash !== p.ownerHash || fresh.id !== p.operationId) throw new LiveError("live_binding_mismatch", ["operation"]);
  if (ok.actorHash !== p.ownerHash) throw new LiveError("live_binding_mismatch", ["actor"]);
  return p;
}
