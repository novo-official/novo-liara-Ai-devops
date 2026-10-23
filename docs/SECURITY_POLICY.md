# Security Policy

Scope: the Liara AI DevOps Agent MVP. This document is normative for Phase 1 implementation: each numbered control maps to a test (§10). Threats considered: stolen/leaked tokens, prompt injection through logs/build output/uploaded code, replayed or forged approvals, an LLM proposing out-of-policy actions, secret exfiltration to the LLM/UI/logs, SSRF through verification probes, malicious archives, and unauthorised use of the web UI itself.

Facts about Liara that this policy deliberately does **not** assume (not documented — see API_CAPABILITY_MATRIX §2): scoped/read-only API tokens, rate-limit values, idempotency keys, a rollback API.

## 1. Token handling (server-side only)

1. The Liara API token exists only in server environment configuration (`LIARA_API_TOKEN`) and, at runtime, in a private field of the Liara adapter. It is never sent to the browser, never in a URL/query string (this is why the console WebSocket, which takes `token=` in the URL, is not used), never in cookies, never in `NEXT_PUBLIC_*` variables.
2. `process.env` is read only in `src/server/config/env.ts` (zod-validated). A lint rule fails the build if any other module reads `LIARA_*`, `LLM_API_KEY`, or `*_SECRET*`.
3. The adapter has no exported accessor for the token; its `toString`/`toJSON`/inspect output is `[REDACTED]`. The HTTP layer strips `Authorization` from any error/log object before logging.
4. The LLM provider key is held the same way, in a different module, and is never exposed to tools or workflow code.
5. Recommended operational setup (documented in README): use a **dedicated Liara team/account for the agent** containing only apps it may touch, with a token that can be revoked independently. Because Liara token scoping is undocumented, the real boundary is our allowlist (§4), not the token.
6. Tokens are rotated by changing the env var and restarting; no token is ever stored in the database. (A "bring your own token in the UI" mode is out of MVP scope precisely because it would put tokens through the browser and the DB.)
7. `.env*` files other than `.env.example` are git-ignored; CI runs a secret scanner on the repository and on build artefacts.

## 2. Access to the agent UI/API

The agent can mutate production infrastructure, so the web app is itself a privileged surface.
- Login with an operator password verified against a salted hash (`APP_ACCESS_PASSWORD_HASH`, argon2id/scrypt); constant-time compare; progressive delay + lockout on failures.
- Session: signed, `httpOnly`, `Secure`, `SameSite=Strict` cookie, short idle timeout, absolute lifetime; session id bound to approvals (§5).
- CSRF: double-submit token or origin check on every state-changing route; JSON content-type enforced.
- Per-session and global rate limits on run creation, uploads and approvals.
- Security headers: strict CSP (no inline script), `X-Content-Type-Options`, `Referrer-Policy: no-referrer`, `frame-ancestors 'none'`.
- If `APP_ACCESS_PASSWORD_HASH` is unset the server refuses to start in `ENABLE_MUTATIONS=true` mode.

## 3. Secret redaction

Redaction is a single module (`src/server/redact`) applied at **every sink**: before evidence enters the LLM prompt, before anything is sent to the browser, before any DB write, and in the logger.

Layers, applied in order:
1. **Structural drop at the adapter**: env values are never returned by `getApp`; only `{key, encrypted}`. `verificationCode`, `user` objects, and the token are dropped by projection.
2. **Known-value redaction**: for the current app, the adapter keeps an in-memory set of env values (and our own configured secrets) and replaces any occurrence in free text with `[REDACTED:ENV:<KEY>]`. Values shorter than a minimum length are matched only as whole tokens to avoid shredding logs.
3. **Pattern redaction**: `Authorization:`/`Bearer` values, JWT-shaped strings, `-----BEGIN … PRIVATE KEY-----` blocks, URLs with embedded credentials (`scheme://user:pass@`), common cloud key formats, `key=value` where key matches `(?i)(pass(word)?|secret|token|api[_-]?key|private|credential)`, high-entropy tokens above a length threshold in key-like positions.
4. **Key-name redaction for JSON** (case-insensitive deny-list on field names).
5. **Egress canary tests**: tests inject canary secrets into env values, logs, build output and uploaded files and assert the canary is absent from the LLM request body, SSE stream, DB dump, audit log and application logs.

