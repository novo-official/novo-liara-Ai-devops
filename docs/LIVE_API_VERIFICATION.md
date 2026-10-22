# Live API Verification (Phase 1F — authorized, bounded, READ-ONLY)

> Evidence below comes from **real GET requests to `api.liara.ir`** made on **2026-10-21 (UTC)** with the operator's own token (team-scoped), under the explicit authorization
> "bounded, READ-ONLY verification". Nothing was created, changed, restarted, deployed or purchased. No AI request was made and BoxAPI was never contacted.
> Credentials, the team id and every response *value* are deliberately absent from this document; only **structure, types and counts** are recorded.

## 1. Preflight (nothing printed from `.env.local`)

| Item | Result |
|---|---|
| `.env.local` | present, mode 0600, git-ignored |
| `LIARA_DATA_SOURCE` | `live` — valid |
| `LIARA_API_TOKEN` | present; JWT-shaped (3 parts), no whitespace/quotes — **value never displayed** |
| `LIARA_TEAM_ID` | present, plausible id — **value never displayed** |
| `LIARA_ALLOWED_APPS` | present **but empty** (0 apps) |
| `APP_ACCESS_PASSWORD_HASH` | present **but empty** (web UI login not configured; irrelevant to the verifier) |
| `AI_LIVE_REQUESTS_ENABLED` / `ENABLE_MUTATIONS` | `false` / `false` — **safety requirements met** |
| `AI_PROVIDER` | `mock` |
| host / redirects | `api.liara.ir` over https; redirects are never followed; `LIARA_ALLOW_UNDOCUMENTED_ENDPOINTS=false`, `LIARA_LOGS_API=v1`, recording off |

The existing runner was **BLOCKED** (exit 3, no network) because live mode demands a non-empty allowlist and a UI password. The user's settings were **not modified**.

## 2. What was added so that an account with no application can be verified

`npm run verify:liara-readonly -- --account-only [--probe-team] [--approve-live-readonly]`

* Four documented GETs: `/v1/projects`, `/v1/me`, `/v1/me/subscription`, `/v1/me/free-credit` (the last three are in the pinned `me.yaml`; asserted by a test). Optional `--probe-team`: one more `GET /v1/projects` **without** `teamID`, **count only**.
* `loadConfig(env, { verification: true })` relaxes **only** the allowlist and UI-password requirements, and only for this script. Everything else still applies (https + trusted host, token, mutation/AI flags, wildcard rejection). The server never passes the option; tests prove the normal loader still rejects.
* Dry run first (exit 4, no request); the live run needs `--approve-live-readonly`; budget ≤ 25 requests **including retries**, concurrency ≤ 2, ≤ 2 req/s, timeouts and retries bounded, redirects refused, method fixed to `GET`.
* `GET /v1/me` is **projected inside the adapter** (zod strip mode): `user`, `team`, `storage.{accessKey,secretKey}` and everything but `plans.projects`/`projectBundlePlans` are dropped; `plans.projects` is *required*. Observations record field **names and types**, never values. Fixture recording approves **nothing** for these endpoints.
* Tests (written and green **before** the first live call): 26 in `verify-account.test.ts` (relaxation scope, GET-only plan, projection, 401/403/404/redirect/non-JSON/5xx handling, budget, no-leak canaries), 5 script-level tests (dry run, blocked paths, flag combinations).

## 3. Live results

**17 real GET requests in total (4 + 4 + 5 + 4 across four runs; each run ≤ 25), all HTTP 200, none retried.**

