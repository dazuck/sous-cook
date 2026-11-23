import {
  chmod,
  copyFile,
  mkdir,
  mkdtemp,
  readFile,
  rm,
  symlink,
  writeFile,
} from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import type { Pack } from "@sous/pack";
import {
  afterEach,
  beforeEach,
  describe,
  expect,
  it,
  vi,
  type MockInstance,
} from "vitest";
import { loadCookPlanFixtures } from "../kitchen/__tests__/load-cook-plan-fixtures";
import { legacyToPackRecipe, storedEstimate } from "../pack-convert/convert";
import type { DocRecipeRow } from "../recipe-sync";
import {
  HOUSEHOLD_PACK,
  SHELF_SOURCES,
  loadShelf,
  type FamilyLibraryReader,
  type ShelfSource,
} from "./registry";

// The repo's packs/ (app/src/lib/shelf → repo root).
const PACKS_DIR = fileURLToPath(new URL("../../../../packs", import.meta.url));
const FANNIE = "drafts/fannie-farmer-1896.pack.json";

const source = (id: string, file: string): ShelfSource => ({
  id,
  source: { type: "pack-file", path: file },
});

const familySource = (id: string): ShelfSource => ({
  id,
  source: { type: "family-doc" },
});

/** For cases with no `family-doc` source: a call would fail the case's errors. */
const noFamily: FamilyLibraryReader = () =>
  Promise.reject(new Error("no family-doc source in this case"));

/** A `doc_recipes` row as the DB returns it, extraction succeeded. */
function docRow(slug: string, over: Partial<DocRecipeRow> = {}): DocRecipeRow {
  return {
    id: `00000000-0000-4000-8000-${slug.padStart(12, "0").slice(-12)}`,
    docSlug: slug,
    name: slug,
    category: null,
    ingredients: [{ item: "red lentils", amount: "1", unit: "cup" }],
    steps: ["Rinse the lentils.", "Simmer 20 minutes."],
    estimatedTime: null,
    serves: 4,
    tags: null,
    notes: null,
    stepIngredients: [[0], [0]],
    rawDocText: `${slug}\n1 cup red lentils…`,
    extractionError: null,
    syncedAt: new Date("2026-10-01T12:00:00Z"),
    servesEstimate: null,
    servesEstimateBasis: null,
    docPosition: null,
    categoryTitle: null,
    servesEstimateSourceHash: null,
    cookPlan: null,
    cookPlanError: null,
    cookPlanSourceHash: null,
    cookPlanStamp: null,
    ...over,
  };
}

const reading =
  (rows: DocRecipeRow[]): FamilyLibraryReader =>
  () =>
    Promise.resolve(rows);

// The committed Fannie file, a valid pack, as the base each case edits.
async function fannie(): Promise<Pack> {
  return JSON.parse(
    await readFile(path.join(PACKS_DIR, FANNIE), "utf8"),
  ) as Pack;
}

describe("SHELF_SOURCES", () => {
  it("has unique registry ids", () => {
    const ids = SHELF_SOURCES.map((s) => s.id);
    expect(new Set(ids).size).toBe(ids.length);
  });

  // The 15 committed cook-plan fixtures are family-library recipes: as rows,
  // they stand in for the library the shelf route will read from the DB.
  it("loads whole from the repo's packs/ and a family library, household first, zero errors", async () => {
    const rows = loadCookPlanFixtures().map((f) =>
      docRow(f.name, {
        name: f.name,
        ingredients: f.recipe.ingredients,
        steps: f.recipe.steps,
        stepIngredients: null,
      }),
    );
    const shelf = await loadShelf(SHELF_SOURCES, {
      packsDir: PACKS_DIR,
      readFamilyLibrary: reading(rows),
    });
    expect(shelf.errors).toEqual([]);
    expect(shelf.packs.map((p) => [p.sourceId, p.pack.id])).toEqual([
      ["household-book", "household-book"],
      ["fannie-farmer-1896", "fannie-farmer-1896"],
    ]);
    expect(shelf.packs[0].pack.recipes).toHaveLength(15);
  });
});

