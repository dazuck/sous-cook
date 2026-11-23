# Environment

Every variable the app reads. Only `DATABASE_URL` is needed to boot; everything else is optional and has a default.

Next.js reads `app/.env.local` on `dev`, `build` and `start`. The schema push (`pnpm --dir app db:push`) is a separate tool, so the simplest setup that serves both is to export the variables in the shell that runs the commands. Never commit a file holding real values; the repo's `.gitignore` covers `.env*`.

## Required

| Variable | What it is |
| --- | --- |
| `DATABASE_URL` | A Postgres connection string, for example `postgres://localhost:5432/sous`. Read at the first query (`app/src/lib/db.ts`), so the build runs without it, and by the schema push (`app/drizzle.config.ts`). |

## Model provider

Recipe import, Ask, serving estimates, cook plans for new recipes, grocery parsing and the household-book Refresh call a language model through `app/src/lib/ai/`. With no key the app still boots and cooks from the bundled pack. Import and Ask fail with a message when used, a recipe with no stored cook plan cooks as written, and grocery parsing finds nothing. One import needs no key: a URL whose page carries its recipe as structured data (JSON-LD) and states a serving count.

| Variable | Default | What it does |
| --- | --- | --- |
| `GOOGLE_AI_API_KEY` | none | Key for the Gemini API. The default provider for both text and vision, so this one key turns every model feature on. |
| `ANTHROPIC_API_KEY` | none | Key for the Anthropic API. Needed only if a provider below is set to `anthropic`. |
| `AI_TEXT_PROVIDER` | `google` | `google` or `anthropic`. Used for text: import from a URL or pasted text, Ask, estimates, cook plans. |
| `AI_TEXT_MODEL` | `gemini-3.5-flash` | The text model's id. Set it whenever you change `AI_TEXT_PROVIDER`, since the default is a Gemini id. |
| `AI_COOK_CHAT_MODEL` | the text model | A different model id for Ask alone, on the text provider. |
| `AI_VISION_PROVIDER` | `google` | `google` or `anthropic`. Used for images: importing a recipe from a photo, a grocery photo. |
| `AI_VISION_MODEL` | `gemini-2.5-flash` | The vision model's id. Set it whenever you change `AI_VISION_PROVIDER`. |

Two things to know before switching providers:

- The prompts were written and checked against the default Gemini models. Another model will work but the cook plans and imports have not been tuned for it.
- With the `google` provider, Ask may use Google Search grounding for a question the recipe doesn't answer. Other providers answer from the recipe and the model alone.

The script that generates cook plans for a pack (`app/scripts/generate-pack-cook-plans.ts --propose`) refuses to run with `AI_TEXT_MODEL` or `AI_TEXT_PROVIDER` set, so that stored plans all come from the default model.

## Webhook

| Variable | Default | What it does |
| --- | --- | --- |
| `KITCHEN_QUEUE_API_TOKEN` | none | The bearer token for `POST /api/kitchen-queue`, its sweep and `GET /api/packs`. In production, with it unset, those three endpoints refuse every call with a 500; in development they accept every call. See `docs/webhook.md`. |

`NODE_ENV` is set by Next.js itself (`production` under `next build` and `next start`, `development` under `next dev`). Besides the webhook check above, the service worker that makes the app installable registers only in production.

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
| `SOUS_BUILD_ID` | The build's id. `app/next.config.ts` makes one up at build time (a date and a random suffix) unless you set it. It names the build in flagged cook reports and versions the service worker. |
| `VERCEL_URL` | If the hosting platform sets it, server-side rendering uses it as the app's own address; otherwise `http://localhost:3000` is used. You don't need to set it. |

## Not in this copy

The author's private copy also read credentials and document ids for a hosted document and spreadsheet service, a voice-assistant skill id, and deploy and browser-test settings. All of that code is removed here. The data it reached now sits behind the six hooks in `docs/hooks/`, which read no environment variables of their own until you write an implementation that does.
