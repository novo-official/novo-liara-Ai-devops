import AxeBuilder from "@axe-core/playwright";
import { expect, test, type Page, type Route } from "@playwright/test";
import { E2E_PASSWORD } from "../../playwright.config";
import { nextZip } from "../helpers/projects";

/**
 * Result persistence & honesty of the recovery UX, in a real browser. The e2e database holds an operation for the mock target `demo-api` stuck in
 * NEEDS_OPERATOR_REVIEW under a login that no longer exists (seed). The network answers of `/resolve` and `/status` are STUBBED per test, so every scenario is
 * independent and NOTHING is ever changed on the server (no Liara access exists in this server anyway: mock data, live execution off).
 */
const OPERATION = /\/api\/agent\/live\/operations\/(lop_\d{14}_[0-9a-f]{8})\/resolve$/;
const ladder = (over: Record<string, string> = {}) => ({ apiAcceptedRequest: "ok", sourceUploaded: "ok", releaseCreated: "ok", buildCompleted: "ok", runtimeStarted: "ok", httpHealthVerified: "ok", ...over });
const opJson = (id: string, over: Record<string, unknown> = {}) => ({ id, kind: "deploy_existing_app", appName: "demo-api", state: "DEPLOYED", updatedAt: "2026-10-23T08:12:12.640Z", remote: { releaseId: "6ada74737ebf55567c8e9382" }, ladder: ladder(), failure: null, recoveryFa: [], evidence: { runtime: "inferred", appletsReadable: false }, ...over });

async function login(page: Page) {
  await page.goto("/login");
  await page.getByLabel("گذرواژه").fill(E2E_PASSWORD);
  await page.getByRole("button", { name: "ورود" }).click();
  await expect(page).toHaveURL(/\/apps$/);
}
async function openPage(page: Page) {
  await page.goto("/agent");
  await page.getByTestId("deploy-file").setInputFiles({ name: "my-site.zip", mimeType: "application/zip", buffer: nextZip() });
  await page.getByTestId("deploy-upload-btn").click();
  await expect(page.getByTestId("live-existing")).toBeVisible({ timeout: 15_000 });
  await page.locator('[data-testid="live-existing-target"][data-app="demo-api"]').click();
}
/** the REAL status document, edited the way the server's answer changes after a successful re-verification (the lock is gone) */
async function stubStatus(page: Page, edit: (j: Record<string, unknown>) => void | Promise<void>, fail = false) {
  await page.route(/\/api\/agent\/live\/status\?/, async (route: Route) => {
    if (fail) return route.fulfill({ status: 500, contentType: "application/json", body: JSON.stringify({ error: { code: "upstream_error", message: "x" } }) });
    const res = await route.fetch();
    const j = (await res.json()) as Record<string, unknown>;
    await edit(j);
    return route.fulfill({ response: res, json: j });
  });
}
const resolveWith = (page: Page, build: (id: string) => { status?: number; body: unknown }) =>
  page.route(OPERATION, (route: Route) => {
    const id = OPERATION.exec(new URL(route.request().url()).pathname)![1]!;
    const r = build(id);
    return route.fulfill({ status: r.status ?? 200, contentType: "application/json", body: JSON.stringify(r.body) });
  });
const lockCard = (page: Page) => page.locator('[data-testid="live-lock"][data-app="demo-api"]');
const withoutLock = (j: Record<string, unknown>) => void (j.locks = (j.locks as { appName: string }[]).filter((l) => l.appName !== "demo-api"));

