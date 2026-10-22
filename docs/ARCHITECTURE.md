# Architecture

> **Reading guide.** §1–§9 are the *original Phase 0 design* (historical). §10–§16 describe what is **actually built**, phase by phase; the live deployment executor is §15–§16 and `LIVE_DEPLOYMENT_EXECUTOR.md`.

Status (original): Phase 0 design (no code yet). Goal: a **deployable** MVP — one Next.js/TypeScript app, one process, one small persistent store — not a multi-service or multi-agent system.

## 1. Principles

1. **The LLM never touches Liara.** It receives redacted evidence and returns schema-validated JSON. Only the workflow engine calls tools; only the adapter holds the token.
2. **Deterministic control flow.** The workflow is an explicit state machine in code. The LLM fills bounded slots (intent extraction, hypothesis ranking, Persian explanation).
3. **Typed tools are the only capability surface.** Each tool = zod input schema + zod output schema + risk class + one adapter method. No generic "call any endpoint" tool.
4. **Policy is code, not prompt.** An explicit policy engine decides allow / require-approval / deny from tool metadata, mode, allowlist and live state.
5. **Verify, don't assume.** Every mutation has post-conditions checked against fresh API reads.
6. **Contract honesty.** Undocumented endpoints (CLI-only) sit behind a `contract: "documented" | "observed"` flag and a startup feature probe; the UI never claims more than was verified.

## 2. Stack

| Concern | Choice | Reason |
|---------|--------|--------|
| Framework | Next.js (App Router) + TypeScript (strict) | One deployable unit for UI + API routes; Liara supports Next.js/Node platforms (`next`, `node` ids in the CLI list). |
| Runtime | Node.js (not Edge) | Needs Node crypto, streams, file handling, `fetch` with `undici`. |
| Validation | `zod` | Single source of truth for tool I/O, LLM output, env parsing. |
| State | SQLite (`better-sqlite3`) via a thin repository layer; file on a Liara **disk** (`DATA_DIR`), or in-memory when `DATA_DIR` unset (demo only) | Approvals, runs, audit log, idempotency records. Needs ACID and no extra service. Alternative (post-MVP): Liara managed Postgres. |
| UI | React server+client components, Tailwind CSS using logical utilities (`ms-*`, `pe-*`, `text-start`), Vazirmatn font self-hosted | RTL-correct by construction. |
| Streaming | Server-Sent Events from route handlers | Simple, proxy-friendly, no WebSocket infra. |
| Tests | Vitest (unit/contract), Playwright (RTL + 360/768/1280 px overflow checks) | |
| Lint/format | ESLint, Prettier, `eslint-plugin-no-secrets`-style custom rule banning `process.env.LIARA_*` outside `src/server/config` | Enforces token isolation. |

## 3. Component view

```
 Browser (fa, RTL)                    Next.js server (Node)
┌──────────────────┐   HTTPS   ┌──────────────────────────────────────────────────────┐
│ Chat + evidence  │──────────▶│ Route handlers (auth, CSRF, zod-validate, rate-limit)│
│ Approval cards   │◀──SSE─────│        │                                             │
└──────────────────┘           │        ▼                                             │
                               │ Workflow engine (state machines: diagnose, deploy)   │
                               │   │         │              │               │         │
                               │   ▼         ▼              ▼               ▼         │
                               │ Tool registry ──▶ Policy engine ──▶ Approval service │
                               │   │  (typed)        (allow/approve/deny)   (hash,TTL)│
                               │   ▼                                                  │
                               │ Liara adapter  ◀── redaction ──▶ Evidence builder    │
                               │   │ (only holder of token)           │               │
                               │   ▼                                  ▼               │
                               │ api.liara.ir                   LLM gateway ──▶ provider
                               │ Audit log / SQLite (append-only, hash-chained)       │
                               └──────────────────────────────────────────────────────┘
```

