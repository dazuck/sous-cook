/**
 * The Cookpacks procedures (slice S, S-D14): getShelf, getPack and
 * queueFromPack, through the router (`createCaller`), over the repo's real
 * packs/ and the real registry, converter and projection. The DB edges are
 * mocked: the family library's read, the ideas cache and the queue insert.
 * The recipe-library and ideas hooks read connected, as a kitchen with both
 * has them; the last block switches them off, as the app ships.
 */

import { copyFile, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi, type MockInstance } from "vitest";
import type { ShelfSource } from "../../lib/shelf/registry";

vi.mock("next/server", async (importOriginal) => ({
  ...(await importOriginal<typeof import("next/server")>()),
  after: vi.fn(),
}));

vi.mock("../../lib/hooks/connected", async () => {
  const { HOOK_NAMES } = await import("../../lib/hooks/types");
  return { connected: Object.fromEntries(HOOK_NAMES.map((name) => [name, true])) };
});

vi.mock("../../lib/kitchen-queue", async (importOriginal) => ({
  ...(await importOriginal<typeof import("../../lib/kitchen-queue")>()),
  addToKitchenQueue: vi.fn(),
  prepareQueueItemInBackground: vi.fn(),
}));

vi.mock("../../lib/recipe-sync", async (importOriginal) => ({
  ...(await importOriginal<typeof import("../../lib/recipe-sync")>()),
  readFamilyLibrary: vi.fn(),
  getDocRecipeBySlug: vi.fn(),
  syncRecipesFromDoc: vi.fn(),
}));

vi.mock("../../lib/recipe-ideas", async (importOriginal) => ({
  ...(await importOriginal<typeof import("../../lib/recipe-ideas")>()),
  cachedIdeasCount: vi.fn(),
  getRecipeIdeas: vi.fn(),
  saveRecipeIdea: vi.fn(),
}));

// The shelf's sources and packs dir, so a case can put a broken pack file on it.
const shelfAt: { sources?: readonly ShelfSource[]; packsDir?: string } = {};
vi.mock("../../lib/shelf/load", async (importOriginal) => {
  const original = await importOriginal<typeof import("../../lib/shelf/load")>();
  return {
    ...original,
    loadAppShelf: (
      kitchenId: string,
      options?: Parameters<typeof original.loadAppShelf>[1],
    ) => original.loadAppShelf(kitchenId, { ...options, ...shelfAt }),
  };
});

import { after } from "next/server";
import { addToKitchenQueue, prepareQueueItemInBackground } from "../../lib/kitchen-queue";
import { connected } from "../../lib/hooks/connected";
import { getDocRecipeBySlug, readFamilyLibrary, syncRecipesFromDoc, type DocRecipeRow } from "../../lib/recipe-sync";
import { cachedIdeasCount, getRecipeIdeas, saveRecipeIdea } from "../../lib/recipe-ideas";
import { PACK_PLANS_DIR, PACKS_DIR } from "../../lib/shelf/load";
import { readPackPlanFile } from "../../lib/pack-cook-plans";
import { callerFor } from "../../lib/__tests__/kitchens";

const HOME = { id: "00000000-0000-4000-8000-000000000001", slug: "home" };
const caller = callerFor(HOME);
const QUEUE_ID = "3f1c2a9e-5b7d-4e8f-9a0b-1c2d3e4f5a6b";

function docRow(slug: string, over: Partial<DocRecipeRow> = {}): DocRecipeRow {
  return {
    id: `00000000-0000-4000-8000-${slug.padStart(12, "0").slice(-12)}`,
    kitchenId: HOME.id,
    docSlug: slug,
    name: slug,
    category: "indian",
    categoryTitle: "Indian",
    docPosition: 0,
    ingredients: [{ item: "red lentils", amount: "1", unit: "cup" }],
    steps: ["Rinse the lentils.", "Simmer 20 minutes."],
    estimatedTime: { total: 40 },
    serves: 4,
    tags: null,
    notes: null,
    stepIngredients: [[0], [0]],
    rawDocText: slug,
    extractionError: null,
    syncedAt: new Date("2026-10-04T18:00:00Z"),
    servesEstimate: null,
    servesEstimateBasis: null,
    servesEstimateSourceHash: null,
    cookPlan: null,
    cookPlanError: null,
    cookPlanSourceHash: null,
    cookPlanStamp: null,
    ...over,
  };
}

let logged: MockInstance<typeof console.error>;
let info: MockInstance<typeof console.info>;
beforeEach(() => {
  vi.clearAllMocks();
  connected["recipe-library"] = true;
  connected.ideas = true;
  delete shelfAt.sources;
  delete shelfAt.packsDir;
  vi.mocked(readFamilyLibrary).mockResolvedValue([
    docRow("dal"),
    docRow("goat", { name: "Goat curry", docPosition: 1, serves: null }),
  ]);
  vi.mocked(cachedIdeasCount).mockResolvedValue(14);
  vi.mocked(addToKitchenQueue).mockResolvedValue({ id: QUEUE_ID });
  logged = vi.spyOn(console, "error").mockImplementation(() => undefined);
  info = vi.spyOn(console, "info").mockImplementation(() => undefined);
});
afterEach(() => {
  logged.mockRestore();
  info.mockRestore();
});

