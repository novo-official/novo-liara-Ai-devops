import AxeBuilder from "@axe-core/playwright";
import { expect, test, type Page } from "@playwright/test";
import { E2E_PASSWORD } from "../../playwright.config";

async function login(page: Page) {
  await page.goto("/login");
  await page.getByLabel("گذرواژه").fill(E2E_PASSWORD);
  await page.getByRole("button", { name: "ورود" }).click();
  await expect(page).toHaveURL(/\/apps$/);
}

const errors: string[] = [];
test.beforeEach(async ({ page }) => {
  errors.length = 0;
  page.on("console", (m) => m.type() === "error" && errors.push(m.text()));
  page.on("pageerror", (e) => errors.push(e.message));
});

test.describe("authentication", () => {
  test("anonymous users are redirected to an RTL Persian login page", async ({ page, request }) => {
    await page.goto("/apps");
    await expect(page).toHaveURL(/\/login$/);
    await expect(page.locator("html")).toHaveAttribute("dir", "rtl");
    await expect(page.locator("html")).toHaveAttribute("lang", "fa");
    await expect(page.getByRole("heading", { name: "ورود اپراتور" })).toBeVisible();

    for (const p of ["/api/apps", "/api/apps/demo-shop", "/api/apps/demo-shop/logs?window=60", "/api/diagnostics"]) {
      const res = await request.get(p);
      expect(res.status(), p).toBe(401);
    }
    const cross = await request.post("/api/auth/login", { headers: { origin: "https://evil.example", "content-type": "application/json" }, data: { password: E2E_PASSWORD } });
    expect(cross.status()).toBe(403);
  });

  test("wrong password shows an error; correct password signs in with a hardened cookie", async ({ page, context }) => {
    await page.goto("/login");
    await page.getByLabel("گذرواژه").fill("definitely-wrong-password");
    await page.getByRole("button", { name: "ورود" }).click();
    await expect(page.locator("#login-error")).toContainText("گذرواژه نادرست");
    await login(page);
    const cookie = (await context.cookies()).find((c) => c.name.includes("liara_agent_session"))!;
    expect(cookie.httpOnly).toBe(true);
    expect(cookie.sameSite).toBe("Strict");
    expect(cookie.secure).toBe(true);
    expect(cookie.name.startsWith("__Host-")).toBe(true);
    // The session cookie is invisible to page scripts
    expect(await page.evaluate(() => document.cookie)).toBe("");
  });

  test("logout revokes the session", async ({ page }) => {
    await login(page);
    await page.getByRole("button", { name: "خروج" }).click();
    await expect(page).toHaveURL(/\/login$/);
    await page.goto("/apps");
    await expect(page).toHaveURL(/\/login$/);
  });
});

