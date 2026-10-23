import AxeBuilder from "@axe-core/playwright";
import { expect, test, type Page } from "@playwright/test";
import { E2E_PASSWORD } from "../../playwright.config";

/**
 * The browser side of the real-model messages, with the API STUBBED in the browser (page.route): the E2E server runs in mock mode, so no model and no network
 * is involved. It proves rendering, attribution, RTL/mixed text, error recovery and accessibility of the new message kinds — not the model call itself.
 */
const CONV = "conv_20260102040000_aabbccdd";
const at = "2026-01-02T04:00:00.000Z";
const user = { id: "msg_1", conversationId: CONV, role: "user", kind: "user", textFa: "تفاوت ری‌استارت و ری‌دیپلوی در لیارا چیست؟", at };
const answer = { id: "msg_2", conversationId: CONV, role: "agent", kind: "ai_answer", at, intent: "unsupported", ai: { source: "boxapi", model: "test-model", usage: { promptTokens: 10, completionTokens: 20, totalTokens: 30 } }, textFa: "۱. ری‌استارت فقط پردازه را دوباره اجرا می‌کند.\n۲. برای تغییر کد باید `liara deploy` اجرا شود و متغیر DATABASE_URL را بررسی کنید." };
const failure = { id: "msg_3", conversationId: CONV, role: "agent", kind: "ai_error", at, intent: "unsupported", ai: { source: "boxapi", error: "insufficient_credit" }, textFa: "اعتبار حساب BoxAPI کافی نیست. حساب را شارژ کنید و دوباره تلاش کنید." };
const view = (messages: unknown[]) => ({ conversation: { id: CONV }, messages, runs: [], activeRun: null, proposals: [] });

async function stub(page: Page, messages: unknown[]) {
  await page.route("**/api/agent/messages", (r) => r.fulfill({ json: { conversationId: CONV, messages, runId: null, proposalId: null } }));
  await page.route(`**/api/agent/conversations/${CONV}`, (r) => r.fulfill({ json: view(messages) }));
}
async function open(page: Page) {
  await page.goto("/login");
  await page.getByLabel("گذرواژه").fill(E2E_PASSWORD);
  await page.getByRole("button", { name: "ورود" }).click();
  await expect(page).toHaveURL(/\/apps$/);
  await page.goto("/agent");
}
const axe = async (page: Page) => {
  const r = await new AxeBuilder({ page }).withTags(["wcag2a", "wcag2aa", "wcag21a", "wcag21aa"]).analyze();
  expect(r.violations.map((v) => `${v.id}: ${v.nodes.map((n) => n.target.join(" ")).join(" | ")}`)).toEqual([]);
};
const send = async (page: Page) => {
  await page.getByTestId("agent-input").fill("تفاوت ری‌استارت و ری‌دیپلوی در لیارا چیست؟");
  await page.getByTestId("send").click();
};

test("a model answer renders with attribution, RTL text and a code snippet, and is accessible", async ({ page }) => {
  await stub(page, [user, answer]);
  await open(page);
  await send(page);
  const item = page.locator('[data-testid="messages"] li[data-kind="ai_answer"]');
  await expect(item).toBeVisible();
  await expect(item).toContainText("ری‌استارت فقط پردازه");
  await expect(item).toContainText("liara deploy");
  await expect(item.getByTestId("ai-attribution")).toHaveAttribute("data-source", "boxapi");
  await expect(item.getByTestId("ai-attribution")).toContainText("test-model");
  await expect(item.getByTestId("ai-attribution")).toContainText("30 توکن");
  await expect(item).toContainText("راهنما، نه نتیجهٔ بررسی");
  await axe(page);
});

test("a failed request is shown as a failure with the recovery text; nothing is presented as an answer; accessible", async ({ page }) => {
  await stub(page, [user, failure]);
  await open(page);
  await send(page);
  const item = page.locator('[data-testid="messages"] li[data-kind="ai_error"]');
  await expect(item).toContainText("اعتبار حساب BoxAPI کافی نیست");
  await expect(page.locator('li[data-kind="ai_answer"]')).toHaveCount(0);
  await expect(item.getByTestId("ai-attribution")).toHaveCount(0);
  await axe(page);
});

test("mock mode has no model controls and says so (no 'ask the model' button, no real-model badge)", async ({ page }) => {
  await open(page);
  await expect(page.getByTestId("ask-model")).toHaveCount(0);
  await expect(page.getByTestId("ai-provider-badge")).toHaveCount(0);
  await expect(page.getByTestId("agent-provider")).toHaveAttribute("data-provider", "mock");
});

test("narrow screens: no horizontal overflow with a long answer", async ({ page }) => {
  await stub(page, [user, { ...answer, textFa: `${answer.textFa}\n${"liara-deploy-with-a-very-long-unbroken-token-".repeat(8)}` }]);
  await page.setViewportSize({ width: 360, height: 800 });
  await open(page);
  await send(page);
  await expect(page.locator('li[data-kind="ai_answer"]')).toBeVisible();
  const overflow = await page.evaluate(() => document.documentElement.scrollWidth - document.documentElement.clientWidth);
  expect(overflow).toBeLessThanOrEqual(1);
});
