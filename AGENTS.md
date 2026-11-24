# AGENTS.md

Notes for a coding agent working in this repository. `README.md` says what the app is; this file says how to work in it.

## Layout

- `app/`: the web app. Next.js (app router), tRPC, Drizzle on Postgres, Vitest. Pages are under `app/src/app/`, components under `app/src/components/`, React hooks under `app/src/hooks/`, server procedures in `app/src/server/routers/_app.ts`, everything else in `app/src/lib/`. The schema is `app/drizzle/schema.ts` (which re-exports the sign-in tables from `app/drizzle/auth-schema.ts`), SQL migrations live in `app/drizzle/migrations/`, and the operator CLI is `app/scripts/kitchens.ts`.
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

One test file, `app/src/lib/kitchens/races.pg.test.ts`, runs only against a real PostgreSQL database (covering parallel-connection races that the in-memory PGlite database cannot show: concurrent first sign-ins on one invite, invite acceptance racing `uninvite`, and concurrent model calls hitting a monthly spend cap). It is skipped in the default `pnpm --dir app test:run`. Run it before any release that touches invites or spend caps, pointing `SOUS_TEST_POSTGRES_URL` at a disposable, migrated database whose name contains `"test"` (the test deletes rows before every case and refuses to run otherwise). Create and migrate it first, for example `createdb sous_test`, then `DATABASE_URL=postgres://localhost:5432/sous_test pnpm --dir app db:migrate`:

```sh
SOUS_TEST_POSTGRES_URL=postgres://localhost:5432/sous_test \
  pnpm --dir app test:run src/lib/kitchens/races.pg.test.ts
```

Put any further test that needs a real PostgreSQL database into `app/src/lib/kitchens/races.pg.test.ts`: Vitest runs separate test files concurrently, so two files sharing a test database would delete each other's rows mid-test.

The Playwright browser test suite needs Docker and a Chromium browser, so it is not part of the gates above; see `docs/browser-tests.md` for prerequisites and how to run it.

## Deploying

A commit goes live only through `scripts/deploy.sh`, after `scripts/release-check.sh` has recorded a pass for it. See `docs/deploy.md` for the release, migration, and rollback steps.

## Things to leave alone unless asked

- **The pack format.** `pack/` implements `design/pack-format-v0.md`, a versioned specification that pack files are written against. Don't change the schema to make a pack or a test pass. A change to one is a change to the other, made together and on purpose.
- **The cook-plan prompt.** The cook-plan system prompt, its response schema and its thinking budget (`app/src/lib/kitchen/cook-plan-derive.ts`) feed a stamp (`app/src/lib/kitchen/cook-plan-stamp.ts`). Editing the prompt, even its whitespace, makes every stored cook plan in `app/pack-plans/` stale, and regenerating them is a paid model run. `cook-plan-golden.test.ts` fails when that happens.
- **Reference codes in comments.** Comments carry short codes ("B4", "S-D9", "DS §6") that point at notes outside this repository. They are harmless; don't try to resolve them.

## The database

The schema in `app/drizzle/schema.ts` (including `app/drizzle/auth-schema.ts`) is managed with SQL migrations in `app/drizzle/migrations/`.

```sh
export DATABASE_URL=postgres://localhost:5432/sous
pnpm --dir app db:migrate
```

Migrations take exclusive locks on the tables they change and set no lock timeout: stop the app, run `pnpm --dir app db:migrate`, and start the app again. To upgrade an older database created with `db:push`, run `pnpm --dir app db:baseline` once, then `pnpm --dir app db:migrate`.

When changing the schema:

