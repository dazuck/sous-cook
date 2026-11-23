import { createHash } from "node:crypto";
import { readdirSync, readFileSync } from "node:fs";
import path from "node:path";
import { PGlite } from "@electric-sql/pglite";
import { sql, type SQL } from "drizzle-orm";
import { drizzle } from "drizzle-orm/pglite";

export interface SqlExecutor {
  execute(query: SQL): PromiseLike<unknown>;
}

export interface TransactionalDb extends SqlExecutor {
  transaction<T>(fn: (tx: SqlExecutor) => Promise<T>): Promise<T>;
}

export interface CatalogTable {
  table: string;
  rlsEnabled: boolean;
}

export interface CatalogColumn {
  table: string;
  column: string;
  dataType: string;
  udtName: string;
  isNullable: string;
  columnDefault: string | null;
}

export interface CatalogConstraint {
  table: string;
  name: string;
  definition: string;
}

export interface CatalogIndex {
  table: string;
  name: string;
  definition: string;
}

export interface SchemaCatalog {
  tables: CatalogTable[];
  columns: CatalogColumn[];
  constraints: CatalogConstraint[];
  indexes: CatalogIndex[];
}

export interface BaselineResult {
  tag: string;
  hash: string;
  createdAt: number;
  warnings: string[];
}

export class BaselineRefusalError extends Error {
  readonly differences: string[];
  readonly warnings: string[];

  constructor(differences: string[], warnings: string[] = []) {
    const lines = [
      "Refused to baseline database:",
      ...differences.map((diff) => `  - ${diff}`),
    ];
    super(lines.join("\n"));
    this.name = "BaselineRefusalError";
    this.differences = differences;
    this.warnings = warnings;
  }
}

interface JournalEntry {
  idx: number;
  version: string;
  when: number;
  tag: string;
  breakpoints: boolean;
}

interface JournalFile {
  entries: JournalEntry[];
}

interface SnapshotTableEntry {
  name?: unknown;
  schema?: unknown;
}

interface SnapshotFile {
  tables?: Record<string, SnapshotTableEntry>;
}

function compareStrings(a: string, b: string): number {
  return a < b ? -1 : a > b ? 1 : 0;
}

function normalizeSqlDef(definition: string): string {
  return definition.replace(/\s+/g, " ").trim();
}

function extractRows<T extends Record<string, unknown>>(result: unknown): T[] {
  if (Array.isArray(result)) {
    return result as T[];
  }
  if (
    result !== null &&
    typeof result === "object" &&
    "rows" in result &&
    Array.isArray((result as { rows: unknown }).rows)
  ) {
    return (result as { rows: T[] }).rows;
  }
  throw new Error("Unexpected query result shape from database driver");
}

/**
 * Reads the PostgreSQL catalog for tables in the `public` schema.
 *
 * Sets `search_path` to `public` inside a local transaction so
 * `pg_get_constraintdef` and `pg_indexes.indexdef` qualify identifiers the
 * same way on every connection. Filters `pg_constraint` to types p, u, c, f
 * (excluding Postgres 18's type n not-null constraints; nullability is read
 * from `information_schema.columns`). Columns are sorted by table and column
 * name rather than ordinal position so additive column history does not
 * produce false differences.
 */
