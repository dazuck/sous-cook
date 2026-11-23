import {
  cpSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import os from "node:os";
import path from "node:path";
import { PGlite } from "@electric-sql/pglite";
import { drizzle } from "drizzle-orm/pglite";
import { migrate } from "drizzle-orm/pglite/migrator";
import { describe, expect, it } from "vitest";
import * as schema from "../../drizzle/schema";
import {
  MIGRATIONS_DIR,
  migratedTestDb,
  migrationsUpTo,
  mockDbModule,
} from "./__tests__/test-db";
import { readCatalog } from "./db-baseline";

interface JournalEntry {
  idx: number;
  version: string;
  when: number;
  tag: string;
  breakpoints: boolean;
}

interface JournalFile {
  version: string;
  dialect: string;
  entries: JournalEntry[];
}

describe("Database migrations", () => {
  it("MIG-1: applied migrations produce the exact same catalog as pushing the Drizzle schema", async () => {
    const migrated = await migratedTestDb();
    const pushedClient = new PGlite();
    try {
      const pushedDb = drizzle(pushedClient, { schema });
      const { generateDrizzleJson, generateMigration } = await import(
        "drizzle-kit/api"
      );
      const statements = await generateMigration(
        generateDrizzleJson({}),
        generateDrizzleJson(schema),
      );
      for (const statement of statements) {
        await pushedClient.exec(statement);
      }

      const migratedCatalog = await readCatalog(migrated.db);
      const pushedCatalog = await readCatalog(pushedDb);

      expect(migratedCatalog.tables.length).toBeGreaterThan(0);
      expect(migratedCatalog).toEqual(pushedCatalog);
      // PostgreSQL 18 stores NOT NULL as pg_constraint rows of type 'n', while
      // PostgreSQL 16 and 17 do not. readCatalog filters to types p, u, c, f so
      // catalogs built on PGlite (PG 18) match PostgreSQL 16 and 17.
      expect(
        migratedCatalog.constraints.filter((c) =>
          c.definition.startsWith("NOT NULL"),
        ),
      ).toEqual([]);
    } finally {
      await migrated.client.close();
      await pushedClient.close();
    }
  }, 15_000);

  it("MIG-4: a migration that fails part-way rolls back its DDL and records no migration row", async () => {
    const tmpDir = mkdtempSync(path.join(os.tmpdir(), "sous-mig4-"));
    const client = new PGlite();
    try {
      cpSync(MIGRATIONS_DIR, tmpDir, { recursive: true });
      const journalPath = path.join(tmpDir, "meta", "_journal.json");
      const journal = JSON.parse(
        readFileSync(journalPath, "utf8"),
      ) as JournalFile;
      const lastWhen = journal.entries[journal.entries.length - 1]?.when ?? 0;
      const failingWhen = lastWhen + 1000;
      const failingTag = "0099_failing_migration";

      writeFileSync(
        path.join(tmpDir, `${failingTag}.sql`),
        [
          `CREATE TABLE "mig4_partial_probe" ("id" integer PRIMARY KEY);`,
          `--> statement-breakpoint`,
          `ALTER TABLE "table_that_does_not_exist" ADD COLUMN "x" text;`,
        ].join("\n"),
      );
      journal.entries.push({
        idx: 99,
        version: "7",
        when: failingWhen,
        tag: failingTag,
        breakpoints: true,
      });
      writeFileSync(journalPath, JSON.stringify(journal, null, 2));

      const db = drizzle(client, { schema });
      // First apply the real migrations so 0099 is the pending failing migration.
      await migrate(db, { migrationsFolder: MIGRATIONS_DIR });

      await expect(
        migrate(db, { migrationsFolder: tmpDir }),
      ).rejects.toThrow(/table_that_does_not_exist/);

      // The table created by 0099's first statement was rolled back.
      const tableCheck = await client.query<{ reg: string | null }>(
        `SELECT to_regclass('public.mig4_partial_probe') AS reg`,
      );
      expect(tableCheck.rows[0]?.reg).toBeNull();

      // No __drizzle_migrations row exists for 0099.
      const migRows = await client.query<{ created_at: string }>(
        `SELECT created_at FROM "drizzle"."__drizzle_migrations" WHERE created_at = $1`,
        [failingWhen],
      );
      expect(migRows.rows).toHaveLength(0);

      // On a fresh database as well, migrating the folder rolls back everything cleanly.
      const freshClient = new PGlite();
      try {
        const freshDb = drizzle(freshClient, { schema });
        await expect(
          migrate(freshDb, { migrationsFolder: tmpDir }),
        ).rejects.toThrow(/table_that_does_not_exist/);
        const freshProbe = await freshClient.query<{ reg: string | null }>(
          `SELECT to_regclass('public.mig4_partial_probe') AS reg`,
        );
        expect(freshProbe.rows[0]?.reg).toBeNull();
        const freshMigRows = await freshClient.query<{ created_at: string }>(
          `SELECT created_at FROM "drizzle"."__drizzle_migrations"`,
        );
        expect(freshMigRows.rows).toHaveLength(0);
      } finally {
        await freshClient.close();
      }
    } finally {
      await client.close();
      rmSync(tmpDir, { recursive: true, force: true });
    }
  }, 15_000);

  it("MIG-5: every table in public has row-level security enabled after all migrations", async () => {
    const { client, db } = await migratedTestDb();
    try {
      const catalog = await readCatalog(db);
      expect(catalog.tables.length).toBeGreaterThan(0);
      for (const table of catalog.tables) {
        expect(table.rlsEnabled, `RLS should be enabled on ${table.table}`).toBe(
          true,
        );
      }
    } finally {
      await client.close();
    }
  }, 15_000);

  it("test helpers: migrationsUpTo cuts later entries and mockDbModule provides a migrated database", async () => {
    const tmpDir = mkdtempSync(path.join(os.tmpdir(), "sous-upto-src-"));
    try {
      cpSync(MIGRATIONS_DIR, tmpDir, { recursive: true });
      const journalPath = path.join(tmpDir, "meta", "_journal.json");
      const journal = JSON.parse(
        readFileSync(journalPath, "utf8"),
      ) as JournalFile;
      journal.entries.push({
        idx: 1,
        version: "7",
        when: (journal.entries[0]?.when ?? 0) + 1000,
        tag: "0001_extra",
        breakpoints: true,
      });
      writeFileSync(
        path.join(tmpDir, "0001_extra.sql"),
        `CREATE TABLE "extra_only_in_0001" ("id" integer PRIMARY KEY);`,
      );
      writeFileSync(journalPath, JSON.stringify(journal, null, 2));

      const cut = migrationsUpTo(0, tmpDir);
      const mocked = await mockDbModule(cut.dir);
      try {
        const catalog = await readCatalog(mocked.db);
        expect(catalog.tables.map((t) => t.table)).not.toContain(
          "extra_only_in_0001",
        );
        expect(catalog.tables.map((t) => t.table)).toContain("kitchen_queue");
      } finally {
        await mocked.client.close();
        cut.cleanup();
      }
    } finally {
      rmSync(tmpDir, { recursive: true, force: true });
    }
  }, 15_000);
});
