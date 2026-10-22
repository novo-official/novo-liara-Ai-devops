# Deployment Execution Contract (original design — now IMPLEMENTED in Phase 2A/2B, never executed live)

> **Status (Phase 2B).** This document is the *design contract* written in Phase 1E (kept for history). The executor it describes **now exists** in `src/server/live/` (Phase 2A) and
> was hardened by the Phase 2B preflight; the **current, authoritative description is `LIVE_DEPLOYMENT_EXECUTOR.md`**. It has been tested only with a recording fake transport and has
> **never sent a write request to Liara**. Every behaviour below remains *unverified live* until Phase 2B's operator-run steps (`FIRST_REAL_DEPLOYMENT_CHECKLIST.md`) prove it.
> Corrections made by the Phase 2B review of the official CLI (commit `14ec35f`, 9.6.0) are listed at the end of this file.

## 1. Evidence classes

* **A** documented in the pinned `paas.yaml` (commit `338325a4`) · **B** observed only in the official CLI (not documentation) · **C** manual user action · **D** unavailable/unverified.
* The classification of each step lives in `src/server/deploy/strategy.ts` and is **verified by a test against the pinned OpenAPI**: every operation attributed to class A must exist in the spec; every operation labelled (B) must *not*.

| # | Step | Class | Operation / note | Risk |
|---|---|---|---|---|
| 1 | Select account/team | B + C | `teamID` query parameter only seen in the CLI | R0 |
| 2 | Check account readiness | C | no documented balance/credit endpoint; **charging is manual** | R0 |
| 3 | Choose platform | B | platform ids (`next`, `static`, …) seen in the CLI; spec has free `type` string | R0 |
| 4 | Recommend plan | D | `GET /v1/me` is free-form; units and prices unverified ⇒ preliminary guidance only | R0 |
| 5 | Create application | A (weak) | `POST /v1/projects`; no required fields; empty response ⇒ re-read `GET /v1/projects/{name}` | R2 |
| 6 | Configure env keys | A (weak) + C | `POST /v1/projects/update-envs` replaces the whole set and restarts (CLI-inferred); values entered by the operator out-of-band | R2 |
| 7 | Prepare artifact | B | archive creation by CLI; spec says ".gz file"; 256 MiB limit only in CLI | R0 |
| 8 | Upload source | A | `POST /v2/projects/{name}/sources` multipart `file` → `{sourceID}` | R2 |
| 9 | Create release | A (weak) | `POST /v2/projects/{name}/releases` `{sourceID, port, type}`; other fields CLI-only | R2 |
| 10 | Track build | A + B | releases list (A); `GET /v1/releases/{id}`, `GET /v2/releases/{id}/build-logs` (B) | R0 |
| 11 | Verify startup | A | applets, logs, app details (existing read-only tools) | R0 |
| 12 | Domain guidance | A + C | `POST /v1/domains`, `provision-ssl-certs`; **DNS change is manual** | R2 |
| 13 | Post-deployment checks | C | no external HTTP probe exists; no HTTP-status metrics in the API | R0 |

**Not assumed**: rollback, native GitHub integration, plan prices, balance reads, database creation through these APIs.
**GitHub Actions / CI** is a *separate* path: unverified in the pinned sources, never executed, no workflow or credential created here.

## 2. Preconditions for any live execution (all required, none exists)

1. A passing `verify:liara-readonly` run on a disposable allowlisted account, reviewed; open contract questions in the matrix answered (`teamID`, `since`, vocabularies, env masking, release `state` values, create-app required fields, release-create fields, archive format).
2. A **separate** `ExecutionBackend` class (kind `"live"`), behind a feature flag that is **off by default** and a **separate live policy**; the write-capable client is constructed only there. The Phase 1D static scans must be extended, not weakened.
3. **Fresh approval under the live policy**: new digest including `environment: "live"`, new typed confirmation, shorter expiry, per-person identity. A simulation approval is *never* accepted: `authorizeLiveExecution` already encodes this (`simulation_approval_not_valid_for_live`) and is tested to refuse every input.
4. **Artifact binding**: the plan's `artifactDigest` (and the full SHA-256) must match the bytes uploaded at execution time; the artifact is re-validated by the same ZIP/analysis pipeline, never trusted from the earlier run.
5. **Idempotency and recovery**: the API has no idempotency keys ⇒ local operation ids, a pre-create existence check, and a recovery routine after an interrupted multi-step run (partial app, uploaded-but-unreleased source). Failed steps must stop the run (as the simulator already does).
6. **Cost control**: the executor may never purchase, charge or change plans; app creation (billable) needs an explicit cost acknowledgement by the operator and a plan id taken from a **verified** catalogue.
7. **Verification**: post-action checks use read-only tools against live state (release state, applets, logs); success is claimed only from observed state, never from an API acknowledgement.
8. **Secrets**: env values go from the operator to Liara over a channel that never persists or logs them; the allowlist must be extended to permit *creating* a named app (today the allowlist only means "exists").
9. **Audit**: external anchoring of the hash chain; every live step recorded with its evidence class and result.
10. **Testing**: the whole adversarial suite (hostile ZIPs, injection, replay, tamper, drift) re-run against the live backend in a sandbox account; the zero-cost and no-network guards stay for everything else.

