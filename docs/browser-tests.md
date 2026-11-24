# Browser tests

The browser test suite drives a production build of Sous in Chromium through Playwright. It checks end-to-end behaviour across the kitchen home screen, queue screen, Cookpacks shelf and pack view, cook mode, and single-kitchen mode without model keys. Every spec runs in two tablet projects: `landscape` (1280x800) and `portrait` (800x1280), both with touch enabled and a device scale factor of 1. In both, the browser says it is Playwright's desktop Chrome (`userAgent` in `app/playwright.config.ts`) on whatever machine runs the suite: the cook screen picks how it listens from that and the touch screen, and Chromium on Linux with a touch screen reads as the tablet asking for desktop sites, which listens only on a tap.

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

Run the Playwright behaviour suite (builds the production app, seeds the database, and runs all non-`@visual` specs in both tablet orientations):

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

## Thin tests while a design is still changing

Screens in Sous are still evolving, so the browser suite follows a thin-tests rule:

- One main-path browser test per screen on the wide (landscape) tablet, plus a not-broken check upright (portrait) and on a phone.
- Screenshot baselines only for screens whose design has been signed off.
- Layout rules belong in fast unit tests, not in browser tests.

## Screenshots

`app/e2e/visual.spec.ts` holds the screenshot checks (tagged `@visual`), running on the `landscape` (1280x800) tablet project only (`portrait` ignores `@visual` via `grepInvert`). `pnpm --dir app e2e` leaves screenshot tests out so behaviour runs stay fast and platform-independent.

Three proof baselines exercise the screenshot setup:

- `VIS-1` (`home.png`): `/kitchen` with the seeded queue (Thin White Sauce offered to start, meal illustration, and right-edge rail).
- `VIS-2` (`library.png`): `/kitchen/cookpacks` showing the bundled 1896 book on the shelf.
- `VIS-3` (`cook-step.png`): Thin White Sauce's first cooking step, after starting from home, leaving the opening screen, and advancing past the prep page, with the bottom strip visible and its peek lowered.

Screens get baselines one at a time, after their design is signed off, not in a sweep.

Reproducibility relies on pinning both the browser and the OS font rendering:

- `@playwright/test` is pinned to an exact version in `app/package.json` (`1.63.0`, with no caret or tilde), which pins the Chromium build.
- Baselines are taken only on macOS (`app/e2e/visual.spec.ts` skips the whole file on any other platform), so font rendering matches without a Docker image.
- Comparisons in `app/playwright.config.ts` require exact pixel matches (`maxDiffPixels: 0`, `threshold: 0`) with `animations: "disabled"` and `caret: "hide"`. Before each shot, `settle(page)` in `app/e2e/visual-helpers.ts` waits for every declared font face in `document.fonts` to load, for any cross-fading leaving step line to finish and leave the DOM, and for two animation frames to paint.

With the E2E PostgreSQL container running (`pnpm --dir app e2e:db:up`), run the screenshot tests:

```sh
pnpm --dir app e2e:visual
```

To reuse the last production build on a repeat run:

```sh
E2E_SKIP_BUILD=1 pnpm --dir app e2e:visual
```

After a screen's design is signed off or intentionally changed, take or re-take its baseline and inspect every new image in `app/e2e/visual.spec.ts-snapshots/` before committing it:

