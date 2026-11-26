# Sous

Sous is a cooking assistant that lets you be present and creative in the kitchen. It runs as a web app on a kitchen tablet: you queue a recipe, prop the tablet on the counter, and it takes you through the cook one screen at a time, showing what to get out, what to do now, and what is on a timer.

![The kitchen home screen](docs/screenshots/home.png)

![A recipe in cook mode](docs/screenshots/cook.png)

## Status

This is a snapshot of the app I cook from, shared as-is and updated now and then, not kept in step with my own copy. Issues and forks are welcome, but I can't promise support.

## What works

With nothing but a database and `SOUS_SIGN_IN=off`, you get the queue and cook mode with timers and voice (spoken steps and voice commands, in a browser that supports speech). The app installs to a tablet's home screen as a PWA.

A spoken command gets a soft sound back, and, if the cook picks "Sounds and voice" in the cook page's More menu, now and then a short recorded reply such as "Yes, chef." Those 17 clips ship in `app/public/sounds/sue/`. They were made with Google's speech model by `app/scripts/generate-sue-clips.ts`, which can make them again. See [docs/voice-replies.md](docs/voice-replies.md).

One pack is bundled. A pack is a set of recipes in the app's own format, and this one is five recipes from the public-domain 1896 *Boston Cooking-School Cook Book*. Each comes with a stored cook plan: the recipe broken into the tasks cook mode schedules, such as what to prep first and what can wait on a timer.

Three things need a model key: importing a recipe from pasted text, a photo or a URL; Ask, the assistant you can question mid-cook; and working out a cook plan for a recipe that doesn't ship with one. A web page that carries its recipe as structured data imports without a key. Gemini is the default (`GOOGLE_AI_API_KEY`). Anthropic is optional. See [docs/environment.md](docs/environment.md).

## Run it

You need Node 24, pnpm 10 and PostgreSQL.

```sh
pnpm --dir app install --frozen-lockfile

createdb sous
export DATABASE_URL=postgres://localhost:5432/sous
export SOUS_SIGN_IN=off

pnpm --dir app db:migrate  # creates the tables and the default "home" kitchen
pnpm --dir app build
pnpm --dir app start       # http://localhost:3000
```

Setting `SOUS_SIGN_IN=off` selects single-kitchen mode (one household, no sign-in). `pnpm --dir app dev` runs the development server instead of the last two lines, with the same variables exported.

What you see if you skip a step: starting the server (including `pnpm --dir app dev`) with `SOUS_SIGN_IN` unset, empty, or `on` and the sign-in variables missing prints a line naming the missing variables and exits with status 1 (setting `SOUS_SIGN_IN` to any other value besides `off` prints a line rejecting that value and exits with status 1; Next.js may print `Ready` just before that line). With `SOUS_SIGN_IN=off` and `DATABASE_URL` unset, the server stays up, pages load, and every request fails with a 500 whose message names `DATABASE_URL` (on webhook endpoints, the response body is empty and the message is in the server log). With `SOUS_SIGN_IN=off` and a database that has no tables, the server stays up and every request fails with a 500 that begins `Failed query: select "id", "slug" from "kitchens"` (again in the server log for webhooks); run `pnpm --dir app db:migrate` to create the tables.

To let an external agent or script send recipes over the webhook, create a bearer token for the `home` kitchen with `DATABASE_URL` and `SOUS_SIGN_IN=off` set:

```sh
pnpm --dir app kitchens token create --kitchen home --label agent
```

The token is printed once; pass it in `Authorization: Bearer <token>`. See [docs/webhook.md](docs/webhook.md).

### Sign-in mode

In sign-in mode, each household is its own kitchen, only invited Google accounts get in, and each kitchen sees only its own data. Sign-in with a real Google account, including from the app installed to a tablet's home screen, has not been exercised yet, so treat it as untested.

Create a Google OAuth client of the "Web application" type in the Google Cloud console. Set its authorized JavaScript origin to the origin of `BETTER_AUTH_URL` (for example `https://sous.example.com`) and its authorized redirect URI to `BETTER_AUTH_URL` followed by `/api/auth/callback/google` (for example `https://sous.example.com/api/auth/callback/google`). Configure the consent screen to ask for the `openid`, `email` and `profile` scopes only.

