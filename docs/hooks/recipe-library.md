# Hook: recipe-library

The household's own recipes, wherever they are kept, read into the app as the first book on the shelf. The cook opens the book, picks a recipe from its chapters and cooks it like any other; a Refresh on the book re-reads the collection.

As shipped this hook is unconnected: the shelf shows only the bundled pack and there is no household book.

## Interface

From `app/src/lib/hooks/types.ts`:

```ts
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
```

A "tab" is whatever your store nests: a tab in a document, a folder, a page, a note with sub-notes.

## `readTabs()`

- **Input:** none.
- **Output:** the whole tree, every level, in the order the household keeps it. Order matters: the app numbers the recipes in the order a depth-first walk meets them, and the book lists them in that order.
- **`title`:** as written. Don't trim a trailing `*` or change case; the app does its own cleaning.
- **`lines`:** every non-blank line of the tab's own text in order, headings included. Remove one leading bullet glyph (`-`, `*`, `•`) from a line. Keep everything else as written, amounts included ("1 1/2 cups flour"). Don't include the title as a line.
- **`nonText`:** true when the tab holds an image, a drawing or anything else that isn't text, whether or not it also has lines.
- **`children`:** `[]` for a leaf, never `undefined`.
- **Empty:** `[]` means the collection exists and has no tabs. The Refresh then fails (`syncRecipesFromDoc` throws "No recipes found in the recipe library…", and the book says the library has no recipe tabs to read), because a collection with no recipe in it usually means it changed shape.
- **Errors:** reject when the store can't be read. Don't answer `[]` for a failed read: the Refresh would report an empty collection instead of an outage.
- **Idempotency:** a pure read. The app never writes to the collection.
- **Time:** bound each request. The Refresh runs inside one HTTP request.

## How tabs become recipes

`chunkRecipeTabs` in `app/src/lib/recipe-sync.ts` walks the tree depth-first and decides what each tab is:

| Tab | What it is |
| --- | --- |
| Top level, has children | A category. Its own text is an intro note and is ignored. |
| Below top level, has children | A sub-category. Text of its own beside the sub-tabs is reported as skipped. |
| Below top level, no children, two or more lines | One recipe. Its title names it; its lines are the recipe. |
| Any level, no children, no lines, `nonText` false | Empty. Passed over without a report. |

A recipe files under its nearest titled ancestor, so `mains > soups > Lentil soup` has the category "soups".

These leaf tabs are reported as skipped, each with a sentence saying why, and are not synced:

- a top-level tab with content and no children (a recipe put at the top level);
- a tab with `nonText` true and no lines (a photo of a recipe card);
- a tab whose title has no Latin letters or digits to make a slug from;
- a second tab whose title gives the same slug as an earlier one (the first wins);
- a tab with exactly one line (too little to be a recipe).

**Identity.** A recipe's identity is the slug of its title (`slugify`): trailing `*` removed (a household's "needs work" marker), accents folded, lowercased, apostrophes dropped, and every other run of characters that aren't letters or digits turned into one hyphen. "Crème brûlée *" and "creme brulee" are the same recipe. Renaming a tab therefore makes a new recipe and leaves the old row behind, named as stale in the Refresh result. The Refresh never deletes.

**What is extracted.** For each recipe tab the app builds the text `title + "\n" + lines.join("\n")` and sends it to the configured model to extract a structured recipe (`extractRecipeFromText`). The result is upserted into the `doc_recipes` table (`app/drizzle/schema.ts`) on `doc_slug`:

- `name`, `category` (lowercased key), `category_title` (as written), `doc_position` (order in the walk);
- `ingredients`, `steps`, `step_ingredients`, `estimated_time`, `serves`, `tags`, `notes`;
- `raw_doc_text` (the text that was sent) and `extraction_error` (null when it worked);
- a serving estimate when the recipe states none (`serves_estimate`, with its basis and source hash);
- the recipe's cook plan, or why one couldn't be made (`cook_plan`, `cook_plan_error`, with a source hash and stamp).

A failed extraction never overwrites a row that extracted before. A recipe whose extraction failed is still listed in its chapter, by name, but can't be cooked.

