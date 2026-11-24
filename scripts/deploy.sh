#!/usr/bin/env bash
{ set +x; } 2>/dev/null
set -euo pipefail

usage() {
  printf 'Usage: %s [--dry-run] [--first-release <number>] <commit>\n' "$0" >&2
}

dry_run=0
first_release=""
commit_arg=""

while [ "$#" -gt 0 ]; do
  case "$1" in
    --dry-run)
      dry_run=1
      shift
      ;;
    --first-release)
      if [ "$#" -lt 2 ]; then
        printf 'deploy: --first-release requires a positive integer\n' >&2
        usage
        exit 1
      fi
      first_release="$2"
      shift 2
      ;;
    --first-release=*)
      first_release="${1#--first-release=}"
      shift
      ;;
    --)
      shift
      break
      ;;
    -*)
      printf 'deploy: unknown option: %s\n' "$1" >&2
      usage
      exit 1
      ;;
    *)
      if [ -n "${commit_arg}" ]; then
        printf 'deploy: unexpected extra argument: %s\n' "$1" >&2
        usage
        exit 1
      fi
      commit_arg="$1"
      shift
      ;;
  esac
done

while [ "$#" -gt 0 ]; do
  if [ -n "${commit_arg}" ]; then
    printf 'deploy: unexpected extra argument: %s\n' "$1" >&2
    usage
    exit 1
  fi
  commit_arg="$1"
  shift
done

if [ -z "${commit_arg}" ]; then
  usage
  exit 1
fi

if [ -n "${first_release}" ]; then
  case "${first_release}" in
    *[!0-9]*|0*)
      printf 'deploy: --first-release must be a positive integer, got "%s"\n' "${first_release}" >&2
      exit 1
      ;;
  esac
fi

# Validate required variables upfront and report all missing ones together.
missing_vars=()
if [ -z "${SOUS_LIVE_URL:-}" ]; then
  missing_vars+=("SOUS_LIVE_URL")
fi
if [ -z "${SOUS_HOST_LINK_FILE:-}" ]; then
  missing_vars+=("SOUS_HOST_LINK_FILE")
fi
if [ -z "${SOUS_EXPECT_SIGN_IN+x}" ]; then
  missing_vars+=("SOUS_EXPECT_SIGN_IN")
fi
if [ "${#missing_vars[@]}" -gt 0 ]; then
  printf 'deploy: missing required environment variable(s): %s\n' "${missing_vars[*]}" >&2
  exit 1
fi

case "${SOUS_EXPECT_SIGN_IN}" in
  on|off)
    ;;
  *)
    printf 'deploy: SOUS_EXPECT_SIGN_IN must be "on" or "off", got "%s"\n' "${SOUS_EXPECT_SIGN_IN}" >&2
    exit 1
    ;;
esac

if [ -n "${SMOKE_BYPASS_HEADER:-}" ] && [ -z "${SMOKE_BYPASS_VALUE:-}" ]; then
  printf 'deploy: SMOKE_BYPASS_HEADER is set without SMOKE_BYPASS_VALUE\n' >&2
  exit 1
fi
if [ -z "${SMOKE_BYPASS_HEADER:-}" ] && [ -n "${SMOKE_BYPASS_VALUE:-}" ]; then
  printf 'deploy: SMOKE_BYPASS_VALUE is set without SMOKE_BYPASS_HEADER\n' >&2
  exit 1
fi

nl=$'\n'
cr=$'\r'
if [ -n "${SMOKE_BYPASS_HEADER:-}" ]; then
  case "${SMOKE_BYPASS_HEADER}${SMOKE_BYPASS_VALUE}" in
    *"${nl}"*|*"${cr}"*)
      printf 'deploy: SMOKE_BYPASS_HEADER and SMOKE_BYPASS_VALUE must not contain newlines\n' >&2
      exit 1
      ;;
  esac
fi

live_wait_seconds="${SOUS_LIVE_WAIT_SECONDS:-60}"
case "${live_wait_seconds}" in
  ""|*[!0-9]*)
    printf 'deploy: SOUS_LIVE_WAIT_SECONDS must be a non-negative integer, got "%s"\n' "${live_wait_seconds}" >&2
    exit 1
    ;;
esac

live_url="${SOUS_LIVE_URL%/}"
case "${live_url}" in
  http://*|https://*)
    ;;
  *)
    printf 'deploy: SOUS_LIVE_URL must start with http:// or https://\n' >&2
    exit 1
    ;;
esac

if [ ! -f "${SOUS_HOST_LINK_FILE}" ] || [ ! -r "${SOUS_HOST_LINK_FILE}" ]; then
  printf 'deploy: SOUS_HOST_LINK_FILE does not exist or is not readable: %s\n' "${SOUS_HOST_LINK_FILE}" >&2
  exit 1
fi

repo_root="$(git rev-parse --show-toplevel 2>/dev/null || true)"
if [ -z "${repo_root}" ]; then
  printf 'deploy: must be run inside a git repository\n' >&2
  exit 1
