import AxeBuilder from "@axe-core/playwright";
import { expect, test, type Page } from "@playwright/test";
import { E2E_PASSWORD } from "../../playwright.config";

async function login(page: Page) {
  await page.goto("/login");
  await page.getByLabel("گذرواژه").fill(E2E_PASSWORD);
  await page.getByRole("button", { name: "ورود" }).click();
  await expect(page).toHaveURL(/\/apps$/);
}

/** Starts a diagnostic run through the real UI form and waits for it to finish. */
async function diagnose(page: Page, app: string, intentLabel: string, windowLabel?: string) {
  await page.goto("/assistant");
  await page.locator("#app").selectOption(app);
  await page.getByLabel(intentLabel).check();
  if (windowLabel) await page.locator("#window").selectOption({ label: windowLabel });
  await page.getByTestId("start-run").click();
  await expect(page).toHaveURL(/\/assistant\/runs\/run_\d{14}_[0-9a-f]{8}$/);
  await expect(page.getByTestId("run-status")).not.toHaveAttribute("data-status", "RUNNING", { timeout: 20_000 });
}

const RESTART = "چرا برنامهٔ من مدام ری‌استارت می‌شود؟";
const SLOW = "چرا وب‌سایت من کند است؟";
const H500 = "بررسی احتمال خطای HTTP 500";
const DEPLOY = "تحلیل شکست‌های اخیر استقرار (deployment)";

const errors: string[] = [];
test.beforeEach(async ({ page }) => {
  errors.length = 0;
  page.on("console", (m) => m.type() === "error" && errors.push(m.text()));
  page.on("pageerror", (e) => errors.push(e.message));
  await login(page);
});

test.describe("assistant screen", () => {
  test("is clearly offline/simulated, lists only authorised apps and a fixed intent set, and has no free-text box", async ({ page }) => {
    await page.getByRole("link", { name: "دستیار عیب‌یابی" }).click();
    await expect(page).toHaveURL(/\/assistant$/);
    await expect(page.getByTestId("offline-banner")).toContainText("کاملاً آفلاین");
    await expect(page.getByTestId("provider-status")).toHaveAttribute("data-provider", "mock");
    await expect(page.getByTestId("provider-status")).toContainText("شبیه‌سازی‌شده");
    await expect(page.getByTestId("mode-badge").first()).toHaveAttribute("data-mode", "mock");
    expect(await page.locator("#app option").count()).toBe(9);
    await expect(page.locator('input[type="radio"][name="intent"]')).toHaveCount(4);
    await expect(page.locator("textarea, input[type=text], input[type=search]")).toHaveCount(0); // no arbitrary natural-language box
    await expect(page.getByText("استدلال آزاد زبان طبیعی پیاده‌سازی نشده است")).toBeVisible();
  });
});

