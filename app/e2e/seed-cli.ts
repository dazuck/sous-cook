/**
 * CLI entry point that seeds the local E2E database and snapshots the seeded rows
 * into the `e2e_seed` schema. Run under tsx from `app/`.
 */

import postgres from "postgres";
import { getDb } from "@/lib/db";
import { assertLocalDatabase } from "./env";
import { seedDatabase } from "./seed";
import { snapshotSql } from "./snapshot";

async function closeDrizzlePool(): Promise<void> {
  const drizzleDb = getDb() as unknown as {
    $client?: { end?: () => Promise<void> };
  };
  if (typeof drizzleDb.$client?.end === "function") {
    await drizzleDb.$client.end();
  }
}

async function main(): Promise<void> {
  const databaseUrl = process.env.DATABASE_URL;
  if (!databaseUrl) {
    throw new Error("DATABASE_URL environment variable is required to seed the E2E database.");
  }
  assertLocalDatabase(databaseUrl);

  if (process.env.SOUS_SIGN_IN !== "off") {
    throw new Error(
      `Refusing to seed unless SOUS_SIGN_IN is "off" (got ${JSON.stringify(process.env.SOUS_SIGN_IN ?? "")}).`,
    );
  }

  let snapshotClient: ReturnType<typeof postgres> | null = null;
  try {
    await seedDatabase();
    snapshotClient = postgres(databaseUrl, {
      max: 1,
      prepare: false,
      connect_timeout: 10,
      onnotice: () => {},
    });
    await snapshotClient.unsafe(snapshotSql());
  } finally {
    if (snapshotClient !== null) {
      await snapshotClient.end();
    }
    await closeDrizzlePool();
  }
}

main()
  .then(() => {
    process.exit(0);
  })
  .catch((err) => {
    if (err instanceof Error) {
      console.error(err.message);
    } else {
      console.error(err);
    }
    process.exit(1);
  });
