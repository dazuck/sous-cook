import { createHash } from "node:crypto";
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
import { pgTable, text, uuid } from "drizzle-orm/pg-core";
import { drizzle } from "drizzle-orm/pglite";
import { migrate } from "drizzle-orm/pglite/migrator";
import { describe, expect, it } from "vitest";
import * as schema from "../../drizzle/schema";
import {
  MIGRATIONS_DIR,
  migratedTestDb,
  migrationsUpTo,
} from "./__tests__/test-db";
import {
  BaselineRefusalError,
  baselineDatabase,
  readCatalog,
} from "./db-baseline";

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

function readBaselineMigration(): {
  entry: JournalEntry;
  sqlText: string;
  hash: string;
} {
  const journal = JSON.parse(
    readFileSync(path.join(MIGRATIONS_DIR, "meta", "_journal.json"), "utf8"),
  ) as JournalFile;
  const entry = journal.entries[0]!;
  const sqlText = readFileSync(
    path.join(MIGRATIONS_DIR, `${entry.tag}.sql`),
    "utf8",
  );
  const hash = createHash("sha256").update(sqlText).digest("hex");
  return { entry, sqlText, hash };
}

async function execBaselineSqlDirectly(client: PGlite): Promise<void> {
  const { sqlText } = readBaselineMigration();
  for (const statement of sqlText.split("--> statement-breakpoint")) {
    const trimmed = statement.trim();
    if (trimmed.length > 0) {
      await client.exec(trimmed);
    }
  }
}

async function createFixtureWithLaterTable(): Promise<{
  dir: string;
  cleanup: () => void;
}> {
  const cut = migrationsUpTo(0);
  const dir = mkdtempSync(path.join(os.tmpdir(), "sous-baseline-fixture-"));
  try {
    cpSync(cut.dir, dir, { recursive: true });
  } finally {
    cut.cleanup();
  }

  const kitchens = pgTable("kitchens", {
    id: uuid("id").primaryKey().defaultRandom(),
    slug: text("slug").notNull().unique(),
    name: text("name").notNull(),
  }).enableRLS();

  const { generateDrizzleJson } = await import("drizzle-kit/api");
  const baselineSnapshot = JSON.parse(
    readFileSync(path.join(dir, "meta", "0000_snapshot.json"), "utf8"),
  ) as { tables: Record<string, unknown> };
  const kitchensSnapshot = generateDrizzleJson({ kitchens });
  const snapshot0001 = {
    ...baselineSnapshot,
    tables: {
      ...baselineSnapshot.tables,
      ...kitchensSnapshot.tables,
    },
  };

  const journalPath = path.join(dir, "meta", "_journal.json");
  const journal = JSON.parse(readFileSync(journalPath, "utf8")) as JournalFile;
  const nextWhen = (journal.entries[0]?.when ?? 0) + 1000;
  journal.entries.push({
    idx: 1,
    version: "7",
    when: nextWhen,
    tag: "0001_kitchens",
    breakpoints: true,
  });
  writeFileSync(journalPath, JSON.stringify(journal, null, 2));
  writeFileSync(
    path.join(dir, "meta", "0001_snapshot.json"),
    JSON.stringify(snapshot0001, null, 2),
  );
  writeFileSync(
    path.join(dir, "0001_kitchens.sql"),
    [
      `CREATE TABLE "kitchens" (`,
      `  "id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,`,
      `  "slug" text NOT NULL,`,
      `  "name" text NOT NULL,`,
      `  CONSTRAINT "kitchens_slug_unique" UNIQUE("slug")`,
      `);`,
      `--> statement-breakpoint`,
      `ALTER TABLE "kitchens" ENABLE ROW LEVEL SECURITY;`,
    ].join("\n"),
  );

  return {
    dir,
    cleanup: () => rmSync(dir, { recursive: true, force: true }),
  };
}

async function expectRefusal(
  fn: () => Promise<unknown>,
): Promise<BaselineRefusalError> {
  try {
    await fn();
  } catch (err) {
    expect(err).toBeInstanceOf(BaselineRefusalError);
    return err as BaselineRefusalError;
  }
  throw new Error("Expected baselineDatabase to throw BaselineRefusalError");
}

