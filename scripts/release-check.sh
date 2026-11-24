#!/usr/bin/env bash
{ set +x; } 2>/dev/null
set -euo pipefail

usage() {
  printf 'Usage: %s <commit>\n' "$0" >&2
}

if [ "$#" -ne 1 ]; then
  usage
  exit 1
fi

commit_arg="$1"
if [ -z "${commit_arg}" ]; then
  usage
  exit 1
fi

repo_root="$(git rev-parse --show-toplevel 2>/dev/null || true)"
if [ -z "${repo_root}" ]; then
  printf 'FAILED: must be run inside a git repository\n' >&2
  exit 1
fi

sha="$(git -C "${repo_root}" rev-parse --verify --quiet "${commit_arg}^{commit}" || true)"
if [ -z "${sha}" ]; then
  printf 'FAILED: unknown commit: %s\n' "${commit_arg}" >&2
  exit 1
fi

validate_port() {
  local name="$1"
  local val="$2"
  case "${val}" in
    *[!0123456789]*|0*)
      printf 'FAILED: %s must be a whole number from 1024 to 65535 (got "%s").\n' "${name}" "${val}" >&2
      exit 1
      ;;
  esac
  if [ "${#val}" -lt 4 ] || [ "${#val}" -gt 5 ] || [ "${val}" -lt 1024 ] || [ "${val}" -gt 65535 ]; then
    printf 'FAILED: %s must be a whole number from 1024 to 65535 (got "%s").\n' "${name}" "${val}" >&2
    exit 1
  fi
}

validate_container() {
  local name="$1"
  local val="$2"
  case "${val}" in
    [!0123456789abcdefghijklmnopqrstuvwxyzABCDEFGHIJKLMNOPQRSTUVWXYZ]*|*[!0123456789abcdefghijklmnopqrstuvwxyzABCDEFGHIJKLMNOPQRSTUVWXYZ._-]*)
      printf 'FAILED: %s must start with a letter or digit and contain only letters, digits, ".", "_" and "-" (got "%s").\n' "${name}" "${val}" >&2
      exit 1
      ;;
  esac
}

e2e_env_args=()
app_port="4131"
pg_container="rails-pg"
if [ -n "${E2E_APP_PORT:-}" ]; then
  validate_port "E2E_APP_PORT" "${E2E_APP_PORT}"
  app_port="${E2E_APP_PORT}"
  e2e_env_args+=("E2E_APP_PORT=${E2E_APP_PORT}")
fi
if [ -n "${E2E_PG_PORT:-}" ]; then
  validate_port "E2E_PG_PORT" "${E2E_PG_PORT}"
  e2e_env_args+=("E2E_PG_PORT=${E2E_PG_PORT}")
fi
if [ -n "${E2E_PG_CONTAINER:-}" ]; then
  validate_container "E2E_PG_CONTAINER" "${E2E_PG_CONTAINER}"
  pg_container="${E2E_PG_CONTAINER}"
  e2e_env_args+=("E2E_PG_CONTAINER=${E2E_PG_CONTAINER}")
fi

os_name="$(uname -s)"
if [ "${os_name}" != "Darwin" ]; then
  printf 'FAILED: the screenshot suite only runs on macOS (found %s); no pass was recorded.\n' "${os_name}" >&2
  exit 1
fi

check_port_free() {
  local port="$1"
  node -e '
const net = require("node:net");
const host = "127.0.0.1";
const port = Number(process.argv[1]);

const socket = net.createConnection({ host, port });
socket.setTimeout(500);

function checkBind() {
  const server = net.createServer();
  server.once("error", () => process.exit(1));
  server.once("listening", () => {
    server.close(() => process.exit(0));
  });
  server.listen(port, host);
}

socket.once("connect", () => {
  socket.destroy();
  process.exit(1);
});
socket.once("timeout", () => {
  socket.destroy();
  process.exit(1);
});
socket.once("error", (err) => {
  socket.destroy();
  if (err && err.code === "ECONNREFUSED") {
    checkBind();
  } else {
    process.exit(1);
  }
});
' "${port}"
}

