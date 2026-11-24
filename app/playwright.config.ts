import { defineConfig } from "@playwright/test";
import { E2E_BASE_URL, E2E_LOCALE, E2E_TIMEZONE } from "./e2e/env";

const skipBuild = process.env.E2E_SKIP_BUILD === "1";
const serveCommand = [
  "node",
  "node_modules/tsx/dist/cli.mjs",
  "e2e/serve.ts",
  ...(skipBuild ? [] : ["--build"]),
  "--owner",
  String(process.pid),
].join(" ");

const tabletLaunchOptions = {
  args: ["--disable-partial-raster"],
};

const smokeBaseUrl = process.env.SMOKE_BASE_URL;
const bypassHeader = process.env.SMOKE_BYPASS_HEADER;
const bypassValue = process.env.SMOKE_BYPASS_VALUE;
const smokeExtraHeaders: Record<string, string> | undefined =
  bypassHeader && bypassValue ? { [bypassHeader]: bypassValue } : undefined;

const smokeConfig = defineConfig({
  testDir: "./e2e",
  testMatch: "smoke.spec.ts",
  workers: 1,
  fullyParallel: false,
  retries: 0,
  forbidOnly: Boolean(process.env.CI),
  outputDir: "test-results",
  reporter: "list",
  projects: [
    {
      name: "smoke",
      use: {
        baseURL: smokeBaseUrl,
        serviceWorkers: "block",
        timezoneId: E2E_TIMEZONE,
        locale: E2E_LOCALE,
        trace: "retain-on-failure",
        viewport: { width: 1280, height: 800 },
        hasTouch: true,
        isMobile: false,
        deviceScaleFactor: 1,
        launchOptions: tabletLaunchOptions,
        ...(smokeExtraHeaders ? { extraHTTPHeaders: smokeExtraHeaders } : {}),
      },
    },
  ],
});

const localConfig = defineConfig({
  testDir: "./e2e",
  testMatch: "**/*.spec.ts",
  testIgnore: "**/smoke.spec.ts",
  workers: 1,
  fullyParallel: false,
  retries: 0,
  forbidOnly: Boolean(process.env.CI),
  outputDir: "test-results",
  reporter: process.env.CI
    ? [["list"], ["html", { open: "never" }]]
    : "list",
  globalSetup: "./e2e/global-setup.ts",
  use: {
    baseURL: E2E_BASE_URL,
    serviceWorkers: "block",
    timezoneId: E2E_TIMEZONE,
    locale: E2E_LOCALE,
    trace: "retain-on-failure",
  },
  projects: [
    {
      name: "landscape",
      use: {
        viewport: { width: 1280, height: 800 },
        hasTouch: true,
        isMobile: false,
        deviceScaleFactor: 1,
        launchOptions: tabletLaunchOptions,
      },
    },
    {
      name: "portrait",
      use: {
        viewport: { width: 800, height: 1280 },
        hasTouch: true,
        isMobile: false,
        deviceScaleFactor: 1,
        launchOptions: tabletLaunchOptions,
      },
    },
  ],
  webServer: {
    command: serveCommand,
    url: `${E2E_BASE_URL}/kitchen`,
    timeout: 300_000,
    reuseExistingServer: false,
    gracefulShutdown: {
      signal: "SIGTERM",
      timeout: 10_000,
    },
  },
});

export default smokeBaseUrl !== undefined && smokeBaseUrl !== ""
  ? smokeConfig
  : localConfig;
