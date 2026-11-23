import {
  cpSync,
  mkdtempSync,
  readdirSync,
  readFileSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { PGlite } from "@electric-sql/pglite";
import { drizzle } from "drizzle-orm/pglite";
import { migrate } from "drizzle-orm/pglite/migrator";
import * as schema from "../../../drizzle/schema";

/** Absolute path to the repository's Drizzle migrations folder. */
export const MIGRATIONS_DIR = fileURLToPath(
  new URL("../../../drizzle/migrations", import.meta.url),
);

/**
 * Creates a fresh in-memory PGlite database with Drizzle migrations applied.
 */
export async function migratedTestDb(
  migrationsFolder: string = MIGRATIONS_DIR,
) {
  const client = new PGlite();
  const db = drizzle(client, { schema });
  await migrate(db, { migrationsFolder });
  return { client, db };
}

/**
 * Returns a migrated in-memory database module shape suitable for
 * `vi.mock("@/lib/db", () => mockDbModule())`.
 */
export async function mockDbModule(migrationsFolder: string = MIGRATIONS_DIR) {
  const { client, db } = await migratedTestDb(migrationsFolder);
  return { ...schema, db, getDb: () => db, client };
}

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

/**
 * Copies the migrations folder into a temporary directory with the journal cut
 * after entry `n` (inclusive), removing later migration SQL and snapshot files.
 * Call `cleanup()` when done to remove the temporary directory.
 */
export function migrationsUpTo(
  n: number,
  sourceFolder: string = MIGRATIONS_DIR,
): { dir: string; cleanup: () => void } {
  const dir = mkdtempSync(path.join(os.tmpdir(), "sous-migrations-"));
  try {
    cpSync(sourceFolder, dir, { recursive: true });
    const metaDir = path.join(dir, "meta");
    const journalPath = path.join(metaDir, "_journal.json");
    const journal = JSON.parse(readFileSync(journalPath, "utf8")) as JournalFile;

    if (!journal.entries.some((entry) => entry.idx === n)) {
      throw new Error(
        `Migration index ${n} does not exist in ${sourceFolder} (available: ${journal.entries.map((e) => e.idx).join(", ")})`,
      );
    }

    const keptEntries = journal.entries.filter((entry) => entry.idx <= n);
    const droppedEntries = journal.entries.filter((entry) => entry.idx > n);

    for (const dropped of droppedEntries) {
      rmSync(path.join(dir, `${dropped.tag}.sql`), { force: true });
    }

    for (const fileName of readdirSync(metaDir)) {
      const match = /^(\d+)_snapshot\.json$/.exec(fileName);
      if (match && Number.parseInt(match[1]!, 10) > n) {
        rmSync(path.join(metaDir, fileName), { force: true });
      }
    }

    writeFileSync(
      journalPath,
      JSON.stringify({ ...journal, entries: keptEntries }, null, 2),
    );

    return {
      dir,
      cleanup: () => rmSync(dir, { recursive: true, force: true }),
    };
  } catch (err) {
    rmSync(dir, { recursive: true, force: true });
    throw err;
  }
}
