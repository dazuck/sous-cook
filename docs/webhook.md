# The agent webhook

Three HTTP endpoints let a program outside the app (an assistant, a script, a cron job) send recipes to a kitchen, finish cooks left open overnight, and read the packs on the shelf.

| Endpoint | What it does | Code |
| --- | --- | --- |
| `POST /api/kitchen-queue` | Puts a recipe in the token's kitchen queue | `app/src/app/api/kitchen-queue/route.ts` |
| `POST /api/kitchen-queue/sweep` | Finishes cooks left idle on their last screen in the token's kitchen | `app/src/app/api/kitchen-queue/sweep/route.ts` |
| `GET /api/packs` | Lists the shared packs, or returns one recipe in full | `app/src/app/api/packs/route.ts` |

The examples assume the app at `http://localhost:3000` and the token in `$TOKEN`.

## Auth

All three endpoints share one check (`authenticateWebhookRequest` in `app/src/lib/kitchens/webhook-tokens.ts`). Every request must carry `Authorization: Bearer <token>`, in **every** environment (production, development, and tests): the token identifies which kitchen the request belongs to.

Tokens are created per kitchen with the operator script (`app/scripts/kitchens.ts`). Each token starts with `sous_` followed by 32 random bytes in base64url. Only its SHA-256 hex digest is stored in `kitchen_webhook_tokens`, so the plaintext token is printed once at creation. Every accepted request updates the token's `last_used_at` timestamp.

```sh
export DATABASE_URL=postgres://localhost:5432/sous
export SOUS_SIGN_IN=off   # required in single-kitchen mode (the "home" kitchen has no members)

pnpm --dir app kitchens token create --kitchen home --label agent
pnpm --dir app kitchens token list --kitchen home
pnpm --dir app kitchens token revoke --id <token-uuid>
```

In sign-in mode (`SOUS_SIGN_IN` unset or `on`), `token create` refuses a kitchen that has no members; in single-kitchen mode (`SOUS_SIGN_IN=off`), `home` has no members by design, so export `SOUS_SIGN_IN=off` when creating its token.

| Request | Answer |
| --- | --- |
| Missing `Authorization: Bearer <token>` header, unknown token, or revoked token | `401 {"error":"Unauthorized"}` |
| Valid unrevoked token | The call runs, scoped to that token's kitchen (or returns shared packs on `GET /api/packs`) |
| Deployment check refused (invalid configuration, or missing `"home"` kitchen, other kitchens, members, or invites in single-kitchen mode) | `500 {"error":"<message>"}` |
| `DATABASE_URL` unset, database unreachable, or database not migrated | `500` with an empty body (the reason is in the server log) |

In single-kitchen mode (`SOUS_SIGN_IN=off`), the app's own pages and tRPC procedures require no login or token, so run single-kitchen deployments on a private network or behind your own authentication (see Safety in [README.md](../README.md)).

## `POST /api/kitchen-queue`

Queues one recipe in the token's kitchen. The body is JSON and takes one of two shapes.

The kitchen always comes from the bearer token. Sending `targetUser` in the JSON body (with any value, including `""` or `null`) is refused with `400 {"error":"targetUser is no longer accepted: the token names the kitchen"}`.

### Shape 1: a recipe from a pack on the shelf

```json
{ "packId": "fannie-farmer-1896", "recipeId": "waffles" }
```

or the shorthand `{ "pack": "fannie-farmer-1896/waffles" }` (a leading `pack:` is allowed). `GET /api/packs` lists the ids.

```sh
curl -sS -X POST http://localhost:3000/api/kitchen-queue \
  -H "Authorization: Bearer $TOKEN" -H "Content-Type: application/json" \
  -d '{"pack":"fannie-farmer-1896/waffles"}'
```

Answers `201`:

```json
{
  "success": true,
  "id": "<queue row uuid>",
  "queueIds": ["<queue row uuid>"],
  "name": "<recipe title>",
  "source": "pack:fannie-farmer-1896/waffles",
  "mode": "native"
}
```

The recipe is queued with the cook plan stored for it in `app/pack-plans/`, so this shape needs no model key and works even if the kitchen's monthly AI allowance is used up.

### Shape 2: a recipe you supply

```json
{
  "recipeData": {
    "name": "Weeknight dal",
    "serves": 4,
    "ingredients": [
      { "item": "red lentils", "amount": "1", "unit": "cup" },
      { "item": "onion", "amount": "1" },
      { "item": "salt" }
    ],
    "steps": [
      "Rinse the lentils and simmer in 3 cups of water for 20 minutes.",
      "Fry the onion until golden and stir it into the lentils with salt."
    ],
    "stepIngredients": [[0], [1, 2]],
    "estimatedTime": { "active": 10, "total": 30 },
    "tags": ["weeknight"],
    "notes": "Good with rice.",
    "source": "https://example.com/dal"
  }
}
```

