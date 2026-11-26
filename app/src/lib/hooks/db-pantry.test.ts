import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { PGlite } from "@electric-sql/pglite";

vi.mock("@/lib/db", async () =>
  (await import("../__tests__/test-db")).mockDbModule(),
);

import * as dbModule from "@/lib/db";
import {
  db,
  kitchenPantryItems,
  kitchenPantrySections,
} from "@/lib/db";
import { seedKitchen, type KitchenRow } from "@/lib/__tests__/kitchens";
import {
  createDbPantryStore,
  DEFAULT_PANTRY_HEADINGS,
} from "./db-pantry";

const client = (dbModule as unknown as { client: PGlite }).client;

let kitchenA: KitchenRow;
let kitchenB: KitchenRow;

beforeEach(async () => {
  await client.exec(
    "delete from kitchen_pantry_items; delete from kitchen_pantry_sections; delete from invites; delete from members; delete from auth_session; delete from auth_account; delete from auth_verification; delete from auth_user;",
  );
  await client.exec("delete from kitchens where slug <> 'home'");

  kitchenA = (await seedKitchen(db, { slug: "kitchen-a", name: "Kitchen A" })).kitchen;
  kitchenB = (await seedKitchen(db, { slug: "kitchen-b", name: "Kitchen B" })).kitchen;
});

afterEach(() => {
  vi.restoreAllMocks();
});

