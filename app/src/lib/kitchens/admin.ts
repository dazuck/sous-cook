import { and, asc, eq, inArray, isNull, or, sql } from "drizzle-orm";
import type { PgDatabase, PgQueryResultHKT } from "drizzle-orm/pg-core";
import * as schema from "../../../drizzle/schema";
import {
  authSession,
  authUser,
  db,
  invites,
  kitchens,
  kitchenWebhookTokens,
  members,
  type MemberRole,
} from "../db";
import { getDeploymentMode } from "./deployment";
import { normalizeEmail } from "./invites";
import { isValidKitchenSlug, slugFromName } from "./slug";
import { generateWebhookToken } from "./webhook-tokens";

export type AdminDb = PgDatabase<PgQueryResultHKT, typeof schema>;

const UUID_PATTERN =
  /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

/**
 * Raised when an operator command cannot proceed (unknown kitchen, missing
 * token, already revoked, invalid input) so the CLI exits 1 with a clear line.
 */
export class KitchenAdminError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "KitchenAdminError";
  }
}

export interface CreatedWebhookToken {
  id: string;
  kitchenSlug: string;
  kitchenName: string;
  label: string;
  createdAt: Date;
  /** Plaintext bearer token, returned once and never stored. */
  token: string;
}

export interface RevokedWebhookToken {
  id: string;
  kitchenSlug: string;
  label: string;
  revokedAt: Date;
}

export interface ListedWebhookToken {
  id: string;
  kitchenSlug: string;
  label: string;
  createdAt: Date;
  lastUsedAt: Date | null;
  revokedAt: Date | null;
}

export type CreateInviteInput =
  | {
      email: string;
      newKitchenName: string;
      slug?: string;
    }
  | {
      email: string;
      kitchenSlug: string;
      role: MemberRole;
    };

export interface CreatedInvite {
  id: string;
  email: string;
  role: MemberRole;
  kitchenSlug: string;
  kitchenName: string;
  isNewKitchen: boolean;
  invitedAt: Date;
}

export interface UninviteResult {
  inviteId: string;
  email: string;
  revokedAt: Date;
  wasAcceptedOrphan: boolean;
  sessionsDeleted: number;
}

export interface RemoveMemberResult {
  memberId: string;
  userId: string;
  email: string;
  kitchenSlug: string;
  kitchenName: string;
  sessionsDeleted: number;
  invitesRevoked: number;
  unrevokedTokens: Array<{ id: string; label: string }>;
  revokedTokens: Array<{ id: string; label: string }>;
  wasLastMember: boolean;
}

export interface ListedKitchen {
  id: string;
  slug: string;
  name: string;
  aiMonthlyCapMicros: number | null;
  members: Array<{ id: string; email: string; role: MemberRole }>;
  pendingInvites: Array<{
    id: string;
    email: string;
    role: MemberRole;
    invitedAt: Date;
  }>;
}

export interface ListedPendingNewKitchenInvite {
  id: string;
  email: string;
  newKitchenSlug: string;
  newKitchenName: string;
  role: MemberRole;
  invitedAt: Date;
}

export interface ListKitchensResult {
  kitchens: ListedKitchen[];
  pendingNewKitchenInvites: ListedPendingNewKitchenInvite[];
}

export interface RenameKitchenResult {
  id: string;
  slug: string;
  oldName: string;
  newName: string;
}

function parseAndValidateEmail(raw: string): string {
  const email = normalizeEmail(raw);
  const atIndex = email.indexOf("@");
  if (
    !email ||
    /\s/.test(email) ||
    atIndex <= 0 ||
    atIndex === email.length - 1 ||
    email.indexOf("@", atIndex + 1) !== -1
  ) {
    throw new KitchenAdminError(`Invalid email address "${raw}".`);
  }
  return email;
}

function parseAndValidateKitchenName(raw: string): string {
  const name = raw.trim();
  if (name.length < 1 || name.length > 80) {
    throw new KitchenAdminError(
      "Kitchen name must be between 1 and 80 characters.",
    );
  }
  return name;
}