fi

# Require a clean working tree (tracked files only; untracked files are allowed).
dirty_status="$(git -C "${repo_root}" status --porcelain --untracked-files=no)"
if [ -n "${dirty_status}" ]; then
  printf 'deploy: the working tree has uncommitted changes to tracked files; commit or stash them first\n' >&2
  exit 1
fi

host_cli="${SOUS_HOST_CLI:-vercel}"
host_args=()
if [ -n "${SOUS_HOST_ARGS:-}" ]; then
  case "${SOUS_HOST_ARGS}" in
    *"${nl}"*|*"${cr}"*)
      printf 'deploy: SOUS_HOST_ARGS must be a single line (newlines are not allowed)\n' >&2
      exit 1
      ;;
  esac
  set -f
  read -r -a host_args <<< "${SOUS_HOST_ARGS}"
  set +f
fi

state_dir="${SOUS_RELEASE_STATE_DIR:-${HOME}/.local/state/sous}"
pass_log="${state_dir}/release-passes.log"
releases_log="${state_dir}/releases.log"
lock_dir="${state_dir}/deploy.lock"

tmp_base="${TMPDIR:-/tmp}"
tmp_dir=""
bypass_header_file=""
pg_env_file=""
db_url_file=""
worktree_dir=""
worktree_added=0
lock_acquired=0

cleanup() {
  if [ "${worktree_added}" -eq 1 ]; then
    git -C "${repo_root}" worktree remove --force "${worktree_dir}" >/dev/null 2>&1 || true
  fi
  if [ -n "${bypass_header_file}" ] && [ -f "${bypass_header_file}" ]; then
    rm -f "${bypass_header_file}"
  fi
  if [ -n "${pg_env_file}" ] && [ -f "${pg_env_file}" ]; then
    rm -f "${pg_env_file}"
  fi
  if [ -n "${db_url_file}" ] && [ -f "${db_url_file}" ]; then
    rm -f "${db_url_file}"
  fi
  if [ -n "${tmp_dir}" ] && [ -d "${tmp_dir}" ]; then
    rm -rf "${tmp_dir}"
  fi
  if [ "${lock_acquired}" -eq 1 ]; then
    rmdir "${lock_dir}" >/dev/null 2>&1 || true
  fi
}

trap cleanup EXIT

# Only one deploy runs at a time.
if [ -e "${lock_dir}" ]; then
  printf 'deploy: lock folder already exists: %s\n' "${lock_dir}" >&2
  exit 1
fi
if [ "${dry_run}" -eq 0 ]; then
  mkdir -p -m 700 "${state_dir}"
  chmod 700 "${state_dir}"
fi
if [ -d "${state_dir}" ]; then
  if ! mkdir "${lock_dir}" 2>/dev/null; then
    printf 'deploy: lock folder already exists: %s\n' "${lock_dir}" >&2
    exit 1
  fi
  lock_acquired=1
fi

# Step 1: resolve commit and confirm it has a recorded release-check pass.
sha="$(git -C "${repo_root}" rev-parse --verify --quiet "${commit_arg}^{commit}" || true)"
if [ -z "${sha}" ]; then
  printf 'deploy: unknown commit: %s\n' "${commit_arg}" >&2
  exit 1
fi
sha_short="${sha:0:7}"

has_pass=0
if [ -f "${pass_log}" ]; then
  if awk -v target="${sha}" '$1 == target { found = 1; exit } END { exit (found ? 0 : 1) }' "${pass_log}"; then
    has_pass=1
  fi
fi
if [ "${has_pass}" -ne 1 ]; then
  printf 'deploy: no recorded release check for %s; run scripts/release-check.sh %s\n' "${sha}" "${sha}" >&2
  exit 1
fi

# Confirm the commit is on the shared release branch.
release_remote="${SOUS_RELEASE_REMOTE:-origin}"
release_branch="${SOUS_RELEASE_BRANCH:-main}"
if ! git -C "${repo_root}" fetch --quiet "${release_remote}" "${release_branch}"; then
  printf 'deploy: failed to fetch %s/%s; check the remote and network\n' "${release_remote}" "${release_branch}" >&2
  exit 1
fi
if ! git -C "${repo_root}" merge-base --is-ancestor "${sha}" FETCH_HEAD 2>/dev/null; then
  printf 'deploy: %s is not on %s/%s; push it first\n' "${sha}" "${release_remote}" "${release_branch}" >&2
  exit 1
fi

# Inspect releases.log before checking live /api/version.
last_release_line=""
if [ -f "${releases_log}" ]; then
  last_release_line="$(awk 'NF > 0 { line = $0 } END { print line }' "${releases_log}")"
fi
releases_log_empty=1
if [ -n "${last_release_line}" ]; then
  releases_log_empty=0
fi

if [ -n "${first_release}" ] && [ "${releases_log_empty}" -ne 1 ]; then
  printf 'deploy: --first-release cannot be used when %s is not empty\n' "${releases_log}" >&2
  exit 1
fi