Leave `SOUS_SIGN_IN` unset (or set it to `on`), keep every hook unconnected, and export `DATABASE_URL`, a model key as for single-kitchen mode, and the six required sign-in variables: `BETTER_AUTH_SECRET`, `BETTER_AUTH_URL`, `GOOGLE_CLIENT_ID`, `GOOGLE_CLIENT_SECRET`, `SOUS_AI_KITCHEN_CAP_USD` and `SOUS_AI_TOTAL_CAP_USD` (see [docs/environment.md](docs/environment.md) for what each must hold):

```sh
export SOUS_SIGN_IN=on
export DATABASE_URL=postgres://localhost:5432/sous
export BETTER_AUTH_SECRET="$(openssl rand -base64 32)"
export BETTER_AUTH_URL=https://sous.example.com
export GOOGLE_CLIENT_ID=example-client-id.apps.googleusercontent.com
export GOOGLE_CLIENT_SECRET=example-client-secret
export SOUS_AI_KITCHEN_CAP_USD=2
export SOUS_AI_TOTAL_CAP_USD=20
export GOOGLE_AI_API_KEY=example-model-key
```

Generate `BETTER_AUTH_SECRET` once and keep it somewhere safe: a different secret on the next start signs everyone out. Then run the same `db:migrate`, `build` and `start` commands as in the single-kitchen setup above.

Inviting is done only from the command line. With `DATABASE_URL` set and `SOUS_SIGN_IN` not set to `off` (single-kitchen mode refuses invites because it has no members or invites), invite the first person:

```sh
pnpm --dir app kitchens invite --email cook@example.com --new-kitchen "River House"
```

The invite is accepted on that person's first request after signing in; a `--new-kitchen` invite creates the kitchen then, with that person as its owner. Run `pnpm --dir app kitchens list` to see kitchens, members and pending invites.

On the tablet, the invited person opens `/sign-in`, signs in with that Google account, and lands on `/kitchen`. A Google account without an invite lands on `/not-invited`, which says it is not on the invite list. A session lasts 90 days and is extended by another 90 days when used again after at least 1 day has passed since its last update.

To sign out, open the home screen's right-edge icon rail menu by tapping the pull-out handle ("More") at the bottom of the rail (or long-pressing the rail, or dragging left from it), and tap `Sign out` at the bottom. If any cook reports are still waiting to be sent, the item changes to say how many have not been sent yet and needs a second tap to sign out and remove them.

Signing in and signing out each forget everything Sous stored in that browser on that device (unsent cook reports, the saved place in a cook, timers, and the prep-mode and voice settings), and other open Sous tabs reload when it happens.

Run the app with `pnpm --dir app start` and no shared cache in front of it. The kitchen pages are prerendered and answer with a long shared cache lifetime (`s-maxage`), while the sign-in redirect (and the cookie that shows `Sign out`) is handled per request by `app/src/proxy.ts`. A cache in front of the app that keys only on the address would answer without running that check: a signed-out person could be shown the empty kitchen page, which holds no kitchen data (the server still refuses every read), until the first refused read sends them to `/sign-in`, and `Sign out` may be missing on that load. Do not put such a cache in front of the kitchen pages.

### Upgrading an older database

Migrations take exclusive locks on the tables they change and set no lock timeout: stop the app, run `pnpm --dir app db:migrate`, and start the app again. If your database was created with `db:push` before migrations existed, stop the app, run `pnpm --dir app db:baseline` once, and then run `pnpm --dir app db:migrate`. Running `pnpm --dir app db:migrate` on a baselined database prints two PostgreSQL notices (`schema "drizzle" already exists`, `relation "__drizzle_migrations" already exists`) before reporting success; these are expected. Do not run `pnpm --dir app db:push` on a database you want to keep: on a database created before migrations existed, `db:push` stops and offers to empty tables it cannot alter, so use `pnpm --dir app db:baseline` once and then `pnpm --dir app db:migrate`. After that upgrade, any recipes an agent previously sent under other cook names appear in the one `home` kitchen. The old shared webhook token variable (`KITCHEN_QUEUE_API_TOKEN`) is no longer read, so create a per-kitchen token with `pnpm --dir app kitchens token create` instead. For upgrading webhook agents, see [docs/webhook.md](docs/webhook.md) for the other breaking changes: the `targetUser` field is refused, and a bearer token is required in development too.

