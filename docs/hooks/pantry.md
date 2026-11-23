# Hook: pantry

A plain list of the food in the house, under headings such as Fridge and Freezer. The cook adds groceries by voice, photo or typed list; when a cook finishes, the app offers to cross off what the recipe used; and Ask knows what is on hand.

As shipped this hook is unconnected: the Add ingredients entry is hidden, finishing a cook goes straight to done, and Ask knows nothing about the pantry.

## Interface

From `app/src/lib/hooks/types.ts`:

```ts
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
```

## The pantry's shape

The pantry is an ordered list of sections. Each has a heading the household chose and an ordered list of lines; a line is free text with the quantity written in ("2 avocados", "sour cream", "5 lbs potatoes"). There are no item ids, units or structured quantities: a line is identified by its text.

**Food sections.** A section is a food section unless its heading, lowercased and trimmed, starts with `our setup` or `our family` (`isFoodInventoryHeading`). Those two prefixes are for notes a household keeps beside its inventory, such as an equipment list. The app never adds to, changes or sends to the model for cross-off anything in a non-food section, and your store must not either. If you don't keep such notes, every section is a food section.

**Headings the app reads by keyword.** For Ask, the app sorts food sections into three groups by heading:

| Heading (lowercased) | Group |
| --- | --- |
| contains `freezer` | Freezer |
| contains `perishable`, `aromatic` or `garden`, or is exactly `fridge` | Fridge |
| anything else | Pantry |

Ask is given the first 10 Freezer lines, the first 15 Pantry lines and the first 8 Fridge lines, so put what matters most at the top of a section.

**Headings the model is told about.** The grocery parser suggests one of five section names for each item: "Fridge", "Freezer", "Pantry", "Spice Rack" and "Oils, Vinegars & Sauces". On the confirm screen the cook can change an item's section to any of those five or "Produce". In the cross-off step the model is told to treat anything under "Spice Rack" or "Oils, Vinegars & Sauces" as a staple, which is listed but not preselected for removal. A pantry with those headings works with no mapping. Any other headings work too, through the matching in `addItems` below.

## Methods