describe("db-pantry", () => {
  it("returns [] for an empty pantry and initializes the five default headings on first addItems", async () => {
    const storeA = createDbPantryStore(kitchenA.id);
    const storeB = createDbPantryStore(kitchenB.id);

    expect(await storeA.readSections()).toEqual([]);
    expect(await storeA.addItems([])).toEqual({ added: 0 });
    expect(await storeA.readSections()).toEqual([]);

    const added = await storeA.addItems([
      { text: "  2 avocados  ", section: "Fridge" },
      { text: "frozen peas", section: "Freezer" },
      { text: "   " },
      { text: "cumin", section: "Spice Rack" },
    ]);
    expect(added).toEqual({ added: 3 });

    const sectionsA = await storeA.readSections();
    expect(sectionsA.map((s) => s.rawHeading)).toEqual([...DEFAULT_PANTRY_HEADINGS]);
    expect(sectionsA.map((s) => s.heading)).toEqual(
      DEFAULT_PANTRY_HEADINGS.map((h) => h.toLowerCase()),
    );
    expect(sectionsA.find((s) => s.heading === "fridge")?.items).toEqual(["2 avocados"]);
    expect(sectionsA.find((s) => s.heading === "freezer")?.items).toEqual(["frozen peas"]);
    expect(sectionsA.find((s) => s.heading === "spice rack")?.items).toEqual(["cumin"]);

    // Kitchen B remains completely empty.
    expect(await storeB.readSections()).toEqual([]);
  });

  it("matches suggested sections through all 6 rules, strips leading bullets, skips blank lines, and allows duplicate adds", async () => {
    const [secSetup, secPerish, secCold, secDry, secExtra] = await db
      .insert(kitchenPantrySections)
      .values([
        { kitchenId: kitchenA.id, rawHeading: "Our setup" },
        { kitchenId: kitchenA.id, rawHeading: "Perishables" },
        { kitchenId: kitchenA.id, rawHeading: "Cold Drawer" },
        { kitchenId: kitchenA.id, rawHeading: "Dry Pantry" },
        { kitchenId: kitchenA.id, rawHeading: "Other Food" },
      ])
      .returning();

    await db.insert(kitchenPantryItems).values([
      { kitchenId: kitchenA.id, sectionId: secSetup!.id, text: "• cast iron skillet" },
      { kitchenId: kitchenA.id, sectionId: secPerish!.id, text: "   " },
      { kitchenId: kitchenA.id, sectionId: secPerish!.id, text: "- 3 lemons" },
    ]);

    const store = createDbPantryStore(kitchenA.id);
    const result = await store.addItems([
      { text: "butter", section: "cold drawer" }, // rule 1: exact
      { text: "bay leaves", section: "Dry" }, // rule 2: contained in "dry pantry"
      { text: "cilantro", section: "Produce" }, // rule 3: veg/produce -> "perishables"
      { text: "ice cream", section: "Deep Freezer" }, // rule 4/2: freezer not present -> rule 5: "dry pantry"
      { text: "rice", section: "Unmatched" }, // rule 5: contains "pantry"
      { text: "Mystery jar" }, // rule 6: no suggestion -> first food section ("Perishables")
      { text: "Mystery jar" }, // non-idempotent: added twice
    ]);
    expect(result).toEqual({ added: 7 });

    const sections = await store.readSections();
    expect(sections).toEqual([
      {
        heading: "our setup",
        rawHeading: "Our setup",
        items: ["cast iron skillet"],
      },
      {
        heading: "perishables",
        rawHeading: "Perishables",
        items: ["3 lemons", "cilantro", "Mystery jar", "Mystery jar"],
      },
      {
        heading: "cold drawer",
        rawHeading: "Cold Drawer",
        items: ["butter"],
      },
      {
        heading: "dry pantry",
        rawHeading: "Dry Pantry",
        items: ["bay leaves", "ice cream", "rice"],
      },
      {
        heading: "other food",
        rawHeading: "Other Food",
        items: [],
      },
    ]);

    expect(secCold && secDry && secExtra).toBeTruthy();
  });

  it("picks freezer section via rule 4 when suggestion contains freezer and section is named chest freezer", async () => {
    await db.insert(kitchenPantrySections).values([
      { kitchenId: kitchenA.id, rawHeading: "Shelf" },
      { kitchenId: kitchenA.id, rawHeading: "Garage Chest Freezer" },
    ]);
    const store = createDbPantryStore(kitchenA.id);
    await store.addItems([{ text: "dumplings", section: "Freezer Drawer" }]);
    const sections = await store.readSections();
    expect(sections.find((s) => s.heading === "garage chest freezer")?.items).toEqual([
      "dumplings",
    ]);
  });

  it("rejects addItems when the pantry has only non-food sections", async () => {
    await db.insert(kitchenPantrySections).values([
      { kitchenId: kitchenA.id, rawHeading: "Our setup" },
      { kitchenId: kitchenA.id, rawHeading: "Our family notes" },
    ]);

    const store = createDbPantryStore(kitchenA.id);
    await expect(
      store.addItems([{ text: "2 avocados", section: "Fridge" }]),
    ).rejects.toThrow(/no food sections/i);
  });

  it("applyUpdates deletes and decrements only untaken food-section lines, respects section hints, and leaves non-food sections untouched", async () => {
    const [secSetup, secFridge, secPantry] = await db
      .insert(kitchenPantrySections)
      .values([
        { kitchenId: kitchenA.id, rawHeading: "Our setup" },
        { kitchenId: kitchenA.id, rawHeading: "Fridge" },
        { kitchenId: kitchenA.id, rawHeading: "Pantry" },
      ])
      .returning();

    await db.insert(kitchenPantryItems).values([
      { kitchenId: kitchenA.id, sectionId: secSetup!.id, text: "5 lbs potatoes" },
      { kitchenId: kitchenA.id, sectionId: secFridge!.id, text: "sour cream" },
      { kitchenId: kitchenA.id, sectionId: secFridge!.id, text: "2 avocados" },
      { kitchenId: kitchenA.id, sectionId: secFridge!.id, text: "2 avocados" },
      { kitchenId: kitchenA.id, sectionId: secFridge!.id, text: "milk" },
      { kitchenId: kitchenA.id, sectionId: secPantry!.id, text: "5 lbs potatoes" },
      { kitchenId: kitchenA.id, sectionId: secPantry!.id, text: "milk" },
    ]);

    // Seed identical items in kitchen B to confirm isolation.
    const storeB = createDbPantryStore(kitchenB.id);
    await storeB.addItems([
      { text: "sour cream", section: "Fridge" },
      { text: "5 lbs potatoes", section: "Pantry" },
    ]);

    const storeA = createDbPantryStore(kitchenA.id);
    expect(await storeA.applyUpdates([])).toEqual({ updated: 0 });

    const res = await storeA.applyUpdates([
      { action: "delete", oldText: "  SOUR CREAM " },
      { action: "decrement", oldText: "5 lbs potatoes", newText: " 4 lbs potatoes " },
      { action: "delete", oldText: "2 avocados" }, // takes first "2 avocados"
      { action: "delete", oldText: "2 avocados" }, // takes second "2 avocados"
      { action: "delete", oldText: "2 avocados" }, // no third copy -> skipped
      { action: "delete", oldText: "milk", section: "Pantry" }, // respects section hint
      { action: "decrement", oldText: "milk", newText: "   " }, // blank newText leaves remaining Fridge milk unchanged
      { action: "delete", oldText: "not-present" }, // skipped
    ]);
    expect(res).toEqual({ updated: 6 });

    expect(await storeA.readSections()).toEqual([
      {
        heading: "our setup",
        rawHeading: "Our setup",
        items: ["5 lbs potatoes"],
      },
      {
        heading: "fridge",
        rawHeading: "Fridge",
        items: ["milk"],
      },
      {
        heading: "pantry",
        rawHeading: "Pantry",
        items: ["4 lbs potatoes"],
      },
    ]);

    // Running same deletes again finds nothing.
    expect(
      await storeA.applyUpdates([
        { action: "delete", oldText: "sour cream" },
        { action: "delete", oldText: "2 avocados" },
      ]),
    ).toEqual({ updated: 0 });

    // Kitchen B is untouched.
    const sectionsB = await storeB.readSections();
    expect(sectionsB.find((s) => s.heading === "fridge")?.items).toEqual(["sour cream"]);
    expect(sectionsB.find((s) => s.heading === "pantry")?.items).toEqual(["5 lbs potatoes"]);
  });
});
