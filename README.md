# Liara AI DevOps Agent — Phase 2B (live deployment executor implemented and preflight-hardened; never executed against Liara)

Persian-first (RTL, responsive, dark-first) dashboard that reads application state from Liara.
**Phases 1A–1D never change infrastructure**: there is no restart, scaling, deployment, env-change or delete code in this build, no write-capable Liara client is ever constructed, and the server refuses to start with `ENABLE_MUTATIONS` enabled. Phase 1D adds a conversational agent whose tools are read-only and whose "actions" are **simulations with synthetic results** that a human may approve — approving never executes anything real. Phase 1E adds a **first-deployment journey**: upload a Next.js project ZIP, see what it needs, review a plan and watch a **simulated** deployment — nothing is built, deployed or contacted. The "LLM" is an offline mock; real free-form AI is unavailable; live Liara validation is still pending; the BoxAPI credit is unused.

> خلاصه: داشبورد فارسی (راست‌به‌چپ) برای مشاهدهٔ برنامه‌های لیارا. فقط‌خواندنی؛ حالت پیش‌فرض «شبیه‌سازی» است و به هیچ اعتباری نیاز ندارد.

## Quick start (mock mode — no Liara credentials)

```bash
npm install
cp .env.example .env.local
npm run hash-password          # prompts (hidden) and prints the escaped APP_ACCESS_PASSWORD_HASH="…" line
# paste that line into .env.local
npm run dev                    # http://localhost:3000
```

Sign in with the password you chose. Mock mode serves **simulated, sanitized** fixtures (`fixtures/mock/`) through the same validation/projection pipeline as live data; every page says so. Without `APP_ACCESS_PASSWORD_HASH`, login is disabled (fail closed).

## Commands

| Command | What it does |
|---|---|
| `npm run dev` / `npm run build && npm start` | Run the app |
| `npm run typecheck` | `tsc --noEmit` (strict) |
| `npm run lint` | ESLint, including custom rules: only `src/server/config` may read `process.env`; no physical-direction Tailwind classes (RTL) |
| `npm test` | Vitest unit + integration tests (1877 at the final hardening pass) |
| `npm run test:e2e` | Playwright (150 tests) against a production build in mock mode, using the system Chrome |
| `npm run verify:liara-readonly` | **Operator-only**, GET-only, budgeted live contract verification (dry run unless approved; see below) |
| `npm run check` | typecheck + lint + unit/integration tests |
| `npm run hash-password` | Generate the operator password hash |
| `npm run record-fixtures` | **Operator-only** live read-only recorder (see below) |

## Phase 2E: existing-app UI and final offline readiness

Persian RTL section for releasing to an **existing** app (authorised targets, identity card, backend choice, cost disclosure, approval preview, timeline) with a three-way mode banner (simulation / live disabled / live enabled); approvals are bound to the app **instance** (recreated app ⇒ stale approvals void); offline settings validation `npm run check:live-settings`; complete rehearsal with fakes. Exact plan and separate approvals for the first real release: [`docs/FIRST_LIVE_RELEASE_PLAN.md`](docs/FIRST_LIVE_RELEASE_PLAN.md). **Nothing was executed live.**

## Phase 2D: releases to an existing app — REST-first hybrid (still nothing executed live)

Decision and evidence: [`docs/DEPLOYMENT_BACKEND_DECISION.md`](docs/DEPLOYMENT_BACKEND_DECISION.md). A new operation kind `deploy_existing_app` releases the approved source to an application that **already exists** (e.g. `liara-agent-demo`) without ever sending a create request. Backend `api` (typed REST, default) or `cli` (the official Liara CLI behind a restricted, allow-listed runner: fixed executable, validated argv array, controlled environment, token only in a private 0600 file, one run, output never parsed). Default OFF; all tests use a recording fake transport or a **fake process runner**.

## Phase 2B: final live-deployment preflight (current status — still read-only / disabled)

Docs: [`docs/LIVE_DEPLOYMENT_EXECUTOR.md`](docs/LIVE_DEPLOYMENT_EXECUTOR.md) · [`docs/FIRST_REAL_DEPLOYMENT_CHECKLIST.md`](docs/FIRST_REAL_DEPLOYMENT_CHECKLIST.md).

