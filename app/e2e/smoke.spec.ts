import {
  test,
  expect,
  type Page,
  type Request,
  type Response,
} from "@playwright/test";

const FULL_COMMIT_RE = /^[0-9a-f]{40}$/;
const READ_ONLY_METHODS: ReadonlySet<string> = new Set(["GET", "HEAD"]);

type ExpectedSignInMode = "on" | "off";

function readExpectedSignInMode(): ExpectedSignInMode {
  const raw = process.env.SMOKE_EXPECT_SIGN_IN;
  if (raw === "on" || raw === "off") {
    return raw;
  }
  const detail = raw === undefined ? "unset" : JSON.stringify(raw);
  throw new Error(
    `SMOKE_EXPECT_SIGN_IN is required and must be "on" or "off" (got ${detail}).`,
  );
}

const expectedSignIn = readExpectedSignInMode();

/**
 * Playwright's `serviceWorkers: "block"` stubs navigator.serviceWorker.register
 * to resolve to undefined, so ServiceWorkerRegistration.tsx logs this error on
 * every page load in production builds.
 */
const PLAYWRIGHT_BLOCKED_SW_ERROR = /^Service Worker registration failed:/;

interface SmokeGuards {
  assertClean: () => void;
  detach: () => void;
}

function attachSmokeGuards(page: Page): SmokeGuards {
  const nonReadOnlyRequests: string[] = [];
  const serverErrors: string[] = [];
  const consoleErrors: string[] = [];
  const pageErrors: string[] = [];

  const onRequest = (req: Request) => {
    const method = req.method().toUpperCase();
    if (!READ_ONLY_METHODS.has(method)) {
      nonReadOnlyRequests.push(`${method} ${req.url()}`);
    }
  };

  const onResponse = (res: Response) => {
    if (res.status() >= 500) {
      serverErrors.push(`${res.status()} ${res.url()}`);
    }
  };

  const onConsole = (msg: { type: () => string; text: () => string }) => {
    if (msg.type() !== "error") return;
    const text = msg.text();
    if (PLAYWRIGHT_BLOCKED_SW_ERROR.test(text)) return;
    consoleErrors.push(text);
  };

  const onPageError = (err: Error) => {
    const text = err.stack ?? err.message;
    if (PLAYWRIGHT_BLOCKED_SW_ERROR.test(text)) return;
    pageErrors.push(text);
  };

  page.on("request", onRequest);
  page.on("response", onResponse);
  page.on("console", onConsole);
  page.on("pageerror", onPageError);

  return {
    detach() {
      page.off("request", onRequest);
      page.off("response", onResponse);
      page.off("console", onConsole);
      page.off("pageerror", onPageError);
    },
    assertClean() {
      expect(
        nonReadOnlyRequests,
        `Smoke check must be read-only, but saw non-GET/HEAD request(s):\n${nonReadOnlyRequests.join("\n")}`,
      ).toEqual([]);
      expect(
        serverErrors,
        `Unexpected 5xx response(s):\n${serverErrors.join("\n")}`,
      ).toEqual([]);
      expect(
        pageErrors,
        `Unexpected page error(s):\n${pageErrors.join("\n")}`,
      ).toEqual([]);
      expect(
        consoleErrors,
        `Unexpected console error(s):\n${consoleErrors.join("\n")}`,
      ).toEqual([]);
    },
  };
}