The schema requires only `name`, but a recipe with no ingredients and no steps is refused with `422` (`"a recipe needs at least one ingredient or one step"`), so send at least one of them. Every field:

| Field | Type | Notes |
| --- | --- | --- |
| `name` | string | Required. |
| `ingredients` | `{ item, amount?, unit? }[]` | All three are strings. |
| `steps` | string[] | One entry per step. |
| `stepIngredients` | array per step | Parallel to `steps`. Each entry is an index into `ingredients` (from 0) or an ingredient object, which is resolved to its index. |
| `estimatedTime` | `{ active?, passive?, total? }` | Minutes. |
| `serves` | number | See "Model calls" below when it is left out. |
| `tags` | string[] | |
| `notes` | string | |
| `source` | string | Free text or a URL. A value starting `pack:` or `pack-adapted:` is checked against the shelf (below). |

Unknown fields other than `targetUser` are dropped; `targetUser` is refused with `400`.

```sh
curl -sS -X POST http://localhost:3000/api/kitchen-queue \
  -H "Authorization: Bearer $TOKEN" -H "Content-Type: application/json" \
  -d '{"recipeData":{"name":"Weeknight dal","serves":4,"ingredients":[{"item":"red lentils","amount":"1","unit":"cup"}],"steps":["Rinse the lentils and simmer for 20 minutes."]}}'
```

Answers `200`:

```json
{
  "success": true,
  "queueIds": ["<queue row uuid>"],
  "conversion": { "...": "how many ingredient lines were read as each kind" }
}
```

The cook opens it at `/kitchen/queue/<queue row uuid>`.

**A `source` that names a pack.** When `recipeData.source` is `pack:<packId>/<recipeId>` and the rest of the payload is exactly what the app itself would queue for that pack recipe, the row is stored as that pack recipe. When the payload differs (the sender changed it), the source is rewritten to `pack-adapted:<packId>/<recipeId>` and the pack's creator notes are appended to `notes` if they are missing. When the source names no pack recipe on the shelf, the `source` field is dropped.

**Model calls.** A supplied recipe uses the configured model (see [environment.md](environment.md)), metered against the token's kitchen, at up to three points:

1. Before it is queued, only when `serves` is left out: one call to estimate a serving count. When a model key is set and the kitchen's or deployment's monthly AI allowance is used up, nothing is queued and the answer is `429`. If it fails for another reason (no key, the provider down), nothing is queued and the answer is `503`; with no model key, `503` comes first because the key is checked before the cap.
2. After the response, for a recipe that is not a pack recipe: an intake pass that cuts the recipe to the app's own shape (one step per stretch of work, one ingredient per line). If it fails or hits a monthly cap, it is tried again when the cook opens the recipe (a cap refusal stores no error); if it still fails, the cook gets the recipe as sent.
3. After the response: the cook plan. If it fails or hits a monthly cap, the cook view runs the recipe as written (a cap refusal stores no error, so it can derive after the monthly reset).

So with no model key — or when a monthly cap is reached — a supplied recipe that states `serves` still queues and cooks as written.

`recipeNotionId` (a string) is also accepted in place of `recipeData`. It is left from an older integration: the row it queues has no recipe to cook from. Don't use it.

### Errors

| Status | Body | When |
| --- | --- | --- |
| 400 | `{"error":"Invalid JSON body"}` | The body isn't JSON. |
| 400 | `{"error":"targetUser is no longer accepted: the token names the kitchen"}` | The JSON object carries a `targetUser` field (any value, including `""` or `null`). |
| 400 | `{"error":"Validation error","details":{…}}` | The body fits neither shape or a field has the wrong type. |
| 401 | `{"error":"Unauthorized"}` | Missing, unknown, or revoked bearer token. |
| 404 | `{"error":"Pack or recipe not found"}` | Shape 1 names a pack or recipe that isn't on the shelf, or the shorthand isn't `<packId>/<recipeId>`. |
| 422 | `{"error":"Recipe can't be read as a pack recipe", …}` | The cook page couldn't read this recipe (for example an ingredient line it can't parse). `issues` (Shape 2) or `differences` (Shape 1) says why, or the reason follows a colon in `error` itself. Nothing is queued. |
| 429 | `{"error":"ai_allowance_used","message":"…","resetsAt":"<ISO 8601 UTC timestamp>"}` | Shape 2 without `serves`, a model key is set, and the kitchen's or deployment's monthly AI cap is reached (with no model key, `503` comes first because the key is checked before the cap). Nothing is queued. |
| 503 | `{"error":"Couldn't work out how many this serves, so nothing was queued","reason":"…"}` | Shape 2 without `serves`, and the estimate call failed for a reason other than a monthly AI cap. Nothing is queued. |
| 500 | `{"error":"Failed to queue recipe","details":"…"}` | The database refused the insert. |
| 500 | `{"error":"<message>"}` | Deployment check refused (invalid configuration, or missing `"home"` kitchen, other kitchens, members, or invites in single-kitchen mode). |
| 500 | *(empty body)* | `DATABASE_URL` is unset, the database is unreachable, or the database is not migrated; the reason is in the server log. |