* `npm run preflight:liara` (dry run by default; `--approve-live-readonly` authorises at most ~4 GETs) produces a sanitised verdict: `READY_FOR_OPERATOR_APPROVAL` or the highest-priority `BLOCKED_BY_SECURITY / CONTRACT / PRICING / CONFIGURATION`.
* Pricing facts are **cross-checked**, not trusted from configuration: units must be corroborated by the live plan catalogue and the public pricing page; billing semantics that no official source states must be explicitly accepted by the operator (and stay labelled unknown).
* The executor gained: financial acknowledgment, read-before-concluding after HTTP errors, exact-identity check before the allowlist is extended, a `PARTIALLY_VERIFIED` verdict and a per-level evidence table. `LIARA_FIRST_APP_BOOTSTRAP` supports accounts with zero apps.
* **No live write has ever been sent.** `LIARA_LIVE_DEPLOY_ENABLED` is off; all write-path tests use a recording fake transport.

## Phase 2A: live deployment executor (implemented — never executed against Liara)

Design: [`docs/LIVE_DEPLOYMENT_EXECUTOR.md`](docs/LIVE_DEPLOYMENT_EXECUTOR.md); operator steps: [`docs/FIRST_REAL_DEPLOYMENT_CHECKLIST.md`](docs/FIRST_REAL_DEPLOYMENT_CHECKLIST.md).

* **Default OFF.** A typed executor (create application → upload source → create release → verify) exists in `src/server/live/`, but a flag alone never authorises a write: it needs operator-verified plan units, a contract attestation, a network id, a trusted health domain and a **fresh live approval for the exact operation** (typed app name, 10 min, single use). Simulation approvals are permanently invalid in live mode.
* **Safe by construction:** one write surface (three typed methods), one attempt per POST, never a blind retry, reconcile by read, partial resources preserved, no delete/restart/plan change/charge. `DEPLOYED` only when six verification levels are all verified.
* **Persian panel** «استقرار واقعی روی لیارا» in the deployment journey (controls disabled until prerequisites exist). Config in `.env.example` (all off).
* **Phase 2A made zero live requests**; all write-path tests use a recording fake transport, and no AI is used.

## Phase 1E: first-deployment assistant (inside the agent workspace)

Design: [`docs/DEPLOYMENT_ASSISTANT.md`](docs/DEPLOYMENT_ASSISTANT.md); future live contract: [`docs/DEPLOYMENT_EXECUTION_CONTRACT.md`](docs/DEPLOYMENT_EXECUTION_CONTRACT.md).

* **Untrusted ZIP upload**: 20 MiB cap (checked while streaming), entry/size/ratio limits, traversal/symlink/special-file/encryption/duplicate rejection, lying-header-proof inflation, isolated 0700 temp dir that is always removed; sensitive files and dependency folders are never extracted. **Nothing uploaded is ever executed, installed or built.**
* **Static SourceAnalyzer** (Next.js only): package manager, scripts, router, output mode, Node engine, env **names**, database/storage/background hints, Dockerfile/liara.json presence, security warnings. Other frameworks are *recognised and reported UNSUPPORTED*.
* **Readiness verdicts**: READY · READY_WITH_WARNINGS · NEEDS_CONFIGURATION · BLOCKED · UNSUPPORTED, with a manual checklist; always labelled as static analysis, never "production-ready".
* **Preliminary resource guidance**: no Liara plan id or price is shown until a catalogue with verified units exists.
* **Plan + approval**: an immutable `first_deploy` proposal (R2, typed app name, digest-bound, 15 min) through the same approval gate; approvals are scoped to simulation and **can never authorise a live action**.
* **Deterministic simulator** with 7 scenarios; failures interrupt the run; no deployment URL and no release id are ever invented.
* **Persian RTL journey** in `/agent`: upload → analysis → checklist → resources → plan → approval → simulated timeline → result; tested at 360/768/1280 px.

## Phase 1D: agent workspace («فضای کار عامل», `/agent`)

A Persian chat over the same read-only service. Design: [`docs/AGENT_ORCHESTRATION.md`](docs/AGENT_ORCHESTRATION.md) and [`docs/APPROVAL_WORKFLOW.md`](docs/APPROVAL_WORKFLOW.md).

