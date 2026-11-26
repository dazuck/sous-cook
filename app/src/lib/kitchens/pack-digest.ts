import type { Recipe } from "@sous/pack";
import type { PackFiles } from "@/lib/shelf/registry";

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
    if (
      !isStaple(ing.name, ing.qty_canonical.salt_type) &&
      !seenNonStaple.has(key)
    ) {
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

export interface PackDigestRecipe {
  id: string;
  title: string;
  time_total_min: number | null;
  time_active_min: number | null;
  serves_base: number;
  tags: string[];
  main_ingredients: string[];
  hook: string | null;
}

export interface PackDigestEntry {
  id: string;
  title: string;
  creator: {
    name: string;
    bio?: string;
    voice_notes?: string;
  };
  from_kitchen_name?: string;
  description: string | null;
  recipes: PackDigestRecipe[];
}

/**
 * Builds the compact pack and recipe digest returned by `GET /api/packs` and
 * the MCP `list_shelf` tool.
 */
export function buildPackDigest(files: PackFiles): PackDigestEntry[] {
  return files.packs.map((pack) => {
    const meta = files.packMeta?.get(pack.id);
    return {
      id: pack.id,
      title: pack.title,
      creator: {
        name: pack.creator.name,
        ...(pack.creator.bio !== undefined && { bio: pack.creator.bio }),
        ...(pack.creator.voice_notes !== undefined && {
          voice_notes: pack.creator.voice_notes,
        }),
      },
      ...(meta?.fromKitchenName
        ? { from_kitchen_name: meta.fromKitchenName }
        : {}),
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
    };
  });
}
