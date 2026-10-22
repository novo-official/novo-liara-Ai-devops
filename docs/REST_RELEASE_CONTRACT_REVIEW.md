# REST release contract review — `liara-agent-demo` (final review before requesting the first live-release approval)

> **Nothing here was executed against Liara.** `LIARA_LIVE_DEPLOY_ENABLED` is off and `LIARA_LIVE_CONTRACT_ATTESTED` is **not** set by this review (setting it is the operator's own act). Sources compared on 2026-10-22: **OpenAPI** `liara-cloud/openapi` `main` @ `338325a4` (17 Oct 2026; our pinned `paas.yaml`, `me.yaml`, `billing.yaml` are byte-identical to upstream), **CLI** `liara-cloud/cli` `master` @ `14ec35f` (`9.6.0`, 18 Oct 2026; `deploy.ts`, `upload.ts`, `create-archive.ts`, `base.ts` re-fetched and identical to the copies reviewed earlier), and the official docs (docs.liara.ir Next.js, liara.json, software-plans, ignore pages).

Legend: **[D]** documented in the pinned OpenAPI · **[C]** observed only in the official CLI source (not documentation, never verified live) · **[O]** our implementation.

## 1. Source upload — `POST /v2/projects/{name}/sources`

| Aspect | OpenAPI [D] | CLI 9.6.0 [C] | Ours [O] | Status |
|---|---|---|---|---|
| Method / path | `POST /v2/projects/{name}/sources` | `v2/projects/${project}/sources` | `/v2/projects/<validated name>/sources` | identical |
| Body | `multipart/form-data`, **required** field `file` (binary, "The .gz file to deploy") | `form-data`: `file` = read stream of the temp `.tar.gz` | `FormData`: single field `file` (Blob, type `application/gzip`, filename `source.tar.gz`) | field name **documented**; filename/content-type are client details (the CLI's filename is `<timestamp>.tar.gz`) |
| Query | none declared | `teamID=<id>` on **every** request (empty for personal) | `teamID` when a team is configured | CLI-observed (docs say only "send teamID"); same as the CLI for a team account |
| Auth | Bearer JWT | `Authorization: Bearer` | same | identical |
| Timeout | — | none (`request: undefined`) | 180 s bound | ours is stricter |
| Success | 200 `{sourceID}` | `response.sourceID` | strict zod `{sourceID}` | documented |
| Errors | 400, 401, 404 (empty bodies) | 413 ⇒ "max source size" (client check 256 MiB first) | status-only classification | 413 is CLI-only |

## 2. Release creation — `POST /v2/projects/{name}/releases`

| Body field | OpenAPI [D] | CLI sends (source deploy, Next.js, non-git dir, no liara.json) | Ours | Status |
|---|---|---|---|---|
| `sourceID` | string | upload result | upload result | **documented** |
| `port` | number | `--port` / liara.json / `getPort('next')` = **3000** | `3000` (from the analysed project) | **documented** |
| `type` | string ("platform of your app") | `config.platform` = **the existing app's own `project.type`** (defaults from `GET v1/projects/{app}`) | `"next"`, **bound to the app's reported platform** (mismatch ⇒ blocked) | **documented** (value rule is CLI-observed) |
| `platformConfig` | — | `config['next'] \|\| {}` = `{}` (auto-version detection exists only for node/python/php/dotnet/go) | `{}` | **CLI-only** |
| `build` | — | `{cache, args, dockerfile, location}`; `cache = !(no-cache \|\| build.cache===false)` = **true**, others undefined ⇒ `{"cache":true}` | `{"cache":true}` | **CLI-only** |
| `gitInfo` | — | **always** present for source deploys; outside a git repository every `git` lookup fails ⇒ `{branch:null,message:null,commit:null,committedAt:null,remote:null,author:{email:null,name:null},tags:[]}` | exactly that constant (added in this review; before it we omitted the field) | **CLI-only** |
| `message`, `cron`, `args`, `disks`, `envs`, `healthCheck` | — | `undefined` ⇒ **omitted** (JSON drops them) unless set by flags/liara.json | omitted (the schema rejects them) | CLI-observed |

Result: our body = the three documented fields + **exactly the three CLI-only fields the CLI always sends** (`platformConfig`, `build`, `gitInfo`) and nothing else (test `rest-release-contract.test.ts`).
Success `200 {releaseID}` is documented; 400/401/404 documented with empty bodies; 428 `max_deployment_count_in_day`, 400 `frozen_project`, 408, 413 are CLI-observed and classified by **status only** (never by body).

## 3. What `LIARA_LIVE_CONTRACT_ATTESTED=true` means (exactly)

By setting it **you** state that you read the official CLI source and accept that: (a) `platformConfig: {}`, `build: {"cache": true}` and the all-`null` `gitInfo` object are what the CLI sends and are sent by us **without live proof that Liara requires or accepts them in this form**; (b) the upload filename/content-type and the tar layout below differ cosmetically from the CLI's; (c) `teamID` as a query parameter is CLI-observed, not documented. It does **not** attest pricing, build success, or anything about the CLI backend. The tool never sets it, never infers it, and `contract_attested_rest` stays a blocking contract check until you do.

## 4. Archive format — ours vs the CLI's

| | CLI | Ours | Risk |
|---|---|---|---|
| Container | `tar` package `create`, gzip level 9, file list = top-level entries + recursion | ustar tar, gzip level 9 | low: both are plain tar.gz |
| Directory entries | included | **not** included (regular files only; parents implied by paths) | low (standard extractors create parents) — unverified live |
| Metadata | real mtime/uid/gid | mtime 0, uid/gid 0, mode 0644, sorted | none (deterministic on purpose) |
| Ignore rules | defaults + one ignore file per directory (`.liaraignore` > `.dockerignore` > `.gitignore`) | same rules, **plus** never packaging `.env*`, keys, credentials | ours is stricter |
| Size limit | 256 MiB client check | 128 MiB (lowest bundle) | ours is stricter |

## 5. The trusted demo artifact (verified offline on 2026-10-22)

* `npm run demo:zip` → `dist-demo/liara-agent-demo.zip` — 8 files, 8 801 bytes, SHA-256 `80e5288707b83a3e411ff2ea4d544e4c8cde899727665feaceb4334864f26249` (deterministic; re-derive it yourself at proposal time, never trust this value blindly).
* Generated artifact: tar.gz, **8 067 bytes**, SHA-256 `a26e1dde0009df7cdf8003680f7ef24a234448b9ac73eca8d7cce4eef6fbaf81`, byte-identical across runs; 8 regular files: `.gitignore`, `README.md`, `app/health/route.js`, `app/layout.js`, `app/page.js`, `next.config.js`, `package-lock.json`, `package.json`. Nothing excluded because nothing unsafe exists in the fixture; no `.env*`, keys, `node_modules`, `.next`, `liara.json`, Dockerfile. The only "secret-like" words in it are the sentence "no secrets" in `README.md`/`package.json` descriptions.
* Dependencies: exactly `next 16.4.2`, `react 19.3.1`, `react-dom 19.3.1` (exact versions); every `package-lock.json` URL is `https://registry.npmjs.org/…`; scripts `dev`/`build`/`start` only. It was built and `/health` verified locally (`{"status":"ok","app":"liara-agent-demo","version":"1"}`); it was **never deployed**.
* Platform facts from the docs: Liara's Next.js builder runs **`npm install`**, then **`npm run build`** if present, and starts with the **`start` script**; default Node **22** (20 and 24 selectable via `liara.json` → `next.nodeVersion`), which satisfies Next 16's Node ≥ 20.9; Liara "automatically" adds the settings it needs to `next.config.js` (if that automatic edit fails the build reports "could not modify config file" and the documented fix is `output: 'standalone'`); the default port is **not stated** (docs examples use 3000) — we send `port: 3000` explicitly like the CLI does for `next`.

## 6. Possible charges (explicit)

* This operation creates **no application, plan, network or disk**. The existing plan keeps billing as before (unchanged by a release).
* **No official page states a separate build or deployment charge**, and none states that builds are free: the cost of a build is **unknown** (treat as possibly non-zero). Documented limits instead: deployments per day **20 / 50 / unlimited** (bronze / silver / gold), max build time **5 / 10 / 20 min**, source size **128 / 256 / 256 MB**.
* VAT, minimum balance and zero-balance behaviour: **not stated**. A too-low balance may surface as `400 frozen_project` / `402` (CLI-observed); this tool never tops up an account.

## 7. Failure modes (all recoverable; nothing is deleted or retried)

| Failure | Likelihood | Effect | Tool behaviour |
|---|---|---|---|
| Release body rejected (400) because a CLI-only field is wrong/required differently | low–medium (unverified) | no release; uploaded source inert | definite rejection → re-read releases → `FAILED`; app and current release untouched |
| Upload rejected (400/404/413) | low | nothing stored/used | `FAILED` |
| Timeout / 5xx / redirect on a POST | low | unknown | **never retried**; reconcile by reading the releases list; ambiguity ⇒ operator review |
| Build fails (npm install, `next build`, "could not modify config file", 5-minute bronze build limit) | low–medium | release exists but `FAILED`/`UNHEALTHY`; previous release keeps serving | ladder `FAILED`; no auto-rollback/delete; read build logs in the console |
| Daily deployment quota reached (428) | low | rejected | `FAILED` |
| App recreated / stopped / plan or subdomain changed / someone else deployed during the window | possible | approval void | `BLOCKED` at approval or `FAILED` before any write |
| Health unverifiable (wrong suffix, subdomain off, marker missing) | possible | never `DEPLOYED` | `PARTIALLY_VERIFIED` / review |

## 8. GO / NO-GO

* **GO — request Approval A now** (read-only preflight `npm run preflight:liara -- --app=liara-agent-demo --approve-live-readonly`, exactly 4 GETs). It cannot cost anything or change anything, and it is the only way to learn the **recreated** app's real identity, network and baseline.
* **NO-GO for Approval B (the real release) until A is green**, specifically: every check passes **except** `contract_attested_rest`; `expectedSuffix` printed by A equals your `LIARA_APP_DOMAIN_SUFFIXES` (**`liara.run` is correct only if the app has a network; without one the CLI rule gives `iran.liara.run`**); the app is running, a Next.js app, default subdomain enabled; the release baseline is read.
* **GO for B after that**, because: the request is now a documented-fields-plus-CLI-parity body; the worst realistic outcomes are a harmless 400 or a failed build; the CLI fallback exists (off); and every write is gated by the typed name, a fresh 10-minute single-use approval, instance binding and zero-retry reconciliation. Residual honesty: the first live write **is** the first live test of the three CLI-only fields.