* **Typed read-only tool registry** (9 tools, strict schemas, app-scoped, budgeted, timed out, audited). No mutation tool exists.
* **Deterministic Persian intent parser** (8 intents) — clarifies when ambiguous, explains when unsupported, **refuses** direct commands and approval/policy-override attempts.
* **Bounded planner** and an audited state machine (REQUEST_RECEIVED → … → REPORT_READY → ACTION_PROPOSED → AWAITING_APPROVAL → APPROVED/REJECTED/EXPIRED → SIMULATION_COMPLETED).
* **Approval engine**: R0–R3 policy table, immutable proposals bound to a SHA-256 digest, expiry, single use, replay and cross-app prevention, state-drift detection, session binding, typed app name for R2; a client `approved=true` is rejected, chat text can never approve.
* **Simulator**: synthetic results only, stamped «شبیه‌سازی — هیچ عملیات واقعی انجام نمی‌شود»; the UI always distinguishes plan created / approved / simulation done or failed / verification / *real operation not executed*.
* **Persistence** (SQLite, replaceable): conversations, messages, runs, tool metadata, evidence refs, proposals, approvals, transitions; crash recovery; atomic decisions. The hash-chained audit log is **not fully tamper-proof** (DB writers can recompute it; no external anchor).

## Phase 1C: offline diagnostic assistant («دستیار عیب‌یابی»)

An evidence-based diagnostic workflow over the existing read-only service — **deterministic rules + a strictly offline mock AI provider**. Full design: [`docs/DIAGNOSTIC_ENGINE.md`](docs/DIAGNOSTIC_ENGINE.md).

* **Evidence collector** (7 sources, bounded, explicit availability: available / missing / unsupported / access denied / stale / contract mismatch / collection failed; each item carries freshness, contract verification status and a *simulated* flag).
* **Eight detectors**: crash loop (≥ 3 timestamped cycles; one restart is not a loop), database failures (refused / timeout / DNS / authentication, separate), missing configuration (names only), memory (explicit OOM; unknown units ⇒ no exhaustion claim), CPU (only with verified unit + limit), release regression/failure (correlation ≠ causation), explicit HTTP 500 (counts, no rate), insufficient evidence.
* **Aggregator**: merges, dedupes, tracks contradictions, ranks with HIGH / MEDIUM / LOW / INSUFFICIENT_EVIDENCE (no percentages); every claim cites evidence ids (integrity-checked).
* **Recommendations**: Persian, context-aware, R0–R3, with prerequisites and verification plans — **never executed** (`executableNow: false`, no mutation tool exists).
* **Workflow**: IDLE → COLLECTING_EVIDENCE → ANALYZING → GENERATING_REPORT → COMPLETED (+ partial / fatal / cancelled / timed-out), duplicate-run protection, quotas, timeouts, cancellation, bounded retries, SQLite persistence that survives restarts, hash-chained audit log.
* **Offline AI**: `MockDiagnosticLLMProvider` (deterministic, simulated, no network) and `DisabledLiveLLMProvider` (fail-closed). `AI_LIVE_REQUESTS_ENABLED` is rejected unless false.
* **Nine synthetic scenarios** (`demo-shop`, `demo-api`, `demo-oom`, `demo-cpu`, `demo-badrelease`, `demo-http500`, `demo-stale`, `demo-conflict`, `demo-worker`) with fixture mutation / negative tests.

### Zero-cost guarantee (no paid AI request exists)

No BoxAPI or other AI endpoint is contacted, ever: there is no AI client in the code base, no AI SDK dependency, no AI API key variable, and `AI_LIVE_REQUESTS_ENABLED=false` is enforced at startup. This is **tested, not just documented**: every unit/integration test runs under a global network guard that makes any `fetch`/socket attempt fail the suite (`tests/helpers/network-guard.ts`); `tests/integration/zero-cost.test.ts` scans the source for AI hosts/SDKs, checks `package.json` and `.env.example`, runs all nine scenarios through the pipeline asserting zero network attempts, and proves the live-provider flag is rejected and the disabled provider performs no I/O.

## Phase 1F: authorized live read-only verification — results (2026-10-21)

First contact with the real Liara API (17 GETs, all HTTP 200, structure recorded, no values): authentication works (team-scoped), `/v1/me`, `/v1/me/subscription`, `/v1/me/free-credit` are **LIVE_VERIFIED** (plan catalogue: 42 plans projected; **units still unverified**), and `/v1/projects` answered but the account has **zero applications**, so it is **INCONCLUSIVE** and **every app-scoped endpoint (runtime, releases, events, logs, CPU/RAM) is NOT_TESTED**. Diagnostic accuracy on real faults is therefore **not verified**. New: `npm run verify:liara-readonly -- --account-only [--probe-team]` (no app or allowlist needed). Details and next steps: [`docs/LIVE_API_VERIFICATION.md`](docs/LIVE_API_VERIFICATION.md).