test.describe("diagnostic runs (offline engine, mock data)", () => {
  test("restart loop caused by DB failure: timeline, ranked hypothesis, evidence, recommendations", async ({ page }) => {
    await diagnose(page, "demo-api", RESTART);
    await expect(page.getByTestId("run-status")).toHaveAttribute("data-status", "COMPLETED");
    // timeline shows every step finished
    for (const k of ["collect_logs", "inspect_runtime", "review_releases", "analyze_metrics", "identify_hypotheses", "prepare_report"]) {
      await expect(page.locator(`[data-step="${k}"]`)).toHaveAttribute("data-status", "done");
    }
    // simulated vs real is explicit
    await expect(page.getByTestId("report-mode")).toHaveAttribute("data-mode", "mock");
    await expect(page.getByTestId("report-mode")).toContainText("شبیه‌سازی‌شده");
    // top hypothesis + confidence level (no percentages)
    const top = page.getByTestId("hypothesis-restart_loop_db_connection_refused");
    await expect(top).toHaveAttribute("data-rank", "1");
    await expect(top).toHaveAttribute("data-confidence", "HIGH");
    await expect(top).toContainText("حلقهٔ ری‌استارت همراه با رد شدن اتصال دیتابیس");
    await expect(top.getByTestId("observations")).toContainText("چرخهٔ ری‌استارت");
    await expect(top.getByTestId("inferences")).toContainText("همبستگی زمانی");
    expect(await page.getByTestId("report-summary").innerText()).not.toMatch(/%|٪/);
    // recommendations: context-aware, never executed
    const recs = page.getByTestId("recommendation");
    expect(await recs.count()).toBeGreaterThanOrEqual(3);
    for (const r of await recs.all()) await expect(r).toHaveAttribute("data-executable", "false");
    await expect(page.getByTestId("recommendations")).toContainText("هیچ‌یک از این اقدام‌ها اجرا نمی‌شود");
    await expect(page.getByTestId("recommendations")).not.toContainText("پلن");
    await expect(page.locator('[data-testid="recommendation"][data-risk="R1"]')).toContainText("پس از رفع");
    // evidence details: expandable, sanitised, labelled
    const logsEvidence = page.getByTestId("evidence-logs");
    await expect(logsEvidence).toHaveAttribute("data-simulated", "true");
    await logsEvidence.locator("summary").click();
    const html = await page.content();
    for (const secret of ["S3cretPass99", "db.internal", "abcdef1234567890SIMULATEDTOKEN", "admin@example.invalid"]) expect(html, secret).not.toContain(secret);
    await expect(logsEvidence).toContainText("host-1");
    // citations link to evidence
    await top.getByTestId("citation").first().click();
    await expect(page).toHaveURL(/#ev-/);
    await page.screenshot({ path: "test-results/assistant-report-desktop.png", fullPage: true });
  });

  const scenarios: [string, string, string, string, string][] = [
    ["demo-oom", RESTART, "restart_loop_oom_kill", "HIGH", "memory_growth_unverified"],
    ["demo-cpu", SLOW, "cpu_saturation", "MEDIUM", ""],
    ["demo-badrelease", DEPLOY, "release_failed", "MEDIUM", ""],
    ["demo-http500", H500, "http_500", "MEDIUM", ""],
    ["demo-conflict", RESTART, "restart_loop_db_connection_refused", "MEDIUM", "db_authentication_failure"],
  ];
  for (const [app, intent, key, conf, second] of scenarios) {
    test(`${app}: ${key} (${conf})`, async ({ page }) => {
      await diagnose(page, app, intent);
      const top = page.getByTestId(`hypothesis-${key}`);
      await expect(top).toHaveAttribute("data-rank", "1");
      await expect(top).toHaveAttribute("data-confidence", conf);
      if (second) await expect(page.getByTestId(`hypothesis-${second}`)).toBeVisible();
      for (const r of await page.getByTestId("recommendation").all()) await expect(r).toHaveAttribute("data-executable", "false");
    });
  }

  test("conflicting signals are shown as contradictions and cap confidence", async ({ page }) => {
    await diagnose(page, "demo-conflict", RESTART);
    await expect(page.getByTestId("contradictions").first()).toContainText("تناقض");
    await expect(page.locator('[data-testid^="hypothesis-"][data-confidence="HIGH"]')).toHaveCount(0);
  });

  test("CPU scenario labels its (simulated) verified units; HTTP-500 scenario flags instruction-like log text without obeying it", async ({ page }) => {
    await diagnose(page, "demo-cpu", SLOW);
    await expect(page.locator('[data-caveat="simulated_semantics"]')).toBeVisible();
    await diagnose(page, "demo-http500", H500);
    await expect(page.locator('[data-caveat="injection_suspected"]')).toContainText("فقط داده است");
    await expect(page.getByTestId("recommendations")).not.toContainText(/حذف|ری‌استارت|پلن/);
    expect(await page.getByTestId("report-summary").innerText()).not.toMatch(/ignore all previous/);
  });

  test("healthy app: 'no anomaly in examined evidence' — never 'healthy'", async ({ page }) => {
    await diagnose(page, "demo-shop", RESTART);
    await expect(page.getByTestId("summary-status")).toContainText("ناهنجاری مشخصی پیدا نشد");
    await expect(page.getByTestId("summary-status")).toContainText("به‌معنی سلامت تأییدشده نیست");
    await expect(page.getByTestId("no-hypotheses")).toBeVisible();
  });

  test("insufficient evidence: explicit explanation, per-source reasons and R0 guidance", async ({ page }) => {
    await diagnose(page, "demo-worker", RESTART);
    await expect(page.getByTestId("report")).toHaveAttribute("data-status", "INSUFFICIENT_EVIDENCE");
    await expect(page.getByTestId("hypothesis-insufficient_evidence")).toHaveAttribute("data-confidence", "INSUFFICIENT_EVIDENCE");
    await expect(page.getByTestId("missing-evidence")).toContainText("لاگ‌ها");
    for (const r of await page.getByTestId("recommendation").all()) await expect(r).toHaveAttribute("data-risk", "R0");
  });

  test("stale metrics are reported as stale evidence", async ({ page }) => {
    await diagnose(page, "demo-stale", SLOW);
    await expect(page.locator('[data-testid="evidence-cpu"]')).toHaveAttribute("data-availability", "stale");
    await expect(page.getByTestId("limitations")).toContainText("قدیمی");
  });

  test("runs persist and are listed; the run page is re-openable", async ({ page }) => {
    await diagnose(page, "demo-shop", RESTART);
    const url = page.url();
    await page.goto("/assistant");
    await expect(page.getByTestId("runs-list").locator("li").first()).toBeVisible();
    await page.goto(url);
    await expect(page.getByTestId("report")).toBeVisible();
  });

  test("unsupported intent and unauthorised app are refused by the API with Persian messages", async ({ page }) => {
    const headers = { origin: "http://localhost:3101" };
    const bad = await page.request.post("/api/diagnostic-runs", { headers, data: { app: "demo-shop", intent: "please restart everything" } });
    expect(bad.status(), await bad.text()).toBe(400);
    expect((await bad.json()).error.message).toContain("پشتیبانی نمی‌شود");
    const denied = await page.request.post("/api/diagnostic-runs", { headers, data: { app: "not-allowlisted", intent: "why_slow" } });
    expect(denied.status()).toBe(404);
    const cross = await page.request.post("/api/diagnostic-runs", { headers: { origin: "https://evil.example" }, data: { app: "demo-shop", intent: "why_slow" } });
    expect(cross.status()).toBe(403);
    const anon = await (await page.context().browser()!.newContext({ baseURL: "http://localhost:3101" })).request.get("/api/diagnostic-runs");
    expect(anon.status()).toBe(401);
  });

  test("another run's page is a 404 for unknown ids", async ({ page }) => {
    const res = await page.goto("/assistant/runs/run_20200101000000_deadbeef");
    expect(res?.status()).toBe(404);
  });

  test("no console errors while using the assistant", async ({ page }) => {
    await diagnose(page, "demo-api", RESTART);
    expect(errors.filter((e) => !/favicon/i.test(e))).toEqual([]);
  });
});

test.describe("assistant: responsive layout, RTL and accessibility", () => {
  for (const s of [{ name: "mobile", width: 360, height: 740 }, { name: "tablet", width: 768, height: 1024 }, { name: "desktop", width: 1280, height: 800 }]) {
    test(`no horizontal overflow at ${s.name} (${s.width}px) on form and report`, async ({ page }) => {
      await page.setViewportSize({ width: s.width, height: s.height });
      await page.goto("/assistant");
      expect(await page.evaluate(() => document.documentElement.scrollWidth - window.innerWidth), "form").toBeLessThanOrEqual(0);
      await diagnose(page, "demo-api", RESTART);
      await page.getByTestId("evidence-logs").locator("summary").click();
      await page.waitForLoadState("networkidle");
      expect(await page.evaluate(() => document.documentElement.scrollWidth - window.innerWidth), "report").toBeLessThanOrEqual(0);
      await expect(page.locator("html")).toHaveAttribute("dir", "rtl");
      await page.screenshot({ path: `test-results/assistant-report-${s.name}.png`, fullPage: true });
    });
  }

  test("touch targets on the form are ≥44px", async ({ page }) => {
    await page.setViewportSize({ width: 360, height: 740 });
    await page.goto("/assistant");
    for (const loc of [page.locator("#app"), page.locator("#window"), page.getByTestId("start-run"), page.locator("label", { hasText: RESTART })]) {
      const box = await loc.first().boundingBox();
      expect(box!.height).toBeGreaterThanOrEqual(43.5);
    }
  });

  test("axe: no serious/critical violations on the form and on a finished report", async ({ page }) => {
    await page.goto("/assistant");
    await page.waitForLoadState("networkidle");
    let res = await new AxeBuilder({ page }).withTags(["wcag2a", "wcag2aa"]).analyze();
    expect(res.violations.filter((v) => v.impact === "serious" || v.impact === "critical").map((v) => `${v.id}:${v.nodes.length}`)).toEqual([]);
    await diagnose(page, "demo-conflict", RESTART);
    await page.getByTestId("evidence-logs").locator("summary").click();
    res = await new AxeBuilder({ page }).withTags(["wcag2a", "wcag2aa"]).analyze();
    expect(res.violations.filter((v) => v.impact === "serious" || v.impact === "critical").map((v) => `${v.id}:${v.nodes.length}`)).toEqual([]);
  });

  test("keyboard: the intent options and start button are reachable and operable without a mouse", async ({ page }) => {
    await page.goto("/assistant");
    await page.getByLabel(DEPLOY).focus();
    await page.keyboard.press("Space");
    await expect(page.getByLabel(DEPLOY)).toBeChecked();
    await page.getByTestId("start-run").focus();
    await page.keyboard.press("Enter");
    await expect(page).toHaveURL(/\/assistant\/runs\//);
  });

  test("reduced motion: no animated spinners on a finished run page", async ({ browser }) => {
    const ctx = await browser.newContext({ reducedMotion: "reduce", baseURL: "http://localhost:3101" });
    const page = await ctx.newPage();
    await login(page);
    await diagnose(page, "demo-shop", RESTART);
    const animated = await page.evaluate(() => [...document.querySelectorAll("*")].filter((el) => { const a = getComputedStyle(el).animationName; return a !== "none" && getComputedStyle(el).animationDuration !== "1e-05s"; }).length);
    expect(animated).toBe(0);
    await ctx.close();
  });
});