**`readSections()`** returns every section in order, non-food ones included, read fresh each time (the list is also edited outside the app, so don't cache). `heading` is `rawHeading` trimmed and lowercased. `items` has one entry per non-blank line, in order, with a leading bullet glyph removed and nothing else changed. A pantry with no sections returns `[]`. Reject when the store can't be read.

**`addItems(items)`** adds each item's `text`, trimmed, as a new last line of one food section and returns how many lines it added. Skip an item whose text is empty. The interface leaves "closest" to the store. A rule that places every name the app suggests:

1. the food section whose `heading` equals the suggestion, ignoring case;
2. else the first food section whose heading contains the suggestion, or is contained in it;
3. else, if the suggestion contains `fridge`, `perish`, `produce` or `veg`, the first food section whose heading contains `fridge` or `perish`;
4. else, if the suggestion contains `freezer`, the first food section whose heading contains `freezer`;
5. else the first food section whose heading contains `pantry`;
6. else, or with no suggestion at all, the first food section.

Reject if the pantry has no food section: there is nowhere to put the item. `addItems([])` returns `{ added: 0 }` without touching the store. It is not idempotent: calling it twice adds the lines twice, and the app does not deduplicate.

**`applyUpdates(actions)`** changes existing lines in food sections and returns how many actions found a line. For each action, find a line whose text equals `oldText` ignoring case and surrounding whitespace. Each line can be taken by one action only, so two actions with the same `oldText` take two lines if there are two. Then:

- `delete`: remove the line.
- `decrement`: replace the line's text with `newText`, trimmed. With `newText` missing or blank, leave the line as it is.

An action with no matching line is skipped and not counted. `section` is a hint for stores that hold the same text in two sections; a store may ignore it and take the first match in order. `applyUpdates([])` returns `{ updated: 0 }`. Apply the whole batch or none of it where the store allows. Running the same deletes twice is harmless: the second run finds nothing.

All three reject when the store can't be reached, and bound their own time.

## Where the app calls it

| Call | Where | Triggered by |
| --- | --- | --- |
| `readSections()` | Ask's context in `app/src/lib/claude.ts` | Every message sent to Ask. A rejected read is logged and Ask answers without the pantry. |
| `readSections()` | `getRecipePantryReconciliation` in `app/src/server/routers/_app.ts`, then `reconcileRecipeIngredients` in `app/src/lib/pantry-reconciliation.ts` | Done on a recipe's last screen. The food sections and the recipe's ingredients go to the model, which proposes lines to remove or reduce. A rejected read answers no candidates, and the cook finishes as if nothing matched. |
| `applyUpdates()` | `applyPantryReconciliation` in `_app.ts` | The cook confirms the mark-used sheet (`app/src/components/kitchen/MarkUsedSheet.tsx`). A rejected call is logged in the browser console and the cook still finishes. |
| `addItems()` | `addIngredientsToPantry` in `_app.ts` | The cook confirms the parsed list in Add ingredients (`app/src/components/kitchen/AddIngredientsModal.tsx`) |

Two steps around these calls use the model and no hook: `parseGroceryInput` turns a voice transcript, a photo or typed text into lines with suggested sections, and the cross-off proposal above. Both need a model key (`docs/environment.md`). Without one, Add ingredients parses nothing and the mark-used sheet never has candidates, so it never shows.

## What the cook sees

**Unconnected.** The home screen has no Add ingredients entry and its screen is not mounted. Done finishes the cook at once, with no mark-used sheet. Ask's reference information has no pantry lines. The procedures above answer empty (`{ items: [] }`, `{ candidates: [] }`, a count of 0).

**Connected.**

- *Add ingredients*, an icon on the home screen's right-edge rail, opens a screen with three ways in: speak a list, photograph a receipt or a haul, or type. The app shows the parsed lines with a section each for the cook to confirm, then adds them.
- *At finish*, Done opens a sheet listing pantry lines the recipe used: lines to remove are preselected, lines to reduce show their new text ("5 lbs potatoes" becomes "4 lbs potatoes"), and staples are listed unselected. The cook adjusts and confirms, or skips, and the cook finishes either way. If nothing matches, the sheet never appears. A cook the app finishes on its own gets no sheet.
- *Ask* can answer "what can I use up?" from the pantry lines.

## A minimal implementation

A JSON file `{ "sections": [{ "heading": "Fridge", "items": ["2 avocados"] }, …] }`, read and rewritten whole on each call, with the write done by renaming a temporary file into place. Start it with the five headings listed above and no items.

A Postgres table `pantry_items(id, section, position, text)` plus a small `pantry_sections(position, heading)` table works the same way and survives concurrent writers. A shared text document with headings and bullet lists, which is how the author's deployment kept it, lets the household edit the list by hand; the app tolerates that because it identifies lines by text and reads fresh each time.

## Connecting it

1. Write an object that satisfies `PantryStore`.
2. Put it in the `pantry` slot of `implementations` in `app/src/lib/hooks/registry.ts` (shipped as `null`).
3. Set `pantry` to `true` in `connected` in `app/src/lib/hooks/connected.ts`.

The app reaches the implementation through `hook("pantry")` in `registry.ts`, and only after checking `connected.pantry`. With the switch on and the slot still `null`, the first use throws `The "pantry" hook is switched on in lib/hooks/connected.ts but has no implementation in lib/hooks/registry.ts. Its spec is docs/hooks/pantry.md.` Add ingredients then fails to save, with the message in the browser console; the mark-used step and Ask log it and go on without the pantry. With the switch off, the implementation is never called.

## Acceptance checklist

- [ ] The Add ingredients icon appears on the home screen's rail.
- [ ] Type "2 avocados, frozen peas, cumin" into Add ingredients and confirm: each line lands at the end of the section the screen showed for it, and the `count` that `addIngredientsToPantry` answers equals the lines added (the screen closes without showing it).
- [ ] Suggest a section your pantry doesn't have (rename "Spice Rack" to "Spices" in your store): the item still lands in a food section, by the matching rules.
- [ ] Put a line under a heading starting "Our setup": it is returned by `readSections()` but is never changed by the app and never appears on the mark-used sheet.
- [ ] Add "5 lbs potatoes" and "sour cream", cook a recipe that uses 1 lb of potatoes and sour cream, and press Done: the sheet offers to reduce the potatoes and remove the sour cream. Confirm: the store holds "4 lbs potatoes" and no sour cream.
- [ ] Cook a recipe that uses nothing in the pantry: Done finishes with no sheet.
- [ ] Make the store unreachable and press Done: the cook still finishes.
- [ ] Ask "what's in my freezer?": the answer names lines from a section whose heading contains "freezer".
- [ ] Switch the hook off again: the icon goes and Done finishes at once.
