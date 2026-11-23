/**
 * Hooks: the six places where the app reaches outside itself for a
 * household's own data. Each is an interface here, an implementation slot in
 * `registry.ts` (server only) and a switch in `connected.ts`. The app ships
 * with none connected, and every surface that depends on one has a drawn
 * state for that: the tile is hidden, the list is empty, the step is skipped.
 *
 * To connect one: write an object that satisfies its interface, put it in
 * its slot in `registry.ts`, and flip its switch in `connected.ts`. Each
 * hook's spec is `docs/hooks/<name>.md` (`hookSpecDoc`).
 *
 * Rules every implementation follows:
 *  - A call that can't reach its store rejects. It never answers with an
 *    empty value in place of a failed read: the caller decides what a
 *    failure means on its surface.
 *  - A call bounds its own time (a timeout on each request). Some calls run
 *    after the response has been sent, where nothing else would stop them.
 *  - Text is stored and returned as written: no trimming of meaning, no
 *    parsing of a string into a number or a date on the way in.
 *
 * This file is types and names only; it is safe to import anywhere.
 */

import type { ShoppingListItem } from "../shopping-list-format";

// =============================================================================
// Names
// =============================================================================

/** The six hooks, by the name of their spec doc. */
export const HOOK_NAMES = [
  "recipe-library",
  "cook-log",
  "pantry",
  "shopping-list",
  "ideas",
  "household-context",
] as const;

export type HookName = (typeof HOOK_NAMES)[number];

/** Each hook's interface, by name. */
export interface Hooks {
  "recipe-library": RecipeLibrarySource;
  "cook-log": CookLogGrid;
  pantry: PantryStore;
  "shopping-list": ShoppingListStore;
  ideas: IdeasStore;
  "household-context": HouseholdContext;
}

/** The registry's shape: an implementation, or null for a hook left open. */
export type HookImplementations = { [K in HookName]: Hooks[K] | null };

/** Where a hook's spec lives, from the repo root. */
export function hookSpecDoc(name: HookName): string {
  return `docs/hooks/${name}.md`;
}

// =============================================================================
// recipe-library: the household's own recipes, read into the household book
// =============================================================================

/**
 * One tab (page, folder, note) of the household's recipe collection. The
 * collection is a tree: a top-level tab is a category, a tab with children
 * below it is a sub-category, and a tab with none is one recipe, named by
 * its title (`chunkRecipeTabs` in `lib/recipe-sync.ts` has the full rules).
 */
export interface LibraryTab {
  /** The tab's title as written, e.g. "mains" or "Lentil soup *". */
  title: string;
  /**
   * The tab's own text, top to bottom, one entry per line: headings
   * included, blank lines dropped, a leading bullet glyph removed. A table
   * row reads as its cells joined with " | ".
   */
  lines: string[];
  /** True when the tab also holds something that isn't text (an image). */
  nonText: boolean;
  /** The tabs nested under this one, in order; empty for a leaf. */
  children: LibraryTab[];
}

export interface RecipeLibrarySource {
  /**
   * The whole collection, top-level tabs in order. Read on every Refresh of
   * the household book. A collection that can't be read rejects; an empty
   * array means the collection is there and holds nothing.
   */
  readTabs(): Promise<LibraryTab[]>;
}

// =============================================================================
// cook-log: one row per finished cook, with its rating and note
// =============================================================================

/** The Cook Log's columns, left to right. Row 1 holds these as its header. */
export const COOK_LOG_COLUMNS = [
  "timestamp",
  "recipe_name",
  "recipe_anchor",
  "rating",
  "notes",
] as const;

/**
 * The Cook Log as a grid of text cells, addressed as a spreadsheet counts:
 * rows and columns from 1, so (2, 4) is the rating of the first cook.
 *
 * Row 1 is the header (`COOK_LOG_COLUMNS`); cooks start at row 2. The app
 * never writes row 1, so a new log is created with its header in place.
 * Other writers may share the log (a person editing it, another program):
 * rows can be added, sorted or removed between calls, and the app looks for
 * a cook's row again before each write (`lib/hooks/cook-log.ts`).
 *
 * Every cell is text. `timestamp` is "YYYY-MM-DD HH:MM" in the kitchen's
 * time zone, `rating` is "1" to "5" or empty, and the grid stores each
 * exactly as given.
 */
