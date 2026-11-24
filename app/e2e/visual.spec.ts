import { test, expect } from "./fixtures";
import { liveNowLine } from "./cook-helpers";
import { readQueueRowByName } from "./db";
import {
  BUNDLED_PACK_CREATOR,
  BUNDLED_PACK_TITLE,
  RECIPE_NAMES,
} from "./seed-data";
import { settle } from "./visual-helpers";

test.skip(
  process.platform !== "darwin",
  "screenshot baselines are taken on macOS with the pinned Chromium",
);

test.describe("Visual baselines", () => {
  test(
    "VIS-1: home screen with seeded queue",
    { tag: "@visual" },
    async ({ page }) => {
      await page.goto("/kitchen");

      // Top pending recipe title and Start action (KitchenHome.tsx:200, 442, 451)
      await expect(
        page.getByRole("heading", { level: 2, name: RECIPE_NAMES.thinWhiteSauce }),
      ).toBeVisible();
      await expect(page.locator("[data-start]")).toBeVisible();
      // Confirm all five home queries settled rather than hitting the slow-load fallback
      await expect(page.locator("[data-home-status]")).toHaveCount(0);

      // Wait for the centerpiece meal illustration to finish loading and decoding
      // before settling layout (KitchenHome.tsx:427-432)
      const mealIllustration = page.locator('[data-home-illustration="meal"] img');
      await expect(mealIllustration).toBeVisible();
      await mealIllustration.evaluate(async (img: HTMLImageElement) => {
        if (!img.complete) {
          await new Promise<void>((resolve, reject) => {
            img.addEventListener("load", () => resolve(), { once: true });
            img.addEventListener(
              "error",
              () => reject(new Error("Meal illustration failed to load")),
              { once: true },
            );
          });
        }
        if (img.naturalWidth === 0) {
          throw new Error("Meal illustration loaded with zero width");
        }
        await img.decode();
      });

      await settle(page);
      await expect(page).toHaveScreenshot("home.png");
    },
  );

  test(
    "VIS-2: Cookpacks library shelf with bundled book",
    { tag: "@visual" },
    async ({ page }) => {
      await page.goto("/kitchen/cookpacks");

      // Bundled 1896 book on the shelf (Shelf.tsx:75-83; copy.ts:17)
      const expectedAccessibleName = `${BUNDLED_PACK_TITLE}, ${BUNDLED_PACK_CREATOR}, 5 recipes`;
      await expect(page.locator("[data-creator-book]")).toHaveCount(1);
      await expect(
        page.getByRole("link", { name: expectedAccessibleName }),
      ).toBeVisible();

      await settle(page);
      await expect(page).toHaveScreenshot("library.png");
    },
  );

  test(
    "VIS-3: Thin White Sauce first cooking step with lowered bottom strip",
    { tag: "@visual" },
    async ({ page }) => {
      const p1 = await readQueueRowByName(RECIPE_NAMES.thinWhiteSauce);
      expect(p1).not.toBeNull();

      await page.goto("/kitchen");

      // Start from home, then Start on the opening screen to reach the prep page
      // (KitchenHome.tsx:451; CookOpening.tsx:170)
      await page.locator("[data-start]").click();
      await expect(page).toHaveURL(new RegExp(`/kitchen/queue/${p1!.id}$`));

      const openingStart = page.locator("[data-opening-start]");
      await expect(openingStart).toBeVisible();
      await openingStart.click();

      const nowLine = liveNowLine(page);
      await expect(nowLine).toBeVisible();
      await expect(nowLine.locator("[data-prep-eyebrow]")).toContainText("Prep");
      const prepKey = await nowLine.getAttribute("data-line");
      expect(prepKey).not.toBeNull();

      // Advance once from the prep page to Thin White Sauce's first cooking step
      await page.getByRole("button", { name: "Next step" }).click();

      await expect(nowLine).toBeVisible();
      await expect(nowLine).not.toHaveAttribute("data-line", prepKey!);
      await expect(nowLine.locator("[data-prep-eyebrow]")).toHaveCount(0);

      // Bottom strip visible with its peek lowered and settled at level 0
      // (CookSheet.tsx:1396, 1542, 1801, 1816)
      const strip = page.locator("[data-strip]");
      const sheet = page.locator("[data-cook-sheet]");
      await expect(strip).toBeVisible();
      await expect(sheet).toHaveAttribute("data-level", "0");
      await expect(sheet).toHaveAttribute("data-settled", "0");
      await expect(strip).toHaveAttribute("aria-expanded", "false");
      await expect(page.locator("[data-peek]")).toBeHidden();

      // Wait for any opening cross-fade ghost (CookSheet.tsx:934-951) and
      // step-advance animations (CookFlow.tsx:761; advance.ts:15-19) to finish
      await expect(
        page.locator('[data-cook-sheet] ~ [aria-hidden="true"][inert]'),
      ).toHaveCount(0);
      await expect(page.locator("body[data-step-advancing]")).toHaveCount(0);

      await settle(page);
      await expect(page).toHaveScreenshot("cook-step.png");
    },
  );
});
