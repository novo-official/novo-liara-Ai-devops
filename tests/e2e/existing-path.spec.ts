import AxeBuilder from "@axe-core/playwright";
import { expect, test, type Page } from "@playwright/test";
import { E2E_PASSWORD } from "../../playwright.config";
import { baseFiles, nextZip, zipOf } from "../helpers/projects";

/**
 * UX of the PRIMARY path (deploy to an EXISTING application): one flow, one next action, one ZIP input, preview clearly separate from execution.
 * Runs on the production build in MOCK mode: the preview is real (same server code) but live execution is closed, so nothing here can write.
 */
async function login(page: Page) {
  await page.goto("/login");
  await page.getByLabel("گذرواژه").fill(E2E_PASSWORD);
  await page.getByRole("button", { name: "ورود" }).click();
  await expect(page).toHaveURL(/\/apps$/);
}
async function uploaded(page: Page) {
  await page.getByTestId("deploy-file").setInputFiles({ name: "my-site.zip", mimeType: "application/zip", buffer: nextZip() });
  await page.getByTestId("deploy-upload-btn").click();
  await expect(page.getByTestId("deploy-panel")).toBeVisible({ timeout: 15_000 });
  await expect(page.getByTestId("artifact-state-badge")).toHaveAttribute("data-state", "match");
}
const action = (page: Page) => page.getByTestId("live-next-action").getAttribute("data-action");

