# AGENTS.md

Notes for a coding agent working in this repository. `README.md` says what the app is; this file says how to work in it.

## Layout

- `app/`: the web app. Next.js (app router), tRPC, Drizzle on Postgres, Vitest. Pages are under `app/src/app/`, components under `app/src/components/`, React hooks under `app/src/hooks/`, server procedures in `app/src/server/routers/_app.ts`, everything else in `app/src/lib/`. The schema is `app/drizzle/schema.ts`.
- `pack/`: `@sous/pack`, the recipe pack format as a Zod schema with parsers and reference checks. It exports TypeScript source and has no build step.
- `packs/`: the bundled pack (`packs/drafts/`) and the two libraries its steps refer to (`commons.json`, `states.json`).
- `design/pack-format-v0.md`: the pack format's specification.
- `app/pack-plans/`: the stored cook plan for each recipe of each bundled pack.
- `docs/`: the hook specs (`docs/hooks/`), the webhook contract (`docs/webhook.md`) and the environment reference (`docs/environment.md`).

## Install

```sh
pnpm --dir app install --frozen-lockfile
```

That one command installs both `app/` and `pack/`: `pack/` is a member of the app's pnpm workspace (`app/pnpm-workspace.yaml`). **Never run an install inside `pack/`.** It would write a second lockfile and a `node_modules` that disagrees with the app's.

Use Node 24 and pnpm 10.

## Gates

Run all of these from the repository root before calling a change done. They need no database, no keys and no environment variables.

```sh
pnpm --dir app lint
pnpm --dir app exec tsc --noEmit -p .
pnpm --dir app run typecheck:scripts
pnpm --dir app test:run
pnpm --dir app build

pnpm --dir pack lint
pnpm --dir pack typecheck
pnpm --dir pack test
```

CI (`.github/workflows/ci.yml`) runs the same commands, plus a secret scan.

The test suite is large. To run part of it, pass a path: `pnpm --dir app test:run src/lib/kitchen`.

## Things to leave alone unless asked

- **The pack format.** `pack/` implements `design/pack-format-v0.md`, a versioned specification that pack files are written against. Don't change the schema to make a pack or a test pass. A change to one is a change to the other, made together and on purpose.
- **The cook-plan prompt.** The cook-plan system prompt, its response schema and its thinking budget (`app/src/lib/kitchen/cook-plan-derive.ts`) feed a stamp (`app/src/lib/kitchen/cook-plan-stamp.ts`). Editing the prompt, even its whitespace, makes every stored cook plan in `app/pack-plans/` stale, and regenerating them is a paid model run. `cook-plan-golden.test.ts` fails when that happens.
- **Reference codes in comments.** Comments carry short codes ("B4", "S-D9", "DS §6") that point at notes outside this repository. They are harmless; don't try to resolve them.

## The database

There are no migrations. The schema in `app/drizzle/schema.ts` is pushed onto a database:

```sh
export DATABASE_URL=postgres://localhost:5432/sous
pnpm --dir app db:push
```

Pushing onto an empty database is the supported setup. After changing the schema, push again; `drizzle-kit push` asks before a change that would lose data. Tests don't use `DATABASE_URL`: the ones that need Postgres run an in-process one.

## Hooks

The app reaches outside itself for a household's own data in six places, each an interface in `app/src/lib/hooks/types.ts`: `recipe-library`, `cook-log`, `pantry`, `shopping-list`, `ideas`, `household-context`. All six ship unconnected, and every screen has a drawn state for that.

To connect one:

1. Read its spec, `docs/hooks/<name>.md`. It gives the interface, what each method must do, where the app calls it, and a checklist to run by hand.
2. Write an object that satisfies the interface, and put it in the hook's slot of `implementations` in `app/src/lib/hooks/registry.ts` (every slot ships as `null`). The registry is server-only.
3. Set the hook's flag to `true` in `connected` in `app/src/lib/hooks/connected.ts` (every flag ships as `false`). This file is imported by both client and server, so keep it to plain booleans.

A hook flagged connected with no implementation throws on first use (`hook()` in `registry.ts`) and names its spec. Don't add a fallback that answers empty for a failed read: a call that can't reach its store rejects, and the caller decides what that means on its screen.

## Safety

- **There is no auth.** Every page and every tRPC procedure is open, and the three webhook endpoints are guarded only by a bearer token, checked only in a production build (`docs/webhook.md`). Nothing here should be deployed to a public host unchanged. If asked to deploy it, put authentication in front of it first, or say that it is missing.
- **URL import fetches server-side.** `importRecipeFromUrl` fetches whatever URL it is given from the server (`extractRecipeFromUrl` in `app/src/lib/recipe-import.ts`). On a host that can reach private addresses, that is a request-forgery risk.
- **Model calls cost money and send data out.** Import, Ask, cook plans, grocery parsing and the household-book Refresh call the configured provider (`docs/environment.md`). Don't add a model call to a path that runs on page load or in a loop.
- **Secrets.** Keys live in the environment, never in the repository. `.env*` is ignored by git.
