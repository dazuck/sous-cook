import { and, asc, count, eq, inArray } from "drizzle-orm";
import type { PgDatabase, PgQueryResultHKT } from "drizzle-orm/pg-core";
import * as schema from "../../../drizzle/schema";
import {
  MAX_CIRCLE_MEMBERS,
  circleMembers,
  circles,
  db,
  kitchens,
} from "../db";
import { KitchenAdminError } from "./admin";
import { getDeploymentMode } from "./deployment";

export type CirclesDb = PgDatabase<PgQueryResultHKT, typeof schema>;

export const UUID_PATTERN =
  /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

export class KitchenCircleError extends KitchenAdminError {
  constructor(message: string) {
    super(message);
    this.name = "KitchenCircleError";
  }
}

export function assertSignInModeForCircles(
  command: string,
  env: Record<string, string | undefined> = process.env,
): void {
  if (getDeploymentMode(env) === "single-kitchen") {
    throw new KitchenCircleError(
      `Cannot run "${command}" in single-kitchen mode (SOUS_SIGN_IN=off): single-kitchen mode has no circles.`,
    );
  }
}

function parseCircleName(raw: string): string {
  const trimmed = raw.trim();
  if (trimmed.length < 1 || trimmed.length > 80) {
    throw new KitchenCircleError(
      "Circle name must be between 1 and 80 characters.",
    );
  }
  return trimmed;
}

function parseCircleId(raw: string): string {
  const trimmed = raw.trim();
  if (!UUID_PATTERN.test(trimmed)) {
    throw new KitchenCircleError(`Invalid circle id "${raw}".`);
  }
  return trimmed;
}

function errorChainMentions(err: unknown, text: string): boolean {
  const seen = new Set<unknown>();
  let current: unknown = err;
  while (current instanceof Error && !seen.has(current)) {
    if (current.message.includes(text)) return true;
    seen.add(current);
    current = current.cause;
  }
  return false;
}

export interface CreatedCircle {
  id: string;
  name: string;
  createdAt: Date;
}

export interface CircleMemberSummary {
  kitchenId: string;
  slug: string;
  name: string;
  joinedAt: Date;
}

export interface ListedCircle {
  id: string;
  name: string;
  createdAt: Date;
  members: CircleMemberSummary[];
}

export interface AddToCircleResult {
  circleId: string;
  circleName: string;
  kitchenId: string;
  kitchenSlug: string;
  kitchenName: string;
  joinedAt: Date;
}

export interface RemoveFromCircleResult {
  circleId: string;
  circleName: string;
  kitchenId: string;
  kitchenSlug: string;
  kitchenName: string;
}

/**
 * Creates a new closed circle of kitchens. Refused in single-kitchen mode.
 */
export async function createCircle(
  input: { name: string },
  database: CirclesDb = db,
  env: Record<string, string | undefined> = process.env,
): Promise<CreatedCircle> {
  assertSignInModeForCircles("circle create", env);
  const name = parseCircleName(input.name);
  const [created] = await database
    .insert(circles)
    .values({ name })
    .returning();
  if (!created) {
    throw new KitchenCircleError("Could not create circle.");
  }
  return created;
}

/**
 * Adds a kitchen to a circle, enforcing at most one circle per kitchen and at
 * most 12 kitchens per circle under a row lock on the circle.
 */
export async function addKitchenToCircle(
  input: { circleId: string; kitchenSlug: string },
  database: CirclesDb = db,
  env: Record<string, string | undefined> = process.env,
): Promise<AddToCircleResult> {
  assertSignInModeForCircles("circle add", env);
  const circleId = parseCircleId(input.circleId);
  const kitchenSlug = input.kitchenSlug.trim();
  if (!kitchenSlug) {
    throw new KitchenCircleError("Kitchen slug is required.");
  }

  try {
    return await database.transaction(async (tx) => {
      const [circle] = await tx
        .select({ id: circles.id, name: circles.name })
        .from(circles)
        .where(eq(circles.id, circleId))
        .for("update")
        .limit(1);

      if (!circle) {
        throw new KitchenCircleError(`Circle "${circleId}" not found.`);
      }

      const [kitchen] = await tx
        .select({ id: kitchens.id, slug: kitchens.slug, name: kitchens.name })
        .from(kitchens)
        .where(eq(kitchens.slug, kitchenSlug))
        .limit(1);

      if (!kitchen) {
        throw new KitchenCircleError(`Kitchen "${kitchenSlug}" not found.`);
      }

      const [existingMembership] = await tx
        .select({
          circleId: circles.id,
          circleName: circles.name,
        })
        .from(circleMembers)
        .innerJoin(circles, eq(circleMembers.circleId, circles.id))
        .where(eq(circleMembers.kitchenId, kitchen.id))
        .limit(1);

      if (existingMembership) {
        throw new KitchenCircleError(
          `Kitchen "${kitchen.slug}" is already in circle "${existingMembership.circleName}" (${existingMembership.circleId}).`,
        );
      }

      const [memberCount] = await tx
        .select({ total: count() })
        .from(circleMembers)
        .where(eq(circleMembers.circleId, circle.id));

      if (Number(memberCount?.total ?? 0) >= MAX_CIRCLE_MEMBERS) {
        throw new KitchenCircleError(
          `Circle "${circle.name}" already has ${MAX_CIRCLE_MEMBERS} kitchens (maximum reached).`,
        );
      }

      const [inserted] = await tx
        .insert(circleMembers)
        .values({
          circleId: circle.id,
          kitchenId: kitchen.id,
        })
        .returning({ joinedAt: circleMembers.joinedAt });

      return {
        circleId: circle.id,
        circleName: circle.name,
        kitchenId: kitchen.id,
        kitchenSlug: kitchen.slug,
        kitchenName: kitchen.name,
        joinedAt: inserted!.joinedAt,
      };
    });
  } catch (err) {
    if (err instanceof KitchenCircleError) throw err;
    if (errorChainMentions(err, "circle_members_kitchen_id_unique")) {
      throw new KitchenCircleError(
        `Kitchen "${kitchenSlug}" is already in a circle.`,
      );
    }
    throw err;
  }
}

