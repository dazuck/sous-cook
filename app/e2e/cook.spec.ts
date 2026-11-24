import { test, expect } from "./fixtures";
import { liveNowLine } from "./cook-helpers";
import { readQueueRowById, readQueueRowByName } from "./db";
import { RECIPE_NAMES } from "./seed-data";

test.describe("Cook mode", () => {
  test("COOK-1: opens Thin White Sauce on the opening screen with its Get out list, then its prep page, steps forward and back, and restores the step on reload", async ({
    page,
  }) => {
    const p1 = await readQueueRowByName(RECIPE_NAMES.thinWhiteSauce);
    expect(p1).not.toBeNull();

    await page.goto("/kitchen");

    // Begin the cook from the home screen's Start button (KitchenHome.tsx)
    await page.locator("[data-start]").click();
    await expect(page).toHaveURL(new RegExp(`/kitchen/queue/${p1!.id}$`));

    // Thin White Sauce has a derived plan with two or more step screens, so it
    // opens on the opening chart with Start (cook-opening.ts; CookOpening.tsx).
    // Its Get out column lists what to bring out before starting (Timetable.tsx).
    const openingStart = page.locator("[data-opening-start]");
    await expect(openingStart).toBeVisible();
    await expect(openingStart).toHaveText("Start");
    const getOut = page.locator("[data-get-out]");
    await expect(getOut).toBeVisible();
    await expect(getOut.locator("[data-get-out-head]")).toContainText("Get out");
    for (const name of ["Butter", "Flour", "Milk"]) {
      await expect(getOut).toContainText(name);
    }
    await openingStart.click();

    // Its one prep job ("mix-flour-seasonings" in the stored plan) is the first
    // screen of the sequence: a prep page, eyebrow "Prep", where a step has its
    // words (CookFlow.tsx PrepEyebrow; cook-view.ts prepPages).
    const nowLine = liveNowLine(page);
    await expect(nowLine).toBeVisible();
    await expect(nowLine.locator("[data-prep-eyebrow]")).toContainText("Prep");
    const prepKey = await nowLine.getAttribute("data-line");
    expect(prepKey).not.toBeNull();
    // The old separate Prep screen is gone.
    await expect(page.locator("[data-prep]")).toHaveCount(0);

    // Next step moves from the prep page to the first cooking step
    const nextButton = page.getByRole("button", { name: "Next step" });
    await nextButton.click();
    await expect(nowLine).not.toHaveAttribute("data-line", prepKey!);
    await expect(nowLine.locator("[data-prep-eyebrow]")).toHaveCount(0);
    const firstStepKey = await nowLine.getAttribute("data-line");
    expect(firstStepKey).not.toBeNull();

    // Next step advances the "now" line to the second step
    await nextButton.click();
    await expect(nowLine).not.toHaveAttribute("data-line", firstStepKey!);
    const secondStepKey = await nowLine.getAttribute("data-line");
    expect(secondStepKey).not.toBeNull();

    // Previous step goes back a screen at a time, to the prep page
    const previousButton = page.getByRole("button", { name: "Previous step" });
    await previousButton.click();
    await expect(nowLine).toHaveAttribute("data-line", firstStepKey!);
    await previousButton.click();
    await expect(nowLine).toHaveAttribute("data-line", prepKey!);
    await expect(nowLine.locator("[data-prep-eyebrow]")).toContainText("Prep");

    // Forward again so we reload on the second step (session saved after progress, cook-session.ts)
    await nextButton.click();
    await expect(nowLine).toHaveAttribute("data-line", firstStepKey!);
    await nextButton.click();
    await expect(nowLine).toHaveAttribute("data-line", secondStepKey!);

    await page.reload();

    // A settled session skips the opening screen and restores the exact step
    // (cook-opening.ts; cook-session.ts)
    await expect(openingStart).toHaveCount(0);
    await expect(liveNowLine(page)).toHaveAttribute("data-line", secondStepKey!);
  });

  test("COOK-4: Boiled Custard's two small prep jobs share one page of tick rows; a tick holds across reload and Next leaves prep", async ({
    page,
  }) => {
    const p2 = await readQueueRowByName(RECIPE_NAMES.boiledCustard);
    expect(p2).not.toBeNull();

    await page.goto(`/kitchen/queue/${p2!.id}`);
    await page.locator("[data-opening-start]").click();

    // Two two-minute jobs in the stored plan (beat the yolks; mix them with the
    // sugar and salt) merge into one prep page of tick rows (PrepRows.tsx).
    const nowLine = liveNowLine(page);
    await expect(nowLine.locator("[data-prep-eyebrow]")).toContainText("Prep");
    const rows = nowLine.locator("[data-prep-rows] > li");
    await expect(rows).toHaveCount(2);
    await expect(rows.nth(0)).not.toHaveAttribute("data-done", "");
    await expect(rows.nth(1)).not.toHaveAttribute("data-done", "");

    // A tap on a row is its tick, never a page turn
    const prepKey = await nowLine.getAttribute("data-line");
    await rows.nth(0).getByRole("checkbox").click();
    await expect(rows.nth(0)).toHaveAttribute("data-done", "");
    await expect(rows.nth(1)).not.toHaveAttribute("data-done", "");
    await expect(nowLine).toHaveAttribute("data-line", prepKey!);

    // The tick is stored with the cook (cook-session.ts) and comes back on reload
    await page.reload();
    await expect(page.locator("[data-opening-start]")).toHaveCount(0);
    const rowsAfter = liveNowLine(page).locator("[data-prep-rows] > li");
    await expect(rowsAfter.nth(0)).toHaveAttribute("data-done", "");
    await expect(rowsAfter.nth(1)).not.toHaveAttribute("data-done", "");

    // Next step leaves the prep page for the first cooking step
    await page.getByRole("button", { name: "Next step" }).click();
    await expect(liveNowLine(page)).not.toHaveAttribute("data-line", prepKey!);
    await expect(liveNowLine(page).locator("[data-prep-rows]")).toHaveCount(0);
  });

  test("COOK-2: starting a timer offer shows a running timer that stays running after reload", async ({
    page,
  }) => {
    // Neither Thin White Sauce (P1) nor Boiled Custard (P2) has any step timer_sec in
    // packs/drafts/fannie-farmer-1896.pack.json. Pantry Tomato Soup (P3) states a 12-minute
    // simmer on step 3, which legacyToPackRecipe converts to timer_sec: 720.
    const p3 = await readQueueRowByName(RECIPE_NAMES.pantryTomatoSoup);
    expect(p3).not.toBeNull();

    await page.goto("/kitchen");

    // Start P3 through the Queue screen (accessible in both landscape and portrait)
    // (app/src/components/kitchen/HomeRail.tsx:158-161; QueueScreen.tsx:101-106)
    await page.getByRole("button", { name: "Up next · 4" }).click();
    await page
      .getByRole("dialog", { name: "Up next" })
      .getByRole("list", { name: "Up next" })
      .getByRole("button", { name: RECIPE_NAMES.pantryTomatoSoup })
      .click();

    await expect(page).toHaveURL(new RegExp(`/kitchen/queue/${p3!.id}$`));
    await expect(liveNowLine(page)).toBeVisible();

    // Bounded walk to the first screen offering a timer
    // (app/src/components/kitchen/TimerLine.tsx:36, 166)
    const offerButton = page.locator('[data-timer="offer"]');
    const maxSteps = 10;
    let foundOffer = false;

    for (let step = 0; step < maxSteps; step++) {
      if (await offerButton.isVisible()) {
        foundOffer = true;
        break;
      }
      const advance = page.getByRole("button", {
        name: /^(Next step|The rest of this step|Looks right)$/,
      });
      if ((await advance.count()) === 0) break;
      await advance.click();
    }

    expect(
      foundOffer,
      "Expected a timer offer within 10 steps on Pantry Tomato Soup",
    ).toBe(true);
    await expect(offerButton).toContainText("Start 12 min timer");

    // Start the timer and confirm a running timer appears on the live step line
    // (app/src/components/kitchen/TimerLine.tsx:216; scoped to liveNowLine so a
    // hidden copy inside a cross-fading ghost cannot match)
    await offerButton.click();
    const runningTimer = liveNowLine(page).locator('[data-timer="running"]');
    await expect(runningTimer).toBeVisible();
    await expect(runningTimer).toHaveAttribute("role", "timer");

    // Reload and verify the timer persists in localStorage and stays running
    await page.reload();
    await expect(runningTimer).toBeVisible();
  });

  test("COOK-3: walking to the last screen and pressing Done cooking finishes Thin White Sauce and updates home and Made recently", async ({
    page,
  }) => {
    const p1 = await readQueueRowByName(RECIPE_NAMES.thinWhiteSauce);
    expect(p1).not.toBeNull();

    await page.goto("/kitchen");
    await page.locator("[data-start]").click();
    await expect(page).toHaveURL(new RegExp(`/kitchen/queue/${p1!.id}$`));

    // Enter the cook from the opening screen (CookOpening.tsx:170)
    await page.locator("[data-opening-start]").click();

    // Walk forward until the last screen's "Done cooking" button appears
    // (CookFlow.tsx:1334, 1363; cook-view.ts:98, 100, 105, 116)
    const doneButton = page.getByRole("button", { name: "Done cooking" });
    const maxSteps = 20;

    for (let step = 0; step < maxSteps; step++) {
      if (await doneButton.isVisible()) break;
      const advance = page.getByRole("button", {
        name: /^(Next step|The rest of this step|Looks right)$/,
      });
      await expect(advance).toBeVisible();
      await advance.click();
    }

    await expect(doneButton).toBeVisible();

    // useFinishArm (app/src/hooks/useFinishArm.ts:7, 14-20) ignores clicks for 500 ms
    // via performance.now(). Under page.clock.setFixedTime, fastForward advances
    // performance.now() immediately while keeping Date.now() fixed at SEED_NOW.
    await page.clock.fastForward(600);
    await doneButton.click();

    // Finishing returns to /kitchen
    await expect(page).toHaveURL(/\/kitchen$/);

    // Database row is completed with finished_by "pressed"
    const p1After = await readQueueRowById(p1!.id);
    expect(p1After).not.toBeNull();
    expect(p1After!.status).toBe("completed");
    expect(p1After!.finishedBy).toBe("pressed");

    // Thin White Sauce is no longer offered to start on the home screen; Boiled Custard is now on top
    // (app/src/components/kitchen/KitchenHome.tsx:200, 442)
    await expect(
      page.getByRole("heading", { level: 2, name: RECIPE_NAMES.boiledCustard }),
    ).toBeVisible();
    await expect(
      page.getByRole("heading", { level: 2, name: RECIPE_NAMES.thinWhiteSauce }),
    ).toHaveCount(0);

    // Queue screen's Made recently list shows Thin White Sauce first
    // (app/src/components/kitchen/QueueScreen.tsx:122-129)
    await page.getByRole("button", { name: "Up next · 3" }).click();
    const recentItems = page
      .getByRole("dialog", { name: "Up next" })
      .getByRole("list", { name: "Made recently" })
      .getByRole("listitem");
    await expect(recentItems.first()).toContainText(RECIPE_NAMES.thinWhiteSauce);
  });
});