Redaction is lossy by design; it fails closed (if the redactor throws, the item is dropped and flagged `redaction_error`). The LLM sees env **keys** (useful for diagnosing missing config) but never values.

Uploaded archives (Journey B): `.env*`, private keys and files matching secret patterns are excluded from the upload and listed to the user; file contents are not sent to the LLM except small manifest excerpts (names/versions/scripts) after redaction.

## 4. Scoped access

Because token scoping is undocumented, scope is enforced by our policy layer:
1. **App allowlist** `LIARA_ALLOWED_APPS` (comma-separated, **required** for any mutating mode; `*` is rejected). All app-scoped tools check membership; the app picker only shows allowlisted apps.
2. **Tool allowlist by risk class**: R0 always on; R1/R2 only when `ENABLE_MUTATIONS=true`; R3 endpoints are not registered, so no code path can reach them (matrix §4.3).
3. **Parameter guards** in the policy engine: `scale ∈ {0,1}`; `planID` must appear in the live `GET /v1/me` catalogue and be `available`; env keys match a strict regex and the total variable count is capped; app names match the Liara name regex; domain names are validated hostnames.
4. **Blast-radius limits**: at most one mutation per run step; configurable cap on mutations per app per hour and per day; no mutation while another approved action on the same app is `executing`.
5. **Team scoping**: a configured `LIARA_TEAM_ID` is applied by the adapter to all requests; the agent never accepts a team id from the browser.
6. **Outbound-network scope**: the only hosts the server may call are `api.liara.ir` (adapter), the configured LLM host, and — for verification probes — hostnames returned by `liara_list_domains` for the allowlisted app (see §8).

## 5. Human approval and expiry

1. Every R1/R2 action is a **proposal** until a human approves it in the UI. Chat text (including "yes") can never approve anything — chat content is influenceable by injected log text.
2. An approval binds: `tool`, canonical input, target app, `state_fingerprint` (hash of app status/scale/plan/current release/applet ids at proposal time), `run_id`, `session_id`, `risk`. Its identifier is `action_hash = SHA-256(canonical JSON)`.
3. **Expiry**: R1 default 10 min, R2 default 5 min (`APPROVAL_TTL_SECONDS_R1/R2`). Expiry is checked server-side against the DB clock at both approve time and execute time; the UI countdown is cosmetic. Expired approvals can only be re-proposed, which re-reads state.
4. **R2 typed confirmation**: the approver must type the app name; it is compared server-side.
5. **Drift guard**: immediately before execution the executor re-reads the app, recomputes the fingerprint and aborts with `STATE_DRIFT` if it changed (e.g. someone redeployed meanwhile), requiring a fresh proposal.
6. The approval UI shows exactly what will be sent (tool, parameters with secret values masked, target app, expected effect, how it will be verified) — rendered from the stored `action_hash` payload, not regenerated from the LLM text.
7. The approver identity is the authenticated session; one session cannot approve a proposal created in another run.
8. Rejection and expiry are first-class audited outcomes.

## 6. Idempotency and replay protection

Liara documents no idempotency mechanism, so we provide it:
1. Execution key `idem = approval_id`. The executor performs an atomic compare-and-set `approved → executing`; any second call (double click, retry, replay, two tabs) finds the state ≠ `approved` and returns the stored result without calling Liara.
2. The mutation call is made at most once per approval. **No automatic retry of mutating requests.** On network timeout/5xx, the outcome is "unknown": the executor transitions to `reconcile`, reads state, and reports either `applied` (post-conditions satisfied), `not_applied`, or `unknown` — in which case a *new* approval is required to try again.
3. Create-style actions check for the target's prior existence first (`create_app`: name must not exist; `create_domain`: not already attached) so a repeat cannot create duplicates.
4. Results (redacted) are stored under the idempotency key so UI reloads show the same outcome.
5. Approvals are single-use even when execution fails.

