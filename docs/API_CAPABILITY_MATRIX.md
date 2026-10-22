# API Capability Matrix — Liara PaaS

> Phase 0 deliverable. Every row separates **what is documented** from **what has been tested live**.
> As of this writing **no endpoint has been called against `api.liara.ir`** (no credentials were available, and Phase 0 forbids mutating calls). Every "Live" cell is therefore `NOT TESTED`.

## 1. Evidence sources and pins

| ID | Source | Pin | Notes |
|----|--------|-----|-------|
| `SPEC` | `liara-cloud/openapi` → `spec/paas.yaml` (OpenAPI 3.0.1, info.version 1.0.0) | repo commit `338325a4` (2026-10-17); file sha256 `a8b8ab24…4d56d`; copy kept in `docs/reference/openapi/paas.yaml` | 41 operations. Authoritative for what is *documented*. |
| `SPEC-ME` | same repo → `spec/me.yaml` | same commit; sha256 `01d8f1a2…0d44d8`; copy in `docs/reference/openapi/` | `GET /v1/me` (plans, user, team). |
| `DOCS` | `openapi/pages/paas.mdx`, `openapi/index.mdx`, https://developers.liara.ir/ (reachable, HTTP 200) | same commit | Prose only; adds auth header form and base URL. |
| `CLI` | `liara-cloud/cli` v9.6.0 source | commit `14ec35f7` (2026-10-18) | **Not documentation.** Shows what the official client actually calls. Used only to flag endpoints/fields *missing from the spec*. Treated as "observed, undocumented" and must be validated live before use. |

Validation vocabulary used below:

| Code | Meaning |
|------|---------|
| `DOC` | Present in `SPEC` with request/response schema. |
| `DOC-WEAK` | Present in `SPEC`, but the schema is incomplete/untyped (details in "Limitations"). |
| `CLI-ONLY` | Not in `SPEC`; seen in official CLI source. Contract unknown until live-tested. |
| Live: `NOT TESTED` | No live call has been made. Phase 1 will add `READ-OK` / `MUTATION-OK` only after a recorded, scrubbed live call. |

## 2. Authentication, base URL, tenancy

| Item | Value | Source | Live |
|------|-------|--------|------|
| Base URL | `https://api.liara.ir` | SPEC `servers`, DOCS | NOT TESTED |
| Auth header | `Authorization: Bearer <API_TOKEN>` | DOCS (index.mdx); SPEC declares both `jwt` (apiKey in `Authorization` header) and `bearerAuth` (http bearer, JWT) | NOT TESTED |
| Token source | Created by the user in Liara console. **No endpoint to mint or scope tokens is documented.** | DOCS | — |
| Token scoping | **Not documented.** Do not assume a read-only or per-app token exists. Scoping must be enforced by *our* policy layer. | — | — |
| Team access | Query parameter `teamID`. The spec mentions it only in the console WebSocket description. The CLI appends `teamID=<id-or-empty>` to **every** request. | SPEC (WS only), CLI `src/base.ts` | NOT TESTED |
| Alternate host | CLI constant `https://api.iran.liara.ir` exists; the spec lists only `api.liara.ir`. Treat as unknown. | CLI `constants.ts` | — |
| Rate limits | **Not documented** ("refer to individual service documentation"; PaaS page lists none). Adapter must apply conservative client-side limits and honour `429`/`Retry-After` if returned. | DOCS | NOT TESTED |
| Error body shape | **Not specified** (all error responses have empty `content`). Adapter must tolerate non-JSON bodies. | SPEC | NOT TESTED |
| Idempotency keys | **None documented.** Idempotency is implemented locally (see SECURITY_POLICY §6). | SPEC | — |

## 3. Risk classes

| Class | Meaning | Policy |
|-------|---------|--------|
| **R0** | Read-only | Allowed without approval, still allowlisted per app + rate-limited. |
| **R1** | Mutation, small blast radius, recoverable (start, restart) | Human approval required. |
| **R2** | Mutation that changes service availability, configuration, cost or exposes a new public surface (deploy, env change, stop, plan change, create app, attach domain) | Human approval with full preview + typed confirmation of app name; shorter expiry. |
| **R3** | Destructive / irreversible / data loss | **Not exposed as a tool in the MVP.** Listed so the policy engine can explicitly deny. |

## 4. Matrix — endpoints in scope for the MVP

Schemas are summarised from `SPEC` (`*` = required by the spec; `?` = `nullable`). Where the spec marks nothing required, "(none required)" is stated — the CLI shows additional fields are needed in practice (see Limitations).

### 4.1 Read endpoints (R0)

