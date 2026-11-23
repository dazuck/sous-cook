# Hook: cook-log

A running record of what was cooked: one row per finished cook, with a 1 to 5 rating and a note. When a cook finishes, the app writes the row; later the kitchen asks "How was it?" and puts the answer in the same row, and Ask reads the last ten rows so a note like "too salty" is remembered next time.

As shipped this hook is unconnected: finishing a cook writes nothing and the kitchen never asks.

## Interface

From `app/src/lib/hooks/types.ts`:

```ts
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
```

The grid is addressed the way a spreadsheet counts: rows and columns both start at 1, and row 1 is the header. `(2, 4)` is the rating of the first cook.

## The grid's rules

- **Row 1 is the header**, the five names in `COOK_LOG_COLUMNS`. The app never writes it. Create your store with the header in place, and return it as `rows[0]` from `read()`.
- **Every cell is text**, stored and returned exactly as given. Don't turn `"4"` into a number or the timestamp into a date; the app compares cells as strings.
- **Columns:**

  | # | Name | Holds |
  | --- | --- | --- |
  | 1 | `timestamp` | When the cook finished: `YYYY-MM-DD HH:MM`, 24-hour, in the kitchen's time zone (`NEXT_PUBLIC_KITCHEN_TZ`, `docs/environment.md`; `Europe/London` unless set). |
  | 2 | `recipe_name` | The recipe's name, trimmed. |
  | 3 | `recipe_anchor` | The app writes the recipe's name here too. It never reads this column. |
  | 4 | `rating` | `"1"` to `"5"`, or empty until rated. |
  | 5 | `notes` | The cook's note, or empty. At most 500 characters from the app. |

- **Other writers are allowed.** A person or another program may add rows, sort them, delete them or fill in a rating. The app copes with that (below), so your store doesn't need locking.

## Methods

**`read()`** returns every row, header first, so `rows[i]` is row `i + 1`. Trailing empty cells may be left off (`["2026-11-16 18:40", "Weeknight dal"]` is a valid unrated row). A log with no cooks returns just the header row. Reject when the store can't be read.

**`append(row)`** adds one row after the last and returns its row number. The app always passes five cells: `[timestamp, name, name, "", ""]`. It is not idempotent on its own, and doesn't need to be: the app's adoption rule (below) keeps a retry from logging a cook twice. If the store can't say which row the append landed on, reject; the row then exists unlinked, and the retry adopts it.

**`write(row, col, values)`** overwrites `values.length` cells of one row, starting at `col`. The app makes exactly three kinds of call:

| Call | When |
| --- | --- |
| `write(row, 4, [rating])` | A rating with no note. The note already in column 5 is kept. |
| `write(row, 4, [rating, note])` | A rating with a note. |
| `write(row, 1, [timestamp])` | A cook that was reopened and finished again: its row moves to the new finish time, rating and note untouched. |

Reject when the row doesn't exist or the store can't be written.

**All three** must bound their own time. The first write of a cook runs after the HTTP response has been sent, where nothing else would stop a hung call, and the app treats a write that has stored no outcome after two minutes as lost.

## What the app does around the grid

These rules live in the app (`app/src/lib/kitchen-cook-log.ts` and the pure helpers in `app/src/lib/hooks/cook-log.ts`), not in your implementation, but the grid has to behave so that they work.

**Name matching.** Two names are the same when they are equal after trimming, collapsing runs of whitespace to one space and lowercasing (`normalizeRecipeName`).

**Adoption.** Before appending, the app reads the grid and looks, from the last row up, for a row whose timestamp starts with the cook's day (`YYYY-MM-DD`) and whose name matches. If there is one, the app adopts it (the latest, if several) and appends nothing. This makes a retry after a lost response safe, and lets another writer log the cook first. One consequence: the same dish cooked twice in one day is one row.

**Finding the row again.** The app remembers each cook's row number, timestamp and name on the queue item (`cook_log`, a JSON column of `kitchen_queue`). Before every later read or write it checks that the remembered row still holds that timestamp (exactly) and that name (matched as above). If not, it looks for the one row that does, so a sorted grid or a row inserted above is followed. If no row or several rows hold the cook, nothing is written and the kitchen says the row moved.

**Claim and retry.** Each write first claims the queue item (`cook_log_claimed_at`, a conditional update), so of two writes started together only one reaches the grid. The outcome is stored on the item: `cook_log` (the row) or `cook_log_error` (why not, cut to 500 characters). A claim older than two minutes is treated as lost and may be taken over. In that rare case both writes can append, which leaves a duplicate row to delete by hand; the app goes on using the row it stored.

**Reopened cooks.** A cook the app finished on its own (idle on the last screen) can be reopened and finished again. The app then moves the row's timestamp instead of appending a second row, but only for a row it appended itself. An adopted row keeps the time its writer gave it.

**Reading for Ask.** Of the rows after the header that have a name, the last ten are taken and listed newest first, so the grid is assumed to be in time order. The rating is parsed as a number. The name and the note are passed to the model with whitespace collapsed, angle brackets replaced and a 300-character cut, since anyone who can reach the app can type a note.