## 7. Audit logging

- Append-only table; each row stores `ts`, `actor` (session/operator id), `run_id`, `event`, redacted `data`, `prev_hash`, `hash = SHA-256(prev_hash ‖ canonical(row))` — tamper-evident chain, verified at startup and via `GET /api/health` (chain OK/BROKEN).
- Events include: login/logout/failure, run created, every tool call (name, risk, app, duration, status code, **not** bodies), policy decisions with reason codes, evidence summaries (counts/ids, not raw logs), LLM calls (provider, model, token counts, schema-valid yes/no — **not** prompt text by default), approval created/viewed/approved/rejected/expired, execution start/result/reconcile, verification verdict, redaction errors, `injection_suspect` flags, config changes at boot (mode flags, allowlist size).
- Rows never contain raw secrets, tokens, env values or full prompts; redaction runs before hashing.
- Retention configurable; export as JSON Lines. Application logs follow the same redaction pipeline.

## 8. Post-action verification

Every mutating tool defines machine-checkable post-conditions (MVP_SPEC A.3, B.1 step 9). Rules:
1. Verification uses fresh API reads taken *after* the action timestamp, never the mutation response alone ("submitted" ≠ done).
2. Bounded polling (interval, max duration); on timeout the verdict is `UNVERIFIED`, never `OK`.
3. Verdicts: `VERIFIED`, `PARTIAL` (some criteria failed — listed), `UNVERIFIED`, `FAILED`. The UI and LLM-generated text must quote the verdict; the LLM cannot upgrade it.
4. A failed/unverified result never triggers another mutation automatically.
5. **HTTP probes (optional, `PROBE_ENABLED`)** — SSRF-safe: only `GET`/`HEAD`, only to hostnames returned by Liara for the allowlisted app, HTTPS preferred, DNS resolved by us and rejected if it resolves to private/loopback/link-local/metadata ranges, redirects not followed, short timeout, response body size-capped and never stored/forwarded to the LLM.

## 9. Prompt injection & LLM containment

- The LLM has no tools, no network, no token. Its only output channel is a zod-validated JSON object that code interprets.
- Untrusted text (logs, events, build output, README/manifest excerpts) is wrapped as quoted data with explicit delimiters and a standing instruction that it is data, not instructions. This is a hygiene layer, **not** the boundary.
- The real boundary: executable actions are re-derived by code from detector findings + allowlist + policy engine; LLM suggestions that don't map to a supported remedy are rendered as advice text. Even a fully compromised LLM can at most (a) produce misleading prose and (b) propose allowlisted actions that still need a human click on a card generated from stored parameters.
- Citations required: hypotheses must cite evidence ids that exist; others are dropped.
- LLM output rendered as text/markdown with HTML escaping; no `dangerouslySetInnerHTML`; links restricted.
- Provider data policy: only redacted evidence is sent; a `LLM_ALLOW_LOG_CONTENT=false` option sends only counts/patterns/categories instead of raw log lines for privacy-sensitive users.

## 10. Other controls

- **Upload safety** (Journey B): size cap, streaming to a temp dir outside the web root, safe extraction (reject `..`, absolute paths, symlinks/hardlinks escaping root, device files; cap entries, total uncompressed size and compression ratio), never executing or building user code on our server, temp files deleted on completion/expiry.
- **Dependency hygiene**: lockfile committed, `npm audit`/OSV in CI, pinned versions; no `postinstall` network fetches.
- **Error handling**: user-facing errors are Persian and generic; internal details only in redacted logs; stack traces never returned.
- **Time**: all comparisons use server clock; skew between client and server never extends an approval.
- **Data minimisation**: raw API payloads are processed in memory and discarded; only redacted evidence summaries are persisted, with TTL.