export async function readCatalog(
  db: TransactionalDb,
  tables?: readonly string[],
): Promise<SchemaCatalog> {
  const tableFilter = tables === undefined ? null : new Set(tables);

  return db.transaction(async (tx) => {
    await tx.execute(sql`SET LOCAL search_path TO public`);

    const rawTables = extractRows<{ table_name: string; rls_enabled: boolean }>(
      await tx.execute(sql`
        SELECT c.relname AS table_name, c.relrowsecurity AS rls_enabled
        FROM pg_class c
        JOIN pg_namespace n ON n.oid = c.relnamespace
        WHERE n.nspname = 'public' AND c.relkind = 'r'
      `),
    );

    const rawColumns = extractRows<{
      table_name: string;
      column_name: string;
      data_type: string;
      udt_name: string;
      is_nullable: string;
      column_default: string | null;
    }>(
      await tx.execute(sql`
        SELECT
          table_name,
          column_name,
          data_type,
          udt_name,
          is_nullable,
          column_default
        FROM information_schema.columns
        WHERE table_schema = 'public'
      `),
    );

    const rawConstraints = extractRows<{
      table_name: string;
      constraint_name: string;
      definition: string;
    }>(
      await tx.execute(sql`
        SELECT
          c.relname AS table_name,
          con.conname AS constraint_name,
          pg_get_constraintdef(con.oid) AS definition
        FROM pg_constraint con
        JOIN pg_class c ON c.oid = con.conrelid
        JOIN pg_namespace n ON n.oid = c.relnamespace
        WHERE n.nspname = 'public'
          AND c.relkind = 'r'
          AND con.contype IN ('p', 'u', 'c', 'f')
      `),
    );

    const rawIndexes = extractRows<{
      table_name: string;
      index_name: string;
      definition: string;
    }>(
      await tx.execute(sql`
        SELECT
          tablename AS table_name,
          indexname AS index_name,
          indexdef AS definition
        FROM pg_indexes
        WHERE schemaname = 'public'
      `),
    );

    const matchesTable = (name: string): boolean =>
      tableFilter === null || tableFilter.has(name);

    const catalogTables: CatalogTable[] = rawTables
      .filter((row) => matchesTable(row.table_name))
      .map((row) => ({
        table: row.table_name,
        rlsEnabled: Boolean(row.rls_enabled),
      }))
      .sort((a, b) => compareStrings(a.table, b.table));

    const catalogColumns: CatalogColumn[] = rawColumns
      .filter((row) => matchesTable(row.table_name))
      .map((row) => ({
        table: row.table_name,
        column: row.column_name,
        dataType: row.data_type,
        udtName: row.udt_name,
        isNullable: row.is_nullable,
        columnDefault: row.column_default,
      }))
      .sort(
        (a, b) =>
          compareStrings(a.table, b.table) ||
          compareStrings(a.column, b.column),
      );

    const catalogConstraints: CatalogConstraint[] = rawConstraints
      .filter((row) => matchesTable(row.table_name))
      .map((row) => ({
        table: row.table_name,
        name: row.constraint_name,
        definition: normalizeSqlDef(row.definition),
      }))
      .sort(
        (a, b) =>
          compareStrings(a.table, b.table) || compareStrings(a.name, b.name),
      );

    const catalogIndexes: CatalogIndex[] = rawIndexes
      .filter((row) => matchesTable(row.table_name))
      .map((row) => ({
        table: row.table_name,
        name: row.index_name,
        definition: normalizeSqlDef(row.definition),
      }))
      .sort(
        (a, b) =>
          compareStrings(a.table, b.table) || compareStrings(a.name, b.name),
      );

    return {
      tables: catalogTables,
      columns: catalogColumns,
      constraints: catalogConstraints,
      indexes: catalogIndexes,
    };
  });
}

/**
 * Compares two schema catalogs and returns a plain-English list of every
 * difference found.
 */
