#!/usr/bin/env bash
{ set +x; } 2>/dev/null
set -euo pipefail

usage() {
  printf 'Usage: %s [--dry-run] [--help]\n' "$0"
}

print_help() {
  usage
  cat <<'EOF'

Take a PostgreSQL custom-format backup of the public and drizzle schemas and
prune older sous-*.dump files past the retention window.

Options:
  --dry-run   Validate configuration, print the backup plan, and list expired
              backups without creating files or running pg_dump.
  -h, --help  Show this help message and exit.

Environment variables:
  SOUS_DEPLOY_ENV_FILE   Required. Path to a mode-600 KEY=VALUE file holding
                         DATABASE_URL (parsed as plain text, never executed).
  SOUS_BACKUP_DIR        Required. Directory where backups are stored (created
                         with mode 700).
  SOUS_BACKUP_KEEP_DAYS  Optional. Positive integer retention period in days
                         (default: 14).
EOF
}

dry_run=0

while [ "$#" -gt 0 ]; do
  case "$1" in
    --dry-run)
      dry_run=1
      shift
      ;;
    -h|--help)
      print_help
      exit 0
      ;;
    --)
      shift
      break
      ;;
    -*)
      printf 'backup: unknown option: %s\n' "$1" >&2
      usage >&2
      exit 1
      ;;
    *)
      printf 'backup: unexpected argument: %s\n' "$1" >&2
      usage >&2
      exit 1
      ;;
  esac
done

if [ "$#" -gt 0 ]; then
  printf 'backup: unexpected argument: %s\n' "$1" >&2
  usage >&2
  exit 1
fi

# Validate required variables upfront and report all missing ones together.
missing_vars=()
if [ -z "${SOUS_DEPLOY_ENV_FILE:-}" ]; then
  missing_vars+=("SOUS_DEPLOY_ENV_FILE")
fi
if [ -z "${SOUS_BACKUP_DIR:-}" ]; then
  missing_vars+=("SOUS_BACKUP_DIR")
fi
if [ "${#missing_vars[@]}" -gt 0 ]; then
  printf 'backup: missing required environment variable(s): %s\n' "${missing_vars[*]}" >&2
  exit 1
fi

keep_days="${SOUS_BACKUP_KEEP_DAYS:-14}"
case "${keep_days}" in
  ""|*[!0-9]*|0*)
    printf 'backup: SOUS_BACKUP_KEEP_DAYS must be a positive integer, got "%s"\n' "${keep_days}" >&2
    exit 1
    ;;
esac

if [ ! -f "${SOUS_DEPLOY_ENV_FILE}" ] || [ ! -r "${SOUS_DEPLOY_ENV_FILE}" ]; then
  printf 'backup: SOUS_DEPLOY_ENV_FILE does not exist or is not readable: %s\n' "${SOUS_DEPLOY_ENV_FILE}" >&2
  exit 1
fi

if [ -e "${SOUS_BACKUP_DIR}" ] && [ ! -d "${SOUS_BACKUP_DIR}" ]; then
  printf 'backup: SOUS_BACKUP_DIR exists and is not a directory: %s\n' "${SOUS_BACKUP_DIR}" >&2
  exit 1
fi

