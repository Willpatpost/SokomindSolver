import { defineConfig, devices } from "@playwright/test";
import { PREVIEW_URL } from "./scripts/preview-settings.mjs";

export default defineConfig({
  testDir: "./tests/e2e",
  fullyParallel: true,
  forbidOnly: Boolean(process.env.CI),
  retries: process.env.CI ? 2 : 0,
  reporter: process.env.CI ? "github" : "list",
  use: {
    baseURL: PREVIEW_URL,
    serviceWorkers: "block",
    trace: "on-first-retry",
    screenshot: "only-on-failure",
  },
  projects: [
    {
      name: "chromium",
      testIgnore: [/mobile\.spec\.ts/, /minimum-width\.spec\.ts/, /service-worker\.spec\.ts/],
      use: {
        ...devices["Desktop Chrome"],
        channel: process.env.CI ? undefined : "chrome",
      },
    },
    {
      name: "firefox",
      testIgnore: [/mobile\.spec\.ts/, /minimum-width\.spec\.ts/, /service-worker\.spec\.ts/],
      use: {
        ...devices["Desktop Firefox"],
      },
    },
    {
      name: "webkit",
      testIgnore: [/mobile\.spec\.ts/, /minimum-width\.spec\.ts/, /service-worker\.spec\.ts/],
      use: {
        ...devices["Desktop Safari"],
      },
    },
    {
      name: "mobile-chrome",
      testMatch: /mobile\.spec\.ts/,
      use: {
        ...devices["Pixel 7"],
        channel: process.env.CI ? undefined : "chrome",
      },
    },
    {
      name: "mobile-safari",
      testMatch: /mobile\.spec\.ts/,
      use: {
        ...devices["iPhone 14"],
      },
    },
    {
      name: "minimum-width-chrome",
      testMatch: /minimum-width\.spec\.ts/,
      use: {
        ...devices["Pixel 7"],
        viewport: { width: 320, height: 568 },
        channel: process.env.CI ? undefined : "chrome",
      },
    },
    {
      name: "service-worker-chromium",
      testMatch: /service-worker\.spec\.ts/,
      use: {
        ...devices["Desktop Chrome"],
        channel: process.env.CI ? undefined : "chrome",
        serviceWorkers: "allow",
      },
    },
  ],
});