function errorChainMentions(err: unknown, text: string): boolean {
  const seen = new Set<unknown>();
  let cur: unknown = err;
  while (cur instanceof Error && !seen.has(cur)) {
    seen.add(cur);
    if (cur.message.includes(text)) return true;
    cur = cur.cause;
  }
  return false;
}

async function requireKitchenBySlug(slug: string, database: AdminDb) {
  const normalized = slug.trim();
  if (!normalized) {
    throw new KitchenAdminError("Kitchen slug is required.");
  }
  const [kitchen] = await database
    .select({ id: kitchens.id, slug: kitchens.slug, name: kitchens.name })
    .from(kitchens)
    .where(eq(kitchens.slug, normalized))
    .limit(1);
  if (!kitchen) {
    throw new KitchenAdminError(`Kitchen "${normalized}" not found.`);
  }
  return kitchen;
}

function roleWithArticle(role: MemberRole): string {
  return /^[aeiou]/i.test(role) ? `an ${role}` : `a ${role}`;
}

/**
 * Refuses membership/invite admin commands when the environment selects
 * single-kitchen mode (`SOUS_SIGN_IN=off`).
 */
export function assertSignInModeForAdmin(
  command: "invite" | "uninvite" | "remove-member",
  env: Record<string, string | undefined> = process.env,
): void {
  if (getDeploymentMode(env) === "single-kitchen") {
    throw new KitchenAdminError(
      `Cannot run "${command}" in single-kitchen mode (SOUS_SIGN_IN=off): single-kitchen mode has no members or invites.`,
    );
  }
}

/**
 * Formats the operator CLI summary line for `remove-member` so the printed
 * message matches what actually happened to the kitchen's webhook tokens.
 */
export function formatRemoveMemberSummary(result: RemoveMemberResult): string {
  const lastMemberNote = result.wasLastMember ? " (last member of kitchen)" : "";
  let tokenNote: string;
  if (result.revokedTokens.length > 0) {
    tokenNote = ` Revoked ${result.revokedTokens.length} webhook token(s): ${result.revokedTokens.map((t) => `"${t.label}"`).join(", ")}.`;
  } else if (result.unrevokedTokens.length > 0) {
    tokenNote = ` Kept ${result.unrevokedTokens.length} existing webhook token(s).`;
  } else {
    tokenNote = " Kitchen had no unrevoked webhook tokens.";
  }
  return `Removed ${result.email} from kitchen "${result.kitchenSlug}"${lastMemberNote}; revoked ${result.invitesRevoked} invite(s), deleted ${result.sessionsDeleted} session(s).${tokenNote}`;
}

/**
 * Adds a pending invite either as the owner of a new kitchen or as a member of
 * an existing kitchen.
 */