| Tool | Method + path | Request | Response (200) | Auth | Risk | Validation | Limitations / drift | Live |
|------|---------------|---------|----------------|------|------|------------|---------------------|------|
| `liara_list_apps` | `GET /v1/projects` | — | `{projects:[{_id, project_id (=app name), type (platform), status, scale:number, planID, created_at, isDeployed:boolean}]}` | Bearer | R0 | DOC | `status` is a free string; values not enumerated. 404 documented for a list call (odd). | NOT TESTED |
| `liara_get_app` | `GET /v1/projects/{name}` | path `name`* | `{project:{_id, project_id, type, status, defaultSubdomain, readOnlyRootFilesystem, zeroDowntime, scale, envs:[{key,value,encrypted,_id}], planID, fixedIPStatus, created_at, node:{_id,IP}, hourlyPrice, isDeployed, reservedDiskSpace}}` | Bearer | R0 | DOC | **Returns env `value`s** → adapter MUST strip values before anything leaves the adapter (keys + `encrypted` only). Unknown whether `encrypted:true` values are masked. `hourlyPrice` unit/currency undocumented. Path param is called `name` here but `id` on settings endpoints — both appear to be the app name (unverified). | NOT TESTED |
| `liara_get_logs` | `GET /v1/projects/{name}/logs` | path `name`*; query `since`* (string, "Show logs since timestamp"; format unspecified) | `[{type, datetime, message}]` | Bearer | R0 | DOC-WEAK | **Drift:** the official CLI does not use this. It calls `GET v2/projects/{name}/logs?start=<unix-s>&direction=forward&last_lines=<bool>[&releaseId=]` and parses `{data:[{metaData:{releaseId}, values:[[<ns-timestamp>, <line>]]}]}`. Unclear whether v1 still works. Max log history depends on the user's bundle plan (CLI reads `plans`). | NOT TESTED |
| `liara_get_logs_v2` | `GET /v2/projects/{name}/logs` | query `start`, `direction`, `last_lines`, `releaseId` (all from CLI) | Loki-style `{data:[{metaData:{releaseId}, values:[[ts,line]]}]}` (from CLI types) | Bearer | R0 | **CLI-ONLY** | Undocumented. Prefer this only if live test shows v1 is unusable; keep both behind one adapter method with a feature probe. | NOT TESTED |
| `liara_get_events` | `GET /v1/projects/{name}/events` | path `name`*; query `search?`:string, `start?`:number, `end?`:number | `{data*:[{metaData:object, values:[[string]]}]}` | Bearer | R0 | DOC-WEAK | `metaData` is an untyped object; `values` is an array of string arrays with no column definition. `start`/`end` only carry the example `1704028315` (a Unix timestamp in **seconds**); no unit is stated and response timestamps are untyped. Parse defensively; store raw. | NOT TESTED |
| `liara_list_releases` | `GET /v1/projects/{name}/releases` | path `name`*; query `page`* (number, default 1), `count`* (number, default 10) | `{total, currentRelease, readyReleasesCount, releases:[{_id, type, imageName, projectType, state, port, gitInfo:{branch?,message?,commit?,committedAt?,remote?,author:{email?,name?},tags[]}, client, finishedAt, createdAt, tag, sourceAvailable}], platform}` | Bearer | R0 | DOC | `state` values not enumerated (CLI also references `FAILED`, `CANCELED`, `TIMEDOUT`, plus `failReason`). `currentRelease` is a string (id or tag — unverified). `sourceAvailable` hints that a source can be reused but **no documented endpoint consumes it** (see rollback gap). | NOT TESTED |
| `liara_get_release` | `GET /v1/releases/{releaseID}` | path | `{release:{state, status, failReason?, queue?}}` (from CLI types) | Bearer | R0 | **CLI-ONLY** | Needed to poll deploy state. Undocumented. | NOT TESTED |
| `liara_get_build_logs` | `GET /v2/releases/{releaseID}/build-logs?since=` | query `since` | `{release:{state,status,failReason?,queue?}, buildOutput:[{stream:'STDOUT'\|other, line}]}` (from CLI) | Bearer | R0 | **CLI-ONLY** | Undocumented. Required for the first-deploy journey to explain build failures. Non-`STDOUT` stream is treated by the CLI as failure output. | NOT TESTED |
| `liara_list_applets` | `GET /v1/projects/{name}/applets` | path `name`* | `{applets:[{id, name, timestamp, state, reason, release:{releaseID, tag}}]}` | Bearer | R0 | DOC | "Applet" = running instance/pod; `state`/`reason` free strings. **Primary signal for crash loops / OOM-kills** — exact vocabulary must be recorded live. | NOT TESTED |
| `liara_get_metrics_summary` | `GET /v1/projects/{name}/metrics/summary` | path `name`* | `{cpuUsage:[{value:[…], applet}], memoryUsage:[{value:[…], applet}], disksUsage:[{size, usage, reportedAt, name}]}` | Bearer | R0 | DOC-WEAK | `value` array element type is **not declared** (schema shows an empty item); units (cores? millicores? bytes?) and whether `size`/`usage` are strings with units are unspecified. | NOT TESTED |
| `liara_get_metrics_series` (cpu) | `GET /v1/projects/{name}/metrics/cpu` | path `name`*; query `since`* (number) | `{end:number, result:[{values:[[number\|string,…]], applet}]}` | Bearer | R0 | DOC-WEAK | Prometheus-style `[ts, "value"]` pairs *likely* but not stated. Unit unspecified. `since` unit unspecified (seconds assumed; verify). | NOT TESTED |
| (memory) | `GET …/metrics/memory` | same as cpu | same as cpu | Bearer | R0 | DOC-WEAK | same | NOT TESTED |
| (network rx) | `GET …/metrics/network-receive` | same as cpu | same as cpu | Bearer | R0 | DOC-WEAK | same | NOT TESTED |
| (network tx) | `GET …/metrics/network-transmit` | same as cpu | same as cpu | Bearer | R0 | DOC-WEAK | same. No HTTP request-rate, status-code (4xx/5xx) or latency metric exists. **500-error detection therefore relies on logs (and optionally an external probe), not metrics.** | NOT TESTED |
| `liara_list_domains` | `GET /v1/domains` | query `project`* (app name) | `{domains:[{_id, name, type, project:{_id,project_id}, status, certificatesStatus, redirectTo, redirectStatus, created_at, CNameRecord}]}` | Bearer | R0 | DOC | `status`/`certificatesStatus` values unspecified. | NOT TESTED |
| `liara_check_domain` | `GET /v1/domains/{id}/check` | path `id`* | `{domain:{_id,user,name,type,project,status,certificatesStatus,redirectTo,redirectStatus,updated_at,punycodeName,verificationCode,created_at,__v,CNameRecord,issuedAt}}` | Bearer | R0 | DOC | Response contains `verificationCode` and `user` → treat as sensitive-ish; do not send to the LLM. | NOT TESTED |
| `liara_list_plans` | `GET /v1/me` | — | `{user, team?, databaseVersions, defaultDatabaseVersions, featureFlags, plans:{projects:{<planID>:{…}}, projectBundlePlans:{…}, …}}` | Bearer | R0 | DOC-WEAK | `plans.*` is `additionalProperties: true` (free-form). From CLI use only: `plans.projects[id].{available, region, RAM.amount, CPU.amount, volume, price}` and `projectBundlePlans[id][bundle].displayPrice`. The CLI multiplies `price × 720` for a monthly figure — **unit is not documented; we will not display a price until the unit is confirmed live.** `user` contains PII → project the response to `plans` only inside the adapter. There is no dedicated "list plans" endpoint in `paas.yaml`. | NOT TESTED |

