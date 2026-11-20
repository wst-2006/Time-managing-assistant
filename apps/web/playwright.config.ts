import { defineConfig, devices } from "@playwright/test";

if (process.env.TMA_E2E_ISOLATED !== "1") {
  throw new Error(
    "Playwright E2E requires the isolated runner. Use `pnpm test:e2e` so tests run against a throwaway data folder instead of your real one."
  );
}

const apiPort = process.env.PLAYWRIGHT_API_PORT ?? "3100";
const webPort = process.env.PLAYWRIGHT_WEB_PORT ?? "5174";
const apiBaseUrl = process.env.PLAYWRIGHT_API_BASE_URL ?? `http://127.0.0.1:${apiPort}`;
const webBaseUrl = process.env.PLAYWRIGHT_WEB_BASE_URL ?? `http://127.0.0.1:${webPort}`;

export default defineConfig({
  testDir: "./e2e",
  fullyParallel: false,
  workers: 1,
  retries: 0,
  timeout: 45_000,
  expect: { timeout: 8_000 },
  reporter: [["list"]],
  use: {
    baseURL: webBaseUrl,
    trace: "retain-on-failure",
    screenshot: "only-on-failure",
    video: "retain-on-failure"
  },
  projects: [
    { name: "chrome", use: { ...devices["Desktop Chrome"], channel: "chrome" } }
  ],
  webServer: [
    {
      command: "pnpm --dir ../api start",
      url: `${apiBaseUrl}/health`,
      env: { API_PORT: apiPort, FEISHU_CALLBACK_TRANSPORT: "http", TMA_DATA_DIR: process.env.TMA_DATA_DIR ?? "", TMA_DISABLE_BACKGROUND_JOBS: "1" },
      reuseExistingServer: false,
      timeout: 30_000
    },
    {
      command: `pnpm exec vite --host 127.0.0.1 --port ${webPort}`,
      url: webBaseUrl,
      env: { VITE_API_BASE_URL: apiBaseUrl },
      reuseExistingServer: false,
      timeout: 30_000
    }
  ]
});