# Read DATABASE_URL from SOUS_DEPLOY_ENV_FILE without executing it.
read_database_env_info() {
  local env_file="$1"
  local mode="$2"
  node -e '
const fs = require("node:fs");
const [envPath, mode] = process.argv.slice(1);
const content = fs.readFileSync(envPath, "utf8");
let dbUrl = null;
for (const rawLine of content.split(/\r?\n/)) {
  const trimmed = rawLine.trim();
  if (!trimmed || trimmed.startsWith("#")) continue;
  const match = /^([A-Za-z_][A-Za-z0-9_]*)=(.*)$/.exec(trimmed);
  if (!match) continue;
  if (match[1] !== "DATABASE_URL") continue;
  let value = match[2].trim();
  if (
    (value.startsWith("\"") && value.endsWith("\"") && value.length >= 2) ||
    (value.startsWith("\x27") && value.endsWith("\x27") && value.length >= 2)
  ) {
    value = value.slice(1, -1);
  }
  dbUrl = value;
}
function fail(reason) {
  console.error(`DATABASE_URL in ${envPath}: ${reason}`);
  process.exit(1);
}
if (!dbUrl) {
  fail("not found");
}
if (/[\x00-\x1f\x7f\s]/.test(dbUrl)) {
  fail("contains whitespace or control characters");
}
if (dbUrl.includes("#")) {
  fail("contains a # fragment (percent-encode # as %23 if it is part of a password)");
}
let parsed;
try {
  parsed = new URL(dbUrl);
} catch {
  fail("not a valid URL");
}
if (parsed.hash !== "") {
  fail("contains a # fragment");
}
if ((parsed.protocol !== "postgres:" && parsed.protocol !== "postgresql:") || !parsed.hostname) {
  fail("must be a postgres:// or postgresql:// URL with a host");
}
if (!parsed.pathname || parsed.pathname === "/") {
  fail("missing database name in path");
}
if (parsed.pathname.slice(1).includes("/")) {
  fail("database path contains unexpected slashes");
}
function safeDecode(part, label) {
  let decoded;
  try {
    decoded = decodeURIComponent(part);
  } catch {
    fail(`invalid percent-encoding in ${label}`);
  }
  if (/[\x00-\x1f\x7f]/.test(decoded)) {
    fail(`${label} contains control characters`);
  }
  return decoded;
}
const pgHost = parsed.hostname.replace(/^\[|\]$/g, "");
const pgPort = parsed.port;
const pgUser = safeDecode(parsed.username, "username");
const pgPassword = safeDecode(parsed.password, "password");
const pgDatabase = safeDecode(parsed.pathname.slice(1), "database name");
if (!pgDatabase) {
  fail("missing database name in path");
}
const sslmodes = parsed.searchParams.getAll("sslmode");
if (sslmodes.length > 1) {
  fail("multiple sslmode query parameters");
}
const pgSslmode = sslmodes.length === 1 ? sslmodes[0] : "";
if (/[\x00-\x1f\x7f]/.test(pgSslmode)) {
  fail("sslmode contains control characters");
}
if (mode === "host") {
  process.stdout.write(parsed.host);
} else if (mode === "url") {
  process.stdout.write(`${dbUrl}\n`);
} else if (mode === "pg-env") {
  for (const v of [pgHost, pgPort, pgUser, pgPassword, pgDatabase, pgSslmode]) {
    process.stdout.write(`${v}\0`);
  }
} else {
  process.exit(1);
}
' "${env_file}" "${mode}"
}

run_retention() {
  local mode="$1"
  local dir="$2"
  local keep="$3"
  local current_path="$4"
  node -e '
const fs = require("node:fs");
const path = require("node:path");

const [mode, dir, keepRaw, currentPath] = process.argv.slice(1);
const keepDays = Number(keepRaw);
const cutoffMs = Date.now() - keepDays * 86400 * 1000;
const currentBase = currentPath ? path.basename(currentPath) : "";

if (!fs.existsSync(dir)) {
  if (mode === "dry-run") {
    console.log(`Would prune 0 old backup(s) older than ${keepDays} day(s) (backup directory does not exist yet)`);
    process.exit(0);
  }
  console.error(`backup: SOUS_BACKUP_DIR does not exist: ${dir}`);
  process.exit(1);
}

const entries = fs.readdirSync(dir);
const expired = [];
for (const entry of entries.sort()) {
  if (!entry.startsWith("sous-") || !entry.endsWith(".dump")) continue;
  if (currentBase && entry === currentBase) continue;
  const fullPath = path.join(dir, entry);
  const st = fs.lstatSync(fullPath);
  if (!st.isFile()) continue;
  if (st.mtimeMs < cutoffMs) {
    expired.push(fullPath);
  }
}

if (mode === "dry-run") {
  console.log(`Would prune ${expired.length} old backup(s) older than ${keepDays} day(s)${expired.length > 0 ? ":" : ""}`);
  for (const p of expired) {
    console.log(`  ${p}`);
  }
  process.exit(0);
}

for (const p of expired) {
  fs.unlinkSync(p);
}
console.log(`Pruned ${expired.length} old backup(s) older than ${keepDays} day(s)`);
' "${mode}" "${dir}" "${keep}" "${current_path}"
}

if ! db_host="$(read_database_env_info "${SOUS_DEPLOY_ENV_FILE}" host)"; then
  exit 1
fi

backup_ts="$(date -u "+%Y%m%dT%H%M%SZ")"
backup_dir="${SOUS_BACKUP_DIR%/}"
if [ -z "${backup_dir}" ]; then
  backup_dir="/"
