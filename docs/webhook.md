# The agent webhook

Three HTTP endpoints let a program outside the app (an assistant, a script, a cron job) send recipes to the kitchen, finish cooks left open overnight, and read the packs on the shelf.

| Endpoint | What it does | Code |
| --- | --- | --- |
| `POST /api/kitchen-queue` | Puts a recipe in the cook's queue | `app/src/app/api/kitchen-queue/route.ts` |
| `POST /api/kitchen-queue/sweep` | Finishes cooks left idle on their last screen | `app/src/app/api/kitchen-queue/sweep/route.ts` |
| `GET /api/packs` | Lists the packs, or returns one recipe in full | `app/src/app/api/packs/route.ts` |

The examples assume the app at `http://localhost:3000` and the token in `$TOKEN`.

## Auth

All three share one check (`webhookAuthRefusal` in `app/src/lib/webhook-auth.ts`). It depends on `NODE_ENV`:

| Server | `KITCHEN_QUEUE_API_TOKEN` | Request | Answer |
| --- | --- | --- | --- |
| Production (`next start`) | not set | any | `500 {"error":"Server configuration error"}` |
| Production | set | no `Authorization: Bearer <token>` header, or the wrong token | `401 {"error":"Unauthorized"}` |
| Production | set | the right token | the call runs |
| Development (`next dev`) and tests | either | any | the call runs; the header is not read |

So a production server with no token refuses every webhook call, and a development server accepts every one.

This token is not a security boundary: it guards only these three endpoints, while the app's own pages and open tRPC procedures can queue recipes, finish cooks, and read packs with no login at all (see Safety in the README).

## `POST /api/kitchen-queue`

Queues one recipe for one cook. The body is JSON and takes one of two shapes.

### Who it is for

`targetUser` is optional in both shapes. It is a slug: lowercase letters and digits, with single hyphens between them, at most 40 characters. Left out, the recipe goes to the default cook, `cook`, which is the only cook the app's own screens show. A recipe sent to any other slug is stored but appears on no screen.

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
  "targetUser": "cook",
  "source": "pack:fannie-farmer-1896/waffles",
  "mode": "native"
}
```

The recipe is queued with the cook plan stored for it in `app/pack-plans/`, so this shape needs no model key.

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

Only `name` is required. Every field:

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

Unknown fields are dropped.

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

**Model calls.** A supplied recipe uses the configured model (see `docs/environment.md`) at up to three points:

1. Before it is queued, only when `serves` is left out: one call to estimate a serving count. If that fails (no key, the provider down), nothing is queued and the answer is `503`.
2. After the response, for a recipe that is not a pack recipe: an intake pass that cuts the recipe to the app's own shape (one step per stretch of work, one ingredient per line). If it fails, it is tried again when the cook opens the recipe; if it still fails, the cook gets the recipe as sent.
3. After the response: the cook plan. If it fails, the cook view runs the recipe as written.

So with no model key, a supplied recipe that states `serves` still queues and cooks, as written.

`recipeNotionId` (a string) is also accepted in place of `recipeData`. It is left from an older integration: the row it queues has no recipe to cook from. Don't use it.

### Errors

| Status | Body | When |
| --- | --- | --- |
| 400 | `{"error":"Invalid JSON body"}` | The body isn't JSON. |
| 400 | `{"error":"Validation error","details":{…}}` | The body fits neither shape, a field has the wrong type, or `targetUser` isn't a slug. |
| 401, 500 | see Auth | |
| 404 | `{"error":"Pack or recipe not found"}` | Shape 1 names a pack or recipe that isn't on the shelf, or the shorthand isn't `<packId>/<recipeId>`. |
| 422 | `{"error":"Recipe can't be read as a pack recipe", …}` | The cook page couldn't read this recipe (for example an ingredient line it can't parse). `issues` (Shape 2) or `differences` (Shape 1) says why, or the reason follows a colon in `error` itself. Nothing is queued. |
| 503 | `{"error":"Couldn't work out how many this serves, so nothing was queued","reason":"…"}` | Shape 2 without `serves`, and the estimate call failed. |
| 500 | `{"error":"Failed to queue recipe","details":"…"}` | The database refused the insert. |

### Idempotency

None. Every accepted call inserts a new queue row, so a retry after a lost response queues the recipe a second time. These endpoints give a sender no way to check whether an earlier call landed, so retry only on an answer that says nothing was queued (a 4xx, the 503). The cook can remove a duplicate from the queue.

## `POST /api/kitchen-queue/sweep`

A tablet asleep on a recipe's last screen never tells the server the cook is done. The sweep finishes those cooks: each cook that has sat on its last screen for 45 minutes past its last activity, with no timer still running, is marked completed, dated to that last activity. It is meant for a nightly job.

Body: `{}` for the default cook, or `{ "targetUser": "<slug>" }`. Any other field is refused.

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

Errors: `400 {"error":"Invalid JSON body"}`, `400 {"error":"Invalid sweep","details":[…]}`, and the Auth answers.

Idempotent: a cook it finished is no longer cooking, so a second call finds nothing to do.

## `GET /api/packs`

Reads the packs registered on the shelf (`app/src/lib/shelf/registry.ts`), so a sender can choose a recipe by id.

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

Errors: `404 {"error":"Pack or recipe not found"}` when only one of the two parameters is given or either id is unknown; `500 {"error":"…"}` when the pack files can't be loaded; and the Auth answers. A read: it changes nothing.
