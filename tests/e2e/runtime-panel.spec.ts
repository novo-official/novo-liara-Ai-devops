import AxeBuilder from "@axe-core/playwright";
import { expect, test, type Page } from "@playwright/test";
import { E2E_PASSWORD } from "../../playwright.config";

async function open(page: Page) {
  await page.goto("/login");
  await page.getByLabel("گذرواژه").fill(E2E_PASSWORD);
  await page.getByRole("button", { name: "ورود" }).click();
  await expect(page).toHaveURL(/\/apps$/);
  await page.goto("/agent");
}

test("the runtime panel shows what the running server uses, only when opened (no request on page load), and is accessible", async ({ page }) => {
  const calls: string[] = [];
  page.on("request", (r) => r.url().includes("/api/agent/runtime") && calls.push(r.url()));
  await open(page);
  await expect(page.getByTestId("server-runtime-panel")).toBeVisible();
  expect(calls).toEqual([]); // collapsed: nothing is read
  await page.getByTestId("server-runtime-panel").locator("summary").click();
  const view = page.getByTestId("runtime-view");
  await expect(view).toBeVisible();
  await expect(view).toHaveAttribute("data-consistent", "true");
  await expect(page.getByTestId("runtime-data-source")).toHaveAttribute("data-source", "mock"); // the e2e server runs on simulated data
  await expect(page.getByTestId("runtime-routing")).toContainText("evidence-first");
  expect(calls).toHaveLength(1);
  const r = await new AxeBuilder({ page }).withTags(["wcag2a", "wcag2aa", "wcag21a", "wcag21aa"]).analyze();
  expect(r.violations.map((v) => `${v.id}: ${v.nodes.map((n) => n.target.join(" ")).join(" | ")}`)).toEqual([]);
});
