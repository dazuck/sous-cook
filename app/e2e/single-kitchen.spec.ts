import { test, expect } from "./fixtures";

const SIGN_IN_OR_OUT_PATTERN = /\b(sign|log)\s*(in|out)\b/i;

test.describe("Single-kitchen mode", () => {
  test("SINGLE-1: root redirects to /kitchen, auth session endpoint answers 404, and no sign-in or sign-out controls appear", async ({
    page,
  }) => {
    // Next.js redirects "/" to "/kitchen" (app/next.config.ts:37)
    await page.goto("/");
    await expect(page).toHaveURL(/\/kitchen$/);

    // Better Auth route returns 404 when SOUS_SIGN_IN=off
    // (app/src/app/api/auth/[...all]/route.ts:39-41)
    const sessionResponse = await page.request.get("/api/auth/get-session");
    expect(sessionResponse.status()).toBe(404);

    // Wait for home content to settle (KitchenHome.tsx:451)
    await expect(page.locator("[data-start]")).toBeVisible();

    // No button or link on /kitchen is named like signing in or out
    await expect(
      page.getByRole("button", { name: SIGN_IN_OR_OUT_PATTERN }),
    ).toHaveCount(0);
    await expect(
      page.getByRole("link", { name: SIGN_IN_OR_OUT_PATTERN }),
    ).toHaveCount(0);

    // Navigate to /kitchen/cookpacks and check the same
    // (app/src/components/kitchen/HomeRail.tsx:145-152; Shelf.tsx:77)
    await page.getByRole("link", { name: "Cookpacks" }).click();
    await expect(page).toHaveURL(/\/kitchen\/cookpacks$/);
    await expect(page.locator("[data-creator-book]")).toHaveCount(1);

    await expect(
      page.getByRole("button", { name: SIGN_IN_OR_OUT_PATTERN }),
    ).toHaveCount(0);
    await expect(
      page.getByRole("link", { name: SIGN_IN_OR_OUT_PATTERN }),
    ).toHaveCount(0);
  });
});