describe("getShelf", () => {
  it("draws the household first, then Fannie, with the ideas count", async () => {
    const shelf = await caller.getShelf();
    expect(shelf.household).toMatchObject({
      id: "household-book",
      state: "ok",
      cookable: 1,
      missing: 1,
      contents: [{ anchor: "indian", title: "Indian", count: 1 }],
    });
    expect(shelf.creators.map((c) => [c.id, c.recipes, c.cloth])).toEqual([["fannie-farmer-1896", 5, "walnut"]]);
    expect(shelf.ideas).toBe(14);
  });

  it("leaves a broken pack file off the shelf, logged, and the rest stand", async () => {
    const dir = await mkdtemp(path.join(tmpdir(), "shelf-procs-"));
    try {
      for (const file of ["commons.json", "states.json"]) await copyFile(path.join(PACKS_DIR, file), path.join(dir, file));
      await writeFile(path.join(dir, "broken.json"), JSON.stringify({ id: "broken", title: "Broken", recipes: [] }));
      shelfAt.packsDir = dir;
      shelfAt.sources = [
        { id: "household-book", source: { type: "family-doc" } },
        { id: "broken", source: { type: "pack-file", path: "broken.json" } },
      ];
      const shelf = await caller.getShelf();
      expect(shelf.household?.state).toBe("ok");
      expect(shelf.creators).toEqual([]);
      expect(logged.mock.calls.map((c) => String(c[0]))).toContain(
        "[shelf] source broken (pack broken): not a valid pack (Pack Format v0.7)",
      );
    } finally {
      await rm(dir, { recursive: true, force: true });
    }
  });

  it("keeps the household first while the library is empty", async () => {
    vi.mocked(readFamilyLibrary).mockResolvedValue([]);
    const shelf = await caller.getShelf();
    expect(shelf.household).toMatchObject({ state: "empty", cookable: 0, syncedAt: null });
    expect(shelf.creators).toHaveLength(1);
  });

  it("says the family book can't be read on a DB error, the creator packs still there", async () => {
    vi.mocked(readFamilyLibrary).mockRejectedValue(new Error("connection refused"));
    vi.mocked(cachedIdeasCount).mockRejectedValue(new Error("connection refused"));
    const shelf = await caller.getShelf();
    expect(shelf.household?.state).toBe("unreadable");
    expect(shelf.creators).toHaveLength(1);
    expect(shelf.ideas).toBeNull();
  });
});

describe("getPack", () => {
  it("draws the household book in its chapters, a refused recipe named", async () => {
    const pack = (await caller.getPack({ packId: "household-book" }))!;
    expect(pack.chapters.map((c) => [c.title, c.rows.map((r) => [r.title, r.missing])])).toEqual([
      ["Indian", [["dal", null], ["Goat curry", "refused"]]],
    ]);
    expect(pack.chapters[0]!.rows[0]).toMatchObject({ times: ["Recipe says 40 min"], serves: "serves 4" });
  });

  it("draws Fannie flat, each count marked as Sous's estimate", async () => {
    const pack = (await caller.getPack({ packId: "fannie-farmer-1896" }))!;
    expect(pack).toMatchObject({ kind: "creator", cookable: 5, cloth: "walnut" });
    expect(pack.chapters).toHaveLength(1);
    expect(pack.chapters[0]!.rows.map((r) => [r.title, r.serves])).toContainEqual([
      "Thin White Sauce",
      "serves 4 (Sous's estimate)",
    ]);
  });

  it("sends no steps or ingredients", async () => {
    for (const packId of ["household-book", "fannie-farmer-1896"]) {
      const json = JSON.stringify(await caller.getPack({ packId }));
      expect(json).not.toMatch(/ingredient|"steps"|Rinse the lentils|Scald the milk/i);
    }
  });

  it("knows no book of an unknown id", async () => {
    expect(await caller.getPack({ packId: "nope" })).toBeNull();
  });
});

