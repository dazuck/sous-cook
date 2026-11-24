# Deploying Sous

This runbook explains how Sous is checked, deployed, verified, and rolled back.

## What a release is

A release is a single git commit that has passed `scripts/release-check.sh`, been staged, verified, smoked, and promoted by `scripts/deploy.sh`, and recorded with a sequential release number in the local release log.

Every built copy serves `GET /api/version`, which returns `{"commit": "<40-char lowercase sha>"}` (or `{"commit": null}` when built without a valid commit). That value is fixed at build time from `SOUS_RELEASE_COMMIT`. `scripts/deploy.sh` checks `/api/version` directly at three points: before deploy to verify what is currently live, after staging to confirm the staged copy answers the target commit before promotion, and after promotion (retrying until `SOUS_LIVE_WAIT_SECONDS`) to confirm the live address answers the new commit. The smoke runs act as a second check on top of those version checks.

## One-time setup

### Hosting project settings (Vercel example)

Configure the hosting project with:

- **Root directory:** `app`
- **Include files outside the root directory:** enabled (required because `app/` imports `../pack` and bundles pack JSON files from `../packs`)
- **Turn off automatic deploys from Git pushes** (on Vercel, in the project's Git settings). A push-triggered deploy skips the release check, the pre-migration backup, and the migration. If a push-triggered deploy ever slips through, the live copy answers `null` or an unrecorded commit and `scripts/deploy.sh` refuses to continue: roll back on the host to the last recorded release, then deploy normally.
- **Do not set `SOUS_RELEASE_COMMIT` by hand** in the host's environment variable settings. `scripts/deploy.sh` passes `--build-env SOUS_RELEASE_COMMIT=<sha>` on every deploy so `/api/version` always reflects the exact commit being released.
- **Deployment protection:** If the host protects deployment URLs (Vercel does by default), either set `SMOKE_BYPASS_HEADER` to `x-vercel-protection-bypass` and `SMOKE_BYPASS_VALUE` to the project's "Protection Bypass for Automation" secret, or turn deployment protection off. Without one of these, the staged `/api/version` check receives HTTP 401 and `scripts/deploy.sh` stops before promotion.

### Host project environment variables (Production)

Configure these in the hosting project's own Production environment (separate from the local operator variables below):

- **`DATABASE_URL` (always required):** PostgreSQL connection string for the production database.
- **Sign-in mode (`SOUS_SIGN_IN` unset, empty, or `on`, which is the default):** Set all six variables that `app/src/lib/kitchens/deployment.ts` checks at start-up:
  - `BETTER_AUTH_SECRET`: non-empty, at least 32 characters after trimming.
  - `BETTER_AUTH_URL`: non-empty, valid URL matching the live origin over `https` (for example `https://sous.example.com`; `http` is allowed only for `localhost`, `127.0.0.1`, or `[::1]`).
  - `GOOGLE_CLIENT_ID`: non-empty Google OAuth client id.
  - `GOOGLE_CLIENT_SECRET`: non-empty Google OAuth client secret.
  - `SOUS_AI_KITCHEN_CAP_USD`: non-empty, plain non-negative dollar amount with at most two decimals (for example `2`, `0.25`, or `0`).
  - `SOUS_AI_TOTAL_CAP_USD`: non-empty, plain non-negative dollar amount with at most two decimals (for example `10`, `2.5`, or `0`).
  In sign-in mode, all household hook flags in `app/src/lib/hooks/connected.ts` must remain `false`, and every configured AI model (`AI_TEXT_MODEL`, `AI_COOK_CHAT_MODEL`, `AI_VISION_MODEL`, or their defaults) must have a price entry in `app/src/lib/ai/prices.ts`.
- **Single-kitchen mode:** Set `SOUS_SIGN_IN=off` instead of the sign-in variables above. (`SOUS_AI_KITCHEN_CAP_USD` and `SOUS_AI_TOTAL_CAP_USD` are optional in single-kitchen mode; if either is set, it must follow the same dollar format and every configured model must have a price entry.)
- **Do not set `SOUS_RELEASE_COMMIT` by hand** in the host project.

If any sign-in variable checked at start-up (or an AI cap or model price configuration) is missing or invalid, the server refuses to start, the staged smoke check fails, and nothing is promoted. Start-up does not check `DATABASE_URL` (`app/src/lib/db.ts` reads it on first use):

- In `on` (sign-in) mode, the smoke check's `GET /api/auth/get-session` request catches a missing `DATABASE_URL` (the auth handler answers 500 instead of 200 with JSON `null`). A `DATABASE_URL` that is present but points at a wrong or unreachable database is not caught by the `on` smoke check, because no unauthenticated read-only request reaches the database; the first sign-in would fail (see Known limits below).
- In `off` (single-kitchen) mode, the kitchen pages read the database on load, so both a missing `DATABASE_URL` and a wrong or unreachable database fail the smoke check.

### Operator environment variables

Export these variables in the shell that runs `scripts/deploy.sh` (or keep them in a private, untracked shell profile outside the repository).

| Variable | Required | Default | Purpose (with Vercel example) |
| --- | --- | --- | --- |
| `SOUS_LIVE_URL` | Always | none | Public origin of the live app, for example `https://sous.example.com`. Used to check `/api/version` before deploy, verify `/api/version` after promote, and smoke the live copy after promote. |
| `SOUS_EXPECT_SIGN_IN` | Always | none | Expected deployment mode of the host: `on` (sign-in mode) or `off` (single-kitchen mode). Must match the mode the host runs in; passed to the smoke check as `SMOKE_EXPECT_SIGN_IN`. In `on` mode the smoke check confirms `/kitchen` redirects on the same origin to `/sign-in` with its heading and enabled "Sign in with Google" button, sends `GET /api/auth/get-session` expecting status 200 with JSON `null`, and skips `/kitchen/cookpacks`; in `off` mode it confirms `/kitchen` loads on the same origin without redirecting and opens a book from `/kitchen/cookpacks`. |
| `SOUS_LIVE_WAIT_SECONDS` | No | `60` | Maximum seconds `scripts/deploy.sh` retries `$SOUS_LIVE_URL/api/version` (every 5 seconds) after promotion while waiting for the live address to answer the new commit. |
| `SOUS_HOST_CLI` | No | `vercel` | Hosting CLI executable name or path. |
| `SOUS_HOST_ARGS` | No | empty | Extra whitespace-separated flags passed to the hosting CLI on a single line (newlines are refused), for example `--scope example-team`. Put the host's authentication token in the host's own environment variable (for Vercel, `VERCEL_TOKEN`), never in `SOUS_HOST_ARGS`. |
| `SOUS_HOST_LINK_FILE` | Always | none | Path to the host's project link JSON file (for example `$HOME/.config/sous/vercel-project.json`). Copied into `.vercel/project.json` inside the temporary deploy worktree before staging. |
| `SOUS_RELEASE_REMOTE` | No | `origin` | Git remote fetched before deploy to confirm the target commit is on the shared release branch. |
| `SOUS_RELEASE_BRANCH` | No | `main` | Git branch on `SOUS_RELEASE_REMOTE` that the target commit must be on before deploy. |
| `SOUS_DEPLOY_ENV_FILE` | When migrations are pending | none | Path to a mode-600 `KEY=VALUE` file holding `DATABASE_URL` for the production database (for example `$HOME/.config/sous/deploy.env`). Read as plain text without executing it; only `DATABASE_URL` is extracted, and only its host is ever printed. Must use a direct connection or a session-mode pooler (never a transaction-mode pooler), with the host's TLS parameter (for example `sslmode=require`) when the host requires TLS. `scripts/deploy.sh` passes only host, port, user, password, database name, and `sslmode` from `DATABASE_URL` to `pg_dump` (as `PG*` variables); other URL parameters (such as `sslrootcert` or `channel_binding`) reach `db:migrate`, which receives the full URL, but not `pg_dump`. |
| `SOUS_BACKUP_DIR` | When migrations are pending | none | Directory where `pg_dump` writes pre-migration backups (for example `$HOME/.local/share/sous/backups`). Created with mode `700`. |
| `SOUS_RELEASE_STATE_DIR` | No | `$HOME/.local/state/sous` | Local state directory holding `release-passes.log`, `releases.log`, and the temporary `deploy.lock` folder. Created with mode `700`. |
| `SMOKE_BYPASS_HEADER` | No | none | Optional HTTP header name sent to `/api/version` requests (through a mode-600 temporary file) and passed to `pnpm --dir app e2e:smoke` when deployment protection requires a bypass header (for example `x-vercel-protection-bypass`). Must be paired with `SMOKE_BYPASS_VALUE`. |
| `SMOKE_BYPASS_VALUE` | No | none | Optional secret value for `SMOKE_BYPASS_HEADER`. Never printed by `scripts/deploy.sh` and never passed on a command line. |

Make sure `pg_dump`, `pg_restore`, `curl`, `node`, `pnpm`, `git`, and your hosting CLI are installed on `PATH`, and that you are authenticated with the hosting CLI before running a real deploy.

## Release steps

Run these three steps in order from the repository root, using the commit you intend to ship (for example `HEAD` or a specific SHA).

### 1. Run the release check

```sh
scripts/release-check.sh <commit>
```

This creates a temporary detached worktree of `<commit>`, installs dependencies from the lockfile (prefers the offline cache, though `--prefer-offline` may still use the network on a cache miss), and runs every gate in a clean environment with `CI=1`: `@sous/pack` lint/typecheck/tests, app lint/typecheck/script typecheck, `db:generate` clean check, unit tests, production build with `SOUS_RELEASE_COMMIT=<sha>`, browser E2E tests (`pnpm --dir app e2e`), and visual screenshot tests (`pnpm --dir app e2e:visual`). Setting `CI=1` ensures focused `.only` tests fail the check. It stops at the first failure with no retries. Only when every step passes with zero failures does it append a pass line to `${SOUS_RELEASE_STATE_DIR:-$HOME/.local/state/sous}/release-passes.log`.

### 2. Run a dry run

```sh
scripts/deploy.sh --dry-run <commit>
```

For the very first release (when `releases.log` is empty), include `--first-release <number>`:

```sh
scripts/deploy.sh --dry-run --first-release 1 <commit>
```

A dry run executes every pre-flight check without modifying the database, hosting project, or release logs: required variables, clean checkout check (refusing uncommitted changes to tracked files; untracked files are allowed), deploy lock, pass log lookup, fetching `SOUS_RELEASE_REMOTE`/`SOUS_RELEASE_BRANCH` to confirm the target commit is pushed, live `/api/version` fetch, git ancestor check, append-only and timestamp-ordered migration validation, and `SOUS_DEPLOY_ENV_FILE` parsing (printing only the database host). What a dry run does touch locally: it takes and releases the `deploy.lock` folder in the state directory, and its `git fetch` updates `FETCH_HEAD` and the remote-tracking branch. It prints the backup path, migration command, staging/version/smoke/promote commands, release number, and rollback command, then ends with `dry run: nothing was changed`.

### 3. Deploy

```sh
scripts/deploy.sh <commit>
```

(Or with `--first-release <number>` on the very first release; see Release numbers below.)

A real deploy:

1. Refuses if the current checkout has uncommitted changes to tracked files (untracked files are allowed), then acquires the lock folder (`deploy.lock`) in the state directory so only one deploy runs at a time per state folder (per machine and `SOUS_RELEASE_STATE_DIR`, not across machines).
2. Re-runs all pre-flight checks (pass log, fetching `SOUS_RELEASE_REMOTE`/`SOUS_RELEASE_BRANCH` to confirm the commit is pushed, live commit ancestor check, append-only and increasing-timestamp migrations).
3. Creates a fresh temporary detached worktree of the commit and installs dependencies (prefers the offline cache).
4. If new migrations are pending, runs `pg_dump -Fc --no-owner -n public -n drizzle` with connection parameters passed through `PG*` environment variables into `SOUS_BACKUP_DIR` (refusing to migrate if the dump fails or is empty) and runs `pnpm --dir app db:migrate` in a clean environment with `DATABASE_URL` loaded from a mode-600 temporary file. The backup covers the `public` and `drizzle` schemas only (the app's tables and its migration record), because a managed PostgreSQL host's own schemas may not be readable by the deploy role; anything an operator adds outside those two schemas is not in it. If `db:migrate` fails after the backup, the script prints the backup file's path, reminds you to restore it into a scratch database first (see Backup and restore below), and exits with status 1 without staging.
5. Copies `SOUS_HOST_LINK_FILE` to `.vercel/project.json` in the worktree and stages the build with `--prod --skip-domain --yes --build-env SOUS_RELEASE_COMMIT=<sha>`. `scripts/deploy.sh` reads the staged URL from the command's stdout: if the trimmed stdout parses as JSON (which newer host CLI versions print in non-interactive mode, their default under coding agents), it uses the JSON rules only, reading `deployment.url` (or top-level `url` when there is no `deployment` object) and stopping with nothing promoted if `readyState` (`deployment.readyState`, or top-level `readyState` when there is no `deployment` object) is present with any value other than the string `"READY"` (including `null`). Otherwise it uses the bare form: the last stdout line starting with `https://`, with any trailing carriage return removed. Whichever form supplied the URL, one shared validator refuses percent signs, whitespace, and control characters on the raw text, requires an `https://` host (or a bare hostname in JSON) whose hostname is a DNS name of at least two labels (each 1 to 63 lowercase letters, digits, or hyphens, not starting or ending with a hyphen, total length at most 253, with no trailing dot) and with no credentials (with or without a password), port, query, fragment, or path other than an optional single trailing `/` (checked on the raw text before URL normalization so dot segments such as `/a/..` are refused), and normalizes it to `https://<hostname>` with no trailing slash for the staged version check, smoke check, promote, and `releases.log`.
6. Checks `<staged-url>/api/version` to confirm the staged copy answers the target commit, then runs `pnpm --dir app e2e:smoke` against the staged URL with `SMOKE_EXPECT_SIGN_IN=$SOUS_EXPECT_SIGN_IN`. If either check fails, the deploy stops and nothing is promoted. Note that if this run had pending migrations, the database is already migrated while the old code remains live (safe because migrations are additive), and re-running `scripts/deploy.sh` after fixing the issue is safe (already-applied migrations are skipped, and a fresh backup is taken).
7. Promotes the staged deployment. If the promote command itself fails, `scripts/deploy.sh` prints that the outcome is unknown, reminds you to check what the live address answers (and notes if this run migrated the database), prints the rollback command, and exits with status 1 without recording a release. After a successful promote, it polls `$SOUS_LIVE_URL/api/version` every 5 seconds for up to `SOUS_LIVE_WAIT_SECONDS` until the live copy answers the target commit, then runs `pnpm --dir app e2e:smoke` against `SOUS_LIVE_URL`. If the live copy never answers the target commit or live smoke fails, the script prints the rollback command and exits with status 1 without recording a release.
8. Appends `<number> <sha> <staged url> <UTC time>` to `releases.log` and prints the rollback command.

### Stale lock after a killed run

If a deploy process is killed abruptly (for example `kill -9` or a power loss), `deploy.lock` may remain in the state directory and block later runs. Remove the lock folder (`rmdir "${SOUS_RELEASE_STATE_DIR:-$HOME/.local/state/sous}/deploy.lock"`) only when you are sure no `scripts/deploy.sh` process is running for that state folder, and only after checking what `$SOUS_LIVE_URL/api/version` currently answers.

## Migrations

Migrations under `app/drizzle/migrations/` are strictly **append-only** and **increasing in timestamp**:

- Never modify, rename, or delete an existing `.sql` migration file or snapshot file.
- Never edit or remove existing entries in `app/drizzle/migrations/meta/_journal.json`; new migrations may only append entries.
- Every new entry's `when` timestamp in `app/drizzle/migrations/meta/_journal.json` must be strictly greater than the largest `when` among the live entries and strictly increasing among new entries, because Drizzle only applies migrations whose `when` is greater than the last applied one.
- `scripts/deploy.sh` refuses any commit that violates these rules.

Every migration must also leave the **previous release** working against the new schema. Follow expand-and-contract across separate releases:

1. In release N, add new tables, nullable columns, or columns with defaults, and ship application code that works with them.
2. Only in a later release N+1 (once release N is settled and you will not roll back past it), drop old columns or tighten constraints that release N-1 still depended on.

This rule is required because rolling back the hosted app switches application code only and does not undo database migrations.

## Rollback

At the end of every deploy (and if promote, live `/api/version` verification, or the post-promotion live smoke check fails), `scripts/deploy.sh` looks up the most recent line in `releases.log` whose commit matches the live commit read at the start of the run and prints the rollback command for that URL:

```sh
vercel rollback <live-release-staged-url> --yes
```

(Using `$SOUS_HOST_CLI` and `$SOUS_HOST_ARGS` if configured.) If no line in `releases.log` matches the live commit (or on a first release), `scripts/deploy.sh` states that and reminds you to roll back from the host's own deployment list.

- **What rollback undoes:** it switches live traffic back to the previous release's staged application build.
- **What rollback does not undo:** it does not reverse database migrations or revert rows written after the release went live. Because migrations leave the previous release working on the new schema, rolling back the app code is safe without touching the database.

## Backup and restore

Whenever a deploy includes new migrations, `scripts/deploy.sh` takes a PostgreSQL custom-format dump before running `db:migrate`, passing connection details through `PG*` environment variables (`PGHOST`, `PGPORT`, `PGUSER`, `PGPASSWORD`, `PGDATABASE`, and `PGSSLMODE` when present) so the database password never appears in any process's arguments:

```sh
pg_dump -Fc --no-owner -n public -n drizzle -f "$SOUS_BACKUP_DIR/sous-<sha short>-<UTC timestamp>.dump"
```

The backup covers the `public` and `drizzle` schemas only (the app's tables and its migration record). Anything an operator adds outside those two schemas is not in it. Scope is limited to these two schemas because a managed PostgreSQL host keeps its own schemas in the same database, and those schemas may not be readable by the deploy role. The app's tables enable row-level security without `FORCE` and without policies, so the role that owns them (the role in `DATABASE_URL`) still dumps every row.

If `pg_dump` fails or writes an empty file, the deploy stops before running any migration. If `db:migrate` fails after the backup succeeds, `scripts/deploy.sh` prints the backup file's path, reminds you to restore it into a scratch database first, and exits with status 1 without staging.

The `DATABASE_URL` in `SOUS_DEPLOY_ENV_FILE` must use a direct connection or a connection pooler in session mode, never a transaction-mode pooler, because `pg_dump` and Drizzle migrations rely on session state. Include the host's TLS parameter (for example `sslmode=require`) when the host requires TLS. Note that `scripts/deploy.sh` passes only host, port, user, password, database name, and `sslmode` from `DATABASE_URL` to `pg_dump` (as `PG*` variables); other connection parameters in the URL (for example `sslrootcert` or `channel_binding`) reach `db:migrate`, which gets the full URL, but not `pg_dump`. The local `pg_dump` binary's major version must also be the same as or newer than the database server's major version, or `pg_dump` will refuse to dump the database.

Dumps in `SOUS_BACKUP_DIR` are full plaintext copies of user data. Keep the directory private (mode `700`) and delete old dumps once they are no longer needed.

Restoring a dump requires a PostgreSQL server you can reach (a local PostgreSQL server or a scratch database created at your database host). Always restore into a **scratch database** first and check its contents before touching production:

```sh
pg_restore --clean --if-exists --no-owner --no-privileges -d "<scratch-database-url-or-name>" "$SOUS_BACKUP_DIR/sous-<sha short>-<UTC timestamp>.dump"
```

Because the dump selects `-n public`, it includes both `CREATE SCHEMA public;` and `COMMENT ON SCHEMA public IS 'standard public schema';`, while `public` already exists in a fresh PostgreSQL database:

- **As the database owner with `--clean --if-exists`:** `pg_restore` drops and recreates `public`, applies its comment, creates `drizzle`, restores all tables, rows, and the `drizzle.__drizzle_migrations` record, and exits `0`.
- **As the database owner without `--clean --if-exists`:** `pg_restore` reports 1 ignored error (`ERROR: schema "public" already exists` on `CREATE SCHEMA public;`) and exits `1`, while `COMMENT ON SCHEMA public` succeeds and all `public` and `drizzle` tables, rows, and migration records restore.
- **As a role that does not own `public` (granted `USAGE, CREATE` on `public` and `CREATE` on the database):** omitting `--clean --if-exists` reports 2 ignored errors (`ERROR: schema "public" already exists` on `CREATE SCHEMA public;` and `ERROR: must be owner of schema public` on `COMMENT ON SCHEMA public IS 'standard public schema';`) and exits `1`. Keeping `--clean --if-exists` adds a third error (`ERROR: must be owner of schema public` on `DROP SCHEMA IF EXISTS public;`, 3 ignored errors total, exit `1`). In both cases all `public` tables, rows, and the `drizzle` migration record still restore.

After verifying the scratch copy, recover production by restoring the dump into a **new database** at the host and pointing the app's `DATABASE_URL` at that new database (keeping the damaged database intact for inspection), or by using the host's own point-in-time recovery if it provides one. Never run `pg_restore` over the live database.

Note that scheduled nightly backups are not part of this release process yet; configure automated backups separately through your PostgreSQL host.

## Release numbers

Releases are numbered sequentially in `${SOUS_RELEASE_STATE_DIR:-$HOME/.local/state/sous}/releases.log`, one line per release:

```text
<number> <sha> <staged url> <UTC ISO-8601 timestamp>
```

- `--first-release <number>` is only for the very first release, on the machine that will keep the release log, when no copy is live yet or the live copy was not deployed by `scripts/deploy.sh`. Use `1` for a brand-new deployment, or pick the next number if continuing from an older release sequence.
- Never use `--first-release` to get past a refusal on a machine whose `releases.log` is merely missing or when the live site is unreachable or answering `null` unexpectedly.
- On every subsequent release, omit `--first-release`; `scripts/deploy.sh` increments the last recorded release number by 1.
- Passing `--first-release` when `releases.log` is non-empty is refused, and omitting `--first-release` when `releases.log` is empty is refused.

## Known limits

- **Wrong or unreachable `DATABASE_URL` in sign-in mode:** Start-up checks do not validate `DATABASE_URL`, and no unauthenticated read-only request in sign-in mode queries the database. With `SOUS_EXPECT_SIGN_IN=on`, `GET /api/auth/get-session` catches a missing `DATABASE_URL` (the auth handler answers 500), but a `DATABASE_URL` that is present and points at a wrong or unreachable database is not caught by the `on` smoke check and would fail on the first sign-in.
- **Staged copy shares the production database:** There is no separate staging database yet, so any pending migration is applied to the production database before the staged build is smoked. The append-only additive migration rule and the pre-migration `pg_dump` backup are the safeguards until a staging database exists.
- **One deploy at a time per state folder:** The `deploy.lock` folder prevents concurrent deploys only for the same machine and `SOUS_RELEASE_STATE_DIR`, not across separate machines.
- **Local Node version vs CI:** `scripts/release-check.sh` runs on whatever Node version is installed on the operator's machine, while CI runs on Node 24.
- **macOS required for screenshots:** Visual screenshot checks only run on macOS. On any other operating system, `scripts/release-check.sh` stops with a plain message and records no pass.
- **Running a release check beside another copy of the browser suite:** By default, the browser test harness uses app port `4131` (`E2E_APP_PORT`), PostgreSQL port `55731` (`E2E_PG_PORT`), and Docker container `rails-pg` (`E2E_PG_CONTAINER`). Setting those three environment variables lets `scripts/release-check.sh` run beside another release check or copy of the browser suite, as long as two concurrent copies do not share any of the three values.
- **Hosting commands not yet run against a live project:** The hosting CLI invocations (`deploy --prod --skip-domain --yes --build-env ...`, `promote`, and `rollback`) follow the host's documented command line, but they have not been exercised against a real hosted project yet. Watch the first real deploy step by step and verify each command's output.
- **First deployment and `--skip-domain` on Vercel:** A project's very first deployment on Vercel is always a production deployment, and it is not documented whether `--skip-domain` holds for that first one. If the host assigns the live domain during staging and the `promote` step then fails, `scripts/deploy.sh` exits with status 1 saying that promote failed and its outcome is unknown, without writing to `releases.log`. To recover, run `scripts/deploy.sh` again with the same `--first-release` number and commit: `releases.log` is still empty so `--first-release` is still accepted, the live `/api/version` check sees the target commit (which passes the ancestry check against itself and yields no pending migrations), and the run stages a fresh copy, verifies and smokes it, promotes it, verifies and smokes the live URL, and records the release in `releases.log`.
