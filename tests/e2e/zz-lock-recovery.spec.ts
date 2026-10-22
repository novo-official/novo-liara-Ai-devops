import AxeBuilder from "@axe-core/playwright";
import { expect, test, type Page } from "@playwright/test";
import { E2E_PASSWORD } from "../../playwright.config";
import { nextZip } from "../helpers/projects";

/**
 * THE REAL INCIDENT, in a real browser. The e2e database is seeded (tests/e2e/seed-locked-operation.ts) with an operation for the mock target `demo-worker` that
 * ended in NEEDS_OPERATOR_REVIEW under a login session that does not exist on this server — exactly what a server restart + new login leaves behind. The operator
 * then logs in (a NEW session), analyses the project again (a NEWER run) and must be able to see and close the old operation. Nothing here can write to Liara
 * (mock data source, live execution off); the abandonment is local bookkeeping and the test proves it by the requests that are sent.
 */
async function login(page: Page) {
  await page.goto("/login");
  await page.getByLabel("گذرواژه").fill(E2E_PASSWORD);
  await page.getByRole("button", { name: "ورود" }).click();
  await expect(page).toHaveURL(/\/apps$/);
}
async function uploadedAndTargeted(page: Page) {
  await page.getByTestId("deploy-file").setInputFiles({ name: "my-site.zip", mimeType: "application/zip", buffer: nextZip() });
  await page.getByTestId("deploy-upload-btn").click();
  await expect(page.getByTestId("deploy-panel")).toBeVisible({ timeout: 15_000 });
  await expect(page.getByTestId("live-existing")).toBeVisible();
  await page.locator('[data-testid="live-existing-target"][data-app="demo-worker"]').click();
}

