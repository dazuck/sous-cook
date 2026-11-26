/**
 * Builds the Cookpacks screens' view model (`view.ts`, S-D14) from what the
 * registry loaded: only what a screen draws, never steps or ingredients.
 * Pure, so the shelf's and a pack's every state is tested without a DB.
 */

import type { Pack, Recipe } from "@sous/pack";
import { servingsText } from "../kitchen/ingredient-display";
import { recipeTimeLine } from "../kitchen/time-line";
import { isTitleTag, titleTagWord, titleTags } from "../pack-convert/title-tags";
import { HOUSEHOLD_PACK, type HouseholdChapter, type HouseholdLayout, type Shelf } from "./registry";
import {
  chapterAnchors,
  type ContentsEntry,
  type CreatorOnShelf,
  type HouseholdOnShelf,
  type PackChapterView,
  type PackPageView,
  type PackRowView,
} from "./view";

/** The household's layout when no family source was read at all. */
const UNREAD: HouseholdLayout = { state: "unreadable", syncedAt: null, chapters: [] };

/** A recipe's row: its title, stated time (T's rule), its count through `servingsText`, its title tags. */
export function recipeRow(recipe: Recipe): PackRowView {
  return {
    id: recipe.id,
    title: recipe.title,
    // No plan before it's queued: the recipe's own stated time, said as its.
    times: recipeTimeLine(null, {
      ...(recipe.time_active_min !== undefined && { active: recipe.time_active_min }),
      ...(recipe.time_total_min !== undefined && { total: recipe.time_total_min }),
    }),
    serves: servingsText(recipe),
    // Only the Doc's title vocabulary; an extraction's own tags stay in the info sheet.
    // Bound, so "New Year's" never breaks between its words.
    tags: (recipe.tags ?? []).filter(isTitleTag).map((tag) => titleTagWord(tag).replace(/ /g, "\u00a0")),
    missing: null,
  };
}

function householdPack(shelf: Shelf, id: string): Pack | undefined {
  return shelf.packs.find((p) => p.pack.id === id && p.pack.kind === "household")?.pack;
}

/** The household's chapters as rows: a recipe that cooks from the pack, one that didn't come through by name. */
function householdChapters(layout: HouseholdLayout, pack: Pack | undefined): PackChapterView[] {
  const recipes = new Map((pack?.recipes ?? []).map((r) => [r.id, r]));
  const anchors = chapterAnchors(layout.chapters.flatMap((c) => (c.title === null ? [] : [c.title])));
  let next = 0;
  return layout.chapters.map((chapter: HouseholdChapter) => ({
    anchor: chapter.title === null ? null : anchors[next++]!,
    title: chapter.title,
    rows: chapter.rows.flatMap((row): PackRowView[] => {
      const householdMeta = {
        ...(row.isPrivate !== undefined ? { isPrivate: row.isPrivate } : {}),
        ...(row.docRecipeId !== undefined ? { docRecipeId: row.docRecipeId } : {}),
      };
      if (row.missing !== null) {
        return [{ id: row.id, title: titleTags(row.name).title, times: null, serves: null, tags: [], missing: row.missing, ...householdMeta }];
      }
      const recipe = recipes.get(row.id);
      return recipe === undefined ? [] : [{ ...recipeRow(recipe), ...householdMeta }];
    }),
  }));
}

const cookable = (chapter: PackChapterView) => chapter.rows.filter((r) => r.missing === null).length;

function contentsOf(chapters: readonly PackChapterView[]): ContentsEntry[] {
  return chapters.flatMap((c) =>
    c.anchor === null || c.title === null ? [] : [{ anchor: c.anchor, title: c.title, count: cookable(c) }],
  );
}

/** A creator pack's chapters: its sections in order, then any recipe in none, headless; no sections, one flat list. */
function creatorChapters(pack: Pack): PackChapterView[] {
  const byId = new Map(pack.recipes.map((r) => [r.id, r]));
  const sections = pack.sections ?? [];
  const anchors = chapterAnchors(sections.map((s) => s.title));
  const placed = new Set(sections.flatMap((s) => s.recipe_ids));
  const chapters: PackChapterView[] = sections.map((section, i) => ({
    anchor: anchors[i]!,
    title: section.title,
    rows: section.recipe_ids.map((id) => recipeRow(byId.get(id)!)),
  }));
  const rest = pack.recipes.filter((r) => !placed.has(r.id));
  if (rest.length > 0) chapters.push({ anchor: null, title: null, rows: rest.map(recipeRow) });
  return chapters;
}

const HOUSEHOLD_ID = HOUSEHOLD_PACK.id;
const HOUSEHOLD_TITLE = HOUSEHOLD_PACK.title;

/** What the shelf draws (S-D14): the household entry, always; the creator packs in registry order; the ideas count. */
export function shelfView(shelf: Shelf, ideas: number | null): { household: HouseholdOnShelf; creators: CreatorOnShelf[]; ideas: number | null } {
  const layout = shelf.household ?? UNREAD;
  const chapters = householdChapters(layout, householdPack(shelf, HOUSEHOLD_ID));
  const rows = chapters.flatMap((c) => c.rows);
  const household: HouseholdOnShelf = {
    id: HOUSEHOLD_ID,
    title: HOUSEHOLD_TITLE,
    state: layout.state,
    cookable: rows.filter((r) => r.missing === null).length,
    missing: rows.filter((r) => r.missing !== null).length,
    syncedAt: layout.syncedAt?.toISOString() ?? null,
    contents: contentsOf(chapters),
  };
  const creators = shelf.packs
    .filter((p) => p.pack.kind !== "household")
    .map((entry) => ({
      id: entry.pack.id,
      title: entry.pack.title,
      creator: entry.pack.creator.name,
      recipes: entry.pack.recipes.length,
      cloth: "walnut" as const,
      coverRef: entry.pack.cover_ref ?? null,
      ...(entry.isOwned !== undefined && { isOwned: entry.isOwned }),
      ...(entry.fromKitchenName != null && { fromKitchenName: entry.fromKitchenName }),
    }));
  return { household, creators, ideas };
}

/** A pack's view (S-D14), or null when no pack on the shelf has that id. */
export function packView(shelf: Shelf, packId: string): PackPageView | null {
  if (packId === HOUSEHOLD_ID) {
    const layout = shelf.household ?? UNREAD;
    const chapters = householdChapters(layout, householdPack(shelf, HOUSEHOLD_ID));
    const rows = chapters.flatMap((c) => c.rows);
    return {
      id: HOUSEHOLD_ID,
      kind: "household",
      title: HOUSEHOLD_TITLE,
      creator: HOUSEHOLD_TITLE,
      state: layout.state,
      syncedAt: layout.syncedAt?.toISOString() ?? null,
      cookable: rows.filter((r) => r.missing === null).length,
      missing: rows.filter((r) => r.missing !== null).length,
      chapters,
      cloth: null,
    };
  }
  const entry = shelf.packs.find((p) => p.pack.id === packId && p.pack.kind !== "household");
  if (entry === undefined) return null;
  const { pack } = entry;
  return {
    id: pack.id,
    kind: "creator",
    title: pack.title,
    creator: pack.creator.name,
    state: "ok",
    syncedAt: null,
    cookable: pack.recipes.length,
    missing: 0,
    chapters: creatorChapters(pack),
    cloth: "walnut",
    ...(entry.isOwned !== undefined && { isOwned: entry.isOwned }),
    ...(entry.fromKitchenName != null && { fromKitchenName: entry.fromKitchenName }),
  };
}