export function diffCatalogs(
  expected: SchemaCatalog,
  actual: SchemaCatalog,
): string[] {
  const diffs: string[] = [];

  const expectedTables = new Map(expected.tables.map((t) => [t.table, t]));
  const actualTables = new Map(actual.tables.map((t) => [t.table, t]));

  for (const [tableName, expTable] of expectedTables) {
    const actTable = actualTables.get(tableName);
    if (!actTable) {
      diffs.push(`Missing table "${tableName}"`);
      continue;
    }
    if (actTable.rlsEnabled !== expTable.rlsEnabled) {
      diffs.push(
        `Table "${tableName}": row-level security is ${actTable.rlsEnabled ? "on" : "off"} (expected ${expTable.rlsEnabled ? "on" : "off"})`,
      );
    }
  }
  for (const tableName of actualTables.keys()) {
    if (!expectedTables.has(tableName)) {
      diffs.push(`Unexpected table "${tableName}"`);
    }
  }

  // Only compare columns, constraints, and indexes for tables that exist on both sides
  const sharedTables = new Set(
    [...expectedTables.keys()].filter((name) => actualTables.has(name)),
  );

  const expectedCols = new Map(
    expected.columns
      .filter((c) => sharedTables.has(c.table))
      .map((c) => [`${c.table}.${c.column}`, c]),
  );
  const actualCols = new Map(
    actual.columns
      .filter((c) => sharedTables.has(c.table))
      .map((c) => [`${c.table}.${c.column}`, c]),
  );

  for (const [key, expCol] of expectedCols) {
    const actCol = actualCols.get(key);
    if (!actCol) {
      diffs.push(`Table "${expCol.table}": missing column "${expCol.column}"`);
      continue;
    }
    if (actCol.dataType !== expCol.dataType) {
      diffs.push(
        `Table "${expCol.table}", column "${expCol.column}": data_type is "${actCol.dataType}" (expected "${expCol.dataType}")`,
      );
    }
    if (actCol.udtName !== expCol.udtName) {
      diffs.push(
        `Table "${expCol.table}", column "${expCol.column}": udt_name is "${actCol.udtName}" (expected "${expCol.udtName}")`,
      );
    }
    if (actCol.isNullable !== expCol.isNullable) {
      diffs.push(
        `Table "${expCol.table}", column "${expCol.column}": is_nullable is "${actCol.isNullable}" (expected "${expCol.isNullable}")`,
      );
    }
    if (actCol.columnDefault !== expCol.columnDefault) {
      diffs.push(
        `Table "${expCol.table}", column "${expCol.column}": column_default is ${JSON.stringify(actCol.columnDefault)} (expected ${JSON.stringify(expCol.columnDefault)})`,
      );
    }
  }
  for (const [key, actCol] of actualCols) {
    if (!expectedCols.has(key)) {
      diffs.push(
        `Table "${actCol.table}": unexpected column "${actCol.column}"`,
      );
    }
  }

  const expectedConstraints = new Map(
    expected.constraints
      .filter((c) => sharedTables.has(c.table))
      .map((c) => [`${c.table}.${c.name}`, c]),
  );
  const actualConstraints = new Map(
    actual.constraints
      .filter((c) => sharedTables.has(c.table))
      .map((c) => [`${c.table}.${c.name}`, c]),
  );

  for (const [key, expCon] of expectedConstraints) {
    const actCon = actualConstraints.get(key);
    if (!actCon) {
      diffs.push(
        `Table "${expCon.table}": missing constraint "${expCon.name}" (${expCon.definition})`,
      );
      continue;
    }
    if (actCon.definition !== expCon.definition) {
      diffs.push(
        `Table "${expCon.table}", constraint "${expCon.name}": definition is "${actCon.definition}" (expected "${expCon.definition}")`,
      );
    }
  }
  for (const [key, actCon] of actualConstraints) {
    if (!expectedConstraints.has(key)) {
      diffs.push(
        `Table "${actCon.table}": unexpected constraint "${actCon.name}" (${actCon.definition})`,
      );
    }
  }

  const expectedIndexes = new Map(
    expected.indexes
      .filter((i) => sharedTables.has(i.table))
      .map((i) => [`${i.table}.${i.name}`, i]),
  );
  const actualIndexes = new Map(
    actual.indexes
      .filter((i) => sharedTables.has(i.table))
      .map((i) => [`${i.table}.${i.name}`, i]),
  );

  for (const [key, expIdx] of expectedIndexes) {
    const actIdx = actualIndexes.get(key);
    if (!actIdx) {
      diffs.push(
        `Table "${expIdx.table}": missing index "${expIdx.name}" (${expIdx.definition})`,
      );
      continue;
    }
    if (actIdx.definition !== expIdx.definition) {
      diffs.push(
        `Table "${expIdx.table}", index "${expIdx.name}": definition is "${actIdx.definition}" (expected "${expIdx.definition}")`,
      );
    }
  }
  for (const [key, actIdx] of actualIndexes) {
    if (!expectedIndexes.has(key)) {
      diffs.push(
        `Table "${actIdx.table}": unexpected index "${actIdx.name}" (${actIdx.definition})`,
      );
    }
  }

  return diffs;
}