test.describe("dashboard (mock mode)", () => {
  test.beforeEach(async ({ page }) => login(page));

  test("applications overview lists simulated apps and is clearly labelled as simulated", async ({ page }) => {
    await expect(page.getByTestId("mode-banner")).toContainText("شبیه‌سازی");
    await expect(page.getByTestId("mode-badge").first()).toHaveAttribute("data-mode", "mock");
    const list = page.getByTestId("apps-list");
    await expect(list.locator("li")).toHaveCount(9);
    for (const n of ["demo-shop", "demo-api", "demo-worker", "demo-stale", "demo-oom", "demo-cpu", "demo-badrelease", "demo-http500", "demo-conflict"]) await expect(list).toContainText(n);
    await expect(list.getByText("غیرفعال (خاموش)").first()).toBeVisible(); // demo-worker (scale 0)
    await page.screenshot({ path: "test-results/apps-desktop.png", fullPage: true });
  });

  test("detail: runtime, charts, releases, events and sanitized logs; no mutation controls", async ({ page }) => {
    await page.getByRole("link", { name: "مشاهده" }).first().click();
    await expect(page).toHaveURL(/\/apps\/demo-/);
    await page.goto("/apps/demo-shop");
    for (const id of ["runtime", "cpu", "memory", "releases", "events", "logs"]) {
      await expect(page.getByTestId(`section-${id}`)).toBeVisible();
    }
    await expect(page.getByTestId("section-cpu").getByTestId("metric-chart")).toBeVisible();
    await expect(page.getByTestId("section-memory").getByTestId("metric-chart")).toBeVisible();
    await expect(page.getByTestId("section-releases")).toContainText("v3");
    await expect(page.getByTestId("applets-list").locator("li")).toHaveCount(2);
    // env var NAMES are shown, never values
    await page.getByText("کلید متغیرهای محیطی").click();
    await expect(page.getByText("PAYMENT_API_KEY")).toBeVisible();
    expect(await page.content()).not.toContain("SIMULATED-NOT-A-REAL-VALUE");
    // read-only: no buttons other than refresh / logout, no forms
    const buttons = await page.getByRole("button").allInnerTexts();
    expect(buttons.map((b) => b.trim()).filter(Boolean).sort()).toEqual(["بازخوانی", "خروج"].sort());
    await expect(page.locator("form")).toHaveCount(0);
    await page.screenshot({ path: "test-results/detail-desktop.png", fullPage: true });
  });

  test("logs are sanitized in the browser", async ({ page }) => {
    await page.goto("/apps/demo-api?window=60");
    const logs = page.getByTestId("logs-list");
    await expect(logs).toContainText("REDACTED");
    const html = await page.content();
    for (const secret of ["S3cretPass99", "abcdef1234567890SIMULATEDTOKEN", "admin@example.invalid"]) expect(html).not.toContain(secret);
    await expect(logs).toHaveCSS("direction", "ltr");
  });

  test("stopped app shows honest empty states (no fabricated metrics)", async ({ page }) => {
    await page.goto("/apps/demo-worker");
    await expect(page.getByTestId("metric-empty")).toHaveCount(2);
    await expect(page.getByTestId("applets-empty")).toBeVisible();
    await expect(page.getByTestId("releases-empty")).toBeVisible();
    await expect(page.getByTestId("events-empty")).toBeVisible();
    await expect(page.getByTestId("logs-empty")).toBeVisible();
  });

  test("unknown and non-allowlisted apps are indistinguishable 404s", async ({ page }) => {
    for (const p of ["/apps/not-a-real-app", "/apps/UPPER", "/apps/..%2Fetc"]) {
      const res = await page.goto(p);
      expect(res?.status(), p).toBe(404);
    }
  });

  test("window selector changes the query window and keeps state in the URL", async ({ page }) => {
    await page.goto("/apps/demo-shop");
    await page.getByRole("link", { name: "۶ ساعت" }).click();
    await expect(page).toHaveURL(/window=360/);
    await expect(page.getByRole("link", { name: "۶ ساعت" })).toHaveAttribute("aria-current", "true");
  });

  test("connection diagnostics explains mode, capabilities and what is unavailable", async ({ page }) => {
    await page.getByRole("link", { name: "وضعیت اتصال" }).click();
    await expect(page.getByTestId("diag-connectivity")).toHaveAttribute("data-state", "simulated");
    const caps = page.getByTestId("diag-capabilities").locator("li");
    await expect(caps).toHaveCount(9);
    // simulation can never be evidence: nothing is LIVE_VERIFIED, everything is simulated or disabled
    await expect(page.locator('[data-capability][data-verification="LIVE_VERIFIED"]')).toHaveCount(0);
    await expect(page.locator('[data-capability="getApp"]')).toHaveAttribute("data-health", "simulated");
    await expect(page.locator('[data-capability="getLogsV2"]')).toHaveAttribute("data-verification", "CLI_ONLY_UNVERIFIED");
    await expect(page.locator('[data-capability="getLogsV2"]')).toHaveAttribute("data-health", "disabled");
    await expect(page.getByTestId("diag-not-available")).toContainText("Rollback");
    await expect(page.getByTestId("diag-not-available")).toContainText("شواهد سلامت");
    await expect(page.getByTestId("diag-not-available")).toContainText("عمداً غیرفعال");
    await page.screenshot({ path: "test-results/diagnostics-desktop.png", fullPage: true });
  });

  test("refresh button re-reads data without errors", async ({ page }) => {
    await page.getByRole("button", { name: "بازخوانی" }).click();
    await expect(page.getByTestId("apps-list")).toBeVisible();
    expect(errors.filter((e) => !/favicon/i.test(e))).toEqual([]);
  });
});

