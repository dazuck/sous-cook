import { and, eq, isNull, sql } from "drizzle-orm";
import type { PgDatabase, PgQueryResultHKT } from "drizzle-orm/pg-core";
import { APIError } from "better-auth/api";
import * as schema from "../../../drizzle/schema";
import {
  authUser,
  db,
  invites,
  kitchens,
  members,
  type MemberRole,
} from "@/lib/db";

export type InviteDb = PgDatabase<PgQueryResultHKT, typeof schema>;

/**
 * Raised when a signed-in user has no kitchen membership and no pending
 * invite that admits them. Mapped by `kitchenProcedure` to `FORBIDDEN` with
 * `data.reason = "not-invited"`.
 */
export class NotInvitedError extends Error {
  readonly reason = "not-invited" as const;

  constructor(message = "Not invited") {
    super(message);
    this.name = "NotInvitedError";
  }
}

/** Trims surrounding whitespace and lowercases an email address for matching. */
export function normalizeEmail(email: string): string {
  return email.trim().toLowerCase();
}

async function hasPendingInvite(
  normalizedEmail: string,
  database: InviteDb,
): Promise<boolean> {
  if (!normalizedEmail || !normalizedEmail.includes("@")) {
    return false;
  }
  const [pending] = await database
    .select({ id: invites.id })
    .from(invites)
    .where(
      and(
        eq(invites.email, normalizedEmail),
        isNull(invites.revokedAt),
        isNull(invites.acceptedAt),
      ),
    )
    .limit(1);
  return pending !== undefined;
}

/**
 * Builds the `databaseHooks.user.create.before` gate bound to a specific
 * Drizzle instance. Refuses unverified emails and any email without a pending
 * invite (trimmed, lowercased).
 */
export function createBeforeCreateUser(database: InviteDb) {
  return async function checkUserInvite(user: {
    email?: unknown;
    emailVerified?: unknown;
  }): Promise<void> {
    if (user.emailVerified !== true) {
      throw new APIError("FORBIDDEN", {
        message: "Email address is not verified",
      });
    }
    const rawEmail = typeof user.email === "string" ? user.email : "";
    const normalizedEmail = normalizeEmail(rawEmail);
    const invited = await hasPendingInvite(normalizedEmail, database);
    if (!invited) {
      throw new APIError("FORBIDDEN", {
        message: "Not invited",
      });
    }
  };
}

/**
 * Default `databaseHooks.user.create.before` hook using the app's `db`.
 * Refuses to create a user whose email is unverified or has no pending invite.
 */
export async function beforeCreateUser(user: {
  email?: unknown;
  emailVerified?: unknown;
}): Promise<void> {
  return createBeforeCreateUser(db)(user);
}

/**
 * Builds the `databaseHooks.session.create.before` gate bound to a specific
 * Drizzle instance. Refuses a new session for any user who has neither a
 * verified email and a member row nor a pending invite.
 */
export function createBeforeCreateSession(database: InviteDb) {
  return async function checkSessionAccess(session: {
    userId?: unknown;
  }): Promise<void> {
    const userId = typeof session.userId === "string" ? session.userId : "";
    if (!userId) {
      throw new APIError("FORBIDDEN", { message: "Not invited" });
    }

    const [user] = await database
      .select({
        id: authUser.id,
        email: authUser.email,
        emailVerified: authUser.emailVerified,
      })
      .from(authUser)
      .where(eq(authUser.id, userId))
      .limit(1);

    if (!user) {
      throw new APIError("FORBIDDEN", { message: "Not invited" });
    }
    if (!user.emailVerified) {
      throw new APIError("FORBIDDEN", {
        message: "Email address is not verified",
      });
    }

    const [existingMember] = await database
      .select({ id: members.id })
      .from(members)
      .where(eq(members.userId, userId))
      .limit(1);

    if (existingMember) {
      return;
    }

    const normalizedEmail = normalizeEmail(user.email);
    const invited = await hasPendingInvite(normalizedEmail, database);
    if (!invited) {
      throw new APIError("FORBIDDEN", { message: "Not invited" });
    }
  };
}

/**
 * Default `databaseHooks.session.create.before` hook using the app's `db`.
 */
