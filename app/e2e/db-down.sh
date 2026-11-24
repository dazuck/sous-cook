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

validate_port "E2E_APP_PORT" "${E2E_APP_PORT:-4131}"
validate_port "E2E_PG_PORT" "${E2E_PG_PORT:-55731}"
CONTAINER="${E2E_PG_CONTAINER:-rails-pg}"
validate_container "E2E_PG_CONTAINER" "$CONTAINER"

docker rm -f "$CONTAINER"
