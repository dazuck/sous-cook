/**
 * The library entries a natively read pack recipe's refs name (slice B5d,
 * B5.md §B5d D1): the states a checkpoint shows as its evidence, the commons
 * an interlude is counted by. Sent with the recipe, kept in B5b's snapshot.
 * Kept apart from the reader so the cook page can import it.
 */

import type { Commons, States } from "@sous/pack";

/** How a queue row's recipe was read: its pack recipe natively, adapted from a pack recipe, or the stored shape converted. */
export type RecipeReading = "native" | "adapted" | "projection";

export interface SourcePackInfo {
  packId: string;
  packTitle: string;
  creatorName: string;
  recipeId: string;
  recipeTitle: string;
  isAdapted: boolean;
}

export interface RecipeLibrary {
  states: States;
  commons: Commons;
}

export const EMPTY_LIBRARY: RecipeLibrary = { states: [], commons: [] };
