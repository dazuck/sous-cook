import { fileURLToPath } from "node:url";
import { beforeAll, describe, expect, it } from "vitest";
import type { Pack, Recipe } from "@sous/pack";
import type { KitchenQueueRecipeData } from "../../../drizzle/schema";
import { storedIngredientLines } from "../kitchen/ingredient-display";
import { SHELF_SOURCES, loadPackFiles, type PackFiles } from "../shelf/registry";
import { stepAt } from "./ids";
import { compareReadings } from "./native-golden";
import { readPackRow, type QueueRowForRead } from "./native-read";
import { readQueueItem, readQueueRecipe } from "./queue-recipe";
import { packRecipeToQueueData } from "./to-queue";

const PACKS_DIR = fileURLToPath(new URL("../../../../packs/", import.meta.url));
const FANNIE = "fannie-farmer-1896";

let files: PackFiles;
let fannie: Pack;

beforeAll(async () => {
  files = await loadPackFiles(SHELF_SOURCES, { packsDir: PACKS_DIR });
  fannie = files.packs.find((p) => p.id === FANNIE)!;
});

/** A queue row as `queueFromPack` stores it for `recipe`. */
function rowFor(recipe: Recipe, id = "11111111-1111-4111-8111-111111111111", packId = FANNIE): QueueRowForRead {
  const projected = packRecipeToQueueData(recipe, packId);
  if (!projected.ok) throw new Error(`${recipe.id} doesn't project`);
  const { recipeData, servesEstimate } = projected.projection;
  return {
    id,
    recipeData: structuredClone(recipeData),
    servesEstimate: servesEstimate?.count ?? null,
    servesEstimateBasis: servesEstimate?.basis ?? null,
  };
}

function recipe(id: string): Recipe {
  return fannie.recipes.find((r) => r.id === id)!;
}

function native(row: QueueRowForRead) {
  const read = readPackRow(row, files);
  if (read?.reading !== "native") throw new Error(`not native: ${read === null ? "null" : read.why}`);
  return read;
}