const errors: string[] = [];
const requests: string[] = [];
test.beforeEach(async ({ page }) => {
  errors.length = 0;
  requests.length = 0;
  page.on("console", (m) => (m.type() === "error" || m.type() === "warning") && errors.push(`${m.type()}: ${m.text()} ${m.location().url}`));
  page.on("pageerror", (e) => errors.push(e.message));
  page.on("request", (r) => r.method() !== "GET" && /\/api\/agent\/live\//.test(r.url()) && requests.push(`${r.method()} ${new URL(r.url()).pathname}`));
  await login(page);
});
test.afterEach(async ({ page }) => {
  await page.unrouteAll({ behavior: "ignoreErrors" }); // no stub handler may outlive its test
  expect(errors.filter((e) => !/favicon/i.test(e) && !/status of (4|5)\d\d .*\/api\/agent\//.test(e)), errors.join("\n")).toEqual([]);
});

test.describe("the result of «بررسی دوبارهٔ وضعیت» is shown and kept", () => {
  test("DEPLOYED: the success result appears, with the release id and the ladder, and stays after the lock disappears, after more refreshes and after a tab switch", async ({ page }) => {
    await openPage(page);
    await expect(lockCard(page)).toHaveAttribute("data-access", "orphan");
    const opId = (await lockCard(page).getAttribute("data-op-id"))!;
    await resolveWith(page, (id) => ({ body: opJson(id) }));
    await stubStatus(page, withoutLock);
    await lockCard(page).getByTestId("live-reverify").click();

    const result = page.locator('[data-testid="live-result"][data-source="action"]');
    await expect(result).toBeVisible();
    await expect(result).toHaveAttribute("data-state", "DEPLOYED");
    await expect(result).toHaveAttribute("data-op-id", opId);
    await expect(result.getByTestId("live-result-headline")).toContainText("مستقر؛ اجرای برنامه از پاسخ سلامت HTTP استنتاج شده است");
    await expect(result.getByTestId("live-result-headline")).not.toContainText("همهٔ سطوح");
    await expect(result.getByTestId("live-result-release")).toHaveText("6ada74737ebf55567c8e9382");
    await expect(result.locator('[data-testid="live-result-ladder"] [data-value="ok"]')).toHaveCount(6);
    // the lock card is gone (legitimate: the operation no longer holds the slot) but the result is NOT
    await expect(lockCard(page)).toHaveCount(0);
    await expect(result).toBeVisible();
    // exactly one card for this operation (no duplicate from the refreshed status)
    await expect(page.locator(`[data-testid="live-result"][data-op-id="${opId}"]`)).toHaveCount(1);
    // the next step no longer sends the operator back to "run the offline preview" as if nothing had happened
    await expect(page.getByTestId("live-next-action")).toHaveAttribute("data-action", "deployed_previously");
    // provenance: inferred, with the applets-API explanation, and NOT claimed as direct observation
    await expect(result.getByTestId("live-result-evidence")).toHaveAttribute("data-runtime-evidence", "inferred");
    await expect(result.getByTestId("live-result-evidence")).toContainText("نه مشاهدهٔ مستقیم");
    await expect(result.getByTestId("live-result-applets-note")).toBeVisible();
    // survives a tab switch (the live panel is unmounted and mounted again)
    await page.getByTestId("path-tab-simulation").click();
    await page.getByTestId("path-tab-existing").click();
    await expect(page.locator('[data-testid="live-result"][data-op-id="' + opId + '"]')).toHaveAttribute("data-state", "DEPLOYED");
    // only ONE write-style request was made by the click: the (stubbed) resolve call
    expect(requests).toEqual([`POST /api/agent/live/operations/${opId}/resolve`]);
  });

  test("a refresh error does not erase a confirmed success; it is announced honestly", async ({ page }) => {
    await openPage(page);
    await resolveWith(page, (id) => ({ body: opJson(id) }));
    await stubStatus(page, () => undefined, true);
    await lockCard(page).getByTestId("live-reverify").click();
    await expect(page.getByTestId("live-result")).toHaveAttribute("data-state", "DEPLOYED");
    await expect(page.getByTestId("live-refresh-error")).toBeVisible();
    await expect(page.getByTestId("live-refresh-error")).toContainText("نتیجهٔ تأییدشدهٔ بالا حفظ شده است");
    await expect(page.getByTestId("live-result")).toBeVisible();
  });

  test("NEEDS_OPERATOR_REVIEW is never shown as success: the card says review is still required and keeps the recovery guidance", async ({ page }) => {
    await openPage(page);
    const opId = (await lockCard(page).getAttribute("data-op-id"))!;
    await resolveWith(page, (id) => ({ body: opJson(id, { state: "NEEDS_OPERATOR_REVIEW", ladder: ladder({ runtimeStarted: "unknown", httpHealthVerified: "unknown" }), failure: { code: "partially_verified", messageFa: "بخشی از سطوح تأیید شد" }, recoveryFa: ["نشانی برنامه را دستی بررسی کنید"], evidence: { runtime: "unknown", appletsReadable: false } }) }));
    await lockCard(page).getByTestId("live-reverify").click();
    const result = page.locator('[data-testid="live-result"][data-source="action"]');
    await expect(result).toHaveAttribute("data-state", "NEEDS_OPERATOR_REVIEW");
    await expect(result.getByTestId("live-result-headline")).toContainText("نیازمند بررسی اپراتور");
    await expect(result).not.toContainText("مستقر و در همهٔ سطوح راستی‌آزمایی شد");
    await expect(result.getByTestId("live-result-recovery")).toContainText("نشانی برنامه را دستی بررسی کنید");
    // the operation still holds the lock in the (unchanged) real status: the lock card and the next action say so
    await expect(page.locator(`[data-testid="live-lock"][data-op-id="${opId}"]`)).toBeVisible();
    await expect(page.getByTestId("live-next-action")).toHaveAttribute("data-action", "resolve_previous");
  });

  test("FAILED is a truthful failure with its message", async ({ page }) => {
    await openPage(page);
    await resolveWith(page, (id) => ({ body: opJson(id, { state: "FAILED", ladder: ladder({ httpHealthVerified: "failed" }), failure: { code: "verification_failed", messageFa: "راستی‌آزمایی پس از استقرار شکست خورد." }, recoveryFa: ["لاگ را در کنسول ببینید"] }) }));
    await stubStatus(page, withoutLock);
    await lockCard(page).getByTestId("live-reverify").click();
    const result = page.getByTestId("live-result");
    await expect(result).toHaveAttribute("data-state", "FAILED");
    await expect(result.getByTestId("live-result-headline")).toHaveText("ناموفق");
    await expect(result.getByTestId("live-result-failure")).toContainText("شکست خورد");
    await expect(result).not.toContainText("مستقر و در همهٔ سطوح");
    await expect(page.getByTestId("live-next-action")).not.toHaveAttribute("data-action", "deployed_previously");
  });

  test("an HTTP 200 that is not a valid operation record is NOT success: the page says the outcome is uncertain", async ({ page }) => {
    await openPage(page);
    for (const body of [{ ok: true }, "fine", null, { id: "lop_20260101000000_00000000", state: "DEPLOYED" }]) {
      await page.unroute(OPERATION);
      await resolveWith(page, () => ({ body }));
      await lockCard(page).getByTestId("live-reverify").click();
      await expect(lockCard(page).getByTestId("live-op-error")).toContainText("نتیجه نامعلوم است");
      await expect(page.getByTestId("live-result")).toHaveCount(0);
    }
  });

  test("a failed request (HTTP 500 from /resolve) shows the error and no result", async ({ page }) => {
    await openPage(page);
    await resolveWith(page, () => ({ status: 500, body: { error: { code: "upstream_error", message: "خطا" } } }));
    await lockCard(page).getByTestId("live-reverify").click();
    await expect(lockCard(page).getByTestId("live-op-error")).toBeVisible();
    await expect(page.getByTestId("live-result")).toHaveCount(0);
  });
});

test.describe("the latest terminal result is discoverable on a NEW run", () => {
  const history = (over: Record<string, unknown> = {}) => ({ operationId: "lop_20261022203843_0396e0b4", appName: "demo-api", kind: "deploy_existing_app", state: "DEPLOYED", completedAt: "2026-10-23T08:12:12.640Z", releaseId: "6ada74737ebf55567c8e9382", ladder: ladder(), failureCode: null, failureFa: null, recoveryFa: [], abandoned: false, runtimeEvidence: "inferred", appletsReadable: false, ...over });

  test("a fresh page with no proposal shows «آخرین نتیجهٔ استقرار این برنامه» as a RECORD, not as a running operation or a lock; the next step is not the offline preview", async ({ page }) => {
    await stubStatus(page, (j) => {
      withoutLock(j);
      j.lastResults = [history()];
    });
    await openPage(page);
    const card = page.locator('[data-testid="live-result"][data-source="history"]');
    await expect(card).toBeVisible();
    await expect(card).toContainText("آخرین نتیجهٔ استقرار این برنامه");
    await expect(card).toContainText("نه عملیات در حال اجرا و نه قفل");
    await expect(page.getByTestId("live-result-record-badge")).toBeVisible();
    await expect(card).toHaveAttribute("data-state", "DEPLOYED");
    await expect(lockCard(page)).toHaveCount(0); // (the seed's OTHER application, demo-worker, legitimately still shows its own lock card)
    await expect(card.locator('[data-testid="live-operation"]')).toHaveCount(0); // the record is not a running-operation card
    await expect(page.getByTestId("live-next-action")).toHaveAttribute("data-action", "deployed_previously");
    await expect(page.getByTestId("live-next-title")).toContainText("استقرار قبلی این برنامه تکمیل شده است");
    // a new deployment stays one explicit step away: nothing is proposed automatically, the preview button is available
    await expect(page.getByTestId("live-existing-preview-btn")).toBeEnabled();
    expect(requests).toEqual([]);
    // keyboard / a11y / RTL
    const r = await new AxeBuilder({ page }).include('[data-testid="live-results"]').analyze();
    expect(r.violations.filter((v) => v.impact === "serious" || v.impact === "critical"), JSON.stringify(r.violations.map((v) => v.id))).toEqual([]);
    expect(await page.evaluate(() => getComputedStyle(document.documentElement).direction)).toBe("rtl");
    const within = await card.evaluate((el) => { const b = el.getBoundingClientRect(); return b.left >= -1 && b.right <= window.innerWidth + 1; });
    expect(within).toBe(true);
  });

  test("a historical FAILED result is shown as a failure record; with no result at all the existing workflow is unchanged", async ({ page }) => {
    await stubStatus(page, (j) => {
      withoutLock(j);
      j.lastResults = [history({ state: "FAILED", ladder: ladder({ httpHealthVerified: "failed" }), failureCode: "verification_failed", failureFa: "راستی‌آزمایی شکست خورد", runtimeEvidence: "unrecorded", appletsReadable: null })];
    });
    await openPage(page);
    await expect(page.getByTestId("live-result")).toHaveAttribute("data-state", "FAILED");
    await expect(page.getByTestId("live-next-action")).not.toHaveAttribute("data-action", "deployed_previously");
    await expect(page.getByTestId("live-result-evidence")).toContainText("ثبت نشده است");
    await page.unroute(/\/api\/agent\/live\/status\?/);
    await stubStatus(page, (j) => {
      withoutLock(j);
      j.lastResults = [];
    });
    await page.reload();
    await openPage(page);
    await expect(page.getByTestId("live-result")).toHaveCount(0);
    await expect(page.getByTestId("live-next-action")).not.toHaveAttribute("data-action", "deployed_previously");
  });

  test("results for another application do not appear on the selected application's page", async ({ page }) => {
    await stubStatus(page, (j) => {
      withoutLock(j);
      j.lastResults = [history({ appName: "demo-worker" })];
    });
    await openPage(page);
    await expect(page.getByTestId("live-result")).toHaveCount(0);
  });
});

test.describe("a fresh read-only re-check of a FINISHED deployment (stubbed answers)", () => {
  const AT = "2026-10-23T08:12:12.640Z";
  const NOW = "2026-10-24T09:00:00.000Z";
  const health = (over: Record<string, unknown> = {}) => ({ source: "http_probe", observedAt: AT, outcome: "ok", status: 200, markerRequired: true, markerMatched: true, failure: null, durationMs: 37, ...over });
  const historyEntry = (over: Record<string, unknown> = {}) => ({ operationId: "lop_20261022203843_0396e0b4", appName: "demo-api", kind: "deploy_existing_app", state: "DEPLOYED", completedAt: AT, releaseId: "6ada74737ebf55567c8e9382", ladder: ladder(), failureCode: null, failureFa: null, recoveryFa: [], abandoned: false, runtimeEvidence: "inferred", appletsReadable: false, evidenceObservedAt: AT, health: health(), applets: { observedAt: AT, readable: false, runtimeClass: null, appletCount: null, failure: "upstream_error" }, latestCheck: null, access: "orphan", ...over });
  const withHistory = (page: Page) => stubStatus(page, (j) => {
    withoutLock(j);
    j.lastResults = [historyEntry()];
  });

  test("the history card says the evidence is historical (with its time), keeps «applets error» apart from the successful health line, and offers the read-only check", async ({ page }) => {
    await withHistory(page);
    await openPage(page);
    const card = page.locator('[data-testid="live-result"][data-source="history"]');
    await expect(card.getByTestId("live-result-deploy-note")).toContainText("تضمین نمی‌کند");
    await expect(card.getByTestId("live-evidence-time")).toContainText("زمان مشاهده");
    await expect(card.locator('[data-testid="live-health"][data-kind="ok"]')).toBeVisible();
    await expect(card.locator('[data-testid="live-applets"][data-kind="unreadable"]')).toContainText("نه اینکه برنامه خاموش باشد");
    await expect(card.getByTestId("live-check")).toHaveAttribute("data-kind", "none");
    await expect(card.getByTestId("live-recheck")).toBeVisible();
    expect(requests).toEqual([]);
    const r = await new AxeBuilder({ page }).include('[data-testid="live-results"]').analyze();
    expect(r.violations.filter((v) => v.impact === "serious" || v.impact === "critical"), JSON.stringify(r.violations.map((v) => v.id))).toEqual([]);
  });

  test("a FAILING fresh check is shown as a failed CHECK with its own time and category; the deployment result stays «مستقر»; the old success stays historical; one read-only request was made", async ({ page }) => {
    await withHistory(page);
    await openPage(page);
    let body = "";
    await resolveWith(page, (id) => ({ body: opJson(id, { evidence: { runtime: "inferred", appletsReadable: false, observedAt: AT, health: health(), applets: { observedAt: AT, readable: false, runtimeClass: null, appletCount: null, failure: "upstream_error" } }, transitions: [{ at: AT }], latestCheck: { observedAt: NOW, verdict: "http_failed", runtime: "unknown", currentReleaseMatches: true, health: health({ observedAt: NOW, outcome: "http_error", status: 503, markerMatched: null, failure: "http_status", durationMs: 88 }), applets: null } }) }));
    page.on("request", (r) => OPERATION.test(new URL(r.url()).pathname) && (body = r.postData() ?? ""));
    await page.locator('[data-testid="live-result"][data-source="history"]').getByTestId("live-recheck").click();
    const card = page.locator('[data-testid="live-result"][data-op-id="lop_20261022203843_0396e0b4"]');
    await expect(card).toHaveCount(1);
    await expect(card).toHaveAttribute("data-source", "action");
    await expect(card.getByTestId("live-result-headline")).toContainText("مستقر؛ اجرای برنامه از پاسخ سلامت HTTP استنتاج شده است");
    await expect(card.getByTestId("live-result-headline")).not.toContainText("همهٔ سطوح");
    await expect(card.getByTestId("live-check")).toHaveAttribute("data-verdict", "http_failed");
    await expect(card.getByTestId("live-check-verdict")).toContainText("نادرست بود");
    await expect(card.getByTestId("live-check")).toContainText("نتیجهٔ استقرار ثبت‌شده تغییر نکرد");
    await expect(card.locator('[data-testid="live-check"] [data-testid="live-health"]')).toHaveAttribute("data-failure", "http_status");
    // the historical evidence is still there, in its own block, with the old (successful) observation
    await expect(card.locator('[data-evidence-kind="historical"] [data-testid="live-health"]')).toHaveAttribute("data-kind", "ok");
    expect(requests).toEqual(["POST /api/agent/live/operations/lop_20261022203843_0396e0b4/resolve"]);
    expect(JSON.parse(body)).toEqual({ action: "recheck", adoptOrphan: true });
  });

  test("an unusable answer to the re-check is reported as uncertain; the card and the historical evidence stay", async ({ page }) => {
    await withHistory(page);
    await openPage(page);
    await resolveWith(page, () => ({ body: { ok: true } }));
    const card = page.locator('[data-testid="live-result"][data-source="history"]');
    await card.getByTestId("live-recheck").click();
    await expect(card.getByTestId("live-recheck-error")).toContainText("نتیجه نامعلوم است");
    await expect(card).toHaveAttribute("data-state", "DEPLOYED");
  });
});

test("layout at 360px: the result card fits, no horizontal overflow", async ({ page }) => {
  await page.setViewportSize({ width: 360, height: 800 });
  await openPage(page);
  await resolveWith(page, (id) => ({ body: opJson(id) }));
  await stubStatus(page, withoutLock);
  await lockCard(page).getByTestId("live-reverify").click();
  await expect(page.getByTestId("live-result")).toBeVisible();
  expect(await page.evaluate(() => document.documentElement.scrollWidth - document.documentElement.clientWidth)).toBeLessThanOrEqual(0);
});
