# Sous

Sous is a cooking assistant that lets you be present and creative in the kitchen. It runs as a web app on a kitchen tablet: you queue a recipe, prop the tablet on the counter, and it takes you through the cook one screen at a time, showing what to get out, what to do now, and what is on a timer.

![The kitchen home screen](docs/screenshots/home.png)

![A recipe in cook mode](docs/screenshots/cook.png)

## Status

This is a snapshot of the app I cook from, shared as-is and updated now and then, not kept in step with my own copy. Issues and forks are welcome, but I can't promise support.

## What works

With nothing but a database, you get the queue and cook mode with timers and voice (spoken steps and voice commands, in a browser that supports speech). The app installs to a tablet's home screen as a PWA.

One pack is bundled. A pack is a set of recipes in the app's own format, and this one is five recipes from the public-domain 1896 *Boston Cooking-School Cook Book*. Each comes with a stored cook plan: the recipe broken into the tasks cook mode schedules, such as what to prep first and what can wait on a timer.

Three things need a model key: importing a recipe from pasted text, a photo or a URL; Ask, the assistant you can question mid-cook; and working out a cook plan for a recipe that doesn't ship with one. A web page that carries its recipe as structured data imports without a key. Gemini is the default (`GOOGLE_AI_API_KEY`). Anthropic is optional. See [docs/environment.md](docs/environment.md).

## Run it

You need Node 24, pnpm 10 and PostgreSQL.

```sh
pnpm --dir app install --frozen-lockfile

createdb sous
export DATABASE_URL=postgres://localhost:5432/sous

pnpm --dir app db:push     # creates the tables
pnpm --dir app build
pnpm --dir app start       # http://localhost:3000
```

There are no migrations. Pushing the schema onto an empty database is the supported setup. `pnpm --dir app dev` runs the development server instead of the last two lines.

## Hooks

My own copy reads and writes my household's data in a few places. In this public copy, each of those is a hook: an interface with no implementation behind it, and the app hides the feature until you connect one.

- [recipe-library](docs/hooks/recipe-library.md): your own recipes, as a book on the shelf.
- [cook-log](docs/hooks/cook-log.md): a row for every finished cook, with a rating and a note.
- [pantry](docs/hooks/pantry.md): what food is in the house.
- [shopping-list](docs/hooks/shopping-list.md): one shared list of things to buy.
- [ideas](docs/hooks/ideas.md): recipes saved for later.
- [household-context](docs/hooks/household-context.md): a few lines about who is eating, for Ask.

Each spec is written so that a coding agent can implement the hook from it.

## The agent webhook

Another program can send a recipe to the tablet with one HTTP call, which is how the kitchen agent I text recipes to queues dinner. The contract is in [docs/webhook.md](docs/webhook.md).

## Safety

There is no login. Run it on a private network or behind your own auth. Anyone who can reach the server can spend your model key (import, Ask, cook plans, grocery parsing, library Refresh) and write to the database without limit, except cook reports (each with a copy of the screen's HTML), which stop at 100 a day for everyone. The webhook's bearer token is not a security boundary: open tRPC procedures do the same jobs without it. URL import fetches any address, follows redirects, has no size cap, and returns a recipe parsed from what it read. On desktop, cook mode listens continuously for its wake word, and Chrome sends that audio to Google. Ask sends the recipe and connected context to your model provider.

## Layout

- `app/`: the web app (Next.js, tRPC, Drizzle, Postgres).
- `pack/`: the pack format as code, which the app checks every pack against.
- `packs/`: the bundled pack, and the two JSON libraries of techniques and doneness cues its steps refer to.
- `design/pack-format-v0.md`: the pack format's specification.

Code comments carry short internal reference codes that point at my private notes. They are harmless and can be ignored.

MIT licensed; see [LICENSE](LICENSE). The bundled fonts (Caprasimo and Figtree) are licensed under the SIL Open Font License 1.1; see [app/public/fonts/](app/public/fonts/).