test.describe("operational honesty (mock mode)", () => {
  test.beforeEach(async ({ page }) => login(page));

  test("a scaled-on but restarting app is never shown as healthy", async ({ page }) => {
    const card = page.getByTestId("apps-list").locator("li", { hasText: "demo-api" });
    await expect(card.getByTestId("badge-enabled")).toHaveAttribute("data-enabled", "enabled");
    await expect(card.getByTestId("badge-runtime")).toHaveAttribute("data-runtime", "restarting");
    expect(await card.getByTestId("badge-runtime").getAttribute("class")).not.toMatch(/text-success/);
    expect(await card.getByTestId("badge-enabled").getAttribute("class")).not.toMatch(/text-success/);

    await page.goto("/apps/demo-api");
    await expect(page.getByTestId("state-enabled")).toHaveAttribute("data-enabled", "enabled");
    await expect(page.getByTestId("state-runtime")).toHaveAttribute("data-runtime", "restarting");
    await expect(page.getByTestId("state-health")).toHaveAttribute("data-health", "unavailable");
    await expect(page.getByTestId("failure-reasons")).toContainText("process exited with code 1");
    await expect(page.getByTestId("section-runtime")).toContainText("روشن بودن پیکربندی به معنی سالم بودن نیست");
    expect(await page.getByTestId("state-runtime").locator("span, div").first().innerHTML()).not.toMatch(/text-success/);
  });

  test("a running app with no failure evidence is the only positive case", async ({ page }) => {
    const card = page.getByTestId("apps-list").locator("li", { hasText: "demo-shop" });
    await expect(card.getByTestId("badge-runtime")).toHaveAttribute("data-runtime", "running");
    expect(await card.getByTestId("badge-runtime").getAttribute("class")).toMatch(/text-success/);
    await page.goto("/apps/demo-worker");
    await expect(page.getByTestId("state-enabled")).toHaveAttribute("data-enabled", "disabled");
    await expect(page.getByTestId("state-runtime")).toHaveAttribute("data-runtime", "stopped");
  });

  test("metrics: no unit is claimed, last observation is shown, gaps are not bridged and stale data is flagged", async ({ page }) => {
    await page.goto("/apps/demo-stale?window=60");
    const cpu = page.getByTestId("section-cpu");
    await expect(cpu.getByTestId("metric-chart")).toHaveAttribute("data-unit", "unknown");
    await expect(cpu.getByTestId("metric-unit-note")).toContainText("واحد این متریک در API مستند نشده");
    await expect(cpu.getByTestId("metric-last")).toContainText("آخرین مشاهدهٔ موفق");
    await expect(cpu.getByTestId("metric-last")).toHaveAttribute("data-stale", "true");
    await expect(cpu.getByText("اندازه‌گیری قدیمی")).toBeVisible();
    await expect(cpu.getByTestId("metric-sparse")).toBeVisible();
    expect(await cpu.locator("svg polyline").count()).toBeGreaterThanOrEqual(2); // line broken at the gap
    await page.screenshot({ path: "test-results/detail-stale-desktop.png", fullPage: true });

    await page.goto("/apps/demo-shop?window=60");
    for (const li of await page.getByTestId("section-cpu").getByTestId("metric-last").all()) await expect(li).toHaveAttribute("data-stale", "false");
    await expect(page.getByTestId("section-cpu").getByTestId("metric-sparse")).toHaveCount(0);
  });

  test("stopped app: empty metrics are reported as empty, not as unsupported or zero", async ({ page }) => {
    await page.goto("/apps/demo-worker");
    await expect(page.getByTestId("metric-empty")).toHaveCount(2);
    await expect(page.getByTestId("metric-unsupported")).toHaveCount(0);
  });

  test("data that stays on screen ages visibly and is flagged stale (cannot silently look current)", async ({ page }) => {
    await page.clock.install();
    await page.goto("/apps/demo-shop");
    const f = page.getByTestId("section-runtime").getByTestId("freshness");
    await expect(f).toHaveAttribute("data-stale", "false");
    await page.clock.fastForward(5 * 60 * 1000);
    await expect(f).toHaveAttribute("data-stale", "true");
    await expect(f).toContainText("قدیمی — بازخوانی کنید");
  });

  test("every dynamic section shows when it was fetched", async ({ page }) => {
    await page.goto("/apps/demo-shop");
    for (const id of ["runtime", "cpu", "memory", "releases", "events", "logs"]) {
      await expect(page.getByTestId(`section-${id}`).getByTestId("freshness")).toBeVisible();
    }
    await page.goto("/apps");
    await expect(page.getByTestId("freshness").first()).toBeVisible();
  });
});