describe("queueFromPack: a pack file", () => {
  it("queues Fannie's Thin White Sauce as its projection, its estimate and reviewed plan beside it, deriving nothing", async () => {
    const result = await caller.queueFromPack({
      packId: "fannie-farmer-1896",
      recipeId: "thin-white-sauce",
    });
    expect(result).toEqual({ id: QUEUE_ID });
    const [queuedKitchenId, queued] = vi.mocked(addToKitchenQueue).mock.calls[0]!;
    expect(queuedKitchenId).toBe(HOME.id);
    expect(queued.recipeData).toMatchObject({
      name: "Thin White Sauce",
      source: "pack:fannie-farmer-1896/thin-white-sauce",
      ingredients: expect.arrayContaining([{ item: "Butter", amount: "2", unit: "tbsp" }]),
    });
    expect(queued.servesEstimate).toEqual({
      count: 4,
      basis: "From the pack fannie-farmer-1896: it gives 4 as Sous's estimate.",
    });
    // What it dropped is logged, never shown.
    expect(String(info.mock.calls[0]![0])).toBe("[queue] fannie-farmer-1896/thin-white-sauce queued without:");
    // The plan reviewed into app/pack-plans/ travels with it (slice P).
    const read = await readPackPlanFile(PACK_PLANS_DIR, "fannie-farmer-1896");
    expect(read.ok && read.file?.recipes["thin-white-sauce"]?.plan).toBeTruthy();
    expect(queued.plan).toEqual({
      cookPlan: read.ok ? read.file?.recipes["thin-white-sauce"]?.plan : undefined,
      cookPlanError: null,
    });
    expect(after).not.toHaveBeenCalled();
    expect(prepareQueueItemInBackground).not.toHaveBeenCalled();
  });

  it("refuses a recipe whose projection wouldn't read back, queueing nothing", async () => {
    const dir = await mkdtemp(path.join(tmpdir(), "shelf-procs-"));
    try {
      for (const file of ["commons.json", "states.json"]) await copyFile(path.join(PACKS_DIR, file), path.join(dir, file));
      await writeFile(
        path.join(dir, "odd.json"),
        JSON.stringify({
          id: "odd",
          title: "Odd",
          version: "1",
          creator: { name: "C" },
          recipes: [
            {
              id: "thyme",
              title: "Thyme",
              serves_base: 2,
              ingredients: [{ id: "t", name: "sprigs of thyme", qty_canonical: { as_written: "2" } }],
              steps: [{ id: "s", type: "action", text: "Strip it.", ingredient_refs: ["t"] }],
            },
          ],
        }),
      );
      shelfAt.packsDir = dir;
      shelfAt.sources = [{ id: "odd", source: { type: "pack-file", path: "odd.json" } }];
      await expect(caller.queueFromPack({ packId: "odd", recipeId: "thyme" })).rejects.toMatchObject({
        code: "UNPROCESSABLE_CONTENT",
      });
      expect(addToKitchenQueue).not.toHaveBeenCalled();
      expect(String(logged.mock.calls.at(-1)![0])).toBe("[queue] odd/thyme doesn't round-trip, not queued:");
    } finally {
      await rm(dir, { recursive: true, force: true });
    }
  });

  it("knows no recipe of an unknown pack or id", async () => {
    await expect(
      caller.queueFromPack({ packId: "fannie-farmer-1896", recipeId: "nope" }),
    ).rejects.toMatchObject({ code: "NOT_FOUND" });
    await expect(caller.queueFromPack({ packId: "nope", recipeId: "x" })).rejects.toMatchObject({
      code: "NOT_FOUND",
    });
    expect(addToKitchenQueue).not.toHaveBeenCalled();
  });
});

describe("with no recipe library connected (as the app ships)", () => {
  beforeEach(() => {
    connected["recipe-library"] = false;
  });

  it("draws the shelf with no household book, the pack files alone, and reads no library", async () => {
    const shelf = await caller.getShelf();
    expect(shelf.household).toBeNull();
    expect(shelf.creators.map((c) => c.id)).toEqual(["fannie-farmer-1896"]);
    expect(shelf.ideas).toBe(14);
    expect(readFamilyLibrary).not.toHaveBeenCalled();
  });

  it("knows no household book: its view and a send from it are NOT_FOUND, and a pack file's still work", async () => {
    await expect(caller.getPack({ packId: "household-book" })).rejects.toMatchObject({ code: "NOT_FOUND" });
    await expect(
      caller.queueFromPack({ packId: "household-book", recipeId: "dal" }),
    ).rejects.toMatchObject({ code: "NOT_FOUND" });
    expect(getDocRecipeBySlug).not.toHaveBeenCalled();
    expect(addToKitchenQueue).not.toHaveBeenCalled();

    expect(await caller.getPack({ packId: "fannie-farmer-1896" })).toMatchObject({ kind: "creator", cookable: 5 });
    expect(
      await caller.queueFromPack({ packId: "fannie-farmer-1896", recipeId: "thin-white-sauce" }),
    ).toEqual({ id: QUEUE_ID });
    expect(readFamilyLibrary).not.toHaveBeenCalled();
  });

  it("has no library to report on or to Refresh", async () => {
    expect(await caller.libraryPlanReport()).toEqual({ needFixes: [], pending: 0, total: 0 });
    await expect(caller.syncRecipes()).rejects.toMatchObject({ code: "FORBIDDEN" });
    expect(syncRecipesFromDoc).not.toHaveBeenCalled();
  });
});

describe("with no ideas hook connected (as the app ships)", () => {
  beforeEach(() => {
    connected.ideas = false;
  });

  it("counts no ideas on the shelf, lists none, saves none, and reads neither the cache nor the list", async () => {
    expect((await caller.getShelf()).ideas).toBe(0);
    expect(await caller.getRecipeIdeas()).toEqual({ ideas: [], syncedAt: new Date(0), stale: false });
    expect(await caller.saveRecipeIdea({ text: "Miso cod" })).toEqual({ success: false });
    expect(cachedIdeasCount).not.toHaveBeenCalled();
    expect(getRecipeIdeas).not.toHaveBeenCalled();
    expect(saveRecipeIdea).not.toHaveBeenCalled();
  });
});