## 3. Boundaries enforced today

| Boundary | Enforcement |
|---|---|
| no write client | the Liara transport interface exposes only `get`; deploy modules import no Liara module (static scan) |
| no network in deploy code | static scan + global network guard in every test |
| simulator isolation | imports only `../agent/types` and `./params`; no I/O (static scan) |
| simulation ≠ live | `executionMode:"simulation"`, `environment:"simulation"`, `scope:"simulation"` approvals, live gate refuses all |
| no invented outputs | simulated results carry no URL and no release id (tested) |

## Phase 2A status update

The executor described above is now **implemented** (`src/server/live/`, see `LIVE_DEPLOYMENT_EXECUTOR.md`) but has never been executed against Liara; every test uses a recording fake transport. Request/response contracts, artifact format, approval binding, state machine, reconciliation and verification are specified there. The CLI-only fields remain unverified until Phase 2B.

## Phase 2B corrections and findings (current)

Verified against the official sources on 2026-10-22: `liara-cloud/openapi` HEAD is still `338325a4` (our pinned `paas.yaml` and `me.yaml` are **byte-identical** to upstream; `billing.yaml` is now pinned) and the official CLI (`liara-cloud/cli` master, 9.6.0).

| Topic | Finding | Evidence |
|---|---|---|
| Release body `build` | The CLI sends `build: {cache, args, dockerfile, location}`; `cache` defaults to **true** ⇒ wire value `{"cache":true}`. Phase 2A wrongly assumed `{}` (fixed in `contract.ts`). | CLI `deploy.ts` (`buildCache = !(no-cache \|\| build.cache === false)`) |
| Release body `platformConfig` | `config[platform] \|\| {}`; the CLI auto-detects a version only for node/python/php/dotnet/go — **not for `next`** ⇒ `{}` is correct for Next.js. | CLI `deploy.ts`, `get-platform-version.ts` |
| Other release fields | `gitInfo` (source deploys), `message`, `disks`, `envs`, `cron`, `args`, `healthCheck` are optional/undefined; this project omits them (unverified that omission is accepted). | CLI `deploy.ts` |
| Create URL | The CLI posts to `v1/projects/` (trailing slash); the OpenAPI path is `/v1/projects`. Which forms the server accepts is **unverified**. | CLI `app/create.ts`, `paas.yaml` |
| Team scoping | A `teamID` **query** parameter on every request (empty `teamID=` for personal accounts). The OpenAPI declares it only for the WebSocket; developer docs say only "send a teamID parameter". | CLI `base.ts` hook |
| Network | `network` is `network._id` from `GET v1/networks` (`{networks:[{_id,name,createdAt}]}`). The endpoint is **absent from every pinned spec** (CLI-only). The CLI exits with an error when the account has no network and `--network` is not given. Creating a network is `POST v1/networks` — this project never calls it. | CLI `network/list.ts`, `base.ts`, `network/create.ts` |
| Plan filter | `liara create` offers only plans that are `available`, region `iran`, and id `free` or containing `g2`; bundle plan is chosen from `projectBundlePlans[planID]`. | CLI `app/create.ts` |
| Status meanings | 402 = not enough balance; 403 body codes `free_plan_platform`/`free_plan_count`; deploy 400 `frozen_project`, 428 `max_deployment_count_in_day`, 413 source too large, 408 timeout. Bodies are CLI-parsed; **this project classifies by status only**. | CLI |
| Release states / logs | `GET v1/releases/{id}` → `release.state` (`CANCELED TIMEDOUT FAILED DEPLOYING UNHEALTHY READY`, plus `queue`); build logs `GET v2/releases/{id}/build-logs`. Neither path is in the OpenAPI. | CLI `build-logs.ts` |
| Billing | `GET /v1/billing` is documented in `billing.yaml` (`user.balance: number`, **no unit**). Console docs disagree on the unit (billing page: Toman; top-up page: Rial). Not used by the CLI. | `billing.yaml`, docs.liara.ir |
| Pricing page | Seven PaaS plans in GB / cores / Toman, hourly and monthly; **states nothing** about billing start, minimum balance, zero-balance behaviour, VAT or bundle prices; no API plan ids. | liara.ir/pricing |

### Phase 2G addition — `gitInfo`
The CLI **always** sends `gitInfo` for a source deploy; for a non-git directory its value is `{branch:null,message:null,commit:null,committedAt:null,remote:null,author:{email:null,name:null},tags:[]}`. The release body now mirrors that constant (`NON_REPO_GIT_INFO`); the full field-by-field comparison and the attestation scope are in `REST_RELEASE_CONTRACT_REVIEW.md`.