**Refresh costs money.** Every Refresh sends every recipe tab to the model again, four at a time: one extraction call per recipe, plus a serving-estimate call for a recipe that states no count and whose text changed, plus a cook-plan call for a recipe whose extracted recipe changed or that has no plan yet. Plan calls stop starting once the Refresh has run 200 seconds or its plan calls could pass 50 cents (`REFRESH_PLAN_BUDGET_MS` and `REFRESH_MAX_USD` in `app/src/lib/library-cook-plans.ts`); the recipes left over are saved without a plan and the Refresh's line says to Refresh again. A collection of 150 recipes is at least 150 model calls per Refresh. It needs a model key (`docs/environment.md`); without one every recipe fails extraction.

## Where the app calls it

| Call | Where | Triggered by |
| --- | --- | --- |
| `readTabs()` | `syncRecipesFromDoc` in `app/src/lib/recipe-sync.ts`, behind the `syncRecipes` procedure in `app/src/server/routers/_app.ts` | The cook taps Refresh in the household book (`app/src/app/kitchen/cookpacks/[packId]/page.tsx`) |

Nothing else calls the hook. Everything the cook sees afterwards is read from `doc_recipes`: the shelf (`getShelf`), the book (`getPack`), the plan report (`libraryPlanReport`) and a send to the queue (`queueFromPack`).

## What the cook sees

**Unconnected.** The shelf (`/kitchen/cookpacks`) has no household book. `getShelf` answers `household: null`; `getPack` and `queueFromPack` answer not found for the household book; `syncRecipes` is refused; `libraryPlanReport` answers zeros.

**Connected.** The household book stands first on the shelf, labelled with how many recipes it holds, or with a prompt to open it and Refresh before the first one. Inside, recipes are listed in chapters by category in the collection's order, with a search field and a Refresh control. A Refresh takes a minute or two for a large collection and ends with one line saying how it went: how many recipes came through, which didn't (by name), which came in without their steps or notes, how many saved recipes are no longer in the collection, and any trouble with cook plans. The line doesn't say why a tab was skipped; each reason is in the `failures` list the `syncRecipes` procedure returns. Picking a recipe queues it and opens the cook view.

## A minimal implementation

A folder on disk. Each sub-folder of the root is a category (a top-level tab with children); each `.txt` or `.md` file inside is a recipe (a leaf): `title` is the file name without its extension, `lines` are the file's non-blank lines with a leading bullet removed, `nonText` is false, `children` is `[]`. Sort folders and files by name, or by a number prefix you strip. Reject if the root folder can't be read.

Other shapes that fit as easily: one JSON file holding the tree as is; a Postgres table of `(parent_id, position, title, body)` rows; a notes app's export.

## Connecting it

1. Write an object that satisfies `RecipeLibrarySource`.
2. Put it in the `"recipe-library"` slot of `implementations` in `app/src/lib/hooks/registry.ts` (shipped as `null`).
3. Set `"recipe-library"` to `true` in `connected` in `app/src/lib/hooks/connected.ts`.

The app reaches the implementation through `hook("recipe-library")` in `registry.ts`, and only after checking `connected["recipe-library"]`. With the switch on and the slot still `null`, the first use throws `The "recipe-library" hook is switched on in lib/hooks/connected.ts but has no implementation in lib/hooks/registry.ts. Its spec is docs/hooks/recipe-library.md.` The Refresh reports that as a failed read: the book says it couldn't reach the recipe library, and the message is in the browser console. With the switch off, the implementation is never called.

## Acceptance checklist

- [ ] With a collection of one category holding two recipes of several lines each, Refresh says "Refreshed all 2 recipes.", and the shelf shows the household book with "2 recipes".
- [ ] The book lists the two recipes under the category's title as you wrote it, in your order.
- [ ] Picking one opens the cook view with its ingredients and steps.
- [ ] Add a one-line tab: the next Refresh says "Refreshed 2 of 3." and names the tab as one that didn't come through; the procedure's `failures` entry for it says why ("a single line of text"). The other two still come through.
- [ ] Rename a recipe tab: the next Refresh syncs the new name and names the old one as no longer in the collection. Nothing is deleted.
- [ ] Give two tabs the same title: only the first syncs, and the second is reported.
- [ ] Make the store unreachable: Refresh fails with a line saying so, and the book still shows the recipes from the last good Refresh.
- [ ] Point the hook at an empty collection: Refresh fails, saying the recipe library has no recipe tabs to read, rather than reporting 0 of 0.
- [ ] Switch the hook off again: the household book leaves the shelf, and the bundled pack still cooks.