> **`.env.local` gotcha (found live):** Next expands `$name` even inside single quotes, so the old single-quoted hash line was silently truncated to `scrypt`. `npm run hash-password` now prints the escaped, double-quoted form (`\$` for every `$`) — paste it exactly. If you created the hash with an earlier version, regenerate it. The e2e suite no longer reads `.env.local`.

## Authorized live read-only verification (Phase 1B workflow)

**Status today: BLOCKED** — no credentials existed when Phase 1B was built, so nothing has been verified against the real API.
Mock results are never live evidence. The steps below produce that evidence without ever sending a credential to chat.

1. In the Liara console create a token (ideally in a dedicated team that contains only the apps this tool may read).
2. `cp .env.example .env.local && chmod 600 .env.local`, then edit `.env.local` yourself:
   ```
   LIARA_DATA_SOURCE=live
   LIARA_API_TOKEN=<token>
   LIARA_ALLOWED_APPS=app-one              # explicit names; "*" is rejected
   LIARA_TEAM_ID=<team id>                 # only if the apps belong to a team
   APP_ACCESS_PASSWORD_HASH="…"            # npm run hash-password
   ```
   The tool never switches from mock to live by itself.
3. **Dry run** (prints the plan, sends nothing, exit 4):
   ```bash
   npm run verify:liara-readonly -- --app=app-one
   ```
4. After reading the plan, approve it explicitly (≈ 10–25 GET requests, budget-capped):
   ```bash
   npm run verify:liara-readonly -- --app=app-one --approve-live-readonly
   ```
   Optional probes: `--probe-formats` (accepted `since` formats), `--probe-team` (team-scope behaviour, counts only), `--include-v2` (undocumented CLI endpoint; also requires `LIARA_ALLOW_UNDOCUMENTED_ENDPOINTS=true`), `--budget=N` (8–60).
5. The command prints a verdict table (never names, ids or secrets) and writes a structure-only report to `fixtures/recorded/verification-*.json` (git-ignored). Review it, then share only what you are comfortable with — it contains vocabularies, formats, counts and ages, not payloads.
6. Exit codes: `0` PASSED · `1` FAILED/INCONCLUSIVE · `2` bad config/usage · `3` BLOCKED (no live credentials) · `4` not approved (dry run).
7. Open **وضعیت اتصال** in the app to see per-capability verification levels (`LIVE_VERIFIED`, `ACCESS_DENIED`, `CONTRACT_MISMATCH`, …) and connection state.
8. Optional sanitised recording (double opt-in): set `LIARA_ALLOW_RECORDING=true` and run `npm run record-fixtures -- --app=app-one --approve-recording`. Output lands in `fixtures/recorded/` with a `REVIEW.md`; **nothing is promoted automatically** — see `fixtures/reviewed/README.md`.

Verification statuses: `LIVE_VERIFIED` · `DOCUMENTED_UNVERIFIED` · `CLI_ONLY_UNVERIFIED` · `UNAVAILABLE` (404) · `ACCESS_DENIED` (401/403 — never "absent") · `CONTRACT_MISMATCH`. Details: `docs/API_CAPABILITY_MATRIX.md` §8.

Production on Liara: set the same variables in the app settings (never in the repo), keep `TRUST_PROXY_HEADERS=true` only because Liara's proxy sets `X-Forwarded-*`, and run a single instance.

## Architecture (as implemented)

```
src/
  app/                    Next.js App Router: pages, route handlers, layout (lang=fa dir=rtl)
    (dashboard)/…         apps overview, app detail, diagnostics — every page calls requireSession()
    api/…                 GET-only data routes + POST login/logout + GET health
  components/             UI (shadcn/ui, base-ui, lucide) — no business logic
  i18n/fa.ts              Persian message catalogue
  lib/                    cn(), fa-IR number/Jalali date formatting
  server/
    config/env.ts         the only reader of process.env; zod; fails closed
    security/             secret wrapper, redaction, scrypt passwords, sessions, rate limits, guard, logger
    liara/                endpoints registry (all GET) → http client → schemas/projections → read client
                          → service (allowlist, capability tracking) ; fixture transport (mock) ; recorder
    domain/models.ts      the only shapes allowed to leave the integration layer
tests/                    unit, integration (routes, service, read-only proofs), e2e (Playwright)
```

Data flow: `UI/route → LiaraService (allowlist) → LiaraReadClient → Transport (live HTTP | fixtures) → zod schema = safe-field projection → redaction → Section<T>`.

## Security model (what is enforced and tested)

