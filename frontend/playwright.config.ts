// Browser tests for Luma. They run against the local FAKE API (dev/mock-api.mjs):
// no real accounts, emails, AI calls or student data. Uses the Microsoft Edge
// already installed on this PC (channel "msedge"), so no browser download.
//
//   npm run e2e                 all layouts
//   npm run e2e -- --project=phone
import { defineConfig, devices } from "@playwright/test"

// Ports can be changed so several runs can happen side by side.
const API_PORT = Number(process.env.E2E_API_PORT || 8788)
const WEB_PORT = Number(process.env.E2E_WEB_PORT || 5174)

export default defineConfig({
  testDir: "./e2e",
  outputDir: "./test-results",
  fullyParallel: false,
  workers: 1,
  retries: 0,
  // Closing an extra Edge window sometimes takes a while on Windows; give tests room.
  timeout: 60_000,
  reporter: [["list"], ["html", { outputFolder: "playwright-report", open: "never" }]],
  use: {
    baseURL: `http://localhost:${WEB_PORT}`,
    channel: "msedge",
    // Fake accounts only, but keep traces small and only when something fails.
    trace: "retain-on-failure",
    screenshot: "only-on-failure",
  },
  projects: [
    { name: "desktop", use: { viewport: { width: 1280, height: 800 } } },
    { name: "tablet", use: { viewport: { width: 820, height: 1180 }, hasTouch: true } },
    { name: "phone", use: { ...devices["Pixel 7"], channel: "msedge", viewport: { width: 375, height: 812 } } },
  ],
  webServer: [
    {
      command: `node dev/mock-api.mjs`,
      url: `http://127.0.0.1:${API_PORT}/health`,
      env: { PORT: String(API_PORT) },
      reuseExistingServer: false,
      stdout: "ignore",
    },
    {
      command: `npx vite --port ${WEB_PORT} --strictPort`,
      url: `http://localhost:${WEB_PORT}`,
      env: { VITE_API_BASE_URL: `http://127.0.0.1:${API_PORT}` },
      reuseExistingServer: false,
    },
  ],
})