describe("Database baseline", () => {
  describe("BASE-1: baselines a database built from 0000 SQL directly and lets migrate apply 0001 onward", () => {
    it("records the 0000 row so migrate leaves the catalog equal to MIG-1", async () => {
      const { entry, hash } = readBaselineMigration();
      const client = new PGlite();
      const reference = await migratedTestDb();
      try {
        await execBaselineSqlDirectly(client);
        const db = drizzle(client, { schema });

        const result = await baselineDatabase(db, MIGRATIONS_DIR);
        expect(result).toEqual({
          tag: entry.tag,
          hash,
          createdAt: entry.when,
          warnings: [],
        });

        const recorded = await client.query<{
          hash: string;
          created_at: string;
        }>(`SELECT hash, created_at FROM "drizzle"."__drizzle_migrations"`);
        expect(recorded.rows).toHaveLength(1);
        expect(recorded.rows[0]?.hash).toBe(hash);
        expect(Number(recorded.rows[0]?.created_at)).toBe(entry.when);

        // Running migrate after baseline succeeds without re-running 0000.
        await migrate(db, { migrationsFolder: MIGRATIONS_DIR });
        expect(await readCatalog(db)).toEqual(await readCatalog(reference.db));
      } finally {
        await client.close();
        await reference.client.close();
      }
    }, 15_000);

    it("skips 0000 and applies 0001 onward against a folder with later migrations", async () => {
      const fixture = await createFixtureWithLaterTable();
      const fixtureClient = new PGlite();
      const fromScratch = await migratedTestDb(fixture.dir);
      try {
        await execBaselineSqlDirectly(fixtureClient);
        const fixtureDb = drizzle(fixtureClient, { schema });

        await baselineDatabase(fixtureDb, fixture.dir);
        await migrate(fixtureDb, { migrationsFolder: fixture.dir });

        const migRows = await fixtureClient.query<{ hash: string }>(
          `SELECT hash FROM "drizzle"."__drizzle_migrations"`,
        );
        expect(migRows.rows).toHaveLength(2);
        expect(await readCatalog(fixtureDb)).toEqual(
          await readCatalog(fromScratch.db),
        );
      } finally {
        await fixtureClient.close();
        await fromScratch.client.close();
        fixture.cleanup();
      }
    }, 15_000);
  });

  describe("BASE-2: refusal and acceptance rules", () => {
    it("refuses when drizzle.__drizzle_migrations already has rows", async () => {
      const { client, db } = await migratedTestDb();
      try {
        const err = await expectRefusal(() =>
          baselineDatabase(db, MIGRATIONS_DIR),
        );
        expect(err.message).toMatch(/__drizzle_migrations/);
      } finally {
        await client.close();
      }
    }, 15_000);

    it("accepts when drizzle.__drizzle_migrations exists but is empty", async () => {
      const client = new PGlite();
      try {
        await execBaselineSqlDirectly(client);
        await client.exec(`
          CREATE SCHEMA "drizzle";
          CREATE TABLE "drizzle"."__drizzle_migrations" (
            id SERIAL PRIMARY KEY,
            hash text NOT NULL,
            created_at bigint
          );
        `);
        const db = drizzle(client, { schema });

        const result = await baselineDatabase(db, MIGRATIONS_DIR);
        expect(result.tag).toBe("0000_baseline");
      } finally {
        await client.close();
      }
    }, 15_000);

    it("refuses when a baseline column is missing and lists the difference", async () => {
      const client = new PGlite();
      try {
        await execBaselineSqlDirectly(client);
        await client.exec(
          `ALTER TABLE "kitchen_queue" DROP COLUMN "last_interaction_at"`,
        );
        const db = drizzle(client, { schema });

        const err = await expectRefusal(() =>
          baselineDatabase(db, MIGRATIONS_DIR),
        );
        expect(err.message).toMatch(/kitchen_queue.*last_interaction_at/);
      } finally {
        await client.close();
      }
    }, 15_000);

    it("refuses when doc_recipes unique constraint exists under another name and lists the difference", async () => {
      const client = new PGlite();
      try {
        await execBaselineSqlDirectly(client);
        await client.exec(`
          ALTER TABLE "doc_recipes" DROP CONSTRAINT "doc_recipes_doc_slug_unique";
          ALTER TABLE "doc_recipes" ADD CONSTRAINT "doc_recipes_slug_custom_key" UNIQUE ("doc_slug");
        `);
        const db = drizzle(client, { schema });

        const err = await expectRefusal(() =>
          baselineDatabase(db, MIGRATIONS_DIR),
        );
        expect(err.message).toContain("doc_recipes_doc_slug_unique");
        expect(err.message).toContain("doc_recipes_slug_custom_key");
      } finally {
        await client.close();
      }
    }, 15_000);

    it("refuses when a baseline table has row-level security off and lists the difference", async () => {
      const client = new PGlite();
      try {
        await execBaselineSqlDirectly(client);
        await client.exec(
          `ALTER TABLE "cook_reports" DISABLE ROW LEVEL SECURITY`,
        );
        const db = drizzle(client, { schema });

        const err = await expectRefusal(() =>
          baselineDatabase(db, MIGRATIONS_DIR),
        );
        expect(err.message).toMatch(/cook_reports.*row-level security/i);
      } finally {
        await client.close();
      }
    }, 15_000);

    it("accepts a database built by a 0000-era db:push rather than the SQL file", async () => {
      const client = new PGlite();
      try {
        const { generateDrizzleJson, generateMigration } = await import(
          "drizzle-kit/api"
        );
        const baselineSnapshot = JSON.parse(
          readFileSync(
            path.join(MIGRATIONS_DIR, "meta", "0000_snapshot.json"),
            "utf8",
          ),
        );
        const statements = await generateMigration(
          generateDrizzleJson({}),
          baselineSnapshot,
        );
        for (const statement of statements) {
          await client.exec(statement);
        }
        const db = drizzle(client, { schema });

        const result = await baselineDatabase(db, MIGRATIONS_DIR);
        expect(result.tag).toBe("0000_baseline");
        expect(result.warnings).toEqual([]);
      } finally {
        await client.close();
      }
    }, 15_000);

    it("accepts a database whose columns are in a different ordinal order", async () => {
      const client = new PGlite();
      try {
        await execBaselineSqlDirectly(client);
        // Recreate recipe_ideas_cache with columns in a different ordinal order
        // (simulating additive column history from older alter scripts).
        await client.exec(`
          DROP TABLE "recipe_ideas_cache";
          CREATE TABLE "recipe_ideas_cache" (
            "synced_at" timestamp DEFAULT now() NOT NULL,
            "text" text NOT NULL,
            "id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL
          );
          ALTER TABLE "recipe_ideas_cache" ENABLE ROW LEVEL SECURITY;
        `);
        const db = drizzle(client, { schema });

        const result = await baselineDatabase(db, MIGRATIONS_DIR);
        expect(result.tag).toBe("0000_baseline");
      } finally {
        await client.close();
      }
    }, 15_000);

    it("warns without refusing when an unrelated extra table exists", async () => {
      const client = new PGlite();
      try {
        await execBaselineSqlDirectly(client);
        await client.exec(
          `CREATE TABLE "scratch_notes" ("id" integer PRIMARY KEY)`,
        );
        const db = drizzle(client, { schema });

        const result = await baselineDatabase(db, MIGRATIONS_DIR);
        expect(result.tag).toBe("0000_baseline");
        expect(result.warnings).toEqual([
          expect.stringContaining("scratch_notes"),
        ]);
      } finally {
        await client.close();
      }
    }, 15_000);

    it("refuses when a table created by a later migration (kitchens) already exists, against a fixture folder", async () => {
      const fixture = await createFixtureWithLaterTable();
      const client = new PGlite();
      try {
        await execBaselineSqlDirectly(client);
        await client.exec(
          `CREATE TABLE "kitchens" ("id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL, "slug" text NOT NULL)`,
        );
        const db = drizzle(client, { schema });

        const err = await expectRefusal(() =>
          baselineDatabase(db, fixture.dir),
        );
        expect(err.message).toMatch(/kitchens/);
      } finally {
        await client.close();
        fixture.cleanup();
      }
    }, 15_000);

    it("refuses when a view with the name of a later-migration table (kitchens) already exists", async () => {
      const fixture = await createFixtureWithLaterTable();
      const client = new PGlite();
      try {
        await execBaselineSqlDirectly(client);
        await client.exec(`CREATE VIEW "kitchens" AS SELECT 1 AS id`);
        const db = drizzle(client, { schema });

        const err = await expectRefusal(() =>
          baselineDatabase(db, fixture.dir),
        );
        expect(err.message).toMatch(/kitchens/);
      } finally {
        await client.close();
        fixture.cleanup();
      }
    }, 15_000);

    it("refuses when a table created by a later migration (kitchens) already exists, against the real migrations folder", async () => {
      const client = new PGlite();
      try {
        await execBaselineSqlDirectly(client);
        await client.exec(
          `CREATE TABLE "kitchens" ("id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL, "slug" text NOT NULL)`,
        );
        const db = drizzle(client, { schema });

        const err = await expectRefusal(() =>
          baselineDatabase(db, MIGRATIONS_DIR),
        );
        expect(err.message).toMatch(/kitchens/);
      } finally {
        await client.close();
      }
    }, 15_000);

    it("refuses when a table created by a later migration (kitchen_webhook_tokens) already exists, against the real migrations folder", async () => {
      const client = new PGlite();
      try {
        await execBaselineSqlDirectly(client);
        await client.exec(
          `CREATE TABLE "kitchen_webhook_tokens" ("id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL)`,
        );
        const db = drizzle(client, { schema });

        const err = await expectRefusal(() =>
          baselineDatabase(db, MIGRATIONS_DIR),
        );
        expect(err.message).toMatch(/kitchen_webhook_tokens/);
      } finally {
        await client.close();
      }
    }, 15_000);

    it("refuses when a view with the name of a later-migration table (kitchens) already exists, against the real migrations folder", async () => {
      const client = new PGlite();
      try {
        await execBaselineSqlDirectly(client);
        await client.exec(`CREATE VIEW "kitchens" AS SELECT 1 AS id`);
        const db = drizzle(client, { schema });

        const err = await expectRefusal(() =>
          baselineDatabase(db, MIGRATIONS_DIR),
        );
        expect(err.message).toMatch(/kitchens/);
      } finally {
        await client.close();
      }
    }, 15_000);
  });
});
