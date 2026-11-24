#!/bin/sh
set -eu

validate_port() {
  name="$1"
  val="$2"
  case "$val" in
    *[!0123456789]*|0*)
      printf '%s must be a whole number from 1024 to 65535 (got "%s").\n' "$name" "$val" >&2
      exit 1
      ;;
  esac
  if [ "${#val}" -lt 4 ] || [ "${#val}" -gt 5 ] || [ "$val" -lt 1024 ] || [ "$val" -gt 65535 ]; then
    printf '%s must be a whole number from 1024 to 65535 (got "%s").\n' "$name" "$val" >&2
    exit 1
  fi
}

validate_container() {
  name="$1"
  val="$2"
  case "$val" in
    [!0123456789abcdefghijklmnopqrstuvwxyzABCDEFGHIJKLMNOPQRSTUVWXYZ]*|*[!0123456789abcdefghijklmnopqrstuvwxyzABCDEFGHIJKLMNOPQRSTUVWXYZ._-]*)
      printf '%s must start with a letter or digit and contain only letters, digits, ".", "_" and "-" (got "%s").\n' "$name" "$val" >&2
      exit 1
      ;;
  esac
}

validate_owner() {
  name="$1"
  val="$2"
  case "$val" in
    [!0123456789abcdefghijklmnopqrstuvwxyzABCDEFGHIJKLMNOPQRSTUVWXYZ]*|*[!0123456789abcdefghijklmnopqrstuvwxyzABCDEFGHIJKLMNOPQRSTUVWXYZ._-]*)
      printf '%s must start with a letter or digit, contain only letters, digits, ".", "_" and "-", and be at most 128 characters (got "%s").\n' "$name" "$val" >&2
      exit 1
      ;;
  esac
  if [ "${#val}" -gt 128 ]; then
    printf '%s must be at most 128 characters (got %d).\n' "$name" "${#val}" >&2
    exit 1
  fi
}

validate_port "E2E_APP_PORT" "${E2E_APP_PORT:-4131}"
PG_PORT="${E2E_PG_PORT:-55731}"
validate_port "E2E_PG_PORT" "$PG_PORT"
CONTAINER="${E2E_PG_CONTAINER:-rails-pg}"
validate_container "E2E_PG_CONTAINER" "$CONTAINER"
PG_OWNER="${E2E_PG_OWNER:-}"
if [ -n "$PG_OWNER" ]; then
  validate_owner "E2E_PG_OWNER" "$PG_OWNER"
fi

IMAGE="postgres:17"
PG_HOST="127.0.0.1"
PG_USER="postgres"
PG_DB="sous_e2e"
DB_URL="postgres://${PG_USER}@${PG_HOST}:${PG_PORT}/${PG_DB}"

if ! command -v docker >/dev/null 2>&1; then
  echo "Docker is not installed. Install Docker before running the browser tests." >&2
  exit 1
fi

if ! docker info >/dev/null 2>&1; then
  echo "Docker is not running. Start Docker before running the browser tests." >&2
  exit 1
fi

NEED_CREATE=1
if [ -n "$PG_OWNER" ]; then
  if docker inspect "$CONTAINER" >/dev/null 2>&1; then
    printf 'Docker container "%s" already exists; refusing to reuse or remove it while E2E_PG_OWNER is set.\n' "$CONTAINER" >&2
    exit 1
  fi
elif docker inspect "$CONTAINER" >/dev/null 2>&1; then
  STATE=$(docker inspect --format '{{.State.Running}}|{{with (index .HostConfig.PortBindings "5432/tcp")}}{{range .}}{{.HostIp}}:{{.HostPort}}{{end}}{{end}}|{{range .Config.Env}}{{if eq . "POSTGRES_HOST_AUTH_METHOD=trust"}}trust{{end}}{{end}}' "$CONTAINER" 2>/dev/null || true)
  if [ "$STATE" = "true|${PG_HOST}:${PG_PORT}|trust" ]; then
    NEED_CREATE=0
  else
    docker rm -f "$CONTAINER" >/dev/null
  fi
fi

if [ "$NEED_CREATE" -eq 1 ]; then
  if [ -n "$PG_OWNER" ]; then
    docker run -d \
      --name "$CONTAINER" \
      --label "sous.e2e.owner=${PG_OWNER}" \
      -e "POSTGRES_USER=${PG_USER}" \
      -e "POSTGRES_HOST_AUTH_METHOD=trust" \
      -e "POSTGRES_DB=postgres" \
      -p "${PG_HOST}:${PG_PORT}:5432" \
      "$IMAGE" >/dev/null
  else
    docker run -d \
      --name "$CONTAINER" \
      -e "POSTGRES_USER=${PG_USER}" \
      -e "POSTGRES_HOST_AUTH_METHOD=trust" \
      -e "POSTGRES_DB=postgres" \
      -p "${PG_HOST}:${PG_PORT}:5432" \
      "$IMAGE" >/dev/null
  fi
fi

MAX_ATTEMPTS=30
ATTEMPTS=0
READY=0
while [ "$ATTEMPTS" -lt "$MAX_ATTEMPTS" ]; do
  if docker exec "$CONTAINER" pg_isready -h 127.0.0.1 -p 5432 -U "$PG_USER" >/dev/null 2>&1; then
    READY=1
    break
  fi
  ATTEMPTS=$((ATTEMPTS + 1))
  sleep 1
done

if [ "$READY" -eq 1 ]; then
  READY=0
  while [ "$ATTEMPTS" -lt "$MAX_ATTEMPTS" ]; do
    if docker exec "$CONTAINER" psql -w -h 127.0.0.1 -U "$PG_USER" -d postgres -tAc 'select 1' >/dev/null 2>&1; then
      READY=1
      break
    fi
    ATTEMPTS=$((ATTEMPTS + 1))
    sleep 1
  done
fi

if [ "$READY" -ne 1 ]; then
  echo "PostgreSQL container ${CONTAINER} did not become ready within 30 seconds." >&2
  exit 1
fi

docker exec "$CONTAINER" psql -w -U "$PG_USER" -d postgres -v ON_ERROR_STOP=1 -c "DROP DATABASE IF EXISTS ${PG_DB} WITH (FORCE);" >/dev/null
docker exec "$CONTAINER" psql -w -U "$PG_USER" -d postgres -v ON_ERROR_STOP=1 -c "CREATE DATABASE ${PG_DB};" >/dev/null

SCRIPT_DIR=$(CDPATH='' cd -- "$(dirname -- "$0")" && pwd)
APP_DIR=$(CDPATH='' cd -- "$SCRIPT_DIR/.." && pwd)
(cd "$APP_DIR" && DATABASE_URL="$DB_URL" pnpm db:migrate >/dev/null)

echo "E2E PostgreSQL ready at ${DB_URL} (container ${CONTAINER})."