if ! check_port_free "${app_port}"; then
  printf 'FAILED: port %s is already in use (another release check or server may be running).\n' "${app_port}" >&2
  exit 1
fi

tmp_base="${TMPDIR:-/tmp}"

run_docker_clean() {
  env -i PATH="${PATH}" HOME="${HOME}" TMPDIR="${tmp_base}" docker "$@"
}

owner_rand="$(node -e 'process.stdout.write(require("node:crypto").randomBytes(8).toString("hex"))')"
pg_owner="rcheck-${sha:0:12}-$$-${owner_rand}"

check_pg_container_absent() {
  if run_docker_clean container inspect "${pg_container}" >/dev/null 2>&1; then
    printf 'FAILED: Docker container "%s" already exists; another run may be using it. Remove it with `pnpm --dir app e2e:db:down` (with the same E2E_* variables) if it is yours, or choose different E2E_PG_CONTAINER and E2E_PG_PORT values.\n' "${pg_container}" >&2
    exit 1
  fi
}

container_owned_by_run() {
  local actual_owner=""
  if ! actual_owner="$(run_docker_clean container inspect --format '{{ index .Config.Labels "sous.e2e.owner" }}' "${pg_container}" 2>/dev/null)"; then
    return 1
  fi
  [ -n "${actual_owner}" ] && [ "${actual_owner}" = "${pg_owner}" ]
}

check_pg_container_absent

tmp_dir="$(mktemp -d "${tmp_base%/}/sous-release-check.XXXXXX")"
worktree_dir="${tmp_dir}/worktree"
e2e_json="${tmp_dir}/e2e-report.json"
visual_json="${tmp_dir}/visual-report.json"
worktree_added=0
db_started=0

cleanup() {
  if [ "${db_started}" -eq 1 ] && [ -d "${worktree_dir}/app" ] && container_owned_by_run; then
    env -i PATH="${PATH}" HOME="${HOME}" TMPDIR="${tmp_base}" \
      ${e2e_env_args[@]+"${e2e_env_args[@]}"} \
      pnpm --dir "${worktree_dir}/app" e2e:db:down >/dev/null 2>&1 || true
  fi
  if [ "${worktree_added}" -eq 1 ]; then
    git -C "${repo_root}" worktree remove --force "${worktree_dir}" >/dev/null 2>&1 || true
  fi
  rm -rf "${tmp_dir}"
}

trap cleanup EXIT

git -C "${repo_root}" worktree add --detach "${worktree_dir}" "${sha}"
worktree_added=1

for env_file in .env .env.local .env.production .env.production.local; do
  if [ -e "${worktree_dir}/app/${env_file}" ]; then
    printf 'FAILED: refusing to start because worktree contains app/%s\n' "${env_file}" >&2
    exit 1
  fi
done

fail_step() {
  local step_name="$1"
  printf 'FAILED: release check for %s stopped at step "%s". No pass was recorded.\n' "${sha}" "${step_name}" >&2
  exit 1
}

run_clean() {
  local step_name="$1"
  shift
  printf '==> %s\n' "${step_name}"
  if ! (cd "${worktree_dir}" && env -i CI=1 PATH="${PATH}" HOME="${HOME}" TMPDIR="${tmp_base}" ${e2e_env_args[@]+"${e2e_env_args[@]}"} "$@"); then
    fail_step "${step_name}"
  fi
}

run_clean "install" pnpm --dir app install --frozen-lockfile --prefer-offline
run_clean "pack lint" pnpm --dir pack lint
run_clean "pack typecheck" pnpm --dir pack typecheck
run_clean "pack test" pnpm --dir pack test
run_clean "app lint" pnpm --dir app lint
run_clean "app typecheck" pnpm --dir app exec tsc --noEmit -p .
run_clean "app typecheck:scripts" pnpm --dir app run typecheck:scripts