## 11. Control → test map (Phase 1 must implement)

| Control | Test |
|---------|------|
| Token isolation | Lint rule test; build-output grep; snapshot of `JSON.stringify(adapter)`; request recorder shows token only in the `Authorization` header to `api.liara.ir`. |
| Redaction | Canary tests across LLM body / SSE / DB / audit / logs. |
| Allowlist & parameter guards | Policy table tests incl. `scale=2`, unknown plan, `*` allowlist, app not allowed. |
| Approval expiry/binding | Clock-mocked tests: expired, altered params, other session, other run. |
| Idempotency | Concurrent double-approve ⇒ exactly one adapter mutation (recording adapter). Timeout ⇒ reconcile path, no retry. |
| Drift guard | Fixture changes between proposal and execute ⇒ `STATE_DRIFT`. |
| Audit chain | Mutate a row ⇒ chain verification fails; secrets absent. |
| Verification | Each tool's verify() with success/partial/timeout fixtures. |
| Injection containment | Hostile log/build/readme fixtures ⇒ no extra executable action; flagged. |
| SSRF probe | Private-IP, redirect and DNS-rebinding fixtures rejected. |
| Archive safety | Zip-slip, symlink, bomb fixtures rejected before any API call. |
| UI auth/CSRF | Unauthenticated and cross-origin requests rejected. |

## 12. Known residual risks (accepted for MVP, to be stated in README)

- Token scope is whatever the Liara token grants; a leaked server env leaks full account power. Mitigation: dedicated team/account, rotation, allowlist, `ENABLE_MUTATIONS=false` default.
- Liara response vocab (states, units) unknown until live-tested; early detectors run in low-confidence mode and say so.
- Single shared operator login (no per-user RBAC) — acceptable for hackathon single-tenant use.
- Redaction is heuristic; novel secret formats in logs may slip through. Mitigated by known-value matching and the log-content opt-out.


## 13. Phase 1B security review (read-only integration)

### 13.1 Data-flow audit
| Flow | Control | Test |
|---|---|---|
| Liara API → adapter | GET-only client; pinned host; no redirects; size/timeout/concurrency/RPS/per-minute budgets; error bodies reduced to key names | `http-client.test.ts`, `read-only.test.ts` |
| Adapter → domain model | strict strip-mode schemas (unknown fields dropped), env values never projected, free text redacted + capped | `projection.test.ts` (random-key poisoning, canaries) |
| Domain → API route → browser | allowlist before upstream call; `redactDeep` on every response; `no-store`; indistinguishable 404 | `routes.test.ts`, `service.test.ts` |
| Liara API → fixture recorder → disk | explicit double opt-in; field allow-list; pseudonyms; **fail-closed validation**; all-or-nothing write; mode 0600; git-ignored; never raw payloads | `recorder.test.ts`, `scripts.test.ts` |
| Liara API → verification report → disk | structure only (types, vocabularies ≤ 40 chars sanitised, counts, formats, ages); app pseudonymised; secrets scan before write | `verify.test.ts` |

### 13.2 Redaction coverage (and limits)
Covered: DB connection strings (`postgres/mysql/mongodb+srv/redis/amqp…`, user:pass, :pass-only and token-only userinfo), URL credentials, `Authorization`/Bearer/Basic, Cookie/Set-Cookie, secret-bearing query strings (`token`, `code`, `state`, `sig`, `X-Amz-*`…), `key=value` pairs with sensitive names, JWTs, PEM keys, vendor key formats, long hex/base64 blobs, emails, ANSI/bidi control characters; env values and the API token via HMAC fingerprints (no plaintext retained). Shareable mode additionally pseudonymises hostnames, IPs and local paths.
**Limits:** heuristic (novel secret formats can survive); value fingerprints only match whole tokens and only for apps whose detail was read in the same process; operator-view logs keep hostnames and ports by design; the fingerprint registry is process-local and bounded (2000).