| Endpoint | HTTP | Schema | Verdict |
|---|---|---|---|
| `GET /v1/projects` | 200 | envelope `{projects: []}` valid | **INCONCLUSIVE** — HTTP/auth proven, but **zero applications** are visible (with and without `teamID`), so the per-item contract is **unverified** |
| `GET /v1/projects` (without `teamID`, `--probe-team`) | 200 | same | count 0 as well; whether `teamID` changes anything is **unproven** |
| `GET /v1/me` | 200 | projection valid | **LIVE_VERIFIED** (structure; units NOT verified) |
| `GET /v1/me/subscription` | 200 | projection valid | **LIVE_VERIFIED** |
| `GET /v1/me/free-credit` | 200 | projection valid | **LIVE_VERIFIED** |
| all app-scoped endpoints (details, applets, releases, events, logs v1/v2, CPU, memory) | — | — | **NOT_TESTED** (no application; allowlist empty; no name was invented, none created) |
| billing balance | — | — | only `team.balance` inside `/v1/me` (documented): type **number**, amount not recorded. No separate balance endpoint exists in the pinned specs ⇒ NOT_TESTED |

### 3.1 Verified structure (no values)

* **Authentication**: bearer token accepted on all four paths; team mode is active (`team` object present).
* **`/v1/me`** top-level keys: `user, team, plans, databaseVersions, defaultDatabaseVersions, featureFlags`. `plans` keys: `projects, projectBundlePlans, databaseBundlePlans, databases, objectStorage, legacyStorageService, mail, subscription`.
  * `plans.projects`: **42** entries, every one an object with `available` (boolean; 15 true / 27 false), `RAM{amount, shared}`, `CPU{amount, shared}`, `volume` (number), `price` (number); `region` (string) present on 28, **absent on 14**. All six CLI-observed field names are therefore **live-confirmed**, and `RAM.shared` / `CPU.shared` are **new, undocumented** keys. The adapter projected 42/42.
  * `projectBundlePlans`: 11 entries. `databaseVersions`: 9 engines. `featureFlags`: 31 (array).
  * **Units**: `RAM.amount` ranges 0.125–64 and `CPU.amount` 0.125–32 — *consistent with GB and cores*, but the API states **no unit**, so units are **not verified**; `price` unit (hourly/monthly, currency) is **not verified**. The projection hard-codes `verified:false, unitsVerified:false`; the deployment recommender therefore still shows no plan id or price.
  * `team` fields (names only): `_id, teamName, teamCreator, accountType, balance(number), isTeam, joined_at, minCreditAmount, isManualMinCredit, minCreditLastNotifiedAt, invoiceIssuingEnabled, teamMemberRole, teamMemberPermissions, privateNetworkFeature, legacyNetworkFeature, legacyObjectStorageFeature`. `user` exposes 25 profile field names (incl. `storage`, which holds access keys) — **never read**.
* **`/v1/me/subscription`**: with no active plan the body is `{"currentSubscriptionPlan": {}}` (key present, **empty object**).
* **`/v1/me/free-credit`**: `{"remainingFreeCredit": <number ≥ 0>}`.

### 3.2 Observed contract differences (and the fixes)

