# Incident: first real source upload ended `NEEDS_OPERATOR_REVIEW` (`malformed_response`)

Target `liara-agent-demo` (existing app, REST backend), operation `lop_20261022184638_3db4352a`, 2026-10-22 18:48 UTC.

## What the record proves
* `create_application` step: `existing_app_verified` (nothing created). `upload_source`: started 18:48:18.525, ended 18:48:18.989 (≈460 ms), outcome `malformed_response`.
* In `write-client.ts` the code `malformed_response` is produced **only after a 2xx status**: every non-2xx status is classified earlier by `classifyStatus` (`bad_request`, `not_found`, `server_error`, …). So Liara answered with a success status, and this project then could not use the answer. A 2xx is *not* a rejection and not proof of failure: the archive (8,067 bytes) was very probably received and stored.
* `remote.sourceId = null`, `releaseId = null`, no `createRelease` was ever sent (ladder: `releaseCreated: unknown`, state never left the upload step). "Zero releases in the console" is therefore exactly what must be expected and says nothing about whether the source exists.
* The HTTP status and the reply were **not persisted anywhere** (the log line only reaches the server's terminal); the answer itself is intentionally never stored. That is the real gap: the failure could not be diagnosed afterwards.

## Candidate causes for an unreadable 2xx (the reply itself is lost, so these cannot be told apart for this attempt)
1. `sourceID` present but not matching this project's invented pattern `^[A-Za-z0-9][A-Za-z0-9_-]{2,127}$` (OpenAPI says only `type: string`; the official CLI — `liara-cloud/cli@master`, `services/upload.ts` + `commands/deploy.ts`: `.json<{ sourceID: string }>()` then `response.sourceID` — validates **nothing**). Any id containing `.`, `/`, `:` … was refused.
2. Body empty or not JSON.
3. JSON object without a `sourceID` string.

(1) is a proven deviation from the vendor contract and is fixed; (2)/(3) are now *observable* instead of invisible.

## Differences from the official CLI (upload.ts, 9.6.0)
| | CLI | this project | verdict |
|---|---|---|---|
| URL | `POST https://api.liara.ir/v2/projects/<app>/sources?teamID=<id or empty>` | same, `teamID` only when a team is configured | equivalent |
| body | `form-data`, single field `file` = read stream of the tmp `.tar.gz` (name/mime derived by the library) | `FormData`, single field `file`, Blob `application/gzip`, filename `source.tar.gz` | equivalent (verified on the wire in a test) |
| headers | `Authorization`, `User-Agent` (+ got defaults) | `Authorization`, `Accept: application/json`, `User-Agent`; `Content-Type` + boundary added by fetch | equivalent |
| timeout / retry | no request timeout, no retry | 180 s, no retry | stricter, fine |
| response | `.json()`; `sourceID` forwarded unvalidated | strict pattern (**bug**) | fixed |

## Fixes
* `contract.ts`: `VENDOR_ID` for `sourceID`/`releaseID` — 1–256 printable ASCII, no whitespace/quote/backslash (it is only ever re-sent as a JSON string and escaped when shown). The release request schema uses the same rule, otherwise a readable upload would have thrown at `createRelease`.
* `response-shape.ts` + `write-client.ts`: an unreadable 2xx now returns and logs a **sanitised shape** — status, recognised media type, byte count, empty/JSON/non-JSON, allowlisted top-level key names (unknown names masked) and kinds, and for the expected id its type, length and coarse format class. Never a value, never any text of a non-JSON body. Arbitrary key names and media types can themselves contain secrets, so character filtering alone is insufficient.
* `executor.ts`: the audit event `live.operation_needs_review` now carries `httpStatus` and `shape`; for an upload answered with 2xx the recovery text says plainly that Liara most likely stored the file, only the id was unreadable, nothing was released, and that continuing needs a new operation with a new approval.

## What is NOT possible
There is no documented API to list or fetch uploaded sources, so the orphaned source cannot be found or reused (a `sourceID` is required to create a release) and this tool does not guess it. The upload is never retried automatically.

Tests: `tests/unit/response-shape.test.ts`, `tests/integration/live-executor.test.ts`, `tests/integration/live-existing-deploy.test.ts`.

## Closure (second pass)
* **Third validator found and fixed:** the persistence schema (`schemas.ts`, `remote.sourceId` / `remote.releaseId`) still used the strict project-id pattern. A vendor id such as `6a87/…tar.gz` would have been accepted by the client and then made *saving the successful upload* throw, ending as `interrupted_by_restart`. It now uses `VENDOR_ID`; a SQLite round-trip test covers it.
* **Abandon is local-only:** `resolve("abandon")` is one compare-and-set on the operation row (`NEEDS_OPERATOR_REVIEW → FAILED`, releasing the (team, app) slot) plus one audit row. A transport that fails the test on any use proves neither `reverify` nor `abandon` (nor a service restart) sends a write; the fake's call log, the app and the release list are unchanged.
* **No replay:** the old proposal is `CONSUMED` (single use) — execute/approve/reject are refused before and after abandoning; an abandoned operation cannot be resolved again; a stale digest cannot approve a new proposal; a restart does not resume it; a new attempt is only possible as a brand-new proposal with its own id, digest and approval.
* **Pinned contract:** a test reads `docs/reference/openapi/paas.yaml` and asserts `sourceID` is a plain string with no pattern/format/enum/length. The 1–256 printable-ASCII acceptance bound is explicitly a LOCAL defensive policy, not a vendor requirement or full coverage of all documented strings. A 30,000-case property test checks that policy and JSON round-tripping; escaping remains necessary in other sinks.
* **Offline artifact binding for `liara-agent-demo.zip`** reproduces the digests of the failed proposal exactly (zip `80e52887…`, analysis `fd18e103…`, artifact `a26e1dde…`, 8 files, 8,067 bytes) → the build is deterministic and unchanged; verdict `READY`, 0 required env keys, 0 sensitive files.
* The audit trail shows **no write request after 18:48:18 UTC** (only a read-only `operation_reverify` at 18:53).

## Final offline verification — 2026-10-22

See the [Persian readiness report and evidence](qa/first-upload/README.md). All 1,565 unit/integration tests (63 files), all 135 Playwright tests and production webpack builds of the agent and the demo pass. The final pass adds secret-in-key/media-type diagnostics coverage through logger and SQLite audit, plus concurrent abandon and replay refusal after a SQLite reopen. The fresh artifact has the same three digests as the failed proposal.

The real operation is STILL `NEEDS_OPERATOR_REVIEW`; its proposal is `CONSUMED`. It was inspected read-only, never abandoned or replayed in this verification. The real environment was observed with the live flag ON (not changed by this work); the isolated verification and preview keep it OFF and have no real credentials. Therefore live readiness is **NO-GO**. No upload retry, live POST, deployment, paid AI request, commit or push occurred in this verification. The exact historical response remains unavailable, so the incident's exact response-level cause is not claimed proven.

## Second recovery incident: the Abandon control was invisible after a new login
* **Data:** the stuck operation `lop_…3db4352a` is `NEEDS_OPERATOR_REVIEW`, `active=1`, owner hash `857204a3…`; the operator's later runs/actions carry owner hashes `825755bd…` and `e9d21257…`. Ownership is `sha256(login session id)` and sessions live in server memory, so every restart / new login produces a different owner.
* **Cause:** the first fix listed locking operations only for the *current* owner, so the old one (owned by a vanished login) was filtered out; `resolve` also required the same owner (→ 404). The lock itself is per (team, app), so proposals kept failing with "already started".
* **Fix:** `status.locks` lists every operation of this team that holds a slot, tagged `owner | orphan | other_session`. `orphan` = no live login maps to the owner hash: a different authenticated session may then only *close* it (re-verify / abandon / cancel), with the explicit `adoptOrphan` flag, behind the two-step confirmation, with an audit row naming both actors. `other_session` (owner still logged in) is shown as a stub — no id, no record, no actions; the server answers 404 to any attempt. Approve / execute are never transferable; other teams' operations are never shown.
* **Tests:** `tests/integration/live-locked-operation.test.tsx`, `live-routes.test.ts` (production session wiring), browser E2E `tests/e2e/zz-lock-recovery.spec.ts` on a DB seeded with the incident (`tests/e2e/seed-locked-operation.ts`).

## Third finding: the real Liara build failed (`COPY failed: stat app/public: file does not exist`)
The upload and `createRelease` worked far enough for Liara to run `npm ci` and `next build`; the image build then failed because the fixture had no `public/` directory. Fix: `fixtures/demo-app/public/robots.txt` (`User-agent: *` / `Disallow: /`, harmless, 26 bytes). New artifact: ZIP `b94c529a…56db` (9 068 B, 9 files), analysis `12f9525e…b955`, tar.gz `cb9ed3d7…07f7` (8 319 B). Verified: the ZIP and the generated tar.gz both contain `public/robots.txt` at the archive root with identical bytes (parsed tar headers in `tests/integration/demo-fixture.test.ts`); the extracted artifact builds with the pinned `next 16.4.2` and, started locally, serves `/health` (unchanged body) and `/robots.txt`. A stale `dist-demo` ZIP is now caught by a test. Unchanged: the executor, the approval model and `/health`.