export interface CookLogGrid {
  /**
   * Every row, header first: `rows[i]` is row `i + 1`. A row lists its
   * cells from column 1; trailing empty cells may be left off.
   */
  read(): Promise<string[][]>;
  /**
   * Adds `row` as a new last row, its cells from column 1.
   *
   * @returns the row number it landed on (2 for the first cook)
   */
  append(row: string[]): Promise<number>;
  /**
   * Overwrites cells of row `row`, starting at column `col` and running
   * right, one cell per value. Cells outside that run keep what they hold.
   */
  write(row: number, col: number, values: string[]): Promise<void>;
}

// =============================================================================
// pantry: what food is in the house
// =============================================================================

/**
 * One headed list in the pantry, e.g. "Fridge" with its items. Headings are
 * the household's own; the app reads a few by keyword ("freezer", "fridge",
 * "perishable") to sort items for Ask, and treats a heading starting "our
 * setup" or "our family" as not food (`lib/hooks/pantry.ts`).
 */
export interface PantrySection {
  /** The heading, lowercased and trimmed, for matching. */
  heading: string;
  /** The heading as written, for display. */
  rawHeading: string;
  /** The section's lines in order, e.g. "2 avocados"; blank lines dropped. */
  items: string[];
}

/** An item to add, with the section it would like to land in. */
export interface PantryAddition {
  /** The line to add, e.g. "1 lb ground beef". */
  text: string;
  /**
   * A suggested section, by name ("Fridge", "Spice Rack"). The store picks
   * the closest of its own food sections, and its first when none is close.
   */
  section?: string;
}

/** A change to an item the pantry already holds, made when a cook finishes. */
export interface PantryUpdateAction {
  /** "delete" removes the line; "decrement" replaces it with `newText`. */
  action: "delete" | "decrement";
  /** The line as the pantry holds it (matched ignoring case). */
  oldText: string;
  /** The line to leave in its place; required for "decrement". */
  newText?: string;
  /** The section the line was read from, when known. */
  section?: string;
}

export interface PantryStore {
  /** Every section in order, food or not. Read fresh on each call. */
  readSections(): Promise<PantrySection[]>;
  /**
   * Adds each item as a new line of a food section.
   *
   * @returns how many lines were added
   */
  addItems(items: PantryAddition[]): Promise<{ added: number }>;
  /**
   * Applies each action to the one line it names, in food sections only. An
   * action whose line isn't there is skipped.
   *
   * @returns how many actions found their line
   */
  applyUpdates(actions: PantryUpdateAction[]): Promise<{ updated: number }>;
}

// =============================================================================
// shopping-list: one shared list of things to buy
// =============================================================================

/** An item to add: what to buy, and optionally what it is for. */
export interface ShoppingListAddition {
  /** e.g. "Lemons (2)". */
  item: string;
  /** The recipe or occasion it is for, e.g. "Tuesday beans". */
  forRecipe?: string | null;
}

/**
 * The list is lines of text, "<item>" or "<item> — <for>". The helpers in
 * `lib/shopping-list-format.ts` make and read them: `formatShoppingLine`
 * writes a line, `parseShoppingLine` reads one into a `ShoppingListItem`,
 * and `shopItemKey` gives the key two lines share when they are the same
 * item ("Lemons (2) — Tuesday beans" and "lemons").
 */
export interface ShoppingListStore {
  /** The list in order, and when it was read. */
  list(): Promise<{ items: ShoppingListItem[]; syncedAt: Date }>;
  /**
   * Adds each item not already on the list (by `shopItemKey`), at the end.
   *
   * @returns the lines added, as written; a duplicate adds nothing
   */
  add(inputs: ReadonlyArray<ShoppingListAddition>): Promise<{ added: string[] }>;
  /**
   * Removes the line that equals `rawOrKey` (ignoring case) or shares its
   * `shopItemKey`.
   *
   * @returns whether a line was removed
   */
  remove(rawOrKey: string): Promise<{ removed: boolean }>;
  /**
   * Empties the list.
   *
   * @returns how many lines it held
   */
  clear(): Promise<{ cleared: number }>;
}

// =============================================================================
// ideas: recipes saved for later
// =============================================================================

export interface IdeasStore {
  /**
   * The whole list as text, one idea per line. The app keeps the last text
   * it read, and shows that (marked stale) when a read rejects.
   */
  readText(): Promise<string>;
  /** Adds one idea as a new last line. `line` is non-empty and trimmed. */
  append(line: string): Promise<void>;
}

// =============================================================================
// household-context: who is eating
// =============================================================================

export interface HouseholdContext {
  /**
   * A few lines of free text about the household for Ask to keep in mind:
   * who eats here, what they avoid, what they like. Placed in the model's
   * reference information as written. "" when there is nothing to say.
   */
  read(): Promise<string>;
}
