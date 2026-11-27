# Sending recipes to Sous

Send a recipe to a Sous kitchen queue using `skills/sous-kitchen/send-recipe.mjs` and the webhook contract in `docs/webhook.md`.

## When to use this skill

Use this skill when a cook gives you a recipe (pasted text, notes, a link they already shared, or a dish from a bundled pack) and asks you to send or queue it into their Sous kitchen.

When using Sous over the `/api/mcp` connector and a cook asks to create or update a recipe collection (cookpack) on their shelf rather than queueing a single dish, call `get_pack_authoring_guide` first for the exact Pack Format v0.7 rules and allowed `commons:`/`state:` reference ids, then submit the flat pack object via `save_pack`. If `save_pack` reports validation errors, fix the named fields and re-submit.

## Environment requirements

`send-recipe.mjs` reads two environment variables:

- `SOUS_URL`: the Sous app base URL (must be `https://...`, or `http://` only for `localhost`, `127.0.0.1`, or `[::1]`).
- `SOUS_TOKEN`: the kitchen sending token created by the kitchen owner on Settings (or by the operator in single-kitchen mode).

Never pass `SOUS_TOKEN` as a command-line argument, never print it, and never write it into a file or JSON payload.

## Building the request body

`POST /api/kitchen-queue` accepts two JSON shapes. Never send `targetUser` (the token already identifies the kitchen) and never send `recipeNotionId` (it queues a row with no recipe to cook from).

### Shape 1: a pack recipe on the shelf (unchanged)

If the cook asks for an unchanged recipe from a pack on the shelf, send:

```json
{ "pack": "<packId>/<recipeId>" }
```

or:

```json
{ "packId": "<packId>", "recipeId": "<recipeId>" }
```

### Shape 2: a supplied or adapted recipe

Wrap the recipe inside `{ "recipeData": { ... } }`:

| Field | Type | Required | Notes |
| --- | --- | --- | --- |
| `name` | string | Yes | Non-empty recipe title. |
| `ingredients` | `{ item, amount?, unit? }[]` | At least one ingredient or one step | Strings only. Put the ingredient name in `item`. |
| `steps` | `string[]` | At least one ingredient or one step | One string per step, in order. |
| `stepIngredients` | `(number | { item, amount?, unit? })[][]` | No | Parallel to `steps`; 0-based indices into `ingredients` or matching `{ item }` objects. |
| `estimatedTime` | `{ active?, passive?, total? }` | No | Non-negative numbers in minutes. |
| `serves` | number | Recommended | Positive number. See below if unknown. |
| `tags` | `string[]` | No | Short label strings. |
| `notes` | string | No | Cook or creator notes. |
| `source` | string | No | URL or short text. Use `pack:<packId>/<recipeId>` only if adapting a shelf pack recipe. |

### Do not invent fields, and ask when required fields are unknown

1. Copy only what the user provided. Do not invent missing ingredient amounts, units, cook times, tags, notes, or extra steps.
2. If `name` is missing or unclear, ask the user what to call the recipe before sending.
3. If both `ingredients` and `steps` are empty or missing, ask the user for at least one ingredient or one step before sending.
4. If `serves` is unknown, ask the user how many servings the recipe makes. If they tell you to send it without a serving count, omit `serves` so the Sous server estimates it on queue (note that omitting `serves` fails with `503` if the server has no model key configured, or `429` if the monthly AI cap is reached).

## Checking and sending

1. Check the JSON first without sending:

```sh
node skills/sous-kitchen/send-recipe.mjs --dry-run <<'EOF'
{ "recipeData": { ... } }
EOF
```

2. When `--dry-run` succeeds, send it:

```sh
node skills/sous-kitchen/send-recipe.mjs <<'EOF'
{ "recipeData": { ... } }
EOF
```

The script prints one plain line for the outcome and exits with a non-zero code on any error.

## Worked example

User message:

> Queue "Crispy Chickpea Flatbreads" for dinner: 1 can (15 oz) chickpeas, 2 tbsp olive oil, 1 tsp smoked paprika, salt, and 2 flatbreads. Serves 2. Steps: Toss chickpeas with olive oil, paprika, and salt, then roast at 425F for 20 minutes. Warm the flatbreads for 2 minutes and spoon the chickpeas on top.

Every required field is present (`name`, `ingredients`, `steps`, `serves`), so build the payload without adding any unstated times or notes:

```json
{
  "recipeData": {
    "name": "Crispy Chickpea Flatbreads",
    "serves": 2,
    "ingredients": [
      { "item": "chickpeas", "amount": "1", "unit": "15 oz can" },
      { "item": "olive oil", "amount": "2", "unit": "tbsp" },
      { "item": "smoked paprika", "amount": "1", "unit": "tsp" },
      { "item": "salt" },
      { "item": "flatbreads", "amount": "2" }
    ],
    "steps": [
      "Toss chickpeas with olive oil, paprika, and salt, then roast at 425F for 20 minutes.",
      "Warm the flatbreads for 2 minutes and spoon the chickpeas on top."
    ]
  }
}
```

Check first with `--dry-run`:

```sh
SOUS_URL=https://sous.example.com node skills/sous-kitchen/send-recipe.mjs --dry-run <<'EOF'
{
  "recipeData": {
    "name": "Crispy Chickpea Flatbreads",
    "serves": 2,
    "ingredients": [
      { "item": "chickpeas", "amount": "1", "unit": "15 oz can" },
      { "item": "olive oil", "amount": "2", "unit": "tbsp" },
      { "item": "smoked paprika", "amount": "1", "unit": "tsp" },
      { "item": "salt" },
      { "item": "flatbreads", "amount": "2" }
    ],
    "steps": [
      "Toss chickpeas with olive oil, paprika, and salt, then roast at 425F for 20 minutes.",
      "Warm the flatbreads for 2 minutes and spoon the chickpeas on top."
    ]
  }
}
EOF
```

Output:

```text
Dry run: recipe "Crispy Chickpea Flatbreads" is valid to https://sous.example.com/api/kitchen-queue.
```

Then send with `SOUS_TOKEN` set in the environment:

```sh
node skills/sous-kitchen/send-recipe.mjs <<'EOF'
{
  "recipeData": {
    "name": "Crispy Chickpea Flatbreads",
    "serves": 2,
    "ingredients": [
      { "item": "chickpeas", "amount": "1", "unit": "15 oz can" },
      { "item": "olive oil", "amount": "2", "unit": "tbsp" },
      { "item": "smoked paprika", "amount": "1", "unit": "tsp" },
      { "item": "salt" },
      { "item": "flatbreads", "amount": "2" }
    ],
    "steps": [
      "Toss chickpeas with olive oil, paprika, and salt, then roast at 425F for 20 minutes.",
      "Warm the flatbreads for 2 minutes and spoon the chickpeas on top."
    ]
  }
}
EOF
```

Output:

```text
Queued "Crispy Chickpea Flatbreads" as 7e2c1a90-4b18-4f10-9a1d-2c4e6f8a0123.
```
