/**
 * Tests for recipe-sync: the tab chunker and the sync that feeds it.
 *
 * The recipe library is a tree of tabs (`LibraryTab`, read through the
 * recipe-library hook). The fixture mirrors a
 * lived-in tree: category tabs nested two deep (entrees > indian), top-level
 * category tabs, a category tab with its own intro text ("quick & easy"),
 * a recipe whose body carries its own headings, and a trailing-"*" needs-work
 * marker. It adds the shapes a household's edits can produce, which the
 * chunker must pass over or report: an empty tab, a second tab with the same
 * name, titles with nothing to slug, an accented title, a tab holding only a
 * photo, a tab of a single line (a rating and a source link), a recipe that
 * grew a sub-tab, a recipe put at the top level, and a top-level category
 * emptied of its recipes.
 */

import { describe, it, expect, vi, beforeEach } from "vitest";
import { PgDialect } from "drizzle-orm/pg-core";
import type { SQL } from "drizzle-orm";

// The recipe-library hook, connected to a source these tests fill.
const readTabs = vi.hoisted(() => vi.fn());
vi.mock("./hooks/registry", () => ({ hook: () => ({ readTabs }) }));

vi.mock("./recipe-import", () => ({
  extractRecipeFromText: vi.fn(),
}));

// The model behind Sous's serving estimate (slice B4b), its one external
// boundary. Each test's default reply is an estimate from the dish.
vi.mock("./ai", async (importOriginal) => ({
  ...(await importOriginal<typeof import("./ai")>()),
  chat: vi.fn(),
}));

// The cook plan (slice P) is settled per recipe before its save; here it is
// always "nothing to plan", so these tests see only extraction and save. The
// plan step runs for real against PGlite in `recipe-sync-plans.test.ts`.
vi.mock("./library-cook-plans", async (importOriginal) => {
  const actual = await importOriginal<typeof import("./library-cook-plans")>();
  return {
    ...actual,
    readSavedPlan: vi.fn(async () => undefined),
    planForChunk: vi.fn(async () => ({ outcome: "none", columns: actual.NO_PLAN })),
  };
});

// The real table, so the SQL asserted below is built from the live schema.
vi.mock("./db", async () => {
  const { docRecipes } = await import("../../drizzle/schema");
  return {
    db: { insert: vi.fn(), select: vi.fn(), transaction: vi.fn(), execute: vi.fn() },
    docRecipes,
  };
});

import {
  chunkRecipeTabs,
  normalizeHeading,
  slugify,
  slugsInDoc,
  syncRecipesFromDoc,
} from "./recipe-sync";
import type { LibraryTab } from "./hooks/types";
import {
  extractRecipeFromText,
  type ExtractionNotice,
  type ImportedRecipe,
} from "./recipe-import";
import { db } from "./db";
import { chat } from "./ai";
import { sourceHash } from "./serves-estimate-plan";
import { asMockDb, createMockQueryBuilder } from "./test-utils";

type Para = { text: string; style?: string };

/**
 * A tab as a source hands it over (`LibraryTab`): `body` is the tab as
 * written, a line or a styled heading each, and `lines` is its text as the
 * hook's contract has it: bullet glyphs off, blank lines dropped.
 */
function tab(
  title: string,
  body: Array<string | Para> = [],
  children: LibraryTab[] = [],
): LibraryTab {
  const lines = body
    .map((p) => (typeof p === "string" ? p : p.text))
    .map((text) => text.trim().replace(/^[•◦▪‣·*-]\s+/, "").trim())
    .filter((line) => line !== "");
  return { title, lines, nonText: false, children };
}

/** A tab whose only content is a pasted photo. */
function photoTab(title: string): LibraryTab {
  return { title, lines: [], nonText: true, children: [] };
}

/** `base` with a photo pasted after its text. */
function withPhoto(base: LibraryTab): LibraryTab {
  return { ...base, nonText: true };
}

function fixtureTabs(): LibraryTab[] {
  return [
    tab(
      "entrees",
      [],
      [
        tab(
          "indian",
          [],
          [
            tab("garlic chutney", ["⭐⭐⭐", "- 1 cup garlic", "blend it"]),
            tab("minced lamb", ["- 1 lb lamb", "brown the meat"]),
          ],
        ),
        tab(
          "american & italian",
          [],
          [
            tab("lentil stew (indian spiced)", [
              { text: "Indian-Spiced Lentil Stew", style: "HEADING_1" },
              "Servings: 6",
              { text: "Ingredients", style: "HEADING_2" },
              "- 4 oz bacon",
              "braise 2 hours",
            ]),
            tab("paprika fish cakes*", ["- fish", "fry"]),
            tab("half-written tab"),
            tab(
              "pizza dough",
              ["- 500g flour", "knead"],
              [tab("sauce", ["- tomatoes", "simmer"])],
            ),
            photoTab("recipe card photo"),
          ],
        ),
      ],
    ),
    tab(
      "desserts",
      [],
      [
        tab("key lime cheesecake", ["- limes", "chill"]),
        tab("Crème Brûlée", ["- cream", "torch the sugar"]),
        tab("麻婆豆腐", ["- tofu"]),
      ],
    ),
    tab(
      "quick & easy",
      ["Dishes ready in under half an hour."],
      [
        tab("air-fryer zucchini fritters", ["- squash", "fry"]),
        tab("shaved brussel sprout salad", [
          "⭐⭐⭐⭐ · Source: https://example.com/recipes/1",
        ]),
        tab("Garlic Chutney", ["- a different chutney"]),
        tab("***", ["- a recipe with no usable title"]),
        tab("   ", ["- a recipe with a blank title"]),
      ],
    ),
    tab("mystery sauce", ["- whatever's in the fridge"]),
    tab("seasonal specials"),
    tab("drinks", ["Cocktails and mocktails."]),
  ];
}

