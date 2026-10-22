# First real deployment — operator checklist (**do not start before every box is ticked**)

The executor (Phase 2A) and its preflight (Phase 2B) are built and tested with a fake transport. Nothing below has been performed. The first live deployment should be the tiny demo fixture (`npm run demo:zip`), on a team/account you are willing to pay for, and watched to the end.

## A. Decide and verify (read-only; you do these, outside the tool)

- [ ] **Read the official sources yourself.** The public pricing page lists seven PaaS plans in GB / cores / Toman (hourly and monthly) but states **nothing** about when billing starts, the minimum balance to create an app, zero-balance behaviour, VAT or bundle prices; the API states no units. Decide whether you accept those unknowns as risk.
- [ ] I created `LIARA_PLAN_UNITS_JSON` (schema in `LIVE_DEPLOYMENT_EXECUTOR.md` §5) with `verifiedAt` and a `source` URL, and listed in `acceptedUnknowns` **only** the facts I knowingly accept as unresolved. The tool will still refuse it unless the live catalogue and the public price page corroborate the same units.
- [ ] Network: I ran `liara network:list` (or the console) and know my network `_id`; if the account has none I created one **myself** (this tool never creates networks). `LIARA_NETWORK_ID` is set and `LIARA_ALLOW_UNDOCUMENTED_ENDPOINTS=true` is set so the id can be verified (the endpoint is CLI-only).
- [ ] I compared the three write payloads with the official `@liara/cli` (`bundlePlanID`, `network`, `platformConfig` = `{}` for Next.js, `build` = `{"cache":true}`) and accept that they are CLI-only and unverified live → `LIARA_LIVE_CONTRACT_ATTESTED=true`.
- [ ] I know the default domain suffix of a new app (`LIARA_APP_DOMAIN_SUFFIXES`) and set `LIARA_LIVE_HEALTH_MARKER=liara-agent-demo` for the demo fixture.
- [ ] The account/team balance covers at least 24 h of the chosen plan **even if the balance unit were Rial**; I will top up manually — the tool never charges.
- [ ] Zero-app account: `LIARA_ALLOWED_APPS` may stay empty only with `LIARA_FIRST_APP_BOOTSTRAP=true`.
- [ ] `AI_LIVE_REQUESTS_ENABLED=false` remains; the free credit is not part of this plan.

## A2. Run the read-only preflight (needs your explicit authorisation each time)

- [ ] `npm run preflight:liara` (dry run: prints the planned GETs, sends nothing).
- [ ] `npm run preflight:liara -- --approve-live-readonly --include-networks --plan=<plan id> --app=<new name>` (≤ ~4 GETs; classes only are written to `fixtures/recorded/preflight-*.json`).
- [ ] The verdict is `READY_FOR_OPERATOR_APPROVAL`. Anything else lists the blocking category (`SECURITY > CONTRACT > PRICING > CONFIGURATION`): fix it and repeat. Do **not** work around a blocker.

## B. Prepare the tool

- [ ] `.env.local` has `LIARA_DATA_SOURCE=live`, a **least-privilege** token, `LIARA_TEAM_ID` (if team mode) and `APP_ACCESS_PASSWORD_HASH`.
- [ ] `npm run check`, `npm run test:e2e`, `npm run build`, `npm audit --omit=dev` are green on the exact checkout.
- [ ] I have **not** yet set `LIARA_LIVE_DEPLOY_ENABLED`. With it off, the panel shows every prerequisite and the read-only plan table; confirm the plan table matches the pricing page.
- [ ] I ran the existing read-only verification (`npm run verify:liara-readonly`) and it still passes.

## C. The controlled run

- [ ] Build the fixture ZIP: `npm run demo:zip` → upload it in the agent workspace → readiness is READY.
- [ ] Set `LIARA_LIVE_DEPLOY_ENABLED=true` and restart. The panel is **READY_FOR_APPROVAL**, all prerequisites green.
- [ ] Choose the plan, enter the name, re-select the same ZIP, create the proposal. Read **every** binding in the dialog: team, name, plan, bundle, network, platform, artifact digests, financial impact (unknowns are listed as unknown) and the final preflight summary.
- [ ] Type the exact app name, tick the financial acknowledgment ("I accept the cost") and approve (valid 10 minutes). Re-select the ZIP and press «شروع اجرای واقعی».
- [ ] Watch the timeline. Success means **all six ladder levels** are verified (`DEPLOYED`); `PARTIALLY_VERIFIED`, `NEEDS_OPERATOR_REVIEW` and `FAILED` are never success — read the evidence and recovery text.
- [ ] If it ends under review, open the Liara console and look; use «بررسی دوبارهٔ وضعیت» (read-only). Never press create again for the same name.

## D. After

- [ ] Record what really happened (statuses, field requirements, timings, billing start) and update `API_CAPABILITY_MATRIX.md` and `LIVE_API_VERIFICATION.md` from facts.
- [ ] Set `LIARA_LIVE_DEPLOY_ENABLED=false` again until the next deliberate deployment.
- [ ] Delete the test app in the Liara console **yourself** if you no longer want to pay for it — the tool never deletes anything.

## Stop immediately if

the network id, units or payload fields cannot be verified; the proposal shows an unexpected team, plan or digest; the state shows `accepted_but_not_visible`/`timeout` on create (do **not** retry: check the console); the balance is lower than the plan needs.

## E. Deploying to an EXISTING app (e.g. `liara-agent-demo`) — Phase 2D variant

This path creates nothing: no plan units, network id or billing semantics are needed.

- [ ] The app already exists, is **running** (scale 1), is a **Next.js** app, and its name is in `LIARA_ALLOWED_APPS` (the tool never adds it).
- [ ] `LIARA_LIVE_DEPLOY_ENABLED=true`, `LIARA_LIVE_CONTRACT_ATTESTED=true` (REST backend: the release fields `platformConfig` = `{}` and `build` = `{"cache":true}` are CLI-only), `LIARA_APP_DOMAIN_SUFFIXES`, `LIARA_LIVE_HEALTH_MARKER=liara-agent-demo`.
- [ ] Upload the demo ZIP in the agent workspace, then create the proposal with the API headers `x-live-kind: deploy_existing_app` and `x-live-backend: api` (UI controls for this kind are not implemented). Approve with the typed app name (valid 10 minutes), then execute with the same ZIP.
- [ ] Watch the six levels; only `DEPLOYED` is success. A definite REST rejection (HTTP 400) of the release leaves the app and its current release untouched.
- [ ] Only if REST is definitively rejected: install `@liara/cli` from a lockfile (`--ignore-scripts`) into a root-owned directory, pin `LIARA_CLI_ENABLED/ENTRY/ENTRY_SHA256/VERSION`, create a proposal with `x-live-backend: cli` (the approval binds the tool, argv and file manifest) and repeat.

