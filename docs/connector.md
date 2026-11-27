# Connecting a chat assistant (MCP)

Sous exposes a stateless MCP endpoint over HTTP at `/api/mcp`. Any chat assistant or MCP client that can connect to a remote HTTP MCP server and send an `Authorization: Bearer <token>` header can read your kitchen's shelf, cook log, and household note, and queue recipes for your tablet.

**Connecting by signing in is not built.** There is no OAuth flow or browser login screen for chat clients. Clients connect with a per-kitchen bearer token instead.

## Getting a token

Every token belongs to one kitchen and is shown once when created.

1. **In the app (sign-in mode):** an owner opens **Settings** (`/kitchen/settings`), enters a label under **Sending tokens**, and selects **Make token**. Copy the token immediately.
2. **From the server CLI:**

```sh
pnpm --dir app kitchens token create --kitchen home --label "Chat assistant"
```

In single-kitchen mode (`SOUS_SIGN_IN=off`), export `SOUS_SIGN_IN=off` before running the CLI command because the `home` kitchen has no members.

You can revoke a token at any time from **Settings** or with `pnpm --dir app kitchens token revoke --id <token-uuid>`.

## Client configuration

Point your MCP client at:

- **URL:** `https://sous.example.com/api/mcp`
- **Transport:** HTTP (`POST` with JSON-RPC 2.0)
- **Header:** `Authorization: Bearer sous_example_token_replace_me`

Example JSON configuration for clients that take a server URL and headers:

```json
{
  "mcpServers": {
    "sous-kitchen": {
      "url": "https://sous.example.com/api/mcp",
      "headers": {
        "Authorization": "Bearer sous_example_token_replace_me"
      }
    }
  }
}
```

## Available tools

| Tool | What it does | Arguments |
| --- | --- | --- |
| `list_shelf` | Lists the recipe packs and recipe summaries visible to the token's kitchen (registered shelf packs plus packs owned by or shared with the kitchen). | None |
| `get_kitchen_context` | Returns the kitchen's name and its "About my kitchen" household note from Settings. | None |
| `read_cook_log` | Returns the kitchen's recent cook log entries, newest first. | `limit` (optional integer, 1 to 100, default 20) |
| `queue_recipe` | Queues a recipe into the token's kitchen using the same validation as `POST /api/kitchen-queue`. | Either `{ "packId", "recipeId" }` (or `{ "pack": "<packId>/<recipeId>" }`) or `{ "recipeData": { "name", ... } }` |
| `get_pack_authoring_guide` | Returns the Pack Format v0.7 specification, allowed `commons:`/`state:` reference ids, reserved pack ids, and owned collection count. | None |
| `save_pack` | Creates or updates an owned recipe collection on the kitchen's shelf (validates schema, refs, and cook-mode compatibility). | `{ "pack": { "id", "title", "version", "creator", "recipes": [...] } }` |

Notes on `queue_recipe`:

- The bearer token always determines the kitchen. Any `targetUser` field is refused, and any extra kitchen field is ignored.
- Supplied recipes (`recipeData`) need `name` and at least one ingredient or step. Leaving out `serves` runs a serving estimate metered against the kitchen's monthly AI allowance.

## Protocol, errors, and rate limits

- **Supported JSON-RPC methods:** `initialize`, `tools/list`, `tools/call`, and notifications such as `notifications/initialized` (which return HTTP `202` with an empty body).
- **HTTP methods:** `POST` handles JSON-RPC requests. `GET` and `DELETE` return `405 Method not allowed` after checking auth and rate limits.
- **Auth:** missing, unknown, or revoked bearer tokens return HTTP `401 {"error":"Unauthorized"}`.
- **Rate limit:** `/api/mcp` shares a per-kitchen sliding-window limit with `/api/kitchen-queue`, `/api/kitchen-queue/sweep`, and `/api/packs` (default 120 requests per minute, configurable via `SOUS_WEBHOOK_RATE_LIMIT_PER_MIN`). Requests past the limit return HTTP `429 {"error":"rate_limit_exceeded", ...}` with a `Retry-After` header.