/**
 * Removes a kitchen from its circle (optionally asserting which circle).
 */
export async function removeKitchenFromCircle(
  input: { kitchenSlug: string; circleId?: string },
  database: CirclesDb = db,
  env: Record<string, string | undefined> = process.env,
): Promise<RemoveFromCircleResult> {
  assertSignInModeForCircles("circle remove", env);
  const kitchenSlug = input.kitchenSlug.trim();
  if (!kitchenSlug) {
    throw new KitchenCircleError("Kitchen slug is required.");
  }
  const expectedCircleId =
    input.circleId !== undefined ? parseCircleId(input.circleId) : undefined;

  const [kitchen] = await database
    .select({ id: kitchens.id, slug: kitchens.slug, name: kitchens.name })
    .from(kitchens)
    .where(eq(kitchens.slug, kitchenSlug))
    .limit(1);

  if (!kitchen) {
    throw new KitchenCircleError(`Kitchen "${kitchenSlug}" not found.`);
  }

  const [membership] = await database
    .select({
      id: circleMembers.id,
      circleId: circles.id,
      circleName: circles.name,
    })
    .from(circleMembers)
    .innerJoin(circles, eq(circleMembers.circleId, circles.id))
    .where(eq(circleMembers.kitchenId, kitchen.id))
    .limit(1);

  if (!membership) {
    throw new KitchenCircleError(
      `Kitchen "${kitchen.slug}" is not in any circle.`,
    );
  }

  if (expectedCircleId !== undefined && membership.circleId !== expectedCircleId) {
    throw new KitchenCircleError(
      `Kitchen "${kitchen.slug}" is in circle "${membership.circleName}" (${membership.circleId}), not "${expectedCircleId}".`,
    );
  }

  await database
    .delete(circleMembers)
    .where(
      and(
        eq(circleMembers.id, membership.id),
        eq(circleMembers.kitchenId, kitchen.id),
      ),
    );

  return {
    circleId: membership.circleId,
    circleName: membership.circleName,
    kitchenId: kitchen.id,
    kitchenSlug: kitchen.slug,
    kitchenName: kitchen.name,
  };
}

/**
 * Lists all circles and their member kitchens. Refused in single-kitchen mode.
 */
export async function listCircles(
  database: CirclesDb = db,
  env: Record<string, string | undefined> = process.env,
): Promise<ListedCircle[]> {
  assertSignInModeForCircles("circle list", env);

  const circleRows = await database
    .select({
      id: circles.id,
      name: circles.name,
      createdAt: circles.createdAt,
    })
    .from(circles)
    .orderBy(asc(circles.createdAt), asc(circles.name), asc(circles.id));

  if (circleRows.length === 0) return [];

  const memberRows = await database
    .select({
      circleId: circleMembers.circleId,
      kitchenId: kitchens.id,
      slug: kitchens.slug,
      name: kitchens.name,
      joinedAt: circleMembers.joinedAt,
    })
    .from(circleMembers)
    .innerJoin(kitchens, eq(circleMembers.kitchenId, kitchens.id))
    .where(
      inArray(
        circleMembers.circleId,
        circleRows.map((c) => c.id),
      ),
    )
    .orderBy(asc(circleMembers.joinedAt), asc(kitchens.slug));

  const byCircle = new Map<string, CircleMemberSummary[]>();
  for (const m of memberRows) {
    const list = byCircle.get(m.circleId) ?? [];
    list.push({
      kitchenId: m.kitchenId,
      slug: m.slug,
      name: m.name,
      joinedAt: m.joinedAt,
    });
    byCircle.set(m.circleId, list);
  }

  return circleRows.map((c) => ({
    id: c.id,
    name: c.name,
    createdAt: c.createdAt,
    members: byCircle.get(c.id) ?? [],
  }));
}
