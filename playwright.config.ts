import { defineConfig } from "@playwright/test";

const E2E_BASE_URL = "http://127.0.0.1:15120";

export default defineConfig({
  testDir: "./e2e",
  fullyParallel: false,
  retries: process.env.CI ? 2 : 0,
  workers: 1,
  reporter: "list",
  use: {
    baseURL: E2E_BASE_URL,
    channel: process.env.CI ? undefined : "chrome",
    colorScheme: "dark",
    trace: "retain-on-failure",
  },
  webServer: {
    command: "node ./node_modules/vite/bin/vite.js --host 127.0.0.1 --port 15120",
    url: E2E_BASE_URL,
    reuseExistingServer: false,
    timeout: 30_000,
  },
});