function readBaselineEntry(migrationsFolder: string): {
  entry: JournalEntry;
  sqlText: string;
  hash: string;
} {
  const journalPath = path.join(migrationsFolder, "meta", "_journal.json");
  const journal = JSON.parse(readFileSync(journalPath, "utf8")) as JournalFile;
  const entry = journal.entries.find((e) => e.idx === 0) ?? journal.entries[0];
  if (!entry) {
    throw new Error(`No baseline entry found in ${journalPath}`);
  }
  const sqlPath = path.join(migrationsFolder, `${entry.tag}.sql`);
  const sqlText = readFileSync(sqlPath, "utf8");
  const hash = createHash("sha256").update(sqlText).digest("hex");
  return { entry, sqlText, hash };
}

/**
 * Reads table names declared in the newest Drizzle snapshot in `meta/` that
 * do not belong to the baseline migration.
 */
function readLaterMigrationTables(
  migrationsFolder: string,
  baselineTables: ReadonlySet<string>,
): Set<string> {
  const metaDir = path.join(migrationsFolder, "meta");
  const snapshotFiles = readdirSync(metaDir)
    .map((fileName) => {
      const match = /^(\d+)_snapshot\.json$/.exec(fileName);
      return match ? { fileName, num: Number.parseInt(match[1]!, 10) } : null;
    })
    .filter((entry): entry is { fileName: string; num: number } => entry !== null)
    .sort((a, b) => a.num - b.num);

  if (snapshotFiles.length === 0) {
    return new Set();
  }

  const newest = snapshotFiles[snapshotFiles.length - 1]!;
  const snapshot = JSON.parse(
    readFileSync(path.join(metaDir, newest.fileName), "utf8"),
  ) as SnapshotFile;

  const laterTables = new Set<string>();
  for (const entry of Object.values(snapshot.tables ?? {})) {
    const schema = typeof entry.schema === "string" ? entry.schema : "";
    if (schema !== "" && schema !== "public") continue;
    if (typeof entry.name === "string" && !baselineTables.has(entry.name)) {
      laterTables.add(entry.name);
    }
  }
  return laterTables;
}

async function buildReferenceCatalog(sqlText: string): Promise<SchemaCatalog> {
  const client = new PGlite();
  try {
    const refDb = drizzle(client);
    const statements = sqlText
      .split("--> statement-breakpoint")
      .map((statement) => statement.trim())
      .filter((statement) => statement.length > 0);
    for (const statement of statements) {
      await refDb.execute(sql.raw(statement));
    }
    return await readCatalog(refDb);
  } finally {
    await client.close();
  }
}

async function migrationTableRowCount(executor: SqlExecutor): Promise<number> {
  const regRows = extractRows<{ reg: string | null }>(
    await executor.execute(
      sql`SELECT to_regclass('drizzle.__drizzle_migrations') AS reg`,
    ),
  );
  if (!regRows[0]?.reg) {
    return 0;
  }
  const countRows = extractRows<{ count: number }>(
    await executor.execute(
      sql`SELECT count(*)::int AS count FROM "drizzle"."__drizzle_migrations"`,
    ),
  );
  return Number(countRows[0]?.count ?? 0);
}

/**
 * Marks an existing database (previously created with `db:push`) as having
 * applied the baseline migration (0000), so `drizzle-kit migrate` can apply
 * subsequent migrations cleanly.
 *
 * Refuses if `drizzle.__drizzle_migrations` already has rows, if the baseline
 * tables differ from what 0000 creates, or if any table created by a later
 * migration already exists in `public`. Extra unrelated tables are returned
 * as warnings rather than refusals.
 */