describe("the family-doc source: the family library as the household pack", () => {
  let dir: string;
  let logged: MockInstance<typeof console.error>;

  beforeEach(async () => {
    dir = await mkdtemp(path.join(tmpdir(), "shelf-family-"));
    for (const file of ["commons.json", "states.json"]) {
      await copyFile(path.join(PACKS_DIR, file), path.join(dir, file));
    }
    await writeFile(
      path.join(dir, "good.json"),
      JSON.stringify(await fannie()),
    );
    logged = vi.spyOn(console, "error").mockImplementation(() => undefined);
  });

  afterEach(async () => {
    logged.mockRestore();
    await rm(dir, { recursive: true, force: true });
  });

  const loggedLines = (): string[] =>
    logged.mock.calls.map((call) => String(call[0]));

  it("turns a valid library into one household pack, in the reader's order", async () => {
    const rows = [
      docRow("pancakes", {
        name: "Pancakes",
        syncedAt: new Date("2026-10-02T08:30:00Z"),
      }),
      docRow("dal", {
        name: "Dal",
        serves: null,
        servesEstimate: 4,
        servesEstimateBasis: "1 cup lentils: about 4 bowls.",
        notes: "Better the next day.",
        tags: ["weeknight"],
        estimatedTime: { active: 10, passive: 25, total: 35 },
      }),
    ];

    const shelf = await loadShelf([familySource("family")], {
      packsDir: dir,
      readFamilyLibrary: reading(rows),
    });

    expect(shelf.errors).toEqual([]);
    expect(logged).not.toHaveBeenCalled();
    expect(shelf.packs).toHaveLength(1);
    const { sourceId, pack } = shelf.packs[0];
    expect(sourceId).toBe("family");
    const { recipes, ...fields } = pack;
    expect(fields).toEqual({
      id: "household-book",
      title: "Household Book",
      kind: "household",
      creator: { name: "Household Book" },
      // The newest syncedAt of the rows read.
      version: "2026-10-02T08:30:00.000Z",
    });
    expect(recipes.map((r) => r.id)).toEqual(["pancakes", "dal"]);
    // Each recipe is the converter's own reading of its row, keyed by slug.
    for (const [i, row] of rows.entries()) {
      const converted = legacyToPackRecipe(row, {
        id: row.docSlug,
        servesEstimate: storedEstimate(row),
      });
      if (!converted.ok) throw new Error(JSON.stringify(converted.issues));
      expect(recipes[i]).toEqual(converted.recipe);
    }
    expect(recipes[1].serves_base).toBe(4);
    expect(recipes[1].serves_estimated).toBe(true);
    expect(recipes[0].steps[0].ingredient_refs).toEqual(["ing-0"]);
  });

  it("isolates a failing recipe with its slug, and loads the rest", async () => {
    const rows = [
      docRow("bread"),
      docRow("blank", { ingredients: [], steps: [] }),
      // jsonb holding a shape its type doesn't describe.
      docRow("numeric", {
        ingredients: [
          { item: "flour", amount: 2 as unknown as string, unit: "cup" },
        ],
      }),
      docRow("soup"),
    ];

    const shelf = await loadShelf(
      [familySource("family"), source("good", "good.json")],
      { packsDir: dir, readFamilyLibrary: reading(rows) },
    );

    expect(shelf.packs.map((p) => p.sourceId)).toEqual(["family", "good"]);
    expect(shelf.packs[0].pack.recipes.map((r) => r.id)).toEqual([
      "bread",
      "soup",
    ]);
    expect(shelf.errors).toEqual([
      {
        sourceId: "family",
        packId: "household-book",
        recipeId: "blank",
        recipeName: "blank",
        section: null,
        missing: "refused",
        reason: "not a valid recipe (Pack Format v0.7)",
        issues: [
          {
            path: "(root)",
            message: "a recipe needs at least one ingredient or one step",
          },
        ],
      },
      {
        sourceId: "family",
        packId: "household-book",
        recipeId: "numeric",
        recipeName: "numeric",
        section: null,
        missing: "refused",
        reason: "recipe row unreadable (not the stored recipe shape)",
        issues: [
          {
            path: "ingredients.0.amount",
            message: expect.stringContaining("expected string"),
          },
        ],
      },
    ]);
    expect(loggedLines()).toEqual([
      "[shelf] source family (pack household-book) recipe blank: not a valid recipe (Pack Format v0.7)",
      "[shelf] source family (pack household-book) recipe numeric: recipe row unreadable (not the stored recipe shape)",
    ]);
  });

  it("serving counts (B4b): Sous's estimate loads marked; no count and no estimate is isolated with its reason", async () => {
    const rows = [
      docRow("stated"),
      docRow("estimated", {
        serves: null,
        servesEstimate: 3,
        servesEstimateBasis: "1 cup lentils: about 3 bowls.",
      }),
      docRow("stale", { serves: 4, servesEstimate: 9, servesEstimateBasis: "made before the Doc stated 4" }),
      docRow("none", { serves: null }),
    ];
    const shelf = await loadShelf([familySource("family")], {
      packsDir: dir,
      readFamilyLibrary: reading(rows),
    });
    const recipes = shelf.packs[0].pack.recipes;
    expect(recipes.map((r) => [r.id, r.serves_base, r.serves_estimated])).toEqual([
      ["stated", 4, undefined],
      ["estimated", 3, true],
      ["stale", 4, undefined],
    ]);
    expect(shelf.errors).toEqual([
      {
        sourceId: "family",
        packId: "household-book",
        recipeId: "none",
        recipeName: "none",
        section: null,
        missing: "refused",
        reason: "not a valid recipe (Pack Format v0.7)",
        issues: [
          {
            path: "serves_base",
            message: "no serving count: the recipe states none, and Sous hasn't estimated one yet",
          },
        ],
      },
    ]);
  });

  it("errors an empty library as its source, loading the other sources", async () => {
    const shelf = await loadShelf(
      [familySource("family"), source("good", "good.json")],
      { packsDir: dir, readFamilyLibrary: reading([]) },
    );

    expect(shelf.packs.map((p) => p.sourceId)).toEqual(["good"]);
    expect(shelf.errors).toEqual([
      {
        sourceId: "family",
        packId: "household-book",
        reason: "family library is empty",
        issues: [],
      },
    ]);
    expect(loggedLines()).toEqual([
      "[shelf] source family (pack household-book): family library is empty",
    ]);
  });

  it("errors a library read that fails as its source, loading the other sources", async () => {
    const shelf = await loadShelf(
      [familySource("family"), source("good", "good.json")],
      {
        packsDir: dir,
        readFamilyLibrary: () => Promise.reject(new Error("connect ETIMEDOUT")),
      },
    );

    expect(shelf.packs.map((p) => p.sourceId)).toEqual(["good"]);
    expect(shelf.errors).toEqual([
      {
        sourceId: "family",
        packId: "household-book",
        reason: "family library unreadable: connect ETIMEDOUT",
        issues: [],
      },
    ]);
  });

  it("errors the source when no recipe converts, after each recipe's own error", async () => {
    const shelf = await loadShelf([familySource("family")], {
      packsDir: dir,
      readFamilyLibrary: reading([
        docRow("a", { ingredients: [], steps: [] }),
        docRow("b", { name: "" }),
      ]),
    });

    expect(shelf.packs).toEqual([]);
    expect(shelf.errors.map((e) => [e.recipeId ?? null, e.reason])).toEqual([
      ["a", "not a valid recipe (Pack Format v0.7)"],
      ["b", "not a valid recipe (Pack Format v0.7)"],
      [null, "no recipe in the family library converted (2 failed)"],
    ]);
  });

  it("refuses the household pack when an earlier source already loaded its pack id (B3a's rule)", async () => {
    const squatter = { ...(await fannie()), id: HOUSEHOLD_PACK.id };
    await writeFile(path.join(dir, "squatter.json"), JSON.stringify(squatter));

    const shelf = await loadShelf(
      [source("squatter", "squatter.json"), familySource("family")],
      { packsDir: dir, readFamilyLibrary: reading([docRow("dal")]) },
    );

    expect(shelf.packs.map((p) => p.sourceId)).toEqual(["squatter"]);
    expect(shelf.errors).toEqual([
      {
        sourceId: "family",
        packId: "household-book",
        reason:
          'duplicate pack id "household-book": source "squatter" already loaded it',
        issues: [],
      },
    ]);
  });

  it("refuses a second family-doc source: one household pack id, loaded once", async () => {
    const shelf = await loadShelf(
      [familySource("family"), familySource("family-again")],
      { packsDir: dir, readFamilyLibrary: reading([docRow("dal")]) },
    );

    expect(shelf.packs.map((p) => p.sourceId)).toEqual(["family"]);
    expect(shelf.errors.map((e) => e.reason)).toEqual([
      'duplicate pack id "household-book": source "family" already loaded it',
    ]);
  });

  it("refuses a duplicate source id without reading the library again", async () => {
    const read = vi.fn(reading([docRow("dal")]));

    const shelf = await loadShelf(
      [familySource("family"), familySource("family")],
      { packsDir: dir, readFamilyLibrary: read },
    );

    expect(read).toHaveBeenCalledOnce();
    expect(shelf.packs.map((p) => p.sourceId)).toEqual(["family"]);
    expect(shelf.errors.map((e) => e.reason)).toEqual([
      'duplicate source id "family": an earlier source already has it (family library not read)',
    ]);
  });

  it("errors the source without reading the library when the libraries are unreadable", async () => {
    await writeFile(path.join(dir, "states.json"), "[{]");
    const read = vi.fn(reading([docRow("dal")]));

    const shelf = await loadShelf([familySource("family")], {
      packsDir: dir,
      readFamilyLibrary: read,
    });

    expect(read).not.toHaveBeenCalled();
    expect(shelf.packs).toEqual([]);
    expect(shelf.errors.map((e) => [e.sourceId, e.reason])).toEqual([
      ["family", "libraries unreadable"],
    ]);
  });
});