export async function createInvite(
  input: CreateInviteInput,
  database: AdminDb = db,
  env: Record<string, string | undefined> = process.env,
): Promise<CreatedInvite> {
  assertSignInModeForAdmin("invite", env);
  const email = parseAndValidateEmail(input.email);

  // Refuse if email is already a member.
  const [existingMember] = await database
    .select({
      memberId: members.id,
      kitchenSlug: kitchens.slug,
      role: members.role,
    })
    .from(members)
    .innerJoin(authUser, eq(members.userId, authUser.id))
    .innerJoin(kitchens, eq(members.kitchenId, kitchens.id))
    .where(sql`lower(btrim(${authUser.email})) = ${email}`)
    .limit(1);

  if (existingMember) {
    throw new KitchenAdminError(
      `"${email}" is already ${roleWithArticle(existingMember.role)} of kitchen "${existingMember.kitchenSlug}".`,
    );
  }

  // Refuse if email already has a pending or accepted invite.
  const [existingInvite] = await database
    .select({
      id: invites.id,
      acceptedAt: invites.acceptedAt,
    })
    .from(invites)
    .where(and(eq(invites.email, email), isNull(invites.revokedAt)))
    .limit(1);

  if (existingInvite) {
    if (existingInvite.acceptedAt === null) {
      throw new KitchenAdminError(`"${email}" already has a pending invite.`);
    }
    throw new KitchenAdminError(
      `"${email}" already has an accepted invite with no member row; run "kitchens uninvite --email ${email}" first.`,
    );
  }

  if ("newKitchenName" in input) {
    const kitchenName = parseAndValidateKitchenName(input.newKitchenName);
    let slug: string;
    if (input.slug !== undefined) {
      slug = input.slug.trim();
      if (!isValidKitchenSlug(slug)) {
        throw new KitchenAdminError(
          `Invalid kitchen slug "${input.slug}". Use lowercase letters, digits, and single hyphens (max 40 characters).`,
        );
      }
    } else {
      slug = slugFromName(kitchenName);
      if (!slug) {
        throw new KitchenAdminError(
          `Could not derive a kitchen slug from "${kitchenName}". Pass --slug <slug> explicitly.`,
        );
      }
    }

    if (slug === "home") {
      throw new KitchenAdminError(
        'Kitchen slug "home" is reserved for the default kitchen.',
      );
    }

    const [clashKitchen] = await database
      .select({ slug: kitchens.slug, name: kitchens.name })
      .from(kitchens)
      .where(eq(kitchens.slug, slug))
      .limit(1);
    if (clashKitchen) {
      throw new KitchenAdminError(
        `Kitchen slug "${slug}" already belongs to kitchen "${clashKitchen.name}".`,
      );
    }

    const [clashInvite] = await database
      .select({ email: invites.email })
      .from(invites)
      .where(
        and(
          eq(invites.newKitchenSlug, slug),
          isNull(invites.revokedAt),
          isNull(invites.acceptedAt),
        ),
      )
      .limit(1);
    if (clashInvite) {
      throw new KitchenAdminError(
        `Kitchen slug "${slug}" is already reserved by a pending invite for "${clashInvite.email}".`,
      );
    }

    try {
      const [inserted] = await database
        .insert(invites)
        .values({
          email,
          kitchenId: null,
          newKitchenName: kitchenName,
          newKitchenSlug: slug,
          role: "owner",
        })
        .returning({
          id: invites.id,
          email: invites.email,
          role: invites.role,
          invitedAt: invites.invitedAt,
        });

      if (!inserted) {
        throw new Error("Failed to insert invite.");
      }

      return {
        id: inserted.id,
        email: inserted.email,
        role: inserted.role,
        kitchenSlug: slug,
        kitchenName,
        isNewKitchen: true,
        invitedAt: inserted.invitedAt,
      };
    } catch (err) {
      if (errorChainMentions(err, "invites_live_email_unique")) {
        throw new KitchenAdminError(`"${email}" already has a live invite.`);
      }
      if (errorChainMentions(err, "invites_pending_slug_unique")) {
        throw new KitchenAdminError(
          `Kitchen slug "${slug}" is already reserved by another pending invite.`,
        );
      }
      throw err;
    }
  }

  // Existing kitchen invite.
  if (input.role !== "owner" && input.role !== "cook") {
    throw new KitchenAdminError(
      `Invalid role "${String(input.role)}". Expected "owner" or "cook".`,
    );
  }
  const kitchen = await requireKitchenBySlug(input.kitchenSlug, database);

  try {
    const [inserted] = await database
      .insert(invites)
      .values({
        email,
        kitchenId: kitchen.id,
        newKitchenName: null,
        newKitchenSlug: null,
        role: input.role,
      })
      .returning({
        id: invites.id,
        email: invites.email,
        role: invites.role,
        invitedAt: invites.invitedAt,
      });

    if (!inserted) {
      throw new Error("Failed to insert invite.");
    }

    return {
      id: inserted.id,
      email: inserted.email,
      role: inserted.role,
      kitchenSlug: kitchen.slug,
      kitchenName: kitchen.name,
      isNewKitchen: false,
      invitedAt: inserted.invitedAt,
    };
  } catch (err) {
    if (errorChainMentions(err, "invites_live_email_unique")) {
      throw new KitchenAdminError(`"${email}" already has a live invite.`);
    }
    throw err;
  }
}