export async function baselineDatabase(
  db: TransactionalDb,
  migrationsFolder: string,
): Promise<BaselineResult> {
  const existingRows = await migrationTableRowCount(db);
  if (existingRows > 0) {
    throw new BaselineRefusalError([
      `Migration table drizzle.__drizzle_migrations already contains ${existingRows} row(s); database is already tracked by migrations`,
    ]);
  }

  const { entry, sqlText, hash } = readBaselineEntry(migrationsFolder);
  const referenceCatalog = await buildReferenceCatalog(sqlText);
  const baselineTableNames = referenceCatalog.tables.map((t) => t.table);
  const baselineTableSet = new Set(baselineTableNames);
  const laterMigrationTables = readLaterMigrationTables(
    migrationsFolder,
    baselineTableSet,
  );

  const allPublicRelations = extractRows<{ name: string; relkind: string }>(
    await db.execute(sql`
      SELECT c.relname AS name, c.relkind::text AS relkind
      FROM pg_class c
      JOIN pg_namespace n ON n.oid = c.relnamespace
      WHERE n.nspname = 'public'
    `),
  ).sort((a, b) => compareStrings(a.name, b.name));

  // Types that are not a table's own row type or an array type: enums,
  // domains, ranges. Creating a table also creates a type with the table's
  // name, so one of these with a later table's name makes that migration fail.
  const standalonePublicTypes = extractRows<{ name: string }>(
    await db.execute(sql`
      SELECT t.typname AS name
      FROM pg_type t
      JOIN pg_namespace n ON n.oid = t.typnamespace
      WHERE n.nspname = 'public' AND t.typrelid = 0 AND t.typelem = 0
    `),
  ).sort((a, b) => compareStrings(a.name, b.name));

  const targetCatalog = await readCatalog(db, baselineTableNames);
  const differences = diffCatalogs(referenceCatalog, targetCatalog);
  const warnings: string[] = [];

  for (const type of standalonePublicTypes) {
    if (laterMigrationTables.has(type.name)) {
      differences.push(
        `Type "${type.name}" already exists, but a later migration creates a table with that name`,
      );
    }
  }

  for (const relation of allPublicRelations) {
    if (baselineTableSet.has(relation.name)) continue;
    if (laterMigrationTables.has(relation.name)) {
      const kind = relation.relkind === "r" ? "Table" : "Relation";
      differences.push(
        `${kind} "${relation.name}" already exists, but is created by a later migration`,
      );
    } else if (relation.relkind === "r") {
      warnings.push(
        `Extra table "${relation.name}" is not part of the baseline; leaving it untouched`,
      );
    }
  }

  if (differences.length > 0) {
    throw new BaselineRefusalError(differences, warnings);
  }

  await db.transaction(async (tx) => {
    await tx.execute(sql`CREATE SCHEMA IF NOT EXISTS "drizzle"`);
    await tx.execute(sql`
      CREATE TABLE IF NOT EXISTS "drizzle"."__drizzle_migrations" (
        id SERIAL PRIMARY KEY,
        hash text NOT NULL,
        created_at bigint
      )
    `);
    await tx.execute(
      sql`LOCK TABLE "drizzle"."__drizzle_migrations" IN EXCLUSIVE MODE`,
    );
    const countInsideTx = await migrationTableRowCount(tx);
    if (countInsideTx > 0) {
      throw new BaselineRefusalError([
        `Migration table drizzle.__drizzle_migrations already contains ${countInsideTx} row(s); database is already tracked by migrations`,
      ]);
    }
    await tx.execute(
      sql`INSERT INTO "drizzle"."__drizzle_migrations" ("hash", "created_at") VALUES (${hash}, ${entry.when})`,
    );
  });

  return {
    tag: entry.tag,
    hash,
    createdAt: entry.when,
    warnings,
  };
}
