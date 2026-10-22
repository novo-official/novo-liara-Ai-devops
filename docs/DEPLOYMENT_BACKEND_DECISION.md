# Deployment backend decision: REST API vs official Liara CLI vs hybrid (Phase 2D)

> **Scope.** Which mechanism should perform the two write calls of a release to the **existing** application `liara-agent-demo`, given the mentor's confirmation that both the official API and the free open-source `@liara/cli` are allowed. Nothing here was executed against Liara: every test uses a recording fake transport or a **fake process runner**. `LIARA_LIVE_DEPLOY_ENABLED` stays off. (There was no earlier "Phase 2D"; this is the first document of that name — the current architecture is Phase 2A/2B/2C plus this change.)

## 1. Verdict

**Hybrid, REST-first.**

* **REST is the control, evidence and verification plane in every configuration** (read-only monitoring, metrics, runtime, logs, releases list, identity). This is unchanged and is where this project's value (diagnosis, evidence, honesty about unknowns) lives.
* **For the release write itself, the default backend is the typed REST client** (`backend: "api"`).
* **The official CLI is implemented as an optional, disabled-by-default, tightly restricted second backend** (`backend: "cli"`), justified by one concrete risk: the release body's `platformConfig` and `build.cache` are **CLI-only fields never verified live**. If the first REST release is definitively rejected (HTTP 400), the operator can complete the deployment with the vendor's own client **under the same approval, audit and verification** — without guessing a different payload.
* **Not recommended:** CLI-only (loses artifact digest binding, adds a supply-chain and secrets-on-disk surface), or API-only with no fallback (leaves the unverified-contract risk with no safe exit).

## 2. What the two paths actually do (facts, with sources)

| | REST (this project) | Official CLI (`@liara/cli` 9.6.0, commit `14ec35f`) |
|---|---|---|
| Writes needed for an **existing** app | `POST /v2/projects/{name}/sources` (multipart `file`) → `{sourceID}`; `POST /v2/projects/{name}/releases` `{sourceID, port, type}` (+ CLI-only `platformConfig`, `build:{cache:true}`) → `{releaseID}`. Both **documented** in `paas.yaml` (@`338325a4`, identical to upstream HEAD). | Same two calls, plus reads: `GET v1/projects/{app}` (refuses if `scale == 0`), and — unless `--detach` — release polling, `GET v1/domains`, a log follower. With `--detach` it prints "Deployment created successfully." and exits. |
| Credentials | Bearer token held in memory by the typed client; never in a file, argv or environment. | **Only** via `--api-token` (command line ⇒ visible in the process list) **or** a saved account in `$HOME/.liara-auth.json`. No environment variable. |
| Source packaging | Deterministic tar.gz built by us (sorted, mtime 0, fixed gzip header): the **digest is known before approval** and re-derived at execution. | The CLI tars a **directory** itself (gzip 9, its own ignore rules, timestamps): bytes are **not reproducible**, so only the **file set** can be bound (path + SHA-256 per file, implemented as `manifestDigest`). The uploaded tarball is never visible to us. |
| Other behaviour | Nothing besides the two POSTs. | Shells out to `git` (`child_process.exec`) for git metadata; `update-notifier` spawns a background registry check (disabled with `NO_UPDATE_NOTIFIER`/`CI`); prompts (inquirer) when a flag is missing; uploads `.env` unless ignored; reads `liara.json`; 30 production dependencies. |
| Outcome signals | HTTP status per call (definite rejection vs unknown outcome) + reconciliation by reads. | Exit code and human text. Exit codes are **not** a contract (errors exit 1/2/3; kills/timeouts are ambiguous). |

## 3. Comparison on the six requested dimensions

| Dimension | REST | CLI (restricted) | Winner for this project |
|---|---|---|---|
| **1. Mechanism / contract risk** | Two documented endpoints; 2 CLI-only body fields unverified live (a wrong guess ⇒ a definite 400, harmless, no resource created). | The vendor's own payload: the fields are right by construction. | **CLI** on this single point |
| **2. Security, auditability, approval** | Every request body is built from the approved, digest-bound proposal by a strict schema; one attempt; one write class; recorded step by step; token never leaves the client. | Black box that makes its own requests (GET project, POST ×2, maybe more); token must sit in a 0600 file inside a private `HOME` for the run (argv would expose it); we can only bind tool identity (entry hash + version), exact argv template, and the file manifest — not the bytes sent. | **REST** |
| **3. Artifact preparation and verification** | Digest of the exact uploaded bytes bound at approval and re-checked at execution; byte-for-byte reproducible. | Directory materialised from the approved ZIP by our safe extractor (no `.env`, keys or dependencies), manifest bound; CLI re-packs with its own ignore rules ⇒ residual difference between "approved set" and "uploaded set". | **REST** |
| **4. Operational reliability and recovery** | A POST is attempted once; unknown outcomes reconcile by reading (releases baseline); fully testable at HTTP level with a recording fake. | Same reconciliation after the process ends (never parse output; one run only; kill/timeout ⇒ operator review); but failure modes multiply (Node/CLI install, version drift, TTY, git, HOME, temp disk, update checks), and tests can only fake the **process**, not the CLI's HTTP behaviour. | **REST** |
| **5. Compatibility with future server hosting** | Pure HTTPS; no binary, no writable HOME, no process permission. | Needs a pinned Node CLI install (supply chain: `lib/` and `node_modules` are not covered by the entry hash), process spawning, a writable private HOME, and a clean PATH on every host; hostile to serverless/locked-down containers. | **REST** |
| **6. Evidence (monitoring, metrics, runtime, logs)** | The read-only layer already covers it; the same reads verify the release in both backends. | The CLI offers none of this as a structured API (only human log streaming). | **REST** (both use it) |

