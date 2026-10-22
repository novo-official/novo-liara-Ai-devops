# Approval Workflow (Phase 1D)

> A human decision can only ever authorise a **simulation** in this release. "Approved" never means "executed": the UI, the audit log and the stored result all say
> that the real operation was **not** performed. Live validation is pending; real mutations are disabled.

## 1. Risk classes and policy table (`policy.ts`)

| Class | Meaning | Operations | Confirmation | Window |
|---|---|---|---|---|
| R0 | read-only | all agent tools | none | — |
| R1 | reversible/low impact | `restart_app`, `start_app` | click | 10 min |
| R2 | high impact | `stop_app`, `change_plan`, `update_env`, `deploy_release` | **type the exact app name** | 5 min |
| R3 | destructive | `delete_resource` | **denied** — can never be proposed or approved | — |

The table is authoritative: a proposal's *declared* risk, confirmation, mode and params are re-validated against it (strict per-operation zod schemas; extra keys rejected;
`update_env` carries key names only, `valuesSource: "operator_out_of_band"`). A declared risk can never lower the table risk.

## 2. Proposal (immutable, server-generated)

Built only from a report recommendation that has a typed `operation` and passes the policy. Fields: id, run, conversation, **exact app**, operation, params, risk,
`executionMode:"simulation"`, recommendation + evidence ids, **state fingerprint**, Persian description / impact / downtime / preconditions / verification plan,
confirmation kind, created/expires timestamps and a **SHA-256 digest over the canonical JSON of every immutable field** (key-sorted, evidence ids sorted).
Changing any field — app, params, risk, mode, texts, expiry, fingerprint — changes the digest (unit-tested field by field).

## 3. Lifecycle

`PENDING → APPROVED → SIMULATED_OK | SIMULATED_FAILED | VERIFICATION_FAILED` · `PENDING → REJECTED | EXPIRED | CANCELLED | BLOCKED`.
Only `PENDING` can change; every change is an atomic compare-and-set in the store (`transitionProposal`), so exactly one decider wins.

## 4. Server-side decision validation (`manager.decide`)

The request body is `{ decision: "approve"|"reject", digest, confirmAppName? }` and is **strict** — a client `approved: true` is a 400 and is never read.
The server loads the stored proposal and checks, in order:

1. `decision` is exactly `approve` or `reject`; `digest` is 64 lowercase hex.
2. **Actor binding / ownership**: the proposal and its run belong to this session (HMAC-pseudonymised owner), and the run's app equals the proposal's app (**cross-app prevention**). Others get `not_found` (no oracle).
3. **Not already decided** (replay → `already_decided`, audited).
4. **Expiry** against the server clock (exactly-once `EXPIRED`, branch closed, message posted once).
5. **Stored-row integrity**: recompute the digest of the stored content; mismatch ⇒ `BLOCKED` + `proposal_tampered`.
6. **Presented digest** equals the stored digest. A wrong digest leaves the proposal `PENDING` (it cannot burn or authorise anything).
7. **Policy re-evaluation** (operation, risk, mode, allowlist, confirmation, params); failure ⇒ `BLOCKED`.
8. Rejection is performed here (always allowed after the checks above).
9. Approval additionally needs the **typed app name** for R2 and a matching **state fingerprint** (read-only probe of scale/status/plan/runtime/current release).
   Drift or an unobservable state ⇒ `BLOCKED` (fail closed).
10. **Atomic PENDING→APPROVED claim.** Only the winner proceeds to the simulator; losers get `already_decided`/`expired`.

LLM or chat text cannot approve: the parser refuses approval phrases/`approved=true`, and there is no code path from a message to `decide`.
Tested: forged/short/uppercase digests, replay ×3, 8 concurrent approvals (exactly 1 wins), approve-vs-reject race, expiry racing the decision, tampered rows
(app/operation/params/risk/mode/expiry/text), recomputed-digest forgery, two managers on one SQLite file, drift, unobservable state, wrong typed names.

## 5. Simulation boundary

`ExecutionBackend.kind` is the literal `"simulation"`. `simulator.ts` imports nothing from the Liara layer, performs no I/O and has no fetch/fs/process access
(statically asserted). Results are deterministic and synthetic: `ok`, `operation_failure`, `verification_failure`, each stamped `simulated:true` with
"شبیه‌سازی — هیچ عملیات واقعی انجام نشد و هیچ درخواست نوشتنی به لیارا ارسال نشد". The Liara transport interface exposes only `get`; a recording transport proves that the entire
investigate → propose → approve → simulate flow reaches only read endpoints.

## 6. Audit behaviour

Hash-chained rows (`agent.*`): `conversation_created`, `intent_parsed`, `run_created`, `transition`, `tool_call`, `run_finished`, `proposal_created`, `proposal_approved`,
`proposal_rejected`, `proposal_expired`, `proposal_blocked_policy`, `proposal_blocked_drift`, `proposal_tampered`, `digest_mismatch`, `decision_replayed`, `simulation_completed`.
Rows hold ids, short digest prefixes and pseudonymous actors — never full session ids, secrets or raw upstream bodies. **Limit:** the chain is not fully tamper-proof (see `AGENT_ORCHESTRATION.md` §8).

## 7. UI

Inline proposal card + native `<dialog>` (focus trap, Esc closes, focus returns to the opener) showing action, app, operation, risk, expiry with a live countdown, impact, downtime,
parameters (JSON), preconditions, verification plan, the digest and a **"simulated test"** notice. The result view separates *plan created · approved · simulation completed/failed ·
verification passed/failed · real operation not executed*. The countdown is cosmetic; the server clock decides.

## 8. Known gaps

Single shared operator identity (actor binding is per session, not per person); drift fingerprint is coarse; expiry is lazy; the digest protects integrity, not confidentiality.

## 9. Phase 1E: `first_deploy`

A new R2 operation (typed app name, **15-minute** window) for the first-deployment plan; its parameters are a strict schema (`src/server/deploy/params.ts`) and the target must be a **new** valid name that does not already exist (`target_app_exists`).
It goes through exactly the same `decide()` checks. Approval records now carry `scope: "simulation"`, and `authorizeLiveExecution` refuses every request, so a simulated approval can never authorise a live action (`DEPLOYMENT_EXECUTION_CONTRACT.md`).
A newer plan supersedes (cancels) an open one; changing a checklist decision is blocked while a plan is open, and the decisions are part of the drift fingerprint.
