import { describe, expect, it } from "vitest";
import { broadIntent, isOperational, mentionsOwnServiceProblem } from "@/server/agent/operational";

const APPS = ["liara-agent-demo", "shop-api"];

describe("operational = about the operator's OWN service ⇒ evidence first (structural, not a list of exact phrasings)", () => {
  it.each([
    "لاگ‌های liara-agent-demo را ببین",
    "آیا liara-agent-demo سالم است؟",
    "liara-agent-demo خیلی دیر جواب میده",
    "memory shop-api بالا رفته",
    "مصرف منابع shop-api چقدر است؟",
    "سایتم کنده",
    "وب‌سایت من گاهی ارور می‌دهد",
    "برنامه‌ام قطع و وصل می‌شود",
    "my website is slow",
    "check my app logs",
    "سایت کند است و ۵۰۰ می‌دهد",
    "سرویس گاهی ارور می‌ده",
  ])("operational: %s", (t) => expect(isOperational(t, APPS)).toBe(true));
  it.each([
    "تفاوت ری‌استارت و ری‌دیپلوی در لیارا چیست؟",
    "پلن‌های لیارا چقدر RAM دارند و کدام برای یک سایت کوچک مناسب است؟",
    "چطور دامنه را به برنامه وصل کنم؟",
    "برای یک اپلیکیشن Node.js که قرار است روی لیارا مستقر شود، یک برنامه استقرار امن تهیه کن. پیش‌نیازهای نامشخص، مراحل بررسی قبل از استقرار، ریسک‌های مهم و ترتیب پیشنهادی اقدامات را مشخص کن. بین اطلاعات قطعی و فرضیات تفاوت بگذار و هیچ عملیات واقعی انجام نده.",
    "ایرنیک چیست؟",
    "how does Liara pricing work?",
  ])("general / planning: %s", (t) => expect(isOperational(t, APPS)).toBe(false));
  it("an unauthorised app name alone does not make a message operational (no existence oracle) — but a problem report about it is still refused deterministically", () => {
    expect(isOperational("secret-internal-app چیست؟", APPS)).toBe(false);
    expect(mentionsOwnServiceProblem("secret-internal-app کند است و ارور می‌دهد؟ سایت من")).toBe(true);
    expect(mentionsOwnServiceProblem("Node.js app deployment plan")).toBe(false);
  });
  it("short tokens are matched as whole words (no accidental hits inside other words)", () => {
    expect(isOperational("رمز عبور سایت را چطور عوض کنم؟", APPS)).toBe(false);
  });
});

describe("broadIntent picks a read-only investigation whose source set covers what was asked", () => {
  it.each([
    ["مصرف CPU و RAM را بررسی کن", "investigate_slow"],
    ["سایتم کنده", "investigate_slow"],
    ["حافظه بالا رفته", "investigate_slow"],
    ["گاهی ارور ۵۰۰ می‌دهد", "investigate_http500"],
    ["برنامه قطع و وصل می‌شود", "investigate_restarts"],
    ["آخرین دیپلوی موفق بود؟", "investigate_deployments"],
    ["لاگ‌ها را ببین", "inspect_health"],
    ["آیا سالم است؟", "inspect_health"],
  ])("%s ⇒ %s", (t, intent) => expect(broadIntent(t)).toBe(intent));
});
