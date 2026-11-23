# Hook: shopping-list

One shared list of things to buy. The cook adds an item from the kitchen tablet, optionally tagged with the recipe it is for, and reads the list grouped by aisle or by recipe; anyone else who shops can use the same list from wherever it is kept.

As shipped this hook is unconnected: the Shopping list entry is hidden on the home screen.

## Interface

From `app/src/lib/hooks/types.ts`:

```ts
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
```

`ShoppingListItem` is defined in `app/src/lib/shopping-list-format.ts`:

| Field | Type | Holds |
| --- | --- | --- |
| `raw` | string | The line as stored, without a leading bullet glyph: "Lemons (2) — Tuesday beans" |
| `item` | string | The part before " — ": "Lemons (2)" |
| `forRecipe` | string or null | The part after " — ": "Tuesday beans" |
| `key` | string | The deduplication key: "lemons" |
| `aisle` | `ShoppingAisle` | The grocery aisle the item is filed under |

## The line format

The list is an ordered sequence of text lines. A line is either `<item>` or `<item> — <for>`: the separator is a space, an em dash (U+2014) and a space. Store lines as text and nothing else; everything on `ShoppingListItem` is derived from the line by the helpers in `shopping-list-format.ts`, which your implementation should call rather than reimplement:

| Helper | Use |
| --- | --- |
| `formatShoppingLine(item, forRecipe)` | Makes the line to store. Removes a leading bullet glyph, turns newlines and tabs into spaces, and appends ` — <for>` when a `forRecipe` is given and the item doesn't already contain the separator. Throws on an empty item. |
| `parseShoppingLine(line)` | Makes the `ShoppingListItem` for a stored line: `raw`, `item`, `forRecipe`, `key` and `aisle`. |
| `shopItemKey(text)` | The key two lines share when they are the same item: the part before ` — `, with anything in parentheses and anything after the first comma removed, trimmed and lowercased. "Lemons (2) — Tuesday beans", "lemons, organic" and "LEMONS" all have the key `lemons`. |

`aisle` is one of eight fixed aisles (`SHOPPING_AISLES`: Produce, Dairy & eggs, Meat & seafood, Pantry, Spices & sauces, Frozen, Bakery, Other), chosen by keyword from the item's text. It is computed on read, never stored.

## Methods

**`list()`** returns the lines in order, each through `parseShoppingLine`, and the time of the read as `syncedAt`. An empty list is `{ items: [], syncedAt: new Date() }`. Skip blank lines. Reject when the store can't be read.

**`add(inputs)`** handles the inputs in order. For each: make the line with `formatShoppingLine`, take its key with `shopItemKey`, and skip it if the key is empty or already on the list, counting lines added earlier in the same call. Otherwise put the line at the end. Return the lines added, exactly as stored, in order. Adding only duplicates returns `{ added: [] }` and changes nothing, which makes a repeated call harmless.

The app's procedure has already trimmed each `item`, removed a leading bullet and limited it to 200 characters, and accepts 1 to 50 items per call.

**`remove(rawOrKey)`** removes every line whose `raw` equals `rawOrKey` ignoring case, or whose key equals `shopItemKey(rawOrKey)`. Because of the key match, removing "lemons" also removes "Lemons (2) — Tuesday beans". Return `{ removed: true }` if any line went and `{ removed: false }` if none did; a second call for the same item returns `false`.

**`clear()`** removes every line and returns how many there were. On an empty list it returns `{ cleared: 0 }`.

**Other writers.** The list is meant to be shared, so lines may be added, reordered or removed between calls. Read the current list inside each `add`, `remove` and `clear` rather than trusting an earlier read, and make each call one atomic change where the store allows.

All four reject when the store can't be reached, and bound their own time.

## Where the app calls it

All four calls come from one screen, `app/src/components/kitchen/ShoppingListModal.tsx`, through four procedures in `app/src/server/routers/_app.ts`:

| Call | Procedure | Triggered by |
| --- | --- | --- |
| `list()` | `getShoppingList` | Opening the shopping list, and after every change |
| `add()` | `addShoppingListItems` | The Add button, with the item field and the optional "for" field |
| `remove()` | `removeShoppingListItem` | Tapping an item's remove control (the item's `raw` line is sent) |
| `clear()` | `clearShoppingList` | Clear all, which takes two taps |

The screen opens from More, the pull-out tab on the home screen's right-edge rail, and directly at `/kitchen?shopping=true`.

## What the cook sees

**Unconnected.** There is no Shopping list entry on the home screen and the screen is not mounted. The four procedures answer empty (`{ items: [], syncedAt: new Date(0) }`, `{ added: [] }`, `{ removed: false }`, `{ cleared: 0 }`). A link to `/kitchen?shopping=true` opens the home screen with no list.

**Connected.** The Shopping list entry opens a screen with an add row (item, and what it is for), the list, a three-way grouping (by aisle, by recipe, all) and Clear all. Grouped by recipe, items with no "for" fall under "General". While the list loads the screen says so; a rejected `list()` shows "Couldn't reach the shopping list." with a retry; a rejected change shows the error's message above the list.

## A minimal implementation

A Postgres table `shopping_list(position serial primary key, line text not null)`. `list()` selects in `position` order and maps `parseShoppingLine` over the lines. `add()` runs in one transaction: read the keys present, format and filter the inputs, insert the survivors. `remove()` deletes the rows whose line matches by raw text or key, which is easiest done by reading the rows and deleting by `position`. `clear()` deletes all rows and returns the count.

A text file with one line per item works for a single household on one server. A block of bullet lines in a shared document, which is how the author's deployment kept it, lets other people and programs edit the same list.

## Connecting it

1. Write an object that satisfies `ShoppingListStore`.
2. Put it in the `"shopping-list"` slot of `implementations` in `app/src/lib/hooks/registry.ts` (shipped as `null`).
3. Set `"shopping-list"` to `true` in `connected` in `app/src/lib/hooks/connected.ts`.

The app reaches the implementation through `hook("shopping-list")` in `registry.ts`, and only after checking `connected["shopping-list"]`. With the switch on and the slot still `null`, the first use throws `The "shopping-list" hook is switched on in lib/hooks/connected.ts but has no implementation in lib/hooks/registry.ts. Its spec is docs/hooks/shopping-list.md.` The screen then says it couldn't reach the shopping list, and shows the message itself after a change. With the switch off, the implementation is never called.

## Acceptance checklist

- [ ] The Shopping list entry appears in the home screen's More pull-out and opens an empty list.
- [ ] Add "Lemons (2)" for "Tuesday beans": the store holds the line `Lemons (2) — Tuesday beans`, and the screen shows it under Produce by aisle and under "Tuesday beans" by recipe.
- [ ] Add "lemons": nothing is added, and the list still has one line.
- [ ] Add "Paper towels": it shows under Other.
- [ ] Add a line by hand in the store: it appears the next time the screen opens.
- [ ] Remove the lemons from the screen: the line leaves the store.
- [ ] Clear all with two taps: the store is empty and the screen says the list is empty.
- [ ] Make the store unreachable and open the screen: it says it couldn't reach the shopping list and offers a retry.
- [ ] Switch the hook off again: the entry goes from the home screen.
