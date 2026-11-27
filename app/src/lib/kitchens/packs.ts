import { readFile } from "node:fs/promises";
import path from "node:path";
import { and, asc, eq, inArray } from "drizzle-orm";
import type { PgDatabase, PgQueryResultHKT } from "drizzle-orm/pg-core";
import { parsePack, verifyPackRefs, type Pack } from "@sous/pack";
import * as schema from "../../../drizzle/schema";
import { db, kitchenPackShares, kitchenPacks, kitchens } from "../db";
import {
  HOUSEHOLD_PACK,
  PACK_FILE_SOURCES,
  loadLibraries,
  type KitchenPackRecord,
} from "../shelf/registry";
import { packRecipeToQueueData } from "../pack-convert/to-queue";
import { KitchenAdminError } from "./admin";
import { getDeploymentMode } from "./mode";

export type PacksDb = PgDatabase<PgQueryResultHKT, typeof schema>;

export const MAX_KITCHEN_PACK_BYTES = 2 * 1024 * 1024; // 2,097,152 bytes
export const MAX_KITCHEN_PACKS_PER_KITCHEN = 20;

export const RESERVED_PACK_IDS: ReadonlySet<string> = new Set([
  HOUSEHOLD_PACK.id,
  "new",
  ...PACK_FILE_SOURCES.map((source) => source.id),
]);

const DEFAULT_PACKS_DIR = path.resolve(process.cwd(), "..", "packs");

const UUID_PATTERN =
  /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

const UNSAFE_PACK_ID = /[/\\\s\p{Cc}\p{Cf}]/u;

export class KitchenPackError extends KitchenAdminError {
  constructor(message: string) {
    super(message);
    this.name = "KitchenPackError";
  }
}

export function assertSignInModeForPackSharing(
  command: "pack share" | "pack unshare",
  env: Record<string, string | undefined> = process.env,
): void {
  if (getDeploymentMode(env) === "single-kitchen") {
    throw new KitchenPackError(
      `Cannot run "${command}" in single-kitchen mode (SOUS_SIGN_IN=off): single-kitchen mode has no pack sharing.`,
    );
  }
}

export interface AddKitchenPackInput {
  kitchenSlug: string;
  filePath?: string;
  rawBytes?: Buffer | string;
  packsDir?: string;
}

export interface AddedKitchenPack {
  id: string;
  kitchenId: string;
  kitchenSlug: string;
  kitchenName: string;
  packId: string;
  title: string;
  sizeBytes: number;
  createdAt: Date;
}

export interface ListedKitchenPack {
  id: string;
  kitchenId: string;
  kitchenSlug: string;
  kitchenName: string;
  packId: string;
  title: string;
  sizeBytes: number;
  createdAt: Date;
  shares: Array<{ kitchenId: string; slug: string; name: string }>;
}

export interface RemovedKitchenPack {
  id: string;
  kitchenSlug: string;
  packId: string;
  title: string;
}

export interface ShareKitchenPackResult {
  packId: string;
  title: string;
  ownerKitchenSlug: string;
  sharedWithKitchenSlug: string;
  sharedWithKitchenName: string;
  alreadyShared: boolean;
}

export interface UnshareKitchenPackResult {
  packId: string;
  title: string;
  ownerKitchenSlug: string;
  sharedWithKitchenSlug: string;
  sharedWithKitchenName: string;
  removed: boolean;
}

async function requireKitchen(slug: string, database: PacksDb) {
  const normalized = slug.trim();
  if (!normalized) {
    throw new KitchenPackError("Kitchen slug is required.");
  }
  const [kitchen] = await database
    .select({ id: kitchens.id, slug: kitchens.slug, name: kitchens.name })
    .from(kitchens)
    .where(eq(kitchens.slug, normalized))
    .limit(1);
  if (!kitchen) {
    throw new KitchenPackError(`Kitchen "${normalized}" not found.`);
  }
  return kitchen;
}

async function readPackBuffer(input: AddKitchenPackInput): Promise<Buffer> {
  if (input.rawBytes !== undefined) {
    return typeof input.rawBytes === "string"
      ? Buffer.from(input.rawBytes, "utf8")
      : input.rawBytes;
  }
  if (!input.filePath || input.filePath.trim() === "") {
    throw new KitchenPackError("Pack file path is required.");
  }
  try {
    return await readFile(path.resolve(input.filePath));
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    throw new KitchenPackError(
      `Could not read pack file "${input.filePath}": ${message}`,
    );
  }
}