### 4.2 Mutating endpoints

| Tool | Method + path | Request | Response | Auth | Risk | Validation | Limitations / drift | Live |
|------|---------------|---------|----------|------|------|------------|---------------------|------|
| `liara_restart_app` | `POST /v1/projects/{name}/actions/restart` | path `name`*; no body | 200 "Your request has been submitted." (empty body) | Bearer | **R1** | DOC | Asynchronous ("submitted"). Completion must be verified via `liara_list_applets` / `liara_get_app`. | NOT TESTED |
| `liara_start_app` | `POST /v1/projects/{name}/actions/scale` | body `{scale*: number}` — spec: "1 to turn on or 0 to turn off" | 200 "submitted" | Bearer | **R1** (`scale:1`) | DOC | **This is an on/off switch, not horizontal scaling.** The product prose ("adjust the number of instances") is not backed by the schema. Only values `0` and `1` are meaningful; the adapter must reject any other number. | NOT TESTED |
| `liara_stop_app` | same as above with `scale:0` | `{scale:0}` | 200 "submitted" | Bearer | **R2** (causes downtime) | DOC | Same. | NOT TESTED |
| `liara_update_envs` | `POST /v1/projects/update-envs` | `{project:string, variables:[{key,value}]}` (none required by spec) | `{message}` | Bearer | **R2** | DOC-WEAK | **Replace-all semantics inferred from CLI:** `liara env:set` first reads all current vars, merges client-side, then posts the *entire* list; and the CLI prints "…applied and restarting <app>". So the call (a) **overwrites the full set** and (b) **restarts the app**. A partial list would delete the other variables. The adapter must read→merge→write and refuse if any current var has `encrypted:true` until masking behaviour is verified live. | NOT TESTED |
| `liara_resize_plan` | `POST /v1/projects/{name}/resize` | `{planID*: string}` | 200 (empty) | Bearer | **R2** (cost + possible restart) | DOC | Valid `planID` values come only from `GET /v1/me` → validate against it. Downgrade may fail if disk/usage exceeds the target (unknown). Downtime and billing behaviour undocumented. Operation description is copy-pasted ("create app that user owns"). | NOT TESTED |
| `liara_create_app` | `POST /v1/projects` | `{name, planID, platform, readOnlyRootFilesystem:boolean, network:string}` — **none marked required** | 200 (empty body — the new app id is **not returned**) | Bearer | **R2** (creates a billable resource) | DOC-WEAK | CLI additionally sends `bundlePlanID` (not in spec) and checks "free plan ⇒ free bundle". CLI name rules: `^[a-z0-9][a-z0-9\-]+[a-z0-9]$`. Platform ids from CLI: `node, laravel, php, python, django, flask, dotnet, react, angular, vue, static, docker, next, go`. 409 on duplicate name. After create, re-read `GET /v1/projects/{name}` to confirm. | NOT TESTED |
| `liara_upload_source` | `POST /v2/projects/{name}/sources` | `multipart/form-data` field `file`* (binary) | `{sourceID}` | Bearer | **R2** (consumes build resources; part of deploy) | DOC | CLI enforces `MAX_SOURCE_SIZE = 256 MiB` (not in spec). Archive format created by CLI is a tar/zip created by `createArchive` (format not documented here — to confirm in Phase 1 by reading `src/utils/create-archive.ts` and a live test). No upload timeout (CLI disables it). | NOT TESTED |
| `liara_create_release` (deploy) | `POST /v2/projects/{name}/releases` | spec body `{sourceID, port:number, type:string (platform)}` | `{releaseID}` | Bearer | **R2** (replaces running version) | DOC-WEAK | The CLI sends far more: `build{cache,args,dockerfile,location}, cron, args, message, disks, envs, image` (docker image deploy), `gitInfo`, `platformConfig`, `healthCheck`. Which are required per platform is unknown → the MVP sends only `{sourceID, port, type}` (+ `platformConfig` where Phase 1 live test proves it is required) and records the result. | NOT TESTED |
| `liara_cancel_release` | `POST /v2/releases/{releaseID}/cancel` | path | (unknown) | Bearer | R1 | **CLI-ONLY** | Undocumented. Optional for MVP. | NOT TESTED |
| `liara_create_domain` | `POST /v1/domains` | `{name*, project*, type*: string default "PROJECT"}` | 201 `{domain:{_id}}` | Bearer | **R2** (new public hostname) | DOC | 409 on conflict. Needs user-side DNS (CNAME) change; `CNameRecord` is returned by list/check. | NOT TESTED |
| `liara_set_domain_project` | `POST /v1/domains/set-project` | `{domainID*, projectID*}` | 200 | Bearer | **R2** | DOC | `projectID` — id vs name unclear (the name `_id` vs `project_id` both exist). Verify live. | NOT TESTED |
| `liara_enable_ssl` | `POST /v1/domains/provision-ssl-certs` | `{domain*: string}` (domain name or id? unspecified) | `{code}` | Bearer | **R2** | DOC-WEAK | Asynchronous; verify with `liara_check_domain.certificatesStatus`. | NOT TESTED |