# Write optional bypass header to a mode-600 file so curl never sees the secret in argv.
if [ -n "${SMOKE_BYPASS_HEADER:-}" ]; then
  bypass_header_file="$(umask 077 && mktemp "${tmp_base%/}/sous-bypass.XXXXXX")"
  chmod 600 "${bypass_header_file}"
  printf '%s: %s\n' "${SMOKE_BYPASS_HEADER}" "${SMOKE_BYPASS_VALUE}" > "${bypass_header_file}"
fi

parse_version_commit() {
  local raw_body="$1"
  node -e '
const raw = process.argv[1];
let parsed;
try {
  parsed = JSON.parse(raw);
} catch {
  process.exit(1);
}
if (!parsed || typeof parsed !== "object" || !Object.prototype.hasOwnProperty.call(parsed, "commit")) {
  process.exit(1);
}
if (parsed.commit === null) {
  process.stdout.write("NULL");
  process.exit(0);
}
if (typeof parsed.commit === "string" && /^[0-9a-f]{40}$/.test(parsed.commit)) {
  process.stdout.write(parsed.commit);
  process.exit(0);
}
process.exit(1);
' "${raw_body}"
}

fetch_version_commit() {
  local base_url="${1%/}"
  local version_body=""
  if [ -n "${bypass_header_file}" ]; then
    if ! version_body="$(curl -fsS --max-time 15 -H "@${bypass_header_file}" "${base_url}/api/version" 2>/dev/null)"; then
      return 1
    fi
  else
    if ! version_body="$(curl -fsS --max-time 15 "${base_url}/api/version" 2>/dev/null)"; then
      return 1
    fi
  fi
  parse_version_commit "${version_body}"
}

# Step 2: check what commit is currently live.
live_commit=""
version_fetch_ok=0
if live_commit="$(fetch_version_commit "${live_url}")"; then
  version_fetch_ok=1
fi

if [ "${version_fetch_ok}" -ne 1 ] || [ "${live_commit}" = "NULL" ]; then
  if [ -n "${first_release}" ] && [ "${releases_log_empty}" -eq 1 ]; then
    live_commit=""
    printf 'Live commit: none (first release %s)\n' "${first_release}"
  else
    if [ "${version_fetch_ok}" -ne 1 ]; then
      printf 'deploy: failed to read %s/api/version; check that the live site is reachable and answers valid JSON\n' "${live_url}" >&2
    else
      printf 'deploy: live %s/api/version returned commit null; check the host deployment before continuing\n' "${live_url}" >&2
    fi
    exit 1
  fi
else
  printf 'Live commit: %s\n' "${live_commit}"
  if ! git -C "${repo_root}" cat-file -e "${live_commit}^{commit}" 2>/dev/null; then
    printf 'deploy: the live commit %s is not in this repository; fetch it first\n' "${live_commit}" >&2
    exit 1
  fi
  if ! git -C "${repo_root}" merge-base --is-ancestor "${live_commit}" "${sha}" 2>/dev/null; then
    printf 'deploy: %s does not contain the live commit %s; merge it first\n' "${sha}" "${live_commit}" >&2
    exit 1
  fi
fi

# Check release numbering rules against releases.log and find the rollback URL for the live commit.
next_release_num=""
rollback_url=""
if [ -n "${first_release}" ]; then
  next_release_num="${first_release}"
else
  if [ "${releases_log_empty}" -eq 1 ]; then
    printf 'deploy: %s is empty; see docs/deploy.md before using --first-release\n' "${releases_log}" >&2
    exit 1
  fi
  last_num="$(printf '%s\n' "${last_release_line}" | awk '{ print $1 }')"
  case "${last_num}" in
    ""|*[!0-9]*|0*)
      printf 'deploy: invalid release number in %s: "%s"\n' "${releases_log}" "${last_num}" >&2
      exit 1
      ;;
  esac
  next_release_num="$((last_num + 1))"
  if [ -n "${live_commit}" ] && [ -f "${releases_log}" ]; then
    rollback_url="$(awk -v target="${live_commit}" 'NF >= 3 && $2 == target { url = $3 } END { print url }' "${releases_log}")"
  fi
fi

printf 'Target commit: %s (release %s)\n' "${sha}" "${next_release_num}"

# Step 3: inspect migrations (append-only and strictly increasing timestamps).
new_migrations=()
journal_path="app/drizzle/migrations/meta/_journal.json"