async function bundledJsonPackIds(packsDir: string): Promise<Set<string>> {
  const ids = new Set<string>(RESERVED_PACK_IDS);
  for (const source of PACK_FILE_SOURCES) {
    if (source.source.type !== "pack-file") continue;
    try {
      const raw = await readFile(path.join(packsDir, source.source.path), "utf8");
      const data = JSON.parse(raw) as { id?: unknown };
      if (typeof data.id === "string" && data.id.length > 0) {
        ids.add(data.id);
      }
    } catch {
      // Ignore unreadable optional pack files; RESERVED_PACK_IDS still covers registry ids.
    }
  }
  return ids;
}

export interface ValidatedKitchenPack {
  pack: Pack;
  sizeBytes: number;
}

/**
 * Validates raw pack JSON bytes against size limits, Pack Format v0 schema,
 * shared library references, reserved/safe IDs, media-ref restrictions, and
 * the cook-mode queue round-trip guard.
 */
export async function validateKitchenPackBytes(
  rawBytes: Buffer | string,
  packsDir: string = DEFAULT_PACKS_DIR,
): Promise<ValidatedKitchenPack> {
  const buffer =
    typeof rawBytes === "string" ? Buffer.from(rawBytes, "utf8") : rawBytes;
  const sizeBytes = buffer.byteLength;
  if (sizeBytes === 0) {
    throw new KitchenPackError("Pack file is empty.");
  }
  if (sizeBytes > MAX_KITCHEN_PACK_BYTES) {
    throw new KitchenPackError(
      `Pack file is ${sizeBytes} bytes, exceeding the ${MAX_KITCHEN_PACK_BYTES}-byte (2 MB) limit.`,
    );
  }

  let data: unknown;
  try {
    data = JSON.parse(buffer.toString("utf8")) as unknown;
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    throw new KitchenPackError(`Invalid JSON in pack file: ${message}`);
  }

  const libraries = await loadLibraries(packsDir);
  if (!libraries.ok) {
    const first = libraries.issues[0];
    throw new KitchenPackError(
      `Cannot verify pack references: ${first ? `${first.path}: ${first.message}` : "libraries unreadable"}.`,
    );
  }

  const parsed = parsePack(data);
  if (!parsed.ok) {
    const first = parsed.issues[0]!;
    throw new KitchenPackError(
      `Invalid pack at ${first.path}: ${first.message}`,
    );
  }

  const refIssues = verifyPackRefs(parsed.value, libraries.libraries);
  if (refIssues.length > 0) {
    const first = refIssues[0]!;
    throw new KitchenPackError(
      `Invalid pack reference at ${first.path}: ${first.message}`,
    );
  }

  if (parsed.value.kind === "household") {
    throw new KitchenPackError('Owned packs cannot have kind "household".');
  }

  const reserved = await bundledJsonPackIds(packsDir);
  if (reserved.has(parsed.value.id)) {
    throw new KitchenPackError(
      `Pack id "${parsed.value.id}" is reserved and cannot be added.`,
    );
  }
  if (
    UNSAFE_PACK_ID.test(parsed.value.id) ||
    parsed.value.id === "." ||
    parsed.value.id === ".."
  ) {
    throw new KitchenPackError(
      `Pack id "${parsed.value.id}" contains unsupported characters.`,
    );
  }

  if (
    parsed.value.cover_ref != null ||
    parsed.value.recipes.some((r) => r.steps.some((s) => s.media_ref != null))
  ) {
    throw new KitchenPackError(
      "Kitchen collections cannot set cover_ref or step media_ref; use null.",
    );
  }

  for (const recipe of parsed.value.recipes) {
    const projected = packRecipeToQueueData(recipe, parsed.value.id);
    if (!projected.ok) {
      throw new KitchenPackError(
        `Invalid recipe "${recipe.title}" (${recipe.id}): ${projected.differences.join("; ")}`,
      );
    }
  }

  return { pack: parsed.value, sizeBytes };
}

/**
 * Validates and stores an owned pack for a kitchen, enforcing:
 * - byte size <= 2 MB (2,097,152 bytes)
 * - valid JSON, Pack Format v0 schema (`parsePack`), and library refs (`verifyPackRefs`)
 * - non-reserved pack id and kind !== "household"
 * - at most 20 owned packs per kitchen and unique pack id per kitchen
 */