### 4.3 Documented but **deliberately not exposed** in the MVP (policy-denied)

| Endpoint | Why |
|----------|-----|
| `DELETE /v1/projects/{name}` (R3) | Irreversible data/app loss. |
| `DELETE /v1/projects/{id}/disks/{name}`, `POST …/disks/{dname}/resize`, `POST …/disks`, FTP create/delete, backups create/download | Persistent-data and cost risk; out of scope for both journeys. Disk *usage* is read via metrics summary only. |
| `DELETE /v1/domains/{id}`, `POST /v1/domains/{id}/ssl/disable`, `POST /v1/domains/{id}/set-redirect` (R3/R2) | Can take a site offline or break TLS. |
| `POST /v1/projects/{id}/zero-downtime/{status}`, `default-subdomain/{status}`, `fixed-ip/{status}`, `read-only/{status}` | Settings flips with side effects (e.g. `fixed-ip` is billable; `default-subdomain disable` removes the free URL). Revisit post-MVP. |
| Console WebSocket `wss://api.liara.ir?token=…&cmd=/bin/bash&project_id=…` | Remote shell with the token in a **URL query string** — violates our secret-handling rules. Not used. |

## 5. Capability gaps vs. the user's list

| Requested capability | Status |
|----------------------|--------|
| apps, logs, events, releases, metrics | Documented (see 4.1). Metrics/events/logs have weak schemas; log API has v1/v2 drift. |
| deployment | Documented: sources upload + release create. Build/release polling is **CLI-ONLY**. |
| domains | Documented (list, create, check, set-project, SSL enable). |
| restart | Documented. |
| **scaling** | Only **on/off** (`scale` 0/1). **No replica-count / horizontal scaling endpoint exists in the spec.** "Scale up" in the product means a **plan change** (`resize`). |
| plan changes | `resize` documented; plan catalogue only via `GET /v1/me` (free-form). |
| **rollback** | **No rollback / release-activation endpoint is documented** (and none appears in the CLI command list). `sourceAvailable` on releases hints at a reuse path, but nothing consumes it. The MVP **will not offer one-click rollback**; remediation for a bad release is "deploy a corrected source". Phase 1 spike: check whether `POST /v2/projects/{name}/releases` accepts a prior `sourceID`/`image` (CLI-observed `image` field) — until proven live, no rollback claim. |
| HTTP 5xx rate / latency / request metrics | **Not available** in the API. |

