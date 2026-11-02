import { defineConfig } from "@playwright/test";
import { accessHost } from "./tests/fixtures/access-host";

const webPort = process.env.THOUGHTLOOM_E2E_WEB_PORT ?? "4317";

export default defineConfig({
  testDir: "./tests/browser",
  fullyParallel: false,
  workers: 1,
  retries: 0,
  timeout: 20_000,
  expect: { timeout: 5_000 },
  reporter: "list",
  use: {
    baseURL: `http://127.0.0.1:${webPort}`,
    browserName: "chromium",
    // Reuse the installed browser. This suite must never download a browser.
    launchOptions: {
      executablePath: process.env.THOUGHTLOOM_CHROMIUM_PATH ?? "/usr/bin/chromium",
    },
    trace: "retain-on-failure",
  },
  projects: [
    { name: "desktop", use: { viewport: { width: 1280, height: 900 } } },
    { name: "phone", use: { viewport: { width: 390, height: 844 }, isMobile: true, hasTouch: true } },
  ],
  webServer: {
    command: "bun run tests/browser/serve.ts",
    env: { THOUGHTLOOM_ALLOWED_HOST: accessHost },
    url: `http://127.0.0.1:${webPort}`,
    reuseExistingServer: false,
    timeout: 60_000,
    gracefulShutdown: { signal: "SIGTERM", timeout: 10_000 },
  },
});
