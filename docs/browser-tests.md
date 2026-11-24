# Browser tests

The browser test suite drives a production build of Sous in Chromium through Playwright. It checks end-to-end behaviour across the kitchen home screen, queue screen, Cookpacks shelf and pack view, cook mode, and single-kitchen mode without model keys. Every spec runs in two tablet projects: `landscape` (1280x800) and `portrait` (800x1280), both with touch enabled and a device scale factor of 1.

## Prerequisites

- Docker, running locally (for the suite's own PostgreSQL 17 container).
- Node 24 and pnpm 10, with workspace dependencies installed (`pnpm --dir app install --frozen-lockfile`).
- Chromium for Playwright 1.63.0, installed once:

```sh
pnpm --dir app exec playwright install chromium
```

- No `.env`, `.env.local`, `.env.production`, or `.env.production.local` file in `app/`. The server launcher refuses to start while any of those files exists because Next.js would load them into the app under test.

## Running the suite

Start the suite's PostgreSQL container, recreate the `sous_e2e` database, and run all migrations:

```sh
pnpm --dir app e2e:db:up
```

Run the Playwright suite (builds the production app, seeds the database, and runs all specs in both tablet orientations):

```sh
pnpm --dir app e2e
```

To reuse the last production build on a repeat run without rebuilding:

```sh
E2E_SKIP_BUILD=1 pnpm --dir app e2e
```

When finished, remove the suite's PostgreSQL container:

```sh
pnpm --dir app e2e:db:down
```

## Running two copies at once

Each copy of the browser suite needs its own PostgreSQL container, database port, and app port. Three environment variables override the defaults (when unset or empty, the defaults apply):

- `E2E_APP_PORT` (default `4131`): whole number from `1024` to `65535`.
- `E2E_PG_CONTAINER` (default `rails-pg`): letters, digits, `.`, `_`, and `-`, starting with a letter or digit.
- `E2E_PG_PORT` (default `55731`): whole number from `1024` to `65535`.

Pass the same overrides to every command for the second copy, for example:

```sh
E2E_APP_PORT=4141 E2E_PG_CONTAINER=port-pg E2E_PG_PORT=55741 pnpm --dir app e2e:db:up
E2E_APP_PORT=4141 E2E_PG_CONTAINER=port-pg E2E_PG_PORT=55741 pnpm --dir app e2e
E2E_APP_PORT=4141 E2E_PG_CONTAINER=port-pg E2E_PG_PORT=55741 pnpm --dir app e2e:db:down
```

## Smoke check of a deployed copy

`app/e2e/smoke.spec.ts` is a read-only check of any running Sous copy. It does not start a local server or connect to a database, and it never writes: it never clicks Start, queues a recipe, imports, or calls Ask, and it fails if any page issues a request with a method other than `GET` or `HEAD`.

It checks three things:

- `SMOKE-1`: `GET /api/version` answers 200 with only `commit`; when `SMOKE_EXPECT_COMMIT` is set, the commit must equal it exactly (and a malformed `SMOKE_EXPECT_COMMIT` fails the test with a plain message).
- `SMOKE-2`: `/kitchen` loads with no 5xx response, no unexpected console or page error, and shows the home screen heading.
- `SMOKE-3`: `/kitchen/cookpacks` loads with at least one book, and opening that book loads its page.

`scripts/deploy.sh` runs `pnpm --dir app e2e:smoke` twice on every real deploy: once against the staged URL before promotion, and once against `SOUS_LIVE_URL` after promotion, passing `SMOKE_BASE_URL`, `SMOKE_EXPECT_COMMIT`, and (when configured) `SMOKE_BYPASS_HEADER` and `SMOKE_BYPASS_VALUE`.

To run it by hand against a deployed URL:

```sh
SMOKE_BASE_URL=https://sous.example.com pnpm --dir app e2e:smoke
```

Set `SMOKE_EXPECT_COMMIT=<40-char lowercase sha>` to assert the exact running commit, and set `SMOKE_BYPASS_HEADER` together with `SMOKE_BYPASS_VALUE` if the host requires a deployment protection bypass header.

## What the harness does

- **Isolated PostgreSQL container:** `app/e2e/db-up.sh` runs container `rails-pg` (`postgres:17`, overridable via `E2E_PG_CONTAINER`) published only on `127.0.0.1:55731` (port overridable via `E2E_PG_PORT`) using trust authentication (`POSTGRES_HOST_AUTH_METHOD=trust`, no password), user `postgres`, and database `sous_e2e` (`postgres://postgres@127.0.0.1:55731/sous_e2e`). The container holds only invented test data and must never be used for anything else. It drops and recreates `sous_e2e` empty, then runs `pnpm db:migrate` from `app/`. `app/e2e/db-down.sh` removes only the container named by `E2E_PG_CONTAINER` (default `rails-pg`). Every database entry point checks `assertLocalDatabase` so it refuses any host other than `127.0.0.1` or `localhost`.
- **Isolated production server:** `app/e2e/serve.ts` runs `next build` (unless `E2E_SKIP_BUILD=1`) and serves `next start -H 127.0.0.1 -p 4131` (`http://127.0.0.1:4131`, port overridable via `E2E_APP_PORT`) with an environment built from scratch: `NODE_ENV=production`, `NEXT_TELEMETRY_DISABLED=1`, `DATABASE_URL` set to the suite URL, `SOUS_SIGN_IN=off`, the three `E2E_*` override variables when set, and no model keys or developer shell variables. It monitors the test runner process and stops Next.js if the runner exits.
- **Single-kitchen mode:** `SOUS_SIGN_IN=off` selects the one `home` kitchen created by migrations, with no sign-in pages and all six household hooks (`app/src/lib/hooks/connected.ts`) unconnected.
- **Outbound network blocked on the server:** The server runs with `NODE_USE_ENV_PROXY=1`, `HTTP_PROXY=http://127.0.0.1:9`, `HTTPS_PROXY=http://127.0.0.1:9`, and `NO_PROXY=127.0.0.1,localhost`, so outbound internet requests fail immediately while requests to local test servers on `127.0.0.1` (such as the local JSON-LD recipe page used by URL import) succeed.
- **Fixed seed and per-test reset:** Global setup runs `app/e2e/seed-cli.ts`, which seeds the `home` kitchen through the application's own library functions and copies the seven data tables (`kitchen_queue`, `doc_recipes`, `recipe_ideas_cache`, `conversation_logs`, `cook_reports`, `ai_usage`, `kitchen_webhook_tokens`) into schema `e2e_seed`. Before every test, the fixture truncates those seven tables together and restores them from `e2e_seed`. The `kitchens`, `members`, `invites`, `auth_*`, and migration tables are never modified.
- **Fixed clock and browser guards:** Before every test navigates, `app/e2e/fixtures.ts` fixes the browser clock (`Date.now()` and `new Date()`) to `SEED_NOW` (`2026-03-10T11:00:00Z`) in timezone `Europe/London` and locale `en-US`. Playwright blocks service workers (`serviceWorkers: "block"`) so cached pages cannot mask the build under test. An init script replaces `SpeechRecognition` and `webkitSpeechRecognition` with an inert stand-in so cook mode never requests microphone access. A network guard aborts and fails the test on any browser request outside `127.0.0.1` or `localhost`. A console and page error guard fails the test on any unexpected `console.error` or uncaught page error unless explicitly allowed by the test.

### Seed rows

All rows belong to the `home` kitchen with timestamps fixed relative to `SEED_NOW = 2026-03-10T11:00:00Z`. `Doughnuts I` (`doughnuts-i`) from the bundled 1896 pack is intentionally not seeded so specs can queue it fresh. No row starts in `cooking`.

| Row | Recipe | Source | Status | Cook plan | `created_at` | Other timestamps |
| --- | --- | --- | --- | --- | --- | --- |
| P1 | Thin White Sauce | Bundled pack (`thin-white-sauce`) | `pending` | Stored pack plan | `SEED_NOW - 10 min` | |
| P2 | Boiled Custard | Bundled pack (`boiled-custard`) | `pending` | Stored pack plan | `SEED_NOW - 1 h` | |
| P3 | Pantry Tomato Soup | Invented (serves 4, 12 min simmer on step 3) | `pending` | None, no error | `SEED_NOW - 2 h` | |
| P4 | Sesame Green Beans | Invented (serves 2) | `pending` | None, settled `COOK_PLAN_BLOCKED` error | `SEED_NOW - 3 h` | |
| F1 | Waffles | Bundled pack (`waffles`) | `completed` (`finished_by: "pressed"`) | Stored pack plan | `SEED_NOW - 1 d - 2 h` | `started_at`: `SEED_NOW - 1 d - 1 h`, `completed_at`: `SEED_NOW - 1 d - 15 min` |
| F2 | Herb Omelette | Invented (serves 1) | `completed` (`finished_by: "pressed"`) | None | `SEED_NOW - 3 d - 1 h` | `started_at`: `SEED_NOW - 3 d - 40 min`, `completed_at`: `SEED_NOW - 3 d` |
| X1 | Parker House Rolls | Bundled pack (`parker-house-rolls`) | `cancelled` | Stored pack plan | `SEED_NOW - 2 d` | |

## Coverage

| Screen or feature | Spec / Status |
| --- | --- |
| Kitchen home: pending queue display, responsive "Then" line, no cancelled rows, no vertical scroll | `app/e2e/home.spec.ts` (HOME-1) |
| Kitchen home: starting top recipe, returning to cook-under-way state | `app/e2e/home.spec.ts` (HOME-2) |
| Kitchen home: idle state and Cookpacks link | `app/e2e/home.spec.ts` (HOME-3) |
| Queue screen: pending order, Made recently order, cancelled rows hidden | `app/e2e/queue.spec.ts` (QUEUE-1) |
| Queue screen: Edit and Remove deletes row and updates rail count | `app/e2e/queue.spec.ts` (QUEUE-2) |
| Queue screen: starting a recipe from its queue row | `app/e2e/queue.spec.ts` (QUEUE-3) |
| Cookpacks shelf: bundled 1896 book only, no household book or saved-for-later | `app/e2e/shelf.spec.ts` (SHELF-1) |
| Cookpacks pack view: recipe list order and search filtering | `app/e2e/shelf.spec.ts` (SHELF-2) |
| Cookpacks pack view: queueing Doughnuts I with stored plan and no `ensureCookPlan` request | `app/e2e/shelf.spec.ts` (SHELF-3) |
| Cook mode: opening timetable, Prep screen, Next/Previous step, reload resume | `app/e2e/cook.spec.ts` (COOK-1) |
| Cook mode: starting a step timer and persistence across reload | `app/e2e/cook.spec.ts` (COOK-2) |
| Cook mode: walking to end, armed Done cooking finish, home and Made recently update | `app/e2e/cook.spec.ts` (COOK-3) |
| No model key: as-written cook with pending then failed prep plan note | `app/e2e/no-key.spec.ts` (NOKEY-1) |
| No model key: settled plan error keeps as-written view and error unchanged | `app/e2e/no-key.spec.ts` (NOKEY-2) |
| No model key: paste import surfaces missing-key error without adding a row | `app/e2e/no-key.spec.ts` (NOKEY-3) |
| No model key: local JSON-LD URL import extracts and queues recipe | `app/e2e/no-key.spec.ts` (NOKEY-4) |
| No model key: Ask Sous shows unreachable message when model key is absent | `app/e2e/no-key.spec.ts` (NOKEY-5) |
| Single-kitchen mode: `/` redirect, `/api/auth/get-session` 404, no sign-in/out controls | `app/e2e/single-kitchen.spec.ts` (SINGLE-1) |
| Version endpoint: `/api/version` answers 200 with only `commit` and matches `SOUS_RELEASE_COMMIT` when set | `app/e2e/version.spec.ts` (VERSION-2) |
| Deployed copy smoke check: `/api/version`, `/kitchen`, `/kitchen/cookpacks`, and a book page (read-only) | `app/e2e/smoke.spec.ts` (SMOKE-1, SMOKE-2, SMOKE-3) |
| Flagging a screen and the reports panel | not covered yet |
| Voice commands | not covered yet |
| The look-ahead sheet | not covered yet |
| The whole recipe view | not covered yet |
| Scaling servings | not covered yet |
| Offline cooking | not covered yet |
| The webhook | not covered yet |
| Finishing an idle cook automatically | not covered yet |
| Sign-in pages | not covered yet |
| Screenshots | not covered yet |