describe("readPackRow: the native read behind the reverse guard (B5d D1–D5)", () => {
  it("reads all five Fannie recipes natively", () => {
    expect(fannie.recipes).toHaveLength(5);
    for (const r of fannie.recipes) expect(readPackRow(rowFor(r), files)?.reading).toBe("native");
  });

  it("re-keys to the stored indices: step-<i>, ing-<i>, refs mapped, the row's id, no variations (D3)", () => {
    const r = recipe("parker-house-rolls");
    const { packRecipe } = native(rowFor(r, "22222222-2222-4222-8222-222222222222"));
    expect(packRecipe.id).toBe("22222222-2222-4222-8222-222222222222");
    expect(packRecipe.steps.map((s) => s.id)).toEqual(r.steps.map((_, i) => `step-${String(i)}`));
    expect(packRecipe.ingredients.map((x) => x.id)).toEqual(r.ingredients.map((_, i) => `ing-${String(i)}`));
    expect(packRecipe.variations).toBeUndefined();
    const indexOf = new Map(r.ingredients.map((x, i) => [x.id, `ing-${String(i)}`]));
    r.steps.forEach((step, i) => {
      expect(packRecipe.steps[i]!.ingredient_refs ?? []).toEqual((step.ingredient_refs ?? []).map((ref) => indexOf.get(ref)));
      expect(packRecipe.steps[i]!.type).toBe(step.type);
      expect(packRecipe.steps[i]!.timer_sec ?? null).toBe(step.timer_sec ?? null);
    });
    expect(stepAt(packRecipe, 17)?.timer_sec).toBe(720);
  });

  it("reads the pepper with no amount, never 0.1 g, and notes it (D5)", () => {
    const read = native(rowFor(recipe("thin-white-sauce")));
    const pepper = read.packRecipe.ingredients.find((x) => x.name === "Pepper")!;
    expect(pepper.qty_canonical).toEqual({ unstated: true });
    const lines = storedIngredientLines(read.packRecipe, read.packRecipe.ingredients.length);
    expect(lines.find((l) => l?.name === "Pepper")).toEqual({ kind: "unstated", name: "Pepper" });
    expect(JSON.stringify(lines)).not.toContain("0.1");
    expect(read.notes.some((n) => n.startsWith("pepper (Pepper): no stated amount"))).toBe(true);
  });

  it("keeps a salt type beside a no-amount line", () => {
    const r = structuredClone(recipe("thin-white-sauce"));
    r.ingredients.find((x) => x.id === "pepper")!.qty_canonical = { mass_g: 0.1, salt_type: "flaky" };
    const pack = { ...structuredClone(fannie), recipes: [r] };
    const read = readPackRow(rowFor(r), { ...files, packs: [pack] });
    expect(read?.reading === "native" && read.packRecipe.ingredients.find((x) => x.name === "Pepper")!.qty_canonical).toEqual({
      unstated: true,
      salt_type: "flaky",
    });
  });

  it("computes no number from a canonical amount beside the stated one (verify round 1)", () => {
    // Fannie's milk states "1 cup" beside a canonical 240 ml (and 245 g):
    // the popover's conversions are the projection's, from the 1 cup.
    const row = rowFor(recipe("thin-white-sauce"));
    const read = native(row);
    const milk = storedIngredientLines(read.packRecipe, 5)[2];
    const projected = storedIngredientLines(readQueueRecipe(row).packRecipe!, 5)[2];
    expect(milk).toMatchObject({ kind: "amount", amount: "1 cup" });
    if (milk?.kind !== "amount" || projected?.kind !== "amount") throw new Error("not measured");
    expect(milk.conversions).toEqual(projected.conversions.filter((c) => c.unit !== "ml"));
    expect(milk.conversions.map((c) => c.unit)).not.toContain("g");
    // A canonical amount far from the stated one reaches no number either.
    const r = structuredClone(recipe("thin-white-sauce"));
    r.ingredients.find((x) => x.id === "butter")!.qty_canonical = { mass_g: 280 };
    const far = readPackRow(row, { ...files, packs: [{ ...structuredClone(fannie), recipes: [r] }] });
    if (far?.reading !== "native") throw new Error("not native");
    expect(JSON.stringify(storedIngredientLines(far.packRecipe, 5)[0])).not.toMatch(/"(?:280|9\.9|10)"/);
  });

  it("brings back the second stated amount: both in `stated`, the first shown (D5)", () => {
    const read = native(rowFor(recipe("thin-white-sauce")));
    const butter = storedIngredientLines(read.packRecipe, 5)[0];
    expect(butter).toMatchObject({ kind: "amount", amount: "2 tbsp", stated: [{ unit: "tbsp", value: "2" }, { unit: "g", value: "28" }] });
  });

  it("sends the library entries its refs name, and only those (D1)", () => {
    const read = native(rowFor(recipe("boiled-custard")));
    expect(read.library.states.map((s) => s.id)).toContain("state:custard-coats-the-spoon");
    expect(read.library.commons.map((c) => c.id)).toContain("commons:tempering-eggs");
    const named = new Set(read.packRecipe.steps.flatMap((s) => [...(s.state_refs ?? []), ...(s.technique_refs ?? [])]));
    for (const entry of [...read.library.states, ...read.library.commons]) expect(named.has(entry.id)).toBe(true);
  });

  it("notes a step that states a length but carries no timer_sec, and gives it none (D4)", () => {
    const r = structuredClone(recipe("parker-house-rolls"));
    r.steps.find((s) => s.id === "bake")!.timer_sec = null;
    const pack = { ...structuredClone(fannie), recipes: [r] };
    // The projection reads the text's timer, so the queued row is the same either way.
    const read = readPackRow(rowFor(recipe("parker-house-rolls")), { ...files, packs: [pack] });
    if (read?.reading !== "native") throw new Error("not native");
    expect(stepAt(read.packRecipe, 17)?.timer_sec ?? null).toBeNull();
    expect(read.notes).toContain("bake: its text states a length (720 s) but timer_sec is null; no timer");
  });

  describe("reads the projection, with the reason, when", () => {
    it("the pack changed since the row was queued", () => {
      const row = rowFor(recipe("waffles"));
      const drifted = structuredClone(fannie);
      drifted.recipes.find((r) => r.id === "waffles")!.steps[2]!.text = "Sift the flour, baking powder and salt twice.";
      const read = readPackRow(row, { ...files, packs: [drifted] });
      expect(read).toEqual({ reading: "projection", why: "fannie-farmer-1896/waffles changed since it was queued (steps[2])" });
    });

    it("the pack files didn't load at all (the load's own reason)", () => {
      const failed: PackFiles = { packs: [], errors: [], libraries: null, loadError: "the pack files didn't load: EIO" };
      expect(readPackRow(rowFor(recipe("waffles")), failed)).toEqual({ reading: "projection", why: "the pack files didn't load: EIO" });
    });

    it("the re-keyed recipe isn't a valid recipe", () => {
      // A field the format refuses that the projection never carries.
      const r = structuredClone(recipe("waffles"));
      (r.steps[1] as unknown as { coach_hints: unknown }).coach_hints = "not a list";
      const pack = { ...structuredClone(fannie), recipes: [r] };
      expect(readPackRow(rowFor(recipe("waffles")), { ...files, packs: [pack] })).toMatchObject({
        reading: "projection",
        why: expect.stringContaining("re-keyed isn't a valid recipe") as string,
      });
    });

    it("the stored row was edited", () => {
      const row = rowFor(recipe("waffles"));
      row.recipeData!.name = "Waffles (edited)";
      expect(readPackRow(row, files)).toMatchObject({ reading: "projection", why: expect.stringContaining("(name)") as string });
    });

    it("enriches an adapted pack recipe (pack-adapted:): keeps edited ingredients/steps, grafts matched step metadata & library, and leaves rewritten steps plain", () => {
      const row = rowFor(recipe("thin-white-sauce"));
      // Edit an ingredient, rewrite step 0 completely, keep checkpoint step 5 verbatim,
      // and reduce the total number of steps to simulate a weeknight riff.
      const originalSteps = [...row.recipeData!.steps!];
      const checkpointStepText = originalSteps[5]!;
      row.recipeData = {
        ...row.recipeData!,
        source: "pack-adapted:fannie-farmer-1896/thin-white-sauce",
        name: "Weeknight Gruyere White Sauce",
        ingredients: [
          ...row.recipeData!.ingredients!,
          { item: "Gruyere, grated", amount: "0.5", unit: "cup" },
        ],
        steps: [
          "Brown some shallots in olive oil in a skillet.",
          originalSteps[1]!,
          checkpointStepText,
          "Fold in the grated Gruyere off the heat.",
        ],
      };

      const read = readPackRow(row, files);
      if (read?.reading !== "adapted") {
        throw new Error(`expected adapted reading, got ${read?.reading ?? "null"}`);
      }

      // Altered ingredients and steps are preserved
      expect(read.packRecipe.title).toBe("Weeknight Gruyere White Sauce");
      expect(read.packRecipe.ingredients).toHaveLength(6);
      expect(read.packRecipe.steps).toHaveLength(4);
      expect((read.packRecipe.creator_notes ?? []).length).toBeGreaterThan(0);

      // Step 0 was completely rewritten and step count changed (4 vs 6), so it stays a plain action step
      expect(read.packRecipe.steps[0]!.type).toBe("action");
      expect(read.packRecipe.steps[0]!.coach_hints ?? []).toEqual([]);
      expect(read.packRecipe.steps[0]!.state_refs ?? []).toEqual([]);
      expect(read.packRecipe.steps[0]!.technique_refs ?? []).toEqual([]);

      // Step 2 matches original checkpoint step 5 by exact normalized text even at a new index
      expect(read.packRecipe.steps[2]!.type).toBe("checkpoint");
      expect(read.packRecipe.steps[2]!.state_refs).toContain("state:sauce-smooth-and-glossy");
      expect(read.library.states.map((s) => s.id)).toContain("state:sauce-smooth-and-glossy");

      // Step 3 is a new custom step and inherits no pack refs
      expect(read.packRecipe.steps[3]!.type).toBe("action");
      expect(read.packRecipe.steps[3]!.state_refs ?? []).toEqual([]);
    });

    it("the row's serving estimate isn't the pack's", () => {
      const row = { ...rowFor(recipe("waffles")), servesEstimate: 6 };
      expect(readPackRow(row, files)).toMatchObject({ reading: "projection", why: expect.stringContaining("serving estimate") as string });
    });

    it("the pack isn't in the registry, or didn't load", () => {
      const row = rowFor(recipe("waffles"), undefined, "gone-pack");
      expect(readPackRow(row, files)).toEqual({ reading: "projection", why: "pack gone-pack isn't in the registry" });
      const failed: PackFiles = {
        ...files,
        packs: [],
        errors: [{ sourceId: "x", packId: "gone-pack", reason: "not a valid pack", issues: [] }],
      };
      expect(readPackRow(row, failed)).toEqual({ reading: "projection", why: "pack gone-pack didn't load: not a valid pack" });
    });

    it("the recipe is gone from the pack", () => {
      const row = rowFor(recipe("waffles"));
      row.recipeData!.source = "pack:fannie-farmer-1896/no-such-recipe";
      expect(readPackRow(row, files)).toEqual({ reading: "projection", why: "pack fannie-farmer-1896 has no recipe no-such-recipe" });
    });

    it("the libraries couldn't be read", () => {
      expect(readPackRow(rowFor(recipe("waffles")), { ...files, libraries: null })).toEqual({
        reading: "projection",
        why: "the platform libraries couldn't be read",
      });
    });

    it("the re-keyed recipe's refs don't resolve", () => {
      const lib = files.libraries!;
      const thin = { ...lib, states: lib.states.filter((s) => s.id !== "state:custard-coats-the-spoon") };
      expect(readPackRow(rowFor(recipe("boiled-custard")), { ...files, libraries: thin })).toMatchObject({
        reading: "projection",
        why: expect.stringContaining("re-keyed refs don't resolve") as string,
      });
    });
  });

  it("never takes a household, import or webhook row, nor a malformed pack source", () => {
    const base: KitchenQueueRecipeData = { name: "Dal", ingredients: [{ item: "lentils", amount: "1", unit: "cup" }], steps: ["Simmer."], serves: 2 };
    for (const source of [undefined, "doc:dal", "import", "pack:", "pack:fannie-farmer-1896", "pack:a/b/c", "pack:a b/c"]) {
      const row = { id: "x", recipeData: { ...base, ...(source !== undefined && { source }) } };
      expect(readPackRow(row, files)).toBeNull();
    }
    expect(readPackRow({ id: "x", recipeData: null }, files)).toBeNull();
  });
});

