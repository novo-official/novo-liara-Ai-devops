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