test.describe("Deployed copy smoke check", () => {
  test("SMOKE-1: GET /api/version answers 200 and matches SMOKE_EXPECT_COMMIT when set", async ({
    request,
  }) => {
    const expectedCommit = process.env.SMOKE_EXPECT_COMMIT;
    if (expectedCommit !== undefined) {
      expect(
        FULL_COMMIT_RE.test(expectedCommit),
        `SMOKE_EXPECT_COMMIT must be a 40-character lowercase hexadecimal commit SHA (got ${JSON.stringify(expectedCommit)})`,
      ).toBe(true);
    }

    const response = await request.get("/api/version");
    expect(response.status()).toBe(200);

    const body: unknown = await response.json();
    expect(body).not.toBeNull();
    expect(typeof body).toBe("object");
    expect(Array.isArray(body)).toBe(false);

    const record = body as Record<string, unknown>;
    expect(Object.keys(record)).toEqual(["commit"]);

    const { commit } = record;
    if (commit !== null) {
      expect(typeof commit).toBe("string");
      expect(commit).toMatch(FULL_COMMIT_RE);
    }

    if (expectedCommit !== undefined) {
      expect(commit).toBe(expectedCommit);
    }
  });

  if (expectedSignIn === "off") {
    test("SMOKE-2: /kitchen loads cleanly in single-kitchen mode without redirecting, 5xx responses, console errors, or write requests", async ({
      page,
      baseURL,
    }) => {
      expect(baseURL, "SMOKE_BASE_URL must be configured").toBeTruthy();
      const expectedOrigin = new URL(baseURL!).origin;
      const guards = attachSmokeGuards(page);
      try {
        const response = await page.goto("/kitchen");
        expect(
          response,
          "Expected a navigation response for /kitchen",
        ).not.toBeNull();
        expect(response!.status()).toBeLessThan(400);
        expect(
          response!.request().redirectedFrom(),
          'Expected /kitchen not to redirect in single-kitchen mode (SMOKE_EXPECT_SIGN_IN="off")',
        ).toBeNull();

        const finalUrl = new URL(page.url());
        expect(
          finalUrl.origin,
          `Expected /kitchen to stay on origin ${expectedOrigin}, but landed on ${finalUrl.origin}`,
        ).toBe(expectedOrigin);
        expect(
          finalUrl.pathname,
          `Expected /kitchen not to redirect in single-kitchen mode (SMOKE_EXPECT_SIGN_IN="off"), but landed on ${finalUrl.pathname}`,
        ).toBe("/kitchen");

        // KitchenHome renders a level-1 landmark heading ("Kitchen") and, once
        // the read-only tRPC queries settle, a visible level-2 subject heading.
        await expect(
          page.getByRole("heading", { level: 1, name: "Kitchen" }),
        ).toBeAttached();
        await expect(
          page
            .locator("[data-subject]")
            .getByRole("heading", { level: 2 })
            .first(),
        ).toBeVisible();

        guards.assertClean();
      } finally {
        guards.detach();
      }
    });

    test("SMOKE-3: /kitchen/cookpacks shows at least one book and opens its page without write requests", async ({
      page,
    }) => {
      const guards = attachSmokeGuards(page);
      try {
        const response = await page.goto("/kitchen/cookpacks");
        expect(
          response,
          "Expected a navigation response for /kitchen/cookpacks",
        ).not.toBeNull();
        expect(response!.status()).toBeLessThan(400);

        await expect(
          page.getByRole("heading", { level: 1, name: "Cookpacks" }),
        ).toBeVisible();

        const bookLinks = page.locator(
          '[data-shelf] a[href^="/kitchen/cookpacks/"]',
        );
        await expect(bookLinks.first()).toBeVisible();
        expect(await bookLinks.count()).toBeGreaterThanOrEqual(1);

        await bookLinks.first().click();

        await expect(page).toHaveURL(/\/kitchen\/cookpacks\/.+/);
        await expect(page.locator("[data-pack-view]")).toBeVisible();
        await expect(
          page
            .locator("[data-running-head]")
            .getByRole("heading", { level: 2 }),
        ).toBeVisible();

        guards.assertClean();
      } finally {
        guards.detach();
      }
    });
  } else {
    test("SMOKE-2: /kitchen redirects to /sign-in cleanly and GET /api/auth/get-session answers 200 null without 5xx responses, console errors, or write requests", async ({
      page,
      request,
      baseURL,
    }) => {
      expect(baseURL, "SMOKE_BASE_URL must be configured").toBeTruthy();
      const expectedOrigin = new URL(baseURL!).origin;
      const guards = attachSmokeGuards(page);
      try {
        const response = await page.goto("/kitchen");
        expect(
          response,
          "Expected a navigation response for /kitchen",
        ).not.toBeNull();
        expect(response!.status()).toBeLessThan(400);

        const finalUrl = new URL(page.url());
        expect(
          finalUrl.origin,
          `Expected /kitchen to stay on origin ${expectedOrigin}, but landed on ${finalUrl.origin}`,
        ).toBe(expectedOrigin);
        expect(
          finalUrl.pathname,
          `Expected /kitchen to redirect to /sign-in in sign-in mode (SMOKE_EXPECT_SIGN_IN="on"), but landed on ${finalUrl.pathname}`,
        ).toBe("/sign-in");

        await expect(page.getByRole("heading", { level: 1 })).toBeVisible();
        const signInButton = page.getByRole("button", {
          name: "Sign in with Google",
        });
        await expect(signInButton).toBeVisible();
        await expect(signInButton).toBeEnabled();

        const sessionResponse = await request.get("/api/auth/get-session");
        expect(
          sessionResponse.status(),
          `Expected GET /api/auth/get-session to answer 200 in sign-in mode, got ${sessionResponse.status()}`,
        ).toBe(200);
        const sessionBody: unknown = await sessionResponse.json();
        expect(sessionBody).toBeNull();

        guards.assertClean();
      } finally {
        guards.detach();
      }
    });

    test("SMOKE-3: /kitchen/cookpacks is skipped in sign-in mode (kitchen pages require a session)", () => {
      test.skip(true, "Kitchen pages require a session in sign-in mode.");
    });
  }
});