### 3.1 Safe Liara adapter (`src/server/liara`)
- **Single egress point** to `https://api.liara.ir` (host pinned; redirects disabled; HTTPS only).
- Reads token from validated config at construction; token is never a parameter of any exported function, never logged, never serialized (class holds it in a private field; `toJSON()` throws/returns `[REDACTED]`).
- Adds `Authorization: Bearer …` and `teamID` (when configured) — the latter is an unconfirmed convention (matrix §2), covered by a live-test item.
- Per-request timeout, bounded retries with jitter **for GET only**; honours `429`/`Retry-After`; client-side concurrency + RPS cap (no documented server limits).
- Response handling: parse with zod, tolerate unknown fields (`.passthrough()` only inside the adapter; exported types are strict and *projected*), non-JSON/empty bodies supported, size cap per response.
- **Projection at the boundary** removes sensitive data: `getApp` returns env **keys + encrypted flag**, never values; `listPlans` returns the `plans` subtree only (drops `user`); `checkDomain` drops `verificationCode`/`user`.
- Mutation methods accept a branded `ApprovedAction` produced by the approval service — the adapter refuses raw parameters. Mutations are **never auto-retried**; on timeout/ambiguous failure the workflow reconciles by reading state.
- `contract` feature probe at boot (read-only): checks whether v1 logs works and whether CLI-only read endpoints respond; results cached and surfaced in the health page.
- Test seams: `LiaraClient` interface with `HttpLiaraClient`, `FixtureLiaraClient` (replays scrubbed recordings), `RecordingLiaraClient` (wraps real client, scrubs and writes fixtures) — the last is used only by an operator CLI script in Phase 1.

### 3.2 Typed tools (`src/server/tools`)
```ts
interface ToolDef<I, O> {
  name: string;                    // e.g. "liara_restart_app"
  description: string;             // for docs/UI, not an LLM prompt in MVP
  risk: "R0" | "R1" | "R2";        // R3 tools are not registered
  contract: "documented" | "observed";
  input: z.ZodType<I>;
  output: z.ZodType<O>;
  appScoped: boolean;              // requires `app` in input; allowlist check
  preview(input: I, ctx): Promise<ActionPreview>;     // mutating tools only
  verify?(input: I, before: Snapshot, ctx): Promise<VerificationResult>; // post-conditions
  run(input: I, ctx: ToolCtx): Promise<O>;
}
```
Names and risk classes are exactly those in the capability matrix. A registry test asserts every tool maps to a matrix row and every R1/R2 tool defines `preview` and `verify`.

### 3.3 Policy engine (`src/server/policy`)
Pure function, table-tested:
```ts
decide(ctx: {tool, input, mode, session, appState, now}): 
  | {effect: "allow"}                                   // R0 within allowlist & rate limit
  | {effect: "require_approval", ttlSec, confirm: "click" | "type_app_name"}
  | {effect: "deny", reason: PolicyReason}
```
Rules (first match wins): unknown tool ⇒ deny · app not in allowlist ⇒ deny · `ENABLE_MUTATIONS=false` and risk>R0 ⇒ deny (proposal still renderable) · R0 ⇒ allow · R1 ⇒ approval(click) · R2 ⇒ approval(type_app_name) · schema-specific guards (e.g. `scale ∈ {0,1}`; `planID ∈ plans from /v1/me`; env keys match `^[A-Za-z_][A-Za-z0-9_]*$`; at most one mutation per run step; max N mutations per app per hour). Every decision is audited with its reason code.

### 3.4 Deterministic workflow (`src/server/workflow`)
- States and transitions are data (`as const` table) with exhaustive-switch handlers; each step is idempotent on replay from the persisted `runs` row (resume after restart).
- A step may call: tools (through registry+policy), the evidence builder, the LLM gateway (bounded slots), the approval service. Nothing else.
- Two workflows in MVP: `diagnose` and `first_deploy` (see MVP_SPEC). They share the evidence builder, approval service and verifier.
- The LLM output for a slot is validated; on invalid output the step uses its deterministic fallback (e.g. detector findings only). No LLM retry loops beyond 1 repair attempt.

### 3.5 Evidence builder & redaction (`src/server/evidence`, `src/server/redact`)
Builds the Evidence Bundle (ids, source, range, completeness) and passes every string through the redaction pipeline (SECURITY_POLICY §3) **before** it can reach the LLM, UI, audit log or logger. Untrusted text (logs, events, build output, user archive content) is wrapped as quoted data blocks and flagged with simple injection heuristics (for audit/UI only — not relied on for safety).

