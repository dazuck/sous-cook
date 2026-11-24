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

### Operator environment variables

Export these variables in the shell that runs `scripts/deploy.sh` (or keep them in a private, untracked shell profile outside the repository).

| Variable | Required | Default | Purpose (with Vercel example) |
| --- | --- | --- | --- |
| `SOUS_LIVE_URL` | Always | none | Public origin of the live app, for example `https://sous.example.com`. Used to check `/api/version` before deploy, verify `/api/version` after promote, and smoke the live copy after promote. |
| `SOUS_LIVE_WAIT_SECONDS` | No | `60` | Maximum seconds `scripts/deploy.sh` retries `$SOUS_LIVE_URL/api/version` (every 5 seconds) after promotion while waiting for the live address to answer the new commit. |
| `SOUS_HOST_CLI` | No | `vercel` | Hosting CLI executable name or path. |
| `SOUS_HOST_ARGS` | No | empty | Extra whitespace-separated flags passed to the hosting CLI on a single line (newlines are refused), for example `--scope example-team`. Put the host's authentication token in the host's own environment variable (for Vercel, `VERCEL_TOKEN`), never in `SOUS_HOST_ARGS`. |
| `SOUS_HOST_LINK_FILE` | Always | none | Path to the host's project link JSON file (for example `$HOME/.config/sous/vercel-project.json`). Copied into `.vercel/project.json` inside the temporary deploy worktree before staging. |
| `SOUS_RELEASE_REMOTE` | No | `origin` | Git remote fetched before deploy to confirm the target commit is on the shared release branch. |
| `SOUS_RELEASE_BRANCH` | No | `main` | Git branch on `SOUS_RELEASE_REMOTE` that the target commit must be on before deploy. |
| `SOUS_DEPLOY_ENV_FILE` | When migrations are pending | none | Path to a mode-600 `KEY=VALUE` file holding `DATABASE_URL` for the production database (for example `$HOME/.config/sous/deploy.env`). Read as plain text without executing it; only `DATABASE_URL` is extracted, and only its host is ever printed. |
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
4. If new migrations are pending, runs `pg_dump -Fc --no-owner` with connection parameters passed through `PG*` environment variables into `SOUS_BACKUP_DIR` (refusing to migrate if the dump fails or is empty) and runs `pnpm --dir app db:migrate` in a clean environment with `DATABASE_URL` loaded from a mode-600 temporary file. If `db:migrate` fails after the backup, the script prints the backup file's path, reminds you to restore it into a scratch database first (see Backup and restore below), and exits with status 1 without staging.
5. Copies `SOUS_HOST_LINK_FILE` to `.vercel/project.json` in the worktree and stages the build with `--prod --skip-domain --yes --build-env SOUS_RELEASE_COMMIT=<sha>`.
6. Checks `<staged-url>/api/version` to confirm the staged copy answers the target commit, then runs `pnpm --dir app e2e:smoke` against the staged URL. If either check fails, the deploy stops and nothing is promoted. Note that if this run had pending migrations, the database is already migrated while the old code remains live (safe because migrations are additive), and re-running `scripts/deploy.sh` after fixing the issue is safe (already-applied migrations are skipped, and a fresh backup is taken).
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
pg_dump -Fc --no-owner -f "$SOUS_BACKUP_DIR/sous-<sha short>-<UTC timestamp>.dump"
```

If `pg_dump` fails or writes an empty file, the deploy stops before running any migration. If `db:migrate` fails after the backup succeeds, `scripts/deploy.sh` prints the backup file's path, reminds you to restore it into a scratch database first, and exits with status 1 without staging.

Dumps in `SOUS_BACKUP_DIR` are full plaintext copies of user data. Keep the directory private (mode `700`) and delete old dumps once they are no longer needed.

Restoring a dump requires a PostgreSQL server you can reach (a local PostgreSQL server or a scratch database created at your database host). Always restore into a **scratch database** first and check its contents before touching production:

```sh
pg_restore --no-owner --no-privileges -d "<scratch-database-url-or-name>" "$SOUS_BACKUP_DIR/sous-<sha short>-<UTC timestamp>.dump"
```

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

- **Staged copy shares the production database:** There is no separate staging database yet, so any pending migration is applied to the production database before the staged build is smoked. The append-only additive migration rule and the pre-migration `pg_dump` backup are the safeguards until a staging database exists.
- **One deploy at a time per state folder:** The `deploy.lock` folder prevents concurrent deploys only for the same machine and `SOUS_RELEASE_STATE_DIR`, not across separate machines.
- **Local Node version vs CI:** `scripts/release-check.sh` runs on whatever Node version is installed on the operator's machine, while CI runs on Node 24.
- **macOS required for screenshots:** Visual screenshot checks only run on macOS. On any other operating system, `scripts/release-check.sh` stops with a plain message and records no pass.
- **Running a release check beside another copy of the browser suite:** By default, the browser test harness uses app port `4131` (`E2E_APP_PORT`), PostgreSQL port `55731` (`E2E_PG_PORT`), and Docker container `rails-pg` (`E2E_PG_CONTAINER`). Setting those three environment variables lets `scripts/release-check.sh` run beside another release check or copy of the browser suite, as long as two concurrent copies do not share any of the three values.
- **Hosting commands not yet run against a live project:** The hosting CLI invocations (`deploy --prod --skip-domain --yes --build-env ...`, `promote`, and `rollback`) follow the host's documented command line, but they have not been exercised against a real hosted project yet. Watch the first real deploy step by step and verify each command's output.
