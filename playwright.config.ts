import { defineConfig, devices } from "@playwright/test";
import { randomBytes, scryptSync } from "node:crypto";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";

/**
 * E2E runs the PRODUCTION build in MOCK mode on a throw-away port, with a throw-away operator password.
 * Uses the system Chrome (no browser download). Nothing here touches Liara.
 */
const PORT = 3101;
export const E2E_PASSWORD = "e2e-operator-password-123";

function hash(pw: string): string {
  const salt = randomBytes(16);
  const N = 4096;
  const key = scryptSync(pw, salt, 32, { N, r: 8, p: 1, maxmem: 64 * 1024 * 1024 });
  return ["scrypt", N, 8, 1, salt.toString("base64url"), key.toString("base64url")].join("$");
}

export default defineConfig({
  testDir: "./tests/e2e",
  fullyParallel: false,
  workers: 1,
  retries: 0,
  reporter: [["list"]],
  outputDir: "test-results",
  use: {
    baseURL: `http://localhost:${PORT}`,
    channel: "chrome",
    locale: "fa-IR",
    timezoneId: "Asia/Tehran",
    trace: "off",
  },
  projects: [{ name: "chrome", use: { ...devices["Desktop Chrome"], channel: "chrome" } }],
  webServer: {
    command: `npx next build && npx next start -p ${PORT}`,
    url: `http://localhost:${PORT}/api/health`,
    reuseExistingServer: false,
    timeout: 240_000,
    env: {
      // The e2e server must NEVER read a developer's .env.local (it may hold a live token, and Next's dotenv-expand would also mangle the `$` in the
      // generated scrypt hash whenever .env.local merely DECLARES the same variable). Next skips env-file loading when this internal flag is already set.
      __NEXT_PROCESSED_ENV: "true",
      LIARA_DATA_SOURCE: "mock",
      APP_ACCESS_PASSWORD_HASH: hash(E2E_PASSWORD),
      NODE_ENV: "production",
      AI_PROVIDER: "mock",
      AI_LIVE_REQUESTS_ENABLED: "false",
      DIAGNOSTICS_DB_PATH: path.join(mkdtempSync(path.join(tmpdir(), "liara-e2e-")), "diagnostics.sqlite"),
      DIAGNOSTICS_MAX_CONCURRENT_RUNS: "5",
    },
  },
});