## 6. Live-test status summary

| Category | Documented ops used by MVP | Live-tested read | Live-tested mutating |
|----------|---------------------------|------------------|----------------------|
| Read (R0) | 17 endpoints (3 CLI-only: logs v2, release status, build logs) | 0 | n/a |
| Mutating (R1/R2) | 11 endpoints / 12 tools (1 CLI-only: release cancel; start & stop share `actions/scale`) | n/a | 0 |

Phase 1 must create `tests/contract/` fixtures only from scrubbed live responses and flip a row's Live cell only with a linked fixture file and a date.

## 7. Phase 1A implementation status (historical — superseded by §8)

Phase 1A implements the read endpoints below in `src/server/liara/` (registry: `endpoints.ts`, projections: `schemas.ts`). **No endpoint has been called against the live API; all "tested" claims refer to synthetic payloads built from the pinned schemas.** Pinned specs were re-compared with upstream on 2026-10-21: `paas.yaml` sha256 `a8b8ab24…` and `me.yaml` sha256 `01d8f1a2…` are unchanged (openapi repo HEAD `338325a4`, cli HEAD `14ec35f7`).

| Endpoint | Contract | Implemented as | Tested (synthetic) | Live |
|---|---|---|---|---|
| `GET /v1/projects` | documented | `listApps` (allowlist-filtered, lenient items) | projection, malformed, allowlist | NOT TESTED |
| `GET /v1/projects/{name}` | documented | `getApp` (env **keys only**) | schema-evolution/canary tests | NOT TESTED |
| `GET /v1/projects/{name}/applets` | documented | `getApplets` | projection, empty | NOT TESTED |
| `GET /v1/projects/{name}/releases` | documented | `getReleases` (page ≤ 50, count ≤ 20) | missing/partial release info | NOT TESTED |
| `GET /v1/projects/{name}/events` | documented | `getEvents` (time inferred from numeric first cell, flagged) | odd shapes | **204 observed live (2026-10-22): reachable, schema UNVERIFIED** — see *Phase 2C* below |
| `GET /v1/projects/{name}/logs` | documented | `getLogsV1` (`since` = unix seconds, **assumption**) | contract mismatch, limits | NOT TESTED |
| `GET /v2/projects/{name}/logs` | **CLI-only** | `getLogsV2`, off unless `LIARA_ALLOW_UNDOCUMENTED_ENDPOINTS=true` + `LIARA_LOGS_API=v2\|auto` | opt-in, auto-fallback rules | NOT TESTED |
| `GET /v1/projects/{name}/metrics/cpu` | documented | `getMetricsCpu` (≤ 10 series, ≤ 240 points, unit "unknown") | empty/garbage metrics | NOT TESTED |
| `GET /v1/projects/{name}/metrics/memory` | documented | `getMetricsMemory` | same | NOT TESTED |

Deliberately **not** implemented in 1A (still in §4 as design): metrics summary/network, domains, plans (`/v1/me`), release/build polling, and every mutating endpoint. The v1/v2 logs discrepancy is handled explicitly: v1 is the default; v2 never runs silently; in `auto` mode v2 is tried only after v1 fails with 404/400/contract mismatch, and the reason is recorded and shown on the diagnostics screen.

New open questions for the first live read-only run: log `since` format; `teamID` query convention; whether the API returns env `value` for `encrypted:true`; vocabularies of `status`, applet `state`/`reason`, release `state`; metric units and timestamp units; event row columns.


## 8. Phase 1B — contract verification status (authoritative)

> **Superseded for the account scope by §9 (Phase 1F live evidence, 2026-10-21).** App-scoped endpoints remain unverified.

**Live verification status (Phase 1B text): BLOCKED.** On 2026-10-21 no `.env.local` and no Liara credentials existed in the environment, so
**no request was sent to `api.liara.ir` in Phase 1B** and **no endpoint is `LIVE_VERIFIED`**. Everything below is either
unchanged documentation, or tooling that is ready to produce live evidence. Simulated (mock) results are never counted as evidence:
`recordOutcome()` ignores mock observations, and the diagnostics screen shows every capability as simulated.

### 8.1 Verification vocabulary (implemented in `src/server/liara/capabilities.ts`)

| Status | Meaning | Set by |
|---|---|---|
| `LIVE_VERIFIED` | An explicit read-only probe succeeded and the response matched the production schema | `verify:liara-readonly` or the diagnostics probe only |
| `DOCUMENTED_UNVERIFIED` | In the pinned OpenAPI; never confirmed live | baseline |
| `CLI_ONLY_UNVERIFIED` | Only in the official CLI source; never confirmed live; opt-in only | baseline |
| `UNAVAILABLE` | Probe got **404** | probe |
| `ACCESS_DENIED` | Probe got **401/403** (never treated as "endpoint absent") | probe |
| `CONTRACT_MISMATCH` | Response did not match our schema | probe |
| (inconclusive) | timeout / network / 5xx / 429 / oversize: **no change** to the status; health shows "failing" | — |