const errors: string[] = [];
const livePosts: { method: string; url: string; kind: string | null }[] = [];
test.beforeEach(async ({ page }) => {
  errors.length = 0;
  livePosts.length = 0;
  page.on("console", (m) => (m.type() === "error" || m.type() === "warning") && errors.push(`${m.type()}: ${m.text()} ${m.location().url}`));
  page.on("pageerror", (e) => errors.push(e.message));
  page.on("request", (r) => r.method() !== "GET" && /\/api\/agent\/live\//.test(r.url()) && livePosts.push({ method: r.method(), url: r.url(), kind: r.headers()["x-live-kind"] ?? null }));
  await login(page);
  await page.goto("/agent");
});
test.afterEach(() => expect(errors.filter((e) => !/favicon/i.test(e) && !/status of 4\d\d .*\/api\/agent\//.test(e)), errors.join("\n")).toEqual([]));

test.describe("primary path: deploy to an existing application", () => {
  test("is the default tab, the tabs are accessible, and the three paths are clearly separated", async ({ page }) => {
    await uploaded(page);
    const tabs = page.getByRole("tablist", { name: "انتخاب مسیر استقرار" });
    await expect(tabs.getByRole("tab")).toHaveCount(3);
    await expect(page.getByTestId("path-tab-existing")).toHaveAttribute("aria-selected", "true");
    await expect(page.getByTestId("path-tab-existing")).toContainText("پیشنهادی");
    await expect(page.getByTestId("path-tab-simulation")).toHaveAttribute("aria-selected", "false");
    await expect(page.getByTestId("deploy-panel")).toHaveAttribute("data-path", "existing");
    await expect(page.getByRole("tabpanel", { name: /انتشار روی برنامهٔ موجود/ })).toBeVisible();
    // the new-app pricing / network / plan blockers do NOT appear on the primary path …
    for (const id of ["live-prereqs", "live-preflight", "live-plan-select", "live-create-new", "live-form"]) await expect(page.getByTestId(id)).toHaveCount(0);
    await expect(page.getByTestId("plan-prepare")).toBeHidden();
    // … they live only under the new-app tab
    await page.getByTestId("path-tab-new").click();
    await expect(page.getByTestId("live-prereqs")).toBeVisible();
    await expect(page.locator('[data-prereq="plan_units_verified"]')).toBeVisible();
    await expect(page.getByTestId("live-existing")).toHaveCount(0);
  });

  test("keyboard: arrow keys move between tabs (RTL-aware), Home/End jump, only the selected tab is in the tab order", async ({ page }) => {
    await uploaded(page);
    await page.getByTestId("path-tab-existing").focus();
    await page.keyboard.press("ArrowLeft"); // RTL: left = next
    await expect(page.getByTestId("path-tab-simulation")).toBeFocused();
    await expect(page.getByTestId("path-tab-simulation")).toHaveAttribute("aria-selected", "true");
    await expect(page.getByTestId("path-tab-existing")).toHaveAttribute("tabindex", "-1");
    await page.keyboard.press("End");
    await expect(page.getByTestId("path-tab-new")).toHaveAttribute("aria-selected", "true");
    await page.keyboard.press("ArrowRight");
    await expect(page.getByTestId("path-tab-simulation")).toHaveAttribute("aria-selected", "true");
    await page.keyboard.press("Home");
    await expect(page.getByTestId("path-tab-existing")).toBeFocused();
  });

  test("exactly one ZIP input on the page flow (the analysed file is carried over); 'upload a new version' is folded away", async ({ page }) => {
    await uploaded(page);
    await expect(page.getByTestId("artifact-file")).toBeVisible();
    await expect(page.getByTestId("artifact-name")).toHaveText("my-site.zip");
    await expect(page.getByTestId("artifact-sha")).toBeVisible();
    expect(await page.locator('[data-testid="deploy-panel"] input[type="file"]').count()).toBe(1);
    await expect(page.getByTestId("upload-new-version")).not.toHaveAttribute("open", "");
    await expect(page.getByTestId("deploy-file")).toBeHidden();
    // the new-app path uses the very same selection (no second input there either)
    await page.getByTestId("path-tab-new").click();
    await expect(page.getByTestId("artifact-file")).toBeVisible();
    expect(await page.locator('[data-testid="deploy-panel"] input[type="file"]').count()).toBe(1);
    await expect(page.getByTestId("artifact-name")).toHaveText("my-site.zip");
  });

  test("a different ZIP is flagged immediately; preview and request stay closed until the analysed archive is selected again", async ({ page }) => {
    await uploaded(page);
    await page.getByTestId("artifact-file").setInputFiles({ name: "other.zip", mimeType: "application/zip", buffer: zipOf({ ...baseFiles(), "README.md": "# not the analysed file" }) });
    await expect(page.getByTestId("artifact-state-badge")).toHaveAttribute("data-state", "mismatch");
    await expect(page.getByTestId("artifact-status")).toContainText("یکی نیست");
    expect(await action(page)).toBe("fix_zip");
    await expect(page.getByTestId("live-existing-preview-btn")).toBeDisabled();
    await expect(page.getByTestId("live-existing-propose")).toBeDisabled();
    await expect(page.locator('[data-stage="source_target"]')).toHaveAttribute("data-state", "blocked");
    await page.getByTestId("artifact-file").setInputFiles({ name: "my-site.zip", mimeType: "application/zip", buffer: nextZip() });
    await expect(page.getByTestId("artifact-state-badge")).toHaveAttribute("data-state", "match");
    await page.getByTestId("artifact-clear").click();
    await expect(page.getByTestId("artifact-status")).toContainText("هنوز فایلی انتخاب نشده");
    expect(await action(page)).toBe("choose_zip");
    await expect(page.getByTestId("live-existing-preview-btn")).toBeDisabled();
    expect(livePosts).toEqual([]);
  });

  test("one next action is always shown, the stage stepper agrees with it, and the two kinds of readiness are separate lists", async ({ page }) => {
    await uploaded(page);
    const card = page.getByTestId("live-next-action");
    await expect(card).toBeVisible();
    await expect(page.getByTestId("live-next-title")).not.toBeEmpty();
    const stages = page.getByTestId("live-existing-stages").locator("li");
    await expect(stages).toHaveCount(5);
    await expect(page.locator('[data-stage="analysis"]')).toHaveAttribute("data-state", "done");
    await expect(page.locator('[data-stage="execution"]')).toHaveAttribute("data-state", "todo");
    const gates = page.getByTestId("live-existing-gates");
    await expect(gates.getByTestId("live-gate-target")).toContainText("فقط خواندن");
    await expect(gates.getByTestId("live-gate-execution")).toContainText("پیش‌نیازهای اجرای واقعی");
    await expect(gates.getByTestId("live-gate-execution").locator('[data-testid="live-gate-prereq-live_flag"]')).toHaveAttribute("data-ok", "false");
    await expect(gates.getByTestId("live-gate-target").locator('[data-testid="live-gate-prereq-live_flag"]')).toHaveCount(0);
  });

  test("offline preview: allowed while live execution is OFF, binds the fresh archive, is not an approval, writes nothing and goes stale when the file changes", async ({ page }) => {
    await uploaded(page);
    await expect(page.getByTestId("live-existing-preview-btn")).toBeEnabled();
    await page.getByTestId("live-existing-preview-btn").click();
    const pv = page.getByTestId("live-existing-preview");
    await expect(pv).toBeVisible({ timeout: 15_000 });
    await expect(page.getByTestId("live-preview-not-approval")).toContainText("نه تأیید");
    await expect(page.getByTestId("live-preview-zip-sha")).toHaveText(/^[0-9a-f]{64}$/);
    await expect(pv).toHaveAttribute("data-executable", "false");
    await expect(page.getByTestId("live-preview-execution")).toContainText("اجرای واقعی اکنون ممکن نیست");
    await expect(page.getByTestId("live-preview-execution").locator('[data-blocker="live_flag"]')).toBeVisible();
    // exactly ONE live request, and it is the offline-preview kind; nothing else was sent
    expect(livePosts).toHaveLength(1);
    expect(livePosts[0]).toMatchObject({ method: "POST", kind: "preview_existing_app" });
    await expect(page.getByTestId("live-existing-propose")).toBeDisabled();
    await expect(page.getByTestId("live-open-approval")).toHaveCount(0);
    await expect(page.getByTestId("live-execute")).toHaveCount(0);
    // changing the selection voids the preview
    await page.getByTestId("artifact-file").setInputFiles({ name: "other.zip", mimeType: "application/zip", buffer: zipOf({ ...baseFiles(), "README.md": "# x" }) });
    await expect(page.getByTestId("live-existing-preview")).toHaveCount(0);
    await expect(page.getByTestId("live-existing-preview-stale")).toBeVisible();
  });

  test("the server refuses a preview built from a different archive (fails closed) and a preview never creates a proposal", async ({ page }) => {
    await uploaded(page);
    await expect(page.getByTestId("live-next-action")).toBeVisible();
    const runId = await page.evaluate(() => performance.getEntriesByType("resource").map((e) => e.name).find((n) => n.includes("/api/agent/live/status?runId="))?.split("runId=")[1] ?? "");
    expect(runId).toMatch(/^arun_\d{14}_[0-9a-f]{8}$/);
    const res = await page.evaluate(async (run) => {
      const post = async (headers: Record<string, string>, body: BodyInit) => {
        const r = await fetch("/api/agent/live/proposals", { method: "POST", headers: { "Content-Type": "application/zip", "X-Live-Kind": "preview_existing_app", "X-Live-Backend": "api", ...headers }, body });
        return { status: r.status, code: (await r.json()).error?.code as string | undefined };
      };
      return {
        other: await post({ "X-Live-Run": run, "X-Live-App": "demo-shop" }, new Uint8Array([80, 75, 3, 4, 1, 2, 3])),
        badRun: await post({ "X-Live-Run": "nope", "X-Live-App": "demo-shop" }, new Uint8Array([1])),
        badApp: await post({ "X-Live-Run": run, "X-Live-App": "Bad App!" }, new Uint8Array([1])),
        status: await (await fetch("/api/agent/live/status?runId=" + run)).json(),
      };
    }, runId);
    expect(res.other.status).toBe(409);
    expect(res.other.code).toMatch(/^live_artifact_(mismatch|rejected)$/);
    expect(res.badRun).toMatchObject({ status: 400, code: "bad_request" });
    expect(res.badApp).toMatchObject({ status: 400, code: "bad_request" });
    expect(res.status.proposals).toEqual([]); // nothing was persisted by any of them
  });

  test("a run that opens blocked starts in the checklist (no tabs) and is NOT moved away when fixing it unlocks the live paths", async ({ page }) => {
    await page.getByTestId("deploy-file").setInputFiles({ name: "needs-env.zip", mimeType: "application/zip", buffer: zipOf({ ...baseFiles(), ".env.example": "API_KEY=\n" }) });
    await page.getByTestId("deploy-upload-btn").click();
    await expect(page.getByTestId("deploy-panel")).toHaveAttribute("data-verdict", "NEEDS_CONFIGURATION", { timeout: 15_000 });
    await expect(page.getByTestId("path-tabs")).toHaveCount(0);
    await expect(page.getByTestId("deploy-panel")).toHaveAttribute("data-path", "simulation");
    await page.getByTestId("check-env_values").check();
    await expect(page.getByTestId("deploy-panel")).toHaveAttribute("data-verdict", "READY_WITH_WARNINGS");
    await expect(page.getByTestId("path-tabs")).toBeVisible();
    await expect(page.getByTestId("deploy-panel")).toHaveAttribute("data-path", "simulation"); // the operator stays on the step they were working on
    await expect(page.getByTestId("check-env_values")).toBeVisible();
    await page.getByTestId("path-tab-existing").click();
    await expect(page.getByTestId("live-existing")).toBeVisible();
  });

  test("a clean READY analysis folds its long lists away; the deployment path starts high on the page", async ({ page }) => {
    await uploaded(page);
    await expect(page.getByTestId("deploy-analysis-details")).not.toHaveAttribute("open", "");
    const top = await page.getByTestId("live-next-action").evaluate((el) => el.getBoundingClientRect().top + window.scrollY);
    expect(top).toBeLessThan(1500);
  });

  for (const [w, h] of [[360, 800], [768, 1024], [1280, 900]] as const) {
    test(`layout at ${w}px (preview open): RTL, no horizontal overflow, tabs and actions ≥ 44px`, async ({ page }) => {
      await page.setViewportSize({ width: w, height: h });
      await uploaded(page);
      await page.getByTestId("live-existing-preview-btn").click();
      await expect(page.getByTestId("live-existing-preview")).toBeVisible({ timeout: 15_000 });
      const overflow = await page.evaluate(() => document.documentElement.scrollWidth - document.documentElement.clientWidth);
      expect(overflow).toBeLessThanOrEqual(0);
      for (const id of ["path-tab-existing", "path-tab-simulation", "path-tab-new", "live-existing-preview-btn", "live-existing-propose", "artifact-clear"]) {
        const box = await page.getByTestId(id).boundingBox();
        expect(box!.height, id).toBeGreaterThanOrEqual(43);
        expect(box!.x + box!.width, id).toBeLessThanOrEqual(w + 1);
        expect(box!.x, id).toBeGreaterThanOrEqual(-1);
      }
      for (const id of ["live-existing-gates", "live-existing-preview", "live-next-action", "artifact-binder"]) {
        const within = await page.getByTestId(id).evaluate((el) => { const r = el.getBoundingClientRect(); return r.left >= -1 && r.right <= window.innerWidth + 1; });
        expect(within, id).toBe(true);
      }
      expect(await page.evaluate(() => getComputedStyle(document.documentElement).direction)).toBe("rtl");
    });
  }

  test("accessibility (axe): no serious or critical violations with the preview open, and the next-action card is a polite live region", async ({ page }) => {
    await uploaded(page);
    await page.getByTestId("live-existing-preview-btn").click();
    await expect(page.getByTestId("live-existing-preview")).toBeVisible({ timeout: 15_000 });
    await expect(page.getByTestId("live-next-action")).toHaveAttribute("aria-live", "polite");
    const r = await new AxeBuilder({ page }).include('[data-testid="deploy-panel"]').analyze();
    expect(r.violations.filter((v) => v.impact === "serious" || v.impact === "critical"), JSON.stringify(r.violations.map((v) => ({ id: v.id, n: v.nodes.map((x) => x.target) })))).toEqual([]);
  });
});