## Where the app calls it

| Call | Where | Triggered by |
| --- | --- | --- |
| `read()` then `append()` | `logCook` in `app/src/lib/kitchen-cook-log.ts`, run after the response by `updateKitchenQueueStatus` and `autoFinishCook` in `app/src/server/routers/_app.ts` | Done on the last screen, or Mark as done in the queue; the app finishing an idle cook; starting a new cook while another was left on its last screen |
| the same | `sweepAndLogIdleCooks` in `app/src/lib/kitchen-auto-finish.ts` | `POST /api/kitchen-queue/sweep` (`docs/webhook.md`) |
| the same | `retryCookLog` | "Try again" on the kitchen's line after a failed write |
| `read()` then `write(row, 4, …)` | `rateCook` | A tap on 1 to 5 under "How was it?" |
| `read()` then `write(row, 1, …)` | `logCook`, for a reopened cook | Done on a cook that was auto-finished and reopened |
| `read()` | `openCookAsk`, behind the `getCookAsk` procedure | The home screen polling for its ask (once a minute; every two seconds while a row is being written). Only while a finished cook from today has a written row and an open ask. |
| `read()` | Ask's context in `app/src/lib/claude.ts` | Every message sent to Ask |

## What the cook sees

**Unconnected.** Nothing. Done finishes the cook and no row is attempted. `getCookAsk` answers `null`, so "How was it?" never appears. Ask has no "Recently made" list.

**Connected.** After a cook finishes, and once no other cook is under way, the home screen shows "How was it?" over the dish's name, with five numerals, "Add a note" and "Not now". It asks about today's latest finished cook only, by the kitchen's time zone, and the ask lapses at midnight.

| State of the row | The line shows |
| --- | --- |
| Being written | The numerals, disabled, for the few seconds the write takes |
| Written, unrated | The numerals live; a tap writes the rating (and note) and the line goes |
| Write failed | "Not in the cook log yet." and "Try again"; a tap on a numeral also retries the write first |
| Rated by someone else in the grid | The line goes on the next poll |
| Row can't be found | "Its row in the cook log moved, so rate it there." |
| Grid can't be read | "Can't reach the cook log just now."; the numerals stay live |

## A minimal implementation

A Postgres table `cook_log(row_number serial primary key, timestamp text, recipe_name text, recipe_anchor text, rating text, notes text)` with one header row inserted at creation (row 1). `read()` selects all rows ordered by `row_number` and maps each to its five text cells; `append()` inserts and returns the new `row_number`; `write()` updates the named columns of one row and rejects if it matched none. If rows can be deleted, number them by position on read instead, so row numbers stay 1, 2, 3 with no gaps: the app's row finder indexes `rows[row - 1]`.

A spreadsheet with a header row fits the interface directly, which is how the author's deployment kept it. A CSV file works for a single process.

## Connecting it

1. Write an object that satisfies `CookLogGrid`.
2. Put it in the `"cook-log"` slot of `implementations` in `app/src/lib/hooks/registry.ts` (shipped as `null`).
3. Set `"cook-log"` to `true` in `connected` in `app/src/lib/hooks/connected.ts`.

The app reaches the implementation through `hook("cook-log")` in `registry.ts`, and only after checking `connected["cook-log"]`. With the switch on and the slot still `null`, the first use throws `The "cook-log" hook is switched on in lib/hooks/connected.ts but has no implementation in lib/hooks/registry.ts. Its spec is docs/hooks/cook-log.md.` A finish stores that message as the cook's `cook_log_error`, so the home screen says the cook isn't in the log yet and offers "Try again"; Ask logs it and answers without the recent cooks. With the switch off, the implementation is never called.

## Acceptance checklist

- [ ] Start with only the header row. Cook a recipe to Done: within a few seconds row 2 holds `[<now, YYYY-MM-DD HH:MM>, <name>, <name>, "", ""]`.
- [ ] The timestamp is in the configured time zone, not the server's.
- [ ] The home screen shows "How was it?" for that cook. Tap 4: cell (2, 4) reads `4`, the line goes, and column 5 is still empty.
- [ ] Cook another recipe, add a note, tap 5: columns 4 and 5 of row 3 hold `5` and the note.
- [ ] Before rating a cook, type a rating into its row by hand: within a minute the line goes without a tap.
- [ ] Insert a blank row above an unrated cook by hand, then rate it in the app: the rating lands in the cook's row, not the old row number.
- [ ] Queue and finish the same recipe twice in one day: the grid has one row for it, not two.
- [ ] Make the store unreachable and finish a cook: Done still works at once; the line shows "Not in the cook log yet." within a minute or two. Restore the store and tap "Try again": the row is written.
- [ ] Rate a dish with the note "too salty", cook it again and ask Ask how much salt to use: the answer takes the note into account.
- [ ] Switch the hook off again: Done writes nothing and no ask appears.