/**
 * Revokes an email's pending invite, or an accepted invite whose member row no
 * longer exists (orphaned after user deletion). Locks the invite row first with
 * `FOR UPDATE` so concurrent invite acceptance serializes with revocation, then
 * checks membership before revoking. Deletes any sessions belonging to a user
 * with that email who has no member row, in the same transaction. Refuses when
 * the person is currently a member and points to `remove-member`.
 */
export async function uninviteEmail(
  input: { email: string },
  database: AdminDb = db,
  env: Record<string, string | undefined> = process.env,
): Promise<UninviteResult> {
  assertSignInModeForAdmin("uninvite", env);
  const email = parseAndValidateEmail(input.email);

  return database.transaction(async (tx) => {
    // Lock the live invite first using the same statement as `acceptInvite` so
    // an in-flight acceptance commits before we inspect `members`.
    const [liveInvite] = await tx
      .select({
        id: invites.id,
        acceptedAt: invites.acceptedAt,
        acceptedUserId: invites.acceptedUserId,
      })
      .from(invites)
      .where(and(eq(invites.email, email), isNull(invites.revokedAt)))
      .for("update");

    const matchingUsers = await tx
      .select({ id: authUser.id })
      .from(authUser)
      .where(sql`lower(btrim(${authUser.email})) = ${email}`);

    const userIdSet = new Set(matchingUsers.map((u) => u.id));
    if (liveInvite?.acceptedUserId) {
      userIdSet.add(liveInvite.acceptedUserId);
    }
    const userIds = Array.from(userIdSet);
    if (userIds.length > 0) {
      const [existingMember] = await tx
        .select({
          id: members.id,
          kitchenSlug: kitchens.slug,
        })
        .from(members)
        .innerJoin(kitchens, eq(members.kitchenId, kitchens.id))
        .where(inArray(members.userId, userIds))
        .limit(1);

      if (existingMember) {
        throw new KitchenAdminError(
          `"${email}" is a member of kitchen "${existingMember.kitchenSlug}"; use "kitchens remove-member --email ${email} (--revoke-tokens | --keep-tokens)" instead.`,
        );
      }
    }

    if (!liveInvite) {
      throw new KitchenAdminError(
        `No pending or orphaned invite found for "${email}".`,
      );
    }

    const [revoked] = await tx
      .update(invites)
      .set({ revokedAt: sql`now()` })
      .where(and(eq(invites.id, liveInvite.id), isNull(invites.revokedAt)))
      .returning({ revokedAt: invites.revokedAt });

    if (!revoked?.revokedAt) {
      throw new KitchenAdminError(`Invite for "${email}" is already revoked.`);
    }

    let sessionsDeleted = 0;
    if (userIds.length > 0) {
      const deleted = await tx
        .delete(authSession)
        .where(inArray(authSession.userId, userIds))
        .returning({ id: authSession.id });
      sessionsDeleted = deleted.length;
    }

    return {
      inviteId: liveInvite.id,
      email,
      revokedAt: revoked.revokedAt,
      wasAcceptedOrphan: liveInvite.acceptedAt !== null,
      sessionsDeleted,
    };
  });
}

/**
 * Removes a member from their kitchen, revokes their invite, deletes all of
 * their sessions, and handles the kitchen's webhook tokens in one transaction.
 *
 * Refuses without changing anything when `tokenAction` is omitted, listing the
 * kitchen's unrevoked webhook tokens by label. When removing the kitchen's
 * last member, its tokens are always revoked regardless of `tokenAction`.
 */
