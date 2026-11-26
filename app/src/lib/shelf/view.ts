/**
 * The Cookpacks screens' view model (slice S, S-D14): what the shelf and a
 * pack view draw, and nothing more. The server builds it from the registry
 * (`getShelf`, `getPack`); the screens only read it. Steps and ingredients
 * never come this way: a row is a title and one fact.
 *
 * The pure helpers here are the screens' own reading of it (search, the
 * missing filter, a row's fact, the contents' columns), kept apart from the
 * components so they are tested without a DOM.
 */

import { KITCHEN_TIME_ZONE } from "../kitchen/zone";

/** The household pack's state on the shelf and in its view. */
export type HouseholdState = "ok" | "empty" | "unreadable";

/** A cloth from the closed palette (design P9); walnut is the uncovered default (S-D5). */
export type Cloth = "walnut" | "flax" | "sage" | "clay" | "olive" | "oxblood";

/** A chapter in a book's contents: its name as the pack writes it, and its recipes that cook. */
export interface ContentsEntry {
  /** The chapter's anchor in its pack view (`#baking`). */
  anchor: string;
  title: string;
  count: number;
}

export interface HouseholdOnShelf {
  id: string;
  title: string;
  state: HouseholdState;
  /** Recipes that cook; the "didn't come through" ones aren't counted. */
  cookable: number;
  missing: number;
  /** When the family library was last synced, ISO; null before any sync. */
  syncedAt: string | null;
  contents: ContentsEntry[];
}

export interface CreatorOnShelf {
  id: string;
  title: string;
  creator: string;
  recipes: number;
  cloth: Cloth;
  coverRef: string | null;
  /** True when the pack is owned by this kitchen in `kitchen_packs`. */
  isOwned?: boolean;
  /** Name of the sharing kitchen when this pack is shared from another kitchen. */
  fromKitchenName?: string | null;
}

export interface ShelfView {
  household: HouseholdOnShelf | null;
  /** The creator packs in registry order. */
  creators: CreatorOnShelf[];
  /** Ideas in the cached backlog, or null when the cache holds none yet. */
  ideas: number | null;
}

/**
 * Why a family recipe isn't cooked from (S-D8): the converter refused it
 * (B4b's can't-estimate included), or its extraction failed on the last
 * Refresh.
 */
export type MissingReason = "refused" | "unread";

export interface PackRowView {
  id: string;
  title: string;
  /** The recipe's stated time as the time line's parts (T's rule), or null. */
  times: string[] | null;
  /** "serves 4", or "serves 4 (Sous's estimate)" (`servingsText`), or null. */
  serves: string | null;
  /** The title-vocabulary tags as they read ("Thanksgiving", "summer"). */
  tags: string[];
  missing: MissingReason | null;
  /** Whether the recipe is marked private (household book rows only). */
  isPrivate?: boolean;
  /** The `doc_recipes.id` UUID (household book rows only, for share links). */
  docRecipeId?: string;
}

export interface PackChapterView {
  /** The chapter's anchor, or null for the headless tail (recipes in no chapter). */
  anchor: string | null;
  /** The chapter's name as the pack writes it; null for the headless tail. */
  title: string | null;
  rows: PackRowView[];
}

export interface PackPageView {
  id: string;
  kind: "household" | "creator";
  title: string;
  creator: string;
  /** The household's state; a creator pack is always "ok". */
  state: HouseholdState;
  syncedAt: string | null;
  cookable: number;
  missing: number;
  /** The book in its own order. A pack with no sections is one headless chapter. */
  chapters: PackChapterView[];
  /** A creator pack's cloth, for its binding. */
  cloth: Cloth | null;
  /** True when the pack is owned by this kitchen in `kitchen_packs`. */
  isOwned?: boolean;
  /** Name of the sharing kitchen when this pack is shared from another kitchen. */
  fromKitchenName?: string | null;
}

