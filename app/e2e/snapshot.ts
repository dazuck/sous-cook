/**
 * Pure SQL text builders for snapshotting and restoring the seeded database state.
 * The same SQL runs on PostgreSQL 17 in the browser suite and on PGlite in Vitest.
 */

export const E2E_SNAPSHOT_SCHEMA = "e2e_seed";

/**
 * Every table that tests or single-kitchen routes can write.
 * Checked against app/drizzle/schema.ts: kitchens, members, invites, the auth_*
 * tables, and Drizzle migration bookkeeping are never copied or truncated.
 * `doc_recipes` precedes `kitchen_cook_log` because `kitchen_cook_log.doc_recipe_id`
 * references `doc_recipes(id)`. `kitchen_packs` precedes `kitchen_pack_shares`
 * because `kitchen_pack_shares.kitchen_pack_id` references `kitchen_packs(id)`.
 * `kitchen_pantry_sections` precedes `kitchen_pantry_items` because
 * `kitchen_pantry_items.section_id` references `kitchen_pantry_sections(id)`.
 */
export const E2E_DATA_TABLES = [
  "kitchen_queue",
  "doc_recipes",
  "recipe_ideas_cache",
  "conversation_logs",
  "cook_reports",
  "ai_usage",
  "kitchen_webhook_tokens",
  "kitchen_cook_log",
  "kitchen_packs",
  "kitchen_pack_shares",
  "kitchen_pantry_sections",
  "kitchen_pantry_items",
  "kitchen_shopping_list",
  "kitchen_ideas",
  "circles",
  "circle_members",
] as const;

const IDENTITY_TABLES: ReadonlySet<E2eDataTable> = new Set([
  "kitchen_cook_log",
  "kitchen_pantry_sections",
  "kitchen_pantry_items",
  "kitchen_shopping_list",
  "kitchen_ideas",
]);

export type E2eDataTable = (typeof E2E_DATA_TABLES)[number];

/**
 * Empties all data tables without touching kitchens, auth tables, or migrations.
 */
export function truncateDataTablesSql(): string {
  const list = E2E_DATA_TABLES.map((table) => `public.${table}`).join(", ");
  return `TRUNCATE TABLE ${list} RESTART IDENTITY;`;
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
    const override = IDENTITY_TABLES.has(table) ? " OVERRIDING SYSTEM VALUE" : "";
    statements.push(
      `INSERT INTO public.${table}${override} SELECT * FROM ${E2E_SNAPSHOT_SCHEMA}.${table};`,
    );
  }
  return statements.join("\n");
}