### 8.2 Per-endpoint status

| Endpoint | Contract | Verification now | Live checks performed | What the verification command will record |
|---|---|---|---|---|
| `GET /v1/projects` | documented | DOCUMENTED_UNVERIFIED | none (BLOCKED) | envelope keys, item field types, `status`/platform/`scale` vocabularies, `created_at` format, allowlisted app present?, team-scope behaviour (`--probe-team`) |
| `GET /v1/projects/{name}` | documented | DOCUMENTED_UNVERIFIED | none | field presence/types, `status`, whether `encrypted` env values are masked (value *kind* only), env entry keys |
| `GET /v1/projects/{name}/applets` | documented | DOCUMENTED_UNVERIFIED | none | applet `state` vocabulary, failure-`reason` presence/short vocabulary, timestamp format, `release` keys |
| `GET /v1/projects/{name}/releases` | documented | DOCUMENTED_UNVERIFIED | none | `total` vs returned, ordering, page-2 disjointness, `state`/`type` vocabularies, `currentRelease` kind (tag vs id), timestamp formats |
| `GET /v1/projects/{name}/events` | documented | DOCUMENTED_UNVERIFIED | none | column counts, first-cell time format, whether rows fall inside the requested window (evidence for the unit of `start`/`end`), `metaData` key names, ordering |
| `GET /v1/projects/{name}/logs` | documented | DOCUMENTED_UNVERIFIED | none | item keys/types, `datetime` format, `type` vocabulary, ordering, in-window ratio; with `--probe-formats` the accepted `since` formats (unix s / ISO / unix ms) |
| `GET /v1/projects/{name}/metrics/cpu` | documented | DOCUMENTED_UNVERIFIED | none | pair shape, timestamp/value types, sampling step (min/median/max), last-observation age, value range, any unit-like key, series labels vs applet names |
| `GET /v1/projects/{name}/metrics/memory` | documented | DOCUMENTED_UNVERIFIED | none | same as CPU |
| `GET /v2/projects/{name}/logs` | **CLI-only** | CLI_ONLY_UNVERIFIED (disabled) | none | only with `--include-v2` **and** `LIARA_ALLOW_UNDOCUMENTED_ENDPOINTS=true` |

### 8.3 Contract questions and their current answers

| Question | Current answer | Evidence |
|---|---|---|
| Status enum values | **Unknown.** Displayed verbatim, never interpreted. | none live |
| Scale vs runtime state | Spec: `scale` is on/off (1/0). Runtime comes from applets. Treated as **independent**; "enabled" is never shown as healthy. | spec + design; live relation unverified |
| Applet state / failure reasons | **Unknown vocabulary.** `VERIFIED_APPLET_STATES` is empty. Keyword heuristics produce a labelled interpretation (worst applet wins; a failure-like `reason` overrides "running"). | none live |
| Date/timestamp formats | **Unknown.** Parser accepts ISO-8601 and epoch s/ms/µs/ns defensively and drops values outside 2000–2100. | none live |
| Team ID requirement | **Unverified.** `teamID` query parameter, copied from the official CLI; sent only when `LIARA_TEAM_ID` is set. | CLI source only |
| Pagination and ordering | Releases: `page`/`count` documented (client caps 50/20). Ordering unverified. Events/logs: no pagination parameter exists; results are capped client-side. | spec |
| API error format | **Unspecified** by the spec (empty `content`). The HTTP client now records error-body *structure* (key names) for the report. | spec; live unverified |
| Log `since` parameter | Type string, format unspecified. **Assumption: unix seconds** (as a string). | spec; unverified |
| Metrics schema / timestamps / units | Schema typed only as arrays of `number\|string`. **Units: not stated by the API; no unit is displayed or assumed.** `VERIFIED_METRIC_UNITS` is empty and must be filled only after human confirmation. | spec; unverified |
| Release status vocabulary | **Unknown.** Displayed verbatim. | none live |
| Empty-response behaviour | Handled defensively (empty releases/applets/events/logs/metrics are rendered as empty; metrics distinguish *empty* from *unsupported schema*). Real upstream behaviour unverified. | tests with synthetic payloads |

### 8.4 Observed contract differences

None observed live (no live access). Documentation-level differences retained from Phase 0: v1 logs (`since`, array) vs CLI v2 logs (`start`, `{data:[…]}`); the OpenAPI prose speaks of "instances" while `/actions/scale` is on/off only; the CLI sends more fields than the spec documents for deploy/create (irrelevant to the read-only scope).

### 8.5 Phase 1C entry criteria

