# Diagnostic Engine (Phase 1C — offline, read-only)

Evidence-based diagnosis of operational problems from Liara data, using **deterministic rules** and a **strictly offline mock AI provider**.
Nothing here calls a paid or live AI service, and nothing here changes infrastructure.

> **Status of evidence.** The Liara live API has **not** been verified yet (`docs/API_CAPABILITY_MATRIX.md` §8). Everything the assistant shows in
> this repository is computed from **synthetic mock fixtures** and labelled *simulated*. Live mode exists and uses the same code path, but its
> contract (vocabularies, units, formats) stays *unverified* until `npm run verify:liara-readonly` has been run and reviewed.

## 1. Pipeline

```
request {app, intent}                         src/server/diagnostics/
  └─ RunManager.start()    validate · allowlist · duplicate/concurrency/quota · persist         workflow.ts
      └─ collectEvidence() read-only LiaraService only · bounded · explicit availability       evidence.ts
          └─ detectors A–H pure functions over sanitised evidence                              detectors/*.ts
              └─ aggregate()  merge · dedupe · contradictions · confidence · ranking           aggregate.ts
                  └─ recommend()  context rules · R0–R3 · never executable                     recommend.ts
                      └─ buildNarrative()  OPTIONAL offline provider; text only                report.ts, llm/*
                          └─ buildReport() → sanitise → SQLite (sanitised only) + audit chain  report.ts, store.ts
```

The deterministic engine (`analyze()` in `engine.ts`) is synchronous, offline and fully useful **without** any LLM.

## 2. Supported requests (closed set)

| Intent | Evidence collected | Detectors |
|---|---|---|
| `why_restarting` — «چرا برنامهٔ من مدام ری‌استارت می‌شود؟» | app, runtime, events, logs, releases, memory | crash loop, database, missing config, memory, release, insufficient |
| `why_slow` — «چرا وب‌سایت من کند است؟» | app, runtime, cpu, memory, logs, events, releases | cpu, memory, database, release, http 500, insufficient |
| `investigate_http_500` — «بررسی احتمال خطای HTTP 500» | app, runtime, logs, events, releases, memory | http 500, database, missing config, release, crash loop, memory, insufficient |
| `recent_deployment_failures` — «تحلیل شکست‌های اخیر استقرار» | app, runtime, releases, events, logs | release, crash loop, missing config, database, http 500, insufficient |

There is **no free-text reasoning**. Any other intent is rejected (`unknown_intent`, HTTP 400); the UI offers radio buttons only and says so.

## 3. Evidence schema

Every item is an `EvidenceItem` (`types.ts`), one per source per run, id `"<runId>/<source>"`:

| Field | Meaning |
|---|---|
| `id`, `source`, `capability`, `app`, `runId` | identity; `capability` is the Liara capability that produced it (e.g. `getLogsV1`) |
| `mode`, `simulated` | `mock` ⇒ `simulated: true`. Shown everywhere. |
| `collectedAt`, `window` | fetch time and the examined time window (`null` for app/runtime/releases) |
| `availability` | see below |
| `freshness` | `{state: fresh\|stale\|unknown, newestObservation, ageSec}` |
| `verification` | contract status at collection time (`DOCUMENTED_UNVERIFIED`, … `LIVE_VERIFIED`). Mock never exceeds the unverified baseline. |
| `data` | structured, sanitised, bounded (≤ 200 log lines, ≤ 100 events, ≤ 10 releases, ≤ 240 points/series) or `null` |
| `errorCode`, `notes` | collection error (code only) and notes such as `empty_response`, `unit_unverified` |

`availability` values (never collapsed — each has a different diagnostic meaning):

| Value | When |
|---|---|
| `available` | data present |
| `missing` | the API answered successfully with **no observations** |
| `unsupported` | 404 / disabled opt-in endpoint / a metric schema we cannot interpret |
| `access_denied` | 401 / 403 (never treated as "absent") |
| `stale` | metrics whose newest point is older than max(5 min, 5 sampling steps) — retained but **not used** by detectors |
| `contract_mismatch` | response did not match the expected contract |
| `collection_failed` | timeout, network, 5xx, 429, oversize, budget, cancellation |

Raw API data never crosses the boundary: the collector only calls the existing allowlist-enforcing, strict-projection, redacting `LiaraService`.
One attempt per source (the HTTP client already performs bounded retries), ≤ 3 sources in parallel, ≤ 8 sources per run, 10 s per source.

## 4. Detector rules

Thresholds are constants in the detector files and are covered by tests.