describe("readQueueItem", () => {
  it("a household row reads as before, with scales: true and no pack files read", () => {
    const row = {
      id: "33333333-3333-4333-8333-333333333333",
      recipeData: { name: "Dal", ingredients: [{ item: "lentils", amount: "1", unit: "cup" }], steps: ["Simmer."], serves: 2 },
    };
    const read = readQueueItem(row, null);
    expect(read).toEqual({
      ...readQueueRecipe(row),
      reading: "projection",
      library: { states: [], commons: [] },
      scales: true,
      log: [],
    });
  });

  it("a drifted pack row reads its projection with scales: false and logs that the serving count stays at the recipe's (B5c-13)", () => {
    const row = { ...rowFor(recipe("doughnuts-i")), servesEstimate: 4 };
    const read = readQueueItem(row, files);
    expect(read.reading).toBe("projection");
    expect(read.scales).toBe(false);
    expect(read.packRecipe).toEqual(readQueueRecipe(row).packRecipe);
    expect(read.log[0]).toBe(
      "reads its projection: fannie-farmer-1896/doughnuts-i: the row's serving estimate isn't the pack's; the serving count stays at the recipe's",
    );
  });

  it("an adapted pack row reads as adapted with enriched steps, sourcePack metadata, and grafted fixed scaling (B5c-13)", () => {
    const row = rowFor(recipe("waffles"));
    row.recipeData = {
      ...row.recipeData!,
      source: "pack-adapted:fannie-farmer-1896/waffles",
      name: "Waffles (Weeknight)",
    };
    const read = readQueueItem(row, files);
    expect(read.reading).toBe("adapted");
    expect(read.scales).toBe(true);
    expect(read.sourcePack).toEqual({
      packId: "fannie-farmer-1896",
      packTitle: "The Boston Cooking-School Cook Book",
      creatorName: "Fannie Merritt Farmer",
      recipeId: "waffles",
      recipeTitle: "Waffles",
      isAdapted: true,
    });
    expect(read.log[0]).toMatch(/^read as adapted pack recipe: /);
    expect(
      read.packRecipe?.ingredients.find((ing) => ing.name === "Butter or lard, for the iron")?.scaling,
    ).toBe("fixed");
  });

  it("multi-flour adapted pack rows (doughnuts-i and parker-house-rolls) graft fixed only onto the matching dusting flour and lock if any fixed base line is unmatched or ambiguous (B5c-13)", () => {
    // 1. doughnuts-i adapted with all fixed lines intact: scales is true, 30 g flour and frying fat stay fixed, dough flours stay linear
    const doughnutsRow = rowFor(recipe("doughnuts-i"));
    doughnutsRow.recipeData = {
      ...doughnutsRow.recipeData!,
      source: "pack-adapted:fannie-farmer-1896/doughnuts-i",
      name: "Doughnuts (Cardamom)",
    };
    const doughnutsRead = readQueueItem(doughnutsRow, files);
    expect(doughnutsRead.reading).toBe("adapted");
    expect(doughnutsRead.scales).toBe(true);
    const flours = doughnutsRead.packRecipe!.ingredients.filter((ing) => ing.name === "Flour");
    expect(flours).toHaveLength(3);
    expect(flours.map((f) => f.scaling ?? "linear")).toEqual(["linear", "linear", "fixed"]);
    expect(
      doughnutsRead.packRecipe!.ingredients.find((ing) => ing.name === "Fat for deep frying")?.scaling,
    ).toBe("fixed");

    // 2. parker-house-rolls adapted with all fixed lines intact: scales is true
    const rollsRow = rowFor(recipe("parker-house-rolls"));
    rollsRow.recipeData = {
      ...rollsRow.recipeData!,
      source: "pack-adapted:fannie-farmer-1896/parker-house-rolls",
      name: "Parker House Rolls (Rosemary)",
    };
    const rollsRead = readQueueItem(rollsRow, files);
    expect(rollsRead.reading).toBe("adapted");
    expect(rollsRead.scales).toBe(true);
    const rollFlours = rollsRead.packRecipe!.ingredients.filter((ing) => ing.name === "Flour");
    expect(rollFlours.map((f) => f.scaling ?? "linear")).toEqual(["linear", "linear", "fixed"]);

    // 3. doughnuts-i adapted where a fixed base line (frying-fat) is changed/unmatched: scales is false and logged
    const unmatchedRow = rowFor(recipe("doughnuts-i"));
    unmatchedRow.recipeData = {
      ...unmatchedRow.recipeData!,
      source: "pack-adapted:fannie-farmer-1896/doughnuts-i",
      ingredients: unmatchedRow.recipeData!.ingredients!.filter(
        (ing) => ing.item !== "Fat for deep frying",
      ),
    };
    const unmatchedRead = readQueueItem(unmatchedRow, files);
    expect(unmatchedRead.reading).toBe("adapted");
    expect(unmatchedRead.scales).toBe(false);
    expect(unmatchedRead.log[0]).toContain(
      "fixed base line not matched (frying-fat (Fat for deep frying)); the serving count stays at the recipe's",
    );

    // 4. doughnuts-i adapted where a second Flour line also has 30 g (ambiguous match): scales is false and logged
    const ambiguousRow = rowFor(recipe("doughnuts-i"));
    const dupIngredients = structuredClone(ambiguousRow.recipeData!.ingredients!);
    dupIngredients[10] = { item: "Flour", amount: "30", unit: "g" };
    ambiguousRow.recipeData = {
      ...ambiguousRow.recipeData!,
      source: "pack-adapted:fannie-farmer-1896/doughnuts-i",
      ingredients: dupIngredients,
    };
    const ambiguousRead = readQueueItem(ambiguousRow, files);
    expect(ambiguousRead.reading).toBe("adapted");
    expect(ambiguousRead.scales).toBe(false);
    expect(ambiguousRead.log[0]).toContain(
      "fixed base line not matched (flour-board (Flour)); the serving count stays at the recipe's",
    );
  });

  it("a pack row that passes reads natively with scales: true, logging its notes", () => {
    const read = readQueueItem(rowFor(recipe("thin-white-sauce")), files);
    expect(read.reading).toBe("native");
    expect(read.scales).toBe(true);
    expect(read.conversionError).toBeNull();
    expect(read.log.some((line) => line.startsWith("read natively: pepper"))).toBe(true);
  });
});

