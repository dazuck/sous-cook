import { test, expect } from "./fixtures";
import { liveNowLine } from "./cook-helpers";
import {
  countQueueRows,
  getHomeKitchenId,
  readQueueRowById,
  readQueueRowByName,
} from "./db";
import {
  PANTRY_TOMATO_SOUP_RECIPE,
  QUICK_CUCUMBER_SALAD_TEXT,
  RECIPE_NAMES,
  SESAME_GREEN_BEANS_RECIPE,
} from "./seed-data";

test.describe("Behaviour without a model key", () => {
  test("NOKEY-1: Pantry Tomato Soup opens as written with no opening, shows pending then failed note, and records a plan error", async ({
    page,
  }) => {
    const p3 = await readQueueRowByName(RECIPE_NAMES.pantryTomatoSoup);
    expect(p3).not.toBeNull();

    // Pause the real ensureCookPlan request briefly so we deterministically observe
    // COOK_COPY.pending before the local server responds with the missing-key failure.
    let releaseEnsure: (() => void) | null = null;
    const ensureRequested = new Promise<void>((resolve) => {
      releaseEnsure = resolve;
    });
    let continueRoute: (() => Promise<void>) | null = null;

    await page.route("**/api/trpc/**", async (route) => {
      const parsed = new URL(route.request().url());
      if (parsed.pathname.includes("ensureCookPlan")) {
        continueRoute = () => route.fallback();
        releaseEnsure?.();
        return;
      }
      await route.fallback();
    });

    await page.goto(`/kitchen/queue/${p3!.id}`);

    // No opening screen for an as-written recipe (cook-opening.ts:28)
    await expect(page.locator("[data-opening-start]")).toHaveCount(0);

    // First step of the recipe as written (CookFlow.tsx:1741-1742)
    await expect(liveNowLine(page)).toContainText(
      PANTRY_TOMATO_SOUP_RECIPE.steps![0]!,
    );

    // Wait until ensureCookPlan is in flight, then assert COOK_COPY.pending
    // (app/src/lib/kitchen/cook-view.ts:85; CookFlow.tsx:1671)
    await ensureRequested;
    await expect(page.getByText("Working out the prep…")).toBeVisible();

    // Let the real server handle ensureCookPlan without a model key
    await continueRoute!();

    // After the server responds with no plan, COOK_COPY.failed replaces the pending note
    // (app/src/lib/kitchen/cook-view.ts:86; CookFlow.tsx:1671)
    await expect(page.getByText("No prep plan for this one")).toBeVisible();

    // Database row has no cook plan and a non-empty plan error
    await expect
      .poll(async () => (await readQueueRowById(p3!.id))?.cookPlanError)
      .toBeTruthy();
    const p3After = await readQueueRowById(p3!.id);
    expect(p3After!.hasCookPlan).toBe(false);
    expect(p3After!.cookPlanError).toBeTruthy();
  });

  test("NOKEY-2: Sesame Green Beans with settled error shows as-written no-plan note, requests ensureCookPlan, and leaves plan error unchanged", async ({
    page,
  }) => {
    const p4Before = await readQueueRowByName(RECIPE_NAMES.sesameGreenBeans);
    expect(p4Before).not.toBeNull();
    expect(p4Before!.cookPlanError).toBeTruthy();

    const ensureCalls: string[] = [];
    const onRequest = (req: { url: () => string }) => {
      const parsed = new URL(req.url());
      if (parsed.pathname.startsWith("/api/trpc/") && parsed.pathname.includes("ensureCookPlan")) {
        ensureCalls.push(parsed.pathname);
      }
    };
    page.on("request", onRequest);

    await page.goto(`/kitchen/queue/${p4Before!.id}`);

    // Recipe shows as written on its first step with no opening screen
    await expect(page.locator("[data-opening-start]")).toHaveCount(0);
    await expect(liveNowLine(page)).toContainText(
      SESAME_GREEN_BEANS_RECIPE.steps![0]!,
    );

    // Shows the no-plan note (app/src/lib/kitchen/cook-view.ts:86; CookFlow.tsx:1671)
    await expect(page.getByText("No prep plan for this one")).toBeVisible();

    // Because CookSessionView only receives storedPlan (not cookPlanError),
    // the page sends one ensureCookPlan request and the server returns the
    // settled error immediately with no model call (page.tsx:431-453; kitchen-queue.ts:512-522, 598-599).
    await expect.poll(() => ensureCalls.length).toBe(1);
    page.off("request", onRequest);

    const p4After = await readQueueRowById(p4Before!.id);
    expect(p4After!.hasCookPlan).toBe(false);
    expect(p4After!.cookPlanError).toBe(p4Before!.cookPlanError);
  });

  test("NOKEY-3: pasting recipe text without a model key shows the server's missing-key error and adds no queue row", async ({
    page,
    allowConsoleError,
  }) => {
    // tRPC returns HTTP 500 when importRecipeFromText fails without a model key
    allowConsoleError(/Failed to load resource: the server responded with a status of 500/);

    const countBefore = await countQueueRows();

    await page.goto("/kitchen");

    // Open import modal from the home rail (app/src/components/kitchen/HomeRail.tsx:185-186)
    await page.getByRole("button", { name: "Import recipe" }).click();

    // Import modal dialog (app/src/components/kitchen/RecipeImportModal.tsx:529; BorrowedChrome.tsx:244-246)
    const dialog = page.getByRole("dialog", { name: "Import recipe" });
    await expect(dialog).toBeVisible();

    // Switch to Paste tab (app/src/components/kitchen/RecipeImportModal.tsx:553)
    await dialog.getByRole("button", { name: "Paste" }).click();

    // Paste invented Quick Cucumber Salad text and submit
    // (app/src/components/kitchen/RecipeImportModal.tsx:614-641)
    await dialog.getByRole("textbox").fill(QUICK_CUCUMBER_SALAD_TEXT);
    await dialog.getByRole("button", { name: "Extract recipe" }).click();

    // Server error from app/src/lib/ai/config.ts:74 displayed in the modal (RecipeImportModal.tsx:423, 574-576)
    await expect(
      dialog.getByText("GOOGLE_AI_API_KEY required when using google provider"),
    ).toBeVisible();

    // No queue row was added
    expect(await countQueueRows()).toBe(countBefore);
    expect(await readQueueRowByName(RECIPE_NAMES.quickCucumberSalad)).toBeNull();
  });

  test("NOKEY-4: importing Weeknight Pea Soup from local JSON-LD URL works without a model key and adds a pending row", async ({
    page,
    recipeSite,
  }) => {
    await page.goto("/kitchen");

    // Open import modal from the home rail (app/src/components/kitchen/HomeRail.tsx:185-186)
    await page.getByRole("button", { name: "Import recipe" }).click();
    const dialog = page.getByRole("dialog", { name: "Import recipe" });
    await expect(dialog).toBeVisible();

    // URL tab is default; enter the local 127.0.0.1 recipe page URL and submit
    // (app/src/components/kitchen/RecipeImportModal.tsx:544, 586-603)
    await dialog.getByRole("textbox").fill(recipeSite.peaSoupUrl);
    await dialog.getByRole("button", { name: "Import recipe" }).click();

    // Preview shows the extracted recipe without a model key (RecipeImportModal.tsx:189, 267)
    await expect(
      dialog.getByRole("heading", { level: 3, name: RECIPE_NAMES.weeknightPeaSoup }),
    ).toBeVisible();

    // Add to queue closes the modal and inserts a pending row in the home kitchen
    await dialog.getByRole("button", { name: "Add to queue" }).click();
    await expect(dialog).toBeHidden();

    const homeKitchenId = await getHomeKitchenId();
    const row = await readQueueRowByName(RECIPE_NAMES.weeknightPeaSoup);
    expect(row).not.toBeNull();
    expect(row!.kitchenId).toBe(homeKitchenId);
    expect(row!.status).toBe("pending");
  });

  test("NOKEY-5: Ask Sous opens from the capsule on a prep page, sends the prep jobs in hand with no step, and shows its unreachable error when no model key is configured", async ({
    page,
    allowConsoleError,
  }) => {
    // tRPC chat fails with HTTP 500 when no model key is configured, and AskSous.tsx logs "Chat error:"
    allowConsoleError(/Failed to load resource: the server responded with a status of 500/);
    allowConsoleError(/^Chat error:/);

    const p1 = await readQueueRowByName(RECIPE_NAMES.thinWhiteSauce);
    expect(p1).not.toBeNull();

    await page.goto(`/kitchen/queue/${p1!.id}`);

    // Start the cook: its first screen is the prep page
    await page.locator("[data-opening-start]").click();
    await expect(liveNowLine(page).locator("[data-prep-eyebrow]")).toContainText("Prep");

    // Open Ask Sous from the capsule at the top line's right end (AskCapsule.tsx).
    // On the landscape tablet it is a panel beside the step; upright, a full sheet
    // (useAskForm.ts). While it is open the capsule stands down.
    const capsule = page.locator("[data-ask-capsule]");
    await capsule.getByRole("button", { name: "Ask Sous" }).click();
    const askPanel = page.locator('[data-ask="open"]');
    await expect(askPanel).toBeVisible();
    const viewport = page.viewportSize()!;
    await expect(askPanel).toHaveAttribute(
      "data-ask-form",
      viewport.width > viewport.height ? "side" : "sheet",
    );
    await expect(capsule).toHaveCount(0);

    // Type a short question and send (Chat.tsx). From a prep page the question
    // carries the jobs in hand and no cooking step (cook-view.ts askInHand).
    const sent = page.waitForRequest((req) => req.url().includes("chatCooking"));
    await askPanel.getByRole("textbox").fill("How fine should the flour be?");
    await askPanel.getByRole("button", { name: "Send" }).click();
    // One batched call, no transformer (providers.tsx): the body is { "0": input }
    const body = (await sent).postDataJSON() as Record<string, Record<string, unknown>>;
    const input = body["0"]!;
    expect(input.currentStepIndex).toBeUndefined();
    const prep = input.prep as { jobs: { text: string; amounts: string[]; done: boolean }[] };
    expect(prep.jobs).toHaveLength(1);
    expect(prep.jobs[0]!.done).toBe(false);
    expect(prep.jobs[0]!.text.length).toBeGreaterThan(0);

    // AskSous shows ASK_COPY.error in a Sous reply bubble
    await expect(askPanel.locator('[data-from="sous"]').last()).toContainText(
      "Couldn't reach Sous. Check the connection and ask again.",
    );
  });
});