test.describe("responsive layout & accessibility", () => {
  const sizes = [
    { name: "mobile", width: 360, height: 740 },
    { name: "tablet", width: 768, height: 1024 },
    { name: "desktop", width: 1280, height: 800 },
  ];
  for (const s of sizes) {
    test(`no horizontal overflow at ${s.name} (${s.width}px)`, async ({ page }) => {
      await page.setViewportSize({ width: s.width, height: s.height });
      await login(page);
      for (const p of ["/apps", "/apps/demo-api", "/diagnostics"]) {
        await page.goto(p);
        await page.waitForLoadState("networkidle");
        const overflow = await page.evaluate(() => document.documentElement.scrollWidth - window.innerWidth);
        expect(overflow, `${p} @${s.width}`).toBeLessThanOrEqual(0);
      }
      await page.goto("/apps/demo-api");
      await page.screenshot({ path: `test-results/detail-${s.name}.png`, fullPage: true });
    });
  }

  test("touch targets of primary navigation are at least 44px", async ({ page }) => {
    await page.setViewportSize({ width: 360, height: 740 });
    await login(page);
    for (const loc of [page.getByRole("link", { name: "برنامه‌ها" }), page.getByRole("link", { name: "وضعیت اتصال" }), page.getByRole("button", { name: "خروج" }), page.getByRole("button", { name: "بازخوانی" })]) {
      const box = await loc.first().boundingBox();
      expect(box!.height).toBeGreaterThanOrEqual(43.5);
    }
  });

  for (const p of ["/login", "/apps", "/apps/demo-shop", "/diagnostics"]) {
    test(`axe: no serious/critical violations on ${p}`, async ({ page }) => {
      if (p !== "/login") await login(page);
      await page.goto(p);
      await page.waitForLoadState("networkidle");
      const res = await new AxeBuilder({ page }).withTags(["wcag2a", "wcag2aa"]).analyze();
      const bad = res.violations.filter((v) => v.impact === "serious" || v.impact === "critical");
      expect(bad.map((v) => `${v.id}: ${v.nodes.length}`)).toEqual([]);
    });
  }

  test("honours prefers-reduced-motion", async ({ browser }) => {
    const ctx = await browser.newContext({ reducedMotion: "reduce", baseURL: "http://localhost:3101" });
    const page = await ctx.newPage();
    await page.goto("/login");
    const dur = await page.evaluate(() => getComputedStyle(document.body).transitionDuration);
    expect(parseFloat(dur)).toBeLessThan(0.001); // seconds; reduced-motion CSS clamps transitions to ~0
    await ctx.close();
  });
});