export async function addKitchenPack(
  input: AddKitchenPackInput,
  database: PacksDb = db,
): Promise<AddedKitchenPack> {
  const normalizedSlug = input.kitchenSlug.trim();
  if (!normalizedSlug) {
    throw new KitchenPackError("Kitchen slug is required.");
  }

  const buffer = await readPackBuffer(input);
  const { pack, sizeBytes } = await validateKitchenPackBytes(
    buffer,
    input.packsDir ?? DEFAULT_PACKS_DIR,
  );

  return database.transaction(async (tx) => {
    const [kitchen] = await tx
      .select({ id: kitchens.id, slug: kitchens.slug, name: kitchens.name })
      .from(kitchens)
      .where(eq(kitchens.slug, normalizedSlug))
      .for("update")
      .limit(1);

    if (!kitchen) {
      throw new KitchenPackError(`Kitchen "${normalizedSlug}" not found.`);
    }

    const existing = await tx
      .select({ id: kitchenPacks.id, packId: kitchenPacks.packId })
      .from(kitchenPacks)
      .where(eq(kitchenPacks.kitchenId, kitchen.id));

    if (existing.some((row) => row.packId === pack.id)) {
      throw new KitchenPackError(
        `Kitchen "${kitchen.slug}" already owns a pack with id "${pack.id}".`,
      );
    }

    if (existing.length >= MAX_KITCHEN_PACKS_PER_KITCHEN) {
      throw new KitchenPackError(
        `Kitchen "${kitchen.slug}" already owns ${MAX_KITCHEN_PACKS_PER_KITCHEN} packs (maximum reached).`,
      );
    }

    const [inserted] = await tx
      .insert(kitchenPacks)
      .values({
        kitchenId: kitchen.id,
        packId: pack.id,
        packJson: pack,
        sizeBytes,
      })
      .returning();

    return {
      id: inserted!.id,
      kitchenId: kitchen.id,
      kitchenSlug: kitchen.slug,
      kitchenName: kitchen.name,
      packId: inserted!.packId,
      title: pack.title,
      sizeBytes: inserted!.sizeBytes,
      createdAt: inserted!.createdAt,
    };
  });
}

/**
 * Lists owned packs (optionally filtered to one kitchen) along with their shares.
 */
export async function listKitchenPacks(
  input: { kitchenSlug?: string } = {},
  database: PacksDb = db,
): Promise<ListedKitchenPack[]> {
  let filterKitchenId: string | undefined;
  if (input.kitchenSlug !== undefined) {
    const kitchen = await requireKitchen(input.kitchenSlug, database);
    filterKitchenId = kitchen.id;
  }

  const rows = await database
    .select({
      id: kitchenPacks.id,
      kitchenId: kitchenPacks.kitchenId,
      kitchenSlug: kitchens.slug,
      kitchenName: kitchens.name,
      packId: kitchenPacks.packId,
      packJson: kitchenPacks.packJson,
      sizeBytes: kitchenPacks.sizeBytes,
      createdAt: kitchenPacks.createdAt,
    })
    .from(kitchenPacks)
    .innerJoin(kitchens, eq(kitchenPacks.kitchenId, kitchens.id))
    .where(
      filterKitchenId ? eq(kitchenPacks.kitchenId, filterKitchenId) : undefined,
    )
    .orderBy(asc(kitchens.slug), asc(kitchenPacks.createdAt), asc(kitchenPacks.packId));

  if (rows.length === 0) return [];

  const shareRows = await database
    .select({
      kitchenPackId: kitchenPackShares.kitchenPackId,
      kitchenId: kitchens.id,
      slug: kitchens.slug,
      name: kitchens.name,
    })
    .from(kitchenPackShares)
    .innerJoin(kitchens, eq(kitchenPackShares.sharedWithKitchenId, kitchens.id))
    .where(
      inArray(
        kitchenPackShares.kitchenPackId,
        rows.map((r) => r.id),
      ),
    )
    .orderBy(asc(kitchens.slug));

  const sharesByPackId = new Map<
    string,
    Array<{ kitchenId: string; slug: string; name: string }>
  >();
  for (const s of shareRows) {
    const list = sharesByPackId.get(s.kitchenPackId) ?? [];
    list.push({ kitchenId: s.kitchenId, slug: s.slug, name: s.name });
    sharesByPackId.set(s.kitchenPackId, list);
  }

  return rows.map((row) => ({
    id: row.id,
    kitchenId: row.kitchenId,
    kitchenSlug: row.kitchenSlug,
    kitchenName: row.kitchenName,
    packId: row.packId,
    title: row.packJson.title,
    sizeBytes: row.sizeBytes,
    createdAt: row.createdAt,
    shares: sharesByPackId.get(row.id) ?? [],
  }));
}