describe("normalizeHeading", () => {
  it("strips a trailing needs-work asterisk", () => {
    expect(normalizeHeading("east asian*")).toBe("east asian");
    expect(normalizeHeading("paprika fish cakes*")).toBe("paprika fish cakes");
  });

  it("collapses whitespace and lowercases", () => {
    expect(normalizeHeading("  American  &   Italian ")).toBe(
      "american & italian",
    );
  });
});

describe("slugify", () => {
  it("kebab-cases names and drops apostrophes and parens", () => {
    expect(slugify("lentil stew (indian spiced)")).toBe(
      "lentil-stew-indian-spiced",
    );
    expect(slugify("frankie's 457 cavatelli")).toBe("frankies-457-cavatelli");
    expect(slugify("Pad See Ew (Stir Fried Rice Noodles)")).toBe(
      "pad-see-ew-stir-fried-rice-noodles",
    );
  });

  it("folds accents so accented and plain spellings share a slug", () => {
    expect(slugify("Crème Brûlée")).toBe("creme-brulee");
    expect(slugify("creme brulee")).toBe("creme-brulee");
  });

  it("spells out Latin letters that have no accent to fold", () => {
    expect(slugify("Æbleskiver")).toBe("aebleskiver");
    expect(slugify("Łódź pierogi")).toBe("lodz-pierogi");
    expect(slugify("Straße Brezel")).toBe("strasse-brezel");
    expect(slugify("smørrebrød")).toBe("smorrebrod");
  });

  it("slugs a name with no Latin letters or digits to empty", () => {
    expect(slugify("麻婆豆腐")).toBe("");
    expect(slugify("***")).toBe("");
  });
});

describe("chunkRecipeTabs", () => {
  it("makes each leaf tab below the top level a recipe, in doc order", () => {
    const { chunks } = chunkRecipeTabs(fixtureTabs());

    expect(chunks.map((c) => c.name)).toEqual([
      "garlic chutney",
      "minced lamb",
      "lentil stew (indian spiced)",
      "paprika fish cakes",
      "sauce",
      "key lime cheesecake",
      "Crème Brûlée",
      "air-fryer zucchini fritters",
    ]);
  });

  it("files each recipe under its nearest category tab", () => {
    const { chunks } = chunkRecipeTabs(fixtureTabs());
    const category = (name: string) =>
      chunks.find((c) => c.name === name)?.category;

    expect(category("garlic chutney")).toBe("indian");
    expect(category("lentil stew (indian spiced)")).toBe("american & italian");
    expect(category("key lime cheesecake")).toBe("desserts");
    expect(category("air-fryer zucchini fritters")).toBe(
      "quick & easy",
    );
  });

  it("sends the tab title and every line of its body, headings included", () => {
    const { chunks } = chunkRecipeTabs(fixtureTabs());
    const lamb = chunks.find((c) => c.docSlug === "lentil-stew-indian-spiced");

    expect(lamb?.rawText).toBe(
      [
        "lentil stew (indian spiced)",
        "Indian-Spiced Lentil Stew",
        "Servings: 6",
        "Ingredients",
        "4 oz bacon",
        "braise 2 hours",
      ].join("\n"),
    );
  });

  it("ignores a top-level category tab's own intro text", () => {
    const { chunks, skipped } = chunkRecipeTabs(fixtureTabs());
    const names = [...chunks, ...skipped].map((c) => c.name);

    expect(names).not.toContain("quick & easy");
    expect(chunks.some((c) => c.rawText.includes("under half an hour"))).toBe(
      false,
    );
  });

  it("strips a trailing needs-work asterisk from the name and slug", () => {
    const { chunks } = chunkRecipeTabs(fixtureTabs());
    const cakes = chunks.find((c) => c.docSlug === "paprika-fish-cakes");

    expect(cakes?.name).toBe("paprika fish cakes");
  });

  it("passes over an empty tab without reporting it", () => {
    const { chunks, skipped } = chunkRecipeTabs(fixtureTabs());
    const names = [...chunks, ...skipped].map((c) => c.name);

    expect(names).not.toContain("half-written tab");
    expect(names).not.toContain("seasonal specials");
  });

  it("folds accents in the slug but keeps them in the name", () => {
    const { chunks } = chunkRecipeTabs(fixtureTabs());
    const brulee = chunks.find((c) => c.docSlug === "creme-brulee");

    expect(brulee?.name).toBe("Crème Brûlée");
  });

  it("keeps the first of two tabs with the same name and reports the second", () => {
    const { chunks, skipped } = chunkRecipeTabs(fixtureTabs());
    const chutneys = chunks.filter((c) => c.docSlug === "garlic-chutney");

    expect(chutneys).toHaveLength(1);
    expect(chutneys[0].category).toBe("indian");
    expect(skipped).toContainEqual({
      name: "Garlic Chutney",
      error: expect.stringMatching(/same name/),
      docSlug: "garlic-chutney",
    });
  });

  it("reports a tab whose title leaves nothing to name it by", () => {
    const { skipped } = chunkRecipeTabs(fixtureTabs());
    const noName = { error: expect.stringMatching(/no Latin letters/) };

    expect(skipped).toContainEqual({ name: "***", ...noName });
    expect(skipped).toContainEqual({ name: "(untitled tab)", ...noName });
    expect(skipped).toContainEqual({ name: "麻婆豆腐", ...noName });
  });

  it("reports a top-level tab with no recipe tabs inside it", () => {
    const { chunks, skipped } = chunkRecipeTabs(fixtureTabs());
    const topLevel = { error: expect.stringMatching(/top-level tab/) };

    expect(chunks.map((c) => c.name)).not.toContain("mystery sauce");
    expect(skipped).toContainEqual({
      name: "mystery sauce",
      docSlug: "mystery-sauce",
      ...topLevel,
    });
    expect(skipped).toContainEqual({
      name: "drinks",
      docSlug: "drinks",
      ...topLevel,
    });
  });

  it("reports the text of a recipe that grew a sub-tab, and syncs the sub-tab", () => {
    const { chunks, skipped } = chunkRecipeTabs(fixtureTabs());

    expect(skipped).toContainEqual({
      name: "pizza dough",
      error: expect.stringMatching(/own content and sub-tabs/),
      docSlug: "pizza-dough",
    });
    expect(chunks.find((c) => c.name === "sauce")?.category).toBe(
      "pizza dough",
    );
  });

  it("reports a tab holding only a photo", () => {
    const { skipped } = chunkRecipeTabs(fixtureTabs());

    expect(skipped).toContainEqual({
      name: "recipe card photo",
      error: expect.stringMatching(/no text to read/),
      docSlug: "recipe-card-photo",
    });
  });

  it("reports a photo beside sub-tabs", () => {
    const { chunks, skipped } = chunkRecipeTabs([
      tab(
        "breads",
        [],
        [withPhoto(tab("focaccia", [], [tab("dough", ["- flour", "knead"])]))],
      ),
    ]);

    expect(chunks.map((c) => c.name)).toEqual(["dough"]);
    expect(skipped).toEqual([
      {
        name: "focaccia",
        error: expect.stringMatching(/own content and sub-tabs/),
        docSlug: "focaccia",
      },
    ]);
  });

  it("reports a single-line tab rather than letting the extractor invent a recipe", () => {
    const { chunks, skipped } = chunkRecipeTabs(fixtureTabs());

    expect(chunks.map((c) => c.name)).not.toContain(
      "shaved brussel sprout salad",
    );
    expect(skipped).toContainEqual({
      name: "shaved brussel sprout salad",
      error: expect.stringMatching(/single line/),
      docSlug: "shaved-brussel-sprout-salad",
    });
  });

  it("lets a later tab of the same name sync when the first is a single line", () => {
    const { chunks, skipped } = chunkRecipeTabs([
      tab(
        "salads",
        [],
        [
          tab("kale salad", ["Source: https://example.com/kale"]),
          tab("Kale Salad", ["- kale", "massage it"]),
        ],
      ),
    ]);

    expect(chunks.map((c) => c.name)).toEqual(["Kale Salad"]);
    expect(skipped.map((s) => s.error)).toEqual([
      expect.stringMatching(/single line/),
    ]);
  });

  it("syncs a recipe with a photo beside its text, marking it", () => {
    const { chunks } = chunkRecipeTabs([
      tab(
        "desserts",
        [],
        [withPhoto(tab("flan", ["- eggs", "bake"])), tab("tart", ["- a", "b"])],
      ),
    ]);

    expect(chunks.map((c) => [c.name, c.nonText])).toEqual([
      ["flan", true],
      ["tart", false],
    ]);
    expect(chunks[0].rawText).toBe("flan\neggs\nbake");
  });

  it("reports every unsyncable tab, in doc order", () => {
    const { skipped } = chunkRecipeTabs(fixtureTabs());

    expect(skipped.map((s) => s.name)).toEqual([
      "pizza dough",
      "recipe card photo",
      "麻婆豆腐",
      "shaved brussel sprout salad",
      "Garlic Chutney",
      "***",
      "(untitled tab)",
      "mystery sauce",
      "drinks",
    ]);
  });
});

