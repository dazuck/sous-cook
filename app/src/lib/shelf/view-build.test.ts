import { describe, expect, it } from "vitest";
import type { Pack, Recipe } from "@sous/pack";
import type { HouseholdLayout, Shelf } from "./registry";
import { packView, recipeRow, shelfView } from "./view-build";

const recipe = (id: string, over: Partial<Recipe> = {}): Recipe => ({
  id,
  title: id,
  serves_base: 4,
  ingredients: [{ id: "i", name: "salt", qty_canonical: { mass_g: 1 }, display_equivalents: { metric: { unit: "g", amount: 1 } } }],
  steps: [{ id: "s", type: "action", text: "Salt it." }],
  ...over,
});

const household = (recipes: Recipe[], sections?: Pack["sections"]): Pack => ({
  id: "household-book",
  title: "Household Book",
  kind: "household",
  version: "2026-10-04T18:00:00.000Z",
  creator: { name: "Household Book" },
  recipes,
  ...(sections && { sections }),
});

const fannie = (over: Partial<Pack> = {}): Pack => ({
  id: "fannie-farmer-1896",
  title: "The Boston Cooking-School Cook Book",
  version: "draft-1",
  creator: { name: "Fannie Merritt Farmer" },
  cover_ref: null,
  recipes: [recipe("doughnuts-i"), recipe("waffles")],
  ...over,
});

const LAYOUT: HouseholdLayout = {
  state: "ok",
  syncedAt: new Date("2026-10-04T18:00:00Z"),
  chapters: [
    {
      title: "Indian",
      rows: [
        { id: "dal", name: "Dal and rice (new year's)", missing: null },
        { id: "goat", name: "Goat curry (holiday)", missing: "refused" },
      ],
    },
    { title: "quick & easy", rows: [{ id: "crackers", name: "Crackers", missing: "unread" }] },
    { title: null, rows: [{ id: "loose", name: "Loose", missing: null }] },
  ],
};

const SHELF: Shelf = {
  packs: [
    {
      sourceId: "household-book",
      pack: household(
        [recipe("dal", { title: "Dal and rice", tags: ["quick", "new year's"], time_total_min: 40 }), recipe("loose")],
        [{ title: "Indian", recipe_ids: ["dal"] }],
      ),
    },
    { sourceId: "fannie-farmer-1896", pack: fannie() },
  ],
  errors: [],
  household: LAYOUT,
};

describe("recipeRow", () => {
  it("says the stated time as the recipe's, the count through servingsText, and only the title's tags", () => {
    expect(recipeRow(recipe("dal", { title: "Dal", time_active_min: 20, time_total_min: 40, tags: ["quick", "new year's", "summer"] }))).toEqual({
      id: "dal",
      title: "Dal",
      times: ["Recipe says 40 min ·", "20 min hands-on"],
      serves: "serves 4",
      tags: ["New\u00a0Year's", "summer"],
      missing: null,
    });
  });

  it("marks Sous's estimate", () => {
    expect(recipeRow(recipe("tuna", { serves_estimated: true })).serves).toBe("serves 4 (Sous's estimate)");
  });

  it("says no time for a recipe that states none", () => {
    expect(recipeRow(recipe("tuna")).times).toBeNull();
  });
});