### 13.3 Request budgets
Per-attempt rolling budget (`LIARA_REQUEST_BUDGET_PER_MINUTE`, default 120) in the server client; hard lifetime cap and ≤ 2 rps / 2 concurrent in the verification and recording commands; ≤ 12 applet lookups per overview render; diagnostics probe cached for 20 s.

### 13.4 Dependency advisories (reviewed 2026-10-21)
- `npm audit --omit=dev`: **0 vulnerabilities** (production tree).
- Full `npm audit`: **5 high advisories, one root cause**: `braces ≤ 3.0.3` (GHSA-vfj7-8cjw-p6xm, CWE-674 stack exhaustion on deeply nested brace patterns) reached via `eslint-config-next → @next/eslint-plugin-next → fast-glob@3.3.1 → micromatch@4.0.8 → braces@3.0.3`. **No patched `braces` release exists** (3.0.3 is the latest published version), so it cannot be fixed by upgrading or `overrides`.
- Phase 1A showed 7–9 advisories via the `shadcn` CLI; Phase 1B **removed the shadcn CLI dependency** (its CSS is vendored in `src/app/shadcn-tailwind.css`; use `npx shadcn@latest` ad hoc to add components), eliminating the `@shadcn/registry`, `ts-morph` and second `fast-glob` chains.
- **Accepted risk:** the remaining chain is a development-time lint dependency, never bundled, never run in production, and only globbing our own source tree (no attacker-controlled patterns). Re-check on each dependency update; remove if `eslint-config-next` moves to a patched glob stack.

### 13.5 Remaining risks after Phase 1B
1. **No live evidence yet** — vocabularies, formats, units, `since`, `teamID` and encrypted-env masking are unverified; interpretations are labelled heuristic.
2. In-memory sessions / throttling / capability state (single instance); global login bucket without a trusted proxy.
3. CSP still allows inline scripts (Next bootstrap).
4. Redaction is heuristic (see 13.2).
5. The verification/recording commands read the token from the environment; the operator's shell history and `.env.local` permissions are outside this tool's control (`chmod 600 .env.local` recommended).
6. Dev-only `braces` advisory (13.4).


## 14. Phase 1C — diagnostic assistant and AI safety

### 14.1 Zero-cost / no live AI (enforced, tested)
* No AI client, SDK dependency, API-key variable or AI host exists in `src/`, `scripts/`, `package.json` or `.env.example` (static test).
* `AI_LIVE_REQUESTS_ENABLED` ≠ false and any `AI_PROVIDER` other than `mock|disabled` are **rejected at startup**; `resolveProvider()` cannot return a live client even from a forged config.
* The diagnostics layer has no `fetch`, `http(s)`, `net`, `tls`, `dns`, `undici`, `child_process` or `process.env` (static test); importing it has no side effects and creates no manager.
* Every unit/integration test runs under a global network guard; any outbound attempt fails the suite. Running all nine scenarios produces zero attempts.

### 14.2 LLM output is never authority
The provider receives sanitised structured context and returns text only. Output is validated (schema, length, citations ⊆ real evidence ids, instruction-like text rejected) and extra fields (e.g. forged `actions`) are stripped. Recommendations and risk classes come only from the deterministic engine, which has no way to execute them. A hostile/failed/slow provider degrades only the optional narrative.

### 14.3 Untrusted log content
Log lines are DATA: detectors output categories and numbers; Persian text is built from facts (never from log strings); excerpts are shareable-redacted, ≤ 200 chars, ≤ 3 per finding; missing-config findings keep none. Instruction-like text sets an `injection_suspected` caveat and changes **nothing else** (tested: identical hypotheses, ranking, confidence and recommendations with/without seven injection payloads; all upstream calls remain bodiless GETs).

