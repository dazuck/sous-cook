# Moving a kitchen's data in and out

Two commands on the operator script (`app/scripts/kitchens.ts`) export one kitchen's data to a JSON file and import it into another kitchen:

```sh
export DATABASE_URL=postgres://localhost:5432/sous

pnpm --dir app kitchens export --kitchen home --out home-backup.json
pnpm --dir app kitchens import --kitchen north --file home-backup.json --dry-run
pnpm --dir app kitchens import --kitchen north --file home-backup.json
```

Both commands work in single-kitchen mode (the `home` kitchen with `SOUS_SIGN_IN=off`) and in sign-in mode. The kitchen must already exist before exporting or importing.

## File format (`"format": 1`)

The file is UTF-8 JSON with a top-level object:

```json
{
  "format": 1,
  "about": "Two adults, gas stove, cast iron skillet.",
  "recipes": [],
  "queue": [],
  "cookLog": [],
  "pantry": [],
  "shoppingList": [],
  "ideas": []
}
```

`"format"` is required and must be `1`. Unknown format numbers and unknown top-level section names are refused.

The seven sections are:

- `about`: the "About my kitchen" text (`kitchens.about`, at most 2,000 characters).
- `recipes`: the kitchen's synced recipe book (`doc_recipes`).
- `queue`: the kitchen's recipe queue (`kitchen_queue`), including pending, cooking, completed, and cancelled rows.
- `cookLog`: the kitchen's cook history (`kitchen_cook_log`).
- `pantry`: the kitchen's pantry sections (`kitchen_pantry_sections`) and items (`kitchen_pantry_items`).
- `shoppingList`: the kitchen's shopping list lines (`kitchen_shopping_list`).
- `ideas`: the kitchen's saved recipe ideas (`kitchen_ideas`).

On export, all seven sections are always written in deterministic order (`format`, `about`, `recipes`, `queue`, `cookLog`, `pantry`, `shoppingList`, `ideas`). On import, every section except `format` is optional; omitted sections leave the target kitchen's data in those tables unchanged.

## What is left out of the export

Local database identifiers and deployment-specific records are omitted so files stay portable and safe to move between kitchens:

- Database row UUIDs (`id`), `kitchenId`, and `position` sequence numbers
- Member references (`cookedByMemberId`, `completedByMemberId`, `targetUser`), invites, and sessions
- Webhook tokens, AI usage logs, and cook reports
- Transient lock columns (`cookLogClaimedAt`, `recipe_ideas_cache`) and wall-clock export metadata (`exportedAt`, kitchen slug)
- Cook-log visibility flags (`notePrivate`, `heldBack`, `visibilityChosen`)

Because visibility flags are local to a kitchen, imported cook-log entries always arrive with private notes (`notePrivate: true`) and held-back dishes (`heldBack: true`, `visibilityChosen: true`). A cook can choose to share them later in the target kitchen.

## Section fields

### `about`

A string up to 2,000 characters (`kitchens.about`).

### `recipes`

Sorted by `docPosition` ascending (nulls last), then `docSlug` ascending. Duplicate `docSlug` entries in the same file are refused.

| Field | Type | Notes |
| --- | --- | --- |
| `docSlug` | `string` | Required, non-empty, unique within the kitchen. |
| `name` | `string` | Required. |
| `rawDocText` | `string` | Required. |
| `category` | `string \| null` | Optional, defaults to `null`. |
| `categoryTitle` | `string \| null` | Optional, defaults to `null`. |
| `docPosition` | `integer \| null` | Optional, defaults to `null`. |
| `ingredients` | `array \| null` | Optional list of `{ item, amount?, unit? }`. |
| `steps` | `string[] \| null` | Optional, defaults to `null`. |
| `estimatedTime` | `object \| null` | Optional `{ active?, passive?, total? }` in minutes. |
| `serves` | `integer \| null` | Optional, defaults to `null`. |
| `tags` | `string[] \| null` | Optional, defaults to `null`. |
| `notes` | `string \| null` | Optional, defaults to `null`. |
| `stepIngredients` | `number[][] \| null` | Optional per-step ingredient indices. |
| `extractionError` | `string \| null` | Optional, defaults to `null`. |
| `syncedAt` | `string` | ISO-8601 timestamp; defaults to import time if omitted. |
| `servesEstimate` | `integer \| null` | Positive integer if set; paired with basis and hash. |
| `servesEstimateBasis` | `string \| null` | Required string when `servesEstimate` is set; `null` otherwise. |
| `servesEstimateSourceHash` | `string \| null` | Required string when `servesEstimate` is set; `null` otherwise. |
| `cookPlan` | `object \| null` | Optional `{ version, tasks }`. |
| `cookPlanError` | `string \| null` | Must be `null` when `cookPlan` is set. |
| `cookPlanSourceHash` | `string \| null` | Optional, defaults to `null`. |
| `cookPlanStamp` | `string \| null` | Optional, defaults to `null`. |
| `isPrivate` | `boolean` | Optional, defaults to `false`. |

