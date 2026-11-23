# Hook: ideas

A list of recipes to try some day. When the cook imports a recipe and isn't ready to cook it, "Save as inspiration" adds a line to the list; "Saved for later" shows the list.

As shipped this hook is unconnected: the import preview has no "Save as inspiration" and the shelf has no "Saved for later".

## Interface

From `app/src/lib/hooks/types.ts`:

```ts
export interface IdeasStore {
  /**
   * The whole list as text, one idea per line. The app keeps the last text
   * it read, and shows that (marked stale) when a read rejects.
   */
  readText(): Promise<string>;
  /** Adds one idea as a new last line. `line` is non-empty and trimmed. */
  append(line: string): Promise<void>;
}
```

## The list's shape

The list is plain text, one idea per line, in the order they were added. An idea is whatever was written: the app writes `<recipe name>` or `<recipe name> — <source>` (the source is the URL the recipe was imported from), and a person editing the list by hand may write anything. The app never parses a line, edits one or removes one; it only shows them.

## Methods

**`readText()`** returns the whole list as one string with a newline between ideas. The app splits on `\n`, trims each line and drops blank ones, so blank lines, trailing newlines and indentation are harmless. An empty list is `""`. Reject when the store can't be read: don't answer `""` for a failed read, because the app would replace its saved copy with an empty list.

**`append(line)`** adds `line` as a new last line. The app has already trimmed it and refused an empty one. It is not idempotent and the app does not check for duplicates: saving the same recipe twice gives two lines. Reject when the store can't be written.

Both bound their own time.

## The cache table

The app keeps the last text it read in the `recipe_ideas_cache` table (`app/drizzle/schema.ts`: `id`, `text`, `synced_at`), a single row replaced on every successful `readText()` (`getRecipeIdeas` in `app/src/lib/recipe-ideas.ts`). It is used for two things:

- **A rejected read.** The app answers with the cached text, marked stale, and the screen says it is showing a cached copy. With no cached row yet, the rejection passes through and the screen says it couldn't reach the list and has no copy saved.
- **The count on the shelf.** The number beside "Saved for later" is the count of lines in the cached text (`cachedIdeasCount`). It is read from the cache alone, so drawing the shelf never calls the hook. Before the list has been opened once, and while the cached list is empty, there is no count.

Your implementation doesn't touch this table. Note that `append` does not update it, so the count on the shelf changes the next time the list is opened.

## Where the app calls it

| Call | Where | Triggered by |
| --- | --- | --- |
| `readText()` | `getRecipeIdeas` in `app/src/lib/recipe-ideas.ts`, behind the `getRecipeIdeas` procedure in `app/src/server/routers/_app.ts` | Opening "Saved for later", from the shelf (`app/src/app/kitchen/cookpacks/page.tsx`) or from the idle home screen (`app/src/app/kitchen/page.tsx`) |
| `append()` | `saveRecipeIdea` in `recipe-ideas.ts`, behind the `saveRecipeIdea` procedure | "Save as inspiration" on an imported recipe's preview (`app/src/components/kitchen/RecipeImportModal.tsx`) |

## What the cook sees

**Unconnected.** The import preview offers to queue or cook the recipe and nothing else. `getRecipeIdeas` answers an empty list and `saveRecipeIdea` answers `{ success: false }` without calling anything.

**Connected.** The import preview has "Save as inspiration" under its other actions. "Saved for later" opens a screen that lists the ideas, one per row, with how many there are; an empty list says there are none yet and how to add one. Ideas are for reading: tapping one does nothing.

"Saved for later" has two ways in, and the first open has to come through the first one:

- A slip tucked into the household book on the shelf. The slip belongs to that book, so it is only there when the `recipe-library` hook is connected (`docs/hooks/recipe-library.md`). It is drawn whether or not `ideas` is connected; with `ideas` unconnected it opens an empty list.
- A "Saved for later" line with the count, under the idle home screen (no cook under way, nothing queued, nothing to rate). It shows only once the cache holds at least one idea, and the cache is filled by opening the list.

So with `ideas` connected alone, "Save as inspiration" works and the list fills, but the app has no way in to read it.

## A minimal implementation

A text file. `readText()` reads it (a missing file is `""`); `append()` appends the line and a newline. Use an append-mode write so two saves at once can't lose one.

A Postgres table `ideas(id serial primary key, line text not null)` with `readText()` joining the lines in `id` order works as well and needs no file system. A shared document, which is how the author's deployment kept it, lets the household add ideas from anywhere.

## Connecting it

1. Write an object that satisfies `IdeasStore`.
2. Put it in the `ideas` slot of `implementations` in `app/src/lib/hooks/registry.ts` (shipped as `null`).
3. Set `ideas` to `true` in `connected` in `app/src/lib/hooks/connected.ts`.

The app reaches the implementation through `hook("ideas")` in `registry.ts`, and only after checking `connected.ideas`. With the switch on and the slot still `null`, the first use throws `The "ideas" hook is switched on in lib/hooks/connected.ts but has no implementation in lib/hooks/registry.ts. Its spec is docs/hooks/ideas.md.` "Saved for later" treats that as a failed read (above), with the message in the server log. With the switch off, the implementation is never called.

## Acceptance checklist

- [ ] Import a recipe from a URL: the preview shows "Save as inspiration". Tap it: the store's last line is `<recipe name> — <the URL>`.
- [ ] Import a recipe from pasted text and save it: the line is the recipe's name alone.
- [ ] Open "Saved for later": both ideas are listed, in the order saved.
- [ ] Add a line by hand in the store, with a blank line after it: it appears on the next open, and the blank line doesn't.
- [ ] After the list has been opened once, the shelf shows the count beside "Saved for later".
- [ ] Make the store unreachable and open the list: it shows the last copy and says it is a cached copy.
- [ ] Empty the `recipe_ideas_cache` table with the store still unreachable: the screen says it couldn't reach the list and has no copy saved.
- [ ] Switch the hook off again: "Save as inspiration" goes from the import preview.