describe("chunkRecipeTabs: the Doc's order (slice S)", () => {
  const ORDERED = [
    tab("Entrees", [], [
      tab("Indian ", [], [tab("Dal", ["- lentils", "simmer"]), tab("Chana masala", ["- chickpeas", "simmer"])]),
      tab("Pasta", ["- pasta", "boil"]),
    ]),
    tab("Seasonal  Specials **", [], [tab("Mole", ["- chiles", "grind"])]),
    tab("quick & easy", [], [tab("Fritters", ["- squash", "fry"])]),
  ];

  it("numbers each recipe by its place in the walk", () => {
    const { chunks } = chunkRecipeTabs(ORDERED);
    expect(chunks.map((c) => [c.name, c.position])).toEqual([
      ["Dal", 0],
      ["Chana masala", 1],
      ["Pasta", 2],
      ["Mole", 3],
      ["Fritters", 4],
    ]);
  });

  it("keeps the nearest category tab's title as the Doc writes it, its * and extra spaces gone", () => {
    const { chunks } = chunkRecipeTabs(ORDERED);
    expect(chunks.map((c) => [c.name, c.category, c.categoryTitle])).toEqual([
      ["Dal", "indian", "Indian"],
      ["Chana masala", "indian", "Indian"],
      ["Pasta", "entrees", "Entrees"],
      ["Mole", "seasonal specials", "Seasonal Specials"],
      ["Fritters", "quick & easy", "quick & easy"],
    ]);
  });

  it("numbers only recipes: a skipped tab takes no place", () => {
    const { chunks } = chunkRecipeTabs(fixtureTabs());
    expect(chunks.map((c) => c.position)).toEqual(chunks.map((_, i) => i));
  });
});

describe("slugsInDoc", () => {
  it("keeps every recipe slug and every skipped tab that has one, once each", () => {
    const { chunks, skipped } = chunkRecipeTabs(fixtureTabs());
    const slugs = slugsInDoc(chunks, skipped);

    expect(slugs).toEqual([...new Set(slugs)]);
    expect(slugs).toEqual(
      expect.arrayContaining([
        "garlic-chutney",
        "sauce",
        "pizza-dough",
        "recipe-card-photo",
        "shaved-brussel-sprout-salad",
        "mystery-sauce",
        "drinks",
      ]),
    );
    expect(slugs).toHaveLength(chunks.length + 5);
  });
});