1. `npm run verify:liara-readonly` has run live against one disposable allowlisted app with **overall PASSED**, and its (git-ignored) report was reviewed by a human.
2. The matrix rows above are updated with the observed findings (vocabularies, time formats, units evidence, error shapes), each with the date of the run.
3. `VERIFIED_APPLET_STATES` / `VERIFIED_METRIC_UNITS` are populated **only** from reviewed evidence, or the heuristic labelling is explicitly accepted by the operator.
4. At least one reviewed fixture per endpoint lives in `fixtures/reviewed/` (see its README) and `tests/integration/contract.test.ts` passes on it.
5. The `since` format, `teamID` behaviour and encrypted-env masking questions are answered; any 403 on a required endpoint is resolved or the endpoint is dropped from the agent's evidence set.


## 9. Phase 1F — live read-only verification (authoritative for the account scope)

Real GETs against `api.liara.ir` on 2026-10-21 (17 requests, all HTTP 200, GET-only, structure recorded, no values). Full detail: `docs/LIVE_API_VERIFICATION.md`.

| Endpoint | Contract | Live result | Verified structure / restrictions | Tests |
|---|---|---|---|---|
| `GET /v1/projects` | documented | **INCONCLUSIVE** (200, envelope `{projects: []}`) | account sees **0** applications with and without `teamID`; item fields, `status` vocabulary and timestamp format **unverified**; `teamID` effect unproven | `verify-account` |
| `GET /v1/me` | documented (`me.yaml`) | **LIVE_VERIFIED** (structure) | keys `user, team, plans, databaseVersions, defaultDatabaseVersions, featureFlags`; `plans.projects` = 42 objects with `available:boolean`, `RAM{amount,shared}`, `CPU{amount,shared}`, `volume:number`, `price:number`, `region` optional (absent on 14); `projectBundlePlans`; **units NOT stated** (RAM 0.125–64, CPU 0.125–32 look like GB/cores; price unit unknown); `team.balance` is a number; profile/storage keys exist and are dropped by the projection | `verify-account`, contract tests |
| `GET /v1/me/subscription` | documented | **LIVE_VERIFIED** | no plan ⇒ `{currentSubscriptionPlan: {}}` (empty object, key present) | regression test |
| `GET /v1/me/free-credit` | documented | **LIVE_VERIFIED** | `{remainingFreeCredit: number ≥ 0}`; **present although team mode is active** (doc says omitted for teams) | `verify-account` |
| all `/v1/projects/{name}…` (app, applets, releases, events, logs v1, CPU, memory) and `/v2/…/logs` | documented / CLI-only | **NOT_TESTED** | no application to test; allowlist empty; none invented or created | synthetic only |
| billing balance | — | NOT_TESTED | only `team.balance` (type number) via `/v1/me`; no separate endpoint in the pinned specs | — |

Corrections to earlier rows: §4.1 `liara_list_plans` — the six CLI-observed plan fields are now **live-confirmed** (plus undocumented `RAM.shared`/`CPU.shared`); §5 — a documented read of the remaining free credit **does exist** (`/v1/me/free-credit`), contrary to "no balance endpoint"; it is credit, not an invoice balance.

## Phase 2A — write endpoints (implemented, NOT executed)

| Endpoint | Evidence | Implemented | Live status |
|---|---|---|---|
| `POST /v1/projects` | A + C (`bundlePlanID`, `network`, 402/403) | `LiaraWriteClient.createApp` | **NOT_TESTED — never sent** |
| `POST /v2/projects/{name}/sources` | A + C (413) | `LiaraWriteClient.uploadSource` | **NOT_TESTED — never sent** |
| `POST /v2/projects/{name}/releases` | A + C (`platformConfig`, `build`) | `LiaraWriteClient.createRelease` | **NOT_TESTED — never sent** |

Default-disabled; only a recording fake transport exercised them. See `LIVE_DEPLOYMENT_EXECUTOR.md`.

## Phase 2B — preflight findings (2026-10-22; **no live request was made in this phase**)

Legend: **Documented** (pinned OpenAPI) · **Live-verified** (recorded read-only call) · **Fake-tested** (recording fake only) · **Not tested** · **Blocked**.

| Endpoint | Documented | Live-verified | Fake-tested | Status / note |
|---|---|---|---|---|
| `GET /v1/billing` | **yes** — `billing.yaml` (pinned; `user.balance` number, `accountType`, `minCreditAmount`, `isManualMinCredit`, `minCreditLastNotifiedAt`; no `teamID`, **no unit**) | no | yes | **Not tested live.** Added as a documented read (projection keeps only `balance`). Console docs disagree on the unit (billing page: Toman; top-up page: Rial) ⇒ balance is only ever classified |
| `GET /v1/networks` | **no** (absent from `paas.yaml`, `me.yaml`, `billing.yaml`) — CLI `network:list` | no | yes | **Experimental / opt-in.** Response `{networks:[{_id,name,createdAt}]}` (CLI type). Needed because the CLI sends `network._id` on every create |
| `POST /v1/networks` | no (CLI `network:create`) | no | no | **Never called; no code path exists** |
| `GET /v1/me` → `team.balance` | yes (`Team` = User + balance) | structure only | yes | team mode only; only `balance` is projected |
| `POST /v1/projects`, `POST /v2/projects/{name}/sources`, `POST /v2/projects/{name}/releases` | yes (+ CLI-only fields) | **never sent** | yes | **Blocked** until operator steps; see `LIVE_DEPLOYMENT_EXECUTOR.md` §15 |
| `GET v1/releases/{id}`, `GET v2/releases/{id}/build-logs` | no (CLI-only) | no | no | not used (the documented releases list is read instead) |