interface ResolvedOwnedPack {
  id: string;
  kitchenId: string;
  kitchenSlug: string;
  packId: string;
  title: string;
}

async function resolveOwnedPack(
  input: { pack: string; kitchenSlug?: string },
  database: PacksDb,
): Promise<ResolvedOwnedPack> {
  const packRef = input.pack.trim();
  if (!packRef) {
    throw new KitchenPackError("Pack id is required.");
  }

  const filterKitchen =
    input.kitchenSlug !== undefined
      ? await requireKitchen(input.kitchenSlug, database)
      : undefined;

  const isUuid = UUID_PATTERN.test(packRef);
  const condition = isUuid
    ? filterKitchen
      ? and(eq(kitchenPacks.id, packRef), eq(kitchenPacks.kitchenId, filterKitchen.id))
      : eq(kitchenPacks.id, packRef)
    : filterKitchen
      ? and(eq(kitchenPacks.packId, packRef), eq(kitchenPacks.kitchenId, filterKitchen.id))
      : eq(kitchenPacks.packId, packRef);

  const matches = await database
    .select({
      id: kitchenPacks.id,
      kitchenId: kitchenPacks.kitchenId,
      kitchenSlug: kitchens.slug,
      packId: kitchenPacks.packId,
      packJson: kitchenPacks.packJson,
    })
    .from(kitchenPacks)
    .innerJoin(kitchens, eq(kitchenPacks.kitchenId, kitchens.id))
    .where(condition);

  if (matches.length === 0) {
    throw new KitchenPackError(
      filterKitchen
        ? `Pack "${packRef}" not found in kitchen "${filterKitchen.slug}".`
        : `Pack "${packRef}" not found.`,
    );
  }

  if (matches.length > 1) {
    const slugs = matches.map((m) => m.kitchenSlug).join(", ");
    throw new KitchenPackError(
      `Pack "${packRef}" exists in multiple kitchens (${slugs}); pass --kitchen <slug> to specify which.`,
    );
  }

  const match = matches[0]!;
  return {
    id: match.id,
    kitchenId: match.kitchenId,
    kitchenSlug: match.kitchenSlug,
    packId: match.packId,
    title: match.packJson.title,
  };
}

/**
 * Removes an owned pack (and cascades its shares). Queued recipes keep working
 * from their stored snapshot.
 */
export async function removeKitchenPack(
  input: { pack: string; kitchenSlug?: string },
  database: PacksDb = db,
): Promise<RemovedKitchenPack> {
  const resolved = await resolveOwnedPack(input, database);
  await database.delete(kitchenPacks).where(eq(kitchenPacks.id, resolved.id));
  return {
    id: resolved.id,
    kitchenSlug: resolved.kitchenSlug,
    packId: resolved.packId,
    title: resolved.title,
  };
}

/**
 * Shares an owned pack with another kitchen. Refused in single-kitchen mode.
 */
export async function shareKitchenPack(
  input: { pack: string; withKitchenSlug: string; kitchenSlug?: string },
  database: PacksDb = db,
  env: Record<string, string | undefined> = process.env,
): Promise<ShareKitchenPackResult> {
  assertSignInModeForPackSharing("pack share", env);
  const resolved = await resolveOwnedPack(
    { pack: input.pack, kitchenSlug: input.kitchenSlug },
    database,
  );
  const target = await requireKitchen(input.withKitchenSlug, database);

  if (resolved.kitchenId === target.id) {
    throw new KitchenPackError(
      `Cannot share pack "${resolved.packId}" with its own kitchen "${target.slug}".`,
    );
  }

  const inserted = await database
    .insert(kitchenPackShares)
    .values({
      kitchenPackId: resolved.id,
      sharedWithKitchenId: target.id,
    })
    .onConflictDoNothing()
    .returning({ id: kitchenPackShares.id });

  return {
    packId: resolved.packId,
    title: resolved.title,
    ownerKitchenSlug: resolved.kitchenSlug,
    sharedWithKitchenSlug: target.slug,
    sharedWithKitchenName: target.name,
    alreadyShared: inserted.length === 0,
  };
}