export async function removeMember(
  input: { email: string; tokenAction?: "revoke" | "keep" },
  database: AdminDb = db,
  env: Record<string, string | undefined> = process.env,
): Promise<RemoveMemberResult> {
  assertSignInModeForAdmin("remove-member", env);
  const email = parseAndValidateEmail(input.email);

  return database.transaction(async (tx) => {
    const matchingUsers = await tx
      .select({ id: authUser.id, email: authUser.email })
      .from(authUser)
      .where(sql`lower(btrim(${authUser.email})) = ${email}`)
      .orderBy(asc(authUser.id));

    if (matchingUsers.length > 1) {
      const ids = matchingUsers.map((u) => u.id).join(", ");
      throw new KitchenAdminError(
        `Multiple users match "${email}" (${ids}); resolve duplicate user rows before removing a member.`,
      );
    }

    const targetUser = matchingUsers[0];
    if (!targetUser) {
      throw new KitchenAdminError(`No member found for "${email}".`);
    }

    const [member] = await tx
      .select({
        memberId: members.id,
        userId: members.userId,
        email: authUser.email,
        kitchenId: kitchens.id,
        kitchenSlug: kitchens.slug,
        kitchenName: kitchens.name,
      })
      .from(members)
      .innerJoin(authUser, eq(members.userId, authUser.id))
      .innerJoin(kitchens, eq(members.kitchenId, kitchens.id))
      .where(eq(members.userId, targetUser.id))
      .limit(1);

    if (!member) {
      throw new KitchenAdminError(`No member found for "${email}".`);
    }

    const unrevokedTokens = await tx
      .select({
        id: kitchenWebhookTokens.id,
        label: kitchenWebhookTokens.label,
      })
      .from(kitchenWebhookTokens)
      .where(
        and(
          eq(kitchenWebhookTokens.kitchenId, member.kitchenId),
          isNull(kitchenWebhookTokens.revokedAt),
        ),
      )
      .orderBy(asc(kitchenWebhookTokens.createdAt));

    if (!input.tokenAction) {
      const tokenSummary =
        unrevokedTokens.length === 0
          ? `Kitchen "${member.kitchenSlug}" has no unrevoked webhook tokens.`
          : `Unrevoked webhook tokens for kitchen "${member.kitchenSlug}": ${unrevokedTokens
              .map((t) => `"${t.label}" (${t.id})`)
              .join(", ")}.`;
      throw new KitchenAdminError(
        `${tokenSummary} Pass --revoke-tokens or --keep-tokens to remove "${email}".`,
      );
    }

    await tx.delete(members).where(eq(members.id, member.memberId));

    const revokedInvites = await tx
      .update(invites)
      .set({ revokedAt: sql`now()` })
      .where(
        and(
          isNull(invites.revokedAt),
          or(
            eq(invites.email, email),
            eq(invites.acceptedUserId, member.userId),
          ),
        ),
      )
      .returning({ id: invites.id });

    const deletedSessions = await tx
      .delete(authSession)
      .where(eq(authSession.userId, member.userId))
      .returning({ id: authSession.id });

    const remainingMembers = await tx
      .select({ id: members.id })
      .from(members)
      .where(eq(members.kitchenId, member.kitchenId))
      .limit(1);
    const wasLastMember = remainingMembers.length === 0;

    let revokedTokens: Array<{ id: string; label: string }> = [];
    if (input.tokenAction === "revoke" || wasLastMember) {
      revokedTokens = await tx
        .update(kitchenWebhookTokens)
        .set({ revokedAt: sql`now()` })
        .where(
          and(
            eq(kitchenWebhookTokens.kitchenId, member.kitchenId),
            isNull(kitchenWebhookTokens.revokedAt),
          ),
        )
        .returning({
          id: kitchenWebhookTokens.id,
          label: kitchenWebhookTokens.label,
        });
    }

    return {
      memberId: member.memberId,
      userId: member.userId,
      email: member.email,
      kitchenSlug: member.kitchenSlug,
      kitchenName: member.kitchenName,
      sessionsDeleted: deletedSessions.length,
      invitesRevoked: revokedInvites.length,
      unrevokedTokens,
      revokedTokens,
      wasLastMember,
    };
  });
}

/**
 * Lists all kitchens with their slug, name, optional cap, members, and pending
 * invites, plus pending invites that will create new kitchens.
 */
