/**
 * Constants for the browser test suite and local-database guard.
 * Reads only E2E_APP_PORT, E2E_PG_PORT, and E2E_PG_CONTAINER from the
 * environment (using fixed defaults when unset or empty); nothing else is read
 * from the shell environment so test runs stay isolated.
 */

const DEFAULT_PG_CONTAINER = "rails-pg";
const DEFAULT_PG_PORT = 55731;
const DEFAULT_APP_PORT = 4131;

const PORT_MIN = 1024;
const PORT_MAX = 65535;
const PORT_PATTERN = /^[1-9][0-9]*$/;
const CONTAINER_PATTERN = /^[A-Za-z0-9][A-Za-z0-9._-]*$/;

function readPortEnv(name: "E2E_APP_PORT" | "E2E_PG_PORT", fallback: number): number {
  const raw = process.env[name];
  if (raw === undefined || raw === "") {
    return fallback;
  }
  if (!PORT_PATTERN.test(raw)) {
    throw new Error(
      `${name} must be a whole number from ${PORT_MIN} to ${PORT_MAX} (got ${JSON.stringify(raw)})`,
    );
  }
  const value = Number(raw);
  if (!Number.isSafeInteger(value) || value < PORT_MIN || value > PORT_MAX) {
    throw new Error(
      `${name} must be a whole number from ${PORT_MIN} to ${PORT_MAX} (got ${JSON.stringify(raw)})`,
    );
  }
  return value;
}

function readContainerEnv(name: "E2E_PG_CONTAINER", fallback: string): string {
  const raw = process.env[name];
  if (raw === undefined || raw === "") {
    return fallback;
  }
  if (!CONTAINER_PATTERN.test(raw)) {
    throw new Error(
      `${name} must start with a letter or digit and contain only letters, digits, ".", "_" and "-" (got ${JSON.stringify(raw)})`,
    );
  }
  return raw;
}

export const E2E_PG_CONTAINER = readContainerEnv(
  "E2E_PG_CONTAINER",
  DEFAULT_PG_CONTAINER,
);
export const E2E_PG_IMAGE = "postgres:17";
export const E2E_PG_HOST = "127.0.0.1";
export const E2E_PG_PORT = readPortEnv("E2E_PG_PORT", DEFAULT_PG_PORT);
export const E2E_PG_USER = "postgres";
export const E2E_PG_DATABASE = "sous_e2e";
export const E2E_DATABASE_URL = `postgres://${E2E_PG_USER}@${E2E_PG_HOST}:${E2E_PG_PORT}/${E2E_PG_DATABASE}`;

export const E2E_APP_HOST = "127.0.0.1";
export const E2E_APP_PORT = readPortEnv("E2E_APP_PORT", DEFAULT_APP_PORT);
export const E2E_BASE_URL = `http://${E2E_APP_HOST}:${E2E_APP_PORT}`;

export const E2E_TIMEZONE = "Europe/London";
export const E2E_LOCALE = "en-US";

const LOCAL_HOSTS: ReadonlySet<string> = new Set(["127.0.0.1", "localhost"]);

/**
 * Throws unless `url` parses as a URL whose hostname is strictly `127.0.0.1`
 * or `localhost`. Never echoes an unparseable input in the error message so
 * credentials in a malformed string are not leaked.
 */
export function assertLocalDatabase(url: string): URL {
  let parsed: URL;
  try {
    parsed = new URL(url);
  } catch {
    throw new Error("Database URL is not a valid URL");
  }
  if (!LOCAL_HOSTS.has(parsed.hostname)) {
    throw new Error(
      `Refusing to connect to non-local database host "${parsed.hostname}"; expected 127.0.0.1 or localhost`,
    );
  }
  return parsed;
}