Pinned specs vs upstream (checked 2026-10-22): `paas.yaml` and `me.yaml` byte-identical to `liara-cloud/openapi@338325a4` (HEAD); `billing.yaml` added to `docs/reference/openapi/`.
Public pricing (liara.ir/pricing, PaaS table): 7 plans, GB / cores / Toman; no billing-start, minimum-balance, zero-balance, VAT or bundle-price statement; no API plan ids. Plan ids are therefore **never** inferred from names or resources.

## Phase 2C — app-scoped verification of `liara-agent-demo` (live observation, 2026-10-22): Events answers HTTP 204

**Exact live observation** (first real app-scoped read-only run, 8 requests, strict report `overall: FAILED` before this correction):

| Capability | Live HTTP status | Strict verdict (before) | Classification now |
|---|---|---|---|
| `listApps` | 200 | LIVE_VERIFIED | LIVE_VERIFIED |
| `getApp` | 200 | LIVE_VERIFIED | LIVE_VERIFIED |
| `getApplets` | 200 | LIVE_VERIFIED | LIVE_VERIFIED |
| `getReleases` | 200 | LIVE_VERIFIED | LIVE_VERIFIED |
| **`getEvents`** | **204 No Content** | CONTRACT_MISMATCH | **INCONCLUSIVE** — endpoint *reached*, schema **unverified**, status **undocumented**; capability health `no_content`; capability verification unchanged (`DOCUMENTED_UNVERIFIED`) |
| `getLogsV1` | 200 | LIVE_VERIFIED | LIVE_VERIFIED |
| `getMetricsCpu` | 200 | LIVE_VERIFIED | LIVE_VERIFIED |
| `getMetricsMemory` | 200 | LIVE_VERIFIED | LIVE_VERIFIED |

* **Documented contract** (`paas.yaml` `getAppEvents`, byte-identical to `liara-cloud/openapi@338325a4`, upstream HEAD on 2026-10-22): `GET /v1/projects/{name}/events?search&start&end` → **200** `application/json` object with a **required `data` array**; 400 / 401 / … error codes. **204 is not documented.**
* **Observed undocumented behaviour:** HTTP **204 No Content** (no payload). We do **not** know whether it means "no events in the window", "events disabled", or something else.
* **Classification rationale.** `LIVE_VERIFIED` would claim a schema nobody saw; `CONTRACT_MISMATCH` would claim a body contradicted the schema when no body existed (and, before this fix, the 204 was indistinguishable from a malformed 200 because the status was lost). Hence **INCONCLUSIVE** with explicit fields: `reachability: reached`, `schemaVerification: unverified`, `undocumentedStatus: 204`, notes that the documented 200 schema was NOT validated and that a 204 does NOT prove zero events. The strict overall verdict becomes `INCONCLUSIVE` (not `PASSED`, and not a hard `FAILED` that would imply the application is unusable).
* **Root cause.** The transport returned `undefined` for a body-less success and handed it to the schema layer, which could only answer "mismatch"; the HTTP status was dropped. Everything downstream (verification, capability state, evidence, dashboard) therefore saw an anonymous `contract_mismatch`. Fixed by an explicit `no_content` error (status kept, body never read or parsed, never retried, never turned into an empty list).
* **Impact on diagnosis.** The events source is recorded as availability **`no_content`** (distinct from `missing` = a 200 with an empty list). It is listed under *missing evidence* with the caveat `no_content_observed`; detectors that need timestamped restart/exit events cannot fire from it; with logs also unusable the diagnosis is `INSUFFICIENT_EVIDENCE`; with logs available the result is at most "no anomaly in the examined evidence (not a health confirmation)" at LOW confidence. All other sources keep working (runs end `COMPLETED_WITH_GAPS`).
* **Remaining verification steps.** (1) Operator-approved events-only re-check (exactly one GET): `npm run verify:liara-readonly -- --app=liara-agent-demo --events-only` (dry run) then `… --events-only --approve-live-readonly`. (2) Re-check after the app has produced events (restart or deployment) — a 200 with `data` would verify the documented schema; a repeated 204 would mean the 204 is the endpoint's normal "nothing to report" answer and the spec should be reported upstream. (3) Never promote the 204 to "zero events" without that evidence.