| # | Detector (`hypothesis`) | Rule | Never does |
|---|---|---|---|
| A | **Crash loop** (`crash_loop`, `isolated_restart`) | Restart/exit signals from timestamped **events** and/or **exit lines in logs**; signals < 30 s apart are one cycle. **≥ 3 cycles = loop** (strong if both sources agree or the runtime is `restarting`, else moderate). 1–2 cycles = `isolated_restart` (weak). | Call a single restart a loop; infer a loop from a runtime *state* without timestamps. |
| B | **Database** (`db_connection_refused`, `db_connection_timeout`, `db_dns_failure`, `db_authentication_failure`) | Log/event lines **with database context** (scheme, driver, port, "database") classified into four separate categories; strength by count (1 weak, 2 moderate, ≥ 3 strong). | Count generic network errors without DB context; expose credentials or private hosts (excerpts are shareable-redacted: hosts → `host-N`). |
| C | **Missing configuration** (`missing_configuration`) | Extracts variable **names** (KeyError, `process.env.X`, "Missing required environment variable", Django `ImproperlyConfigured` …); cross-checks against the app's configured env **keys**. Strong = named **and** absent; moderate = key exists but still fails (value unverifiable). | Read, request or show values; attach log excerpts (none are kept). |
| D | **Memory** (`oom_kill`, `memory_exhaustion_in_process`, `memory_growth_unverified`, `memory_pressure`) | Explicit OOM signal in events / applet reason / logs ⇒ strong. Exit code 137 ⇒ moderate **inference**. JS-heap/`MemoryError` ⇒ in-process exhaustion. Metric: **unknown units** ⇒ only a *weak* "raw growth" observation (≥ 10 points, ≥ 1.5×, ≥ 80 % non-decreasing); **verified unit + known limit** ⇒ `memory_pressure` if the last 5 points ≥ 90 % of the limit. | Claim exhaustion from raw values; use stale metrics. |
| E | **CPU** (`cpu_saturation`) | Only with a **verified unit and a known limit**: last 5 points ≥ 90 % of the limit ⇒ moderate inference ("utilisation is not latency"). | Compute any percentage from unknown units; fire without a limit. |
| F | **Release** (`release_failed`, `release_regression`) | `release_failed`: a failed-looking release ≤ 72 h old (moderate; weak if a newer successful release superseded it; says whether it ever became current). `release_regression`: ≥ 5 error signals after the latest release and a rate ≥ 3× a clean baseline of ≥ 5 min before it (moderate), or weak without a baseline. | Prove causation: correlation is **at most moderate** and always carries `correlation_not_causation`. |
| G | **HTTP 500** (`http_500`) | Explicit 500 in access-log-style lines, framework messages (`Internal Server Error`, `statusCode: 500`). Reports **counts** in the sampled lines; other 5xx counted separately. | Compute an error rate (the API has no request totals or status metrics); match `500ms`, `port 5000`, `500 rows`. |
| H | **Insufficient evidence** (`insufficient_evidence`) | No usable timeline (logs **and** events unusable) ⇒ states why, per source availability. | Let silence read as health. |

## 5. Confidence and ranking (`aggregate.ts`)

Four levels only: **HIGH · MEDIUM · LOW · INSUFFICIENT_EVIDENCE**. No percentages anywhere.

| Finding | Confidence |
|---|---|
| observation, strong, ≥ 2 independent evidence sources — or an explicit unambiguous signal (explicit OOM; variable named **and** confirmed absent) | HIGH |
| observation, strong, one source · observation, moderate | MEDIUM |
| observation, weak · `memory_growth_unverified` · `isolated_restart` | LOW |
| inference (strong or moderate) | MEDIUM (never higher) · weak inference LOW |
| **cap:** any recorded contradiction | ≤ MEDIUM |

**Merge rules** (components stay visible in `merged`, observations and inferences are kept separate):

| Rule | Condition | Result |
|---|---|---|
| `R-LOOP-OOM` | crash loop + OOM | `restart_loop_oom_kill`; HIGH if explicit OOM and loop HIGH, else MEDIUM |
| `R-LOOP-CONFIG` | crash loop + named-missing config (≥ moderate) | `restart_loop_missing_configuration`; HIGH if both HIGH |
| `R-LOOP-DB` | crash loop + DB failure (≥ moderate) whose errors **precede** restarts | `restart_loop_<db category>`; HIGH if ≥ 50 % of cycles are preceded by a DB error within 2 min, loop HIGH and ≥ 3 DB lines; MEDIUM if ordering is unverifiable; LOW if < 50 % |
| `R-HTTP-RELATED` | 500s co-occurring with DB / config / loop / OOM | adds a weak "possibly related" inference to `http_500` |