export async function beforeCreateSession(session: {
  userId?: unknown;
}): Promise<void> {
  return createBeforeCreateSession(db)(session);
}

export interface AcceptedMembership {
  kitchen: { id: string; slug: string };
  member: { id: string; role: MemberRole };
}

/**
 * Accepts a pending invite for a signed-in user in one transaction.
 *
 * Locks the live invite (`revoked_at IS NULL`, deliberately without
 * `accepted_at IS NULL` in the WHERE so concurrent requests waiting on the
 * lock still see the row under READ COMMITTED and observe the member created
 * by the winning transaction). Returns `null` when the user has neither an
 * existing member row nor a pending invite. Any database error while creating
 * the kitchen or member is logged with the invite id and rethrown.
 */
export async function acceptInvite(
  userId: string,
  email: string,
  database: InviteDb = db,
): Promise<AcceptedMembership | null> {
  const normalizedEmail = normalizeEmail(email);

  return database.transaction(async (tx) => {
    // Lock the person's live invite WITHOUT `accepted_at IS NULL` in the WHERE
    // so concurrent first requests serialize on the row under READ COMMITTED.
    const [liveInvite] = await tx
      .select({
        id: invites.id,
        email: invites.email,
        kitchenId: invites.kitchenId,
        newKitchenName: invites.newKitchenName,
        newKitchenSlug: invites.newKitchenSlug,
        role: invites.role,
        acceptedAt: invites.acceptedAt,
        acceptedUserId: invites.acceptedUserId,
      })
      .from(invites)
      .where(and(eq(invites.email, normalizedEmail), isNull(invites.revokedAt)))
      .for("update");

    // Check membership under the lock: another concurrent request may have
    // accepted the invite and inserted the member row while we waited.
    const [existingMember] = await tx
      .select({
        memberId: members.id,
        role: members.role,
        kitchenId: kitchens.id,
        kitchenSlug: kitchens.slug,
      })
      .from(members)
      .innerJoin(kitchens, eq(members.kitchenId, kitchens.id))
      .where(eq(members.userId, userId))
      .limit(1);

    if (existingMember) {
      return {
        kitchen: {
          id: existingMember.kitchenId,
          slug: existingMember.kitchenSlug,
        },
        member: {
          id: existingMember.memberId,
          role: existingMember.role,
        },
      };
    }

    if (!liveInvite || liveInvite.acceptedAt !== null) {
      return null;
    }

    try {
      let targetKitchen: { id: string; slug: string };

      if (liveInvite.kitchenId !== null) {
        const [existingKitchen] = await tx
          .select({ id: kitchens.id, slug: kitchens.slug })
          .from(kitchens)
          .where(eq(kitchens.id, liveInvite.kitchenId))
          .limit(1);
        if (!existingKitchen) {
          throw new Error(
            `Invited kitchen ${liveInvite.kitchenId} no longer exists`,
          );
        }
        targetKitchen = existingKitchen;
      } else {
        if (!liveInvite.newKitchenName || !liveInvite.newKitchenSlug) {
          throw new Error(
            "New-kitchen invite is missing new_kitchen_name or new_kitchen_slug",
          );
        }
        const [createdKitchen] = await tx
          .insert(kitchens)
          .values({
            slug: liveInvite.newKitchenSlug,
            name: liveInvite.newKitchenName,
          })
          .returning({ id: kitchens.id, slug: kitchens.slug });
        if (!createdKitchen) {
          throw new Error("Failed to insert kitchen for invite");
        }
        targetKitchen = createdKitchen;
      }

      const [createdMember] = await tx
        .insert(members)
        .values({
          kitchenId: targetKitchen.id,
          userId,
          role: liveInvite.role,
        })
        .returning({ id: members.id, role: members.role });

      if (!createdMember) {
        throw new Error("Failed to insert member for invite");
      }

      await tx
        .update(invites)
        .set({
          acceptedAt: sql`now()`,
          acceptedUserId: userId,
        })
        .where(eq(invites.id, liveInvite.id));

      return {
        kitchen: targetKitchen,
        member: {
          id: createdMember.id,
          role: createdMember.role,
        },
      };
    } catch (err) {
      console.error("[invites] acceptInvite failed", {
        inviteId: liveInvite.id,
        error: err,
      });
      throw err;
    }
  });
}