const errors: string[] = [];
const writes: { method: string; path: string; body: string | null }[] = [];
test.beforeEach(async ({ page }) => {
  errors.length = 0;
  writes.length = 0;
  page.on("console", (m) => (m.type() === "error" || m.type() === "warning") && errors.push(`${m.type()}: ${m.text()} ${m.location().url}`));
  page.on("pageerror", (e) => errors.push(e.message));
  page.on("request", (r) => r.method() !== "GET" && new URL(r.url()).pathname.startsWith("/api/agent/live/") && writes.push({ method: r.method(), path: new URL(r.url()).pathname, body: r.postData() }));
  await login(page);
  await page.goto("/agent");
});
test.afterEach(() => expect(errors.filter((e) => !/favicon/i.test(e) && !/status of 4\d\d .*\/api\/agent\//.test(e)), errors.join("\n")).toEqual([]));

test.describe("old locked operation + newer run + new login", () => {
  test("the recovery card and the Abandon button are visible; abandoning is confirmed, local-only and releases the lock", async ({ page }) => {
    await uploadedAndTargeted(page);

    // 1. the card is there: orphan (owner login gone), with the record and BOTH recovery buttons
    const lock = page.locator('[data-testid="live-lock"][data-app="demo-worker"]');
    await expect(page.getByTestId("live-locks")).toBeVisible();
    await expect(lock).toHaveAttribute("data-access", "orphan");
    await expect(lock).toHaveAttribute("data-state", "NEEDS_OPERATOR_REVIEW");
    await expect(page.getByTestId("live-lock-orphan-note")).toContainText("دیگر وجود ندارد");
    const opId = (await lock.getAttribute("data-op-id"))!;
    expect(opId).toMatch(/^lop_\d{14}_[0-9a-f]{8}$/);
    await expect(lock.getByTestId("live-reverify")).toBeVisible();
    await expect(lock.getByTestId("live-abandon")).toBeVisible();
    await expect(lock.getByTestId("live-failure")).toContainText("قابل‌فهم نبود");

    // 2. the page names it as THE next action; a request cannot be made under the lock; the offline preview still works
    await expect(page.getByTestId("live-next-action")).toHaveAttribute("data-action", "resolve_previous");
    await expect(page.getByTestId("live-existing-propose")).toBeDisabled();
    await expect(page.getByTestId("live-existing-disabled-note")).toContainText("عملیات قبلی هنوز قفل");
    await expect(page.getByTestId("live-existing-preview-btn")).toBeEnabled();

    // 3. accessibility with the card and the confirmation open
    await lock.getByTestId("live-abandon").click();
    const box = lock.getByTestId("live-abandon-confirm-box");
    await expect(box).toBeVisible();
    await expect(box).toContainText("هیچ درخواستی به لیارا نمی‌رود");
    await expect(box).toContainText("حذف نمی‌شود");
    const r = await new AxeBuilder({ page }).include('[data-testid="live-locks"]').analyze();
    expect(r.violations.filter((v) => v.impact === "serious" || v.impact === "critical"), JSON.stringify(r.violations.map((v) => ({ id: v.id, n: v.nodes.map((x) => x.target) })))).toEqual([]);

    // 4. "انصراف" closes the confirmation and sends NOTHING
    await box.getByTestId("live-abandon-back").click();
    await expect(box).toHaveCount(0);
    await expect(lock).toBeVisible();
    expect(writes).toEqual([]);

    // 4b. fails securely: without the explicit orphan acknowledgement the server refuses (indistinguishable from "not found"), and nothing changes
    const refused = await page.evaluate(async (id) => {
      const x = await fetch(`/api/agent/live/operations/${id}/resolve`, { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ action: "abandon" }) });
      return { status: x.status, code: (await x.json()).error?.code as string };
    }, opId);
    expect(refused).toEqual({ status: 404, code: "live_not_found" });
    writes.length = 0; // the deliberate probe above is not part of the UI flow being asserted
    await page.reload();
    await expect(page.getByTestId("deploy-panel")).toHaveCount(0); // a reload drops the in-memory conversation; re-create the page state
    await uploadedAndTargeted(page);
    await expect(page.locator('[data-testid="live-lock"][data-app="demo-worker"]')).toHaveAttribute("data-access", "orphan");

    // 5. confirm: exactly ONE request, to the resolve endpoint of that operation, abandon + the explicit orphan acknowledgement; nothing to proposals/execute
    await lock.getByTestId("live-abandon").click();
    const [resp] = await Promise.all([page.waitForResponse((x) => x.url().endsWith(`/api/agent/live/operations/${opId}/resolve`)), lock.getByTestId("live-abandon-confirm").click()]);
    expect(resp.status()).toBe(200);
    expect((await resp.json()).state).toBe("FAILED");
    await expect(page.getByTestId("live-locks")).toHaveCount(0);
    expect(writes).toHaveLength(1);
    expect(writes[0]).toMatchObject({ method: "POST", path: `/api/agent/live/operations/${opId}/resolve` });
    expect(JSON.parse(writes[0]!.body!)).toEqual({ action: "abandon", adoptOrphan: true });

    // 6. the lock is released in the UI: the next action is no longer "resolve the previous operation" and the request button's reason is no longer the lock
    await expect(page.getByTestId("live-next-action")).not.toHaveAttribute("data-action", "resolve_previous");
    await expect(page.getByTestId("live-existing-disabled-note")).not.toContainText("عملیات قبلی هنوز قفل");
    const status = await page.evaluate(async () => {
      const run = performance.getEntriesByType("resource").map((e) => e.name).filter((n) => n.includes("/api/agent/live/status?runId=")).at(-1)!.split("runId=")[1]!;
      return (await fetch("/api/agent/live/status?runId=" + run)).json();
    });
    expect(status.locks).toEqual([]);

    // 7. no replay: the same operation cannot be closed (or cancelled) again, and a hand-made execute of its consumed proposal is refused
    const again = await page.evaluate(async (id) => {
      const post = async (url: string, body: unknown, ct = "application/json") => {
        const x = await fetch(url, { method: "POST", headers: { "Content-Type": ct }, body: ct === "application/json" ? JSON.stringify(body) : (body as BodyInit) });
        return { status: x.status, code: (await x.json()).error?.code as string | undefined };
      };
      return { abandon: await post(`/api/agent/live/operations/${id}/resolve`, { action: "abandon", adoptOrphan: true }), reverify: await post(`/api/agent/live/operations/${id}/resolve`, { action: "reverify", adoptOrphan: true }) };
    }, opId);
    expect(again.abandon).toEqual({ status: 409, code: "live_invalid_state" });
    expect(again.reverify).toEqual({ status: 409, code: "live_invalid_state" });
  });
});