**Contradictions** (tracked, cap at MEDIUM, listed in the report): `conflicting_db_categories` (≥ 2 DB categories at ≥ moderate); `runtime_running_older_than_restarts` (all instances "running", older than the claimed restarts, no failure reason).
**Ranking:** confidence, then cause priority (merged loops > OOM > config > DB > 500 > release > cpu/memory), with an intent-aware boost. **Statuses:** `ISSUES_FOUND`, `NO_ANOMALY_IN_EXAMINED_EVIDENCE` (explicitly *not* "healthy"), `INSUFFICIENT_EVIDENCE`.
**Citation integrity:** `assertCitationIntegrity()` fails the run if any hypothesis, finding, contradiction, missing-evidence entry or recommendation cites unknown evidence, or a non-insufficient hypothesis cites none. LLM narratives are held to the same rule.

## 6. Recommendation policy (`recommend.ts`)

Each recommendation has: id (`rec_<hash>`), related diagnosis, evidence ids, Persian description, expected impact, risk (R0–R3), prerequisites, verification plan, `requiresApproval`, `actor`, and `executableNow: false` — **always**.

* **R0** observe / manual operator step · **R1** restart-class · **R2** configuration, plan or deploy change · **R3** never recommended.
* `requiresApproval` ⇔ risk ≠ R0. R1/R2 items are `liara_operation_future`: nothing in Phase 1C can execute them (no mutation tool exists).
* Context rules: DB failures never yield a memory/plan upgrade; authentication failures recommend fixing credentials, not a restart; a restart appears only **after** the DB cause is fixed, is labelled not guaranteed, and is suppressed inside a restart loop; missing-config advice names variables only and says the operator enters the values (this tool never asks for or sees them); OOM advice is investigate → plan change (R2, prerequisites) → restart only as a temporary mitigation; unverified memory growth recommends **verifying units**, not changing the plan; "no rollback API" is stated for release advice; insufficient evidence yields only R0 guidance tailored to *why* (denied / unsupported / failed).

## 7. Workflow state machine (`workflow.ts`)

`IDLE → COLLECTING_EVIDENCE → ANALYZING → GENERATING_REPORT → COMPLETED` (forward only; `NEXT` table enforced).
Terminal statuses: `COMPLETED`, `COMPLETED_WITH_GAPS` (partial evidence), `FAILED`, `CANCELLED`, `TIMED_OUT`.

| Concern | Behaviour |
|---|---|
| Authorization | session required; runs belong to the creating session (stored as `sha256` only); others get 404 |
| Allowlist | checked before any record or upstream call; unknown/malformed/non-allowlisted ⇒ identical 404 |
| Duplicates | one active run per app (`run_in_progress` 409 + `X-Existing-Run`); `start()` is serialised so concurrent requests cannot both pass |
| Limits | ≤ 2 concurrent runs (config), 10 runs per 10 min per session, ≤ 8 sources, ≤ 200 log lines |
| Timeouts | 30 s per run, 10 s per source, 3 s for the narrative |
| Cancellation | abort signal; `CANCELLED`; idempotent; owner only |
| Retries | no automatic retries in the engine; manual `retryOf` only for FAILED / GAPS / TIMED_OUT, same app, max 2 retries in a chain |
| Partial failure | missing sources become explicit evidence; `COMPLETED_WITH_GAPS` |
| Fatal failure | all sources denied ⇒ `FAILED(access_denied)`; all unusable ⇒ `FAILED(no_usable_evidence)`; crash ⇒ `FAILED(analysis_error)` (stable code, never the message). A report is still produced when possible. |
| Observability | per-step status (`collect_logs`, `inspect_runtime`, `review_releases`, `analyze_metrics`, `identify_hypotheses`, `prepare_report`) persisted on every change; the UI polls `GET /api/diagnostic-runs/:id` |
| Never | shell commands, arbitrary HTTP tools, any Liara write |

## 8. Persistent run model (`store.ts`)

`RunStore` interface (replaceable by PostgreSQL); `SqliteRunStore` uses Node's built-in `node:sqlite` (no native add-on; **Node ≥ 22.13**, prints an experimental warning) at `DIAGNOSTICS_DB_PATH` (default `./data/diagnostics.sqlite`, file mode 0600, git-ignored); `MemoryRunStore` for tests.

* `runs(id, owner_hash, app, status, created_at, updated_at, record_json)`; `audit(seq, at, run_id, event, data, prev_hash, hash)` — SHA-256 hash chain, verified by `verifyAudit()`.
* **Persisted:** run id, app, intent, window, mode, status/phase, per-step status, transitions, sanitised report (hypotheses with citations, recommendations, evidence *summaries* and ≤ 5 cited excerpts per item), sanitised audit events (ids, statuses, counts).
* **Never persisted:** API tokens, raw API responses, whole logs, env values, credentials, session ids. Everything passes `sanitizeForStore()` (shareable redaction of every string) before it is written.
* Records survive restarts; runs that were in flight when the process died are marked `FAILED(interrupted_by_restart)` on startup.