- **Token** is held in a `Secret` (never serialises/inspects), read only in `config/env.ts`, used only inside `LiaraHttpClient`; never sent to the browser, logs or errors.
- **Egress**: one class, `get()` only (no other HTTP verb exists in it); registered GET endpoints only; host pinned to `api.liara.ir`; redirects never followed; timeouts, response-size caps, ≤2 retries for transient GET failures, concurrency + RPS limits.
- **Allowlist** checked before any upstream call; unknown / malformed / non-allowlisted names are indistinguishable (404). The account-wide app list is filtered before leaving the service.
- **Projection**: schemas are strip-mode zod objects — unknown upstream fields (even future sensitive ones) are dropped. Env values are never projected; only well-formed key names. Free text (logs, events, release messages, applet reasons) is redacted and length-capped.
- **Redaction** also masks env values / the token by HMAC fingerprint (values are not retained), strips ANSI/bidi tricks, and is linear-time on adversarial input.
- **Auth**: single operator, scrypt hash, opaque server-side sessions in an `HttpOnly; SameSite=Strict` cookie (`Secure` + `__Host-` in production), idle + absolute timeouts, login throttling (per client behind a trusted proxy, plus global), same-origin + JSON checks on POST, per-session API rate limit, `Cache-Control: no-store` on API responses.
- **Read-only proof**: source-scan tests (no child_process/eval, only two own-origin `fetch` call sites, no write verb or body in the Liara client, only GET handlers on data routes) plus a runtime replay of hostile requests (method-override headers, odd params, POST bodies) asserting every upstream call is a bodiless GET to an allowed path.

## Phase 1B: what changed

- Independent state display: **configuration (enabled/disabled) · runtime (from applets) · health evidence (unavailable)**. A scaled-on app whose applet is restarting is red, never green; green appears only for a running runtime with no failure evidence.
- Metrics: raw values, **no unit unless verified** (none yet), last successful observation, gap-aware lines (no interpolation), stale/sparse/empty/unsupported states.
- Connection states: simulated · connected · degraded · auth failure · endpoint unavailable · contract mismatch · unreachable · stale · unknown.
- Every dynamic section shows its fetch time and ages visibly on the client (stale warning after 2 minutes).
- Redaction: DB URLs (incl. password-only), cookies, secret query strings, plus a *shareable* mode that pseudonymises hosts/IPs/paths.
- Recorder: double opt-in, fail-closed validation, review manifest. Verification command with budgets and approval gate.
- Dependencies: shadcn CLI removed (CSS vendored). Production audit clean; one dev-only `braces` advisory chain remains (no patched release) — see `docs/SECURITY_POLICY.md` §13.4.

## Automated results (Phase 1E)

| Check | Result |
|---|---|
| `tsc --noEmit` | clean |
| `eslint .` | clean |
| `vitest` | 1047 passed (37 files; Phase 1E adds +212: ZIP safety 29, analyzer 52, plan/recommend/simulator/strategy 35, journey A–L 53, routes 15, UI 10, intent 14, scans; earlier 1D breakdown: +198 in Phase 1D: parser 39, policy/simulator 28, tools/planner 25, workflow/approval/persistence 47, routes 8, adversarial 26, UI 14, scans and redaction) |
| Playwright (Chrome, mock mode) | 111 passed (34 new for the first-deployment journey: scenarios A–L over the real UI, hostile uploads, dialogs, axe, keyboard, 360/768/1280 px, reduced motion, isolation; 28 for the agent: scenarios A–G, dialogs, axe, keyboard, 360/768/1280 px, reduced motion, session isolation; plus auth, dashboard, operational honesty, assistant runs for all scenarios, evidence details, axe A/AA, 360/768/1280 px no overflow, keyboard, reduced motion) |
| `next build` | passes |
| `npm audit --omit=dev` | 0 vulnerabilities |
| `npm audit` (full) | 5 high, single root cause (`braces ≤ 3.0.3` under `eslint-config-next`), dev-only, no patched version |
| Live Liara verification | **BLOCKED — never run** (contract still unverified) |
| Paid / live AI requests | **0** (none can be made; enforced and tested) |
| Real infrastructure operations | **0** (no write client exists; a recording transport shows only read endpoints are touched) |

## What is implemented vs verified

