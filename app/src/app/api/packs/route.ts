import { NextResponse } from "next/server";
import type { Recipe } from "@sous/pack";
import { librarySubset } from "@/lib/pack-convert/native-read";
import { EMPTY_LIBRARY } from "@/lib/pack-convert/recipe-library";
import { packRecipeToQueueData } from "@/lib/pack-convert/to-queue";
import { loadAppPackFiles } from "@/lib/shelf/load";
import { webhookAuthRefusal } from "@/lib/webhook-auth";

const STAPLE_NAMES = new Set([
  "water",
  "lukewarm water",
  "boiling water",
  "cold water",
  "warm water",
  "salt",
  "kosher salt",
  "table salt",
  "fine table salt",
  "sea salt",
  "flaky salt",
  "pepper",
  "black pepper",
  "white pepper",
  "oil",
  "olive oil",
  "vegetable oil",
  "neutral oil",
  "cooking oil",
  "fat for deep frying",
  "frying fat",
]);

function isStaple(name: string, saltType: string | undefined): boolean {
  if (saltType !== undefined) return true;
  return STAPLE_NAMES.has(name.trim().toLowerCase());
}

function mainIngredientsOf(recipe: Recipe): string[] {
  const uniqueNonStaple: string[] = [];
  const seenNonStaple = new Set<string>();
  const uniqueAll: string[] = [];
  const seenAll = new Set<string>();

  for (const ing of recipe.ingredients) {
    const key = ing.name.trim().toLowerCase();
    if (!key) continue;
    if (!seenAll.has(key)) {
      seenAll.add(key);
      uniqueAll.push(ing.name.trim());
    }
    if (!isStaple(ing.name, ing.qty_canonical.salt_type) && !seenNonStaple.has(key)) {
      seenNonStaple.add(key);
      uniqueNonStaple.push(ing.name.trim());
    }
  }

  const chosen = uniqueNonStaple.length > 0 ? uniqueNonStaple : uniqueAll;
  return chosen.slice(0, 6);
}

function firstSentence(text: string): string | null {
  const trimmed = text.trim();
  if (!trimmed) return null;
  const match = /^[^.!?]+[.!?]/.exec(trimmed);
  return match ? match[0].trim() : trimmed;
}

function hookOf(recipe: Recipe): string | null {
  if (recipe.story && recipe.story.trim() !== "") {
    return firstSentence(recipe.story);
  }
  const firstNote = recipe.creator_notes?.[0];
  if (firstNote && firstNote.trim() !== "") {
    return firstSentence(firstNote);
  }
  return null;
}

/**
 * GET /api/packs
 *
 * Serves the live registered creator packs (`SHELF_SOURCES` `pack-file` entries)
 * to `kitchen.py`:
 * - `GET /api/packs`: compact digest per pack and per recipe.
 * - `GET /api/packs?pack=<packId>&recipe=<recipeId>`: full validated Recipe +
 *   pack header + resolved commons/states subset + queue projection.
 *
 * Auth: Bearer token via KITCHEN_QUEUE_API_TOKEN env var in production.
 */
export async function GET(request: Request): Promise<Response> {
  const refusal = webhookAuthRefusal(request);
  if (refusal) return refusal;

  const files = await loadAppPackFiles();
  if (files.loadError !== undefined) {
    return NextResponse.json({ error: files.loadError }, { status: 500 });
  }

  const url = new URL(request.url);
  const packParam = url.searchParams.get("pack");
  const recipeParam = url.searchParams.get("recipe");

  if (packParam !== null || recipeParam !== null) {
    if (!packParam || !recipeParam) {
      return NextResponse.json(
        { error: "Pack or recipe not found" },
        { status: 404 },
      );
    }
    const pack = files.packs.find((p) => p.id === packParam);
    const recipe = pack?.recipes.find((r) => r.id === recipeParam);
    if (!pack || !recipe) {
      return NextResponse.json(
        { error: "Pack or recipe not found" },
        { status: 404 },
      );
    }
    const projected = packRecipeToQueueData(recipe, pack.id);
    const library = files.libraries
      ? librarySubset(recipe, files.libraries)
      : EMPTY_LIBRARY;
    return NextResponse.json({
      pack: {
        id: pack.id,
        title: pack.title,
        creator: pack.creator,
      },
      recipe,
      library,
      projection: projected.ok ? projected.projection.recipeData : null,
    });
  }

  const packs = files.packs.map((pack) => ({
    id: pack.id,
    title: pack.title,
    creator: {
      name: pack.creator.name,
      ...(pack.creator.bio !== undefined && { bio: pack.creator.bio }),
      ...(pack.creator.voice_notes !== undefined && {
        voice_notes: pack.creator.voice_notes,
      }),
    },
    description: pack.description ?? null,
    recipes: pack.recipes.map((r) => ({
      id: r.id,
      title: r.title,
      time_total_min: r.time_total_min ?? null,
      time_active_min: r.time_active_min ?? null,
      serves_base: r.serves_base,
      tags: r.tags ?? [],
      main_ingredients: mainIngredientsOf(r),
      hook: hookOf(r),
    })),
  }));

  return NextResponse.json({ packs });
}
