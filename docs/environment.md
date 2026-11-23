# Environment

Every environment variable the app and its scripts read.

When the Node.js server boots, `app/src/instrumentation.ts` runs `checkDeploymentEnv` (`app/src/lib/kitchens/deployment.ts`) and exits with status 1 if the environment variables (or hook flags) are incomplete or invalid (Next.js may print `Ready` just before that line). Start-up does not look at the database: `DATABASE_URL` and the database's contents are checked on the first request. `next build` skips start-up checks so it runs with an empty environment.

Next.js reads `app/.env.local` on `dev`, `build` and `start`. The migration scripts (`pnpm --dir app db:migrate`, `pnpm --dir app db:baseline`) and the operator script (`pnpm --dir app kitchens`) are separate CLI tools, so the simplest setup that serves all of them is to export the variables in the shell that runs the commands. Never commit a file holding real values; the repo's `.gitignore` covers `.env*`.

## Required

For single-kitchen mode (one household, no sign-in — the only mode usable end to end today), set both variables below.

| Variable | What it is |
| --- | --- |
| `DATABASE_URL` | A PostgreSQL connection string, for example `postgres://localhost:5432/sous`. Read lazily at the first query (`app/src/lib/db.ts`), by Drizzle (`app/drizzle.config.ts`), by `db:baseline` (`app/scripts/db-baseline.ts`), and by the operator script (`app/scripts/kitchens.ts`). |
| `SOUS_SIGN_IN` | Selects the deployment mode (`app/src/lib/kitchens/deployment.ts`). Only the exact value `off` selects single-kitchen mode. Unset, empty (`""`), or `on` selects sign-in mode (the default, so losing the variable fails closed). Any other value makes the server log an error and exit. |

**Database notes:**

