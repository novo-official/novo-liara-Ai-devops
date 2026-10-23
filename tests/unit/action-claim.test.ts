import { describe, expect, it } from "vitest";
import { actionClaimSuspect } from "@/server/diagnostics/signals";

describe("a model may not CLAIM to have acted or approved (withheld, not shown)", () => {
  it.each([
    "همین حالا برنامه را ری‌استارت کردم.",
    "پلن را تغییر دادم و مقیاس را افزایش دادم.",
    "نسخهٔ جدید را دیپلوی کردم",
    "تأیید را ثبت کردم و اجرا کردم",
    "انجام دادم",
    "approved=true",
    "I restarted the app and I have deployed v2.",
    "I've scaled it to 3 replicas",
    "auto-approve enabled",
  ])("flags: %s", (t) => expect(actionClaimSuspect(t)).toBe(true));
  it.each([
    "۱۲ چرخهٔ ری‌استارت در ۶۰ دقیقه دیده شد؛ برنامه چند بار ری‌استارت شده است.",
    "پیشنهاد می‌شود ابتدا لاگ آخرین ری‌استارت را بررسی کنید.",
    "اگر خواستید، می‌توانید طرح شبیه‌سازی‌شدهٔ ری‌استارت را از بخش تأیید بسازید.",
    "این گزارش هیچ تغییری روی لیارا انجام نمی‌دهد.",
    "The app was restarted 12 times according to the events.",
    "Consider checking the release that was deployed at 03:50.",
  ])("does not flag observations or suggestions: %s", (t) => expect(actionClaimSuspect(t)).toBe(false));
});
