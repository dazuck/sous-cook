import { defineConfig, devices } from "@playwright/test";
import {
  E2E_APP_PORT,
  E2E_BASE_URL,
  E2E_LOCALE,
  E2E_TIMEZONE,
} from "./e2e/env";

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
  expect: {
    toHaveScreenshot: {
      maxDiffPixels: 0,
      threshold: 0,
      animations: "disabled",
      caret: "hide",
    },
  },
  use: {
    baseURL: E2E_BASE_URL,
    serviceWorkers: "block",
    timezoneId: E2E_TIMEZONE,
    locale: E2E_LOCALE,
    // What the browser says it is, the same on every machine: Playwright's
    // desktop Chrome (it says Windows). The cook screen picks how it listens
    // from this and the touch screen (src/lib/kitchen/voice-mode.ts), and
    // Chromium on Linux with the projects' touch screen reads as the tablet
    // asking for desktop sites, which listens only on a tap. Left to the
    // machine, a Linux CI runner would test a different cook screen than a
    // Mac. Specs that test the other identities set their own
    // (e2e/voice-replies.spec.ts, VOICE-8 to VOICE-11).
    userAgent: devices["Desktop Chrome"].userAgent,
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
      grepInvert: /@visual/,
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
    // Playwright races webServer.url against wait.stdout, so omitting url keeps
    // another server that starts during the build from satisfying readiness.
    // serve.ts checks the port before building and before spawning next start,
    // waits for its own child's ready line and /kitchen response, then prints
    // this line.
    wait: {
      stdout: new RegExp(
        `^sous-e2e-server-ready pid=\\d+ port=${E2E_APP_PORT}$`,
        "m",
      ),
    },
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
