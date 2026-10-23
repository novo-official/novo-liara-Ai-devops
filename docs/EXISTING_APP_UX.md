# UX of the existing-app deployment workflow (`/agent`)

Scope: the page a trusted operator uses to take an analysed project ZIP and release it to an application that **already exists** in Liara (for example
`liara-agent-demo`, created by hand). Nothing in this document changes what is *allowed*; it changes what the operator *sees and does*. Every approval,
digest, drift and typed-name rule from `APPROVAL_WORKFLOW.md`, `LIVE_DEPLOYMENT_EXECUTOR.md` and `DEPLOYMENT_BACKEND_DECISION.md` is unchanged.

## What was wrong (observed)

| # | Problem | Cause |
|---|---|---|
| 1 | Existing-app release and new-app creation were one very long page | one `LiveDeploymentPanel` rendered both, under the whole simulation journey |
| 2 | New-app pricing / network / plan-unit blockers looked like blockers of the existing-app release | the create-flow prerequisite list sat next to the existing-app section |
| 3 | After the ZIP analysis it was unclear what to do next | no single "next action"; seven cards of equal weight |
| 4 | Preview and real execution were not separated | one "propose" button, disabled for several unrelated reasons |
| 5 | Up to four ZIP inputs (analysis, new version, existing form, new-app form, execute box) | each form re-asked for the archive |
| 6 | Next.js dev overlay: **"3 Issues"** | one real bug, see below |

### The "3 Issues" (root cause, not a warning to dismiss)
`src/components/deploy-journey.tsx`, `Checklist`: a `<details>` (with `<summary>`) was rendered **inside a `<p>`**. That is invalid HTML; React reports it as
a hydration error and prints three messages for it (`<details>` in `<p>`, `<summary>` in `<p>`, the hydration mismatch). It cannot show up in the production
build the e2e suite uses (React only validates nesting in development), which is why every earlier test was green. The `<p>` is now a `<div>`.
Regression guard: `tests/helpers/html-nesting.ts` is a small HTML content-model checker and `tests/unit/html-nesting.test.tsx` runs it over the server-rendered
markup of the deployment panel and of the live panel in every mode/state (blocked, preview, pending, approved, finished, new-app, preview card).

## The new page

```
تحلیل سورس (verdict, framework; long finding lists folded when the verdict is READY)
┌ tabs (role=tablist, roving tabindex, ←/→ RTL-aware, Home/End) ─────────────────────────────┐
│ انتشار روی برنامهٔ موجود [پیشنهادی] │ شبیه‌سازی [طرح باز] │ ساخت برنامهٔ جدید (پیشرفته) │
└────────────────────────────────────────────────────────────────────────────────────────────┘
```

* **Existing app (default, primary)** — mode banner → **next-action card** → 5-stage stepper → analysis → **the one ZIP control** → target → backend →
  the two readiness lists → cost disclosure → **offline preview** → approval request → proposal card / timeline.
* **Simulation** — the former journey (checklist, recommendation, plan, simulated approval, timeline, result). Unchanged behaviour.
* **New app (advanced)** — preflight, prerequisites (units, network, billing), plan table, proposal form. Pricing/network blockers exist **only** here.

A run that opens *blocked* has no tabs at all (only the checklist can help) and is not moved away when fixing it unlocks the live paths.
The "upload a new version" card is folded under the journey; it is a different action (a new analysis), not an input of the deployment.

### One next action
`src/lib/live-next-action.ts` (pure, unit-tested) maps the page state to exactly one of:
`fix_source → choose_zip → wait_hash → fix_zip → choose_target → fix_target → run_preview → operator_enable_live → create_request → approve_pending → execute_approved → wait_in_progress → done_verified / review_failure`.
When the blocker is configuration the card lists the **exact operator steps** (for example `LIARA_LIVE_DEPLOY_ENABLED`, `LIARA_LIVE_CONTRACT_ATTESTED`) and says
they happen outside this page: the tool never changes configuration, never sets the attestation and never enables live execution.

### Two different kinds of readiness (never mixed)
* **A — source and target (read-only)**: analysis OK, the selected ZIP is the analysed one, the target app passes its checks. *Enough for a preview.*
* **B — execution prerequisites**: live flag, live data source, token, REST write path (or CLI identity), contract attestation, health domain and marker.
  *Needed for an approval request and for execution.* Shown in a separate list.

### Offline preview vs. execution

| | Offline preview | Approval request | Approval | Execution |
|---|---|---|---|---|
| needs live flag / attestation | **no** | yes | yes | yes |
| fresh archive re-uploaded and re-verified by the server | **yes** | yes | digest only (tamper check) | **yes** |
| persists anything (proposal, operation, approval) | **no** | yes | yes | yes |
| contacts a Liara write endpoint | **never** | never | never | yes (after approval) |
| human typed-name approval | — | — | **yes** | requires it |

