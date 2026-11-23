/**
 * Recipe-idea backlog: the ideas hook's list (`lib/hooks/types.ts`,
 * `IdeasStore`), read for the shelf's "Saved for later" and appended to when
 * a recipe is saved as inspiration. The router calls these only while the
 * hook is connected.
 *
 * The list is one idea per non-empty line. Reads cache the text in a
 * single-row table so the list degrades to the last-known one if the read
 * fails rather than going blank.
 */

import { desc, eq } from "drizzle-orm";
import { db, recipeIdeasCache } from "./db";
import { hook } from "./hooks/registry";

export interface RecipeIdeas {
  ideas: string[];
  syncedAt: Date;
  /** True when the read failed and this is the cached list. */
  stale: boolean;
}

function splitIdeas(text: string): string[] {
  return text
    .split("\n")
    .map((line) => line.trim())
    .filter((line) => line !== "");
}

async function readCachedIdeas(kitchenId: string): Promise<RecipeIdeas | null> {
  const row = await db.query.recipeIdeasCache.findFirst({
    where: eq(recipeIdeasCache.kitchenId, kitchenId),
    orderBy: [desc(recipeIdeasCache.syncedAt)],
  });
  if (!row) return null;
  return { ideas: splitIdeas(row.text), syncedAt: row.syncedAt, stale: true };
}

/**
 * How many ideas the cache holds for a kitchen, without reading the list (the
 * Cookpacks shelf's "Saved for later" count, S-D14); null before the list has
 * ever been read.
 */
export async function cachedIdeasCount(kitchenId: string): Promise<number | null> {
  const cached = await readCachedIdeas(kitchenId);
  return cached === null ? null : cached.ideas.length;
}

/**
 * Returns the current recipe-idea list, refreshing the kitchen's cache row on
 * success. When the read fails, answers with the cached text (marked
 * `stale`) instead of throwing, as the list is non-critical; with nothing
 * cached, the failure is thrown.
 */
export async function getRecipeIdeas(kitchenId: string): Promise<RecipeIdeas> {
  let text: string;
  try {
    text = await hook("ideas").readText();
  } catch (error) {
    console.warn("Could not read the recipe ideas:", error);
    const cached = await readCachedIdeas(kitchenId);
    if (cached) return cached;
    throw error;
  }

  // Upsert the kitchen's single cache row without touching other kitchens.
  const syncedAt = new Date();
  await db
    .insert(recipeIdeasCache)
    .values({ kitchenId, text, syncedAt })
    .onConflictDoUpdate({
      target: recipeIdeasCache.kitchenId,
      set: { text, syncedAt },
    });

  return { ideas: splitIdeas(text), syncedAt, stale: false };
}

/** Appends a new idea as the list's last line. */
export async function saveRecipeIdea(text: string): Promise<void> {
  const trimmed = text.trim();
  if (trimmed === "") throw new Error("Cannot save an empty recipe idea.");
  await hook("ideas").append(trimmed);
}