## 9. Offline AI provider (`llm/*`)

`DiagnosticLLMProvider` → `MockDiagnosticLLMProvider` (deterministic, simulated, no network, no credentials; behaviours `ok | error | timeout | invalid_output | cites_unknown_evidence | malicious_extra_fields` for failure tests) and `DisabledLiveLLMProvider` (fails closed, no I/O).
`resolveProvider()` can only return those two. `AI_LIVE_REQUESTS_ENABLED` other than false is **rejected at startup**; `AI_PROVIDER` accepts only `mock | disabled`.

The provider gets **sanitised structured context** (hypotheses, Persian observations, evidence ids) plus a separate, capped `untrustedExcerpts` field, and returns **text only**: its output is validated (non-empty, ≤ 2000 chars, extra fields stripped, citations must exist, instruction-like text rejected). A narrative can never add an action, a recommendation or a risk change, and the report is complete without it. The UI labels the text *simulated*.

## 10. Real versus simulated

| | Real | Simulated |
|---|---|---|
| Engine logic, detectors, aggregator, recommendations, workflow, persistence, UI | ✔ (implemented and tested) | |
| Liara data in mock mode | | ✔ (`fixtures/mock/*`, nine scenarios) |
| Liara data in live mode | ✔ read-only, **contract unverified** | |
| Narrative text | | ✔ (mock provider; never a real model) |
| CPU units/limit for `demo-cpu` | | ✔ (`semantics.ts`, tagged `simulated_fixture`) |
| Production metric semantics | verified table is **empty**, plan limits not collected ⇒ saturation/exhaustion claims are impossible by construction | |

## 11. Known diagnostic limitations

* No live evidence yet; applet/release vocabularies are keyword heuristics, labelled as such.
* Metric units and capacity limits are unknown ⇒ no CPU saturation or memory exhaustion claim in production.
* No HTTP request totals / status metrics ⇒ only explicit log counts; no error rate; no health probes.
* Logs are capped at 200 lines ⇒ counts are lower bounds; quiet periods look like "no anomaly".
* Pattern matching is English/framework-specific (Python, Node, common DBs); other stacks will yield "no anomaly" or "insufficient", never invented causes.
* Redaction is heuristic: excerpts are shareable-redacted and short, but a novel secret format inside a *cited* excerpt could survive. Missing-config findings keep no excerpts for this reason.
* Correlation (release, DB-before-restart) is not causation; the report says so and caps confidence.
* In-process, single-instance execution: no distributed queue; runs interrupted by a restart are marked failed, not resumed.
* `node:sqlite` is experimental in Node 22/24.

## 12. Reproduce the demo

```bash
npm install
cp .env.example .env.local        # defaults: mock data, AI_PROVIDER=mock, AI_LIVE_REQUESTS_ENABLED=false
npm run hash-password             # paste the printed APP_ACCESS_PASSWORD_HASH="…" line (with its \$ escapes) into .env.local
npm run dev                       # http://localhost:3000 → «دستیار عیب‌یابی»
```

| Scenario app | Request | Expected |
|---|---|---|
| `demo-api` | چرا برنامهٔ من مدام ری‌استارت می‌شود؟ | `restart_loop_db_connection_refused` — HIGH |
| `demo-oom` | same | `restart_loop_oom_kill` — HIGH, plus `memory_growth_unverified` — LOW |
| `demo-cpu` | چرا وب‌سایت من کند است؟ | `cpu_saturation` — MEDIUM (simulated units) |
| `demo-badrelease` | تحلیل شکست‌های اخیر استقرار | `release_failed` — MEDIUM (never became current) |
| `demo-http500` | بررسی احتمال خطای HTTP 500 | `http_500` — MEDIUM + injection caveat |
| `demo-conflict` | restart | two DB categories + runtime contradiction — MEDIUM, with contradictions |
| `demo-stale` | slow | no anomaly; metrics stale |
| `demo-shop` | restart | no anomaly in examined evidence (not "healthy") |
| `demo-worker` | restart | insufficient evidence |

Tests: `npm test` (637), `npm run test:e2e` (49), scenario definitions in `tests/scenarios/scenarios.ts`.

## 13. Reuse in Phase 1D

The agent's tools use `createSourceCollector` (extracted from `collectEvidence`), `analyze`, `buildNarrative` and `buildReport` unchanged. `Recommendation.operation` (typed `restart_app | change_plan | update_env | deploy_release`
with schema-valid params, only when derivable from evidence) is the *only* input from which a simulated proposal can be built. `executableNow` remains `false` for every recommendation.
