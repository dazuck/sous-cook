import { drizzle } from "drizzle-orm/postgres-js";
import postgres from "postgres";
import * as schema from "../drizzle/schema";
import { addKitchenPack } from "../src/lib/kitchens/packs";
import { PACKS_DIR } from "../src/lib/shelf/load";
import { E2E_DATABASE_URL, assertLocalDatabase } from "./env";
import { test, expect } from "./fixtures";
import { getHomeKitchenId, seedDocRecipeRow } from "./db";

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
      ],
      steps: [
        {
          id: "s1",
          type: "action",
          text: "Simmer the beans gently for 12 minutes.",
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

test.describe("Package 6: Circles, share links, and pack circle sharing in single-kitchen mode", () => {
  test("PKG6-1: single-kitchen mode hides circle dishes, share links, and pack circle sharing switches and refuses circle endpoints", async ({
    page,
  }) => {
    const circleRequests: string[] = [];
    page.on("request", (req) => {
      if (
        req.url().includes("getCircleDishes") ||
        req.url().includes("getCircleOverview") ||
        req.url().includes("getPackCircleShares")
      ) {
        circleRequests.push(req.url());
      }
    });

    await page.goto("/kitchen");
    await expect(page.locator("[data-circle-dishes]")).toHaveCount(0);

    // Household book hides Copy share link in single-kitchen mode
    const homeId = await getHomeKitchenId();
    await seedDocRecipeRow(homeId, {
      docSlug: "house-lentil-soup",
      name: "House Lentil Soup",
      category: "mains",
      categoryTitle: "Mains",
      docPosition: 0,
      ingredients: [{ item: "lentils", amount: "1", unit: "cup" }],
      steps: ["Simmer for 25 minutes."],
      serves: 4,
      rawDocText: "House Lentil Soup\n1 cup lentils\nSimmer for 25 minutes.",
    });

    await page.goto("/kitchen/cookpacks/household-book");
    await expect(
      page.getByRole("button", { name: "House Lentil Soup", exact: true }),
    ).toBeVisible();
    await expect(page.locator("[data-share-link]")).toHaveCount(0);

    // Owned pack hides Share with circle switches in single-kitchen mode
    const e2eDb = getE2eDb();
    await addKitchenPack(
      {
        kitchenSlug: "home",
        rawBytes: JSON.stringify(OWNED_PACK),
        packsDir: PACKS_DIR,
      },
      e2eDb,
    );
    await page.goto("/kitchen/cookpacks/sunday-suppers");
    await expect(page.getByRole("heading", { name: "Sunday Suppers" })).toBeVisible();
    await expect(page.locator("[data-pack-circle-sharing]")).toHaveCount(0);

    expect(circleRequests).toEqual([]);

    // Circle tRPC endpoints refuse or return empty in single-kitchen mode
    const dishesRes = await page.request.get("/api/trpc/getCircleDishes");
    expect(dishesRes.status()).toBe(200);
    const dishesJson = (await dishesRes.json()) as {
      result?: { data?: unknown };
    };
    expect(dishesJson.result?.data).toEqual([]);

    const packSharesRes = await page.request.get(
      `/api/trpc/getPackCircleShares?input=${encodeURIComponent(
        JSON.stringify({ packId: "sunday-suppers" }),
      )}`,
    );
    expect(packSharesRes.status()).toBe(403);
  });

  test("PKG6-2: circle dish and shared recipe routes show plain Not available in single-kitchen mode without leaking", async ({
    page,
    allowConsoleError,
  }) => {
    allowConsoleError(/Failed to load resource: the server responded with a status of 404/);

    await page.goto("/kitchen/circle");
    await expect(page.locator("[data-not-available]")).toHaveText("Not available");
    await expect(page.getByRole("link", { name: "Back to the kitchen" })).toBeVisible();

    await page.goto("/kitchen/circle/dish/00000000-0000-4000-8000-000000000001");
    await expect(page.locator("[data-not-available]")).toHaveText("Not available");
    await expect(page.getByRole("link", { name: "Back to the kitchen" })).toBeVisible();

    await page.goto("/kitchen/circle/dish/not-a-uuid");
    await expect(page.locator("[data-not-available]")).toHaveText("Not available");

    await page.goto("/kitchen/shared/00000000-0000-4000-8000-000000000001");
    await expect(page.locator("[data-not-available]")).toHaveText("Not available");
    await expect(page.getByRole("link", { name: "Back to the kitchen" })).toBeVisible();

    await page.goto("/kitchen/shared/not-a-uuid");
    await expect(page.locator("[data-not-available]")).toHaveText("Not available");
  });
});