### 14.4 Run isolation, abuse and persistence
Per-session ownership (session id stored only as SHA-256), allowlist before any record/upstream call, duplicate/concurrency/quota limits, atomic start, timeouts, cancellation, bounded retries, no unhandled rejections from storage failures. SQLite file mode 0600, git-ignored; every persisted string is shareable-redacted; no tokens, raw responses, whole logs, env values or session ids; audit is a hash chain verified in tests (tamper ⇒ detected).

### 14.5 New residual risks
Heuristic redaction can miss novel secret formats inside cited excerpts · pattern detectors are language/framework specific (false negatives, not invented causes) · in-memory single-instance throttling and run tracking · `node:sqlite` is experimental (Node ≥ 22.13) · POST routes now exist (`/api/diagnostic-runs`, `/cancel`): guarded by session + same-origin + JSON + rate limit, and they can only start/stop an offline analysis.

## 15. Phase 1D — agent, approvals and simulation

### 15.1 What is enforced (and tested)
* **Tool containment**: only registered read-only tools run, through one `executeTool` gate (strict args, app == run app ∧ allowlisted, budget, timeout, cancel, output projection, audit). No URL/path/command arguments.
* **Instructions are data**: log text, tool output, chat text and the (mock) model cannot start an operation or approve one. The parser refuses direct commands and policy/approval overrides; plans never depend on evidence content; recommendations are structured, not parsed from text.
* **Approvals**: server-side only — session binding, expiry, stored-digest integrity, presented digest, policy re-evaluation, typed app name (R2), drift check, atomic single-use claim. A client `approved` flag is rejected by the strict body schema and by a static scan.
* **No execution path**: `ExecutionBackend.kind === "simulation"`; the simulator is isolated (static scan: no imports beyond local types, no I/O); the Liara transport exposes only `get`; a recording transport shows only read endpoints during a full approve/simulate flow.
* **Abuse limits**: 500-char messages, 100 messages/conversation, 20 runs/10 min/session, ≤ 2 concurrent runs, one run per app, ≤ 3 proposals per run, 200 transitions per run.
* **Response redaction** now lets exactly two 64-hex integrity hashes through (`digest`, `stateFingerprint`, only under those keys); every other 64-hex value is still masked.

### 15.2 Residual risks (accepted)
* Audit hash chain is local: a database writer can recompute it, tail truncation is undetectable, and there is no external anchor. Do **not** describe it as tamper-proof.
* One shared operator password ⇒ actor binding is per session, not per person.
* Drift detection is coarse; expiry is lazy; the intent parser is keyword-based and can mis-route (it never executes) or over-refuse.
* Everything is exercised on synthetic data; live behaviour is unverified, and real mutations remain disabled.

## 16. Phase 1E — untrusted uploads and the first-deployment journey

### 16.1 Enforced and tested
* **Archive handling**: size/entry/ratio/path/symlink/encryption/duplicate limits before any write; lying headers cannot over-allocate; isolated 0700 workspace removed in `finally`; sensitive files and dependency trees never extracted; tested with 29 ZIP cases + route and journey tests.
* **No execution of uploaded content**: static scan forbids `child_process`, `eval`, `Function`, `require`, dynamic `import()`, network and Liara imports in `src/server/deploy`; a test uploads a project whose scripts/config/source would write a sentinel file if run, and asserts it does not exist.
* **Uploaded text is data**: only validated tokens leave the analyzer; instruction-like metadata is flagged, ignored and never echoed; plan parameters are a strict schema (canonical commands, env **names**, no free text).
* **Secrets**: `.env*`, `.npmrc`, keys and credentials are never inflated or read; canary values are asserted absent from the analysis, readiness report, plan, responses, SQLite tables and audit.
* **Authorization**: every route requires a session, same-origin and rate limit; upload additionally needs a ZIP content type; cross-session access to uploads, checklist, plans, decisions and live requests is `not found`.
* **Simulation/live separation**: approvals are `scope:"simulation"`; `authorizeLiveExecution` refuses every input; plans are `environment:"simulation"`, so a simulated approval cannot be replayed against a live-target action.
* **Cost/network**: the journey makes no network call and no AI call (asserted); only the allowlist read (`listApps`) touches the Liara layer.

