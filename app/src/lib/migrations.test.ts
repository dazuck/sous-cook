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
import { eq } from "drizzle-orm";
import { drizzle } from "drizzle-orm/pglite";
import { migrate } from "drizzle-orm/pglite/migrator";
import { describe, expect, it } from "vitest";
import * as schema from "../../drizzle/schema";
import {
  homeKitchen,
  mintToken,
  seedKitchen,
  seedQueueRow,
  snapshotRow,
} from "./__tests__/kitchens";
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

  it("MIG-2: backfills existing rows in all five owned tables onto the home kitchen", async () => {
    const cut = migrationsUpTo(0);
    const { client, db } = await migratedTestDb(cut.dir);
    try {
      const reportId = "0f8fad5b-d9cb-469f-a165-70867728950e";
      await client.exec(`
        INSERT INTO "kitchen_queue" ("recipe_data", "target_user", "status")
        VALUES
          ('{"name":"Dal"}'::jsonb, 'cook', 'pending'),
          ('{"name":"Tacos"}'::jsonb, 'someone-else', 'pending');

        INSERT INTO "doc_recipes" ("doc_slug", "name", "raw_doc_text")
        VALUES ('dal', 'Dal', 'Dal recipe');

        INSERT INTO "recipe_ideas_cache" ("text")
        VALUES ('Weeknight stir-fry');

        INSERT INTO "conversation_logs" ("session_id", "role", "content")
        VALUES ('session-1', 'user', 'How hot should the pan be?');

        INSERT INTO "cook_reports" (
          "id", "captured_at", "build", "path", "screen", "recipe_name",
          "state", "context", "events", "dom"
        ) VALUES (
          '${reportId}',
          '2026-10-09T10:00:00.000Z',
          'test-build-1',
          '/kitchen/queue/1',
          'step',
          'Dal',
          '{"mode":"first"}'::jsonb,
          '{"online":true}'::jsonb,
          '[]'::jsonb,
          '<div>step</div>'
        );
      `);

      await migrate(db, { migrationsFolder: MIGRATIONS_DIR });

      const home = await homeKitchen(db);
      expect(home.slug).toBe("home");
      expect(home.name).toBe("Home");

      const queueRows = await client.query<{
        target_user: string;
        kitchen_id: string | null;
      }>(
        `SELECT target_user, kitchen_id FROM "kitchen_queue" ORDER BY target_user`,
      );
      expect(queueRows.rows).toEqual([
        { target_user: "cook", kitchen_id: home.id },
        { target_user: "someone-else", kitchen_id: home.id },
      ]);

      const docRows = await client.query<{ kitchen_id: string | null }>(
        `SELECT kitchen_id FROM "doc_recipes"`,
      );
      expect(docRows.rows).toEqual([{ kitchen_id: home.id }]);

      const ideasRows = await client.query<{ kitchen_id: string | null }>(
        `SELECT kitchen_id FROM "recipe_ideas_cache"`,
      );
      expect(ideasRows.rows).toEqual([{ kitchen_id: home.id }]);

      const logRows = await client.query<{ kitchen_id: string | null }>(
        `SELECT kitchen_id FROM "conversation_logs"`,
      );
      expect(logRows.rows).toEqual([{ kitchen_id: home.id }]);

      const reportRows = await client.query<{
        id: string;
        kitchen_id: string | null;
      }>(`SELECT id, kitchen_id FROM "cook_reports"`);
      expect(reportRows.rows).toEqual([{ id: reportId, kitchen_id: home.id }]);
    } finally {
      await client.close();
      cut.cleanup();
    }
  }, 15_000);

  it("MIG-3: backfills rows written with a null kitchen_id since 0001, deduplicates recipe_ideas_cache per kitchen, and enforces not-null and unique constraints", async () => {
    const cut = migrationsUpTo(2);
    const { client, db } = await migratedTestDb(cut.dir);
    try {
      const homeResult = await client.query<{ id: string }>(
        `SELECT id FROM "kitchens" WHERE "slug" = 'home' LIMIT 1`,
      );
      const home = homeResult.rows[0];
      if (!home) throw new Error("Default home kitchen missing at migration 0002");
      // At migration 0002, auth_user and members do not exist yet, so insert
      // the second kitchen row directly without columns added in later migrations.
      const otherResult = await client.query<{ id: string }>(
        `INSERT INTO "kitchens" ("slug", "name") VALUES ('other-kitchen', 'Other Kitchen') RETURNING "id"`,
      );
      const other = otherResult.rows[0];
      if (!other) throw new Error("Failed to insert other-kitchen");

      const reportId = "1f8fad5b-d9cb-469f-a165-70867728950e";
      const ideaOlderId = "00000000-0000-4000-8000-000000000010";
      const ideaNewerId = "00000000-0000-4000-8000-000000000020";
      const ideaTieLowId = "00000000-0000-4000-8000-000000000030";
      const ideaTieHighId = "00000000-0000-4000-8000-000000000040";

      await client.exec(`
        -- Rows written with null kitchen_id between 0001 and 0003 in all five owned tables.
        INSERT INTO "kitchen_queue" ("kitchen_id", "recipe_data", "status")
        VALUES (NULL, '{"name":"Null Kitchen Soup"}'::jsonb, 'pending');

        INSERT INTO "doc_recipes" ("kitchen_id", "doc_slug", "name", "raw_doc_text")
        VALUES (NULL, 'null-kitchen-dal', 'Null Kitchen Dal', 'Dal recipe');

        INSERT INTO "conversation_logs" ("kitchen_id", "session_id", "role", "content")
        VALUES (NULL, 'null-session', 'user', 'Hello');

        INSERT INTO "cook_reports" (
          "id", "kitchen_id", "captured_at", "build", "path", "screen", "recipe_name",
          "state", "context", "events", "dom"
        ) VALUES (
          '${reportId}',
          NULL,
          '2026-10-10T10:00:00.000Z',
          'test-build-2',
          '/kitchen/queue/2',
          'step',
          'Dal',
          '{"mode":"first"}'::jsonb,
          '{"online":true}'::jsonb,
          '[]'::jsonb,
          '<div>step</div>'
        );

        -- Home gets two recipe_ideas_cache rows (one older with null kitchen_id, one newer with home's id).
        INSERT INTO "recipe_ideas_cache" ("id", "kitchen_id", "text", "synced_at")
        VALUES
          ('${ideaOlderId}', NULL, 'Older home ideas', '2026-10-01T10:00:00.000Z'),
          ('${ideaNewerId}', '${home.id}', 'Newer home ideas', '2026-10-02T10:00:00.000Z');

        -- Other kitchen gets two recipe_ideas_cache rows with the exact same synced_at: higher id survives.
        INSERT INTO "recipe_ideas_cache" ("id", "kitchen_id", "text", "synced_at")
        VALUES
          ('${ideaTieLowId}', '${other.id}', 'Tied low id', '2026-10-03T10:00:00.000Z'),
          ('${ideaTieHighId}', '${other.id}', 'Tied high id', '2026-10-03T10:00:00.000Z');
      `);

      await migrate(db, { migrationsFolder: MIGRATIONS_DIR });

      // All previously-null rows now belong to home.
      const queueRows = await client.query<{ kitchen_id: string }>(
        `SELECT kitchen_id FROM "kitchen_queue"`,
      );
      expect(queueRows.rows).toEqual([{ kitchen_id: home.id }]);

      const docRows = await client.query<{ kitchen_id: string; doc_slug: string }>(
        `SELECT kitchen_id, doc_slug FROM "doc_recipes"`,
      );
      expect(docRows.rows).toEqual([
        { kitchen_id: home.id, doc_slug: "null-kitchen-dal" },
      ]);

      const logRows = await client.query<{ kitchen_id: string }>(
        `SELECT kitchen_id FROM "conversation_logs"`,
      );
      expect(logRows.rows).toEqual([{ kitchen_id: home.id }]);

      const reportRows = await client.query<{ id: string; kitchen_id: string }>(
        `SELECT id, kitchen_id FROM "cook_reports"`,
      );
      expect(reportRows.rows).toEqual([{ id: reportId, kitchen_id: home.id }]);

      // Exactly one ideas cache row survives per kitchen: newer for home, higher id for tie.
      const ideasRows = await client.query<{
        id: string;
        kitchen_id: string;
        text: string;
      }>(
        `SELECT id, kitchen_id, text FROM "recipe_ideas_cache" ORDER BY id`,
      );
      expect(ideasRows.rows).toEqual([
        { id: ideaNewerId, kitchen_id: home.id, text: "Newer home ideas" },
        { id: ideaTieHighId, kitchen_id: other.id, text: "Tied high id" },
      ]);

      // Two kitchens can hold the same doc_slug after the unique constraint swap.
      await client.exec(`
        INSERT INTO "doc_recipes" ("kitchen_id", "doc_slug", "name", "raw_doc_text")
        VALUES ('${other.id}', 'null-kitchen-dal', 'Other Dal', 'Other Dal recipe');
      `);

      // Unique constraint on recipe_ideas_cache (kitchen_id) holds.
      await expect(
        client.exec(`
          INSERT INTO "recipe_ideas_cache" ("kitchen_id", "text")
          VALUES ('${home.id}', 'Duplicate home ideas');
        `),
      ).rejects.toThrow(/recipe_ideas_cache_kitchen_unique/);

      // Not-null constraint on kitchen_id holds.
      await expect(
        client.exec(`
          INSERT INTO "kitchen_queue" ("kitchen_id", "recipe_data", "status")
          VALUES (NULL, '{"name":"Rejected"}'::jsonb, 'pending');
        `),
      ).rejects.toThrow(/kitchen_id/);
    } finally {
      await client.close();
      cut.cleanup();
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
    const cut = migrationsUpTo(0);
    const mocked = await mockDbModule(cut.dir);
    try {
      const catalog = await readCatalog(mocked.db);
      expect(catalog.tables.map((t) => t.table)).not.toContain("kitchens");
      expect(catalog.tables.map((t) => t.table)).not.toContain(
        "kitchen_webhook_tokens",
      );
      expect(catalog.tables.map((t) => t.table)).toContain("kitchen_queue");
    } finally {
      await mocked.client.close();
      cut.cleanup();
    }
  }, 15_000);

  it("test helpers: kitchens helpers seed kitchens, queue rows, hashed tokens, and row snapshots", async () => {
    const { client, db } = await migratedTestDb();
    try {
      const home = await homeKitchen(db);
      expect(home.slug).toBe("home");

      const { kitchen } = await seedKitchen(db, {
        slug: "north-house",
        name: "North House",
        aiMonthlyCapMicros: 2_000_000,
      });
      expect(kitchen.slug).toBe("north-house");
      expect(kitchen.aiMonthlyCapMicros).toBe(2_000_000);

      const queueRow = await seedQueueRow(db, kitchen.id, {
        recipeData: { name: "Roast Chicken" },
      });
      expect(queueRow.kitchenId).toBe(kitchen.id);
      expect(await snapshotRow(db, schema.kitchenQueue, queueRow.id)).toEqual(
        queueRow,
      );

      const plaintext = await mintToken(db, kitchen.id, "agent");
      expect(plaintext).toMatch(/^sous_[A-Za-z0-9_-]+$/);
      const expectedHash = createHash("sha256").update(plaintext).digest("hex");
      const [storedToken] = await db
        .select()
        .from(schema.kitchenWebhookTokens)
        .where(eq(schema.kitchenWebhookTokens.kitchenId, kitchen.id));
      expect(storedToken?.tokenSha256).toBe(expectedHash);
      expect(storedToken?.label).toBe("agent");

      // Check constraints and restrict foreign key hold.
      await expect(
        seedKitchen(db, { slug: "Bad Slug", name: "Bad" }),
      ).rejects.toThrow();
      await expect(
        seedKitchen(db, {
          slug: "neg-cap",
          name: "Negative",
          aiMonthlyCapMicros: -1,
        }),
      ).rejects.toThrow();
      await expect(
        db.delete(schema.kitchens).where(eq(schema.kitchens.id, kitchen.id)),
      ).rejects.toThrow();
    } finally {
      await client.close();
    }
  }, 15_000);

  it("0004 sign_in constraints: members, invites partial uniques, user cascade, and member_id set null hold", async () => {
    const expectConstraint = async (
      promise: Promise<unknown>,
      constraintName: string,
    ) => {
      try {
        await promise;
      } catch (err) {
        const messages: string[] = [];
        let cur: unknown = err;
        const seen = new Set<unknown>();
        while (cur instanceof Error && !seen.has(cur)) {
          seen.add(cur);
          messages.push(cur.message);
          cur = cur.cause;
        }
        expect(messages.join("\n")).toContain(constraintName);
        return;
      }
      throw new Error(`Expected query to fail with constraint "${constraintName}"`);
    };

    const { client, db } = await migratedTestDb();
    try {
      const home = await homeKitchen(db);

      await db.insert(schema.authUser).values({
        id: "user-1",
        name: "Alice",
        email: "alice@example.com",
        emailVerified: true,
      });

      const [member] = await db
        .insert(schema.members)
        .values({
          kitchenId: home.id,
          userId: "user-1",
          role: "owner",
        })
        .returning();
      expect(member?.userId).toBe("user-1");

      // One kitchen per person: second member row for same user_id fails.
      await expectConstraint(
        db.insert(schema.members).values({
          kitchenId: home.id,
          userId: "user-1",
          role: "cook",
        }),
        "members_user_id_unique",
      );

      // Unnormalized invite email fails check constraint.
      await expectConstraint(
        db.insert(schema.invites).values({
          email: "Upper@Example.com",
          kitchenId: home.id,
          role: "cook",
        }),
        "invites_email_normalized",
      );

      // New-kitchen invite must be role=owner and set both name and slug.
      await expectConstraint(
        db.insert(schema.invites).values({
          email: "bob@example.com",
          newKitchenName: "Bob Kitchen",
          newKitchenSlug: "bob-kitchen",
          role: "cook",
        }),
        "invites_new_kitchen_owner",
      );

      // Live invite unique on email; pending invite unique on slug.
      await db.insert(schema.invites).values({
        email: "bob@example.com",
        newKitchenName: "Bob Kitchen",
        newKitchenSlug: "bob-kitchen",
        role: "owner",
      });
      await expectConstraint(
        db.insert(schema.invites).values({
          email: "bob@example.com",
          kitchenId: home.id,
          role: "cook",
        }),
        "invites_live_email_unique",
      );
      await expectConstraint(
        db.insert(schema.invites).values({
          email: "carol@example.com",
          newKitchenName: "Carol Kitchen",
          newKitchenSlug: "bob-kitchen",
          role: "owner",
        }),
        "invites_pending_slug_unique",
      );

      // Storing member_id on conversation_logs and cook_reports; deleting auth_user
      // cascades to members and sets member_id to null on logs and reports.
      const [logRow] = await db
        .insert(schema.conversationLogs)
        .values({
          kitchenId: home.id,
          memberId: member!.id,
          sessionId: "sess-1",
          role: "user",
          content: "hi",
        })
        .returning();
      const reportId = "4f8fad5b-d9cb-469f-a165-70867728950e";
      await db.insert(schema.cookReports).values({
        id: reportId,
        kitchenId: home.id,
        memberId: member!.id,
        capturedAt: new Date("2026-10-10T10:00:00.000Z"),
        build: "test-build",
        path: "/kitchen",
        screen: "step",
        recipeName: "Dal",
        state: { mode: "go", pos: 0, ticked: [], passed: [], kept: [] },
        context: {
          viewport: { w: 1024, h: 768, dpr: 2 },
          ua: "test",
          online: true,
          voice: { mode: null, status: "idle" },
          ask: { sessionId: "sess-1", open: false },
          layers: { pane: false, card: null, more: false },
          part: null,
        },
        events: [],
        dom: "<div/>",
      });

      await db.delete(schema.authUser).where(eq(schema.authUser.id, "user-1"));

      const remainingMembers = await db.select().from(schema.members);
      expect(remainingMembers).toEqual([]);
      const updatedLog = await snapshotRow(db, schema.conversationLogs, logRow!.id);
      expect(updatedLog?.memberId).toBeNull();
      const updatedReport = await snapshotRow(db, schema.cookReports, reportId);
      expect(updatedReport?.memberId).toBeNull();
    } finally {
      await client.close();
    }
  }, 15_000);

  it("0005 ai_usage constraints: feature, provider, status, nonnegative amounts, settled_at pairing, and member_id set null hold", async () => {
    const expectConstraint = async (
      promise: Promise<unknown>,
      constraintName: string,
    ) => {
      try {
        await promise;
      } catch (err) {
        const messages: string[] = [];
        let cur: unknown = err;
        const seen = new Set<unknown>();
        while (cur instanceof Error && !seen.has(cur)) {
          seen.add(cur);
          messages.push(cur.message);
          cur = cur.cause;
        }
        expect(messages.join("\n")).toContain(constraintName);
        return;
      }
      throw new Error(`Expected query to fail with constraint "${constraintName}"`);
    };

    const { client, db } = await migratedTestDb();
    try {
      const { kitchen, member, user } = await seedKitchen(db, {
        slug: "meter-kitchen",
        name: "Meter Kitchen",
      });

      const [reserved] = await db
        .insert(schema.aiUsage)
        .values({
          kitchenId: kitchen.id,
          memberId: member.id,
          feature: "ask",
          provider: "google",
          model: "gemini-3.5-flash",
          status: "reserved",
          reservedMicros: 1500,
        })
        .returning();
      expect(reserved?.status).toBe("reserved");
      expect(reserved?.settledAt).toBeNull();

      // Settled row without settled_at violates ai_usage_settled_has_time.
      await expectConstraint(
        db.insert(schema.aiUsage).values({
          kitchenId: kitchen.id,
          feature: "ask",
          provider: "google",
          model: "gemini-3.5-flash",
          status: "settled",
          reservedMicros: 1500,
          costMicros: 900,
          settledAt: null,
        }),
        "ai_usage_settled_has_time",
      );

      // Reserved row with settled_at violates ai_usage_settled_has_time.
      await expectConstraint(
        db.insert(schema.aiUsage).values({
          kitchenId: kitchen.id,
          feature: "ask",
          provider: "google",
          model: "gemini-3.5-flash",
          status: "reserved",
          reservedMicros: 1500,
          settledAt: new Date("2026-11-22T00:00:00.000Z"),
        }),
        "ai_usage_settled_has_time",
      );

      // Negative reserved_micros or cost_micros fails check constraints.
      await expectConstraint(
        db.insert(schema.aiUsage).values({
          kitchenId: kitchen.id,
          feature: "ask",
          provider: "google",
          model: "gemini-3.5-flash",
          status: "reserved",
          reservedMicros: -1,
        }),
        "ai_usage_reserved_nonnegative",
      );
      await expectConstraint(
        db.insert(schema.aiUsage).values({
          kitchenId: kitchen.id,
          feature: "ask",
          provider: "google",
          model: "gemini-3.5-flash",
          status: "settled",
          reservedMicros: 100,
          costMicros: -1,
          settledAt: new Date("2026-11-22T00:00:00.000Z"),
        }),
        "ai_usage_cost_nonnegative",
      );

      // Unknown feature or provider fails check constraints.
      await expectConstraint(
        client.exec(
          `INSERT INTO "ai_usage" ("kitchen_id", "feature", "provider", "model", "status", "reserved_micros") VALUES ('${kitchen.id}', 'unknown', 'google', 'm', 'reserved', 0)`,
        ),
        "ai_usage_feature_known",
      );
      await expectConstraint(
        client.exec(
          `INSERT INTO "ai_usage" ("kitchen_id", "feature", "provider", "model", "status", "reserved_micros") VALUES ('${kitchen.id}', 'ask', 'openai', 'm', 'reserved', 0)`,
        ),
        "ai_usage_provider_known",
      );

      // Deleting the user cascades to members and sets ai_usage.member_id to null.
      await db.delete(schema.authUser).where(eq(schema.authUser.id, user.id));
      const updated = await snapshotRow(db, schema.aiUsage, reserved!.id);
      expect(updated?.memberId).toBeNull();

      // Deleting the kitchen is restricted while ai_usage rows reference it.
      await expectConstraint(
        db.delete(schema.kitchens).where(eq(schema.kitchens.id, kitchen.id)),
        "ai_usage_kitchen_id_kitchens_id_fk",
      );
    } finally {
      await client.close();
    }
  }, 15_000);
});