/**
 * Unshares an owned pack from another kitchen. Refused in single-kitchen mode.
 */
export async function unshareKitchenPack(
  input: { pack: string; withKitchenSlug: string; kitchenSlug?: string },
  database: PacksDb = db,
  env: Record<string, string | undefined> = process.env,
): Promise<UnshareKitchenPackResult> {
  assertSignInModeForPackSharing("pack unshare", env);
  const resolved = await resolveOwnedPack(
    { pack: input.pack, kitchenSlug: input.kitchenSlug },
    database,
  );
  const target = await requireKitchen(input.withKitchenSlug, database);

  const deleted = await database
    .delete(kitchenPackShares)
    .where(
      and(
        eq(kitchenPackShares.kitchenPackId, resolved.id),
        eq(kitchenPackShares.sharedWithKitchenId, target.id),
      ),
    )
    .returning({ id: kitchenPackShares.id });

  return {
    packId: resolved.packId,
    title: resolved.title,
    ownerKitchenSlug: resolved.kitchenSlug,
    sharedWithKitchenSlug: target.slug,
    sharedWithKitchenName: target.name,
    removed: deleted.length > 0,
  };
}

/**
 * Reads all DB packs visible to a kitchen: owned packs first, then packs shared
 * with it (omitting shares in single-kitchen mode).
 */
export async function readVisibleKitchenPacks(
  kitchenId: string,
  database: PacksDb = db,
  env: Record<string, string | undefined> = process.env,
): Promise<KitchenPackRecord[]> {
  const owned = await database
    .select({
      id: kitchenPacks.id,
      packId: kitchenPacks.packId,
      packJson: kitchenPacks.packJson,
    })
    .from(kitchenPacks)
    .where(eq(kitchenPacks.kitchenId, kitchenId))
    .orderBy(asc(kitchenPacks.createdAt), asc(kitchenPacks.packId));

  const records: KitchenPackRecord[] = owned.map((row) => ({
    id: row.id,
    packId: row.packId,
    packJson: row.packJson as Pack,
    isOwned: true,
    fromKitchenName: null,
  }));

  if (getDeploymentMode(env) === "single-kitchen") {
    return records;
  }

  const shared = await database
    .select({
      id: kitchenPacks.id,
      packId: kitchenPacks.packId,
      packJson: kitchenPacks.packJson,
      fromKitchenName: kitchens.name,
    })
    .from(kitchenPackShares)
    .innerJoin(kitchenPacks, eq(kitchenPackShares.kitchenPackId, kitchenPacks.id))
    .innerJoin(kitchens, eq(kitchenPacks.kitchenId, kitchens.id))
    .where(eq(kitchenPackShares.sharedWithKitchenId, kitchenId))
    .orderBy(asc(kitchenPackShares.createdAt), asc(kitchenPacks.packId));

  for (const row of shared) {
    records.push({
      id: row.id,
      packId: row.packId,
      packJson: row.packJson as Pack,
      isOwned: false,
      fromKitchenName: row.fromKitchenName,
    });
  }

  return records;
}

export interface UpsertKitchenPackResult {
  id: string;
  packId: string;
  title: string;
  recipes: number;
  sizeBytes: number;
  updated: boolean;
}

export interface OwnedKitchenPackSummary {
  id: string;
  packId: string;
  title: string;
  creator: string;
  recipes: number;
  sizeBytes: number;
}

/**
 * Validates and saves (creates or updates in place) an owned collection for a
 * kitchen. Updating an existing packId keeps its row UUID and circle shares.
 */