### 16.2 Residual risks
Static analysis can miss malicious code (it never claims safety); the in-house ZIP reader is intentionally minimal (unsupported variants are rejected, not handled); upload quota is process-local; the chosen app name can only be checked against visible apps; one shared operator identity; the artifact is not retained.

## 17. Phase 2A — live deployment executor

* **Default off, and the flag is not authority.** A write needs the flag, a live data source, a token, operator attestations (units, contract, network id), and a fresh live-scope approval for the exact operation; every step re-validates from storage. Configured credentials are never interpreted as permission.
* **One write surface:** three typed methods on `LiveWriteTransport`, implemented only by `LiaraWriteClient` (static test: `"POST"` appears nowhere else in server code that reaches Liara; `fetch`, `node:https`, `node:dns` are confined to `write-client.ts` and `probe.ts`).
* **Approval binding:** operator, team, app, plan, bundle, network, platform, artifact digests, config, env key names, financial impact, TTL 10 min, unique operation id, state fingerprint, typed app name; digest recomputed on every use; single-use claim; simulation approvals permanently invalid (`live_simulation_approval_rejected`).
* **No blind retry; reconcile by read; preserve partial resources; no delete/upgrade/restart/charge.** `DEPLOYED` only when all six verification levels are verified.
* **Untrusted inputs:** archives re-validated at proposal and execution and compared by digest; secrets never packaged; upstream error bodies never stored; probe is SSRF-hardened and restricted to the validated app name under an operator-trusted suffix.
* **Allowlist** is never disabled; extension rows are written only by the bootstrap transaction for the exact team+name of a confirmed, approved creation.
* **Zero AI cost:** no provider code in `src/server/live`; `AI_LIVE_REQUESTS_ENABLED=false`.
* Residual risks: the CLI-only fields are attested, not verified; a successful create whose app never appears needs a human; single shared operator identity; health proof depends on the operator-supplied domain/marker.

## 18. Phase 2B — preflight and executor hardening

* **Read-only preflight:** `preflight:liara` is dry-run by default; live GETs need `--approve-live-readonly`, are bounded (budget, ≤2 concurrent, ≤2 req/s) and write classes only. The undocumented network list needs a second, explicit opt-in.
* **No attestation by configuration alone:** pricing units must be corroborated by independent data; unresolved billing semantics block unless explicitly accepted as risk (and stay labelled unknown); a team mismatch is a security blocker.
* **Explicit financial acknowledgment** is required with the typed name; the approved state includes a signature of the preflight so drift voids the approval.
* **Errors are not evidence:** after a rejected write the state is read; ambiguity ⇒ operator review; no automatic deletion, rollback or retry.
* **Identity before scope:** the allowlist grows only after the API-reported name equals the approved name; first-app mode uses an empty set, never a wildcard.
* Residual risks: CLI-only fields and the network list remain unverified live; balance unit ambiguity is handled conservatively, not resolved; the health probe depends on the operator-supplied domain/marker.

## 19. Phase 2D — releases to an existing application and the restricted official-CLI backend