| # | Difference | Impact | Resolution |
|---|---|---|---|
| 1 | No account-only verification existed; live mode refused an empty allowlist / empty UI password | verification impossible for an account without apps | `--account-only` + verification-mode config (above) |
| 2 | Subscription "no plan" is `{currentSubscriptionPlan: {}}`, not `{}` | a naive projection reported "has an active plan" | `hasActivePlan` requires an id/type; `null`/`{}`/absent all mean inactive; regression test; observation `currentSubscriptionPlanKind` |
| 3 | An empty application list proved auth + envelope but nothing about items | a green "LIVE_VERIFIED" would overclaim | zero items ⇒ **INCONCLUSIVE** with an explicit note; regression test |
| 4 | `free-credit` is documented as omitted for teams, but was **present** (number) with team mode active | docs wrong or token behaves as personal | recorded; field treated as optional; amount never recorded |
| 5 | `plans.projects[*].region` absent on 14/42 plans; `RAM.shared`/`CPU.shared` undocumented | consumers must not assume `region` | projection returns `region: null`; tests |
| 6 | `me.yaml` documents `/v1/me*` while the registry assumed project paths only | contract/static tests rejected the new paths | tests updated to check `/v1/me*` against `me.yaml` |
| 7b | **Operator hash line (found while investigating #7)**: `npm run hash-password` printed `APP_ACCESS_PASSWORD_HASH='scrypt$…'` claiming single quotes keep `$` intact — **false for Next's loader**, which truncated the value to `scrypt` (every UI login would fail on live) | web UI unusable with the printed line | now prints the escaped double-quoted form via `envLineFor`; round-trip test against `@next/env` incl. regression of the old form |
| 7 | **e2e coupling (found while running regressions)**: with a real `.env.local` present, Playwright's server inherited it and Next's dotenv-expand mangled the `$` in the generated scrypt hash (declared-but-empty variable) ⇒ 108 e2e failures | test suite depended on the developer's file and could read a live token | e2e server now sets Next's `__NEXT_PROCESSED_ENV` so env files are skipped; 111/111 pass **with** the real `.env.local` present |

## 4. Agent compatibility

| Component | Live status |
|---|---|
| Transport/auth/redaction/budget (`LiaraHttpClient`) | **proven live** on four endpoints (200s, bounded, GET-only, redirects refused) |
| Account projections, plan catalogue structure | **proven live** (42/42 plans projected) |
| `LiaraService.listApps` / agent `list_apps` | envelope proven; **no items ever seen live**; with an empty allowlist the agent (correctly) sees no application |
| Application details, applets/runtime assessment, releases, events, logs, CPU/RAM metrics, timestamps, vocabularies | **NOT_TESTED live** — fixtures and synthetic payloads only |
| Diagnostic detectors, evidence collector, agent tools/planner | exercised on mock/synthetic data only; **diagnostic accuracy is NOT verified** (no real fault evidence exists) |
| Deployment readiness workflow | independent of Liara reads; unchanged (plan catalogue stays unverified ⇒ no ids/prices) |
| Data labelling | unchanged and tested: every evidence item carries `mode` (`live`/`mock`), `simulated`, `verification` (`DOCUMENTED_UNVERIFIED` until a probe) and availability (missing/unsupported/…). Real, mock, unverified and missing data stay distinguishable; there is no mock-to-live fallback (tested). |

## 5. Security validation

* The token exists only in `.env.local` (0600, git-ignored) and in the verifier process; the request logger records endpoint, status and duration only; the reports were scanned: **no token, no team id, no `@`**. A scan of the whole working tree (268 files, excluding `node_modules`/`.next`) found **no copy** of the token or team id.
* Raw responses are never stored; reports hold structure only; fixture recording stays off and approves nothing for account endpoints.
* No write method exists: the registry is GET-only (static test), the client fixes `method:"GET"`, redirects are refused, the account-only plan has no app-scoped path, and 17/17 live requests were GETs.
* Allowlist cannot be bypassed: app mode still refuses a name outside it (tested via the script); account mode never forms an app path.
* The relaxed config is script-only: the normal loader still rejects missing allowlist/password (tested).

## 6. Remaining assumptions / what is still unverified

Item-level `GET /v1/projects` contract and status vocabulary · every app-scoped endpoint (runtime, applet states/reasons, releases, events, logs, metrics, units, timestamp formats, `since` format, env masking) · `teamID` behaviour · plan RAM/CPU/price units · whether `free-credit` presence in team mode is stable · release/build endpoints used by a future deployment.

## 7. To finish verification

Add **one** existing application name to `LIARA_ALLOWED_APPS` (a disposable one is best) and run, in this order:
`npm run verify:liara-readonly -- --app=<name>` (dry run) → `… --approve-live-readonly` (add `--probe-formats` once to settle the `since` format). Set `APP_ACCESS_PASSWORD_HASH` (`npm run hash-password` — paste the printed, `\$`-escaped line **exactly**; regenerate any hash made before this fix) to use the web UI against live data.

## 8. Phase 2A (no live contact)

Phase 2A made **zero** live requests of any kind (read or write): all tests use fixtures and a recording fake transport. Open questions to settle in Phase 2B before the first real deployment: network id source, required-ness of CLI-only create/release fields, plan units and billing start, release/runtime state vocabularies.

## 9. Phase 2B (final preflight — no live contact in this phase)

* Official sources were compared on 2026-10-22: OpenAPI HEAD = pinned commit; CLI 9.6.0. Findings are in `DEPLOYMENT_EXECUTION_CONTRACT.md` ("Phase 2B corrections") and `API_CAPABILITY_MATRIX.md` ("Phase 2B").
* **To collect the live evidence** (operator, explicit authorisation each time): `npm run preflight:liara` (dry run) then `npm run preflight:liara -- --approve-live-readonly [--include-networks] [--plan=<id>] [--app=<name>]`. It performs only GETs (≤ budget, default 8) and writes classes only (no balance amount, no names) to `fixtures/recorded/`.
* Still unverified live: `GET /v1/billing` shape, `GET /v1/networks`, release/runtime state vocabularies, required-ness of the CLI-only write fields, billing start/minimum balance.

## 10. Phase 2C — first app-scoped live verification and the Events 204 finding (2026-10-22)

* **Run:** `npm run verify:liara-readonly -- --app=liara-agent-demo --approve-live-readonly` (operator-run, 8 GETs): `listApps`, `getApp`, `getApplets`, `getReleases`, `getLogsV1`, `getMetricsCpu`, `getMetricsMemory` → **200, LIVE_VERIFIED**; `getEvents` → **204** → *CONTRACT_MISMATCH* in the old classification, overall FAILED.
* **Correction (code):** HTTP 204/205 is now an explicit `no_content` observation. The strict report separates **reachability** from **schema verification** (`reachability`, `schemaVerification`, `undocumentedStatus`, plus `findings.reachability`), classifies a 204 as `INCONCLUSIVE` (overall `INCONCLUSIVE`), never as `LIVE_VERIFIED`, and keeps historical reports valid (the new fields are optional).
* **What a 204 does NOT prove:** that there are zero events, that the endpoint is healthy, or that the documented 200 schema is correct. What it does prove: the endpoint was reached with our token and team scope and returned no payload.
* **Operational impact:** none for the other seven capabilities; the dashboard shows a *warning* panel for events; capability health `no_content`; connectivity `degraded` (never `connected`, never "unusable").
* **Narrow re-check (needs explicit approval):** `npm run verify:liara-readonly -- --app=liara-agent-demo --events-only` prints its plan — **exactly one** `GET /v1/projects/liara-agent-demo/events?start&end` — and sends nothing; add `--approve-live-readonly` to run it. Re-run it after the app has produced events.
* **Still unverified:** the 200 events item shape (`metaData`, `values`) against a real non-empty answer; whether 204 is the normal empty answer; the `search` parameter.

## 11. `preflight:liara` — strict arguments and the existing-app mode (Phase 2F fix)

* **Finding:** the script's parser silently ignored unknown flags, and `--app` meant "name of a NEW app to create" and appeared nowhere in the dry run, so `--app=liara-agent-demo` printed only `GET /v1/projects` and `GET /v1/me`.
* **Now:** `--app=<name>` selects the **existing-application** mode and the dry run lists every GET: `/v1/projects`, `/v1/me`, `/v1/projects/<name>` (instance id, creation time, plan, platform, network, default-domain flag, scale), `/v1/projects/<name>/releases?page=1&count=10` (baseline), optional `/v1/networks` (undocumented, opt-in). The identity/release GETs are shown as SKIPPED when the app is not in `LIARA_ALLOWED_APPS`. `--new-app=<name>` keeps the old creation semantics; no flag keeps the account flow. Any unknown flag, positional argument, duplicate, missing/invalid value or contradictory combination is an error (exit 2).
* Nothing captured earlier is trusted; the report carries a **fresh identity digest** (12 hex) and hints only. The REST release-field attestation (`LIARA_LIVE_CONTRACT_ATTESTED`) is reported as a blocking contract check with its explanation and is never bypassed.