## Hooks

My own copy reads and writes my household's data in a few places. In this public copy, each of those is a hook: an interface with no implementation behind it, and the app hides the feature until you connect one. Hooks are instance-wide and work only in single-kitchen mode (`SOUS_SIGN_IN=off`); sign-in mode refuses to start with any hook connected.

- [recipe-library](docs/hooks/recipe-library.md): your own recipes, as a book on the shelf.
- [cook-log](docs/hooks/cook-log.md): a row for every finished cook, with a rating and a note.
- [pantry](docs/hooks/pantry.md): what food is in the house.
- [shopping-list](docs/hooks/shopping-list.md): one shared list of things to buy.
- [ideas](docs/hooks/ideas.md): recipes saved for later.
- [household-context](docs/hooks/household-context.md): a few lines about who is eating, for Ask.

Each spec is written so that a coding agent can implement the hook from it.

## The agent webhook

Another program can send a recipe to a kitchen with one HTTP call, which is how the kitchen agent I text recipes to queues dinner. Every call requires a per-kitchen bearer token (created on the Settings screen by a kitchen owner in sign-in mode, or with `pnpm --dir app kitchens token create` in single-kitchen mode). For an owner guide, the `send-recipe.mjs` script, and the assistant skill, see [docs/send-recipes.md](docs/send-recipes.md). The full HTTP contract is in [docs/webhook.md](docs/webhook.md).

## Safety

- **Single-kitchen mode (`SOUS_SIGN_IN=off`).** There is no login. `pnpm --dir app start` and `pnpm --dir app dev` listen on every network interface by default, so anyone on the same network can open the app, read and change everything in it, and spend your model key; add `-H 127.0.0.1` (for example `pnpm --dir app start -H 127.0.0.1`) to keep it to this machine, or run it on a private network or behind your own authentication. Anyone who can reach the server can spend your model key (import, Ask, cook plans, grocery parsing, library refresh), up to a monthly cap if you set one (`SOUS_AI_KITCHEN_CAP_USD`, `SOUS_AI_TOTAL_CAP_USD`, or `pnpm --dir app kitchens cap set`; see [docs/environment.md](docs/environment.md); caps are optional and off unless set), and can write to the database without limit, except cook reports (each with a copy of the screen's HTML), which stop at 100 per rolling 24 hours per kitchen. The tRPC procedures need no token in this mode; the webhook endpoints require a kitchen token in every build.
- **Sign-in mode.** Sign-in mode (sign-in with a real Google account has not been exercised yet) is built so that only invited Google accounts get in, each kitchen sees only its own queue, recipes, Ask history and reports, model spend is capped per kitchen and overall each UTC month (both cap variables are required in sign-in mode), and webhook calls require a kitchen's own token in every build.
- **Both modes.** Whoever operates the database can read every kitchen's data, including Ask messages and cook report contents. Row-level security is enabled on every table with no policies, so only the role that owns the tables (the one in `DATABASE_URL`), and roles that bypass row-level security such as a superuser, can read or write them; if your PostgreSQL host also exposes the database through its own API roles (such as Supabase's `anon` and `authenticated` roles), those roles can read nothing, but default grants may still leave them with the `TRUNCATE` privilege, which row-level security does not govern: revoke it. URL import fetches any address, follows redirects, has no size cap, and returns a recipe parsed from what it read. On desktop, cook mode listens continuously for its wake word, and Chrome sends that audio to Google. Ask sends the recipe and any connected context to your model provider.

## Layout

- `app/`: the web app (Next.js, tRPC, Drizzle, Postgres).
- `pack/`: the pack format as code, which the app checks every pack against.
- `packs/`: the bundled pack, and the two JSON libraries of techniques and doneness cues its steps refer to.
- `design/pack-format-v0.md`: the pack format's specification.

Code comments carry short internal reference codes that point at my private notes. They are harmless and can be ignored.

MIT licensed; see [LICENSE](LICENSE). The bundled fonts (Caprasimo and Figtree) are licensed under the SIL Open Font License 1.1; see [app/public/fonts/](app/public/fonts/).
