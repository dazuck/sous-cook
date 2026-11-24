/**
 * Pure SQL text builders for snapshotting and restoring the seeded database state.
 * The same SQL runs on PostgreSQL 17 in the browser suite and on PGlite in Vitest.
 */

export const E2E_SNAPSHOT_SCHEMA = "e2e_seed";

/**
 * Every table that tests or single-kitchen routes can write.
 * Checked against app/drizzle/schema.ts: kitchens, members, invites, the auth_*
 * tables, and Drizzle migration bookkeeping are never copied or truncated.
 * None of these tables have foreign keys referencing one another.
 */
export const E2E_DATA_TABLES = [
  "kitchen_queue",
  "doc_recipes",
  "recipe_ideas_cache",
  "conversation_logs",
  "cook_reports",
  "ai_usage",
  "kitchen_webhook_tokens",
] as const;

export type E2eDataTable = (typeof E2E_DATA_TABLES)[number];

/**
 * Empties all data tables without touching kitchens, auth tables, or migrations.
 */
export function truncateDataTablesSql(): string {
  const list = E2E_DATA_TABLES.map((table) => `public.${table}`).join(", ");
  return `TRUNCATE TABLE ${list};`;
}

/**
 * Copies each data table into the `e2e_seed` schema, dropping and recreating
 * each snapshot copy.
 */
export function snapshotSql(): string {
  const statements: string[] = [`CREATE SCHEMA IF NOT EXISTS ${E2E_SNAPSHOT_SCHEMA};`];
  for (const table of E2E_DATA_TABLES) {
    statements.push(`DROP TABLE IF EXISTS ${E2E_SNAPSHOT_SCHEMA}.${table};`);
    statements.push(
      `CREATE TABLE ${E2E_SNAPSHOT_SCHEMA}.${table} AS SELECT * FROM public.${table};`,
    );
  }
  return statements.join("\n");
}

/**
 * Truncates all data tables together in a single statement, then restores every
 * row from the `e2e_seed` snapshot schema.
 */
export function restoreSql(): string {
  const statements: string[] = [truncateDataTablesSql()];
  for (const table of E2E_DATA_TABLES) {
    statements.push(
      `INSERT INTO public.${table} SELECT * FROM ${E2E_SNAPSHOT_SCHEMA}.${table};`,
    );
  }
  return statements.join("\n");
}
