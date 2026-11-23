/**
 * The Fannie Farmer draft's recipes as the cook page reads them natively
 * (slice B5d), for tests: each queued as `queueFromPack` stores it, then read
 * through the real reverse guard. Synchronous, from the repo's packs/.
 */

import { readFileSync } from "node:fs";
import path from "node:path";
import { parseCommonsFile, parsePack, parseStatesFile, type Pack, type Recipe } from "@sous/pack";
import type { KitchenQueueRecipeData } from "../../../../drizzle/schema";
import type { PackFiles } from "../../shelf/registry";
import { readPackRow } from "../native-read";
import type { RecipeLibrary } from "../recipe-library";
import { packRecipeToQueueData } from "../to-queue";

// From the cwd, as the app resolves packs/ (`shelf/load.ts`): tests run from app/, and
// a happy-dom test has no file: URL to resolve against.
const PACKS = path.resolve(process.cwd(), "..", "packs");

function json(file: string): unknown {
  return JSON.parse(readFileSync(path.join(PACKS, file), "utf8"));
}

let files: PackFiles | null = null;

export function fanniePackFiles(): PackFiles {
  if (files !== null) return files;
  const pack = parsePack(json("drafts/fannie-farmer-1896.pack.json"));
  const commons = parseCommonsFile(json("commons.json"));
  const states = parseStatesFile(json("states.json"));
  if (!pack.ok || !commons.ok || !states.ok) throw new Error("the repo's packs don't parse");
  files = { packs: [pack.value], errors: [], libraries: { commons: commons.value, states: states.value } };
  return files;
}

export function fannie(): Pack {
  return fanniePackFiles().packs[0]!;
}

export interface NativeFannie {
  id: string;
  recipeData: KitchenQueueRecipeData;
  servesEstimate: number | null;
  servesEstimateBasis: string | null;
  packRecipe: Recipe;
  library: RecipeLibrary;
}

/** One Fannie recipe, queued and read natively, under queue id `id`. */
export function fannieNative(recipeId: string, id = "f0000000-0000-4000-8000-000000000001"): NativeFannie {
  const recipe = fannie().recipes.find((r) => r.id === recipeId);
  if (recipe === undefined) throw new Error(`no Fannie recipe ${recipeId}`);
  const projected = packRecipeToQueueData(recipe, fannie().id);
  if (!projected.ok) throw new Error(`${recipeId} doesn't project`);
  const { recipeData, servesEstimate } = projected.projection;
  const row = {
    id,
    recipeData,
    servesEstimate: servesEstimate?.count ?? null,
    servesEstimateBasis: servesEstimate?.basis ?? null,
  };
  const read = readPackRow(row, fanniePackFiles());
  if (read?.reading !== "native") throw new Error(`${recipeId} doesn't read natively`);
  return { ...row, packRecipe: read.packRecipe, library: read.library };
}

export const FANNIE_RECIPES = ["doughnuts-i", "parker-house-rolls", "boiled-custard", "waffles", "thin-white-sauce"] as const;
