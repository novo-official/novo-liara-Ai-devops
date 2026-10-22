# Agent Orchestration (Phase 1D — read-only tools, simulated actions)

> **Status.** Everything below is implemented and tested against **mock data and a simulated execution backend only**.
> Live Liara validation is still **pending** (see `API_CAPABILITY_MATRIX.md`), **real infrastructure mutations are disabled and do not exist in the code**,
> the "LLM" is the offline deterministic mock, **real free-form AI is unavailable**, and the BoxAPI promotional credit is **unused** (no code can contact it).

The agent turns a short Persian message into an **audited, bounded, read-only investigation** and, when the evidence supports it, a **simulated** remediation
proposal that a human may approve. It never executes anything real.

```
message ─▶ parseIntent (deterministic) ─▶ createPlan (bounded) ─▶ executeTool × N (read-only) ─▶ analyze/report (Phase 1C engine)
                │                                                                                      │
        refuse / clarify                                                              propose (only from a report recommendation)
                                                                                                       │
                                              human decision ─▶ server-side validation ─▶ SimulatedExecutionBackend (synthetic result)
```

## 1. Tool registry (`src/server/agent/tools.ts`)

Single entry point `executeTool(ctx, toolId, rawArgs)`. Nothing else may call a tool's `run`.
Order of checks: registry lookup → strict zod argument validation → app authorisation (must equal the run's app **and** be on the allowlist) →
capability check → budget → timeout/cancel → output projection (unknown fields stripped) → audit row (metadata only).

| Tool | Reads | Budget cost |
|---|---|---|
| `list_apps` | allowlisted apps only | 1 |
| `get_app_details` | app, scale, plan, env **key names** | 1 |
| `get_runtime_status` | applets / state classification | 2 |
| `get_recent_releases` | release history | 1 |
| `get_recent_events` | events in window | 1 |
| `get_application_logs` | log excerpts (redacted, bounded) | 1 |
| `get_cpu_metrics` / `get_memory_metrics` | series summaries | 1 each |
| `diagnose_application` | **no upstream call**: runs the Phase 1C detectors/aggregator/report over evidence already collected | 0 |

All tools are risk **R0**, session-authorised, 10 s timeout. There is no mutation tool, no URL/path/command/header argument anywhere
(asserted by `tests/integration/agent-tools.test.ts`). The collector is the Phase 1C one (`createSourceCollector`): there is **no second diagnostic engine**.

## 2. Intents (`intent.ts`, deterministic — no model involved)

Eight intents: `inspect_health`, `investigate_restarts`, `investigate_http500`, `investigate_slow`, `investigate_deployments`,
`explain_finding`, `review_remediation`, `simulate_remediation_plan`. Mapped onto the four engine intents where an investigation is needed.

* Input is NFKC-normalised; Arabic/Persian digits, ye/kaf, ZWNJ, diacritics, control and bidi characters are handled. Max 500 characters.
* Apps are resolved **only from the allowlist**. An unknown name is refused (no existence oracle); a name never feeds the keyword families
  (an app called `demo-http500` is not a report of HTTP 500).
* **Clarify** when ambiguous (several apps, two problem families, follow-up without a report) — with clickable options.
* **Explain** when unsupported, with what *is* supported.
* **Refuse** direct orders for real operations (restart/stop/scale/deploy/delete… `blocked_action`) and attempts to override policy or approval
  (`approved=true`, "without approval", "ignore previous instructions", fake `system:` prefixes… `policy_override`). A *question* about restarting is not an order.
  An explicit request for a *simulation* is allowed.
* The parser has no side effects; the manager audits `intent_parsed` with the rule ids that fired.

## 3. Plan schema (`planner.ts`)

`AgentPlan { id, intent, engineIntent, app, windowMinutes, risk:"R0", budget:{maxToolCalls:12}, steps[], skipped[], expectedEvidence[], prerequisitesFa[], missingInformationFa[], verificationCriteriaFa[] }`.
Each step has a tool, **schema-valid args**, a Persian reason, the evidence it should yield and `optional`. Rules: P1 fixed step sets per intent; P3 `diagnose_application` last;
P4 no duplicate tools; P5 non-allowlisted app ⇒ empty plan; P6 capability known to be unavailable ⇒ skipped with reason; P7 budget (≤ 12 upstream reads).
Fresh (≤ 5 min), same-app, same-window, *available* evidence from the conversation is **reused** and shown as a skipped step with the reason `reused_evidence`.
Follow-up intents (`explain/review/simulate`) plan **zero** tool calls. The plan is never influenced by evidence content (tested with hostile log lines).

## 4. Workflow state machine (`manager.ts`, `AGENT_NEXT`)

```
REQUEST_RECEIVED → INTENT_RESOLVED → PLAN_CREATED → COLLECTING_EVIDENCE → ANALYZING → REPORT_READY
REPORT_READY → ACTION_PROPOSED → AWAITING_APPROVAL → { APPROVED → SIMULATION_COMPLETED | REJECTED | EXPIRED } → REPORT_READY
```

Run status: `RUNNING · READY · FAILED · CANCELLED · TIMED_OUT`. Every transition is stored (actor, outcome, note; capped at 200) and mirrored in the hash-chained audit log.
Controls: one running run per app, ≤ 2 concurrent runs (configurable), 20 runs / 10 min / session, 30 s run timeout, cancel at any time, retry only for FAILED/TIMED_OUT
with a chain depth ≤ 2, conversation ≤ 100 messages, ≤ 3 proposals per run, ≤ 1 open proposal. Start and propose are serialised so check-then-act is atomic in-process.
Interrupted runs (crash/restart) are recovered as `FAILED / interrupted_by_restart` on startup and can be retried.

## 5. Conversation model

`ConversationMessage.kind ∈ user | ack | clarification | refusal | plan | report | explanation | remediation_review | proposal | decision | simulation | system`
with optional suggestions. Conversations, messages, runs (plan, tool-call metadata, evidence references, report), proposals, approvals and transitions are persisted
(`SqliteAgentStore`, replaceable behind the `AgentStore` interface; `MemoryAgentStore` for tests). Tool results are stored as projected summaries + evidence ids, not raw upstream bodies.

## 6. UI (`/agent`, «فضای کار عامل»)

Conversation panel (suggestions, limits note, provider status, 500-char composer, Enter/Shift+Enter) · run status with phase · **proposals first** · tool timeline
(plan, executed tools with status/duration, skipped steps with reasons) · the Phase 1C diagnostic report reused unchanged. A persistent banner reads
**«شبیه‌سازی — هیچ عملیات واقعی انجام نمی‌شود»**. Outcome colours: blue = simulated completion, amber = simulated failure, **never green**.

## 7. What is real and what is simulated

| Real | Simulated / mocked |
|---|---|
| Intent parsing, planning, validation, policy, digesting, persistence, audit | All Liara data in mock mode (fixtures); live contracts unverified |
| Read-only tool execution and the Phase 1C analysis | The execution backend (`SimulatedExecutionBackend`) and its verification |
| Approval validation, expiry, replay prevention, drift detection | The narrative provider (`mock-diagnostic-llm-simulated`) |

## 8. Limitations

* No free-form conversation: only the eight intents. No model reasoning.
* Proposals exist only for recommendations whose parameters can be derived from evidence (e.g. `restart_app`, `change_plan`); `update_env` is never proposed because key names are not inferred.
* Drift detection fingerprints scale/status/plan/runtime/current release; other changes are not noticed.
* The local audit chain detects accidental edits, but is **not fully tamper-proof**: whoever can write the database can recompute the chain, tail truncation is undetectable, and there is no external anchor.
* Single-process locking; multi-process safety relies on SQLite `BEGIN IMMEDIATE` + compare-and-set (tested with two managers on one file), not on a distributed lock.
* Expiry is enforced lazily (on read/decision), not by a timer — correct, but a stale proposal row can sit `PENDING` until someone looks.

## 9. Test scenarios (all automated)

| | Scenario | Where |
|---|---|---|
| A | HTTP 500 → grounded diagnosis, evidence inspection, "explain finding" with no new tool calls | `agent-workflow`, `e2e/agent` |
| B | Repeated restarts → DB failure → simulated R1 proposal | same |
| C | Approve → simulation → simulated verification; R2 typed name; simulated failure/verification failure | same |
| D | Reject / cancel → nothing executed | same |
| E | Expiry, digest change, tampered row, drift, unobservable state | `agent-workflow` (clock-controlled), e2e for forged digest |
| F | Malicious logs and chat instructions (8 + 12 payloads) | `agent-adversarial`, `agent-intent`, e2e |
| G | Insufficient evidence → no cause claimed, no proposal, asks for more | `agent-workflow`, e2e |

Real-time expiry (5–10 min) is not waited for in the browser; it is proven with an injected clock at integration level.

## 10. Prerequisites before any real execution (Phase 2+, **not** done)

1. Live read-only contract verification passes (`verify:liara-readonly`) and endpoint behaviour for each mutation is documented/verified on a disposable app.
2. A separate `ExecutionBackend` class behind its own policy gate and feature flag, default off, with a write-capable client constructed **only** there.
3. Idempotency keys and a documented rollback per operation; verified post-action checks against live state.
4. External audit anchoring; multi-operator identities instead of one shared password; per-action RBAC.
5. Re-run the whole adversarial suite against the live backend in a sandbox account.

## 11. Phase 1E extension — deployment runs

The same manager also drives `kind: "deployment"` runs (see `DEPLOYMENT_ASSISTANT.md`): `receiveProject` (upload → static analysis → readiness), `setChecklist` (operator decisions), `prepareDeployment`
(immutable `first_deploy` proposal), the unchanged `decide()` gate, and `requestLiveExecution` (always refuses). Four new intents (`start_deployment`, `check_compatibility`, `recommend_plan`, `predeploy_checklist`)
are resolved deterministically; legitimate deploy requests for the user's own project become safe plans instead of `blocked_action` refusals, while commands naming an existing app and policy overrides are still refused.
New phases: `SOURCE_RECEIVED → SOURCE_ANALYZING → READINESS_REVIEW → PLAN_PREPARED → … → SIMULATION_RUNNING → SIMULATION_VERIFICATION → SIMULATION_COMPLETED`. Approvals carry `scope: "simulation"`.
