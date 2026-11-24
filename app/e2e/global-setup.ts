/**
 * Playwright global setup: seeds the E2E database and creates its snapshot
 * schema before any browser test runs.
 */

import { execFileSync } from "node:child_process";
import path from "node:path";
import { E2E_DATABASE_URL, assertLocalDatabase } from "./env";

export default function globalSetup(): void {
  assertLocalDatabase(E2E_DATABASE_URL);
  const appDir = path.resolve(__dirname, "..");
  const tsxCli = path.join(appDir, "node_modules/tsx/dist/cli.mjs");
  const seedCli = path.join(appDir, "e2e/seed-cli.ts");

  const env: NodeJS.ProcessEnv = {
    NODE_ENV: "test",
    DATABASE_URL: E2E_DATABASE_URL,
    SOUS_SIGN_IN: "off",
  };
  if (process.env.PATH !== undefined) env.PATH = process.env.PATH;
  if (process.env.HOME !== undefined) env.HOME = process.env.HOME;
  if (process.env.E2E_APP_PORT !== undefined) {
    env.E2E_APP_PORT = process.env.E2E_APP_PORT;
  }
  if (process.env.E2E_PG_PORT !== undefined) {
    env.E2E_PG_PORT = process.env.E2E_PG_PORT;
  }
  if (process.env.E2E_PG_CONTAINER !== undefined) {
    env.E2E_PG_CONTAINER = process.env.E2E_PG_CONTAINER;
  }

  try {
    execFileSync(process.execPath, [tsxCli, seedCli], {
      cwd: appDir,
      env,
      stdio: "inherit",
    });
  } catch {
    throw new Error(
      "E2E global setup failed while seeding the database. Ensure PostgreSQL is up via `pnpm --dir app e2e:db:up`.",
    );
  }
}
