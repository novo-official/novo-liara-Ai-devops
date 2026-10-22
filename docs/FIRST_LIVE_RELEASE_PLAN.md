# First live release to `liara-agent-demo` — exact execution plan (NOT executed)

> Status: prepared offline in Phase 2E. **Nothing in this document has been run.** `LIARA_LIVE_DEPLOY_ENABLED` is off, no source was uploaded, no release was created, no application was created. The target application was **recreated manually by the operator**: no identity, approval or baseline captured before that is trusted — every fact is re-read and bound afresh.

## 1. What will happen (and only this)

Two real write requests, nothing else, each sent **once**:

1. `POST /v2/projects/liara-agent-demo/sources` — the deterministic tar.gz built from the approved demo ZIP (REST backend).
2. `POST /v2/projects/liara-agent-demo/releases` — `{sourceID, port: 3000, type: "next", platformConfig: {}, build: {"cache": true}, gitInfo: {all-null object, tags: []}}` (documented: sourceID/port/type; CLI-only: the other three — see `REST_RELEASE_CONTRACT_REVIEW.md`).

Never sent: `POST /v1/projects` (createApplication), plan change, resize, scale, restart, delete, domain or network calls, balance/payment calls. Everything else is `GET`.

## 2. Preconditions the operator sets (this tool never edits `.env.local`)

Run `npm run check:live-settings` (offline) to see the current state. Observed on 2026-10-22 (values only where non-secret):

