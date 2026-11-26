# Sending recipes to your kitchen

As a kitchen owner, you can let an assistant, a script, or another program send recipes straight to your Sous queue.

## 1. Make a sending token

### In sign-in mode

1. Open Sous on your tablet or browser and sign in as a kitchen **owner** (cooks cannot see or manage tokens).
2. Open the right-edge menu ("More") and tap **Settings**.
3. Scroll to **Sending tokens**, enter a short label (for example, `Kitchen assistant`), and tap **Make token**.
4. Copy the token right away. For safety, Sous stores only a one-way digest and will never show the plaintext token again.

A kitchen can have up to **10 live tokens** at a time. The Settings screen lists each live token's label, when it was made, and when it was last used. If a device is retired or a token may have leaked, tap **Revoke** next to it to turn it off right away.

### In single-kitchen mode (`SOUS_SIGN_IN=off`)

Single-kitchen mode has no sign-in or owner screens, so create and revoke tokens from the server command line instead:

```sh
export DATABASE_URL=postgres://localhost:5432/sous
export SOUS_SIGN_IN=off
pnpm --dir app kitchens token create --kitchen home --label agent
```

## 2. Configure `SOUS_URL` and `SOUS_TOKEN`

Set these two environment variables wherever your script or assistant runs:

```sh
export SOUS_URL=https://sous.example.com
export SOUS_TOKEN=sous_your_token_here
```

- `SOUS_URL` must use `https://`. Plain `http://` is refused everywhere except `localhost`, `127.0.0.1`, and `[::1]`.
- Keep `SOUS_TOKEN` only in environment variables or a private secret store. Never pass it as a command-line argument, never print it, and never commit it to git.

## 3. Send a recipe from the command line

`skills/sous-kitchen/send-recipe.mjs` runs with Node.js and needs no installed packages.

Test a recipe file without queueing it (`--dry-run`):

```sh
node skills/sous-kitchen/send-recipe.mjs --dry-run recipe.json
```

Send a recipe from a file:

```sh
node skills/sous-kitchen/send-recipe.mjs recipe.json
```

Or send JSON on stdin:

```sh
node skills/sous-kitchen/send-recipe.mjs <<'EOF'
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
    ]
  }
}
EOF
```

To queue an unchanged recipe from a pack on the shelf, send:

```json
{ "pack": "fannie-farmer-1896/waffles" }
```

Run `node skills/sous-kitchen/send-recipe.mjs --help` for all options.

## 4. Use the assistant skill

If you use an AI assistant that supports skills, point it to [skills/sous-kitchen/SKILL.md](../skills/sous-kitchen/SKILL.md) and give it `SOUS_URL` and `SOUS_TOKEN` in its environment. The skill tells the assistant how to format recipes without inventing missing amounts or steps, when to ask you for missing fields, and how to run `send-recipe.mjs`.

## Common errors

| Output | Meaning | What to do |
| --- | --- | --- |
| `Plain http:// is refused except for localhost...` | `SOUS_URL` uses `http://` for a remote host. | Change `SOUS_URL` to `https://...`. |
| `Do not pass a token as an argument` | A token or `--token` flag was passed on the command line. | Remove the flag and export `SOUS_TOKEN` instead. |
| `Unauthorized (401)` | Token is missing, wrong, or revoked. | Make a fresh token on Settings and update `SOUS_TOKEN`. |
| `Unreadable recipe (422)` | Missing `name`, or neither ingredients nor steps, or an unreadable field. | Check the recipe JSON with `--dry-run` and fix the named field. |
| `Service unavailable (503)` | `serves` was left out and the server has no model key configured. | Add `"serves": <number>` to `recipeData` and send again. |
| `Monthly AI allowance used (429)` | `serves` was left out and the monthly AI allowance is spent. | Add `"serves": <number>` to `recipeData` (or wait for the monthly reset). |

For the full HTTP endpoint reference, see [docs/webhook.md](webhook.md).
