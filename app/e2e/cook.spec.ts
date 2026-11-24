import { test, expect } from "./fixtures";
import { liveNowLine } from "./cook-helpers";
import { readQueueRowById, readQueueRowByName } from "./db";
import { BUNDLED_PACK_ID, RECIPE_NAMES, SEED_NOW } from "./seed-data";

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

  test("COOK-5: on a cooking step the bottom strip draws the cook as work segments, a tap raises the peek on the step in hand, and Put away lowers it", async ({
    page,
  }) => {
    const p1 = await readQueueRowByName(RECIPE_NAMES.thinWhiteSauce);
    expect(p1).not.toBeNull();

    await page.goto(`/kitchen/queue/${p1!.id}`);
    await page.locator("[data-opening-start]").click();
    // Past the prep page to the first cooking step
    await page.getByRole("button", { name: "Next step" }).click();
    const nowLine = liveNowLine(page);
    await expect(nowLine.locator("[data-prep-eyebrow]")).toHaveCount(0);
    const stepKey = await nowLine.getAttribute("data-line");
    expect(stepKey).not.toBeNull();

    // The strip at the foot: the whole cook folded flat, a segment per run of
    // work (CookSheet.tsx; strip-line.ts). The sheet rests at level 0.
    const strip = page.locator("[data-strip]");
    await expect(strip).toBeVisible();
    expect(await strip.locator("[data-strip-seg]").count()).toBeGreaterThan(0);
    // Filled to the end of the step in hand: some of the line already, not all of it.
    const fill = async () =>
      strip.locator("[data-strip-seg] > span").evaluateAll((els) =>
        els.reduce((a, el) => a + Number(/scaleX\(([\d.]+)\)/.exec((el as HTMLElement).style.transform)?.[1] ?? 0), 0),
      );
    await expect.poll(fill).toBeGreaterThan(0);
    const filledAtFirstStep = await fill();
    expect(filledAtFirstStep).toBeLessThan(await strip.locator("[data-strip-seg]").count());
    const sheet = page.locator("[data-cook-sheet]");
    await expect(sheet).toHaveAttribute("data-level", "0");
    await expect(strip).toHaveAttribute("aria-expanded", "false");

    // A tap on the strip raises the peek (level 1): the step in hand first,
    // then the steps up to the next break (cook-peek.ts; PeekRows.tsx)
    await strip.click();
    await expect(sheet).toHaveAttribute("data-level", "1");
    // Settled at the peek, where its arrows take taps (they ignore one made mid-glide).
    await expect(sheet).toHaveAttribute("data-settled", "1");
    await expect(strip).toHaveAttribute("aria-expanded", "true");
    const peek = page.locator("[data-peek]");
    await expect(peek).toBeVisible();
    const inHand = peek.locator('[data-peek-row="step"][data-peek-now]');
    await expect(inHand).toHaveCount(1);
    await expect(inHand).toHaveAttribute("data-peek-key", stepKey!);
    expect(await peek.locator("[data-peek-row]").count()).toBeGreaterThan(1);

    // The ⌄ arrow on the peek's edge puts it away (the strip, also named Put away
    // at the peek, is not the button tapped here); the step in hand has not moved
    await page.locator('[data-sheet-arrow="collapse"]').click();
    await expect(sheet).toHaveAttribute("data-level", "0");
    await expect(peek).toBeHidden();
    await expect(liveNowLine(page)).toHaveAttribute("data-line", stepKey!);

    // On to the next step, the fill moves on with it
    await page.getByRole("button", { name: "Next step" }).click();
    await expect(liveNowLine(page)).not.toHaveAttribute("data-line", stepKey!);
    await expect.poll(fill).toBeGreaterThan(filledAtFirstStep);
  });

  test("COOK-6: the opening and the whole cook draw the meal as lines with its stops, and at the whole cook the step in hand is the stop marked now", async ({
    page,
  }) => {
    const p1 = await readQueueRowByName(RECIPE_NAMES.thinWhiteSauce);
    expect(p1).not.toBeNull();

    await page.goto(`/kitchen/queue/${p1!.id}`);

    // The opening draws the whole meal as lines (Timetable.tsx; MealLines.tsx),
    // in columns or as a list as the room and the dishes allow, a stop per step.
    const opening = page.locator("[data-meal-lines]").first();
    await expect(opening).toBeVisible();
    expect(await opening.locator("[data-line-stop]").count()).toBeGreaterThan(1);

    // Start, then past the prep page to the first cooking step
    await page.locator("[data-opening-start]").click();
    await page.getByRole("button", { name: "Next step" }).click();
    const nowLine = liveNowLine(page);
    await expect(nowLine.locator("[data-prep-eyebrow]")).toHaveCount(0);
    const stepKey = await nowLine.getAttribute("data-line");
    expect(stepKey).not.toBeNull();

    // The strip raises the peek, and its expand arrow opens the whole cook (level 2)
    await page.locator("[data-strip]").click();
    const sheet = page.locator("[data-cook-sheet]");
    await expect(sheet).toHaveAttribute("data-level", "1");
    // Settled at the peek first: its arrows ignore a tap made mid-glide (as in COOK-5).
    await expect(sheet).toHaveAttribute("data-settled", "1");
    await page.getByRole("button", { name: "Show the whole cook" }).click();
    await expect(sheet).toHaveAttribute("data-level", "2");

    // The whole cook's lines mark the step in hand as the one stop "now"
    const lines = page.locator("[data-meal-lines]").first();
    await expect(lines).toBeVisible();
    const now = lines.locator('[data-line-stop][data-stop-state="now"]');
    await expect(now).toHaveCount(1);
    await expect(now).toHaveAttribute("data-line-stop", stepKey!);

    // Esc leaves the whole cook for the step, which has not moved
    await page.keyboard.press("Escape");
    await expect(sheet).toHaveAttribute("data-level", "0");
    await expect(liveNowLine(page)).toHaveAttribute("data-line", stepKey!);
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
    // (app/src/components/kitchen/HomeRail.tsx:194-195; QueueScreen.tsx:101-106)
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

  test("COOK-7: on a step with a timer the progress line holds one length: before the timer starts, as it runs and loses a digit, at the whole cook and back, and past its end; a step with none keeps the whole line", async ({
    page,
  }) => {
    // Pantry Tomato Soup (P3) cooks as written: step 1 has no timer, step 3 offers its 12-minute
    // simmer (as in COOK-2). The well beside the line keeps the room its clocks take from the
    // start of a step with a timer (well-room.ts), so the line never jumps when the clock starts,
    // walks into the well at the whole cook, or runs out.
    const p3 = await readQueueRowByName(RECIPE_NAMES.pantryTomatoSoup);
    expect(p3).not.toBeNull();
    await page.goto(`/kitchen/queue/${p3!.id}`);
    const sheet = page.locator("[data-cook-sheet]");
    const strip = page.locator("[data-strip]");
    const lineBox = async () => {
      const b = (await strip.boundingBox())!;
      return { x: Math.round(b.x * 10) / 10, w: Math.round(b.width * 10) / 10 };
    };
    const fills = () =>
      strip.locator("[data-strip-seg] > span").evaluateAll((els) =>
        els.map((el) => Number(/scaleX\(([\d.]+)\)/.exec((el as HTMLElement).style.transform)?.[1] ?? 0).toFixed(3)).join(" "),
      );
    const wellClock = page.locator("[data-foot] [data-ledge]:not([data-well-room] [data-ledge])");
    /** Every glide on the cook screen done: a step's change, a clock's flight, the sheet's move. */
    const still = () =>
      page.waitForFunction(() =>
        document
          .querySelector("[data-stage]")!
          .parentElement!.getAnimations({ subtree: true })
          .every((a) => a.playState !== "running" || a.effect?.getTiming().iterations === Infinity),
      );

    // Step 1: no timer and no clock anywhere, so no room is held: the whole line.
    await expect(liveNowLine(page)).toBeVisible();
    await expect(sheet).toHaveAttribute("data-settled", "0");
    await still();
    await expect(page.locator("[data-well-room]")).toHaveCount(0);
    const whole = await lineBox();

    // Step 3, its timer offered and not started: the room is held already.
    const next = page.getByRole("button", { name: "Next step" });
    await next.click();
    await next.click();
    const offer = liveNowLine(page).locator('[data-timer="offer"]');
    await expect(offer).toContainText("Start 12 min timer");
    await expect(page.locator("[data-well-room]")).toHaveCount(1);
    await still();
    const held = await lineBox();
    expect(held.w, "shorter than the whole line by the well's held room").toBeLessThan(whole.w - 50);

    // Started where it stands.
    await offer.click();
    const running = liveNowLine(page).locator('[data-timer="running"]');
    await expect(running).toBeVisible();
    await still();
    expect(await lineBox(), "the timer started").toEqual(held);

    // 12:00 down past 10:00: the clock loses a digit, the line does not move.
    await page.clock.setFixedTime(SEED_NOW.getTime() + 2 * 60_000 + 1_000);
    await expect(running).toHaveAttribute("aria-label", /9:5\d left$/);
    expect(await lineBox(), "a digit fewer").toEqual(held);
    const fill = await fills();

    // At the whole cook the step's clock walks into the well, seen: the line keeps its length and its fill.
    await strip.click();
    await expect(sheet).toHaveAttribute("data-level", "1");
    await expect(sheet).toHaveAttribute("data-settled", "1");
    await page.getByRole("button", { name: "Show the whole cook" }).click();
    await expect(sheet).toHaveAttribute("data-level", "2");
    await expect(sheet).toHaveAttribute("data-settled", "2");
    await expect(wellClock).toBeVisible();
    await still();
    expect(await lineBox(), "at the whole cook, the clock in the well").toEqual(held);
    expect(await fills(), "the fill keeps its minute").toBe(fill);

    // Back on the step.
    await page.keyboard.press("Escape");
    await expect(sheet).toHaveAttribute("data-level", "0");
    await expect(sheet).toHaveAttribute("data-settled", "0");
    await expect(wellClock).toHaveCount(0);
    await still();
    expect(await lineBox(), "back on the step").toEqual(held);
    expect(await fills(), "the fill keeps its minute").toBe(fill);

    // Half a second past its end the step's clock rings (the band over the stage), and the line
    // still holds. (The held room is drawn at moment 0, so it never reaches an end here;
    // TimerLedge.test.tsx checks that a still clock past its end is never the alarm.)
    await page.clock.setFixedTime(SEED_NOW.getTime() + 12 * 60_000 + 500);
    await expect(running).toHaveCount(0);
    await expect(page.locator("[data-alarm-band]")).toBeVisible();
    await expect(page.locator("[data-well-room] [data-timer]").first()).toHaveAttribute("data-timer", "still");
    await still();
    expect(await lineBox(), "past the timer's end").toEqual(held);
  });

  test("COOK-8: the opening's Ahead note ends in \"Missed it?\", the whole note is its target, and a tap opens Ask with the question about the make-ahead work", async ({
    page,
  }) => {
    // Doughnuts I is the bundled pack recipe whose stored plan has make-ahead work (soften the
    // butter 30 minutes before). Queued from its pack page, it opens on its opening (as in SHELF-3).
    await page.goto(`/kitchen/cookpacks/${BUNDLED_PACK_ID}`);
    await page.locator('[data-pack-row="doughnuts-i"]').click();
    await expect(page).toHaveURL(/\/kitchen\/queue\/[0-9a-f-]+$/);
    await expect(page.locator("[data-opening-start]")).toBeVisible();

    const note = page.locator("[data-ahead]");
    const words = note.locator("[data-ask-words]");
    const target = note.locator("[data-ask-ahead]");
    await expect(words).toHaveText("Missed it?");
    await expect(target).toHaveAccessibleName("Missed it? Ask Sous");
    const view = page.viewportSize()!;
    const m = await words.evaluate((el) => {
      const noteEl = el.closest<HTMLElement>("[data-ahead]")!;
      const button = noteEl.querySelector<HTMLElement>("[data-ask-ahead]")!;
      const n = noteEl.getBoundingClientRect();
      // A finger anywhere on the note, across its width and down its height, lands on the ask.
      const missed: string[] = [];
      for (const fy of [0.15, 0.5, 0.85]) {
        for (let fx = 0.05; fx < 1; fx += 0.1) {
          const at = document.elementFromPoint(n.left + n.width * fx, n.top + n.height * fy);
          if (at !== button) missed.push(`${fx.toFixed(2)},${fy}: ${at ? at.tagName : "nothing"}`);
        }
      }
      const w = el.getBoundingClientRect();
      return {
        lines: el.getClientRects().length,
        words: { right: w.right, bottom: w.bottom },
        textRight: el.closest("p")!.getBoundingClientRect().right,
        target: button.getBoundingClientRect().height,
        note: n.height,
        missed,
      };
    });
    expect(m.lines, "the words on one line").toBe(1);
    expect(m.words.right, "inside the note's text").toBeLessThanOrEqual(m.textRight + 0.5);
    expect(m.words.right, "on the screen").toBeLessThanOrEqual(view.width);
    expect(m.words.bottom, "on the screen").toBeLessThanOrEqual(view.height);
    expect(m.target, "a target 48 px tall at least").toBeGreaterThanOrEqual(48);
    expect(m.target, "the target is the whole note").toBeGreaterThanOrEqual(m.note - 0.5);
    expect(m.missed, "a finger anywhere on the note reaches the ask").toEqual([]);

    // A finger on the words opens Ask about the recipe, the question in its box, not sent.
    const at = (await words.boundingBox())!;
    await page.mouse.click(at.x + at.width / 2, at.y + at.height / 2);
    const askPanel = page.locator('[data-ask="open"]');
    await expect(askPanel).toBeVisible();
    await expect(askPanel.getByRole("textbox")).toHaveValue(
      "I was meant to soften butter 30 minutes before and didn't. What's the quickest way through?",
    );
  });

});
