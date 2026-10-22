# Live Deployment Executor (implemented in Phase 2A, hardened in Phase 2B — **never executed against Liara**)

> **Status.** The executor is implemented (Phase 2A) and its final preflight added (Phase 2B). It has **not** been run against Liara: every write-path test uses a recording fake transport, and the real write client is never constructed with the default configuration. The first real deployment is Phase 2B and needs the operator steps in `FIRST_REAL_DEPLOYMENT_CHECKLIST.md`.

## 1. What it is (and is not)

A typed, isolated executor for exactly one workflow: *create an application → upload a source archive → create a release → verify*. It lives in `src/server/live/` and shares **nothing executable** with the simulator (`deploy/simulator.ts`, `agent/simulation/*`): separate types, tables, digest domain and approval scope.

It cannot delete, restart, stop, scale, change plans, change domains, charge, or top up. There is no generic HTTP client, no request-by-URL helper, and no code path from chat text or model output to any of its methods.

## 2. Default: DISABLED — and a flag alone is never authority

Execution requires **all** of the following at the moment of each mutating step; a missing item fails closed (`live_execution_disabled` / `live_prerequisite_missing`):

| Gate | Source |
|---|---|
| `LIARA_LIVE_DEPLOY_ENABLED=true` (needs `LIARA_DATA_SOURCE=live` and a token — config refuses the mix otherwise) | env |
| operator-verified plan units + billing semantics | `LIARA_PLAN_UNITS_JSON` |
| operator attestation of the CLI-observed write fields | `LIARA_LIVE_CONTRACT_ATTESTED=true` |
| network id the CLI always sends | `LIARA_NETWORK_ID` |
| trusted default app domain(s) for the health probe | `LIARA_APP_DOMAIN_SUFFIXES` (optional `LIARA_LIVE_HEALTH_PATH`, `LIARA_LIVE_HEALTH_MARKER`) |
| a **fresh, server-validated, live-scope approval for this exact operation** | `live_approvals` |

`createLiveWriteClient(cfg)` returns `null` unless the flag, a live data source and a token are all present, so with the shipped defaults no object able to send a write exists in the process. Even when it exists, `assertStepAuthorized` re-reads storage before **every** step and re-checks flag, attestation, units, network, operation state, proposal `CONSUMED`, an accepted `live` approval, the recomputed digest and the exact team/network/actor bindings.

## 3. Official API contracts (evidence classes)

`[A]` = documented in the pinned OpenAPI (`paas.yaml`, commit `338325a4`). `[C]` = observed **only** in the official `@liara/cli` source — not documentation, not verified live.

| Operation | Request | Response |
|---|---|---|
| `POST /v1/projects` (`teamID` is a **query** parameter) | `[A]` `name`, `planID`, `platform`, `readOnlyRootFilesystem?`, `network` · `[C]` `bundlePlanID`; the CLI **always** sends `network` | `[A]` 200 with an **empty body** (no app id) · 400 · 401 · 409 — `[C]` 402 (balance), 403 |
| `POST /v2/projects/{name}/sources` | `[A]` multipart field `file` ("the .gz file to deploy") | `[A]` `{sourceID}` · 400 · 401 · 404 — `[C]` 413 |
| `POST /v2/projects/{name}/releases` | `[A]` `sourceID`, `port`, `type` · `[C]` `platformConfig` (`{}` for Next.js), `build` = `{"cache":true}` (the CLI always sends `build.cache`, default true; corrected in Phase 2B) | `[A]` `{releaseID}` · 400 · 401 · 404 |

Reads used for verification: `GET /v1/projects` (name existence), `GET /v1/projects/{name}` (scale/status), `GET /v1/projects/{name}/releases`, applets, recent logs (all read-only, already allowlisted).

Facts that shaped the design: error bodies are unspecified (classification is by **HTTP status only**; bodies are never stored); there is **no idempotency key**; no rate limits are documented; the create response does not return the app id (so existence is proven by a read); there is no endpoint to list uploaded sources. Which `[C]` fields are *required* has never been verified live → the operator attestation gate.