- Generate a migration with `pnpm --dir app db:generate --name <name>`.
- Never hand-apply DDL or edit generated DDL (editing DDL makes `app/drizzle/migrations/meta/` snapshots disagree with the SQL). Hand-edit a generated migration only to add data statements (`INSERT`, `UPDATE`, `DELETE`) separated by `--> statement-breakpoint`.
- Enable row-level security (`.enableRLS()`) with no policies on every new table so only the role that owns the tables (the one in `DATABASE_URL`), and roles that bypass row-level security such as a superuser, can read or write them. (On hosts that expose API roles such as Supabase's `anon` and `authenticated`, also revoke `TRUNCATE`.)
- Keep `pnpm --dir app db:push` only for throwaway local tests; a pushed database does not run data statements such as creating the `home` kitchen, so single-kitchen mode refuses it.

Default tests do not use `DATABASE_URL`: database tests run in-process on PGlite with all migrations applied via `migratedTestDb()` in `app/src/lib/__tests__/test-db.ts`.

The operator script `pnpm --dir app kitchens` (`app/scripts/kitchens.ts`, logic in `app/src/lib/kitchens/admin.ts`) manages kitchens, invites, members, webhook tokens, monthly AI spend reports and per-kitchen AI caps. Run `pnpm --dir app kitchens --help` to see all subcommands.

## Hooks

The app reaches outside itself for a household's own data in six places, each an interface in `app/src/lib/hooks/types.ts`: `recipe-library`, `cook-log`, `pantry`, `shopping-list`, `ideas`, `household-context`. All six ship unconnected, and every screen has a drawn state for that. Hooks are instance-wide and work only in single-kitchen mode (`SOUS_SIGN_IN=off`); sign-in mode refuses to start if any flag in `app/src/lib/hooks/connected.ts` is `true` (`checkDeploymentEnv` in `app/src/lib/kitchens/deployment.ts`).

To connect one:

1. Read its spec, `docs/hooks/<name>.md`. It gives the interface, what each method must do, where the app calls it, and a checklist to run by hand.
2. Write an object that satisfies the interface, and put it in the hook's slot of `implementations` in `app/src/lib/hooks/registry.ts` (every slot ships as `null`). The registry is server-only.
3. Set the hook's flag to `true` in `connected` in `app/src/lib/hooks/connected.ts` (every flag ships as `false`). This file is imported by both client and server, so keep it to plain booleans.

A hook flagged connected with no implementation throws on first use (`hook()` in `registry.ts`) and names its spec. Don't add a fallback that answers empty for a failed read: a call that can't reach its store rejects, and the caller decides what that means on its screen.

## Safety

- **Modes and auth.** `SOUS_SIGN_IN` defaults to sign-in mode (when unset, empty, or `on`); only the exact value `off` selects single-kitchen mode (`app/src/lib/kitchens/deployment.ts`). Start-up validation (`app/src/instrumentation.ts`, `app/src/instrumentation-node.ts`) logs configuration errors and exits with status 1, and `ensureDeploymentReady` re-checks environment and database invariants on the first request. Sign-in mode's server side (Google OAuth via Better Auth, invite-only, 90-day sliding database sessions) is built, but there are no sign-in pages yet, so deployments currently run with `SOUS_SIGN_IN=off`. In single-kitchen mode every page and tRPC procedure is open — do not expose it on a public host without authentication in front of it. The three webhook endpoints always require a per-kitchen bearer token in every build (`app/src/lib/kitchens/webhook-tokens.ts`, `docs/webhook.md`). Run one server instance: the remembered start-up database check and Better Auth's default sign-in rate limit are per process.
- **Kitchen scoping and metering rules.** Follow these four rules in all server code:
  1. Every tRPC procedure except `health` (`publicProcedure`) must use `kitchenProcedure` (`app/src/server/trpc.ts`): in sign-in mode it refuses cross-site requests (`Origin`, `Sec-Fetch-Site`) and requires a session; in both modes it resolves the kitchen and member (before input parsing) and maps `AllowanceUsedError` to `TOO_MANY_REQUESTS`. Never accept a kitchen or member id from client input.
  2. Every library function that reads or writes one of the five data tables (`kitchen_queue`, `doc_recipes`, `recipe_ideas_cache`, `conversation_logs`, `cook_reports`), or one kitchen's rows of `ai_usage`, takes `kitchenId` as its first parameter and puts `eq(<table>.kitchenId, kitchenId)` in every `where`, updates and deletes by id included. The deliberate exceptions are the webhook token lookup (by hash), the overall spend total and monthly spend report, sign-in and invite code, the start-up checks, migrations, and `app/src/lib/kitchens/admin.ts`.
  3. Any procedure that takes a queue item id calls `requireOwnedQueueItem(ctx.kitchen.id, queueId)` (`app/src/server/kitchen-access.ts`) before any hook `connected` short-circuit, so missing ids and other kitchens' ids return the same `NOT_FOUND`.
  4. Background work scheduled with Next.js `after()` receives `kitchenId` explicitly as an argument (never through ambient state). Every model call goes through `chat()` or `vision()` in `app/src/lib/ai/chat.ts` with a required `AiMeter`: `kitchenMeter(kitchenId, memberId, feature)` in application code (`memberId: null` in background work and single-kitchen mode), and `scriptMeter(name)` only in standalone scripts under `app/scripts/` (never under `app/src/`). Do not bypass `chat()`/`vision()` with direct provider calls.
- **URL import fetches server-side.** `importRecipeFromUrl` fetches whatever URL it is given from the server (`extractRecipeFromUrl` in `app/src/lib/recipe-import.ts`). On a host that can reach private addresses, that is a request-forgery risk.
- **Model calls cost money and send data out.** Import, Ask, cook plans, intake, serving estimates, grocery parsing, pantry reconciliation and the household-book Refresh call the configured provider (`docs/environment.md`) and are metered in `ai_usage` under monthly caps. Don't add a model call to a path that runs on page load or in a loop, and never store an `AllowanceUsedError` as a recipe, cook-plan or intake error.
- **Secrets.** Keys live in the environment, never in the repository. `.env*` is ignored by git.
