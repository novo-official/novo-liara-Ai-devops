# BoxAPI integration (real model, server-side, opt-in)

Status: implemented and tested with a mocked transport. A real response is documented in the "Live verification" section only after the bounded smoke test was run.

## 1. Verified contract (authoritative sources: <https://boxapi.ir/docs/ai/> and <https://boxapi.ir/docs/ai/models/>, read 2026-10-23)

| Item | Value |
|---|---|
| Base URL | `https://ai.boxapi.ir/ai/v1` (the only host the app accepts: `TRUSTED_BOXAPI_HOSTS`) |
| Chat endpoint | `POST {base}/chat/completions` (also documented: `/responses`, `/embeddings`, images, audio, video — **not used**) |
| Auth | `Authorization: Bearer <API key>` |
| Request | OpenAI-style: `{ "model": "...", "messages": [{ "role": "system" \| "user", "content": "..." }] }` |
| Streaming | Supported by the provider (`"stream": true`, `Accept: text/event-stream`). **Not used here**: the app makes one non-streamed request and shows an honest loading state (no fake token stream). |
| Models | Catalogue with pricing per 1M tokens (input / output / cache-read). The hackathon key supports only: `gpt-6.1-sol, gpt-6-astra, gpt-6-luna, gpt-6-sol, gpt-5-mini, gpt-5.6-luna, gpt-5.6-terra, gpt-5.6-sol, gpt-5.4-mini, gpt-5.3-codex` (+ two embedding models). |
| Not stated in the docs | The exact name of the output-cap parameter, the error-body shape, rate-limit headers, the usage object. The adapter therefore sends `max_completion_tokens` (the OpenAI-style cap current GPT models accept), classifies errors by HTTP status plus a bounded keyword hint, and reads `usage.{prompt,completion,total}_tokens` only if present. These assumptions are confirmed or refuted by the live smoke test below. |

### Model choice (cheapest supported by the hackathon key, catalogue prices in USD per 1M tokens)

| Model | Input | Output |
|---|---|---|
| **`gpt-6-luna`** (chosen) | **0.115** | **0.575** |
| gpt-5.6-luna | 0.230 | 1.380 |
| gpt-5-mini | 0.2875 | 2.30 |
| gpt-5.4-mini | 0.8625 | 5.175 |
| gpt-6-sol / gpt-6.1-sol | 2.30 | 11.50 |
| gpt-5.3-codex | 2.0125 | 16.10 |
| gpt-5.6-terra / gpt-5.6-sol / gpt-6-astra | 2.30 / 4.60 / 11.50 | 13.80 / 23.00 / 57.50 |

A request here sends roughly 0.5–1k input tokens and is capped at 600 completion tokens (`BOXAPI_MAX_OUTPUT_TOKENS`; this cap also covers any hidden reasoning tokens), i.e. at most about US$0.0005 per request at the `gpt-6-luna` catalogue prices (0.115 in / 0.575 out per 1M tokens). This is an estimate from published prices, not a guarantee; the provider's own usage figures are the only real cost evidence. If the model spends the whole cap before writing an answer, the app reports `output_truncated` (it never retries). The model is **never defaulted in code**: `BOXAPI_MODEL` must be set explicitly.

## 2. Configuration (server-side only; `.env.local`, git-ignored)

```
AI_PROVIDER=boxapi
AI_LIVE_REQUESTS_ENABLED=true     # both are required; either alone is rejected at startup
BOXAPI_API_KEY=<your key>         # never in source, .env.example, the browser, logs or shell history
BOXAPI_MODEL=gpt-6-luna
# optional: BOXAPI_MAX_REQUESTS_TOTAL (hard lifetime cap per server run — set 1 for a one-request demo; a restart resets it), BOXAPI_MAX_OUTPUT_TOKENS (64–4000, default 600), BOXAPI_TIMEOUT_MS (2000–60000, default 25000), BOXAPI_BASE_URL (https://ai.boxapi.ir/ai/v1 only)
```

`AI_PROVIDER=mock` (the default) keeps everything offline. The Liara execution flags (`LIARA_LIVE_DEPLOY_ENABLED`, `ENABLE_MUTATIONS`) are independent and stay off: **asking the model never touches Liara.**

Smoke test (one request, explicit approval flag; dry run without it):

```
npm run ai:smoke                              # dry run: prints configuration status, sends nothing
npm run ai:smoke -- --approve-live-ai-request # exactly ONE request
```

## 3. Where the model is used (and where it is not)

| Path | What happens | Authority |
|---|---|---|
| Diagnostic narrative (`/agent` investigations, `/assistant` runs) | The deterministic engine produces hypotheses/evidence; the model only writes a short Persian narrative from those structured facts. Findings, confidence and recommendations are unchanged. | none |
| Free-form guidance (`/agent`, "پرسش از مدل" button, or automatically for requests the parser cannot map) | The model answers in Persian, labelled "راهنما، نه نتیجهٔ بررسی". It has **no** access to the account or app state. | none |
| Everything else (deployment journey, live panel, approvals, executor) | Deterministic code only. | — |

