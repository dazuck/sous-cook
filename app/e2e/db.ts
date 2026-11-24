/**
 * Test-side PostgreSQL helpers for browser specs.
 * Maintains a single connection per Playwright worker and always validates
 * the database URL with assertLocalDatabase before connecting.
 */

import postgres from "postgres";
import { E2E_DATABASE_URL, assertLocalDatabase } from "./env";
import { restoreSql } from "./snapshot";

let client: ReturnType<typeof postgres> | null = null;

function getClient(): ReturnType<typeof postgres> {
  if (client !== null) return client;
  assertLocalDatabase(E2E_DATABASE_URL);
  client = postgres(E2E_DATABASE_URL, {
    max: 1,
    prepare: false,
    connect_timeout: 10,
    onnotice: () => {},
  });
  return client;
}

export async function closeDb(): Promise<void> {
  if (client === null) return;
  const active = client;
  client = null;
  await active.end({ timeout: 5 });
}

export async function restoreSeed(): Promise<void> {
  await getClient().unsafe(restoreSql());
}

export interface QueueRowSummary {
  id: string;
  kitchenId: string;
  name: string | null;
  status: string;
  hasCookPlan: boolean;
  cookPlanError: string | null;
  finishedBy: string | null;
  startedAt: Date | null;
  completedAt: Date | null;
}

interface RawQueueRow {
  id: string;
  kitchen_id: string;
  recipe_name: string | null;
  status: string;
  has_cook_plan: boolean;
  cook_plan_error: string | null;
  finished_by: string | null;
  started_at: Date | null;
  completed_at: Date | null;
}

function mapQueueRow(row: RawQueueRow): QueueRowSummary {
  return {
    id: row.id,
    kitchenId: row.kitchen_id,
    name: row.recipe_name,
    status: row.status,
    hasCookPlan: row.has_cook_plan,
    cookPlanError: row.cook_plan_error,
    finishedBy: row.finished_by,
    startedAt: row.started_at,
    completedAt: row.completed_at,
  };
}

export async function getHomeKitchenId(): Promise<string> {
  const rows = await getClient()<{ id: string }[]>`
    SELECT id FROM public.kitchens WHERE slug = 'home' LIMIT 1
  `;
  if (rows.length === 0) {
    throw new Error('Home kitchen (slug "home") not found in database');
  }
  return rows[0]!.id;
}

export async function readQueueRowByName(
  name: string,
): Promise<QueueRowSummary | null> {
  const rows = await getClient()<RawQueueRow[]>`
    SELECT
      id,
      kitchen_id,
      recipe_data->>'name' AS recipe_name,
      status,
      (cook_plan IS NOT NULL) AS has_cook_plan,
      cook_plan_error,
      finished_by,
      started_at,
      completed_at
    FROM public.kitchen_queue
    WHERE recipe_data->>'name' = ${name}
    ORDER BY created_at DESC
    LIMIT 1
  `;
  return rows[0] ? mapQueueRow(rows[0]) : null;
}

export async function readQueueRowById(
  id: string,
): Promise<QueueRowSummary | null> {
  const rows = await getClient()<RawQueueRow[]>`
    SELECT
      id,
      kitchen_id,
      recipe_data->>'name' AS recipe_name,
      status,
      (cook_plan IS NOT NULL) AS has_cook_plan,
      cook_plan_error,
      finished_by,
      started_at,
      completed_at
    FROM public.kitchen_queue
    WHERE id = ${id}::uuid
    LIMIT 1
  `;
  return rows[0] ? mapQueueRow(rows[0]) : null;
}

export async function countQueueRows(): Promise<number> {
  const rows = await getClient()<{ count: string }[]>`
    SELECT count(*)::text AS count FROM public.kitchen_queue
  `;
  return Number(rows[0]!.count);
}

export interface AuthCounts {
  kitchens: number;
  members: number;
  invites: number;
}

export async function readAuthCounts(): Promise<AuthCounts> {
  const sql = getClient();
  const [kitchenCount] = await sql<{ count: string }[]>`
    SELECT count(*)::text AS count FROM public.kitchens
  `;
  const [memberCount] = await sql<{ count: string }[]>`
    SELECT count(*)::text AS count FROM public.members
  `;
  const [inviteCount] = await sql<{ count: string }[]>`
    SELECT count(*)::text AS count FROM public.invites
  `;
  return {
    kitchens: Number(kitchenCount!.count),
    members: Number(memberCount!.count),
    invites: Number(inviteCount!.count),
  };
}

/**
 * Setup helper used to put named seeded rows into another status before a page
 * loads (for example, cancelling every pending row to reach the idle home state).
 */
export async function setQueueRowStatus(
  name: string,
  status: "pending" | "cooking" | "completed" | "cancelled",
): Promise<void> {
  const updated = await getClient()<{ id: string }[]>`
    UPDATE public.kitchen_queue
    SET status = ${status}
    WHERE recipe_data->>'name' = ${name}
    RETURNING id
  `;
  if (updated.length === 0) {
    throw new Error(`No kitchen_queue row found with recipe name "${name}"`);
  }
}
