# First-Deployment Assistant (Phase 1E — offline, simulation-only)

> **Status.** A beginner can upload a Next.js project as a ZIP, see what it needs, review a plan, approve a **simulated** deployment and watch the whole
> workflow — without touching real infrastructure. Nothing here creates, changes, builds or deploys anything on Liara. Live Liara validation is still
> **pending**, real mutations are **disabled and do not exist**, the "LLM" is the offline mock, real free-form AI is unavailable and the BoxAPI credit is **unused**.

```
ZIP (untrusted) ─▶ guardedUpload ─▶ readZipDirectory (limits, traversal, symlinks, ratio) ─▶ isolated temp dir (non-sensitive files only)
   ─▶ analyzeSource (STATIC) ─▶ buildReadiness ─▶ recommend (preliminary) ─▶ [operator checklist decisions]
   ─▶ buildPlan ─▶ first_deploy proposal ─▶ the EXISTING decide() gate ─▶ simulateDeployment (synthetic) ─▶ timeline + result
                                                                  └──────── authorizeLiveExecution: always refuses
```

It reuses the Phase 1D agent: same `AgentRunManager`, policy table, digest, expiry, drift check, single-use claim, SQLite store and hash-chained audit. A deployment is a
run with `kind: "deployment"`; the plan is a proposal with `operation: "first_deploy"` (R2, typed app name, 15 min).

## 1. Supported input

| Input | Support |
|---|---|
| ZIP of a **Next.js** project with `package.json` at the archive root (one wrapping folder is stripped) | analysed end to end |
| Next.js with `output: 'export'` | analysed; recommends static hosting, no start script required |
| Nuxt, SvelteKit, Astro, Remix/React Router, Gatsby, Angular, CRA, Vite, Node servers, Python, PHP/Laravel, Go, Java, Ruby, .NET, Docker-only | **recognised, reported UNSUPPORTED** (never silently treated as Next.js) |
| Next + another framework in `dependencies` | UNSUPPORTED — *ambiguous*, not guessed |
| Monorepo / project in a sub-folder / no manifest | UNSUPPORTED with an explanation |
| Git URL, GitHub connection | not supported (no verified API) |

Multi-framework support is **not** claimed: only Next.js has analysis, recommendations, plans and simulations.

## 2. Upload safety (`limits.ts`, `zip.ts`, `workspace.ts`, `guardedUpload`)

Authenticated; same-origin; raw `application/zip` body (non-simple content type ⇒ CORS preflight); rate limit; **20 MiB** cap enforced on `Content-Length` *and* while streaming; 20 s read budget;
**6 uploads / 10 min / session**. The archive is parsed with a small in-house reader (no dependency) *before* anything touches disk:

* ≤ 5000 entries, ≤ 80 MiB declared total, ≤ 8 MiB per file, per-entry ratio ≤ 200 (> 1 MiB), overall ratio ≤ 100 — zip-bomb guard.
* rejected: absolute paths, `..`/`.` segments, backslashes, drive letters, control and bidi characters, Windows device names, trailing dots/spaces, over-long/deep paths, **symlinks and special files** (unix mode), duplicate names (case-insensitive), encryption, ZIP64, multi-disk, methods other than stored/deflate.
* inflation uses `maxOutputLength` and verifies declared size and CRC, so **lying headers cannot over-allocate**.
* extraction: `mkdtemp` (0700), files 0600, `O_EXCL|O_NOFOLLOW`, realpath re-check; **only non-sensitive, non-dependency files** are written (`.env*` except templates, `.npmrc`, keys, `*.pem`, credentials, `node_modules`, `.git`, `.next`… are counted but never inflated).
* the directory is removed in `finally` — success, failure or throw (tested).
* **Never**: executing, importing, installing, building, running hooks or Docker, or reading uploaded configuration as instructions.

## 3. Static inspection rules (`analyze.ts`)

* `package.json` is parsed as JSON. JS/TS files are scanned with regular expressions only (`process.env.NAME`, file writes). Nothing is evaluated.
* Only **validated tokens** leave the analyzer: names matching strict patterns, canonical invocations (`npm run build`, never the script body), booleans, counts, relative paths. Free text from the archive (description, keywords, script bodies, config values) is never copied.
* Env variables: **names only**, from `.env.example|.sample|.template|.dist` and `process.env` references; a secret-*looking* value in a template is only flagged (never echoed). Real `.env*` files are never read.
* Instruction-like text in `name/description/keywords/author/homepage/repository/scripts` is flagged as untrusted data and ignored; an invalid or instruction-like `name` falls back to `my-next-app`.
* Every finding carries `source` and `basis` (`declared_in_manifest | file_present | static_inference | not_verifiable`).
* Bounds: ≤ 400 source files, 200 KB each, 6 MB total, ≤ 60 env keys, ≤ 80 findings; truncation is reported.

## 4. Readiness report (`readiness.ts`)

`READY · READY_WITH_WARNINGS · NEEDS_CONFIGURATION · BLOCKED · UNSUPPORTED`, computed by a **pure function** `buildReadiness(analysis, decisions)`:

1. framework unsupported ⇒ `UNSUPPORTED`
2. any blocker (invalid manifest, no routes, **missing build script, missing start script** (not for static export), incompatible Node engine, i18n+export) ⇒ `BLOCKED`
3. a pending *blocking manual* checklist item (required env values, database service, file-based database storage) ⇒ `NEEDS_CONFIGURATION`
4. warnings, security findings, or operator-confirmed manual items ⇒ `READY_WITH_WARNINGS`
5. otherwise `READY` ("no static warnings") — **never** "production-ready"; the static-analysis notice is always shown.