/** "Oct 4": a sync's date as the kitchen reads it, in the kitchen's time zone (`lib/kitchen/zone.ts`). */
export function kitchenDate(iso: string, timeZone: string = KITCHEN_TIME_ZONE): string {
  return new Date(iso).toLocaleDateString("en-US", {
    month: "short",
    day: "numeric",
    timeZone,
  });
}

/**
 * A chapter's anchor from its name: lowercase words joined by "-"
 * ("quick & easy" → "quick-easy"), unique within the pack (a repeat gains
 * "-2"). A name with no letters or digits is "chapter".
 */
export function chapterAnchors(titles: readonly string[]): string[] {
  const seen = new Map<string, number>();
  return titles.map((title) => {
    const base =
      title
        .normalize("NFKD")
        .replace(/[̀-ͯ]/g, "")
        .toLowerCase()
        .replace(/[^a-z0-9]+/g, "-")
        .replace(/^-|-$/g, "") || "chapter";
    const n = (seen.get(base) ?? 0) + 1;
    seen.set(base, n);
    return n === 1 ? base : `${base}-${n}`;
  });
}

/** A row with the chapter it sits in, for the flat list a search or filter draws. */
export interface FlatRow {
  row: PackRowView;
  chapter: string | null;
}

function flatten(chapters: readonly PackChapterView[]): FlatRow[] {
  return chapters.flatMap((c) => c.rows.map((row) => ({ row, chapter: c.title })));
}

/** The rows whose title holds the query (case-insensitive), in book order; missing ones included. */
export function searchRows(chapters: readonly PackChapterView[], query: string): FlatRow[] {
  const q = query.trim().toLocaleLowerCase();
  return flatten(chapters).filter(({ row }) => row.title.toLocaleLowerCase().includes(q));
}

/** The rows that didn't come through, in book order. */
export function missingRows(chapters: readonly PackChapterView[]): FlatRow[] {
  return flatten(chapters).filter(({ row }) => row.missing !== null);
}

const NBSP = " ";

/**
 * A row's one fact, as parts joined by " · " (each but the last ends on its
 * dot, so a wrap never opens a line on one): the stated time (the time
 * line's parts), the serving count, then the title tags. A missing row's
 * fact is why it is missing. In a flat list (a search, the missing filter)
 * it leads with the row's chapter.
 */
export function rowFact(row: PackRowView, chapter?: string | null): string[] {
  const facts: string[][] = [];
  if (chapter) facts.push([chapter]);
  if (row.missing !== null) {
    facts.push([row.missing === "refused" ? MISSING_WORDS.refused : MISSING_WORDS.unread]);
  } else {
    if (row.times) facts.push(row.times);
    if (row.serves) facts.push([row.serves]);
    for (const tag of row.tags) facts.push([tag]);
  }
  return facts.flatMap((parts, i) =>
    i === facts.length - 1 ? parts : [...parts.slice(0, -1), `${parts[parts.length - 1]}${NBSP}·`],
  );
}

/** The missing rows' reasons (S-D8; placeholder copy, mirrored in COOKPACKS_COPY). */
export const MISSING_WORDS = {
  refused: "Sous couldn't read this one",
  unread: "Didn't come through on the last Refresh",
} as const;

/** How many chapters the household's contents show on the shelf (two columns of five). */
export const CONTENTS_SHOWN = 10;

/**
 * The household's contents on the shelf, in two columns of up to five. Past
 * ten chapters the second column's last line becomes "and N more", so it
 * holds four chapters and the count of the rest.
 */
export function contentsColumns(entries: readonly ContentsEntry[]): {
  columns: [ContentsEntry[], ContentsEntry[]];
  more: number;
} {
  const over = entries.length > CONTENTS_SHOWN;
  const shown = over ? entries.slice(0, CONTENTS_SHOWN - 1) : entries.slice();
  const half = Math.ceil(Math.min(entries.length, CONTENTS_SHOWN) / 2);
  return {
    columns: [shown.slice(0, half), shown.slice(half)],
    more: over ? entries.length - shown.length : 0,
  };
}