### Idempotency

None. Every accepted call inserts a new queue row, so a retry after a lost response queues the recipe a second time. These endpoints give a sender no way to check whether an earlier call landed, so retry only on an answer that says nothing was queued (a 4xx, the 503). The cook can remove a duplicate from the queue.

## `POST /api/kitchen-queue/sweep`

A tablet asleep on a recipe's last screen never tells the server the cook is done. The sweep finishes those cooks for the token's kitchen only: each cook that has sat on its last screen for 45 minutes past its last activity, with no timer still running, is marked completed, dated to that last activity. It is meant for a nightly job.

Body: `{}` only. Any field (including `targetUser`) is refused with `400 {"error":"Invalid sweep","details":[…]}`.

```sh
curl -sS -X POST http://localhost:3000/api/kitchen-queue/sweep \
  -H "Authorization: Bearer $TOKEN" -H "Content-Type: application/json" -d '{}'
```

Answers `200`:

```json
{
  "finished": [{ "queueId": "<uuid>", "name": "Weeknight dal", "cookLog": "none" }],
  "relogged": []
}
```

- `finished`: the cooks this call finished.
- `relogged`: cooks the app finished in the last three days whose cook-log write had failed, written again by this call.
- `cookLog` is where the cook's cook-log row stands after the call. The cook log is one of the six hooks (`docs/hooks/cook-log.md`). With it unconnected, as shipped, nothing is written: `cookLog` is always `"none"` and `relogged` stays empty. With it connected, `cookLog` is `"logged"`, `"failed"` for a write the app will offer to retry, or `"writing"` when another write of the same row was still under way.

Errors: `400 {"error":"Invalid JSON body"}`, `400 {"error":"Invalid sweep","details":[…]}`, and the Auth answers (`401`, `500`).

Idempotent: a cook it finished is no longer cooking, so a second call finds nothing to do.

## `GET /api/packs`

Reads the shared packs registered on the shelf (`app/src/lib/shelf/registry.ts`), so a sender can choose a recipe by id. Any valid kitchen bearer token is accepted.

**The digest**, with no query:

```sh
curl -sS http://localhost:3000/api/packs -H "Authorization: Bearer $TOKEN"
```

```json
{
  "packs": [
    {
      "id": "fannie-farmer-1896",
      "title": "…",
      "creator": { "name": "…", "bio": "…", "voice_notes": "…" },
      "description": "…",
      "recipes": [
        {
          "id": "…",
          "title": "…",
          "time_total_min": 45,
          "time_active_min": 15,
          "serves_base": 6,
          "tags": ["…"],
          "main_ingredients": ["…"],
          "hook": "…"
        }
      ]
    }
  ]
}
```

`creator.bio` and `creator.voice_notes` appear only when the pack has them. `description`, the two times and `hook` are `null` when absent. `main_ingredients` is up to six ingredient names with water, salt, pepper and plain oils left out; `hook` is the first sentence of the recipe's story or first creator note.

**One recipe**, with both `pack` and `recipe`:

```sh
curl -sS "http://localhost:3000/api/packs?pack=fannie-farmer-1896&recipe=waffles" \
  -H "Authorization: Bearer $TOKEN"
```

```json
{
  "pack": { "id": "…", "title": "…", "creator": { "…": "…" } },
  "recipe": { "…": "the full recipe, as design/pack-format-v0.md defines it" },
  "library": { "…": "the technique and state entries the recipe's steps refer to" },
  "projection": { "…": "the recipeData the app would queue for it, or null" }
}
```

`projection` is the same recipe in the `recipeData` shape, for a sender that wants to change it and send it as Shape 2, keeping its `source` (see "A `source` that names a pack"). To queue the recipe unchanged, use Shape 1.

Errors: `404 {"error":"Pack or recipe not found"}` when only one of the two parameters is given or either id is unknown; `500 {"error":"…"}` when the pack files can't be loaded; and the Auth answers (`401`, `500`). A read: it changes nothing.