Checklist items have `kind` (auto/manual), `blocking`, `state` and an evidence `class` A–D. The operator may only toggle **manual** items; blockers cannot be overridden; items are locked while a plan is open. Decisions are persisted, audited and included in the drift fingerprint.

## 5. Recommendation limits (`recommend.ts`)

Explainable *preliminary resource guidance*: approach (server vs static export), RAM floor/recommendation (traffic, ORM, constraints), disk hint, background-work caveat, trade-offs, missing information, manual steps.
**No plan id and no price is produced** unless a catalogue with `verified` **and** `unitsVerified` (and `priceUnitVerified` for money) is supplied — Phase 1E never has one (`GET /v1/me` is free-form and unverified), so the gate is covered by tests but unused. Charging, upgrading and purchasing are manual and stated as such.

## 6. Plan, approval and simulation

* `first_deploy` params are a strict schema (`params.ts`): plan id, **artifact digest (first 32 hex of the archive's SHA-256)**, framework, app name, team id (null), platform, plan category, resources, canonical build/start invocations, **env key names**, database flag, readiness basis, step list, `environment: "simulation"`, simulation scenario. No secret value, no free text. The proposal digest covers all of it (and the state fingerprint: artifact, name availability, verdict, decisions).
* Policy: R2, **typed app name**, 15-minute window, `executionMode` must be `simulation`; the target name must be valid and **must not already exist**. A newer plan supersedes (cancels) an open one.
* Approval = the Phase 1D `decide()`: owner binding, expiry, stored-row integrity, presented digest, policy re-check, typed confirmation, drift, atomic single-use claim. Approvals carry `scope: "simulation"`.
* **A simulated approval never authorises anything live**: `authorizeLiveExecution` (live-gate) refuses every input; `requestLiveExecution` is an audited, owner-checked refusal; there is no live executor.
* Simulator (`simulator.ts`): deterministic stages `create_app → validate_config → prepare_artifact → upload_source → create_release → build → runtime_startup → health_check → post_checks`. Scenarios (part of the plan and its digest): `success`, `missing_build_script`, `missing_config`, `insufficient_permissions`, `build_failure`, `startup_failure`, `health_failure`. A failure **interrupts** the workflow (later stages "not run"); the run becomes `FAILED / simulation_failed` and can be re-planned. **No URL and no release id are ever shown**; every line says it is simulated.
* States: `SOURCE_RECEIVED → SOURCE_ANALYZING → READINESS_REVIEW → PLAN_PREPARED → AWAITING_APPROVAL → APPROVED → SIMULATION_RUNNING → SIMULATION_VERIFICATION → SIMULATION_COMPLETED` (+ `REJECTED`, `EXPIRED`, `FAILED`, `CANCELLED`, blocked proposals).

## 7. User experience

In `/agent` («فضای کار عامل»): stepper (upload · analysis · checklist · resources · plan · approval · simulated run · result), verdict badge with plain explanation, static-analysis notice, findings grouped *found / missing / security*, manual checklist with text states (never colour alone), preliminary resources, plan form (name, traffic, test scenario), approval dialog with a readable plan summary (raw JSON under "technical details"), amber (not green) failures, recovery buttons, advanced details (API classification, GitHub note). Chat understands *"می‌خوام پروژه‌ام رو دیپلوی کنم"*, *"این پروژه روی لیارا اجرا می‌شه؟"*, *"برای سایتم چه پلنی مناسبه؟"*, *"قبل از انتشار چه چیزهایی کم دارم؟"*; legitimate deploy requests yield a **safe plan**, while orders against existing apps and policy overrides are still refused.

## 8. Persistence and data minimisation

Stored (sanitised, in the existing SQLite tables): project metadata (name sanitised, counts, 32-hex digest), analysis report, readiness report, recommendation, decisions, plan proposal, approvals, transitions, result, audit rows. **Never stored**: archive bytes, extracted source, env values, `.env*` contents, credentials, raw git data, full session ids. Tested by dumping every table for planted canaries.

## 9. Limitations

Static analysis only; env/DB/storage needs are inferences; Next.js only; `.env` in the archive is deliberately invisible (its *presence* is reported); name collisions can only be checked against apps this service can see (409 on create is the real check); expiry is lazy; upload quota is process-local; the artifact is **not retained** after analysis (a real run would need a fresh, digest-matched upload); no external probe verifies a deployed site; the hash chain is not fully tamper-proof.

## 10. Test scenarios and results

| | Scenario | Evidence |
|---|---|---|
| A | valid Next.js project | `deploy-analyzer`, `deploy-journey`, e2e |
| B | missing start script | same (+ recovery by re-upload) |
| C | environment configuration | same |
| D | database dependency | same |
| E | unsupported / ambiguous | same (10 frameworks, ambiguity, monorepo) |
| F | malicious ZIP (traversal, symlink, bomb, lying size, oversized, encrypted, not a zip) | `deploy-zip` (29), `deploy-journey`, `deploy-routes`, e2e |
| G | rejection | `deploy-journey`, e2e |
| H | expiry, changed parameters, drift, tampering, forged digest | `deploy-journey` (clock-controlled), e2e for forged digest/supersede |
| I | simulated failures (6 scenarios) | `deploy-plan`, `deploy-journey`, e2e |
| J | simulated success | same |
| K | simulated approval replayed against a live target | `deploy-journey` (live gate) |
| L | instruction injection via `package.json` | `deploy-analyzer`, `deploy-journey`, e2e |

Mutation tests flip the verdict by changing single inputs; detection is driven by manifest content, not by fixture names.
