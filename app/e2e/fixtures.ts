/**
 * Shared Playwright fixtures for every browser spec:
 * - Restores the seeded database snapshot before each test.
 * - Fixes Date.now() / new Date() to SEED_NOW before any navigation.
 * - Aborts and fails on any browser request outside 127.0.0.1 / localhost.
 * - Fails on any console error or page error not explicitly allowed.
 * - Replaces SpeechRecognition / webkitSpeechRecognition with an inert stand-in.
 * - Provides a worker-scoped local HTTP server for the URL-import recipe page.
 */

import { test as base, expect } from "@playwright/test";
import { closeDb, restoreSeed } from "./db";
import { startRecipeSite, type RecipeSiteHandle } from "./recipe-site";
import { SEED_NOW } from "./seed-data";

const ALLOWED_LOCAL_HOSTS: ReadonlySet<string> = new Set([
  "127.0.0.1",
  "localhost",
]);

const ALLOWED_INTERNAL_PROTOCOLS: ReadonlySet<string> = new Set([
  "about:",
  "blob:",
  "data:",
]);

/**
 * In production builds, ServiceWorkerRegistration.tsx:65-83 calls
 * navigator.serviceWorker.register(...).then((reg) => { if (reg.waiting) ... }).
 * Playwright's `serviceWorkers: "block"` replaces register with an async stub
 * that returns undefined (playwright-core/lib/coreBundle.js:51606-51609), so
 * accessing reg.waiting throws and triggers console.error("Service Worker
 * registration failed:", error) on every page load.
 */
const PLAYWRIGHT_BLOCKED_SW_ERROR = /^Service Worker registration failed:/;

interface WorkerFixtures {
  dbWorker: void;
  recipeSite: RecipeSiteHandle;
}

interface TestFixtures {
  allowedConsoleErrors: RegExp[];
  allowConsoleError: (pattern: RegExp) => void;
  e2eGuards: void;
}

export const test = base.extend<TestFixtures, WorkerFixtures>({
  dbWorker: [
    async ({}, provide) => {
      await provide();
      await closeDb();
    },
    { scope: "worker", auto: true },
  ],

  recipeSite: [
    async ({}, provide) => {
      const site = await startRecipeSite();
      await provide(site);
      await site.close();
    },
    { scope: "worker" },
  ],

  allowedConsoleErrors: async ({}, provide) => {
    await provide([PLAYWRIGHT_BLOCKED_SW_ERROR]);
  },

  allowConsoleError: async ({ allowedConsoleErrors }, provide) => {
    await provide((pattern: RegExp) => {
      allowedConsoleErrors.push(pattern);
    });
  },

  e2eGuards: [
    async ({ page, allowedConsoleErrors }, provide) => {
      await restoreSeed();

      // Replace SpeechRecognition / webkitSpeechRecognition with an inert
      // stand-in so cook mode never captures audio or depends on a microphone.
      await page.addInitScript(() => {
        class InertSpeechRecognition extends EventTarget {
          continuous = false;
          interimResults = false;
          lang = "en-US";
          maxAlternatives = 1;
          onstart: ((this: InertSpeechRecognition, ev: Event) => unknown) | null = null;
          onend: ((this: InertSpeechRecognition, ev: Event) => unknown) | null = null;
          onerror: ((this: InertSpeechRecognition, ev: Event) => unknown) | null = null;
          onresult: ((this: InertSpeechRecognition, ev: Event) => unknown) | null = null;

          start(): void {
            // Inert: never captures audio or emits results or errors.
          }

          stop(): void {
            // Inert no-op.
          }

          abort(): void {
            // Inert no-op.
          }
        }

        const win = window as unknown as Record<string, unknown>;
        win.SpeechRecognition = InertSpeechRecognition;
        win.webkitSpeechRecognition = InertSpeechRecognition;
      });

      // Fix Date.now() and new Date() at SEED_NOW before any navigation.
      // Playwright's setFixedTime keeps performance.now() advancing in real time
      // and via page.clock.fastForward(...) while Date.now() stays frozen.
      await page.clock.setFixedTime(SEED_NOW);

      const blockedRequests: string[] = [];
      await page.route("**/*", async (route) => {
        const rawUrl = route.request().url();
        let parsed: URL;
        try {
          parsed = new URL(rawUrl);
        } catch {
          blockedRequests.push(rawUrl);
          await route.abort("blockedbyclient");
          return;
        }
        if (ALLOWED_INTERNAL_PROTOCOLS.has(parsed.protocol)) {
          await route.continue();
          return;
        }
        if (ALLOWED_LOCAL_HOSTS.has(parsed.hostname)) {
          await route.continue();
          return;
        }
        blockedRequests.push(rawUrl);
        await route.abort("blockedbyclient");
      });

      const consoleErrors: string[] = [];
      const pageErrors: string[] = [];

      const onConsole = (msg: { type: () => string; text: () => string }) => {
        if (msg.type() !== "error") return;
        const text = msg.text();
        if (allowedConsoleErrors.some((pattern) => pattern.test(text))) return;
        consoleErrors.push(text);
      };

      const onPageError = (err: Error) => {
        const text = err.stack ?? err.message;
        if (allowedConsoleErrors.some((pattern) => pattern.test(text))) return;
        pageErrors.push(text);
      };

      page.on("console", onConsole);
      page.on("pageerror", onPageError);

      await provide();

      page.off("console", onConsole);
      page.off("pageerror", onPageError);

      if (blockedRequests.length > 0) {
        throw new Error(
          `Blocked unexpected external request(s):\n${blockedRequests.map((u) => `  - ${u}`).join("\n")}`,
        );
      }

      if (pageErrors.length > 0) {
        throw new Error(
          `Unexpected page error(s):\n${pageErrors.map((e) => `  - ${e}`).join("\n")}`,
        );
      }

      if (consoleErrors.length > 0) {
        throw new Error(
          `Unexpected console error(s):\n${consoleErrors.map((e) => `  - ${e}`).join("\n")}`,
        );
      }
    },
    { auto: true },
  ],
});

export { expect };
