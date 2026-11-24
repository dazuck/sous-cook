import { test, expect } from "./fixtures";
import { readQueueRowById, readQueueRowByName, setQueueRowStatus } from "./db";
import { RECIPE_NAMES } from "./seed-data";

test.describe("Kitchen home", () => {
  test("HOME-1: shows Thin White Sauce to start, remaining pending recipes, queue count, no cancelled row, and fits viewport", async ({
    page,
  }, testInfo) => {
    await page.goto("/kitchen");

    // Top pending recipe title (app/src/components/kitchen/KitchenHome.tsx:200, 442)
    await expect(
      page.getByRole("heading", { level: 2, name: RECIPE_NAMES.thinWhiteSauce }),
    ).toBeVisible();

    // Primary Start button for the top recipe (app/src/components/kitchen/KitchenHome.tsx:33, 451)
    await expect(page.locator("[data-start]")).toHaveText("Start");

    // "Then" line lists the remaining pending recipes according to viewport orientation
    // (app/src/lib/kitchen/home-view.ts:26-29; app/src/components/kitchen/KitchenHome.tsx:460-488)
    const thenRow = page.locator("[data-then]");
    await expect(
      thenRow.getByRole("button", { name: RECIPE_NAMES.boiledCustard }),
    ).toBeVisible();

    if (testInfo.project.name === "landscape") {
      // Landscape shows two follow-up titles and "1 more" (KitchenHome.tsx:467-487)
      await expect(
        thenRow.getByRole("button", { name: RECIPE_NAMES.pantryTomatoSoup }),
      ).toBeVisible();
      await expect(thenRow.getByRole("button", { name: "1 more" })).toBeVisible();
    } else {
      // Portrait hides the second follow-up title and shows "2 more" (KitchenHome.tsx:473, 478-481)
      await expect(
        thenRow.getByRole("button", { name: RECIPE_NAMES.pantryTomatoSoup }),
      ).toBeHidden();
      await expect(thenRow.getByRole("button", { name: "2 more" })).toBeVisible();
    }

    // Rail queue button carries pending count wording "Up next · 4"
    // (app/src/components/kitchen/HomeRail.tsx:194-195; app/src/lib/kitchen/home-view.ts:51)
    await expect(
      page.getByRole("button", { name: "Up next · 4" }),
    ).toBeVisible();

    // Cancelled recipe Parker House Rolls appears nowhere on the home screen
    await expect(page.getByText(RECIPE_NAMES.parkerHouseRolls)).toHaveCount(0);

    // Home screen does not scroll vertically in either tablet orientation
    const fitsWithoutScroll = await page.evaluate(
      () => document.documentElement.scrollHeight <= window.innerHeight,
    );
    expect(fitsWithoutScroll).toBe(true);
  });

  test("HOME-2: pressing Start opens P1 cook page, marks it cooking, and returning shows cook under way", async ({
    page,
  }) => {
    const p1Before = await readQueueRowByName(RECIPE_NAMES.thinWhiteSauce);
    expect(p1Before).not.toBeNull();

    await page.goto("/kitchen");

    // Start button on the top recipe (app/src/components/kitchen/KitchenHome.tsx:33, 451)
    await page.locator("[data-start]").click();

    await expect(page).toHaveURL(new RegExp(`/kitchen/queue/${p1Before!.id}$`));

    // Cook opening screen Start control confirms the cook page loaded
    // (app/src/components/kitchen/CookOpening.tsx:170; app/src/lib/kitchen/cook-view.ts:194)
    await expect(page.locator("[data-opening-start]")).toBeVisible();

    const p1Cooking = await readQueueRowById(p1Before!.id);
    expect(p1Cooking).not.toBeNull();
    expect(p1Cooking!.status).toBe("cooking");
    expect(p1Cooking!.startedAt).not.toBeNull();

    // On the opening screen RecipeHeader is inert/invisible (CookScreen.tsx:1086);
    // the cook screen's exit control is More -> Exit cooking
    // (app/src/components/kitchen/CookSheet.tsx:1462; app/src/components/kitchen/HeaderMore.tsx:31, 64, 161, 237-239)
    await page.locator("[data-sheet-more]").getByRole("button", { name: "More" }).click();
    await page.getByRole("link", { name: "Exit cooking" }).click();

    await expect(page).toHaveURL(/\/kitchen$/);

    // Cooking subject card shows "Pick up where you left off" with Thin White Sauce
    // (app/src/components/kitchen/KitchenHome.tsx:31, 375-376, 392)
    const cookingSubject = page.locator("[data-cooking-subject]");
    await expect(cookingSubject).toBeVisible();
    await expect(cookingSubject).toHaveAttribute(
      "aria-label",
      "Pick up where you left off",
    );
    await expect(
      cookingSubject.getByRole("link", { name: RECIPE_NAMES.thinWhiteSauce }),
    ).toBeVisible();

    // With 3 pending recipes still queued alongside 1 cooking, queueFoot chooses
    // "Up next · 3" over "Under way · 1" (app/src/lib/kitchen/home-view.ts:50-55)
    await expect(
      page.getByRole("button", { name: "Up next · 3" }),
    ).toBeVisible();
  });

  test("HOME-3: with all pending rows cancelled, home shows its idle state and links to Cookpacks", async ({
    page,
  }) => {
    await setQueueRowStatus(RECIPE_NAMES.thinWhiteSauce, "cancelled");
    await setQueueRowStatus(RECIPE_NAMES.boiledCustard, "cancelled");
    await setQueueRowStatus(RECIPE_NAMES.pantryTomatoSoup, "cancelled");
    await setQueueRowStatus(RECIPE_NAMES.sesameGreenBeans, "cancelled");

    await page.goto("/kitchen");

    // Idle home state copy and link (app/src/components/kitchen/KitchenHome.tsx:37-39, 495-496, 512-523)
    const idleSubject = page.locator("[data-idle-subject]");
    await expect(idleSubject).toBeVisible();
    await expect(idleSubject).toContainText("Nothing on the stove yet");
    await expect(
      idleSubject.getByRole("heading", { level: 2, name: "Find something for dinner" }),
    ).toBeVisible();

    const exploreLink = page.getByRole("link", {
      name: "Explore Cookpacks & recipes",
    });
    await expect(exploreLink).toBeVisible();
    await exploreLink.click();

    await expect(page).toHaveURL(/\/kitchen\/cookpacks$/);
  });

  test("HOME-4: the names panel stands wholly on the screen, each row level with its rail icon, and its left strip closes it", async ({
    page,
  }, testInfo) => {
    test.skip(testInfo.project.name !== "landscape", "the viewports are set here");
    // Landscape, a shorter landscape, and upright (app/src/components/kitchen/HomeRail.tsx: the pull-out)
    for (const view of [
      { width: 1280, height: 800 },
      { width: 1280, height: 680 },
      { width: 800, height: 1280 },
    ]) {
      const at = `${view.width}x${view.height}`;
      await page.setViewportSize(view);
      await page.goto("/kitchen");
      await expect(page.getByRole("button", { name: "Up next · 4" }), at).toBeVisible();
      await page.locator("[data-rail-pull]").click();
      const tab = page.locator("[data-rail-tab]");
      await expect(tab, at).toBeVisible();
      const { panel, rows, rail, menuRoles } = await page.evaluate(() => {
        const centre = (el: Element) => {
          const r = el.getBoundingClientRect();
          return r.top + r.height / 2;
        };
        const box = document.querySelector("[data-rail-tab]")!.getBoundingClientRect();
        return {
          panel: { top: box.top, bottom: box.bottom, left: box.left, right: box.right },
          rows: [...document.querySelectorAll("[data-rail-tab] [role=menuitem]")].map((el) => ({
            name: (el.textContent ?? "").trim(),
            y: centre(el),
          })),
          rail: [...document.querySelectorAll("[data-home-rail] nav > *")]
            .filter((el) => !el.hasAttribute("data-rail-pull"))
            .map((el) => ({ name: el.getAttribute("aria-label") ?? "", y: centre(el) })),
          menuRoles: [...document.querySelector("[data-rail-tab] [role=menu]")!.children].map((el) =>
            el.getAttribute("role"),
          ),
        };
      });
      expect(panel.top, `${at}: the panel starts on the screen`).toBeGreaterThanOrEqual(0);
      expect(panel.bottom, `${at}: the panel ends on the screen`).toBeLessThanOrEqual(view.height);
      expect(panel.left, `${at}: the panel starts on the screen`).toBeGreaterThanOrEqual(0);
      expect(panel.right, `${at}: the panel ends on the screen`).toBeLessThanOrEqual(view.width);
      expect(rail.map((icon) => icon.name), `${at}: the rail's icons`).toEqual([
        "Cookpacks",
        "Import recipe",
        "Up next · 4",
      ]);
      // Each rail icon's own row (its name, or the start of it: "Import" for "Import recipe") stands level with it.
      for (const icon of rail) {
        const row = rows.find((r) => r.name !== "" && icon.name.startsWith(r.name));
        expect(row, `${at}: a panel row names the rail icon ${icon.name}`).toBeDefined();
        expect(Math.abs(row!.y - icon.y), `${at}: ${icon.name}'s row stands level with its icon`).toBeLessThanOrEqual(1);
      }
      expect(rows[0]?.name, `${at}: Ask Sous sits above the first`).toBe("Ask Sous");
      expect(menuRoles, `${at}: the menu holds only rows`).toEqual(rows.map(() => "menuitem"));
      // With four rows the panel stops short of the More handle, which hides rather than stand as a second chevron.
      const handle = page.locator("[data-rail-pull]");
      await expect(handle, `${at}: the handle hides while the panel is open`).toHaveCSS("opacity", "0");
      await expect(handle, `${at}: and takes no tap`).toHaveCSS("pointer-events", "none");
      // The strip down the panel's left edge is the way out.
      await page.locator("[data-rail-close]").click();
      await expect(tab, at).toHaveCount(0);
      await expect(handle, `${at}: the handle is back once it closes`).toHaveCSS("opacity", "1");
    }
  });
});