describe("golden: every Fannie recipe, native against projected (zero wrong numbers)", () => {
  it("has no wrong number, and records what the native read adds", () => {
    const report: string[] = [];
    for (const r of fannie.recipes) {
      const row = rowFor(r);
      const projection = readQueueRecipe(row).packRecipe!;
      const read = native(row);
      const golden = compareReadings(projection, read.packRecipe, {
        ingredients: row.recipeData!.ingredients!.length,
        steps: row.recipeData!.steps!.length,
      });
      expect(golden.wrong, r.id).toEqual([]);
      report.push(`${r.id}: ${String(golden.expected.length)} expected differences`);
    }
    expect(report).toHaveLength(5);
  });

  it("counts a changed amount, a lost stated amount, a changed timer and a changed count as wrong", () => {
    const row = rowFor(recipe("parker-house-rolls"));
    const projection = readQueueRecipe(row).packRecipe!;
    const read = native(row);
    const bad = structuredClone(read.packRecipe);
    bad.ingredients[0]!.display_equivalents = { imperial: { unit: "cup", amount: 3 } };
    bad.steps[17]!.timer_sec = 900;
    bad.serves_base = 10;
    const golden = compareReadings(projection, bad, { ingredients: 11, steps: 19 });
    expect(golden.wrong).toEqual([
      'line 0: shows [["amount","2 cups"],"Milk"], natively [["amount","3 cups"],"Milk"]',
      "step 17: timer 720, natively 900",
      "serves 12 (estimate), natively 10 (estimate)",
    ]);
  });
});