### 3.6 Provider-agnostic LLM gateway (`src/server/llm`)
```ts
interface LlmProvider {
  generateStructured<T>(req: {
    system: string;
    messages: {role: "user"|"assistant"; content: string}[];
    schema: z.ZodType<T>;
    maxOutputTokens: number;
    temperature?: number;
    timeoutMs: number;
  }): Promise<{ok: true; value: T; usage: Usage} | {ok: false; error: LlmError}>;
}
```
- Adapters: `openai-compatible` (configurable `LLM_BASE_URL`; works with OpenAI-style endpoints, including Liara AI's OpenAI-style `…/api/{workspaceID}/v1/chat/completions` on `ai.liara.ir` per its public spec — unverified until tested), `anthropic`, and `mock` (scripted, used in CI and the offline demo).
- Structured output is obtained by JSON-schema-constrained generation when the provider supports it, else JSON-in-text + zod parse + one repair attempt.
- **No tool/function calling in the MVP** — removes an entire class of tool-injection risk. The gateway has no handle to the tool registry.
- Prompts live in `src/server/llm/prompts/*.fa.ts` (Persian outputs) with golden tests on the mock; the system prompt states that evidence is untrusted data. Prompt text is **not** the security boundary.
- Per-run token budget, request timeout, no logging of full prompts unless `LOG_LLM_PAYLOADS=true` (dev only; still redacted).

### 3.7 Approval service (`src/server/approvals`)
Creates approvals bound to `sha256(canonical(toolName, input, appStateFingerprint, runId, sessionId))`, stores `expires_at`, `status` (`pending|approved|executed|expired|rejected|failed`), and enforces single use via an atomic `UPDATE … WHERE status='approved'` — details in SECURITY_POLICY §5–6.

### 3.8 Persistence schema (SQLite, sketch)
`sessions`, `runs(id, workflow, state, app, created_at, updated_at)`, `evidence_items(run_id, id, source, range, redacted_json)`, `approvals(id, run_id, action_hash, tool, params_json_redacted, risk, state_fingerprint, expires_at, status, approved_at, executed_at)`, `idempotency(key PRIMARY KEY, approval_id, result_json_redacted, created_at)`, `audit(seq INTEGER PRIMARY KEY, ts, actor, run_id, event, data_json_redacted, prev_hash, hash)`. Raw (unredacted) API payloads are never persisted.

## 4. HTTP surface (all JSON, zod-validated, session + CSRF protected)

| Route | Purpose |
|-------|---------|
| `POST /api/auth/login`, `POST /api/auth/logout` | App access (single shared operator password → signed, httpOnly, SameSite=Strict cookie). |
| `GET /api/apps` | Allowlisted apps (R0). |
| `POST /api/runs` | Start `diagnose` / `first_deploy` run. |
| `GET /api/runs/:id/events` | SSE progress + evidence + proposals. |
| `POST /api/runs/:id/upload` | Archive upload for Journey B (size-capped, streamed to temp). |
| `POST /api/approvals/:id/approve`, `/reject` | Human decision (R2: body includes typed app name). |
| `GET /api/audit?run=` | Redacted audit view. |
| `GET /api/health` | Config sanity, contract probe results, mode flags (no secrets). |

## 5. Frontend (Persian RTL, responsive)

- Root layout sets `lang="fa" dir="rtl"`; Tailwind logical utilities only (lint rule bans `ml-/mr-/pl-/pr-/left-/right-/text-left/text-right`).
- Message catalogue `src/i18n/fa.ts` (typed keys); no inline user-facing strings in components. Number/date helpers in `src/lib/format.ts` (`Intl` `fa-IR`, Persian calendar).
- Components: `ChatPanel`, `EvidenceDrawer`, `FindingCard`, `ApprovalCard` (countdown, risk badge, typed-confirm), `VerificationTimeline`, `LogBlock` (`dir="ltr"`, internal scroll), `AppPicker`, `UploadZone`.
- Responsive: container queries; ≥1024 px two-pane (chat | evidence), <768 px single column with drawer/bottom sheet. Playwright checks at 360/768/1280: `document.documentElement.scrollWidth <= innerWidth`, `dir=rtl`, key flows operable by keyboard.

## 6. Deployment

- Target: a Liara app on the `next` (or `node`/`docker`) platform; persistent `DATA_DIR` on a Liara disk. The agent can eventually be deployed with its own Journey B (dogfooding), but Phase 1 deploys by the Liara CLI/console manually.
- Config only via environment variables (see `.env.example`); startup fails closed on invalid config (zod). `GET /api/health` reports mode (`read-only` vs `mutating`) prominently.
- Single instance (SQLite). Horizontal scaling is a post-MVP concern (move to Postgres).

## 7. Project file tree (target; Phase 1 creates it)

```
hackaton liara/
├── .env.example
├── .gitignore                    # .env*, data/, fixtures/raw/, *.log
├── README.md                     # (fa + en quickstart; Phase 1)
├── package.json  tsconfig.json  next.config.ts  tailwind.config.ts  eslint.config.mjs
├── docs/
│   ├── API_CAPABILITY_MATRIX.md  MVP_SPEC.md  ARCHITECTURE.md  SECURITY_POLICY.md
│   └── reference/openapi/        # pinned paas.yaml, me.yaml (+ SHA in matrix)
├── src/
│   ├── app/                      # Next.js App Router
│   │   ├── layout.tsx            # lang=fa dir=rtl, fonts
│   │   ├── page.tsx              # chat + app picker
│   │   ├── runs/[id]/page.tsx
│   │   └── api/
│   │       ├── auth/{login,logout}/route.ts
│   │       ├── apps/route.ts
│   │       ├── runs/route.ts
│   │       ├── runs/[id]/{events,upload}/route.ts
│   │       ├── approvals/[id]/{approve,reject}/route.ts
│   │       ├── audit/route.ts
│   │       └── health/route.ts
│   ├── components/               # ChatPanel, ApprovalCard, LogBlock, ...
│   ├── i18n/fa.ts
│   ├── lib/                      # format.ts (fa-IR), cn.ts, csrf-client.ts
│   └── server/
│       ├── config/               # env.ts (zod) — only place reading process.env
│       ├── liara/                # client.ts, http-client.ts, fixture-client.ts, schemas/, projections.ts, probe.ts
│       ├── tools/                # registry.ts, read/*.ts, mutate/*.ts
│       ├── policy/               # engine.ts, rules.ts, reasons.ts
│       ├── approvals/            # service.ts, hash.ts
│       ├── workflow/             # engine.ts, diagnose/{states,detectors}.ts, deploy/{states,analyze-source}.ts, verify/*.ts
│       ├── evidence/             # builder.ts, bundle.ts
│       ├── redact/               # pipeline.ts, patterns.ts, canary.test.ts
│       ├── llm/                  # gateway.ts, providers/{openai-compatible,anthropic,mock}.ts, prompts/*.fa.ts
│       ├── audit/                # log.ts (hash chain)
│       ├── db/                   # sqlite.ts, migrations/*.sql, repos/*.ts
│       └── auth/                 # session.ts, csrf.ts, rate-limit.ts
├── scripts/
│   ├── record-fixtures.ts        # operator-only live READ recording with scrubbing
│   └── verify-matrix.ts          # fails CI if tools ≠ matrix rows
├── tests/
│   ├── unit/                     # policy table tests, detectors, redaction, hash/expiry
│   ├── contract/                 # adapter vs scrubbed fixtures (+ pinned spec sha check)
│   ├── workflow/                 # journeys A & B on mock adapter + mock LLM
│   └── e2e/                      # Playwright RTL/responsive
└── fixtures/
    ├── scrubbed/                 # committed; secrets replaced, canaries asserted absent
    └── raw/                      # gitignored, never committed
```

## 8. Key design decisions & alternatives rejected

| Decision | Rejected alternative | Why |
|----------|---------------------|-----|
| LLM returns structured analysis; code executes | LLM tool-calling agent loop | Smaller injection surface; reproducible; testable with a mock. |
| Single Next.js app + SQLite | Separate backend service, queue, Redis | MVP deployability; one instance suffices. |
| Typed per-endpoint tools | Generic "liara_request(method, path)" tool | Unbounded blast radius; cannot attach risk class/preview/verify. |
| Approval cards with typed app name for R2 | Chat-text "yes" | Chat text is attacker-influenceable via injected content; approval must be a separate authenticated UI action. |
| Honour CLI-only endpoints behind flags | Ignore them | Release polling/build logs are needed for Journey B; flag + probe keeps the claim honest. |

## 9. Phase 1A deviations from this design (as built)

- **No SQLite / audit chain / approvals yet** — Phase 1A is read-only; sessions, login throttling and capability state are in-memory (single instance). Persistence lands in Phase 1B.
- **No `SESSION_SECRET`**: sessions are opaque random ids held server-side (revocable), so no signing key is needed.
- **No tool registry / policy engine / LLM gateway yet**: the read surface is `LiaraService` → `LiaraReadClient` with an explicit endpoint registry (all GET). The policy engine arrives with the first mutation.
- **Allowlist and projection live in the service/schema layer** (not a generic policy engine); behaviour matches SECURITY_POLICY §3–4.
- Actual layout: see README → Architecture.

## 10. Phase 1B additions (as built)

- **Verification model** (`liara/capabilities.ts`): `VerificationStatus` (LIVE_VERIFIED … CONTRACT_MISMATCH) is separate from `CapabilityHealth` (ok/failing/not_probed/simulated/disabled). Only explicit probes (`probe: true`) change the verification level; mock observations are ignored.
- **Connection states** (`service.ts › computeConnectivity`): simulated · connected · degraded · auth_failure · endpoint_unavailable · contract_mismatch · unreachable · stale · unknown, plus a per-capability issue list.
- **Independent runtime dimensions** (`domain/runtime.ts`, `domain/vocabulary.ts`): `enabled` (config, from `scale`) · `runtime` (from applets, worst-applet-wins, heuristic and clearly labelled until `VERIFIED_APPLET_STATES` is filled from live evidence) · `health` (always "unavailable" — no health evidence is collected). The only positive colour is a running runtime with no failure evidence.
- **Metrics** (`schemas.ts`, `metric-chart.tsx`): raw points only; per-series median step, gaps (> 3× step, line is broken), last observation, staleness; `schema: ok | empty | unsupported`; unit is `null` unless in `VERIFIED_METRIC_UNITS`.
- **Freshness**: every dynamic section carries `meta.fetchedAt`; the client `Freshness` component ages it (10 s tick, `pageshow`/visibility aware) and flags it stale after 120 s. There is no server-side data cache (only a 20 s diagnostics-probe cache).
- **HTTP client**: rolling per-minute request budget (`LIARA_REQUEST_BUDGET_PER_MINUTE`, retries count, local exhaustion is never retried), optional lifetime cap (verification command), error-body *structure* capture (≤ 2 KB peek, key names only).
- **Verification command** (`liara/verify.ts`, `scripts/verify-liara-readonly.ts`): GET-only, budgeted (default 25), ≤ 2 concurrent / 2 rps, plan printed first, dry run unless `--approve-live-readonly`, app named by pseudonym only, structure-only observations written to `fixtures/recorded/verification-*.json` (git-ignored, mode 0600).
- **Recorder** (`liara/recorder.ts`, `scripts/record-fixtures.ts`): double opt-in (flag + `LIARA_ALLOW_RECORDING=true`), allowlisted app, field allow-list, pseudonyms, **fail-closed leaf validation**, all-or-nothing writes, `REVIEW.md` manifest; nothing is promoted automatically (`fixtures/reviewed/` is empty and documented).
- **Redaction** (`security/redact.ts`): credentials in any URL userinfo (incl. password-only and token-only), Cookie/Set-Cookie lines, secret query parameters, plus a **shareable** mode (hosts → `host-N`, IPs → `[PRIVATE_IP]`/`[IP]`, home paths → `/home/[user]`) used by the recorder and report. Dashboard output keeps hosts visible for diagnosis.


## 11. Phase 1C additions (as built)

New module `src/server/diagnostics/` (full description in `docs/DIAGNOSTIC_ENGINE.md`):

```
types.ts · evidence-set.ts · semantics.ts · signals.ts        schema, immutable evidence bag, verified-metric semantics, text classifiers
evidence.ts                                                   EvidenceCollector (only consumer of the read-only LiaraService)
detectors/{crash-loop,database,missing-config,memory,cpu,release,http500,insufficient}.ts   pure detectors, registry per intent
aggregate.ts · recommend.ts · engine.ts · report.ts           ranking/confidence · policy · offline pipeline · report + narrative validation
llm/{provider,mock,disabled,index}.ts                         DiagnosticLLMProvider (offline only)
store.ts                                                      RunStore + SqliteRunStore (node:sqlite) + MemoryRunStore, sanitizeForStore, audit chain
workflow.ts · runtime.ts                                      RunManager state machine · lazy process-wide accessor
```

* API: `POST/GET /api/diagnostic-runs`, `GET /api/diagnostic-runs/:id`, `POST /api/diagnostic-runs/:id/cancel` (`guardedAction`: session → same-origin JSON → rate limit; the POSTs only start/stop an OFFLINE analysis).
* UI: `/assistant` (form + recent runs), `/assistant/runs/:id` (polling timeline + report + evidence details).
* The Liara client stays GET-only; the diagnostics layer has no `fetch`, no HTTP verbs, no `process.env` (tested). Reaching Liara is only possible through `LiaraService` (allowlist, strict projection, redaction).
* Error classification is **duck-typed** (`isLiaraError`, `isRunError`): Next.js can bundle a module separately for pages and route handlers, so `instanceof` is unreliable for errors raised by process-wide singletons (found by an e2e test).
* Persistence deviates from the Phase 0 design only in using Node's built-in SQLite instead of `better-sqlite3` (no native build). `RunStore` keeps PostgreSQL a drop-in replacement.
* Not built (by design): approval service, policy engine for mutations, any LLM client, background job infrastructure.

## 12. Phase 1D additions (as built)

`src/server/agent/`: `types` · `tools` (9 read-only tools, `executeTool`) · `intent` (deterministic Persian parser) · `planner` · `policy` (R0–R3 table, canonical digest) ·
`manager` (`AgentRunManager`: conversation handling, state machine, propose/decide, cancel/retry, recovery) · `store` (`AgentStore`, `MemoryAgentStore`, `SqliteAgentStore`) ·
`simulation/{simulator,backend}` (synthetic execution only) · `errors` · `runtime` (lazy singleton). Routes under `/api/agent/*` (6, session + same-origin JSON guarded).
UI: `/agent` with `agent-workspace`, `approval-card`, `tool-timeline`, `simulation-result`, `countdown`. The Phase 1C collector/analyzer/report are reused (`createSourceCollector`), not duplicated.
Details: `AGENT_ORCHESTRATION.md`, `APPROVAL_WORKFLOW.md`. The earlier "approval service" sketch in §3.7 is realised here **in simulation mode only**.

## 13. Phase 1E additions (as built)

`src/server/deploy/`: `limits` · `zip` (defensive reader) · `workspace` (isolated extraction) · `analyze` (static SourceAnalyzer) · `readiness` (pure verdict function) · `strategy` (13-step Liara workflow classified A–D, verified against the pinned OpenAPI by a test) ·
`recommend` (catalogue-gated guidance) · `params` (strict `first_deploy` schema) · `plan` (builder + drift fingerprint) · `simulator` · `live-gate` · `types`. Integration points: `agent/manager` (`receiveProject`, `setChecklist`, `prepareDeployment`, `requestLiveExecution`, deploy-aware `decide`),
`agent/policy` (`first_deploy`), `agent/intent` (4 intents), `security/guard` (`guardedUpload`), routes `/api/agent/deploy/{uploads, runs/[id]/checklist, runs/[id]/plan}`, UI `components/deploy-journey.tsx` inside the agent workspace.
No new dependency, no new table: runs, proposals, approvals and audit reuse the Phase 1D store.

## 14. Phase 1F additions (as built)

* `src/server/liara/endpoints.ts`: three more **GET-only, documented** account endpoints (`/v1/me`, `/v1/me/subscription`, `/v1/me/free-credit`; pinned `me.yaml`). They are not part of the user-facing capability list.
* `schemas.ts` (`MeProjectionSchema`, `MeSubscriptionSchema`, `MeFreeCreditSchema`) are projections in zod strip mode — profile, team and storage keys never leave the adapter; `plans.ts` (`projectPlanCatalogue`) inspects plan records field by field and can never claim `verified`/`unitsVerified`.
* `verify.ts`: account-only mode (`app: null`), account observers (structure only), honest verdicts (an empty list is INCONCLUSIVE), counts-only `--probe-team`. `config/env.ts`: `loadConfig(env, { verification: true })`, used only by the script.
* `recorder.ts`: empty approved-field specs for the account endpoints (nothing can be recorded).
* `playwright.config.ts`: the e2e server skips env files (`__NEXT_PROCESSED_ENV`) so a developer's `.env.local` can neither leak a token into tests nor alter them.

## 15. Phase 2A additions (as built)

* `src/server/live/` — the **only** write-capable code: `contract` (3 typed operations, strict zod, no generic request), `write-client` (the only file with `"POST"`; one attempt, no redirects, status-only classification, built only when flag + live source + token), `artifact` (deterministic tar.gz), `plans`/`units` (catalogue selection, operator-verified units), `authorize` (per-step re-validation), `store` (Memory + SQLite: `live_proposals`, `live_approvals`, `live_operations`, `app_scope`), `executor` (state machine, reconciliation), `verify` + `probe` (ladder; SSRF-safe probe — the only module with `node:https`/`dns`), `service`, `runtime` (lazy singleton).
* Routes under `/api/agent/live/*`; UI `components/live-deployment.tsx` mounted in the deployment panel; strings in `i18n/live-fa.ts`.
* The simulator, the Phase 1D/1E approval path and the live path share no executable code and no table; scans enforce it. See `LIVE_DEPLOYMENT_EXECUTOR.md`.
* Config: `AppConfig.live` (`enabled`, `planUnits`, `appDomainSuffixes`, `contractAttested`, `networkId`, `healthPath`, `healthMarker`) — all off/empty by default.

## 16. Phase 2B additions (as built) — final live-deployment preflight (still NOTHING executed live)

* **Read layer:** `getBilling` (documented, `billing.yaml` pinned) and `listNetworks` (CLI-observed, opt-in via `LIARA_ALLOW_UNDOCUMENTED_ENDPOINTS`) as GET-only registry entries with strip-mode projections (`BillingProjectionSchema` keeps only `balance`; `NetworksSchema` keeps only `_id` + short name; `/v1/me` additionally keeps only `team.balance`). `LiaraService.appInventory` (count + name existence in one list read) and `appIdentity` (one exact name, bypasses the allowlist by design, returns only name + scale).
* **`live/pricing.ts`:** operator units are **cross-checked** against the live catalogue and a dated snapshot of the public pricing page (≥2 plans must match RAM + CPU + exact price under a single unit hypothesis); `cliOffersPlan`, `balanceStatus` (class only, unit-agnostic).
* **`live/preflight.ts` + `preflight-gather.ts`:** a pure, sanitised report (checks with category + evidence class, pricing summary, network/team/account classes) and its verdict (`READY_FOR_OPERATOR_APPROVAL` or the highest-priority `BLOCKED_BY_SECURITY > CONTRACT > PRICING > CONFIGURATION`). Used by proposal, approval drift, execution drift, `GET /api/agent/live/status`, and `npm run preflight:liara`.
* **Executor hardening:** explicit financial acknowledgment; HTTP errors reconciled by reading before "FAILED"; exact identity proven (`GET /v1/projects/{name}` name equality) before the scope bootstrap; `PARTIALLY_VERIFIED` verdict; per-level evidence table in `src/lib/live-ladder.ts`.
* **First-app bootstrap:** `LIARA_FIRST_APP_BOOTSTRAP=true` allows an empty allowlist with live data (zero-app accounts): the effective scope is an empty set plus exact, verified, tool-created apps — never a wildcard.
* **UI:** final preflight summary (what / who / why this plan / cost / approvals / agent steps / verification / failure) and evidence badges in `components/live-deployment.tsx`.

## 17. Phase 2D additions (as built) — existing-app releases and the optional CLI backend

* `LiveKind` (`create_new_app` | `deploy_existing_app`) and `LiveBackend` (`api` | `cli`) on proposals and operations (defaults keep Phase 2A/2B meaning); `LiveCliBinding` (tool version + entry hash, argv template digest, manifest digest) bound into the approval digest.
* `src/server/live/cli/`: `spec.ts` (the only argv builder; allow/deny lists; env and auth-file builders), `backend.ts` (`LiaraCliBackend`: identity check, approved-source materialisation, private HOME + 0600 auth file, one run, cleanup, sanitised tail), `process-runner.ts` (the ONLY process-starting code; `FakeProcessRunner` in tests).
* Executor: `adoptExisting` (no create), `cliDeploy` (baseline → run once → reconcile by reading); REST steps unchanged. `service.createExistingProposal`; `POST /api/agent/live/proposals` accepts `x-live-kind` / `x-live-backend`.
* Decision and evidence: `DEPLOYMENT_BACKEND_DECISION.md` (hybrid, REST-first).

## 18. Phase 2E additions (as built)

`live/existing.ts` (pure facts, checks, signature, offline health-settings validation), `LiveExistingBinding` in the approval digest, `LiveReader.releaseBaseline/authorizedApps`, richer `appIdentity` (`instanceId`, `createdAt`, `networkId`, `defaultSubdomain` projected from `GET /v1/projects/{name}`), `LiveStatus.mode` and `LiveStatus.existing`, the existing-app section of `components/live-deployment.tsx`, `scripts/check-live-settings.ts`, and `FIRST_LIVE_RELEASE_PLAN.md`.