| Setting | Current | Needed for the release |
|---|---|---|
| `LIARA_DATA_SOURCE=live`, token, team | set | keep |
| `LIARA_ALLOWED_APPS` includes `liara-agent-demo` | yes (allowlist size 1) | keep — the tool never adds it |
| `LIARA_LIVE_DEPLOY_ENABLED` | `false` | `true` **only at step 6** |
| `LIARA_LIVE_CONTRACT_ATTESTED` | not set | `true` after you read the three CLI-only release fields (`platformConfig = {}`, `build = {"cache":true}`, all-null `gitInfo`) in `REST_RELEASE_CONTRACT_REVIEW.md` §3 |
| `LIARA_APP_DOMAIN_SUFFIXES` | **empty** | the app's default domain: `liara.run` if the app has a network, `iran.liara.run` if not (the panel's identity card and `npm run preflight:liara` show which) |
| `LIARA_LIVE_HEALTH_MARKER` | **not set** | `liara-agent-demo` (the demo's `/health` returns `{"status":"ok","app":"liara-agent-demo","version":"1"}`) |
| `LIARA_LIVE_HEALTH_PATH` | `/health` | keep |
| `LIARA_CLI_ENABLED` | `false` | **keep false** (CLI fallback is never enabled automatically) |
| `LIARA_PLAN_UNITS_JSON`, `LIARA_NETWORK_ID` | — | **not needed** for an existing app |

## 3. Steps and approval boundaries

| # | Step | Writes? | Who/what authorises |
|---|---|---|---|
| 0 | `npm run check` / `test:e2e` / `build` green on the exact checkout | no | — |
| 1 | `npm run check:live-settings` — offline validation of suffix, marker, path, probe host | no | — |
| 2 | **Approval A (read-only):** `npm run preflight:liara -- --app=liara-agent-demo --approve-live-readonly` (exactly 4 GETs: `/v1/projects`, `/v1/me`, `/v1/projects/liara-agent-demo`, `/v1/projects/liara-agent-demo/releases?page=1&count=10`; classes/hints only) — shows the target's network ⇒ expected suffix | no | your separate sentence (§6.A) |
| 3 | Set the three settings above in `.env.local` yourself; restart the server | no | you |
| 4 | Build `npm run demo:zip`; upload it in the agent workspace; readiness must be READY | no | — |
| 5 | In the panel «انتشار روی برنامهٔ موجود»: select `liara-agent-demo`, backend **REST API** (default), re-select the same ZIP, create the proposal — all identity checks must be green (instance, plan, platform, running, default subdomain, suffix, marker) | no | the tool |
| 6 | **Approval B (the write):** set `LIARA_LIVE_DEPLOY_ENABLED=true`, restart; the banner turns red «اجرای واقعی فعال»; open the approval preview, read every binding, type the exact app name `liara-agent-demo`, approve (valid 10 minutes, single use) | no (authorises) | your separate sentence (§6.B) + typed name |
| 7 | Re-select the same ZIP and press «شروع اجرای واقعی» — **the only moment writes occur** (exactly two POSTs, once) | **yes** | the approval of step 6 |
| 8 | Watch the six-level ladder; only `DEPLOYED` is success | no | — |
| 9 | Set `LIARA_LIVE_DEPLOY_ENABLED=false` again | no | you |

## 4. Possible charges (be explicit)

* **No new application, no plan change, no network change** — the existing plan's running cost simply continues (its hourly price is whatever your plan costs; the public PaaS page lists Earth 1,041 / Mars 1,805 / Jupiter 3,194 Toman per hour, but the API plan id is **not** mapped to those names, so the exact figure for this app is unverified).
* **Build and traffic cost of the release: not stated by any official source** (unknown).
* **Bundle limits:** each deployment consumes the daily deployment quota of the feature bundle (e.g. 20/day for the base bundle); a source above the bundle size limit (128 MB base) is rejected (our artifact is far smaller).
* **VAT and minimum-balance behaviour: not stated** by the official sources. If the account balance is too low Liara may answer 402/400 (`frozen_project`): the release is rejected, nothing is charged by this tool, and it **never tops up** the account.

## 5. Risks and recovery

| Risk | What the tool does | What you do |
|---|---|---|
| A CLI-only release field is wrong → HTTP 400 on the release | definite rejection; the releases list is re-read; if nothing new → `FAILED`; the uploaded source is inert; the app and its current release are untouched | read the cause; optionally pin the CLI fallback (separate decision, §6.C) |
| Timeout / 5xx / redirect on a POST | **never retried**; reconcile by reading the releases list against the baseline; exactly one new id → adopted and verified; none/several → `NEEDS_OPERATOR_REVIEW` | check the console; «بررسی دوبارهٔ وضعیت» (read-only) or «رها کردن» (keeps everything) |
| The app is deleted/recreated, scaled to 0, plan/platform/network/subdomain changed, or someone else deploys during the 10-minute window | the approval is void (fingerprint) and, at execution, instance/baseline are re-proven before any write → `FAILED`, zero writes | create a fresh proposal |
| Release created but build fails / unhealthy | ladder shows `FAILED`; nothing is deleted or rolled back automatically | inspect build logs in the console; Liara keeps the previous release serving |
| Health probe cannot verify (wrong suffix, subdomain disabled, marker missing) | never `DEPLOYED`; `PARTIALLY_VERIFIED` / review | fix the setting; re-verify (read-only) |
| Process restart mid-run | operation becomes `NEEDS_OPERATOR_REVIEW`; nothing resumes automatically | as above |

Kill switch at any time: set `LIARA_LIVE_DEPLOY_ENABLED=false` (no write path exists then) — before step 7 nothing has been sent.

## 6. The separate approvals required (each is a distinct message to the assistant; none exists yet)

**A — read-only preflight:** *«Approved: run `npm run preflight:liara -- --app=liara-agent-demo --approve-live-readonly` (GET-only; the 4 planned GETs shown by the dry run).»* (Dry run first: `npm run preflight:liara -- --app=liara-agent-demo`.)

**B — first real release (REST):** *«I approve ONE real release to the existing application liara-agent-demo using the REST backend: one source upload and one release creation, no application creation, CLI fallback disabled. I have set LIARA_LIVE_CONTRACT_ATTESTED, LIARA_APP_DOMAIN_SUFFIXES and LIARA_LIVE_HEALTH_MARKER myself and accept the unknown build/traffic costs.»* — followed by the in-app typed name and approval of the specific proposal digest (the chat message never replaces it).

**C — CLI fallback (only after a definite REST rejection):** a new, separate message naming the pinned CLI version and entry hash.

## 7. Remaining blockers before step 6

1. `LIARA_APP_DOMAIN_SUFFIXES` and `LIARA_LIVE_HEALTH_MARKER` unset (above). 2. `LIARA_LIVE_CONTRACT_ATTESTED` unset. 3. Approval A not given, so the recreated app's real identity/network (and therefore the right suffix) has not been read live yet. 4. Events endpoint still answers 204 (informational; not a blocker for the release, but release/health evidence is the verification path). 5. Approval B not given.

## UX note (existing-app page)
The `/agent` page now has an offline preview that needs neither the live flag nor the contract attestation, and a next-action card that lists the exact operator steps. See `docs/EXISTING_APP_UX.md`. The preview is not an approval; Approval A and Approval B above are unchanged.