check_journal_entries() {
  local mode="$1"
  local live_journal="$2"
  local target_journal="$3"
  node -e '
const [mode, oldRaw, newRaw, journalPath] = process.argv.slice(1);
function deepEqual(a, b) {
  if (a === b) return true;
  if (a === null || b === null || typeof a !== "object" || typeof b !== "object") {
    return false;
  }
  if (Array.isArray(a) !== Array.isArray(b)) return false;
  if (Array.isArray(a)) {
    if (a.length !== b.length) return false;
    for (let i = 0; i < a.length; i += 1) {
      if (!deepEqual(a[i], b[i])) return false;
    }
    return true;
  }
  const keysA = Object.keys(a).sort();
  const keysB = Object.keys(b).sort();
  if (keysA.length !== keysB.length) return false;
  for (let i = 0; i < keysA.length; i += 1) {
    if (keysA[i] !== keysB[i]) return false;
    if (!deepEqual(a[keysA[i]], b[keysB[i]])) return false;
  }
  return true;
}
function entryTag(entry, index) {
  if (entry && typeof entry === "object" && typeof entry.tag === "string" && entry.tag.length > 0) {
    return entry.tag;
  }
  return String(index);
}
function validWhen(entry) {
  return Boolean(entry && typeof entry === "object" && typeof entry.when === "number" && Number.isFinite(entry.when));
}

if (mode === "first") {
  let newJ;
  try {
    newJ = JSON.parse(newRaw);
  } catch {
    console.error(`deploy: ${journalPath} is not valid JSON`);
    process.exit(1);
  }
  if (!newJ || typeof newJ !== "object" || !Array.isArray(newJ.entries)) {
    console.error(`deploy: ${journalPath} is missing an entries array`);
    process.exit(1);
  }
  for (let i = 0; i < newJ.entries.length; i += 1) {
    const entry = newJ.entries[i];
    if (!validWhen(entry)) {
      console.error(`deploy: migration ${entryTag(entry, i)} in ${journalPath} has an invalid timestamp`);
      process.exit(1);
    }
    if (i > 0 && entry.when <= newJ.entries[i - 1].when) {
      console.error(`deploy: migration ${entryTag(entry, i)} has a timestamp that does not increase after ${entryTag(newJ.entries[i - 1], i - 1)}; regenerate it`);
      process.exit(1);
    }
  }
  process.exit(0);
}

let oldJ;
let newJ;
try {
  oldJ = JSON.parse(oldRaw);
  newJ = JSON.parse(newRaw);
} catch {
  console.error(`deploy: migrations are append-only; ${journalPath} is not valid JSON`);
  process.exit(1);
}
if (!oldJ || !newJ || !Array.isArray(oldJ.entries) || !Array.isArray(newJ.entries)) {
  console.error(`deploy: migrations are append-only; ${journalPath} modified or removed existing entries`);
  process.exit(1);
}
if (oldJ.version !== newJ.version || oldJ.dialect !== newJ.dialect) {
  console.error(`deploy: migrations are append-only; ${journalPath} modified or removed existing entries`);
  process.exit(1);
}
if (newJ.entries.length < oldJ.entries.length) {
  console.error(`deploy: migrations are append-only; ${journalPath} modified or removed existing entries`);
  process.exit(1);
}
for (let i = 0; i < oldJ.entries.length; i += 1) {
  if (!deepEqual(oldJ.entries[i], newJ.entries[i])) {
    console.error(`deploy: migrations are append-only; ${journalPath} modified or removed existing entries`);
    process.exit(1);
  }
}

let maxLiveWhen = -Infinity;
for (let i = 0; i < oldJ.entries.length; i += 1) {
  if (!validWhen(oldJ.entries[i])) {
    console.error(`deploy: live migration ${entryTag(oldJ.entries[i], i)} in ${journalPath} has an invalid timestamp`);
    process.exit(1);
  }
  if (oldJ.entries[i].when > maxLiveWhen) {
    maxLiveWhen = oldJ.entries[i].when;
  }
}

let prevWhen = maxLiveWhen;
for (let i = oldJ.entries.length; i < newJ.entries.length; i += 1) {
  const entry = newJ.entries[i];
  const tag = entryTag(entry, i);
  if (!validWhen(entry)) {
    console.error(`deploy: migration ${tag} in ${journalPath} has an invalid timestamp`);
    process.exit(1);
  }
  if (oldJ.entries.length > 0 && entry.when <= maxLiveWhen) {
    console.error(`deploy: migration ${tag} has a timestamp earlier than one already live; regenerate it`);
    process.exit(1);
  }
  if (i > oldJ.entries.length && entry.when <= prevWhen) {
    console.error(`deploy: migration ${tag} has a timestamp that does not increase after ${entryTag(newJ.entries[i - 1], i - 1)}; regenerate it`);
    process.exit(1);
  }
  prevWhen = entry.when;
}
' "${mode}" "${live_journal}" "${target_journal}" "${journal_path}"
}

