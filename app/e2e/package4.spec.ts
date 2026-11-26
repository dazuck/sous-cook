import { drizzle } from "drizzle-orm/postgres-js";
import postgres from "postgres";
import * as schema from "../drizzle/schema";
import { addKitchenPack, removeKitchenPack } from "../src/lib/kitchens/packs";
import { PACKS_DIR } from "../src/lib/shelf/load";
import { liveNowLine } from "./cook-helpers";
import { E2E_DATABASE_URL, assertLocalDatabase } from "./env";
import { test, expect } from "./fixtures";
import {
  BUNDLED_PACK_CREATOR,
  BUNDLED_PACK_ID,
  BUNDLED_PACK_TITLE,
} from "./seed-data";

const OWNED_PACK = {
  id: "sunday-suppers",
  title: "Sunday Suppers",
  version: "1.0.0",
  creator: { name: "Chef Carbon" },
  recipes: [
    {
      id: "garlic-white-beans",
      title: "Garlic White Beans",
      serves_base: 4,
      ingredients: [
        {
          id: "i1",
          name: "Cannellini beans",
          qty_canonical: { mass_g: 400 },
          display_equivalents: { metric: { unit: "g", amount: 400 } },
        },
        {
          id: "i2",
          name: "Garlic",
          qty_canonical: {
            count: 3,
            count_unit: { one: "clove", other: "cloves" },
          },
        },
      ],
      steps: [
        {
          id: "s1",
          type: "action",
          text: "Warm the garlic slices gently in olive oil.",
          ingredient_refs: ["i2"],
        },
        {
          id: "s2",
          type: "action",
          text: "Add the beans and simmer for 12 minutes.",
          ingredient_refs: ["i1"],
          timer_sec: 720,
        },
      ],
    },
  ],
};

let pgClient: ReturnType<typeof postgres> | null = null;

function getE2eDb() {
  if (pgClient === null) {
    assertLocalDatabase(E2E_DATABASE_URL);
    pgClient = postgres(E2E_DATABASE_URL, {
      max: 1,
      prepare: false,
      connect_timeout: 10,
      onnotice: () => {},
    });
  }
  return drizzle(pgClient, { schema });
}

test.afterAll(async () => {
  if (pgClient !== null) {
    const active = pgClient;
    pgClient = null;
    await active.end({ timeout: 5 });
  }
});

test.describe("Package 4: Kitchen-owned packs on the shelf and in cook mode", () => {
  test("PKG4-1: owned pack appears beside Fannie Farmer, queues into cook mode, and removing it preserves the queued cook", async ({
    page,
  }) => {
    const e2eDb = getE2eDb();

    await addKitchenPack(
      {
        kitchenSlug: "home",
        rawBytes: JSON.stringify(OWNED_PACK),
        packsDir: PACKS_DIR,
      },
      e2eDb,
    );

    // 1. Owned pack appears on /kitchen/cookpacks beside the bundled book
    await page.goto("/kitchen/cookpacks");
    const creatorBooks = page.locator("[data-creator-book]");
    await expect(creatorBooks).toHaveCount(2);

    await expect(
      page.getByRole("link", {
        name: `${BUNDLED_PACK_TITLE}, ${BUNDLED_PACK_CREATOR}, 5 recipes`,
      }),
    ).toBeVisible();

    const ownedLink = page.getByRole("link", {
      name: "Sunday Suppers, Chef Carbon, 1 recipe",
    });
    await expect(ownedLink).toBeVisible();

    // 2. Open the owned pack and queue its recipe
    await ownedLink.click();
    await expect(page).toHaveURL(/\/kitchen\/cookpacks\/sunday-suppers$/);
    await expect(page.getByRole("heading", { name: "Sunday Suppers" })).toBeVisible();
    await expect(page.locator("[data-title-page]")).toContainText("Chef Carbon");

    const recipeRow = page.locator('[data-pack-row="garlic-white-beans"]');
    await expect(recipeRow).toContainText("Garlic White Beans");
    await recipeRow.click();

    await expect(page).toHaveURL(/\/kitchen\/queue\/([0-9a-f-]+)$/);
    const queueUrl = page.url();

    // Cook mode opens cleanly on step 1 (without a model key, shows as written)
    await expect(liveNowLine(page)).toContainText(
      "Warm the garlic slices gently in olive oil.",
    );
    await expect(page.getByText("No prep plan for this one")).toBeVisible();

    // 3. Remove the owned pack; shelf drops it at once while the queued recipe still cooks
    await removeKitchenPack(
      { pack: "sunday-suppers", kitchenSlug: "home" },
      e2eDb,
    );

    await page.goto("/kitchen/cookpacks");
    await expect(page.locator("[data-creator-book]")).toHaveCount(1);
    await expect(
      page.locator(`[data-creator-book="${BUNDLED_PACK_ID}"]`),
    ).toBeVisible();
    await expect(
      page.locator('[data-creator-book="sunday-suppers"]'),
    ).toHaveCount(0);

    // Re-opening the already-queued recipe still loads and steps cleanly
    await page.goto(queueUrl);
    await expect(liveNowLine(page)).toContainText(
      "Warm the garlic slices gently in olive oil.",
    );
    await page.getByRole("button", { name: "Next step" }).click();
    await expect(liveNowLine(page)).toContainText(
      "Add the beans and simmer for 12 minutes.",
    );
  });
});