run_clean "app db:generate" pnpm --dir app db:generate
drizzle_status="$(git -C "${worktree_dir}" status --porcelain -- app/drizzle)"
if [ -n "${drizzle_status}" ]; then
  printf '%s\n' "${drizzle_status}" >&2
  fail_step "app db:generate (schema changed without a committed migration)"
fi

run_clean "app test:run" pnpm --dir app test:run
run_clean "app build" "SOUS_RELEASE_COMMIT=${sha}" pnpm --dir app build

check_pg_container_absent
db_started=1
run_clean "app e2e:db:up" "E2E_PG_OWNER=${pg_owner}" pnpm --dir app e2e:db:up

run_clean "app e2e" \
  "SOUS_RELEASE_COMMIT=${sha}" \
  "PLAYWRIGHT_JSON_OUTPUT_NAME=${e2e_json}" \
  pnpm --dir app e2e --reporter=list,json

run_clean "app e2e:visual" \
  "E2E_SKIP_BUILD=1" \
  "SOUS_RELEASE_COMMIT=${sha}" \
  "PLAYWRIGHT_JSON_OUTPUT_NAME=${visual_json}" \
  pnpm --dir app e2e:visual --reporter=list,json

read_playwright_counts() {
  local report_path="$1"
  local label="$2"
  node -e '
const fs = require("node:fs");
const [reportPath, label] = process.argv.slice(1);
if (!fs.existsSync(reportPath)) {
  console.error(`${label}: missing Playwright JSON report at ${reportPath}`);
  process.exit(1);
}
let data;
try {
  data = JSON.parse(fs.readFileSync(reportPath, "utf8"));
} catch (err) {
  console.error(`${label}: invalid Playwright JSON report: ${err.message}`);
  process.exit(1);
}
const stats = data && typeof data === "object" ? data.stats : null;
if (!stats || typeof stats !== "object") {
  console.error(`${label}: Playwright JSON report has no stats object`);
  process.exit(1);
}
const expected = stats.expected;
const unexpected = stats.unexpected;
const flaky = stats.flaky === undefined ? 0 : stats.flaky;
const errors = Array.isArray(data.errors) ? data.errors.length : 0;
if (
  !Number.isInteger(expected) ||
  !Number.isInteger(unexpected) ||
  !Number.isInteger(flaky) ||
  expected < 0 ||
  unexpected < 0 ||
  flaky < 0
) {
  console.error(`${label}: unexpected Playwright stats counters`);
  process.exit(1);
}
const passed = expected;
const failed = unexpected + flaky + errors;
if (passed < 1) {
  console.error(`${label}: expected at least 1 passed test, found ${passed}`);
  process.exit(1);
}
if (failed !== 0) {
  console.error(`${label}: expected 0 failures, found ${failed}`);
  process.exit(1);
}
process.stdout.write(`${passed}/${failed}`);
' "${report_path}" "${label}"
}

if ! e2e_counts="$(read_playwright_counts "${e2e_json}" "e2e")"; then
  fail_step "e2e report verification"
fi

if ! visual_counts="$(read_playwright_counts "${visual_json}" "visual")"; then
  fail_step "visual report verification"
fi

state_dir="${SOUS_RELEASE_STATE_DIR:-${HOME}/.local/state/sous}"
mkdir -p -m 700 "${state_dir}"
chmod 700 "${state_dir}"
pass_log="${state_dir}/release-passes.log"
utc_now="$(date -u "+%Y-%m-%dT%H:%M:%SZ")"

printf '%s %s e2e=%s visual=%s\n' "${sha}" "${utc_now}" "${e2e_counts}" "${visual_counts}" >> "${pass_log}"

printf 'PASSED: %s %s e2e=%s visual=%s\n' "${sha}" "${utc_now}" "${e2e_counts}" "${visual_counts}"
printf 'Recorded in %s\n' "${pass_log}"