export async function listKitchens(
  database: AdminDb = db,
): Promise<ListKitchensResult> {
  const kitchenRows = await database
    .select({
      id: kitchens.id,
      slug: kitchens.slug,
      name: kitchens.name,
      aiMonthlyCapMicros: kitchens.aiMonthlyCapMicros,
    })
    .from(kitchens)
    .orderBy(asc(kitchens.slug));

  const memberRows = await database
    .select({
      id: members.id,
      kitchenId: members.kitchenId,
      email: authUser.email,
      role: members.role,
    })
    .from(members)
    .innerJoin(authUser, eq(members.userId, authUser.id))
    .orderBy(asc(authUser.email));

  const pendingInviteRows = await database
    .select({
      id: invites.id,
      email: invites.email,
      kitchenId: invites.kitchenId,
      newKitchenName: invites.newKitchenName,
      newKitchenSlug: invites.newKitchenSlug,
      role: invites.role,
      invitedAt: invites.invitedAt,
    })
    .from(invites)
    .where(and(isNull(invites.revokedAt), isNull(invites.acceptedAt)))
    .orderBy(asc(invites.invitedAt), asc(invites.email));

  const membersByKitchen = new Map<
    string,
    Array<{ id: string; email: string; role: MemberRole }>
  >();
  for (const m of memberRows) {
    const list = membersByKitchen.get(m.kitchenId) ?? [];
    list.push({ id: m.id, email: m.email, role: m.role });
    membersByKitchen.set(m.kitchenId, list);
  }

  const invitesByKitchen = new Map<
    string,
    Array<{ id: string; email: string; role: MemberRole; invitedAt: Date }>
  >();
  const pendingNewKitchenInvites: ListedPendingNewKitchenInvite[] = [];

  for (const inv of pendingInviteRows) {
    if (inv.kitchenId !== null) {
      const list = invitesByKitchen.get(inv.kitchenId) ?? [];
      list.push({
        id: inv.id,
        email: inv.email,
        role: inv.role,
        invitedAt: inv.invitedAt,
      });
      invitesByKitchen.set(inv.kitchenId, list);
    } else if (inv.newKitchenSlug && inv.newKitchenName) {
      pendingNewKitchenInvites.push({
        id: inv.id,
        email: inv.email,
        newKitchenSlug: inv.newKitchenSlug,
        newKitchenName: inv.newKitchenName,
        role: inv.role,
        invitedAt: inv.invitedAt,
      });
    }
  }

  return {
    kitchens: kitchenRows.map((k) => ({
      id: k.id,
      slug: k.slug,
      name: k.name,
      aiMonthlyCapMicros: k.aiMonthlyCapMicros,
      members: membersByKitchen.get(k.id) ?? [],
      pendingInvites: invitesByKitchen.get(k.id) ?? [],
    })),
    pendingNewKitchenInvites,
  };
}

/**
 * Changes a kitchen's display name only; slugs never change.
 */
export async function renameKitchen(
  input: { kitchenSlug: string; name: string },
  database: AdminDb = db,
): Promise<RenameKitchenResult> {
  const kitchen = await requireKitchenBySlug(input.kitchenSlug, database);
  const newName = parseAndValidateKitchenName(input.name);

  await database
    .update(kitchens)
    .set({ name: newName })
    .where(eq(kitchens.id, kitchen.id));

  return {
    id: kitchen.id,
    slug: kitchen.slug,
    oldName: kitchen.name,
    newName,
  };
}

/**
 * Mints a new webhook bearer token for a kitchen, stores only its SHA-256 hex
 * digest, and returns the plaintext token once. Refuses kitchens without
 * members in sign-in mode; in single-kitchen mode, `home` has no members by
 * design and token creation remains allowed.
 */
export async function createWebhookToken(
  input: { kitchenSlug: string; label: string },
  database: AdminDb = db,
  env: Record<string, string | undefined> = process.env,
): Promise<CreatedWebhookToken> {
  const kitchen = await requireKitchenBySlug(input.kitchenSlug, database);
  const label = input.label.trim();
  if (!label) {
    throw new KitchenAdminError("Token label is required.");
  }

  if (getDeploymentMode(env) === "sign-in") {
    const [existingMember] = await database
      .select({ id: members.id })
      .from(members)
      .where(eq(members.kitchenId, kitchen.id))
      .limit(1);
    if (!existingMember) {
      throw new KitchenAdminError(
        `Kitchen "${kitchen.slug}" has no members; add a member before creating a webhook token, or set SOUS_SIGN_IN=off if this deployment runs in single-kitchen mode.`,
      );
    }
  }

  const { token, tokenSha256 } = generateWebhookToken();
  const [inserted] = await database
    .insert(kitchenWebhookTokens)
    .values({
      kitchenId: kitchen.id,
      tokenSha256,
      label,
    })
    .returning({
      id: kitchenWebhookTokens.id,
      label: kitchenWebhookTokens.label,
      createdAt: kitchenWebhookTokens.createdAt,
    });

  if (!inserted) {
    throw new Error("Failed to insert webhook token.");
  }

  return {
    id: inserted.id,
    kitchenSlug: kitchen.slug,
    kitchenName: kitchen.name,
    label: inserted.label,
    createdAt: inserted.createdAt,
    token,
  };
}