Boundaries enforced in code and tests:
* The key lives in a `Secret`, is sent only in the `Authorization` header of the one provider class (`src/server/ai/boxapi.ts`), and never appears in config errors, logs, status, results or the browser.
* One attempt per call: no retries, no fallback model, no fallback text. A failure is shown as a failure (`ai_error` message / narrative `failure`), never as a mock answer.
* Cost guards: input clipped (question ≤ 500 chars, context ≤ ~6k chars), output capped, hard timeout, per-session 12 questions / 10 min, process-wide 40 requests / hour and 2 in flight.
* Model text is redacted for secrets, withheld if it looks like an injected instruction, stored with attribution (`source`, `model`, token counts) and can never create a run, proposal, approval or execution. Safety refusals (`blocked_action`, `policy_override`) are decided by the deterministic parser and never reach the model.
* Audit records outcome, model and token counts — never the question or the answer.
* Tests never reach BoxAPI: a fetch double stands in for it; the suite's network guard blocks real sockets.

## 3b. Evidence first (troubleshooting requests)

A troubleshooting request is **never** answered by the model alone. The model-only path (`answer()`) knows just the question and the authorised app *names*, so it can only give general advice — which is why a request to "investigate my slow site / HTTP 500 using real data" used to come back with "I have no access to logs or metrics".

| Request | Route |
|---|---|
| one symptom (slow, HTTP 500, restarts, deployments, health) | deterministic read-only investigation → report → (optional) model narrative |
| several symptoms incl. slow or HTTP 500 | **one** investigation with the superset of sources (`investigate_slow` → engine `why_slow`: status, releases, events, logs, CPU, RAM) instead of asking "which first?" |
| unmappable text that asks for the app's own logs / CPU / RAM / metrics / status ("بررسی کن … برنامه‌ام") | broad investigation, same pipeline |
| "ask the model" button on any of the above | **still** evidence first |
| general knowledge / planning questions | model advice (labelled: no access to the account) |

The app is resolved only from the authorised list (text match → conversation → the single authorised app). Unknown names are refused; several candidates ⇒ the agent asks which one; an empty list ⇒ an explicit "no authorised apps, nothing collected" message. Collection is the existing read-only tool plan (budgeted, timed, cancellable); the model is called only **after** every tool finished and only if at least one source is usable (otherwise the report says nothing usable was collected and no credit is spent).

What the model sees (`LLMContext.evidence`): per source — id, availability, freshness, verification, mode (`live`/`mock`), `simulated`, collection time, window and a compact summary (counts, newest/oldest timestamps, release tags/states, metric statistics; never raw payloads, env values or whole logs) — plus up to 6 newest error-like log lines with timestamps and the operator's question, both fenced as untrusted data. The list is the complete record of what was checked; the prompt forbids mentioning anything else, and a first-person claim of having acted or approved is withheld by `actionClaimSuspect` (the real guarantee is that model text has no path to proposals, approvals or the executor).

**Which messages count as "about the operator's own service".** Decided structurally in `src/server/agent/operational.ts`, not by a list of phrasings: an authorised app is named, or the operator says "my site/app", or a service word comes with a symptom/data word (slow, error, logs, CPU, RAM, health…), unless the wording is clearly about plans/pricing/how-to. Such a message is **never** answered model-only — not by Send and not by the "ask the model" button; if the app cannot be resolved the agent asks which one. An unknown app named with a problem report stays a deterministic refusal. (Before this, phrasings the keyword parser did not know — "لاگ‌های X را ببین", "آیا X سالم است؟", "مصرف منابع X چقدر است؟" — fell through to the model-only path.)

**Stale server guard.** Process-wide objects (Liara service, agent/diagnostic managers, live service) are keyed by a fingerprint of the configuration (data source, allowlist, token/key hashes, model, caps) and by their class identity; in development `getConfig()` re-reads the environment when it changes. A long-running server therefore cannot keep answering with an old data source, allowlist, provider or routing. `GET /api/agent/runtime` (and the collapsed "وضعیت سرور" panel in `/agent`) shows what the *running* process uses and flags any mismatch — no network, no secrets.

Liara endpoints used (all `GET`, documented in `docs/API_CAPABILITY_MATRIX.md`): `/v1/projects` (allowlist/listing), `/v1/projects/{name}`, `…/applets`, `…/releases`, `…/events`, `…/logs` (v1), `…/metrics/cpu`, `…/metrics/memory`. Metric units/limits are unverified, so CPU/RAM are reported as raw values and never as "saturation/OOM" without verified semantics.

## 4. Live verification

(Filled in after the bounded smoke test; see the final report of the integration task.)