Score: REST wins 5 of 6; the CLI wins the one that matters for a **first** real write (contract certainty). That asymmetry is exactly what the hybrid captures: REST by default, CLI as the safe fallback.

## 4. Why REST can be the default despite the unverified fields

* The cost of being wrong is small and visible: a rejected release is a definite 4xx (no release created — and the executor still re-reads the releases list before concluding), the already-uploaded source is inert, the app and its current release are untouched. Nothing is charged, deleted or restarted.
* The existing-app path needs **no** create call, no plan units, no network id and no billing semantics — the unresolved Phase 2B pricing/network blockers do not apply; only the release-field attestation does.
* If the first attempt is rejected the operator can switch the *same* approval flow to the CLI backend (a fresh proposal bound to the CLI tool, argv and manifest), instead of editing our request body by guesswork.

## 5. How the restricted CLI adapter is built (and what it can never do)

* **One command, one shape:** `node <pinned entry> deploy --app … --platform … --port … --path <private dir> --detach --no-app-logs --message agent-op-<operation id> [--team-id …]`. The argv is an **array** built from a strict schema; every value is validated and cannot start with `-`; a deny-list (`--api-token`, `--account`, `--image`, `--debug`, …) and an allow-list of flags are both enforced. No other subcommand is representable.
* **Fixed executable and identity:** `process.execPath` (absolute) runs the operator-pinned entry script (`LIARA_CLI_ENTRY`); the entry's SHA-256 (`LIARA_CLI_ENTRY_SHA256`), `package.json` name and exact version (`LIARA_CLI_VERSION`) must match — checked by reading, never by executing; the approval binds them.
* **Controlled environment:** exactly 10 variables (`HOME` = private temp dir, `PATH` = Node's directory only, `NO_UPDATE_NOTIFIER=1`, `CI=1`, …). Nothing is inherited, so no proxy, `NODE_OPTIONS`, tokens or npm/git config; `git` is simply not on `PATH`.
* **Token handling:** never in argv, never in the environment. It is written to `$HOME/.liara-auth.json` (mode 0600, `wx`) inside a per-run 0700 directory that is **deleted in `finally`**, together with the source copy. (Trade-off: the token exists on disk for the duration of the run — the CLI offers no other non-argv channel.)
* **Source:** the directory is materialised from the approved ZIP by the safe extractor — only the approved files; `.env*`, keys and dependency trees never exist there — and its manifest digest must equal the approved one or **nothing runs**.
* **Process limits:** `spawn(..., {shell:false, stdio:["ignore","pipe","pipe"]})`, wall-clock timeout (SIGTERM then SIGKILL), 64 KiB output cap, sanitised tail (token, private paths, ANSI, secret-like text removed; ≤10 lines). The only file allowed to start a process is `src/server/live/cli/process-runner.ts`; a static test enforces it; the real runner is constructed only in `runtime.ts` behind `createCliBackend`, never in tests.
* **Outcome by reading:** baseline releases list before; after the process ends (any exit code) the list is re-read: exactly one new release ⇒ adopted and then verified through the usual six-level ladder; none ⇒ `FAILED` (non-zero exit, an observation) or review (exit 0 / timeout); several ⇒ review. **One run only; never retried; nothing deleted.** `upload` and `release` are marked *inferred from the release's existence* (labelled as such).
* **Same governance:** the proposal/approval/audit store, typed app name, 10-minute single-use approval, drift fingerprint (app identity, scale, plan, platform, CLI identity), per-step re-authorisation, cancellation/recovery are the existing ones. No financial acknowledgment is needed (nothing new is created).

## 6. Residual risks of the CLI backend (stated, not hidden)

1. The entry hash does not cover `lib/` or `node_modules`: install the package from a lockfile with `--ignore-scripts` into a root-owned, read-only directory and pin its version. 2. The CLI's own ignore rules may drop approved files (the manifest binds what we hand it, not what it packs). 3. The token is on disk (0600, private dir) for the run. 4. The CLI makes its own requests (project GET, two POSTs); egress cannot be allow-listed without a sandbox. 5. Output is never parsed: a CLI that prints "success" proves nothing.

## 7. What was implemented in this change

`deploy_existing_app` operation kind (REST and CLI backends; never sends a create request; never extends the allowlist; identity, plan, platform and scale bound and re-proven), `src/server/live/cli/{spec,backend,process-runner}.ts`, `materializeApprovedSource`, `LIARA_CLI_*` configuration, `POST /api/agent/live/proposals` headers `x-live-kind` / `x-live-backend`, 46 new tests (fake transport and fake process runner only). **Not implemented:** UI controls for the existing-app kind (API only), any real execution, parsing of CLI output, CLI-based reads.

## 8. Recommended next action

1. Operator: re-run the narrow Events check later (see `LIVE_API_VERIFICATION.md` §10); set `LIARA_ALLOWED_APPS` to include `liara-agent-demo`, `LIARA_LIVE_CONTRACT_ATTESTED=true` (after reading the CLI fields), `LIARA_APP_DOMAIN_SUFFIXES`, `LIARA_LIVE_HEALTH_MARKER=liara-agent-demo`.
2. Prepare `npm run demo:zip`, upload it, create a `deploy_existing_app` / `api` proposal, approve with the typed name, and watch the six-level ladder.
3. Only if the REST release is definitively rejected: pin the CLI (`LIARA_CLI_*`), create a `cli` proposal and repeat.