describe("loadShelf, each source failing on its own", () => {
  let dir: string;
  let logged: MockInstance<typeof console.error>;

  beforeEach(async () => {
    dir = await mkdtemp(path.join(tmpdir(), "shelf-"));
    await copyFile(
      path.join(PACKS_DIR, "commons.json"),
      path.join(dir, "commons.json"),
    );
    await copyFile(
      path.join(PACKS_DIR, "states.json"),
      path.join(dir, "states.json"),
    );
    await writeFile(
      path.join(dir, "good.json"),
      JSON.stringify(await fannie()),
    );
    logged = vi.spyOn(console, "error").mockImplementation(() => undefined);
  });

  afterEach(async () => {
    logged.mockRestore();
    await rm(dir, { recursive: true, force: true });
  });

  // Each error is logged once, in order, as one line naming its source and,
  // once the file gave one, its pack id.
  const loggedLines = (): string[] =>
    logged.mock.calls.map((call) => String(call[0]));

  it("isolates an invalid pack beside a valid one", async () => {
    const { title: _title, ...untitled } = { ...(await fannie()), id: "bad" };
    await writeFile(path.join(dir, "bad.json"), JSON.stringify(untitled));

    const shelf = await loadShelf(
      [source("bad", "bad.json"), source("good", "good.json")],
      { packsDir: dir, readFamilyLibrary: noFamily },
    );

    expect(shelf.packs.map((p) => p.sourceId)).toEqual(["good"]);
    expect(shelf.errors).toEqual([
      {
        sourceId: "bad",
        packId: "bad",
        reason: "not a valid pack (Pack Format v0.7)",
        issues: [
          {
            path: "title",
            message: expect.stringContaining("expected string"),
          },
        ],
      },
    ]);
    expect(logged).toHaveBeenCalledOnce();
    expect(logged).toHaveBeenCalledWith(
      "[shelf] source bad (pack bad): not a valid pack (Pack Format v0.7)",
      shelf.errors[0].issues,
    );
  });

  it("errors a missing file and a file that is not JSON, loading the rest", async () => {
    await writeFile(path.join(dir, "garbled.json"), "{ not json");

    const shelf = await loadShelf(
      [
        source("gone", "drafts/gone.pack.json"),
        source("garbled", "garbled.json"),
        source("good", "good.json"),
      ],
      { packsDir: dir, readFamilyLibrary: noFamily },
    );

    expect(shelf.packs.map((p) => p.sourceId)).toEqual(["good"]);
    expect(shelf.errors).toEqual([
      {
        sourceId: "gone",
        reason: "file not found: packs/drafts/gone.pack.json",
        issues: [],
      },
      {
        sourceId: "garbled",
        reason: expect.stringMatching(/^not valid JSON: /),
        issues: [],
      },
    ]);
    expect(loggedLines()).toEqual([
      "[shelf] source gone: file not found: packs/drafts/gone.pack.json",
      expect.stringMatching(/^\[shelf\] source garbled: not valid JSON: /),
    ]);
  });

  it("refuses a path that leaves packs/", async () => {
    const shelf = await loadShelf(
      [source("escape", "../good.json"), source("good", "good.json")],
      { packsDir: dir, readFamilyLibrary: noFamily },
    );

    expect(shelf.packs.map((p) => p.sourceId)).toEqual(["good"]);
    expect(shelf.errors).toEqual([
      {
        sourceId: "escape",
        reason: 'path "../good.json" is outside packs/',
        issues: [],
      },
    ]);
    expect(loggedLines()).toEqual([
      '[shelf] source escape: path "../good.json" is outside packs/',
    ]);
  });

  it("reads a file whose name merely starts with two dots as inside packs/", async () => {
    await copyFile(path.join(dir, "good.json"), path.join(dir, "..good.json"));

    const shelf = await loadShelf([source("dots", "..good.json")], {
      packsDir: dir,
      readFamilyLibrary: noFamily,
    });

    expect(shelf.errors).toEqual([]);
    expect(shelf.packs.map((p) => p.sourceId)).toEqual(["dots"]);
    expect(logged).not.toHaveBeenCalled();
  });

  it("refuses a symlink in packs/ that leads out of it", async () => {
    const outside = await mkdtemp(path.join(tmpdir(), "shelf-outside-"));
    try {
      await copyFile(path.join(dir, "good.json"), path.join(outside, "x.json"));
      await symlink(path.join(outside, "x.json"), path.join(dir, "link.json"));

      const shelf = await loadShelf(
        [source("link", "link.json"), source("good", "good.json")],
        { packsDir: dir, readFamilyLibrary: noFamily },
      );

      expect(shelf.packs.map((p) => p.sourceId)).toEqual(["good"]);
      expect(shelf.errors).toEqual([
        {
          sourceId: "link",
          reason: 'path "link.json" is outside packs/',
          issues: [],
        },
      ]);
      expect(loggedLines()).toEqual([
        '[shelf] source link: path "link.json" is outside packs/',
      ]);
    } finally {
      await rm(outside, { recursive: true, force: true });
    }
  });

  it("loads through a packs/ that is itself reached by a symlink", async () => {
    const alias = `${dir}-alias`;
    await symlink(dir, alias);
    try {
      const shelf = await loadShelf([source("good", "good.json")], {
        packsDir: alias,
        readFamilyLibrary: noFamily,
      });
      expect(shelf.errors).toEqual([]);
      expect(shelf.packs.map((p) => p.sourceId)).toEqual(["good"]);
      expect(logged).not.toHaveBeenCalled();
    } finally {
      await rm(alias, { force: true });
    }
  });

  // macOS's filesystem ignores case and prod's (Linux) doesn't: a wrong-case
  // path would load here and be missing there, so it is refused on both.
  it("refuses a file named in the wrong case, naming the file as it is on disk", async () => {
    const shelf = await loadShelf(
      [source("upper", "Good.json"), source("good", "good.json")],
      { packsDir: dir, readFamilyLibrary: noFamily },
    );

    expect(shelf.packs.map((p) => p.sourceId)).toEqual(["good"]);
    expect(shelf.errors).toEqual([
      {
        sourceId: "upper",
        reason:
          'path "Good.json": "Good.json" is "good.json" on disk; names must match exactly, as prod\'s filesystem reads them',
        issues: [],
      },
    ]);
    expect(loggedLines()).toEqual([
      `[shelf] source upper: path "Good.json": "Good.json" is "good.json" on disk; names must match exactly, as prod's filesystem reads them`,
    ]);
  });

  it("fails only the source under a folder it can't list", async () => {
    await mkdir(path.join(dir, "locked"));
    await chmod(path.join(dir, "locked"), 0o000);
    try {
      const shelf = await loadShelf(
        [source("locked", "locked/x.pack.json"), source("good", "good.json")],
        { packsDir: dir, readFamilyLibrary: noFamily },
      );
      expect(shelf.packs.map((p) => p.sourceId)).toEqual(["good"]);
      expect(shelf.errors).toEqual([
        {
          sourceId: "locked",
          reason: expect.stringMatching(
            /^file unreadable: packs\/locked\/x\.pack\.json: EACCES/,
          ),
          issues: [],
        },
      ]);
    } finally {
      await chmod(path.join(dir, "locked"), 0o755);
    }
  });

  it("refuses a folder named in the wrong case", async () => {
    await mkdir(path.join(dir, "drafts"));
    await copyFile(
      path.join(dir, "good.json"),
      path.join(dir, "drafts", "x.pack.json"),
    );

    const shelf = await loadShelf(
      [
        source("folder", "Drafts/x.pack.json"),
        source("exact", "drafts/x.pack.json"),
      ],
      { packsDir: dir, readFamilyLibrary: noFamily },
    );

    expect(shelf.packs.map((p) => p.sourceId)).toEqual(["exact"]);
    expect(shelf.errors).toEqual([
      {
        sourceId: "folder",
        reason:
          'path "Drafts/x.pack.json": "Drafts" is "drafts" on disk; names must match exactly, as prod\'s filesystem reads them',
        issues: [],
      },
    ]);
  });

  // B3 review 3: macOS also matches a name through full case folding (ß is
  // ss) and Unicode normalisation (an NFC é finds an NFD file), and follows a
  // link whose target text is in the wrong case. Linux does none of these.
  it("refuses a name macOS matches and Linux doesn't, naming the file on disk", async () => {
    const good = path.join(dir, "good.json");
    await copyFile(good, path.join(dir, "straße.json"));
    await copyFile(good, path.join(dir, "café.json"));
    await symlink("GOOD.json", path.join(dir, "shout.json"));

    const shelf = await loadShelf(
      [
        source("fold", "STRASSE.json"),
        source("nfc", "café.json"),
        source("link", "shout.json"),
        source("good", "good.json"),
      ],
      { packsDir: dir, readFamilyLibrary: noFamily },
    );

    const exactly =
      "names must match exactly, as prod's filesystem reads them";
    expect(shelf.packs.map((p) => p.sourceId)).toEqual(["good"]);
    expect(shelf.errors).toEqual([
      {
        sourceId: "fold",
        reason: `path "STRASSE.json": "STRASSE.json" is "straße.json" on disk; ${exactly}`,
        issues: [],
      },
      {
        sourceId: "nfc",
        reason: `path "café.json": "café.json" is "café.json" on disk; ${exactly}`,
        issues: [],
      },
      {
        sourceId: "link",
        reason: `path "shout.json": "GOOD.json" through the link "shout.json" is "good.json" on disk; ${exactly}`,
        issues: [],
      },
    ]);
  });

  // A name macOS opens but no on-disk name answers to, even folded: capital
  // sharp s (ẞ) finds ß on macOS, and Linux has no such file. Without an
  // exact name the source is missing, whatever this machine would open.
  it("refuses a name with no exact match as not found, though macOS opens it", async () => {
    await copyFile(path.join(dir, "good.json"), path.join(dir, "ß.json"));

    const shelf = await loadShelf(
      [source("sharp", "ẞ.json"), source("good", "good.json")],
      { packsDir: dir, readFamilyLibrary: noFamily },
    );

    expect(shelf.packs.map((p) => p.sourceId)).toEqual(["good"]);
    expect(shelf.errors).toEqual([
      {
        sourceId: "sharp",
        reason: "file not found: packs/ẞ.json",
        issues: [],
      },
    ]);
  });

  it("refuses a source whose id an earlier source already has, without reading its file", async () => {
    const shelf = await loadShelf(
      [source("one", "good.json"), source("one", "drafts/gone.pack.json")],
      { packsDir: dir, readFamilyLibrary: noFamily },
    );

    expect(shelf.packs.map((p) => p.sourceId)).toEqual(["one"]);
    expect(shelf.errors).toEqual([
      {
        sourceId: "one",
        reason:
          'duplicate source id "one": an earlier source already has it (path "drafts/gone.pack.json" not read)',
        issues: [],
      },
    ]);
    expect(loggedLines()).toEqual([
      '[shelf] source one: duplicate source id "one": an earlier source already has it (path "drafts/gone.pack.json" not read)',
    ]);
  });

  it("refuses a duplicate source id even when the libraries are unreadable", async () => {
    await writeFile(path.join(dir, "states.json"), "[{]");

    const shelf = await loadShelf(
      [source("one", "good.json"), source("one", "good.json")],
      { packsDir: dir, readFamilyLibrary: noFamily },
    );

    expect(shelf.packs).toEqual([]);
    expect(shelf.errors.map((e) => e.reason)).toEqual([
      "libraries unreadable",
      'duplicate source id "one": an earlier source already has it (path "good.json" not read)',
    ]);
  });

  it("loads the first of two packs with one id and refuses the later, naming both", async () => {
    await writeFile(
      path.join(dir, "again.json"),
      JSON.stringify(await fannie()),
    );

    const shelf = await loadShelf(
      [source("first", "good.json"), source("second", "again.json")],
      { packsDir: dir, readFamilyLibrary: noFamily },
    );

    expect(shelf.packs.map((p) => p.sourceId)).toEqual(["first"]);
    expect(shelf.errors).toEqual([
      {
        sourceId: "second",
        packId: "fannie-farmer-1896",
        reason:
          'duplicate pack id "fannie-farmer-1896": source "first" already loaded it',
        issues: [],
      },
    ]);
    expect(loggedLines()).toEqual([
      '[shelf] source second (pack fannie-farmer-1896): duplicate pack id "fannie-farmer-1896": source "first" already loaded it',
    ]);
  });

  it("isolates a pack with a dangling library ref", async () => {
    const pack = { ...(await fannie()), id: "dangling" };
    pack.recipes[0].steps[0].technique_refs = ["commons:no-such-technique"];
    await writeFile(path.join(dir, "dangling.json"), JSON.stringify(pack));

    const shelf = await loadShelf(
      [source("dangling", "dangling.json"), source("good", "good.json")],
      { packsDir: dir, readFamilyLibrary: noFamily },
    );

    expect(shelf.packs.map((p) => p.sourceId)).toEqual(["good"]);
    expect(shelf.errors).toEqual([
      {
        sourceId: "dangling",
        packId: "dangling",
        reason: "refs don't resolve against the platform libraries",
        issues: [
          {
            path: "recipes.0.steps.0.technique_refs",
            message:
              'technique_ref "commons:no-such-technique" not found in the commons library',
          },
        ],
      },
    ]);
    expect(logged).toHaveBeenCalledOnce();
    expect(logged).toHaveBeenCalledWith(
      "[shelf] source dangling (pack dangling): refs don't resolve against the platform libraries",
      shelf.errors[0].issues,
    );
  });

  it("errors every source when a library is unreadable, loading none", async () => {
    await writeFile(path.join(dir, "states.json"), "[{]");

    const shelf = await loadShelf(
      [source("good", "good.json"), source("also", "good.json")],
      { packsDir: dir, readFamilyLibrary: noFamily },
    );

    expect(shelf.packs).toEqual([]);
    const libraryError = {
      reason: "libraries unreadable",
      issues: [
        {
          path: "states.json",
          message: expect.stringMatching(/^not valid JSON: /),
        },
      ],
    };
    expect(shelf.errors).toEqual([
      { sourceId: "good", ...libraryError },
      { sourceId: "also", ...libraryError },
    ]);
    expect(loggedLines()).toEqual([
      "[shelf] source good: libraries unreadable",
      "[shelf] source also: libraries unreadable",
    ]);
  });

  it("names the library issues when a library parses as JSON but not as a library", async () => {
    await writeFile(
      path.join(dir, "commons.json"),
      JSON.stringify([{ id: "commons:x" }]),
    );

    const shelf = await loadShelf([source("good", "good.json")], {
      packsDir: dir,
      readFamilyLibrary: noFamily,
    });

    expect(shelf.packs).toEqual([]);
    expect(shelf.errors).toHaveLength(1);
    expect(shelf.errors[0].reason).toBe("libraries unreadable");
    expect(shelf.errors[0].issues.length).toBeGreaterThan(0);
    for (const issue of shelf.errors[0].issues) {
      expect(issue.path).toMatch(/^commons\.json:0\./);
    }
    expect(logged).toHaveBeenCalledOnce();
    expect(logged).toHaveBeenCalledWith(
      "[shelf] source good: libraries unreadable",
      shelf.errors[0].issues,
    );
  });
});