| Area | Implemented | Verified how |
|---|---|---|
| 8 documented read endpoints + 1 opt-in CLI-observed (v2 logs) | yes | unit/integration tests against **synthetic** payloads shaped like the pinned OpenAPI. **Not tested against the real Liara API.** |
| Mock mode & dashboard | yes | integration + 20 Playwright tests (Chrome), axe WCAG A/AA, 360/768/1280 px overflow checks |
| Live mode & verification command | yes | **Unverified live.** Command tested against synthetic upstreams and for its blocked / dry-run paths only. |
| Diagnostic engine, assistant UI, persistence | yes | tests on **synthetic** data only; live evidence quality is unverified |
| First-deployment assistant (upload, analysis, plan, simulation) | yes | 212 + 34 tests on **synthetic** projects; static analysis only; no real build, deployment or Liara call |
| Agent orchestration, approvals, simulator | yes | 835 + 77 tests; the executor is a **simulation** — nothing real is executed or verified live |
| Fixture recorder | yes | unit-tested with hostile payloads; **never run against a live account** |

## Known limitations and risks

- **Live API behaviour is unverified.** Open items (also in `docs/API_CAPABILITY_MATRIX.md` §7): `since` format of the v1 logs endpoint (unix seconds assumed), `teamID` as a query parameter (copied from the official CLI), units/timestamps of metric series, event column layout, status/state vocabularies, whether `encrypted` env values are masked upstream.
- Status shown to users is derived only from documented fields (`scale`, `isDeployed`); the raw `status` text is displayed verbatim and never interpreted. Metrics are shown as raw values with “unit unknown”.
- No horizontal scaling, rollback or HTTP-status metrics exist in the API, and none are faked (listed in diagnostics).
- Sessions, login throttling and capability state are **in memory** (single instance; lost on restart). Without `TRUST_PROXY_HEADERS` login throttling is one global bucket, so an attacker can lock the operator out for up to 15 minutes.
- CSP keeps `script-src 'unsafe-inline'` because Next injects inline bootstrap scripts; a nonce-based CSP is deferred.
- Redaction is heuristic (defence in depth, not proof). Novel secret formats embedded in free text may survive; env **values** are masked only when seen via the app-detail call of the same process.
- Dark theme only (no light theme). Persian only.
- `npm audit --omit=dev` is clean. The full audit reports 5 high advisories with ONE root cause (`braces ≤ 3.0.3` under `eslint-config-next`, dev-only, no patched release exists) — not claimed clean; see `docs/SECURITY_POLICY.md` §13.4.
- Mock logs intentionally contain obviously fake secret-looking strings to demonstrate redaction.

## Phase 1C entry criteria (see matrix §8.5)

1. Live `verify:liara-readonly` run with overall PASSED on a disposable allowlisted app, report reviewed.
2. Matrix updated with observed vocabularies, formats, units evidence, error shapes; `VERIFIED_*` tables filled only from reviewed evidence.
3. At least one reviewed fixture per endpoint in `fixtures/reviewed/`.
4. `since`, `teamID` and encrypted-env masking questions answered; no required endpoint left in ACCESS_DENIED.

## (Historical) Phase 1B scope as recommended after 1A

1. Run the authorized live read-only check (above); commit scrubbed recordings as contract fixtures; flip matrix rows to READ-OK.
2. Persistence (SQLite on a Liara disk) for audit log, sessions and runs; nonce-based CSP.
3. Evidence bundle + deterministic detectors (app stopped, crash loop, error burst, missing config) over the existing read client — still no mutations.
4. Provider-agnostic LLM gateway with a mock provider; structured Persian diagnosis citing evidence ids.
5. Only then: approval service and the first R1 mutation (restart) with verification, per `docs/SECURITY_POLICY.md`.

## Phase 2 entry criteria (HISTORICAL — written in Phase 1; superseded by Phase 2A/2B and the first-deployment checklist)

1. A live `verify:liara-readonly` run with overall PASSED, reviewed; matrix §8 updated; `VERIFIED_APPLET_STATES` / `VERIFIED_METRIC_UNITS` filled **only** from reviewed evidence (otherwise the heuristic labelling is explicitly accepted).
2. Plan catalogue (`GET /v1/me`) read and unit/limit semantics verified, so CPU/memory saturation can be judged with real limits.
3. Detector thresholds reviewed against at least one real incident/log sample (reviewed fixtures in `fixtures/reviewed/`).
4. Approval service and policy engine exist (Phase 1D, simulated). Before any real executor: a separate backend behind its own flag and policy gate, documented idempotency/rollback, verified post-action checks, external audit anchoring and per-person identities (see `docs/AGENT_ORCHESTRATION.md` §10). First candidate: a single R1 restart on a disposable app.
5. Decision on LLM use (only then, and only with an explicit, separate budget approval): the provider interface already isolates it.