`LiveDeploymentService.previewExisting` runs the same `bindSource` pipeline as `createExistingProposal` (the ZIP must be the analysed archive, the analysis must
reproduce byte-for-byte, the deterministic artifact is built), reads the target through the read-only reader **only when the data source is live**, and returns
the digests that *would* be bound, `targetReady`, the execution prerequisites and `executable`. It is reached through the existing
`POST /api/agent/live/proposals` with `X-Live-Kind: preview_existing_app` (the route set is unchanged). It is explicitly labelled *not an approval*; its
digests cannot be used to decide or execute (`live_not_found`), and it goes stale in the UI as soon as the file, target or backend changes.

### One ZIP control
`components/artifact-binding.tsx`. The analysed `File` is carried from the upload card in browser memory only; the control shows name, size, the first 16 hex of its
client-side SHA-256 and whether it equals the analysed archive (`artifactDigest32`). Preview, request, the new-app form and **execute** all use this one selection.
This client comparison is a convenience only: **the server re-hashes, re-analyses and rebuilds the artifact at every step and refuses a different archive**
(`live_artifact_mismatch`). After a page reload the file is gone and must be selected again — deliberately.

## Finding fixed on the way: approval digests reached the browser as `[REDACTED]`
`redactDeep` (applied to every API response) masks 64-hex strings except under the keys `digest` and `stateFingerprint`. The live approval dialog and the new
preview show the SHA-256 of the ZIP, the analysis digest and the artifact digest (and for the CLI backend the argv/manifest digests) so a human can compare what
they approve — but those fields were arriving as `[REDACTED]`. The allowlist now also contains exactly `zipSha256`, `analysisDigest`, `artifactDigest`,
`argvDigest`, `manifestDigest`, `entrySha256` (content hashes of the operator's own files, never secrets); the same value under any other key is still redacted
(`tests/unit/redact.test.ts`, `tests/integration/live-existing-preview.test.ts`).

## Tests added/updated
* `tests/unit/html-nesting.test.tsx` + `tests/helpers/html-nesting.ts` — HTML validity of all server-rendered states (the "3 Issues" regression).
* `tests/unit/live-next-action.test.ts` — priority order, stage states, operator-step texts, artifact helpers (+ WebCrypto digest equals Node's).
* `tests/unit/live-ui.test.tsx` — one file input, no create-flow content on the primary path, separated gate lists, preview card, execute needs the same file.
* `tests/integration/live-existing-preview.test.ts` — preview with live OFF, persists nothing, writes nothing, refuses a different archive / other session, reports target problems without throwing, mock source, determinism, no secret, digests survive redaction.
* `tests/e2e/existing-path.spec.ts` — tabs semantics and keyboard, single input, mismatch flow, next-action/stages/gates, preview over the real route with exactly one live request, server refusal, folded analysis, layout at 360/768/1280 with the preview open, axe.
* `tests/e2e/deploy.spec.ts`, `live.spec.ts` — adapted to the tabs; axe now runs on all three paths.

## Result persistence, evidence provenance and the mode banner (2026-10-23)
**Problem.** A successful re-verification moved the operation to `DEPLOYED` (`active=0`). The lock card disappeared, the `/resolve` answer was discarded, and the new run (no proposal of its own) fell back to "run the offline preview" — a real success was invisible.

* **Result card** (`ResultCard`, `src/lib/live-result.ts`): the answer of `/resolve` is *validated* (`parseOperationResponse`: same id, known state, six ladder levels, bounded strings — anything else ⇒ "outcome uncertain", never success) and handed to a parent that outlives the lock card (`DeploymentPanel`, so even a tab switch keeps it). `DEPLOYED` ⇒ verified success with release id and ladder; `NEEDS_OPERATOR_REVIEW` ⇒ warning, never success; `FAILED`/abandoned ⇒ failure. A failed status refresh keeps the confirmed result and shows a banner.
* **History across runs:** `status.lastResults` = latest `DEPLOYED`/`FAILED` operation per application, read from persisted records only (no verification, no polling, no audit write). Scope: this team, application inside the operator's scope, and records this session may see (own, or owner login gone — the `recoveryAccess` rule); the latest is chosen among *all* owners first so an invisible newer record never makes an older one look current. History is never a lock. The page shows it as «آخرین نتیجهٔ استقرار این برنامه» with a "record" badge; next step becomes `deployed_previously` (no automatic proposal; the preview button stays available).
* **Provenance of "runtime started"** (`assess()` in `verify.ts`, persisted as optional `evidence` on the operation JSON — no migration, strict schema `.optional()`): `observed` (applets list read), `inferred` (applets unreadable + marker-verified HTTPS answer of the current READY release), `unknown`. Records written before this change have no `evidence`; they are shown as **"not recorded"** — provenance is never guessed. The UI states that an applets-API error does not invalidate the independent HTTP health check.
* **Banner:** the "everything is simulated" banner is rendered only for `mode="mock"`; with real Liara data (`mode="live"`) a live-context banner says that chat/simulated approvals change nothing and real writes happen only in the live panel after a separate approval.
* **Limitation:** the real operation `lop_20261022203843_0396e0b4` predates provenance, so its card says the runtime evidence "was not recorded". The Liara `GET /applets` HTTP 500 itself is an upstream problem and is not fixed here.

## Phase R1 — runtime verification, re-verification integrity and evidence provenance
**Evidence lifecycle (after).** Every verification run (the post-release wait and a re-verification of an operation under review) takes snapshots with an observation time. `assess()` turns a snapshot into the ladder AND the evidence that is persisted with it on the operation JSON (optional members, strict schema, **no migration**): `evidence.runtime` (`observed` / `inferred` / `unknown`), `evidence.observedAt`, `evidence.health` (`source: http_probe`, outcome, HTTP status, marker required/matched, safe failure category, duration; `null` = no probe ran) and `evidence.applets` (readable or the error-code class). A record written earlier simply lacks these members and is displayed as "not recorded" — nothing is reconstructed.

**Deployed ≠ healthy now.** `DEPLOYED` is the recorded completion of the deployment operation; its evidence is historical and carries its own time. A FRESH, READ-ONLY check of a finished deployment (`POST …/resolve {"action":"recheck"}`, button «بررسی تازهٔ سلامت») makes one bounded observation (releases, applets, one HTTP probe) and stores it as `latestCheck` next to the deployment: state, ladder, historical evidence, transitions and `updatedAt` are never touched, so a failing check cannot turn a completed deployment into a failed one and an old success cannot pass for the new observation. Only `DEPLOYED` operations can be re-checked, only by the owner (or an explicit orphan adoption), and it sends no write request.

**Applets HTTP 500.** Recorded as `applets: {readable:false, failure:"upstream_error"}` — "no information". It is never a failure of the runtime (`runtimeStarted` is `unknown`, or `inferred` when a marker-verified HTTPS answer of the current READY release exists) and never downgrades a successful health probe. The UI shows it on its own line.

**Probe.** Typed `ProbeFailure` categories (`dns`, `tls`, `connection`, `timeout`, `cancelled`, `blocked_address`, `redirect`, `http_status`, `too_large`, `marker_mismatch`…) derived from error CODES only, `durationMs`, a TOTAL deadline (not just an idle timeout) and an `AbortSignal`. A verification run bounds itself: each probe gets 1–8 s (never more than the remaining budget), one abort signal ends a probe still running at the budget's end (recorded as `cancelled`), probes are sequential and requests for the same operation are coalesced (one probe sequence, one answer).

**Operation/lock audit (read-only, nothing changed).** Terminal states (`DEPLOYED`, `FAILED`, `CANCELLED`) never hold a lock; a crash mid-flight is swept to `NEEDS_OPERATOR_REVIEW` at start-up. Two reproducible *stale-lock* paths remain, both recoverable by the operator but unnecessary: (1) a `PENDING` proposal whose 10-minute expiry passed keeps its (team, app) slot until something reads its OWN run (`listForRun` → lazy expiry) — a proposal from another run is refused as `live_proposal_pending` meanwhile; the lock card's «لغو» clears it; (2) an `APPROVED`-but-never-executed proposal leaves its operation in `AWAITING_LIVE_APPROVAL` after expiry, even across a restart, until someone tries to execute it (`live_expired` then cancels it) or cancels it. Proposed separate remediation (not implemented here): call `expireIfDue` for the proposals behind `lockingOperations` and in `recover()`, and cancel `AWAITING_LIVE_APPROVAL` operations whose proposal is expired, with tests for both paths.

## Phase R2 — expired proposals no longer hold locks (implemented)
Root cause of both stale-lock paths of the R1 audit: expiry was *lazy and read-driven* (`expireIfDue` ran only when a proposal of the SAME run was listed/decided) and it only knew `PENDING`. The store's conflict rule (`createLiveProposal`: a `PENDING` proposal or an active operation on the (team, app) slot refuses a new one) never looked at the deadline, so (1) an expired `PENDING` proposal of another run kept the slot until its own run was read, and (2) an expired `APPROVED` proposal could not be expired at all (`transitionLiveProposal` accepted only `PENDING` as origin), leaving its operation in `AWAITING_LIVE_APPROVAL` even after a restart.

Fix (no schema change, no new lock registry, no timers): ONE lifecycle step, `expireIfDue`, now covers `PENDING` and `APPROVED`. A proposal past its deadline that was never executed becomes `EXPIRED` (store compare-and-set; `APPROVED → EXPIRED` is legal only once the deadline passed) and its operation takes the already-legal `AWAITING_LIVE_APPROVAL → CANCELLED` transition, which releases the (team, app) slot; one `live.proposal_expired` audit row (with the previous status), the human approval record and the transition history stay. It is applied (via `expireDueAwaiting`) when a slot is asked for (`createProposal` / `createExistingProposal`, for that slot only), on every status read, at start-up recovery, and in the `execute` "expired" branch. Execution safety: `beginExecution` (proposal `APPROVED` and not expired → `CONSUMED`, operation `AWAITING → APPROVED`) and the expiry transition are compare-and-set on the same proposal row, so exactly one can win; a proposal whose execution started is `CONSUMED` and is never touched, terminal operations are never rewritten, and a repeated check finds `EXPIRED` and does nothing. Tests: `tests/integration/live-expiry-lifecycle.test.ts` (memory and SQLite stores).
