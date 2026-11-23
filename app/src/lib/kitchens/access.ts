import { eq } from "drizzle-orm";
import type { PgDatabase, PgQueryResultHKT } from "drizzle-orm/pg-core";
import * as schema from "../../../drizzle/schema";
import { db, kitchens, members, type MemberRole } from "@/lib/db";
import { DeploymentConfigError, findHomeKitchen } from "./deployment";
import { NotInvitedError, acceptInvite } from "./invites";

export type AccessDb = PgDatabase<PgQueryResultHKT, typeof schema>;

export interface ResolvedAccess {
  kitchen: { id: string; slug: string };
  member: { id: string; role: MemberRole } | null;
}

export type ResolveAccessInput =
  | { mode: "single-kitchen" }
  | { mode: "sign-in"; user: { id: string; email: string } };

/**
 * Resolves the caller's kitchen and member for a request.
 *
 * - In single-kitchen mode, returns the `home` kitchen and a null member.
 * - In sign-in mode, returns the user's existing `members` row, or accepts a
 *   pending invite for their email on their first request, or throws
 *   `NotInvitedError` when neither exists.
 */
export async function resolveAccess(
  input: ResolveAccessInput,
  database: AccessDb = db,
): Promise<ResolvedAccess> {
  if (input.mode === "single-kitchen") {
    const home = await findHomeKitchen(database);
    if (!home) {
      throw new DeploymentConfigError(
        'Default "home" kitchen not found; run `pnpm --dir app db:migrate`.',
      );
    }
    return {
      kitchen: { id: home.id, slug: home.slug },
      member: null,
    };
  }

  const [existing] = await database
    .select({
      memberId: members.id,
      role: members.role,
      kitchenId: kitchens.id,
      kitchenSlug: kitchens.slug,
    })
    .from(members)
    .innerJoin(kitchens, eq(members.kitchenId, kitchens.id))
    .where(eq(members.userId, input.user.id))
    .limit(1);

  if (existing) {
    return {
      kitchen: { id: existing.kitchenId, slug: existing.kitchenSlug },
      member: { id: existing.memberId, role: existing.role },
    };
  }

  const accepted = await acceptInvite(input.user.id, input.user.email, database);
  if (!accepted) {
    throw new NotInvitedError();
  }

  return accepted;
}