* **Existing apps are never "adopted by accident":** a separate operation kind with its own binding; the app must already be in the operator's scope; a release never extends the scope; identity (name, plan, platform, scale) is re-proven at proposal, approval and execution.
* **The CLI is a restricted backend, default OFF:** `LIARA_CLI_ENABLED` plus a pinned tool (absolute entry path, SHA-256, exact version) in live mode; a flag alone does nothing.
* **No arbitrary command execution:** the only process-starting file is `live/cli/process-runner.ts` (`spawn`, argv array, `shell:false`, closed stdin, timeout, output cap); the argv comes from one strict builder (allow-list + deny-list, values cannot start with `-`); the real runner is never constructed in tests (static scan).
* **Secrets:** the token is never in argv, environment, logs, audit or process output; it exists only in a 0600 file inside a per-run private `HOME` that is removed afterwards. The environment is an exact 10-variable allow-list (no inheritance).
* **Approval binding for the CLI:** tool identity, argv template digest and file-manifest digest; the run is refused before starting if any differs. Output is sanitised and never parsed; the outcome is established by reading the releases list; one run only.
* Residual risks: see `DEPLOYMENT_BACKEND_DECISION.md` §6 (package contents beyond the entry hash, the CLI's own ignore rules, token on disk during the run, uncontrolled CLI egress).

## 20. Phase 2E — recreated-app drift and mode clarity

* An approval is bound to one application **instance**, not a name: instance id, creation time, network, plan, platform, default-subdomain flag and release baseline are re-proven at approval and at execution; any difference voids it before a byte is sent.
* The UI distinguishes simulation, live-disabled (read-only) and live-enabled by banner, frame colour and text; controls are disabled unless the mode is live-enabled and every check is green. The CLI fallback is never selected by default.
* Health-verification settings are validated offline (suffix ↔ network rule, specific marker, valid path); the tool never modifies configuration files.


## 21. Final hardening pass (local review; not a production audit)

* **SSRF address guard (`probe.ts`)**: every resolved address is parsed (IPv6 in any notation, embedded dotted IPv4, zone ids) and IPv6 is an *allowlist* of global unicast `2000::/3` minus 6to4, Teredo/IETF assignments, documentation, 6bone, NAT64, IPv4-compatible/mapped/SIIT forms (which are judged by their embedded IPv4). Unparsable text is blocked. One blocked address refuses the whole DNS answer. Tests: `tests/unit/probe-address-guard.test.ts`.
* **Probe default request (`tests/unit/probe-default-request.test.ts`)**: exercised against a *mock* of `node:https` only — total deadline (slow-drip cut off), abort signal destroys the request, redirects never followed, 4 KiB cap, truncated responses are a network failure, consistent failure categories. This proves behaviour under those simulated conditions, **not** a real production socket.
* **Health marker**: the new-app preflight uses the same `markerIsSpecific` rule as the existing-app path (a generic marker such as `ok` blocks).
* **Data minimisation**: the browser never receives `ownerHash`, `actorHash` or the raw `teamId`; live routes pass through `toPublicLive` (`src/lib/live-public.ts`), which replaces `teamId` with `teamScope: "team" | "personal"`.
* **Rate limits**: login — 5 failures / 15 min per client key plus 20 / 15 min globally, checked *before* the password is verified. Without `TRUST_PROXY_HEADERS` all clients share one key (a spoofed `X-Forwarded-For` cannot buy attempts; the cost is that one attacker can lock the single operator out for 15 min — fail-secure by design). With a trusted proxy the rightmost address is used. The offline preview has its own 12 / min / session budget, charged before the upload body is read.
* **Status reads**: `GET …/live/status` keeps its lazy clean-up of expired, never-executed proposals (idempotent; one transition and one audit row per proposal). With nothing due it performs no store write — pinned by `tests/integration/live-status-readonly.test.ts`.
* **Multi-instance recovery**: an operation carries a `runner` stamp (instance + pid). Start-up recovery leaves an operation alone when another live instance on the same host is running it (pid alive and younger than the executor's max age); a dead, stale or unstamped operation is still moved to review exactly once. Limits: single host only (no cross-host lock), pid reuse is bounded by the age cut-off. Tests: `tests/integration/live-multi-instance.test.ts`.
* **UI truthfulness**: the cancel control exists only while the operation is `AWAITING_LIVE_APPROVAL` (`APPROVED` means execution was claimed); a release identifier is labelled as an identifier, not proof of health; "deployed" wording is neutral unless runtime provenance is observed.
* **Not done here**: `npm audit` / dependency freshness (no network), any live Liara request, any load or soak test, any multi-host deployment test.