### `queue`

Sorted by `createdAt` ascending, then `status`, then recipe name.

| Field | Type | Notes |
| --- | --- | --- |
| `status` | `string` | Required: `"pending"`, `"cooking"`, `"completed"`, or `"cancelled"`. |
| `createdAt` | `string` | Required ISO-8601 timestamp. |
| `recipeNotionId` | `string \| null` | Optional, defaults to `null`. |
| `recipeData` | `object \| null` | Optional `{ name, ingredients?, steps?, estimatedTime?, serves?, tags?, notes?, stepIngredients?, source? }`. |
| `cookPlan` | `object \| null` | Optional `{ version, tasks }`. |
| `cookPlanError` | `string \| null` | Optional, defaults to `null`. |
| `startedAt` | `string \| null` | Optional ISO-8601 timestamp. |
| `completedAt` | `string \| null` | Optional ISO-8601 timestamp. |
| `cookLog` | `object \| null` | Optional `{ row, timestamp, recipeName, adopted }`. |
| `cookLogError` | `string \| null` | Optional, defaults to `null`. |
| `ratingClosedAt` | `string \| null` | Optional ISO-8601 timestamp. |
| `servesEstimate` | `integer \| null` | Positive integer if set; paired with basis and hash. |
| `servesEstimateBasis` | `string \| null` | Required string when `servesEstimate` is set; `null` otherwise. |
| `servesEstimateSourceHash` | `string \| null` | Required string when `servesEstimate` is set; `null` otherwise. |
| `intakeRecipe` | `object \| null` | Optional recipe object. |
| `intakeError` | `string \| null` | Must be `null` when `intakeRecipe` is set. |
| `intakeSourceHash` | `string \| null` | Optional, defaults to `null`. |
| `intakeStamp` | `string \| null` | Optional, defaults to `null`. |
| `intakeAttempts` | `integer \| null` | Optional non-negative integer. |
| `intakeNudges` | `string[] \| null` | Optional, defaults to `null`. |
| `finishedBy` | `string \| null` | Optional `"pressed"`, `"auto"`, or `null`. |
| `lastScreenActiveAt` | `string \| null` | Optional ISO-8601 timestamp. |
| `lastInteractionAt` | `string \| null` | Optional ISO-8601 timestamp. |
| `isPrivate` | `boolean` | Optional, defaults to `false`. |

### `cookLog`

Sorted by `cookedAt` ascending, then `timestampText`, then `recipeTitle`.

| Field | Type | Notes |
| --- | --- | --- |
| `recipeTitle` | `string` | Required. |
| `timestampText` | `string` | Required display timestamp (for example `"2026-11-20 18:30"`). |
| `cookedDay` | `string` | Required day string (for example `"2026-11-20"`). |
| `cookedAt` | `string` | Required ISO-8601 timestamp. |
| `docSlug` | `string \| null` | Optional link to a `doc_recipes` row by `docSlug` in the target kitchen. |
| `packSource` | `string \| null` | Optional, defaults to `null`. |
| `recipeSnapshot` | `object \| null` | Optional recipe snapshot object. |
| `rating` | `integer \| null` | Optional integer from `1` to `5`. |
| `notes` | `string` | Optional, defaults to `""`. |
| `noteUpdatedAt` | `string \| null` | Optional ISO-8601 timestamp. |

### `pantry`

An array of pantry section objects in `position` order. Duplicate `rawHeading` values (ignoring case and surrounding whitespace) in the same file are refused.

| Field | Type | Notes |
| --- | --- | --- |
| `rawHeading` | `string` | Required non-empty section heading (for example `"Fridge"`). |
| `items` | `string[]` | Required array of non-empty item lines in `position` order. |

### `shoppingList`

An array of non-empty shopping list lines in `position` order.

### `ideas`

An array of non-empty saved recipe idea lines in `position` order.

## Import guarantees

1. **Whole-file check first.** Import parses and validates the entire JSON document before opening a write transaction. If anything is invalid, it refuses the file and names the first fault with its JSON path (for example `cookLog[0].rating: expected integer between 1 and 5`).
2. **All or nothing.** All writes run inside a single database transaction. If any write fails, nothing is committed.
3. **Safe to run twice.** Recipes match on `docSlug`, queue rows match on `(createdAt, recipeNotionId, recipeData)`, cook-log rows match on `(cookedDay, timestampText, recipeTitle, cookedAt)`, pantry sections match on `rawHeading` (case-insensitive) with items matched per section, shopping list lines match on `shopItemKey` (or normalized line when empty), and ideas match by line text. Re-running import skips rows already present and adds no duplicates.
4. **Dry run.** Passing `--dry-run` validates the file, compares it against the target kitchen, prints the counts that would be added or skipped, and writes nothing.
5. **Round-trip stability.** Exporting a kitchen, importing into an empty kitchen, and exporting the target kitchen again produces the exact same JSON file byte-for-byte.
