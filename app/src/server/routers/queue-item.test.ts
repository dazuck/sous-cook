/**
 * `getKitchenQueueItem` reading a `pack:` row natively (slice B5d, B5.md
 * §B5d D1–D2), through the router, over the repo's real packs/ and registry.
 * The DB edges are mocked: the queue row's read and the family library.
 */

import { readFileSync } from "node:fs";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi, type MockInstance } from "vitest";
import { parsePack } from "@sous/pack";

vi.mock("../../lib/kitchen-queue", async (importOriginal) => ({
  ...(await importOriginal<typeof import("../../lib/kitchen-queue")>()),
  getQueueItem: vi.fn(),
}));

vi.mock("../../lib/recipe-sync", async (importOriginal) => ({
  ...(await importOriginal<typeof import("../../lib/recipe-sync")>()),
  readFamilyLibrary: vi.fn(),
}));

vi.mock("../../lib/shelf/load", async (importOriginal) => {
  const original = await importOriginal<typeof import("../../lib/shelf/load")>();
  return { ...original, loadAppPackFiles: vi.fn(original.loadAppPackFiles) };
});

import { getQueueItem } from "../../lib/kitchen-queue";
import { packRecipeToQueueData } from "../../lib/pack-convert/to-queue";
import { readFamilyLibrary } from "../../lib/recipe-sync";
import { loadAppPackFiles, PACKS_DIR } from "../../lib/shelf/load";
import { callerFor } from "../../lib/__tests__/kitchens";

const HOME = { id: "00000000-0000-4000-8000-000000000001", slug: "home" };
const caller = callerFor(HOME);
const QUEUE_ID = "4a1c2a9e-5b7d-4e8f-9a0b-1c2d3e4f5a6b";

function fannieRow(recipeId: string) {
  const pack = parsePack(JSON.parse(readFileSync(path.join(PACKS_DIR, "drafts/fannie-farmer-1896.pack.json"), "utf8")));
  if (!pack.ok) throw new Error("fannie");
  const recipe = pack.value.recipes.find((r) => r.id === recipeId)!;
  const projected = packRecipeToQueueData(recipe, pack.value.id);
  if (!projected.ok) throw new Error("projection");
  const { recipeData, servesEstimate } = projected.projection;
  return {
    id: QUEUE_ID,
    recipeData,
    servesEstimate: servesEstimate?.count ?? null,
    servesEstimateBasis: servesEstimate?.basis ?? null,
  };
}

let info: MockInstance<typeof console.info>;
beforeEach(() => {
  vi.clearAllMocks();
  vi.mocked(readFamilyLibrary).mockRejectedValue(new Error("the family library must not be read"));
  info = vi.spyOn(console, "info").mockImplementation(() => undefined);
});
afterEach(() => info.mockRestore());

describe("getKitchenQueueItem", () => {
  it("reads a pack row natively from the pack files alone, never the family library, logging its notes", async () => {
    vi.mocked(getQueueItem).mockResolvedValue(fannieRow("thin-white-sauce") as never);
    const item = await caller.getKitchenQueueItem({ queueId: QUEUE_ID });
    expect(item?.reading).toBe("native");
    expect(item?.packRecipe?.steps[5]?.type).toBe("checkpoint");
    expect(item?.library.states.map((s) => s.id)).toContain("state:sauce-smooth-and-glossy");
    expect(item?.sourcePack).toEqual({
      packId: "fannie-farmer-1896",
      packTitle: "The Boston Cooking-School Cook Book",
      creatorName: "Fannie Merritt Farmer",
      recipeId: "thin-white-sauce",
      recipeTitle: "Thin White Sauce",
      isAdapted: false,
    });
    expect(readFamilyLibrary).not.toHaveBeenCalled();
    expect(info).toHaveBeenCalledWith(expect.stringMatching(new RegExp(`^\\[queue\\] item ${QUEUE_ID}: read natively: pepper`)));
  });

  it("reads a drifted pack row as its projection and logs why", async () => {
    const row = fannieRow("waffles");
    row.recipeData = { ...row.recipeData, name: "Waffles, edited" };
    vi.mocked(getQueueItem).mockResolvedValue(row as never);
    const item = await caller.getKitchenQueueItem({ queueId: QUEUE_ID });
    expect(item?.reading).toBe("projection");
    expect(item?.scales).toBe(false);
    expect(item?.packRecipe?.steps.every((s) => s.type === "action")).toBe(true);
    expect(info).toHaveBeenCalledWith(
      `[queue] item ${QUEUE_ID}: reads its projection: fannie-farmer-1896/waffles changed since it was queued (name); the serving count stays at the recipe's`,
    );
  });

  it("reads an adapted pack row (pack-adapted:) as adapted, preserving matched checkpoints and sourcePack metadata", async () => {
    const row = fannieRow("waffles");
    row.recipeData = {
      ...row.recipeData,
      source: "pack-adapted:fannie-farmer-1896/waffles",
      name: "Waffles, edited",
    };
    vi.mocked(getQueueItem).mockResolvedValue(row as never);
    const item = await caller.getKitchenQueueItem({ queueId: QUEUE_ID });
    expect(item?.reading).toBe("adapted");
    expect(item?.scales).toBe(true);
    expect(item?.sourcePack?.isAdapted).toBe(true);
    expect(item?.packRecipe?.steps.some((s) => s.type === "checkpoint")).toBe(true);
    expect(info).toHaveBeenCalledWith(
      `[queue] item ${QUEUE_ID}: read as adapted pack recipe: fannie-farmer-1896/waffles adapted (name)`,
    );
  });

  it("reads a pack row whose serving estimate drifted as its projection and logs why", async () => {
    const row = { ...fannieRow("waffles"), servesEstimate: 6 };
    vi.mocked(getQueueItem).mockResolvedValue(row as never);
    const item = await caller.getKitchenQueueItem({ queueId: QUEUE_ID });
    expect(item?.reading).toBe("projection");
    expect(item?.scales).toBe(false);
    expect(item?.packRecipe?.steps.every((s) => s.type === "action")).toBe(true);
    expect(info).toHaveBeenCalledWith(
      `[queue] item ${QUEUE_ID}: reads its projection: fannie-farmer-1896/waffles: the row's serving estimate isn't the pack's; the serving count stays at the recipe's`,
    );
  });

  it("never loads the pack files for a household row", async () => {
    vi.mocked(getQueueItem).mockResolvedValue({
      id: QUEUE_ID,
      recipeData: { name: "Dal", ingredients: [{ item: "lentils", amount: "1", unit: "cup" }], steps: ["Simmer."], serves: 2 },
      servesEstimate: null,
      servesEstimateBasis: null,
    } as never);
    const item = await caller.getKitchenQueueItem({ queueId: QUEUE_ID });
    expect(item?.reading).toBe("projection");
    expect(item?.library).toEqual({ states: [], commons: [] });
    expect(loadAppPackFiles).not.toHaveBeenCalled();
  });
});