describe("the family book's chapters and the recipes that didn't come through (slice S)", () => {
  let dir: string;
  let logged: MockInstance<typeof console.error>;

  beforeEach(async () => {
    dir = await mkdtemp(path.join(tmpdir(), "shelf-chapters-"));
    for (const file of ["commons.json", "states.json"]) {
      await copyFile(path.join(PACKS_DIR, file), path.join(dir, file));
    }
    logged = vi.spyOn(console, "error").mockImplementation(() => undefined);
  });

  afterEach(async () => {
    logged.mockRestore();
    await rm(dir, { recursive: true, force: true });
  });

  async function load(rows: DocRecipeRow[]) {
    return loadShelf([familySource("family")], { packsDir: dir, readFamilyLibrary: reading(rows) });
  }

  const chapters = (shelf: Awaited<ReturnType<typeof load>>) =>
    shelf.household!.chapters.map((c) => [c.title, c.rows.map((r) => (r.missing ? `${r.id}:${r.missing}` : r.id))]);

  it("emits the Doc's category tabs as sections, in Doc order, and orders recipes[] to match", async () => {
    const shelf = await load([
      docRow("dal", { category: "indian", categoryTitle: "Indian", docPosition: 0 }),
      docRow("mole", { category: "seasonal specials", categoryTitle: "Seasonal Specials", docPosition: 1 }),
      docRow("chana", { category: "indian", categoryTitle: "Indian", docPosition: 2 }),
    ]);
    const pack = shelf.packs[0]!.pack;
    expect(pack.sections).toEqual([
      { title: "Indian", recipe_ids: ["dal", "chana"] },
      { title: "Seasonal Specials", recipe_ids: ["mole"] },
    ]);
    expect(pack.recipes.map((r) => r.id)).toEqual(["dal", "chana", "mole"]);
    expect(shelf.household!.state).toBe("ok");
    expect(shelf.errors).toEqual([]);
  });

  it("falls back to the lowercase category for a row synced before the title was kept", async () => {
    const shelf = await load([docRow("dal", { category: "indian", categoryTitle: null, docPosition: null })]);
    expect(shelf.packs[0]!.pack.sections).toEqual([{ title: "indian", recipe_ids: ["dal"] }]);
  });

  it("puts a recipe in no chapter after the last chapter, in no section", async () => {
    const shelf = await load([
      docRow("loose", { category: null, categoryTitle: null, docPosition: 0 }),
      docRow("dal", { category: "indian", categoryTitle: "Indian", docPosition: 1 }),
    ]);
    const pack = shelf.packs[0]!.pack;
    expect(pack.sections).toEqual([{ title: "Indian", recipe_ids: ["dal"] }]);
    expect(pack.recipes.map((r) => r.id)).toEqual(["dal", "loose"]);
    expect(chapters(shelf)).toEqual([
      ["Indian", ["dal"]],
      [null, ["loose"]],
    ]);
  });

  it("reads a chapter title of only invisible format characters as no chapter, and the book still loads", async () => {
    const shelf = await load([
      docRow("dal", { category: "indian", categoryTitle: "Indian", docPosition: 0 }),
      docRow("zw", { category: "\u200b", categoryTitle: "\u200b\u200d ", docPosition: 1 }),
      docRow("chef", { category: "chef's picks", categoryTitle: "👨\u200d🍳 Chef's picks", docPosition: 2 }),
    ]);
    expect(shelf.errors).toEqual([]);
    // A title that shows anything is kept as written, its emoji's ZWJ whole.
    expect(shelf.packs[0]!.pack.sections).toEqual([
      { title: "Indian", recipe_ids: ["dal"] },
      { title: "👨\u200d🍳 Chef's picks", recipe_ids: ["chef"] },
    ]);
    expect(chapters(shelf)).toEqual([
      ["Indian", ["dal"]],
      ["👨\u200d🍳 Chef's picks", ["chef"]],
      [null, ["zw"]],
    ]);
  });

  it("makes two tabs of one name, in any case, one chapter where it first appears", async () => {
    const shelf = await load([
      docRow("dal", { category: "indian", categoryTitle: "Indian", docPosition: 0 }),
      docRow("cake", { category: "baking", categoryTitle: "Baking", docPosition: 1 }),
      docRow("paneer", { category: "indian", categoryTitle: "indian", docPosition: 2 }),
    ]);
    expect(chapters(shelf)).toEqual([
      ["Indian", ["dal", "paneer"]],
      ["Baking", ["cake"]],
    ]);
  });

  it("keeps the reader's order inside a chapter, so a row with no place sorts last", async () => {
    // The reader sorts by place, rows with none last by name.
    const shelf = await load([
      docRow("dal", { categoryTitle: "Indian", docPosition: 0 }),
      docRow("chana", { categoryTitle: "Indian", docPosition: 1 }),
      docRow("minced-lamb", { categoryTitle: "Indian", docPosition: null }),
    ]);
    expect(chapters(shelf)).toEqual([["Indian", ["dal", "chana", "minced-lamb"]]]);
  });

  it("names a refused recipe and a failed extraction in their chapters, in place", async () => {
    const shelf = await load([
      docRow("dal", { categoryTitle: "Indian", docPosition: 0 }),
      docRow("goat-curry", { name: "Goat curry", categoryTitle: "Indian", docPosition: 1, serves: null }),
      docRow("crackers", {
        name: "Seeded rye crackers",
        categoryTitle: "Baking",
        docPosition: 2,
        ingredients: null,
        steps: null,
        extractionError: "No recipe content could be extracted from this section.",
      }),
      docRow("cake", { categoryTitle: "Baking", docPosition: 3 }),
    ]);
    expect(chapters(shelf)).toEqual([
      ["Indian", ["dal", "goat-curry:refused"]],
      ["Baking", ["crackers:unread", "cake"]],
    ]);
    expect(shelf.packs[0]!.pack.recipes.map((r) => r.id)).toEqual(["dal", "cake"]);
    expect(shelf.errors.map((e) => [e.recipeId, e.recipeName, e.section, e.missing, e.reason])).toEqual([
      ["goat-curry", "Goat curry", "Indian", "refused", "not a valid recipe (Pack Format v0.7)"],
      [
        "crackers",
        "Seeded rye crackers",
        "Baking",
        "unread",
        "extraction failed on the last Refresh: No recipe content could be extracted from this section.",
      ],
    ]);
    // The refusal's own words stay in the log, never on the row (S-D8).
    expect(shelf.errors[0]!.issues.map((i) => i.message)).toContain(
      "no serving count: the recipe states none, and Sous hasn't estimated one yet",
    );
  });

  it("keeps a chapter whose recipes all failed in the layout, with no section", async () => {
    const shelf = await load([
      docRow("dal", { categoryTitle: "Indian", docPosition: 0 }),
      docRow("crackers", { categoryTitle: "Baking", docPosition: 1, extractionError: "nope" }),
    ]);
    expect(shelf.packs[0]!.pack.sections).toEqual([{ title: "Indian", recipe_ids: ["dal"] }]);
    expect(chapters(shelf)).toEqual([
      ["Indian", ["dal"]],
      ["Baking", ["crackers:unread"]],
    ]);
  });

  it("lays out an empty library as empty, with no sync date", async () => {
    const shelf = await load([]);
    expect(shelf.household).toEqual({ state: "empty", syncedAt: null, chapters: [] });
  });

  it("lays out a library where nothing converts as empty, every row named in place", async () => {
    const shelf = await load([
      docRow("a", { categoryTitle: "Indian", docPosition: 0, serves: null }),
      docRow("b", { categoryTitle: "Indian", docPosition: 1, extractionError: "nope" }),
    ]);
    expect(shelf.packs).toEqual([]);
    expect(shelf.household!.state).toBe("empty");
    expect(shelf.household!.syncedAt).toEqual(new Date("2026-10-01T12:00:00Z"));
    expect(chapters(shelf)).toEqual([["Indian", ["a:refused", "b:unread"]]]);
  });

  it("lays out an unreadable library as unreadable", async () => {
    const shelf = await loadShelf([familySource("family")], {
      packsDir: dir,
      readFamilyLibrary: () => Promise.reject(new Error("connection refused")),
    });
    expect(shelf.household).toEqual({ state: "unreadable", syncedAt: null, chapters: [] });
    expect(shelf.errors.map((e) => e.reason)).toEqual(["family library unreadable: connection refused"]);
  });

  it("dates the household by its newest sync", async () => {
    const shelf = await load([
      docRow("dal", { syncedAt: new Date("2026-10-02T12:00:00Z") }),
      docRow("chana", { syncedAt: new Date("2026-10-04T18:00:00Z") }),
    ]);
    expect(shelf.household!.syncedAt).toEqual(new Date("2026-10-04T18:00:00Z"));
  });
});
