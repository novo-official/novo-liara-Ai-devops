import AxeBuilder from "@axe-core/playwright";
import { expect, test, type Page } from "@playwright/test";
import { E2E_PASSWORD } from "../../playwright.config";
import { nextZip } from "../helpers/projects";

async function login(page: Page) {
  await page.goto("/login");
  await page.getByLabel("گذرواژه").fill(E2E_PASSWORD);
  await page.getByRole("button", { name: "ورود" }).click();
  await expect(page).toHaveURL(/\/apps$/);
}
async function uploaded(page: Page, path: "existing" | "simulation" | "new" = "existing") {
  await page.getByTestId("deploy-file").setInputFiles({ name: "my-site.zip", mimeType: "application/zip", buffer: nextZip() });
  await page.getByTestId("deploy-upload-btn").click();
  await expect(page.getByTestId("deploy-panel")).toBeVisible({ timeout: 15_000 });
  if (path !== "existing") await page.getByTestId(`path-tab-${path}`).click();
  await expect(page.getByTestId("deploy-panel")).toHaveAttribute("data-path", path);
}

const errors: string[] = [];
const livePosts: string[] = [];
test.beforeEach(async ({ page }) => {
  errors.length = 0;
  livePosts.length = 0;
  page.on("console", (m) => m.type() === "error" && errors.push(`${m.text()} ${m.location().url}`));
  page.on("pageerror", (e) => errors.push(e.message));
  page.on("request", (r) => r.method() !== "GET" && /\/api\/agent\/live\//.test(r.url()) && livePosts.push(`${r.method()} ${r.url()}`));
  await login(page);
  await page.goto("/agent");
});
test.afterEach(() => expect(errors.filter((e) => !/favicon/i.test(e) && !/status of 4\d\d .*\/api\/agent\//.test(e)), errors.join("\n")).toEqual([]));

test.describe("Phase 2A — live deployment panel in the default (disabled / mock) configuration", () => {
  test("new-app path: is BLOCKED, lists the prerequisites, disables every control and sends no write request", async ({ page }) => {
    await uploaded(page, "new");
    const panel = page.getByTestId("live-panel");
    await expect(panel).toBeVisible();
    await expect(panel).toHaveAttribute("data-state", "BLOCKED");
    await expect(page.getByTestId("live-state-badge")).toContainText("مسدود");
    await expect(page.getByTestId("live-subtitle")).toContainText("پیش‌فرض خاموش است");
    for (const id of ["live_flag", "contract_attested", "plan_units_verified", "network_id", "app_domain_suffix", "write_transport"]) await expect(page.locator(`[data-prereq="${id}"]`)).toHaveAttribute("data-ok", "false");
    await expect(page.getByTestId("live-propose")).toBeDisabled();
    await expect(page.getByTestId("live-app-input")).toBeDisabled();
    await expect(page.getByTestId("live-plan-select")).toBeDisabled();
    await expect(page.getByTestId("live-disabled-note")).toBeVisible();
    await expect(page.getByTestId("live-open-approval")).toHaveCount(0);
    await expect(page.getByTestId("live-execute")).toHaveCount(0);
    expect(livePosts).toEqual([]);
  });

  test("Phase 2B (new-app path): the final preflight summary is complete, honest about unknowns, lists every missing prerequisite, and keeps live execution disabled", async ({ page }) => {
    await uploaded(page, "new");
    const pf = page.getByTestId("live-preflight");
    await expect(pf).toBeVisible();
    await expect(pf).toHaveAttribute("data-verdict", /^BLOCKED_BY_/);
    await expect(page.getByTestId("live-verdict")).toContainText("مسدود");
    for (const label of ["چه برنامه‌ای ساخته می‌شود", "مالک (تیم)", "پلن و دلیل آن", "هزینهٔ مورد انتظار", "کدام مراحل تأیید می‌خواهند", "عامل دقیقاً چه می‌کند", "پیشرفت چگونه راستی‌آزمایی می‌شود", "اگر مرحله‌ای شکست بخورد"]) await expect(page.getByTestId("live-preflight-summary")).toContainText(label);
    await expect(page.getByTestId("live-cost-unknown")).toBeVisible(); // no verified units ⇒ no invented price
    await expect(page.getByTestId("live-verify-plan").locator("li")).toHaveCount(6);
    const missing = page.getByTestId("live-preflight-missing");
    await expect(missing.locator('[data-check="contract_attested"]')).toBeVisible();
    await expect(missing.locator('[data-check="units_operator_document"]')).toBeVisible();
    await page.getByTestId("live-preflight-all").locator("summary").click();
    await expect(page.getByTestId("live-preflight-all").locator('[data-check="allowlist_exact"][data-status="ok"]')).toBeVisible();
    await expect(page.getByTestId("live-preflight-all").locator('[data-evidence="cli_observed"]').first()).toBeVisible();
    await expect(page.getByTestId("live-propose")).toBeDisabled();
    expect(livePosts).toEqual([]);
  });

  test("Phase 2E: the mode banner says SIMULATION and the existing-app section is fully visible but every action is disabled", async ({ page }) => {
    await uploaded(page);
    const banner = page.getByTestId("live-mode-banner");
    await expect(banner).toHaveAttribute("data-live-mode", "simulation");
    await expect(page.getByTestId("live-mode-label")).toContainText("حالت شبیه‌سازی");
    await expect(page.getByTestId("live-panel")).toHaveAttribute("data-live-mode", "simulation");
    const ex = page.getByTestId("live-existing");
    await expect(ex).toBeVisible();
    await expect(page.getByTestId("live-existing-never-create")).toContainText("createApplication");
    await expect(page.getByTestId("live-existing-analysis")).toContainText("Next.js");
    await expect(page.getByTestId("live-existing-cost")).toContainText("شارژ");
    await expect(page.locator('[data-testid="live-existing-backend"][data-backend="api"]')).toContainText("پیش‌فرض");
    await expect(page.locator('[data-testid="live-existing-backend"][data-backend="cli"]')).toContainText("جایگزین");
    await expect(page.locator('[data-testid="live-existing-backend"][data-backend="cli"] input')).toBeDisabled();
    await expect(page.getByTestId("live-existing-propose")).toBeDisabled();
    await expect(page.getByTestId("live-existing-disabled-note")).toContainText("شبیه‌سازی");
    await expect(page.getByTestId("live-existing-preview-btn")).toBeVisible();
    await expect(page.getByTestId("live-existing-zip")).toHaveCount(0); // the single artifact binder replaced the per-form ZIP inputs
    expect(livePosts).toEqual([]);
  });

  test("the server refuses a hand-made live proposal / execution (fails closed, HTTP 403) and a simulation id on live routes", async ({ page }) => {
    await uploaded(page);
    const res = await page.evaluate(async () => {
      const post = async (url: string, headers: Record<string, string>, body: BodyInit) => {
        const r = await fetch(url, { method: "POST", headers, body });
        return { status: r.status, code: (await r.json()).error?.code as string };
      };
      return {
        propose: await post("/api/agent/live/proposals", { "Content-Type": "application/zip", "X-Live-Run": "arun_20260102040000_aabbccdd", "X-Live-Plan": "g2-small", "X-Live-App": "my-live-app" }, new Uint8Array([1, 2, 3])),
        execute: await post("/api/agent/live/proposals/lprop_20260102040000_aabbccdd/execute", { "Content-Type": "application/zip" }, new Uint8Array([1, 2, 3])),
        simDecision: await post("/api/agent/live/proposals/prop_20260102040000_aabbccdd/decision", { "Content-Type": "application/json" }, JSON.stringify({ decision: "approve", digest: "a".repeat(64), confirmAppName: "x", acknowledgeFinancial: true })),
      };
    });
    expect(res.propose).toEqual({ status: 403, code: "live_execution_disabled" });
    expect(res.execute).toEqual({ status: 403, code: "live_execution_disabled" });
    expect(res.simDecision).toEqual({ status: 403, code: "live_simulation_approval_rejected" });
  });

  test("simulation still works and its approval never enables anything live", async ({ page }) => {
    await uploaded(page, "simulation");
    await page.getByTestId("plan-app-name").fill("sim-only");
    await page.getByTestId("plan-prepare").click();
    await expect(page.getByTestId("proposal-card")).toBeVisible({ timeout: 15_000 });
    await page.getByTestId("open-approval").click();
    const dlg = page.getByTestId("approval-dialog");
    await dlg.getByTestId("confirm-input").fill("sim-only");
    await dlg.getByTestId("approve").click();
    await expect(dlg).toBeHidden({ timeout: 10_000 });
    await expect(page.getByTestId("deploy-final")).toBeVisible({ timeout: 20_000 });
    await page.getByTestId("path-tab-existing").click();
    await expect(page.getByTestId("live-panel")).toHaveAttribute("data-state", /^(SIMULATED|BLOCKED)$/);
    await expect(page.getByTestId("live-existing-propose")).toBeDisabled();
    expect(livePosts).toEqual([]);
  });

  for (const [w, h] of [[360, 800], [768, 1024], [1280, 900]] as const) {
    test(`layout at ${w}px: RTL, no horizontal overflow, controls ≥ 44px tall`, async ({ page }) => {
      await page.setViewportSize({ width: w, height: h });
      await uploaded(page);
      const panel = page.getByTestId("live-panel");
      await expect(panel).toHaveAttribute("data-state", "BLOCKED");
      await panel.scrollIntoViewIfNeeded();
      const overflow = await page.evaluate(() => document.documentElement.scrollWidth - document.documentElement.clientWidth);
      expect(overflow).toBeLessThanOrEqual(0);
      const box = await page.getByTestId("live-existing-propose").boundingBox();
      expect(box!.height).toBeGreaterThanOrEqual(43);
      const within = await panel.evaluate((el) => { const r = el.getBoundingClientRect(); return r.left >= 0 && r.right <= window.innerWidth + 1; });
      expect(within).toBe(true);
      expect(await page.evaluate(() => getComputedStyle(document.documentElement).direction)).toBe("rtl");
    });
  }

  for (const path of ["existing", "simulation", "new"] as const) {
    test(`accessibility (axe) has no serious or critical violations on the ${path} path (tabs included)`, async ({ page }) => {
      await uploaded(page, path);
      const r = await new AxeBuilder({ page }).include('[data-testid="deploy-panel"]').analyze();
      expect(r.violations.filter((v) => v.impact === "serious" || v.impact === "critical"), JSON.stringify(r.violations.map((v) => v.id))).toEqual([]);
    });
  }
});