describe("shelfView", () => {
  it("counts only the recipes that cook, and how many didn't come through", () => {
    const view = shelfView(SHELF, 14);
    expect(view.household).toMatchObject({ state: "ok", cookable: 2, missing: 2, syncedAt: "2026-10-04T18:00:00.000Z" });
    expect(view.ideas).toBe(14);
  });

  it("lists the contents as the Doc writes them, each with its recipes that cook", () => {
    expect(shelfView(SHELF, null).household.contents).toEqual([
      { anchor: "indian", title: "Indian", count: 1 },
      { anchor: "quick-easy", title: "quick & easy", count: 0 },
    ]);
  });

  it("lists the creator packs in registry order with their cloth", () => {
    expect(shelfView(SHELF, null).creators).toEqual([
      {
        id: "fannie-farmer-1896",
        title: "The Boston Cooking-School Cook Book",
        creator: "Fannie Merritt Farmer",
        recipes: 2,
        cloth: "walnut",
        coverRef: null,
      },
    ]);
  });

  it("always has the household entry: empty, and unreadable, and with no family source read", () => {
    const empty = shelfView({ packs: [], errors: [], household: { state: "empty", syncedAt: null, chapters: [] } }, null);
    expect(empty.household).toMatchObject({ state: "empty", cookable: 0, contents: [], syncedAt: null });
    const unreadable = shelfView({ packs: [], errors: [], household: { state: "unreadable", syncedAt: null, chapters: [] } }, null);
    expect(unreadable.household.state).toBe("unreadable");
    expect(shelfView({ packs: [], errors: [] }, null).household.state).toBe("unreadable");
  });

  it("names every row of a family book where nothing cooks, and counts none", () => {
    const view = shelfView(
      {
        packs: [],
        errors: [],
        household: { state: "empty", syncedAt: LAYOUT.syncedAt, chapters: [{ title: "Indian", rows: [{ id: "a", name: "A", missing: "refused" }] }] },
      },
      null,
    );
    expect(view.household).toMatchObject({ state: "empty", cookable: 0, missing: 1 });
  });
});

describe("packView", () => {
  it("lays out the household book in its chapters, a missing row named in place, the tail headless", () => {
    const view = packView(SHELF, "household-book")!;
    expect(view.chapters.map((c) => [c.anchor, c.title, c.rows.map((r) => [r.title, r.missing])])).toEqual([
      ["indian", "Indian", [["Dal and rice", null], ["Goat curry", "refused"]]],
      ["quick-easy", "quick & easy", [["Crackers", "unread"]]],
      [null, null, [["loose", null]]],
    ]);
    expect(view).toMatchObject({ kind: "household", cookable: 2, missing: 2, cloth: null, state: "ok" });
  });

  it("sends no steps or ingredients", () => {
    const json = JSON.stringify(packView(SHELF, "household-book"));
    expect(json).not.toContain("Salt it.");
    expect(json).not.toContain("ingredients");
    expect(json).not.toContain("steps");
  });

  it("draws a creator pack with no sections as one flat list, in its cloth", () => {
    const view = packView(SHELF, "fannie-farmer-1896")!;
    expect(view).toMatchObject({ kind: "creator", creator: "Fannie Merritt Farmer", cookable: 2, cloth: "walnut" });
    expect(view.chapters).toEqual([{ anchor: null, title: null, rows: [recipeRow(recipe("doughnuts-i")), recipeRow(recipe("waffles"))] }]);
  });

  it("draws a creator pack's sections in order, a recipe in none after the last", () => {
    const shelf: Shelf = {
      packs: [
        {
          sourceId: "f",
          pack: fannie({
            recipes: [recipe("a"), recipe("b"), recipe("c")],
            sections: [
              { title: "Breads", recipe_ids: ["c"] },
              { title: "Breakfast", recipe_ids: ["a"] },
            ],
          }),
        },
      ],
      errors: [],
    };
    expect(packView(shelf, "fannie-farmer-1896")!.chapters.map((c) => [c.title, c.rows.map((r) => r.id)])).toEqual([
      ["Breads", ["c"]],
      ["Breakfast", ["a"]],
      [null, ["b"]],
    ]);
  });

  it("knows no pack of an unknown id, and never serves the household under a creator's", () => {
    expect(packView(SHELF, "nope")).toBeNull();
  });

  it("opens an empty or unreadable household book, saying so", () => {
    const shelf: Shelf = { packs: [], errors: [], household: { state: "unreadable", syncedAt: null, chapters: [] } };
    expect(packView(shelf, "household-book")).toMatchObject({ state: "unreadable", chapters: [] });
  });
});