if [ -z "${live_commit}" ]; then
  if ! mig_listing="$(git -C "${repo_root}" ls-tree -r --name-only "${sha}" -- app/drizzle/migrations)"; then
    printf 'deploy: failed to list migrations for %s\n' "${sha}" >&2
    exit 1
  fi
  has_journal=0
  if [ -n "${mig_listing}" ]; then
    while IFS= read -r mig_path; do
      [ -z "${mig_path}" ] && continue
      if [ "${mig_path}" = "${journal_path}" ]; then
        has_journal=1
      fi
      case "${mig_path}" in
        app/drizzle/migrations/meta/*)
          ;;
        *)
          new_migrations+=("${mig_path}")
          ;;
      esac
    done <<< "${mig_listing}"
  fi
  if [ "${has_journal}" -eq 1 ]; then
    if ! target_journal="$(git -C "${repo_root}" show "${sha}:${journal_path}")"; then
      printf 'deploy: failed to read %s at %s\n' "${journal_path}" "${sha}" >&2
      exit 1
    fi
    if ! check_journal_entries "first" "" "${target_journal}"; then
      exit 1
    fi
  fi
else
  if ! mig_diff="$(git -C "${repo_root}" diff --name-status "${live_commit}" "${sha}" -- app/drizzle/migrations)"; then
    printf 'deploy: failed to diff migrations between %s and %s\n' "${live_commit}" "${sha}" >&2
    exit 1
  fi
  if [ -n "${mig_diff}" ]; then
    while IFS=$'\t' read -r diff_status diff_path1 diff_path2; do
      [ -z "${diff_status}" ] && continue
      if [ "${diff_status}" = "A" ]; then
        if [ "${diff_path1}" = "${journal_path}" ]; then
          if ! target_journal="$(git -C "${repo_root}" show "${sha}:${journal_path}")"; then
            printf 'deploy: failed to read %s at %s\n' "${journal_path}" "${sha}" >&2
            exit 1
          fi
          if ! check_journal_entries "first" "" "${target_journal}"; then
            exit 1
          fi
        fi
        case "${diff_path1}" in
          app/drizzle/migrations/meta/*)
            ;;
          *)
            new_migrations+=("${diff_path1}")
            ;;
        esac
      elif [ "${diff_status}" = "M" ] && [ "${diff_path1}" = "${journal_path}" ]; then
        if ! live_journal="$(git -C "${repo_root}" show "${live_commit}:${journal_path}")"; then
          printf 'deploy: failed to read %s at %s\n' "${journal_path}" "${live_commit}" >&2
          exit 1
        fi
        if ! target_journal="$(git -C "${repo_root}" show "${sha}:${journal_path}")"; then
          printf 'deploy: failed to read %s at %s\n' "${journal_path}" "${sha}" >&2
          exit 1
        fi
        if ! check_journal_entries "append" "${live_journal}" "${target_journal}"; then
          exit 1
        fi
      else
        if [ -n "${diff_path2:-}" ]; then
          printf 'deploy: migrations are append-only; refused %s %s -> %s\n' "${diff_status}" "${diff_path1}" "${diff_path2}" >&2
        else
          printf 'deploy: migrations are append-only; refused %s %s\n' "${diff_status}" "${diff_path1}" >&2
        fi
        exit 1
      fi
    done <<< "${mig_diff}"
  fi
fi

if [ "${#new_migrations[@]}" -gt 0 ]; then
  printf 'New migrations:\n'
  for mig_path in "${new_migrations[@]}"; do
    printf '  %s\n' "${mig_path}"
  done
else
  printf 'New migrations: none\n'
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

format_host_cmd() {
  local subcmd="$1"
  shift
  local out="${host_cli} ${subcmd}"
  local all_args=("$@")
  if [ "${#host_args[@]}" -gt 0 ]; then
    all_args+=("${host_args[@]}")
  fi
  local arg
  local redact_next=0
  for arg in ${all_args[@]+"${all_args[@]}"}; do
    if [ "${redact_next}" -eq 1 ]; then
      out="${out} <redacted>"
      redact_next=0
    else
      case "${arg}" in
        --token|-t)
          out="${out} ${arg}"
          redact_next=1
          ;;
        --token=*)
          out="${out} --token=<redacted>"
          ;;
        -t=*)
          out="${out} -t=<redacted>"
          ;;
        *)
          out="${out} ${arg}"
          ;;
      esac
    fi
  done
  printf '%s' "${out}"
}

print_rollback_info() {
  if [ -n "${rollback_url}" ]; then
    printf 'Rollback command:\n'
    printf '  %s\n' "$(format_host_cmd rollback "${rollback_url}" --yes)"
  else
    printf "Rollback: no recorded release matches the live commit; rollback must be done from the host's own deployment list.\n"
  fi
  printf 'Note: rollback switches application code only; database migrations are not rolled back (see docs/deploy.md).\n'
}

# Step 4 pre-check when migrations are pending (runs in dry-run and real run).
backup_path=""
db_host=""
if [ "${#new_migrations[@]}" -gt 0 ]; then
  missing_mig_vars=()
  if [ -z "${SOUS_DEPLOY_ENV_FILE:-}" ]; then
    missing_mig_vars+=("SOUS_DEPLOY_ENV_FILE")
  fi
  if [ -z "${SOUS_BACKUP_DIR:-}" ]; then
    missing_mig_vars+=("SOUS_BACKUP_DIR")
  fi
  if [ "${#missing_mig_vars[@]}" -gt 0 ]; then
    printf 'deploy: migrations are pending; missing required environment variable(s): %s\n' "${missing_mig_vars[*]}" >&2
    exit 1
  fi
  if [ ! -f "${SOUS_DEPLOY_ENV_FILE}" ] || [ ! -r "${SOUS_DEPLOY_ENV_FILE}" ]; then
    printf 'deploy: SOUS_DEPLOY_ENV_FILE does not exist or is not readable: %s\n' "${SOUS_DEPLOY_ENV_FILE}" >&2
    exit 1
  fi
  if ! db_host="$(read_database_env_info "${SOUS_DEPLOY_ENV_FILE}" host)"; then
    exit 1
  fi
  backup_ts="$(date -u "+%Y%m%dT%H%M%SZ")"
  backup_path="${SOUS_BACKUP_DIR%/}/sous-${sha_short}-${backup_ts}.dump"
fi

# Dry run prints every value it would use (except secrets) and changes nothing.
if [ "${dry_run}" -eq 1 ]; then
  printf 'State directory: %s\n' "${state_dir}"
  printf 'Live URL: %s\n' "${live_url}"
  printf 'Expected sign-in mode: %s\n' "${SOUS_EXPECT_SIGN_IN}"
  printf 'Host link file: %s\n' "${SOUS_HOST_LINK_FILE}"
  if [ -n "${SMOKE_BYPASS_HEADER:-}" ]; then
    printf 'Smoke bypass header: %s (value redacted)\n' "${SMOKE_BYPASS_HEADER}"
  fi
  if [ "${#new_migrations[@]}" -gt 0 ]; then
    printf 'Database host: %s (from %s)\n' "${db_host}" "${SOUS_DEPLOY_ENV_FILE}"
    printf 'Would back up database to: %s\n' "${backup_path}"
    printf 'Would run migration: pnpm --dir app db:migrate\n'
  fi
  printf 'Would stage: %s\n' "$(format_host_cmd deploy --prod --skip-domain --yes --build-env "SOUS_RELEASE_COMMIT=${sha}")"
  printf 'Would check staged /api/version equals %s\n' "${sha}"
  printf 'Would smoke staged URL: SMOKE_BASE_URL=<staged-url> SMOKE_EXPECT_COMMIT=%s SMOKE_EXPECT_SIGN_IN=%s pnpm --dir app e2e:smoke\n' "${sha}" "${SOUS_EXPECT_SIGN_IN}"
  printf 'Would promote: %s\n' "$(format_host_cmd promote "<staged-url>" --yes)"
  printf 'Would check live /api/version equals %s (waiting up to %ss)\n' "${sha}" "${live_wait_seconds}"
  printf 'Would smoke live URL: SMOKE_BASE_URL=%s SMOKE_EXPECT_COMMIT=%s SMOKE_EXPECT_SIGN_IN=%s pnpm --dir app e2e:smoke\n' "${live_url}" "${sha}" "${SOUS_EXPECT_SIGN_IN}"
  printf 'Would record release %s in %s\n' "${next_release_num}" "${releases_log}"
  print_rollback_info
  printf 'dry run: nothing was changed\n'
  exit 0
fi

# Real run: create a fresh temporary detached worktree for the target commit.
tmp_dir="$(umask 077 && mktemp -d "${tmp_base%/}/sous-deploy.XXXXXX")"
worktree_dir="${tmp_dir}/worktree"
git -C "${repo_root}" worktree add --detach "${worktree_dir}" "${sha}"
worktree_added=1

(cd "${worktree_dir}" && pnpm --dir app install --frozen-lockfile --prefer-offline)

# Step 4: backup and migrate when migrations are pending.
db_migrated=0
if [ "${#new_migrations[@]}" -gt 0 ]; then
  mkdir -p -m 700 "${SOUS_BACKUP_DIR}"
  chmod 700 "${SOUS_BACKUP_DIR}"

  pg_env_file="$(umask 077 && mktemp "${tmp_dir}/pg-env.XXXXXX")"
  chmod 600 "${pg_env_file}"
  if ! read_database_env_info "${SOUS_DEPLOY_ENV_FILE}" pg-env > "${pg_env_file}"; then
    rm -f "${pg_env_file}"
    pg_env_file=""
    exit 1
  fi

  printf 'Backing up database at %s to %s\n' "${db_host}" "${backup_path}"
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
    printf 'deploy: pg_dump failed; refusing to migrate\n' >&2
    exit 1
  fi
  if [ ! -s "${backup_path}" ]; then
    printf 'deploy: backup file is empty (%s); refusing to migrate\n' "${backup_path}" >&2
    exit 1
  fi

  db_url_file="$(umask 077 && mktemp "${tmp_dir}/db-url.XXXXXX")"
  chmod 600 "${db_url_file}"
  if ! read_database_env_info "${SOUS_DEPLOY_ENV_FILE}" url > "${db_url_file}"; then
    rm -f "${db_url_file}"
    db_url_file=""
    exit 1
  fi

  printf 'Running migrations against %s\n' "${db_host}"
  migrate_ok=0
  if (cd "${worktree_dir}" && env -i PATH="${PATH}" HOME="${HOME}" bash -c 'IFS= read -r DATABASE_URL < "$1" && export DATABASE_URL && exec pnpm --dir app db:migrate' _ "${db_url_file}"); then
    migrate_ok=1
  fi
  rm -f "${db_url_file}"
  db_url_file=""
  if [ "${migrate_ok}" -ne 1 ]; then
    printf 'deploy: db:migrate failed; backup is at %s; restore it into a scratch database first (docs/deploy.md, Backup and restore)\n' "${backup_path}" >&2
    exit 1
  fi
  db_migrated=1
fi

# Step 5: stage the target commit.
mkdir -p "${worktree_dir}/.vercel"
cp "${SOUS_HOST_LINK_FILE}" "${worktree_dir}/.vercel/project.json"

stage_out="${tmp_dir}/stage.stdout"
print_stage_out() {
  cat "${stage_out}"
  if [ -s "${stage_out}" ] && [ "$(tail -c 1 "${stage_out}" | wc -l)" -eq 0 ]; then
    printf '\n'
  fi
}
if ! (cd "${worktree_dir}" && "${host_cli}" deploy --prod --skip-domain --yes --build-env "SOUS_RELEASE_COMMIT=${sha}" ${host_args[@]+"${host_args[@]}"}) > "${stage_out}"; then
  print_stage_out >&2
  printf 'deploy: staging command failed\n' >&2
  exit 1
fi
print_stage_out

parse_staged_url() {
  local stage_file="$1"
  node -e '
const fs = require("node:fs");
const stagePath = process.argv[1];
const noUrlMsg =
  "deploy: host staging output contained no https:// URL (neither a bare https:// line nor a JSON document with a deployment URL was found); nothing was promoted";
const invalidUrlMsg =
  "deploy: host staging output contained an invalid deployment URL (expected an https:// host with no credentials, port, path, query, or fragment); nothing was promoted";

function fail(message) {
  console.error(message);
  process.exit(1);
}

function isDnsHostname(hostname) {
  if (hostname.length === 0 || hostname.length > 253 || hostname.endsWith(".")) {
    return false;
  }
  const labels = hostname.split(".");
  if (labels.length < 2) {
    return false;
  }
  for (const label of labels) {
    if (!/^[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?$/.test(label)) {
      return false;
    }
  }
  return true;
}

function validateStagedUrl(rawUrl, allowBareHostname) {
  if (typeof rawUrl !== "string" || rawUrl.length === 0) {
    fail(noUrlMsg);
  }
  if (/[\x00-\x1f\x7f\s]/.test(rawUrl) || rawUrl.includes("%")) {
    fail(invalidUrlMsg);
  }

  let rest;
  if (rawUrl.includes("://")) {
    if (!rawUrl.startsWith("https://")) {
      fail(invalidUrlMsg);
    }
    rest = rawUrl.slice("https://".length);
  } else {
    if (!allowBareHostname) {
      fail(invalidUrlMsg);
    }
    rest = rawUrl;
  }

  if (
    !rest ||
    rest.includes("@") ||
    rest.includes(":") ||
    rest.includes("?") ||
    rest.includes("#") ||
    rest.includes("\\")
  ) {
    fail(invalidUrlMsg);
  }

  // Check path on the raw text before URL normalization so dot segments such
  // as host/. or host/a/.. are refused rather than normalized away.
  const firstSlash = rest.indexOf("/");
  if (firstSlash !== -1) {
    if (firstSlash !== rest.length - 1) {
      fail(invalidUrlMsg);
    }
    rest = rest.slice(0, -1);
  }
  if (!rest) {
    fail(invalidUrlMsg);
  }

  let urlObj;
  try {
    urlObj = new URL(`https://${rest}`);
  } catch {
    fail(invalidUrlMsg);
  }
  if (
    urlObj.protocol !== "https:" ||
    !urlObj.hostname ||
    urlObj.username !== "" ||
    urlObj.password !== "" ||
    urlObj.port !== "" ||
    urlObj.search !== "" ||
    urlObj.hash !== "" ||
    urlObj.pathname !== "/" ||
    !isDnsHostname(urlObj.hostname)
  ) {
    fail(invalidUrlMsg);
  }

  return `https://${urlObj.hostname}`;
}

const content = fs.readFileSync(stagePath, "utf8");
const trimmed = content.trim();
if (!trimmed) {
  fail(noUrlMsg);
}

let isJson = false;
let parsed;
try {
  parsed = JSON.parse(trimmed);
  isJson = true;
} catch {
  isJson = false;
}

let candidate = null;
let allowBareHostname = false;

if (isJson) {
  if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) {
    fail(noUrlMsg);
  }

  const hasDeployment =
    parsed.deployment !== null &&
    typeof parsed.deployment === "object" &&
    !Array.isArray(parsed.deployment);
  const source = hasDeployment ? parsed.deployment : parsed;

  if (Object.prototype.hasOwnProperty.call(source, "readyState")) {
    if (source.readyState !== "READY") {
      fail(
        `deploy: staged deployment reported readyState ${JSON.stringify(source.readyState)} (expected "READY"); nothing was promoted`,
      );
    }
  }

  if (typeof source.url !== "string" || source.url.length === 0) {
    fail(noUrlMsg);
  }
  candidate = source.url;
  allowBareHostname = true;
} else {
  for (const rawLine of content.split("\n")) {
    const line = rawLine.endsWith("\r") ? rawLine.slice(0, -1) : rawLine;
    if (line.startsWith("https://")) {
      candidate = line;
    }
  }
  if (candidate === null) {
    fail(noUrlMsg);
  }
  allowBareHostname = false;
}

process.stdout.write(validateStagedUrl(candidate, allowBareHostname));
' "${stage_file}"
}

if ! staged_url="$(parse_staged_url "${stage_out}")"; then
  exit 1
fi
if [ -z "${staged_url}" ]; then
  printf 'deploy: host staging output contained no https:// URL (neither a bare https:// line nor a JSON document with a deployment URL was found); nothing was promoted\n' >&2
  exit 1
fi
printf 'Staged URL: %s\n' "${staged_url}"

run_smoke() {
  local target_url="$1"
  (
    cd "${worktree_dir}"
    export SMOKE_BASE_URL="${target_url}"
    export SMOKE_EXPECT_COMMIT="${sha}"
    export SMOKE_EXPECT_SIGN_IN="${SOUS_EXPECT_SIGN_IN}"
    if [ -n "${SMOKE_BYPASS_HEADER:-}" ]; then
      export SMOKE_BYPASS_HEADER="${SMOKE_BYPASS_HEADER}"
      export SMOKE_BYPASS_VALUE="${SMOKE_BYPASS_VALUE}"
    fi
    exec pnpm --dir app e2e:smoke
  )
}

# Step 6: verify staged /api/version and smoke the staged URL before promotion.
staged_commit=""
if ! staged_commit="$(fetch_version_commit "${staged_url}")"; then
  staged_commit="an invalid or unreachable response"
elif [ "${staged_commit}" = "NULL" ]; then
  staged_commit="null"
fi
if [ "${staged_commit}" != "${sha}" ]; then
  printf 'deploy: the staged copy answers %s, expected %s; nothing was promoted\n' "${staged_commit}" "${sha}" >&2
  exit 1
fi

if ! run_smoke "${staged_url}"; then
  printf 'deploy: staged smoke check failed for %s; nothing was promoted.\n' "${staged_url}" >&2
  exit 1
fi

# Step 7: promote staged deployment, verify live /api/version, and smoke live URL.
if ! (cd "${worktree_dir}" && "${host_cli}" promote "${staged_url}" --yes ${host_args[@]+"${host_args[@]}"}); then
  printf 'deploy: promote failed; its outcome is unknown, check what the live address answers (%s/api/version)\n' "${live_url}" >&2
  if [ "${db_migrated}" -eq 1 ]; then
    printf 'deploy: note: this run already migrated the database; backup is at %s\n' "${backup_path}" >&2
  fi
  print_rollback_info >&2
  exit 1
fi

live_after_ok=0
live_after_answer="an invalid or unreachable response"
wait_start="$(date +%s)"
wait_deadline="$((wait_start + live_wait_seconds))"
while :; do
  if polled_commit="$(fetch_version_commit "${live_url}")"; then
    if [ "${polled_commit}" = "${sha}" ]; then
      live_after_ok=1
      break
    elif [ "${polled_commit}" = "NULL" ]; then
      live_after_answer="null"
    else
      live_after_answer="${polled_commit}"
    fi
  else
    live_after_answer="an invalid or unreachable response"
  fi
  now_ts="$(date +%s)"
  if [ "${now_ts}" -ge "${wait_deadline}" ]; then
    break
  fi
  remaining="$((wait_deadline - now_ts))"
  sleep_secs=5
  if [ "${remaining}" -lt "${sleep_secs}" ]; then
    sleep_secs="${remaining}"
  fi
  sleep "${sleep_secs}"
done

if [ "${live_after_ok}" -ne 1 ]; then
  printf 'deploy: the live copy at %s does not answer the new commit %s after %ss (last answer: %s)\n' "${live_url}" "${sha}" "${live_wait_seconds}" "${live_after_answer}" >&2
  print_rollback_info >&2
  exit 1
fi

if ! run_smoke "${live_url}"; then
  printf 'deploy: live smoke check failed for %s after promotion!\n' "${live_url}" >&2
  print_rollback_info >&2
  exit 1
fi

# Step 8: record the release.
utc_now="$(date -u "+%Y-%m-%dT%H:%M:%SZ")"
printf '%s %s %s %s\n' "${next_release_num}" "${sha}" "${staged_url}" "${utc_now}" >> "${releases_log}"
printf 'Release %s: %s is live at %s\n' "${next_release_num}" "${sha}" "${live_url}"

# Step 9: print rollback command and migration reminder.
print_rollback_info