/**
 * Revokes a single webhook token by its id. Refuses if the id is not a UUID,
 * does not exist, or is already revoked.
 */
export async function revokeWebhookToken(
  input: { id: string },
  database: AdminDb = db,
): Promise<RevokedWebhookToken> {
  const id = input.id.trim();
  if (!UUID_PATTERN.test(id)) {
    throw new KitchenAdminError(`Invalid token id "${id}".`);
  }

  const [existing] = await database
    .select({
      id: kitchenWebhookTokens.id,
      label: kitchenWebhookTokens.label,
      revokedAt: kitchenWebhookTokens.revokedAt,
      kitchenSlug: kitchens.slug,
    })
    .from(kitchenWebhookTokens)
    .innerJoin(kitchens, eq(kitchenWebhookTokens.kitchenId, kitchens.id))
    .where(eq(kitchenWebhookTokens.id, id))
    .limit(1);

  if (!existing) {
    throw new KitchenAdminError(`Webhook token "${id}" not found.`);
  }
  if (existing.revokedAt !== null) {
    throw new KitchenAdminError(
      `Webhook token "${id}" (${existing.kitchenSlug}, "${existing.label}") was already revoked at ${existing.revokedAt.toISOString()}.`,
    );
  }

  const [updated] = await database
    .update(kitchenWebhookTokens)
    .set({ revokedAt: sql`now()` })
    .where(
      and(
        eq(kitchenWebhookTokens.id, id),
        isNull(kitchenWebhookTokens.revokedAt),
      ),
    )
    .returning({ revokedAt: kitchenWebhookTokens.revokedAt });

  if (!updated?.revokedAt) {
    throw new KitchenAdminError(`Webhook token "${id}" is already revoked.`);
  }

  return {
    id: existing.id,
    kitchenSlug: existing.kitchenSlug,
    label: existing.label,
    revokedAt: updated.revokedAt,
  };
}

/**
 * Lists webhook tokens (all kitchens, or one kitchen when `kitchenSlug` is
 * given). Never returns the token or its digest.
 */
export async function listWebhookTokens(
  input: { kitchenSlug?: string } = {},
  database: AdminDb = db,
): Promise<ListedWebhookToken[]> {
  let kitchenIdFilter: string | null = null;
  if (input.kitchenSlug !== undefined) {
    const kitchen = await requireKitchenBySlug(input.kitchenSlug, database);
    kitchenIdFilter = kitchen.id;
  }

  const query = database
    .select({
      id: kitchenWebhookTokens.id,
      kitchenSlug: kitchens.slug,
      label: kitchenWebhookTokens.label,
      createdAt: kitchenWebhookTokens.createdAt,
      lastUsedAt: kitchenWebhookTokens.lastUsedAt,
      revokedAt: kitchenWebhookTokens.revokedAt,
    })
    .from(kitchenWebhookTokens)
    .innerJoin(kitchens, eq(kitchenWebhookTokens.kitchenId, kitchens.id));

  const rows =
    kitchenIdFilter !== null
      ? await query
          .where(eq(kitchenWebhookTokens.kitchenId, kitchenIdFilter))
          .orderBy(asc(kitchenWebhookTokens.createdAt))
      : await query.orderBy(
          asc(kitchens.slug),
          asc(kitchenWebhookTokens.createdAt),
        );

  return rows;
}