describe("syncRecipesFromDoc", () => {
  const KITCHEN_ID = "00000000-0000-4000-8000-000000000001";
  const values = vi.fn();
  const onConflictDoUpdate = vi.fn();
  let staleQuery = createMockQueryBuilder<{ name: string }>([]);
  const dialect = new PgDialect();
  const orderPass = vi.fn();
  let orderWrites: Array<{ sql: string; params: unknown[] }> = [];
  // The order of the sync's order pass and its extractions.
  let events: string[] = [];

  // The transaction a successful extraction is written in: it locks the
  // slug, reads the saved recipe, then writes (or doesn't).
  const tx = {
    execute: vi.fn(),
    select: vi.fn(),
    insert: vi.fn(),
    update: vi.fn(),
  };
  type SavedRow = Required<Pick<ImportedRecipe, "name">> & {
    ingredients: ImportedRecipe["ingredients"] | null;
    steps: string[] | null;
    notes: string | null;
    rawDocText: string;
  };
  // Saved recipes (rows that extracted) by slug, as that read finds them.
  let saved: Record<string, SavedRow> = {};
  // Saved serving estimates by slug, as the sync's read before an estimate
  // finds them (slice B4b).
  type SavedEstimate = {
    servesEstimate: number | null;
    servesEstimateBasis: string | null;
    servesEstimateSourceHash: string | null;
  };
  let savedEstimates: Record<string, SavedEstimate> = {};
  const DISH_ESTIMATE = { basis: "From the dish alone: a family dinner for 4.", serves: 4 };
  // What each transaction did, in order: its lock, its read, its write or
  // update, with the fields an update set.
  let txSteps: Array<{
    step: string;
    sql: string;
    params: unknown[];
    fields?: Record<string, unknown>;
  }> = [];

  function record(step: string, query: SQL, fields?: Record<string, unknown>) {
    const { sql, params } = dialect.sqlToQuery(query);
    txSteps.push({ step, sql, params, ...(fields && { fields }) });
  }

  function savedRecipeQuery() {
    const query = {
      from: () => query,
      where: async (condition: SQL) => {
        record("read", condition);
        const row = saved[txSteps[txSteps.length - 1].params[1] as string];
        return row ? [row] : [];
      },
    };
    return query;
  }

  beforeEach(() => {
    readTabs.mockReset();
    onConflictDoUpdate.mockReset();
    onConflictDoUpdate.mockResolvedValue(undefined);
    values.mockReset();
    values.mockReturnValue({ onConflictDoUpdate });
    asMockDb(db).insert.mockReset();
    asMockDb(db).insert.mockReturnValue({ values });
    tx.execute.mockReset();
    tx.execute.mockImplementation(async (query: SQL) => record("lock", query));
    tx.insert.mockReset();
    tx.insert.mockImplementation(() => {
      txSteps.push({ step: "write", sql: "", params: [] });
      return { values };
    });
    tx.select.mockReset();
    tx.select.mockImplementation(savedRecipeQuery);
    tx.update.mockReset();
    tx.update.mockImplementation(() => ({
      set: (fields: Record<string, unknown>) => ({
        where: async (condition: SQL) => record("update", condition, fields),
      }),
    }));
    saved = {};
    txSteps = [];
    // The order pass (slice S): one statement before any extraction.
    orderPass.mockReset();
    orderPass.mockImplementation(async (query: SQL) => {
      const { sql, params } = dialect.sqlToQuery(query);
      events.push("order");
      orderWrites.push({ sql, params });
    });
    (db as unknown as { execute: typeof orderPass }).execute = orderPass;
    orderWrites = [];
    events = [];
    asMockDb(db).transaction.mockReset();
    asMockDb(db).transaction.mockImplementation(
      async (write: (t: typeof tx) => Promise<unknown>) => write(tx),
    );
    staleQuery = createMockQueryBuilder([{ name: "minced lamb (old)" }]);
    savedEstimates = {};
    asMockDb(db).select.mockReset();
    // The stale read selects the name; the estimate read the estimate.
    asMockDb(db).select.mockImplementation((fields?: Record<string, unknown>) => {
      if (fields === undefined || !("servesEstimate" in fields)) return staleQuery;
      const query = {
        from: () => query,
        where: async (condition: SQL) => {
          const slug = dialect.sqlToQuery(condition).params[1] as string;
          const row = savedEstimates[slug];
          return row ? [row] : [];
        },
      };
      return query;
    });
    vi.mocked(extractRecipeFromText).mockReset();
    vi.mocked(chat).mockReset();
    vi.mocked(chat).mockResolvedValue({ content: JSON.stringify(DISH_ESTIMATE), finishReason: "stop" });
  });

  /** An extraction of a tab's text: its first line, cooked. */
  function extracted(text: string, notices: ExtractionNotice[] = []) {
    return {
      recipe: { name: text.split("\n")[0], steps: ["cook it"] },
      notices,
    };
  }

  const stepsLeftOut: ExtractionNotice = {
    kind: "method-dropped",
    message: "Left out 3 steps that aren't in the source.",
  };

  // The garlic chutney tab, with a note, alone in the doc.
  const CHUTNEY_LINES = [
    "1 cup garlic",
    "1 tsp salt",
    "roast the garlic until golden, then blend it smooth",
    "keeps a week in the fridge",
  ];
  const chutneyTabs = (lines: string[]) => [
    tab("entrees", [], [tab("garlic chutney", lines)]),
  ];
  const CHUTNEY_TABS = chutneyTabs(CHUTNEY_LINES);
  // The text the sync extracts the tab from.
  const CHUTNEY_TEXT = ["garlic chutney", ...CHUTNEY_LINES].join("\n");
  // Its recipe, as an extraction returns it.
  const CHUTNEY = {
    name: "garlic chutney",
    ingredients: [
      { item: "garlic", amount: "1", unit: "cup" },
      { item: "salt", amount: "1", unit: "tsp" },
    ],
    steps: ["Roast the garlic until golden", "Blend it smooth"],
    notes: "Keeps a week in the fridge",
  } satisfies ImportedRecipe;
  // The same recipe as an earlier sync of the tab, as it reads now, saved it.
  const SAVED_CHUTNEY: SavedRow = { ...CHUTNEY, rawDocText: CHUTNEY_TEXT };

  /** The conflict clause the upsert for `docSlug` was given. */
  function conflictFor(docSlug: string) {
    const call = values.mock.calls.findIndex(([v]) => v.docSlug === docSlug);
    expect(call).toBeGreaterThanOrEqual(0);
    return onConflictDoUpdate.mock.calls[call][0];
  }

  it("extracts and upserts every recipe tab, reporting skips and failures", async () => {
    readTabs.mockResolvedValueOnce(fixtureTabs());
    vi.mocked(extractRecipeFromText).mockImplementation(async (text) =>
      text.startsWith("minced lamb") ? null : extracted(text),
    );

    const result = await syncRecipesFromDoc(KITCHEN_ID);

    expect(readTabs).toHaveBeenCalledTimes(1);
    expect(extractRecipeFromText).toHaveBeenCalledTimes(8);
    expect(values).toHaveBeenCalledTimes(8);
    expect(values).toHaveBeenCalledWith(
      expect.objectContaining({
        docSlug: "garlic-chutney",
        name: "garlic chutney",
        category: "indian",
        steps: ["cook it"],
        extractionError: null,
      }),
    );
    expect(values).toHaveBeenCalledWith(
      expect.objectContaining({
        docSlug: "minced-lamb",
        steps: null,
        extractionError: expect.stringMatching(/No recipe content/),
      }),
    );

    expect(result.stale).toEqual(["minced lamb (old)"]);
    expect(result.total).toBe(17);
    expect(result.succeeded).toBe(7);
    expect(result.failed).toBe(10);
    expect(result.failures.map((f) => f.name)).toEqual([
      "pizza dough",
      "recipe card photo",
      "麻婆豆腐",
      "shaved brussel sprout salad",
      "Garlic Chutney",
      "***",
      "(untitled tab)",
      "mystery sauce",
      "drinks",
      "minced lamb",
    ]);
    expect(result.failures[0]).toEqual({
      name: "pizza dough",
      error: expect.stringMatching(/own content and sub-tabs/),
    });
  });

  it("overwrites a recipe that extracts, but never a good one with a failure", async () => {
    readTabs.mockResolvedValueOnce(fixtureTabs());
    vi.mocked(extractRecipeFromText).mockImplementation(async (text) => {
      if (text.startsWith("minced lamb")) throw new Error("model timed out");
      return extracted(text);
    });

    const result = await syncRecipesFromDoc(KITCHEN_ID);

    const good = conflictFor("garlic-chutney");
    expect(good.setWhere).toBeUndefined();
    expect(good.set).toMatchObject({
      steps: ["cook it"],
      name: "garlic chutney",
    });
    expect(good.set).not.toHaveProperty("docSlug");
    expect(good.set).not.toHaveProperty("kitchenId");

    const failed = conflictFor("minced-lamb");
    expect(dialect.sqlToQuery(failed.setWhere as SQL).sql).toBe(
      '"doc_recipes"."extraction_error" is not null',
    );
    expect(failed.set).toMatchObject({
      steps: null,
      extractionError: "model timed out",
    });
    expect(result.failures).toContainEqual({
      name: "minced lamb",
      error: "model timed out",
    });
    // A failure is written outside any transaction, without reading first.
    expect(db.insert).toHaveBeenCalledTimes(1);
    expect(
      txSteps.some((step) => step.params.some((p) => String(p).includes("minced-lamb"))),
    ).toBe(false);
  });

  it("locks the slug and reads the saved recipe before writing an extraction", async () => {
    readTabs.mockResolvedValueOnce(CHUTNEY_TABS);
    vi.mocked(extractRecipeFromText).mockImplementation(async (text) =>
      extracted(text),
    );

    await syncRecipesFromDoc(KITCHEN_ID);

    expect(extractRecipeFromText).toHaveBeenCalledWith(CHUTNEY_TEXT, {
      meter: {
        kind: "kitchen",
        kitchenId: KITCHEN_ID,
        memberId: null,
        feature: "library-refresh",
      },
    });
    expect(db.transaction).toHaveBeenCalledTimes(1);
    expect(txSteps).toEqual([
      {
        step: "lock",
        sql: "select pg_advisory_xact_lock(hashtext($1))",
        params: [`${KITCHEN_ID}:garlic-chutney`],
      },
      {
        step: "read",
        sql:
          '("doc_recipes"."kitchen_id" = $1 and "doc_recipes"."doc_slug" = $2 and ' +
          '"doc_recipes"."extraction_error" is null)',
        params: [KITCHEN_ID, "garlic-chutney"],
      },
      { step: "write", sql: "", params: [] },
    ]);
    expect(tx.insert).toHaveBeenCalledTimes(1);
    expect(db.insert).not.toHaveBeenCalled();
  });

  it("writes a recipe whose steps were left out, and names it among the notices", async () => {
    readTabs.mockResolvedValueOnce(fixtureTabs());
    vi.mocked(extractRecipeFromText).mockImplementation(async (text) =>
      text.startsWith("garlic chutney")
        ? {
            recipe: {
              name: "garlic chutney",
              ingredients: [{ item: "garlic" }],
              steps: [],
            },
            notices: [stepsLeftOut],
          }
        : extracted(text),
    );

    const result = await syncRecipesFromDoc(KITCHEN_ID);

    const dropped = conflictFor("garlic-chutney");
    expect(dropped.setWhere).toBeUndefined();
    expect(dropped.set).toMatchObject({ steps: [], extractionError: null });
    expect(result.notices).toEqual([
      { name: "garlic chutney", ...stepsLeftOut },
    ]);
    expect(result.succeeded).toBe(8);
    expect(result.failures.map((f) => f.name)).not.toContain("garlic chutney");
  });

  it("keeps a saved recipe rather than lose steps its unchanged tab gives", async () => {
    readTabs.mockResolvedValueOnce(CHUTNEY_TABS);
    saved = { "garlic-chutney": SAVED_CHUTNEY };
    // Steps missing with no notice: the model returned none at all.
    vi.mocked(extractRecipeFromText).mockResolvedValue({
      recipe: { ...CHUTNEY, steps: [] },
      notices: [],
    });

    const result = await syncRecipesFromDoc(KITCHEN_ID);

    expect(values).not.toHaveBeenCalled();
    expect(result.failures).toEqual([
      {
        name: "garlic chutney",
        error:
          "This sync's extraction came back without its steps, though the " +
          "tab is unchanged and still gives them, so the saved recipe was kept.",
      },
    ]);
    expect(result.succeeded).toBe(0);
  });

  it("files a kept recipe under the category its tab is in now", async () => {
    // The chutney tab, unchanged, moved from under "indian" to "entrees".
    readTabs.mockResolvedValueOnce(CHUTNEY_TABS);
    saved = { "garlic-chutney": SAVED_CHUTNEY };
    vi.mocked(extractRecipeFromText).mockResolvedValue({
      recipe: { ...CHUTNEY, steps: [] },
      notices: [],
    });

    const result = await syncRecipesFromDoc(KITCHEN_ID);

    expect(values).not.toHaveBeenCalled();
    expect(txSteps.slice(2)).toEqual([
      {
        step: "update",
        sql: '("doc_recipes"."kitchen_id" = $1 and "doc_recipes"."doc_slug" = $2)',
        params: [KITCHEN_ID, "garlic-chutney"],
        fields: { category: "entrees", categoryTitle: "entrees", docPosition: 0 },
      },
    ]);
    expect(result.failures.map((f) => f.name)).toEqual(["garlic chutney"]);
  });

  it("names every part it kept, and only those", async () => {
    readTabs.mockResolvedValueOnce(CHUTNEY_TABS);
    saved = { "garlic-chutney": SAVED_CHUTNEY };
    vi.mocked(extractRecipeFromText).mockResolvedValue({
      recipe: { name: "garlic chutney", steps: [] },
      notices: [stepsLeftOut],
    });

    const result = await syncRecipesFromDoc(KITCHEN_ID);

    expect(result.failures[0].error).toBe(
      "This sync's extraction came back without its ingredients, steps and " +
        "notes, though the tab is unchanged and still gives them, so the " +
        "saved recipe was kept.",
    );
    expect(result.notices).toEqual([]);

    readTabs.mockResolvedValueOnce(CHUTNEY_TABS);
    saved = { "garlic-chutney": { ...SAVED_CHUTNEY, steps: null } };

    const again = await syncRecipesFromDoc(KITCHEN_ID);

    expect(again.failures[0].error).toMatch(
      /without its ingredients and notes,/,
    );
  });

  it("takes an edited tab as the new extraction reads it, even without steps the tab gives", async () => {
    // The family added a line since the saved recipe was extracted. Word
    // overlap can't tell steps the family took out from steps the model
    // dropped, so an edited tab's extraction is written as it came back.
    const edited = [...CHUTNEY_LINES, "good with lamb"];
    readTabs.mockResolvedValueOnce(chutneyTabs(edited));
    saved = { "garlic-chutney": SAVED_CHUTNEY };
    vi.mocked(extractRecipeFromText).mockResolvedValue({
      recipe: { ...CHUTNEY, steps: [] },
      notices: [],
    });

    const result = await syncRecipesFromDoc(KITCHEN_ID);

    expect(conflictFor("garlic-chutney").set).toMatchObject({
      steps: [],
      rawDocText: ["garlic chutney", ...edited].join("\n"),
    });
    expect(result.failures).toEqual([]);
    expect(result.succeeded).toBe(1);
  });

  it("replaces saved steps the tab doesn't give", async () => {
    readTabs.mockResolvedValueOnce(CHUTNEY_TABS);
    // Written by an earlier, laxer extraction.
    saved = {
      "garlic-chutney": {
        ...SAVED_CHUTNEY,
        steps: ["Wrap the cloves in foil and bake at 400 until soft"],
      },
    };
    vi.mocked(extractRecipeFromText).mockResolvedValue({
      recipe: { ...CHUTNEY, steps: [] },
      notices: [stepsLeftOut],
    });

    const result = await syncRecipesFromDoc(KITCHEN_ID);

    expect(conflictFor("garlic-chutney").set).toMatchObject({ steps: [] });
    expect(result.failures).toEqual([]);
    expect(result.notices).toEqual([
      { name: "garlic chutney", ...stepsLeftOut },
    ]);
  });

  it("writes over a saved recipe that never extracted, since the read skips it", async () => {
    readTabs.mockResolvedValueOnce(CHUTNEY_TABS);
    vi.mocked(extractRecipeFromText).mockResolvedValue({
      recipe: { name: "garlic chutney", steps: [] },
      notices: [],
    });

    const result = await syncRecipesFromDoc(KITCHEN_ID);

    expect(conflictFor("garlic-chutney").setWhere).toBeUndefined();
    expect(result.failures).toEqual([]);
  });

  it("writes each recipe as it extracts, so a cut-short run keeps its work", async () => {
    const events: string[] = [];
    readTabs.mockResolvedValueOnce(fixtureTabs());
    vi.mocked(extractRecipeFromText).mockImplementation(async (text) => {
      events.push(`extract ${text.split("\n")[0]}`);
      return extracted(text);
    });
    values.mockImplementation((v: { docSlug: string }) => {
      events.push(`save ${v.docSlug}`);
      return { onConflictDoUpdate };
    });

    await syncRecipesFromDoc(KITCHEN_ID);

    const extracts = events.filter((e) => e.startsWith("extract"));
    expect(extracts).toHaveLength(8);
    const firstSave = events.findIndex((e) => e.startsWith("save"));
    expect(firstSave).toBeGreaterThan(-1);
    expect(firstSave).toBeLessThan(events.indexOf(extracts[4]));
  });

  it("reports a recipe it couldn't save and carries on with the rest", async () => {
    readTabs.mockResolvedValueOnce(fixtureTabs());
    vi.mocked(extractRecipeFromText).mockImplementation(async (text) =>
      extracted(text),
    );
    values.mockImplementation((v: { docSlug: string }) => ({
      onConflictDoUpdate:
        v.docSlug === "minced-lamb"
          ? vi.fn().mockRejectedValue(new Error("connection reset"))
          : onConflictDoUpdate,
    }));

    const result = await syncRecipesFromDoc(KITCHEN_ID);

    expect(values).toHaveBeenCalledTimes(8);
    expect(onConflictDoUpdate).toHaveBeenCalledTimes(7);
    expect(result.failures).toContainEqual({
      name: "minced lamb",
      error: "Couldn't save: connection reset",
    });
    expect(result.succeeded).toBe(7);
    expect(result.stale).toEqual(["minced lamb (old)"]);
  });

  it("lists as stale only extracted rows whose slug the doc no longer gives", async () => {
    readTabs.mockResolvedValueOnce(fixtureTabs());
    vi.mocked(extractRecipeFromText).mockResolvedValue({
      recipe: { name: "x", steps: ["cook it"] },
      notices: [],
    });

    await syncRecipesFromDoc(KITCHEN_ID);

    expect(staleQuery.where).toHaveBeenCalledTimes(1);
    const [where] = staleQuery.where.mock.calls[0] as unknown as [SQL];
    const query = dialect.sqlToQuery(where);
    expect(query.sql).toMatch(
      /^\("doc_recipes"\."kitchen_id" = \$1 and "doc_recipes"\."extraction_error" is null and "doc_recipes"\."doc_slug" not in \(\$2(, \$\d+)*\)\)$/,
    );
    const { chunks, skipped } = chunkRecipeTabs(fixtureTabs());
    expect(query.params).toEqual([KITCHEN_ID, ...slugsInDoc(chunks, skipped)]);
    expect(query.params).toContain("shaved-brussel-sprout-salad");
  });

  describe("serving counts (slice B4b)", () => {
    const CHUTNEY_ESTIMATE = { basis: "1 cup garlic: about 8 servings as a condiment.", serves: 8 };

    it("a stated count is written, the estimate cleared, and no call made", async () => {
      readTabs.mockResolvedValueOnce(CHUTNEY_TABS);
      vi.mocked(extractRecipeFromText).mockResolvedValue({ recipe: { ...CHUTNEY, serves: 6 }, notices: [] });
      savedEstimates["garlic-chutney"] = {
        servesEstimate: 8,
        servesEstimateBasis: "old",
        servesEstimateSourceHash: sourceHash("doc_recipes", CHUTNEY_TEXT),
      };

      await syncRecipesFromDoc(KITCHEN_ID);

      expect(chat).not.toHaveBeenCalled();
      expect(conflictFor("garlic-chutney").set).toMatchObject({
        serves: 6,
        servesEstimate: null,
        servesEstimateBasis: null,
      });
    });

    it("no stated count: one call over the tab's text, the estimate stored beside the recipe, serves left null", async () => {
      readTabs.mockResolvedValueOnce(CHUTNEY_TABS);
      vi.mocked(extractRecipeFromText).mockResolvedValue({ recipe: CHUTNEY, notices: [] });
      vi.mocked(chat).mockResolvedValue({ content: JSON.stringify(CHUTNEY_ESTIMATE), finishReason: "stop" });

      const result = await syncRecipesFromDoc(KITCHEN_ID);

      expect(chat).toHaveBeenCalledTimes(1);
      const prompt = vi.mocked(chat).mock.calls[0]![0].messages[0]!.content;
      expect(prompt).toContain("Recipe: garlic chutney");
      expect(prompt).toContain("Amounts in the ingredient lines: yes.");
      expect(prompt).toContain(`<<<\n${CHUTNEY_TEXT}\n>>>`);
      expect(conflictFor("garlic-chutney").set).toMatchObject({
        serves: null,
        servesEstimate: 8,
        servesEstimateBasis: "1 cup garlic: about 8 servings as a condiment.",
        servesEstimateSourceHash: sourceHash("doc_recipes", CHUTNEY_TEXT),
      });
      expect(prompt).toContain("Category: entrees");
      expect(result.failures).toEqual([]);
    });

    it("an unchanged tab keeps its saved estimate, with no call", async () => {
      readTabs.mockResolvedValueOnce(CHUTNEY_TABS);
      vi.mocked(extractRecipeFromText).mockResolvedValue({ recipe: CHUTNEY, notices: [] });
      savedEstimates["garlic-chutney"] = {
        servesEstimate: 8,
        servesEstimateBasis: "seen by the cook",
        servesEstimateSourceHash: sourceHash("doc_recipes", CHUTNEY_TEXT),
      };

      await syncRecipesFromDoc(KITCHEN_ID);

      expect(chat).not.toHaveBeenCalled();
      expect(conflictFor("garlic-chutney").set).toMatchObject({
        servesEstimate: 8,
        servesEstimateBasis: "seen by the cook",
      });
    });

    it("an estimate beside text it wasn't made from (an older app's sync rewrote the text) is never reused", async () => {
      readTabs.mockResolvedValueOnce(CHUTNEY_TABS);
      vi.mocked(extractRecipeFromText).mockResolvedValue({ recipe: CHUTNEY, notices: [] });
      vi.mocked(chat).mockResolvedValue({ content: JSON.stringify(CHUTNEY_ESTIMATE), finishReason: "stop" });
      // The row's text is already the tab's (R19 wrote it), but the estimate
      // was made for the text before.
      savedEstimates["garlic-chutney"] = {
        servesEstimate: 3,
        servesEstimateBasis: "for the text before R19's sync",
        servesEstimateSourceHash: sourceHash("doc_recipes", "garlic chutney\n(the text before)"),
      };

      await syncRecipesFromDoc(KITCHEN_ID);

      expect(chat).toHaveBeenCalledTimes(1);
      expect(conflictFor("garlic-chutney").set).toMatchObject({
        servesEstimate: 8,
        servesEstimateSourceHash: sourceHash("doc_recipes", CHUTNEY_TEXT),
      });
    });

    it("an edited tab is estimated again", async () => {
      readTabs.mockResolvedValueOnce(CHUTNEY_TABS);
      vi.mocked(extractRecipeFromText).mockResolvedValue({ recipe: CHUTNEY, notices: [] });
      vi.mocked(chat).mockResolvedValue({ content: JSON.stringify(CHUTNEY_ESTIMATE), finishReason: "stop" });
      savedEstimates["garlic-chutney"] = {
        servesEstimate: 3,
        servesEstimateBasis: "for the older text",
        servesEstimateSourceHash: sourceHash("doc_recipes", `${CHUTNEY_TEXT}\n(an older version)`),
      };

      await syncRecipesFromDoc(KITCHEN_ID);

      expect(chat).toHaveBeenCalledTimes(1);
      expect(conflictFor("garlic-chutney").set).toMatchObject({ servesEstimate: 8 });
    });

    it("a recipe with no amounts is estimated from the dish, and must say so", async () => {
      readTabs.mockResolvedValueOnce(CHUTNEY_TABS);
      vi.mocked(extractRecipeFromText).mockResolvedValue({
        recipe: { ...CHUTNEY, ingredients: [{ item: "garlic" }, { item: "salt" }] },
        notices: [],
      });

      await syncRecipesFromDoc(KITCHEN_ID);

      expect(vi.mocked(chat).mock.calls[0]![0].messages[0]!.content).toContain("Amounts in the ingredient lines: none.");
      expect(conflictFor("garlic-chutney").set).toMatchObject({
        servesEstimate: 4,
        servesEstimateBasis: DISH_ESTIMATE.basis,
      });
    });

    it("an estimate that can't be made fails that recipe like an extraction: a saved recipe kept whole, the failure reported", async () => {
      readTabs.mockResolvedValueOnce(CHUTNEY_TABS);
      vi.mocked(extractRecipeFromText).mockResolvedValue({ recipe: CHUTNEY, notices: [] });
      vi.mocked(chat).mockRejectedValue(new Error("GOOGLE_AI_API_KEY is not set"));

      const result = await syncRecipesFromDoc(KITCHEN_ID);

      const write = conflictFor("garlic-chutney");
      // Only a row that never extracted takes the failure.
      expect(dialect.sqlToQuery(write.setWhere as SQL).sql).toBe(
        '"doc_recipes"."extraction_error" is not null',
      );
      expect(write.set).toMatchObject({
        steps: null,
        serves: null,
        servesEstimate: null,
        extractionError: "Couldn't estimate a serving count: the estimate call failed: GOOGLE_AI_API_KEY is not set",
      });
      expect(result.failures).toEqual([
        {
          name: "garlic chutney",
          error: "Couldn't estimate a serving count: the estimate call failed: GOOGLE_AI_API_KEY is not set",
        },
      ]);
      // No transaction: nothing was written over the saved recipe.
      expect(txSteps).toEqual([]);
    });
  });

  it("writes the Doc's order in one statement before any extraction, so a failed run keeps it", async () => {
    readTabs.mockResolvedValueOnce(fixtureTabs());
    vi.mocked(extractRecipeFromText).mockImplementation(async () => {
      events.push("extract");
      throw new Error("model down");
    });

    const result = await syncRecipesFromDoc(KITCHEN_ID);

    expect(events[0]).toBe("order");
    expect(events.filter((e) => e === "order")).toHaveLength(1);
    expect(result.succeeded).toBe(0);
    const [write] = orderWrites;
    expect(write!.sql).toMatch(/^\s*update doc_recipes set\s+doc_position = w\.pos/);
    // Each recipe the walk produces, with its place and its chapter as the Doc writes it,
    // followed by the kitchen filter parameters on the join and both table aliases.
    expect(write!.params.slice(0, 6)).toEqual(["garlic-chutney", 0, "indian", "minced-lamb", 1, "indian"]);
    expect(write!.params).toHaveLength(8 * 3 + 3);
    expect(write!.params.slice(-3)).toEqual([KITCHEN_ID, KITCHEN_ID, KITCHEN_ID]);
  });

  it("writes each recipe with its place and chapter title", async () => {
    readTabs.mockResolvedValueOnce(fixtureTabs());
    vi.mocked(extractRecipeFromText).mockImplementation(async (text) => extracted(text));

    await syncRecipesFromDoc(KITCHEN_ID);

    expect(values).toHaveBeenCalledWith(
      expect.objectContaining({ docSlug: "key-lime-cheesecake", docPosition: 5, categoryTitle: "desserts" }),
    );
  });

  it("fails loudly when no tab holds a recipe", async () => {
    readTabs.mockResolvedValueOnce([tab("entrees", [], [tab("indian")]), tab("drinks")]);

    await expect(syncRecipesFromDoc(KITCHEN_ID)).rejects.toThrow(/No recipes found in the recipe library/);
    expect(extractRecipeFromText).not.toHaveBeenCalled();
    expect(db.insert).not.toHaveBeenCalled();
  });

  it("fails before any write when the library can't be read, saying so", async () => {
    readTabs.mockRejectedValueOnce(new Error("503 backend error"));

    await expect(syncRecipesFromDoc(KITCHEN_ID)).rejects.toThrow("Couldn't read the recipe library: 503 backend error");
    expect(orderPass).not.toHaveBeenCalled();
    expect(extractRecipeFromText).not.toHaveBeenCalled();
    expect(db.insert).not.toHaveBeenCalled();
  });
});