- **Single-kitchen database check.** On the first request, single-kitchen mode refuses to serve (tRPC `INTERNAL_SERVER_ERROR`, webhook `500`) if the database has no `"home"` kitchen, or holds any other kitchen, any member, or any invite. A database with no tables fails with the raw query error (`Failed query: select "id", "slug" from "kitchens"`) instead; run `pnpm --dir app db:migrate` to create them. (An older database created with `db:push` needs `pnpm --dir app db:baseline` once before `pnpm --dir app db:migrate`; see Upgrading an older database in [README.md](../README.md).) The check runs once per server process and is remembered after it passes, so restart the server after changing the database by hand.
- **Migrations and connection poolers.** Migrations (`pnpm --dir app db:migrate`) take exclusive locks on the tables they change and set no lock timeout: stop the app, run the migration, and start the app again. If your hosted PostgreSQL sits behind a transaction-mode connection pooler, run migrations (and `db:baseline`) with a direct or session-mode connection string in `DATABASE_URL`; whether a transaction-mode pooler handles Drizzle's transactional migrations is unconfirmed.
- **Row-level security.** Every table enables row-level security with no policies, so only the role that owns the tables (the one in `DATABASE_URL`), and roles that bypass row-level security such as a superuser, can read or write them. If your PostgreSQL host exposes the database through additional API roles (for example Supabase's `anon` and `authenticated` roles), those roles can read nothing, but default grants may still leave them with the `TRUNCATE` privilege, which row-level security does not govern: revoke `TRUNCATE` from those roles.
- **Single instance.** Some limits and caches hold per server process (the remembered start-up database check and Better Auth's default in-memory sign-in rate limit): run one server instance.

## Sign-in mode (server side only; not yet usable end to end)

Sign-in mode's server side is built, but the app has no sign-in pages yet and sign-in with a real Google account has not been exercised. Until sign-in pages exist, run with `SOUS_SIGN_IN=off`.

When `SOUS_SIGN_IN` is unset, empty, or `on`, all six variables below are required (`SOUS_AI_KITCHEN_CAP_USD` and `SOUS_AI_TOTAL_CAP_USD` are described under Model spend and caps), and every hook flag in `app/src/lib/hooks/connected.ts` must be `false`. If any check fails, the server logs the reason and exits.

| Variable | What it is |
| --- | --- |
| `BETTER_AUTH_SECRET` | Secret used by Better Auth to sign session cookies and encrypt stored OAuth tokens (`app/src/lib/auth/auth.ts`, `app/src/lib/kitchens/deployment.ts`). Must be at least 32 characters after trimming. |
| `BETTER_AUTH_URL` | Public origin of the app, for example `https://sous.example.com` (`app/src/lib/auth/auth.ts`, `app/src/lib/kitchens/deployment.ts`). Must be a valid `http` or `https` URL, and must use `https` unless its hostname is `localhost`, `127.0.0.1`, or `[::1]`. Used as Better Auth's base URL and trusted origin, and checked against `Origin` headers on tRPC requests. |
| `GOOGLE_CLIENT_ID` | Google OAuth client id for sign-in (`openid`, `email`, and `profile` scopes only; `app/src/lib/auth/auth.ts`). |
| `GOOGLE_CLIENT_SECRET` | Google OAuth client secret (`app/src/lib/auth/auth.ts`). |

## Model provider

Recipe import, Ask, serving estimates, intake cuts, cook plans for new recipes, grocery parsing, pantry reconciliation and the household-book Refresh call a language model through `app/src/lib/ai/`. With no key the app still boots and cooks from the bundled pack. Import and Ask fail with a message when used, a recipe with no stored cook plan cooks as written, and grocery parsing finds nothing. One import needs no key: a URL whose page carries its recipe as structured data (JSON-LD) and states a serving count.

| Variable | Default | What it does |
| --- | --- | --- |
| `GOOGLE_AI_API_KEY` | none | Key for the Gemini API. The default provider for both text and vision, so this one key turns every model feature on. |
| `ANTHROPIC_API_KEY` | none | Key for the Anthropic API. Needed only if a provider below is set to `anthropic`. |
| `AI_TEXT_PROVIDER` | `google` | `google` or `anthropic`. Used for text: import from a URL or pasted text, Ask, serving estimates, intake cuts, cook plans, text/voice grocery parsing, pantry reconciliation, library Refresh. |
| `AI_TEXT_MODEL` | `gemini-3.5-flash` | The text model's id. Set it whenever you change `AI_TEXT_PROVIDER`, since the default is a Gemini id. |
| `AI_COOK_CHAT_MODEL` | the text model | A different model id for Ask alone, on the text provider. |
| `AI_VISION_PROVIDER` | `google` | `google` or `anthropic`. Used for images: importing a recipe from a photo, a grocery photo. |
| `AI_VISION_MODEL` | `gemini-2.5-flash` | The vision model's id. Set it whenever you change `AI_VISION_PROVIDER`. |

Two things to know before switching providers:

- The prompts were written and checked against the default Gemini models. Another model will work, but the cook plans and imports have not been tuned for it.
- With the `google` provider, Ask may use Google Search grounding for a question the recipe doesn't answer. Other providers answer from the recipe and the model alone.

The script that generates cook plans for a pack (`app/scripts/generate-pack-cook-plans.ts --propose`) refuses to run with `AI_TEXT_MODEL` or `AI_TEXT_PROVIDER` set (`app/scripts/default-model.ts`), so that stored plans all come from the default model.

## Model spend and caps

Every kitchen-metered model call is recorded in the `ai_usage` table per kitchen (`app/src/lib/ai/spend.ts`). Two optional variables cap spend per calendar month (in single-kitchen mode they are how you bound what anyone who can reach the app can spend; in sign-in mode both are required).

| Variable | Default | What it does |
| --- | --- | --- |
| `SOUS_AI_KITCHEN_CAP_USD` | none | Default monthly AI spend cap per kitchen, in US dollars. Required in sign-in mode; optional in single-kitchen mode (unset means no cap). A kitchen's own override set with `pnpm --dir app kitchens cap set` takes precedence. |
| `SOUS_AI_TOTAL_CAP_USD` | none | Monthly AI spend cap across the whole deployment, in US dollars. Required in sign-in mode; optional in single-kitchen mode (unset means no cap). |

**Format and validation (`app/src/lib/ai/prices.ts`, `app/src/lib/kitchens/deployment.ts`):**

- Each cap must match `^\d+(\.\d{1,2})?$`: a plain non-negative dollar amount with at most two decimal places and no sign (for example `2`, `2.5`, `0.25`, or `0`; `0` refuses every model call the cap covers). Negative numbers, scientific notation, more than two decimals, and amounts too large to store in micro-dollars are refused.
- A blank value (for example `SOUS_AI_KITCHEN_CAP_USD=""`) is a configuration error in both modes. Leave the variable unset for no cap in single-kitchen mode.

**Price table check:** Whenever a cap variable is set at start-up (always in sign-in mode, and in single-kitchen mode whenever either `SOUS_AI_KITCHEN_CAP_USD` or `SOUS_AI_TOTAL_CAP_USD` is set), every configured model (`AI_TEXT_MODEL`, `AI_COOK_CHAT_MODEL`, `AI_VISION_MODEL`, or their defaults) must have a row in `app/src/lib/ai/prices.ts`, or the server refuses to start. Today that table prices `gemini-3.5-flash` ($1.50/M input, $9.00/M output) and `gemini-2.5-flash` ($0.30/M input, $2.50/M output), plus Google Search grounding at $0.014 per reported query. If you set a per-kitchen cap with `kitchens cap set` in single-kitchen mode without setting either cap variable, an unpriced model is refused when called; with no cap in force at all, calls to unpriced models still run and record token counts with a null cost.

**How caps work:**

- **Month window.** Spend is summed over the **UTC calendar month**, using the PostgreSQL database clock (`now() at time zone 'UTC'`). Allowances reset at `00:00 UTC` on the first day of the next month.
- **Reservation and settlement.** Before calling the provider, an upper-bound estimate is checked under a transaction-scoped database advisory lock and inserted as `reserved`. On success the row settles to reported usage; on a provider error it settles as `failed` at its reservation.
- **When a cap is reached.** No model call is made. tRPC procedures return `TOO_MANY_REQUESTS` with a plain message naming the UTC reset date (for example, `This kitchen's AI allowance for this month is used up. It resets on 1 December. Cooking from saved plans still works.`) and `data.allowance = { scope, resetsAt }`. Reaching the overall cap also logs `[ai-cap] overall monthly cap reached`. The webhook `POST /api/kitchen-queue` returns `429` if a serving estimate is blocked (see [webhook.md](webhook.md)). Cap refusals are never stored as recipe, cook-plan, or intake errors.
- **What still works when capped.** Cooking any queued recipe (from its stored cook plan, or as written if it has no plan), queuing recipes from the bundled pack (whose stored plans live in `app/pack-plans/` and make no model call), importing a URL that carries structured JSON-LD recipe data with a serving count, queuing via the webhook with `serves` supplied, and non-AI features (timers, voice, queue management, cook reports).
- **Operator commands.** With `DATABASE_URL` set, `pnpm --dir app kitchens spend [--month YYYY-MM]` prints spend by kitchen and feature plus any rows still `reserved` after an hour; its cap column reflects the cap variables of the shell that runs it, not the server's, so run it with the same cap variables as the server to see the caps in force. `pnpm --dir app kitchens cap set --kitchen <slug> --usd <amount>` and `pnpm --dir app kitchens cap clear --kitchen <slug>` set or clear a kitchen's own cap override. In single-kitchen mode (`SOUS_SIGN_IN=off`), `invite`, `uninvite`, and `remove-member` are refused because single-kitchen mode has no members or invites.

## The kitchen's place and time

These are read in the browser bundle, so they are fixed at build time: change one, then rebuild.

| Variable | Default | What it does |
| --- | --- | --- |
| `NEXT_PUBLIC_KITCHEN_LAT` | `51.48` | Latitude of the kitchen, in decimal degrees. With the longitude it gives the time of sunset, which the screen's ambient light follows. |
| `NEXT_PUBLIC_KITCHEN_LNG` | `0` | Longitude, in decimal degrees (west is negative). |
| `NEXT_PUBLIC_KITCHEN_TZ` | `Europe/London` | An IANA time zone, such as `Europe/Lisbon`. The home screen's clock and its "Tonight" label use it, as does the date shown for the household book's last Refresh, whatever the tablet's own clock is set to. The server uses it too, for anything dated by the kitchen's day: the cook log's timestamps and which cooks count as today's (`docs/hooks/cook-log.md`). |
| `NEXT_PUBLIC_AMBIENT_FORCE` | none | `dusk` or `day` pins the ambient light, for working on the screens. Ignored in a production build, unless `NEXT_PUBLIC_E2E` is `1`. |
| `NEXT_PUBLIC_E2E` | none | `1` lets `NEXT_PUBLIC_AMBIENT_FORCE` apply in a production build. It does nothing else in this copy. |

The defaults are a placeholder (Greenwich). Set the latitude, longitude and time zone to where the kitchen is.

## Set for you

| Variable | What it is |
| --- | --- |
| `NODE_ENV` | Set by Next.js (`production` under `next build` and `next start`, `development` under `next dev`). The PWA service worker registers only in `production` (`app/src/components/ServiceWorkerRegistration.tsx`), and `NEXT_PUBLIC_AMBIENT_FORCE` is ignored in `production` unless `NEXT_PUBLIC_E2E=1`. |
| `NEXT_RUNTIME` | Set by Next.js. `app/src/instrumentation.ts` runs start-up checks only when this is `nodejs`. |
| `NEXT_PHASE` | Set by Next.js. `app/src/instrumentation.ts` skips start-up checks when this is `phase-production-build`. |
| `SOUS_BUILD_ID` | The build's id. `app/next.config.ts` makes one up at build time (a date and a random suffix) unless you set it. It names the build in flagged cook reports and versions the service worker. |
| `VERCEL_URL` | If the hosting platform sets it, server-side rendering uses it as the app's own address (`app/src/app/providers.tsx`); otherwise `http://localhost:3000` is used. You don't need to set it. |

## Tests

| Variable | What it is |
| --- | --- |
| `SOUS_TEST_POSTGRES_URL` | Optional PostgreSQL connection string for the real-database concurrency test suite (`app/src/lib/kitchens/races.pg.test.ts`), skipped when unset. Must point at a disposable, migrated database whose name contains `"test"` (for example `postgres://localhost:5432/sous_test`); the test deletes rows before every case. |

## Not in this copy

The author's private copy also read credentials and document ids for a hosted document and spreadsheet service, a voice-assistant skill id, and deploy and browser-test settings. All of that code is removed here. The data it reached now sits behind the six hooks in `docs/hooks/`, which read no environment variables of their own until you write an implementation that does.