```sh
pnpm --dir app e2e:visual --update-snapshots
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

`SMOKE_EXPECT_SIGN_IN` is required on every run and must be set to exactly `on` or `off` (no default, no trimming, no case folding). If it is missing or has any other value, the smoke run fails immediately before any page or request check runs.

It checks three things:

- `SMOKE-1`: `GET /api/version` answers 200 with only `commit`; when `SMOKE_EXPECT_COMMIT` is set, the commit must equal it exactly (and a malformed `SMOKE_EXPECT_COMMIT` fails the test with a plain message).
- `SMOKE-2`:
  - When `SMOKE_EXPECT_SIGN_IN=off` (single-kitchen mode): navigates to `/kitchen`, confirms the navigation was not redirected, confirms the final URL stays on the configured `SMOKE_BASE_URL` origin with path `/kitchen` and a response status below 400, checks for no 5xx response, no unexpected console or page error, and no non-`GET`/`HEAD` request, and confirms the home screen headings appear.
  - When `SMOKE_EXPECT_SIGN_IN=on` (sign-in mode): navigates to `/kitchen`, confirms the final URL stays on the configured `SMOKE_BASE_URL` origin with path `/sign-in` and a response status below 400, confirms the sign-in page's level-1 heading is visible and the "Sign in with Google" button is visible and enabled (without clicking it), sends a read-only `GET /api/auth/get-session` through Playwright's request context without following redirects (`maxRedirects: 0`), asserting status 200 with a JSON `null` body (catching a missing `DATABASE_URL` in sign-in mode), and checks for no 5xx response, no unexpected console or page error, and no non-`GET`/`HEAD` request.
- `SMOKE-3`: when `SMOKE_EXPECT_SIGN_IN=off`, loads `/kitchen/cookpacks` with at least one book and opens its page without write requests. When `SMOKE_EXPECT_SIGN_IN=on`, `SMOKE-3` is skipped because kitchen pages require a session.

`scripts/deploy.sh` runs `pnpm --dir app e2e:smoke` twice on every real deploy: once against the staged URL before promotion, and once against `SOUS_LIVE_URL` after promotion, passing `SMOKE_BASE_URL`, `SMOKE_EXPECT_COMMIT`, `SMOKE_EXPECT_SIGN_IN` (from `SOUS_EXPECT_SIGN_IN`), and (when configured) `SMOKE_BYPASS_HEADER` and `SMOKE_BYPASS_VALUE`.

To run it by hand against a deployed URL (use `SMOKE_EXPECT_SIGN_IN=off` for a single-kitchen deployment):

```sh
SMOKE_BASE_URL=https://sous.example.com SMOKE_EXPECT_SIGN_IN=on pnpm --dir app e2e:smoke
```

Set `SMOKE_EXPECT_COMMIT=<40-char lowercase sha>` to assert the exact running commit, and set `SMOKE_BYPASS_HEADER` together with `SMOKE_BYPASS_VALUE` if the host requires a deployment protection bypass header.

## In CI

The `browser` job in `.github/workflows/ci.yml` runs the behaviour suite (`pnpm --dir app e2e`) on every push to `main` and every pull request, on Linux (`ubuntu-latest`) with Chromium.

Screenshot tests (`app/e2e/visual.spec.ts`) do not run in CI because `pnpm --dir app e2e` excludes `@visual` and their baselines are macOS only. The smoke check (`app/e2e/smoke.spec.ts`) does not run in CI either, because `SMOKE_BASE_URL` is never set there.

When the `browser` job fails, it uploads `app/test-results/` and `app/playwright-report/` as the `browser-test-results` artifact (kept for 7 days). Download and unzip the artifact to inspect a failure trace or the HTML report locally:

```sh
pnpm --dir app exec playwright show-trace <trace.zip>
pnpm --dir app exec playwright show-report <report-dir>
```

## What the harness does

- **Isolated PostgreSQL container:** `app/e2e/db-up.sh` runs container `rails-pg` (`postgres:17`, overridable via `E2E_PG_CONTAINER`) published only on `127.0.0.1:55731` (port overridable via `E2E_PG_PORT`) using trust authentication (`POSTGRES_HOST_AUTH_METHOD=trust`, no password), user `postgres`, and database `sous_e2e` (`postgres://postgres@127.0.0.1:55731/sous_e2e`). The container holds only invented test data and must never be used for anything else. It drops and recreates `sous_e2e` empty, then runs `pnpm db:migrate` from `app/`. `app/e2e/db-down.sh` removes only the container named by `E2E_PG_CONTAINER` (default `rails-pg`). Every database entry point checks `assertLocalDatabase` so it refuses any host other than `127.0.0.1` or `localhost`.
- **Isolated production server:** `app/e2e/serve.ts` runs `next build` (unless `E2E_SKIP_BUILD=1`) and serves `next start -H 127.0.0.1 -p 4131` (`http://127.0.0.1:4131`, port overridable via `E2E_APP_PORT`) with an environment built from scratch: `NODE_ENV=production`, `NEXT_TELEMETRY_DISABLED=1`, `DATABASE_URL` set to the suite URL, `SOUS_SIGN_IN=off`, the three `E2E_*` override variables when set, and no model keys or developer shell variables. It monitors the test runner process and stops Next.js if the runner exits.
- **Single-kitchen mode:** `SOUS_SIGN_IN=off` selects the one `home` kitchen created by migrations, with no sign-in pages and all six household hooks (`app/src/lib/hooks/connected.ts`) unconnected.
- **Outbound network blocked on the server:** The server runs with `NODE_USE_ENV_PROXY=1`, `HTTP_PROXY=http://127.0.0.1:9`, `HTTPS_PROXY=http://127.0.0.1:9`, and `NO_PROXY=127.0.0.1,localhost`, so outbound internet requests fail immediately while requests to local test servers on `127.0.0.1` (such as the local JSON-LD recipe page used by URL import) succeed.
- **Fixed seed and per-test reset:** Global setup runs `app/e2e/seed-cli.ts`, which seeds the `home` kitchen through the application's own library functions and copies the seven data tables (`kitchen_queue`, `doc_recipes`, `recipe_ideas_cache`, `conversation_logs`, `cook_reports`, `ai_usage`, `kitchen_webhook_tokens`) into schema `e2e_seed`. Before every test, the fixture truncates those seven tables together and restores them from `e2e_seed`. The `kitchens`, `members`, `invites`, `auth_*`, and migration tables are never modified.
- **Fixed clock and browser guards:** Before every test navigates, `app/e2e/fixtures.ts` fixes the browser clock (`Date.now()` and `new Date()`) to `SEED_NOW` (`2026-03-10T11:00:00Z`) in timezone `Europe/London` and locale `en-US`. Playwright blocks service workers (`serviceWorkers: "block"`) so cached pages cannot mask the build under test. An init script replaces `SpeechRecognition` and `webkitSpeechRecognition` with an inert stand-in so cook mode never requests microphone access; a spec that needs commands heard installs `app/e2e/fake-speech.ts` over it, a recognizer it speaks to (`voice-replies.spec.ts`). A network guard aborts and fails the test on any browser request outside `127.0.0.1` or `localhost`. A console and page error guard fails the test on any unexpected `console.error` or uncaught page error unless explicitly allowed by the test.

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
| Kitchen home: the names panel wholly on the screen, each row level with its rail icon, its left strip closing it | `app/e2e/home.spec.ts` (HOME-4) |
| Queue screen: pending order, Made recently order, cancelled rows hidden | `app/e2e/queue.spec.ts` (QUEUE-1) |
| Queue screen: Edit and Remove deletes row and updates rail count | `app/e2e/queue.spec.ts` (QUEUE-2) |
| Queue screen: starting a recipe from its queue row | `app/e2e/queue.spec.ts` (QUEUE-3) |
| Cookpacks shelf: bundled 1896 book only, no household book or saved-for-later | `app/e2e/shelf.spec.ts` (SHELF-1) |
| Cookpacks pack view: recipe list order and search filtering | `app/e2e/shelf.spec.ts` (SHELF-2) |
| Cookpacks pack view: queueing Doughnuts I with stored plan and no `ensureCookPlan` request | `app/e2e/shelf.spec.ts` (SHELF-3) |
| Cook mode: opening timetable with its Get out list, the prep page before the first cooking step, Next/Previous step, reload resume | `app/e2e/cook.spec.ts` (COOK-1) |
| Cook mode: two small prep jobs as one page of tick rows, a tick kept across reload, Next leaving prep | `app/e2e/cook.spec.ts` (COOK-4) |
| Cook mode: the bottom strip on a cooking step, filled to the step in hand and moving on with Next, a tap raising the peek on the step in hand, the peek's arrow putting it away | `app/e2e/cook.spec.ts` (COOK-5) |
| Cook mode: the peek and the whole cook laid out again as Prep first's pages turn (the time to the table and the fill move with the page) | not covered in a browser: COOK-5 still passes when the sheet's hold reads only the step's mark and not its page (`inHandKey` in `app/src/lib/kitchen/sheet-strip.ts`). The unit test in `app/src/lib/kitchen/sheet-strip.test.ts` ("tells each page in hand apart") is its only guard. |
| Cook mode: the whole meal drawn as lines on the opening and at the whole cook, the step in hand marked now, Esc back to the step | `app/e2e/cook.spec.ts` (COOK-6) |
| Cook mode: starting a step timer and persistence across reload | `app/e2e/cook.spec.ts` (COOK-2) |
| Cook mode: walking to end, armed Done cooking finish, home and Made recently update | `app/e2e/cook.spec.ts` (COOK-3) |
| Cook mode: Sue's replies in More (Sounds until chosen, Sounds and voice offered and fetching every clip, the choice kept across a reload) | `app/e2e/voice-replies.spec.ts` (VOICE-1) |
| Cook mode: every recorded clip answered as audio and decoded in Chromium at its measured length | `app/e2e/voice-replies.spec.ts` (VOICE-2) |
| Cook mode: voice commands heard through a recognizer the spec talks to: the understood and not-understood sounds, none for touch or for talk not meant for Sue, Off silent, a flag confirmed by its clip (three at most), a timer read back from its clip, and a tap starting each listen on Android | `app/e2e/voice-replies.spec.ts` (VOICE-3 to VOICE-8) |
| Cook mode: how it listens by what the browser says it is: every spec's browser is Playwright's desktop Chrome on any machine; Linux with a touch screen listens only once the dot is tapped; Linux without one listens all the time | `app/e2e/voice-replies.spec.ts` (VOICE-9 to VOICE-11) |
| No model key: as-written cook with pending then failed prep plan note | `app/e2e/no-key.spec.ts` (NOKEY-1) |
| No model key: settled plan error keeps as-written view and error unchanged | `app/e2e/no-key.spec.ts` (NOKEY-2) |
| No model key: paste import surfaces missing-key error without adding a row | `app/e2e/no-key.spec.ts` (NOKEY-3) |
| No model key: local JSON-LD URL import extracts and queues recipe | `app/e2e/no-key.spec.ts` (NOKEY-4) |
| No model key: Ask Sous opens from the top line's capsule (beside the step in landscape, a full sheet upright), sends a prep page's jobs with no step, and shows the unreachable message | `app/e2e/no-key.spec.ts` (NOKEY-5) |
| Single-kitchen mode: `/` redirect, `/api/auth/get-session` 404, no sign-in/out controls | `app/e2e/single-kitchen.spec.ts` (SINGLE-1) |
| Version endpoint: `/api/version` answers 200 with only `commit` and matches `SOUS_RELEASE_COMMIT` when set | `app/e2e/version.spec.ts` (VERSION-2) |
| Deployed copy smoke check: `/api/version`, `/kitchen` (home screen on the same origin with no redirect when `SMOKE_EXPECT_SIGN_IN=off`; same-origin redirect to `/sign-in` with heading and enabled button plus `GET /api/auth/get-session` returning 200 `null` without following redirects when `SMOKE_EXPECT_SIGN_IN=on`), and `/kitchen/cookpacks` plus a book page when `SMOKE_EXPECT_SIGN_IN=off` (skipped when `on`; read-only) | `app/e2e/smoke.spec.ts` (SMOKE-1, SMOKE-2, SMOKE-3) |
| Flagging a screen and the reports panel | not covered yet |
| What a voice command does beyond the reply (the step moved, the timer set, the screen flagged, Ask by voice) | not covered yet |
| The whole cook's reading of a stop, and its scrolling lines | not covered yet |
| The whole recipe view | not covered yet |
| Scaling servings | not covered yet |
| Offline cooking | not covered yet |
| The webhook | not covered yet |
| Finishing an idle cook automatically | not covered yet |
| Sign-in pages | not covered yet |
| Screenshot baseline: kitchen home | `app/e2e/visual.spec.ts` (VIS-1) |
| Screenshot baseline: Cookpacks library | `app/e2e/visual.spec.ts` (VIS-2) |
| Screenshot baseline: Thin White Sauce first cooking step | `app/e2e/visual.spec.ts` (VIS-3) |
| Screenshots of every other screen | no baseline yet (not signed off) |
| The phone width | not covered yet |