export async function upsertKitchenPackByKitchenId(
  kitchenId: string,
  input: { rawBytes: Buffer | string; packsDir?: string },
  database: PacksDb = db,
): Promise<UpsertKitchenPackResult> {
  const { pack, sizeBytes } = await validateKitchenPackBytes(
    input.rawBytes,
    input.packsDir ?? DEFAULT_PACKS_DIR,
  );

  return database.transaction(async (tx) => {
    const [kitchen] = await tx
      .select({ id: kitchens.id, slug: kitchens.slug })
      .from(kitchens)
      .where(eq(kitchens.id, kitchenId))
      .for("update")
      .limit(1);

    if (!kitchen) {
      throw new KitchenPackError("Kitchen not found.");
    }

    const existing = await tx
      .select({ id: kitchenPacks.id, packId: kitchenPacks.packId })
      .from(kitchenPacks)
      .where(eq(kitchenPacks.kitchenId, kitchenId));

    const match = existing.find((row) => row.packId === pack.id);
    if (match) {
      await tx
        .update(kitchenPacks)
        .set({
          packJson: pack,
          sizeBytes,
        })
        .where(
          and(
            eq(kitchenPacks.id, match.id),
            eq(kitchenPacks.kitchenId, kitchenId),
          ),
        );
      return {
        id: match.id,
        packId: pack.id,
        title: pack.title,
        recipes: pack.recipes.length,
        sizeBytes,
        updated: true,
      };
    }

    if (existing.length >= MAX_KITCHEN_PACKS_PER_KITCHEN) {
      throw new KitchenPackError(
        `Kitchen "${kitchen.slug}" already owns ${MAX_KITCHEN_PACKS_PER_KITCHEN} packs (maximum reached).`,
      );
    }

    const [inserted] = await tx
      .insert(kitchenPacks)
      .values({
        kitchenId,
        packId: pack.id,
        packJson: pack,
        sizeBytes,
      })
      .returning();

    return {
      id: inserted!.id,
      packId: inserted!.packId,
      title: pack.title,
      recipes: pack.recipes.length,
      sizeBytes: inserted!.sizeBytes,
      updated: false,
    };
  });
}

/**
 * Reads one owned collection in full for editing by its kitchen owner.
 */
export async function getOwnedKitchenPackRaw(
  kitchenId: string,
  packId: string,
  database: PacksDb = db,
): Promise<{
  id: string;
  packId: string;
  packJson: Pack;
  sizeBytes: number;
  createdAt: Date;
} | null> {
  const [row] = await database
    .select({
      id: kitchenPacks.id,
      packId: kitchenPacks.packId,
      packJson: kitchenPacks.packJson,
      sizeBytes: kitchenPacks.sizeBytes,
      createdAt: kitchenPacks.createdAt,
    })
    .from(kitchenPacks)
    .where(
      and(
        eq(kitchenPacks.kitchenId, kitchenId),
        eq(kitchenPacks.packId, packId),
      ),
    )
    .limit(1);

  if (!row) return null;
  return {
    id: row.id,
    packId: row.packId,
    packJson: row.packJson as Pack,
    sizeBytes: row.sizeBytes,
    createdAt: row.createdAt,
  };
}

/**
 * Lists summaries of collections owned by a single kitchen.
 */
export async function listOwnedKitchenPacksForKitchen(
  kitchenId: string,
  database: PacksDb = db,
): Promise<OwnedKitchenPackSummary[]> {
  const rows = await database
    .select({
      id: kitchenPacks.id,
      packId: kitchenPacks.packId,
      packJson: kitchenPacks.packJson,
      sizeBytes: kitchenPacks.sizeBytes,
    })
    .from(kitchenPacks)
    .where(eq(kitchenPacks.kitchenId, kitchenId))
    .orderBy(asc(kitchenPacks.createdAt), asc(kitchenPacks.packId));

  return rows.map((row) => {
    const pack = row.packJson as Pack;
    return {
      id: row.id,
      packId: row.packId,
      title: pack.title,
      creator: pack.creator.name,
      recipes: pack.recipes.length,
      sizeBytes: row.sizeBytes,
    };
  });
}

/**
 * Removes an owned collection scoped to a single kitchen.
 */
export async function removeOwnedKitchenPack(
  kitchenId: string,
  packId: string,
  database: PacksDb = db,
): Promise<{ removed: boolean; packId: string }> {
  const deleted = await database
    .delete(kitchenPacks)
    .where(
      and(
        eq(kitchenPacks.kitchenId, kitchenId),
        eq(kitchenPacks.packId, packId),
      ),
    )
    .returning({ id: kitchenPacks.id, packId: kitchenPacks.packId });

  return {
    removed: deleted.length > 0,
    packId,
  };
}
