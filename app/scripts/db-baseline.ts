/**
 * Records the baseline migration (0000) in `drizzle.__drizzle_migrations` for
 * an existing database that was originally created with `db:push`.
 *
 * Run once against a pre-migration database, then run `pnpm --dir app db:migrate`:
 *
 *   DATABASE_URL=postgres://... pnpm --dir app db:baseline
 *
 * Refuses without modifying the database if migrations are already recorded,
 * if the existing `public` schema does not match the baseline, or if a table
 * created by a later migration is already present.
 */

import path from "node:path";
import { fileURLToPath } from "node:url";
import { drizzle } from "drizzle-orm/postgres-js";
import postgres from "postgres";
import { BaselineRefusalError, baselineDatabase } from "../src/lib/db-baseline";

const migrationsFolder = path.resolve(
  path.dirname(fileURLToPath(import.meta.url)),
  "../drizzle/migrations",
);

async function main(): Promise<void> {
  const connectionString = process.env.DATABASE_URL;
  if (!connectionString) {
    throw new Error("DATABASE_URL environment variable is required");
  }

  const client = postgres(connectionString, {
    max: 1,
    prepare: false,
    connect_timeout: 10,
    onnotice: () => {},
  });

  try {
    const db = drizzle(client);
    const result = await baselineDatabase(db, migrationsFolder);
    for (const warning of result.warnings) {
      console.warn(`Warning: ${warning}`);
    }
    console.log(
      `Baselined database at ${result.tag} (hash ${result.hash}, created_at ${result.createdAt}).`,
    );
    console.log("Next: run `pnpm --dir app db:migrate` to apply later migrations.");
  } finally {
    await client.end();
  }
}

main().catch((err) => {
  if (err instanceof Error) {
    console.error(err.message);
    const seen = new Set<Error>([err]);
    let cause: unknown = err.cause;
    while (cause instanceof Error && !seen.has(cause)) {
      seen.add(cause);
      console.error(cause.message);
      cause = cause.cause;
    }
    if (err instanceof BaselineRefusalError) {
      for (const warning of err.warnings) {
        console.warn(`Warning: ${warning}`);
      }
    }
  } else {
    console.error(err);
  }
  process.exit(1);
});