## 4. Source artifact

Format taken from the CLI: **tar.gz** (gzip level 9), root-relative entries, default ignores plus one ignore file per directory (`.liaraignore` > `.dockerignore` > `.gitignore`). Stricter than the CLI: `.env*`, keys, `.npmrc` and credentials are **never** packaged. Deterministic: sorted entries, mtime 0, uid/gid 0, mode 0644, fixed gzip header → identical input gives an identical digest. Limit 128 MiB (the lowest documented bundle limit; the CLI's own cap is 256 MiB).

Digest binding (domain `liara-live-deploy-v1`): original ZIP SHA-256 → static analysis digest → plan → generated artifact digest, all inside the proposal digest. Archives are never persisted; the operator **re-uploads** the same ZIP at proposal time and again at execution, and the artifact is rebuilt and compared byte-for-byte to the approved digest before any write.

## 5. Plans, pricing and money

The plan is chosen from the real catalogue (`/v1/me`). The API states **no units** for RAM/CPU/price and nothing about when billing starts, minimum balance, or zero-balance behaviour. Therefore:

* units unverified ⇒ **no price, no ranking, no "recommended" flag, creation blocked**;
* verified units come only from the operator document `LIARA_PLAN_UNITS_JSON` (`ram` GB|MB, `cpu: "cores"`, `price {currency, per}`, `billing {model, minimumBalanceToCreate, otherCostsKnown, otherCostsUnknown}`, `verifiedAt`, `source`); every figure shown is labelled with it;
* the bundle plan (`bundlePlanID`) must resolve unambiguously from `projectBundlePlans`, else blocked; a plan below the estimated RAM minimum is blocked; unknown/unavailable plans are blocked;
* a 402 (insufficient balance) ends as `FAILED` with the instruction to top up **manually**. The executor never charges, never calls any billing endpoint, and never uses the free credit logic.

## 6. Approval model

A live proposal binds: operator (session hash), exact team, app name, plan id, bundle plan, network id, platform, artifact digests, build config, env key **names** (Phase 2A refuses projects that need env values), financial impact, state fingerprint (name absent, plan available, units version), unique operation id, TTL (10 min), and requires the **typed exact app name**. The digest is recomputed from storage on every use; any tampered field → `live_tampered`. Approval is single-use (`beginExecution` atomically moves proposal `APPROVED→CONSUMED` and operation `AWAITING_LIVE_APPROVAL→APPROVED`).

**Simulation approvals are permanently invalid in live mode:** simulation ids (`prop_…`) are refused by the routes and the service (`live_simulation_approval_rejected`, HTTP 403), live proposals live in other tables, and the digest domain differs.

At decision time the executor re-checks drift (plan still available, bundle plan unchanged, name still absent, catalogue readable); drift → proposal `BLOCKED`.

## 7. State machine

`PREFLIGHT → AWAITING_LIVE_APPROVAL → APPROVED → CREATING_APPLICATION → APPLICATION_CREATED → UPLOADING_SOURCE → SOURCE_UPLOADED → CREATING_RELEASE → RELEASE_CREATED → VERIFYING_DEPLOYMENT → DEPLOYED`, plus `FAILED`, `NEEDS_OPERATOR_REVIEW` and `CANCELLED`. Edges are enforced in the store (`LIVE_NEXT`) with compare-and-set; `DEPLOYED`, `FAILED` and `CANCELLED` are terminal; `NEEDS_OPERATOR_REVIEW` leaves only through an explicit operator action (`reverify` → `DEPLOYED` only if every fact is verified, or `abandon` → `FAILED`). Cancellation is possible only before any remote activity.

## 8. Idempotency, timeouts, recovery

* **A POST is attempted once.** `LiaraWriteClient` makes one attempt, `redirect: "manual"`, bounded time and bounded body reads.
* Definite 4xx (`rejected`) ⇒ nothing happened ⇒ `FAILED`; a 409 means somebody else's app of that name exists and it is never touched.
* Timeout / network / 5xx / redirect / unreadable 2xx ⇒ `unknown_outcome` ⇒ **reconcile by reading**, never by retrying: create → name list; release → releases list compared against the baseline taken just before the POST (exactly one new id is adopted; zero or several ⇒ review). Upload has no listing endpoint ⇒ review.
* HTTP 200 alone is never success: the app must be seen to exist.
* Partial resources are **preserved**; nothing is auto-deleted, auto-upgraded or rolled back; the failure record carries Persian recovery instructions.
* Uniqueness is enforced by partial unique indexes (one pending proposal and one active operation per team+app), so no duplicate deployments even across two processes. After a restart, in-flight operations become `NEEDS_OPERATOR_REVIEW` (`interrupted_by_restart`) and are never resumed automatically.

## 9. Post-deployment verification ladder

`apiAcceptedRequest`, `sourceUploaded`, `releaseCreated`, `buildCompleted`, `runtimeStarted`, `httpHealthVerified` are recorded separately; **`DEPLOYED` only when all six are `ok`**. `unknown` is never success; a failing level ⇒ `FAILED`; an inconclusive one after the bounded budget (10 min, 5 s polls) ⇒ `NEEDS_OPERATOR_REVIEW`. The release states come from the CLI (`READY` ok; `FAILED/CANCELED/TIMEDOUT/UNHEALTHY` fail; `DEPLOYING` and unknown wait). Runtime comes from applets; recent logs are sanitized.

The health probe (`probe.ts`) is SSRF-hardened: the URL is built only from the validated app name and an operator-trusted suffix, `https`, port 443, `GET`, DNS resolved **at connect time** and every address validated (private, loopback, link-local, CGNAT, multicast, reserved, metadata and IPv4-mapped IPv6 are blocked), no redirects, bounded size and time. A configured marker must be found in the body.

## 10. Allowlist bootstrap

The existing allowlist (`LIARA_ALLOWED_APPS`) is never disabled. `LiaraService.isAllowed` = env allowlist ∪ rows of `app_scope`. A row is written by exactly one transaction (`bootstrapScope`, audited) and only for the **exact team and name** of an operation whose proposal is `CONSUMED` with an accepted live approval and whose creation the executor **confirmed by a read**. Rejected, expired, failed-before-create and unapproved operations never reach scope (tests).

## 11. API and UI

Routes (own-origin, session + CSRF + rate-limited, strict bodies): `GET live/status`, `POST live/proposals` (ZIP body, parameters in headers), `POST live/proposals/{id}/decision`, `POST live/proposals/{id}/execute` (ZIP body), `GET live/operations/{id}`, `POST live/operations/{id}/resolve` (`cancel|reverify|abandon` only).

The Persian panel («استقرار واقعی روی لیارا») shows `SIMULATED / BLOCKED / READY_FOR_APPROVAL / LIVE_IN_PROGRESS / LIVE_VERIFIED / LIVE_FAILED`, the prerequisite checklist with the reason each one fails, the plan table (raw values, labelled), the proposal with every binding, a typed-name approval dialog, the execution box (re-select the ZIP), the timeline, the six-level ladder, the failure cause with recovery steps and the recovery buttons. Controls stay disabled until the server reports the prerequisites.

## 12. Demo fixture

`fixtures/demo-app` is a tiny deterministic Next.js app (`/health` returns a fixed JSON marker). `npm run demo:zip` writes a deterministic ZIP to `dist-demo/`. It is built only locally by the maintainer, is never deployed in Phase 2A, and is excluded from lint/tsc of the main project.

## 13. Zero-cost AI policy

The executor and its panel contain no LLM or provider code (static scan over `src/server/live`). `AI_LIVE_REQUESTS_ENABLED` stays `false`; no embeddings, fallbacks or background inference; the promotional credit is untouched.

## 14. What is still unverified (blocks Phase 2B until settled)

Required-ness of the `[C]` fields; the network id source (`GET v1/networks`); units/billing semantics; whether a 200 create is always followed by visibility within seconds; release state vocabulary beyond the CLI's; runtime vocabulary; `teamID` effect on writes. See `FIRST_REAL_DEPLOYMENT_CHECKLIST.md`.

## 15. Capability status (Phase 2B) — five labels, never conflated

| Label | Meaning |
|---|---|
| **Documented** | in the pinned OpenAPI (`paas.yaml`, `me.yaml`, `billing.yaml` @ `338325a4`, identical to upstream HEAD on 2026-10-22) |
| **Live-verified** | a recorded, sanitised, read-only call to the real API matched our schema (Phase 1F: `GET /v1/projects`, `/v1/me`, `/v1/me/subscription`, `/v1/me/free-credit`) |
| **Tested with fake transport** | exercised only against the recording fake (`FakeLiara`) |
| **Not tested** | never exercised against anything real |
| **Blocked** | a prerequisite is missing and the tool refuses to proceed |

| Capability | Documented | Live-verified | Fake-tested | Not tested live | Blocked until |
|---|---|---|---|---|---|
| `GET /v1/projects`, `/v1/me`, `/v1/me/free-credit`, `/v1/me/subscription` | yes | structure (Phase 1F) | yes | item-level app fields (zero apps) | — |
| `GET /v1/billing` | yes (`billing.yaml`; **no unit**) | no | yes | yes | operator runs `preflight:liara --approve-live-readonly` |
| `GET /v1/networks` | **no (CLI-only)** | no | yes | yes | explicit opt-in + read-only run |
| `POST /v1/projects`, `/v2/…/sources`, `/v2/…/releases` | yes (CLI-only fields: `bundlePlanID`, `network`, `platformConfig`, `build`) | **never sent** | yes | yes | Phase 2B operator steps |
| release state vocabulary, build logs, runtime vocabulary | no (CLI-only) | no | yes | yes | first controlled run |
| SSRF-safe health probe | n/a (own code) | no | yes | yes | domain suffix + first run |

## 16. Phase 2B hardening (what changed and why)

1. **Pricing is corroborated, not declared.** `LIARA_PLAN_UNITS_JSON` is only *believed* when the live plan catalogue and the public pricing page agree on exactly one unit hypothesis (RAM GB|MB × price per hour|month, Toman) over ≥2 matching plans and no contradiction. This confirms **units only**; it never maps a public plan name to an API plan id, and the selected plan's own price must match a published plan. The operator may *accept as unresolved* (`acceptedUnknowns`) the facts no official source states (billing start, minimum balance, zero-balance behaviour, bundle price, VAT) — a risk acceptance, shown as unknown everywhere; otherwise creation stays blocked.
2. **Balance** is classified, never printed: `sufficient` only if it covers 24 h even when read as Rial; `insufficient` only if short even as Toman; otherwise `ambiguous` (blocks). Team accounts use `team.balance` from `/v1/me`; personal accounts use `/v1/billing`.
3. **Network:** the configured id must appear in `GET /v1/networks` (opt-in); an empty list blocks (the tool never creates networks); the id is never invented.
4. **Team:** a configured team must be present in the account answer, else a *security* blocker.
5. **Financial acknowledgment:** `acknowledgeFinancial: true` is required in addition to the typed name; audited (without amounts).
6. **Drift:** the approved state includes a signature of the network/units/balance/team/plan checks; any change between proposal, approval and execution voids the approval.
7. **HTTP errors are not proof of absence:** after a rejected create/release the state is read; a visible app/release ⇒ `NEEDS_OPERATOR_REVIEW`, unreadable ⇒ review, observed absent ⇒ `FAILED`.
8. **Identity before scope:** the allowlist is extended only after `GET /v1/projects/{name}` reports exactly the approved name (and not before: that read bypasses the allowlist for one exact name). Zero-app accounts run with `LIARA_FIRST_APP_BOOTSTRAP=true` and an empty allowlist.
9. **Verdicts:** `DEPLOYED` (all six levels), `PARTIALLY_VERIFIED` (create/upload/release plus a later level), `NEEDS_OPERATOR_REVIEW`, `FAILED`; each level lists its evidence source (`documented`, `cli_observed`, `own_probe`) and limitation. A created release is never a completed build.
10. **Preflight verdict:** `READY_FOR_OPERATOR_APPROVAL` or the highest-priority blocker `BLOCKED_BY_SECURITY > CONTRACT > PRICING > CONFIGURATION`, produced by `npm run preflight:liara` and the status API.

## 17. Existing applications (Phase 2C audit → implemented in Phase 2D)

`liara-agent-demo` was created **manually** in the console. The *create* flow (`createProposal`) still supports only NEW applications and still refuses an existing name (`live_duplicate_app`; tests `live-existing-app.test.ts`). Phase 2D adds a **separate, explicit operation kind**, `deploy_existing_app` (`LiveDeploymentService.createExistingProposal`), that **never sends a create request**:

* **Preconditions (all read-only, all re-proven at approval and at execution):** the app exists (inventory), is **already in the operator's scope** (`LIARA_ALLOWED_APPS`; a release never widens it and `bootstrapScope` refuses non-creations), its identity matches (API-reported name, plan id, platform equal to the release type, `scale == 1`). No plan units, network id or billing semantics are needed — nothing is created and the plan is untouched.
* **Binding:** `kind`, `backend`, the app's real plan id, the artifact digests and — for the CLI backend — the tool identity, argv template digest and file-manifest digest are part of the proposal digest. Typed app name, 10-minute single-use approval and drift fingerprint apply; the financial acknowledgment does not (no new cost line).
* **State machine:** `APPROVED → APPLICATION_CREATED` (note `existing_app_verified`; no create) → upload → release → verification (same six levels, same `DEPLOYED` rule). An existing-app operation does not own the app name once it ended (`DEPLOYED`/`FAILED`); in-flight work and an unresolved review still hold the slot.
* **Backends:** `api` (typed REST: `uploadSource` + `createRelease`) or `cli` (restricted official CLI, see `DEPLOYMENT_BACKEND_DECISION.md`). **The REST backend is the default.**
* **Not implemented:** UI controls for this kind (use the API headers `x-live-kind: deploy_existing_app`, `x-live-backend: api|cli`), any live execution.

## 18. Phase 2E — existing-app UI, instance binding and offline rehearsal

* **Instance identity:** besides name, plan and platform, the approval now binds the app's **instance id (`_id`), creation time, network, default-subdomain flag and release baseline (current release + count)**. A deleted-and-recreated app (same name) therefore voids every earlier proposal and approval (drift at approval, `existing_instance_changed` / `existing_baseline_changed` at execution, zero writes). An app reporting neither an instance id nor a creation time cannot be bound and is blocked.
* **Domain and health validation (no env changes):** the expected default domain follows the official CLI rule (network ⇒ `liara.run`, none ⇒ `iran.liara.run`); the probe only uses the first configured suffix; the marker must be specific (≥ 8 characters, not `ok`/`healthy`…); the default subdomain must be enabled. `npm run check:live-settings` validates the settings offline; nothing writes `.env.local`.
* **UI:** a Persian RTL section «انتشار روی برنامهٔ موجود» (authorised targets with identity card, readiness, backend choice REST-default/CLI-fallback, cost disclosure, approval preview with every binding, execution timeline), and a three-way mode banner: **simulation** (amber) · **live disabled / read-only** (neutral) · **live enabled** (red).
* **Rehearsal:** `tests/integration/live-rehearsal.test.ts` — full REST and CLI flows with the recording fake transport and the fake process runner; proof that `createApp` is never sent across 8 REST/CLI outcomes.
* The exact separate plan and approvals for the first real release: `FIRST_LIVE_RELEASE_PLAN.md`.

## 19. Final REST release contract review

`REST_RELEASE_CONTRACT_REVIEW.md`: field-by-field comparison of the two writes against the pinned OpenAPI and the official CLI 9.6.0, the exact scope of `LIARA_LIVE_CONTRACT_ATTESTED`, the verified demo artifact, platform facts, charges, failure modes and the GO/NO-GO (Approval A now; Approval B only after a green read-only preflight).