fi
backup_path="${backup_dir}/sous-backup-${backup_ts}.dump"
if [ -e "${backup_path}" ]; then
  backup_path="${backup_dir}/sous-backup-${backup_ts}-$$.dump"
fi
suffix=1
while [ -e "${backup_path}" ]; do
  backup_path="${backup_dir}/sous-backup-${backup_ts}-$$-${suffix}.dump"
  suffix=$((suffix + 1))
done

if [ "${dry_run}" -eq 1 ]; then
  printf 'Database host: %s (from %s)\n' "${db_host}" "${SOUS_DEPLOY_ENV_FILE}"
  printf 'Backup directory: %s\n' "${backup_dir}"
  printf 'Target backup path: %s\n' "${backup_path}"
  printf 'Retention days: %s\n' "${keep_days}"
  printf 'Would run: pg_dump -Fc --no-owner -n public -n drizzle -f %s\n' "${backup_path}"
  run_retention "dry-run" "${backup_dir}" "${keep_days}" ""
  printf 'dry run: nothing was changed\n'
  exit 0
fi

tmp_base="${TMPDIR:-/tmp}"
tmp_dir=""
pg_env_file=""
backup_in_progress=0

cleanup() {
  if [ "${backup_in_progress}" -eq 1 ] && [ -n "${backup_path}" ] && [ -f "${backup_path}" ]; then
    rm -f "${backup_path}"
  fi
  if [ -n "${pg_env_file}" ] && [ -f "${pg_env_file}" ]; then
    rm -f "${pg_env_file}"
  fi
  if [ -n "${tmp_dir}" ] && [ -d "${tmp_dir}" ]; then
    rm -rf "${tmp_dir}"
  fi
}

trap cleanup EXIT

tmp_dir="$(umask 077 && mktemp -d "${tmp_base%/}/sous-backup.XXXXXX")"
mkdir -p -m 700 "${backup_dir}"
chmod 700 "${backup_dir}"

pg_env_file="$(umask 077 && mktemp "${tmp_dir}/pg-env.XXXXXX")"
chmod 600 "${pg_env_file}"
if ! read_database_env_info "${SOUS_DEPLOY_ENV_FILE}" pg-env > "${pg_env_file}"; then
  rm -f "${pg_env_file}"
  pg_env_file=""
  exit 1
fi

printf 'Backing up database at %s to %s\n' "${db_host}" "${backup_path}"
backup_in_progress=1
pg_dump_ok=0
if (
  unset PGHOST PGPORT PGUSER PGPASSWORD PGDATABASE PGSSLMODE
  {
    IFS= read -r -d '' pg_host
    IFS= read -r -d '' pg_port
    IFS= read -r -d '' pg_user
    IFS= read -r -d '' pg_password
    IFS= read -r -d '' pg_database
    IFS= read -r -d '' pg_sslmode
  } < "${pg_env_file}"
  if [ -n "${pg_host}" ]; then export PGHOST="${pg_host}"; fi
  if [ -n "${pg_port}" ]; then export PGPORT="${pg_port}"; fi
  if [ -n "${pg_user}" ]; then export PGUSER="${pg_user}"; fi
  if [ -n "${pg_password}" ]; then export PGPASSWORD="${pg_password}"; fi
  if [ -n "${pg_database}" ]; then export PGDATABASE="${pg_database}"; fi
  if [ -n "${pg_sslmode}" ]; then export PGSSLMODE="${pg_sslmode}"; fi
  exec pg_dump -Fc --no-owner -n public -n drizzle -f "${backup_path}"
); then
  pg_dump_ok=1
fi
rm -f "${pg_env_file}"
pg_env_file=""

if [ "${pg_dump_ok}" -ne 1 ]; then
  rm -f "${backup_path}"
  backup_in_progress=0
  printf 'backup: pg_dump failed; existing backups were left untouched\n' >&2
  exit 1
fi
if [ ! -s "${backup_path}" ]; then
  rm -f "${backup_path}"
  backup_in_progress=0
  printf 'backup: backup file is empty (%s); existing backups were left untouched\n' "${backup_path}" >&2
  exit 1
fi
backup_in_progress=0

run_retention "prune" "${backup_dir}" "${keep_days}" "${backup_path}"
printf 'Backup complete: %s\n' "${backup_path}"
