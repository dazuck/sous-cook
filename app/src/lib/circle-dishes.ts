import { and, asc, desc, eq, gte, inArray, ne, or, sql } from "drizzle-orm";
import type { PgDatabase, PgQueryResultHKT } from "drizzle-orm/pg-core";
import type { Pack, Recipe } from "@sous/pack";
import * as schema from "../../drizzle/schema";
import type { KitchenQueueRecipeData } from "../../drizzle/schema";
import {
  circleMembers,
  circles,
  db,
  docRecipes,
  kitchenCookLog,
  kitchenPacks,
  kitchenPackShares,
  kitchenQueue,
  kitchens,
} from "./db";
import { getDeploymentMode } from "./kitchens/deployment";
import { UUID_PATTERN } from "./kitchens/circles";
import {
  readVisibleKitchenPacks,
  shareKitchenPack,
  unshareKitchenPack,
} from "./kitchens/packs";
import { packRecipeToQueueData, parsePackSource } from "./pack-convert/to-queue";
import { docRecipeToQueueData, slugify } from "./recipe-sync";
import { loadAppPackFiles } from "./shelf/load";

export type CircleDishesDb = PgDatabase<PgQueryResultHKT, typeof schema>;

/**
 * Raised on any missing, private, unshared-pack, out-of-circle, or pre-join
 * circle dish or share link so callers never learn whether a row exists.
 */
export class CircleNotAvailableError extends Error {
  constructor() {
    super("Not available");
    this.name = "CircleNotAvailableError";
  }
}

export class PackCircleShareError extends Error {
  constructor(
    readonly code: "FORBIDDEN" | "NOT_FOUND" | "BAD_REQUEST",
    message: string,
  ) {
    super(message);
    this.name = "PackCircleShareError";
  }
}

export interface CircleDishSummary {
  logId: string;
  recipeTitle: string;
  kitchenName: string;
  cookedDay: string;
  rating: number | null;
  note: string | null;
  canOpenRecipe: boolean;
  packBlocked: boolean;
}

export interface ReadOnlyCircleRecipe {
  logId: string;
  title: string;
  kitchenName: string;
  cookedDay: string;
  rating: number | null;
  note: string | null;
  recipe: KitchenQueueRecipeData;
  isPackRecipe: boolean;
  sourceKitchenPackId: string | null;
}

export interface ReadOnlySharedRecipe {
  recipeId: string;
  title: string;
  kitchenName: string;
  recipe: KitchenQueueRecipeData;
}

export interface CirclePackShareTarget {
  kitchenId: string;
  slug: string;
  name: string;
  shared: boolean;
}

export interface PackCircleSharesView {
  circleName: string | null;
  kitchens: CirclePackShareTarget[];
}

interface ViewerPackVisibility {
  bundledPacksById: Map<string, Pack>;
  dbPacksByUuid: Map<string, Pack>;
}

async function loadViewerPackVisibility(
  viewerKitchenId: string,
  database: CircleDishesDb,
  env: Record<string, string | undefined>,
): Promise<ViewerPackVisibility> {
  const bundledPacksById = new Map<string, Pack>();
  const base = await loadAppPackFiles();
  for (const pack of base.packs) {
    bundledPacksById.set(pack.id, pack);
  }
  const dbPacksByUuid = new Map<string, Pack>();
  const dbPacks = await readVisibleKitchenPacks(viewerKitchenId, database, env);
  for (const record of dbPacks) {
    const pack = record.packJson as Pack;
    if (
      pack &&
      typeof pack.id === "string" &&
      pack.kind !== "household" &&
      !bundledPacksById.has(pack.id)
    ) {
      dbPacksByUuid.set(record.id, pack);
    }
  }
  return { bundledPacksById, dbPacksByUuid };
}

async function resolveDishPackForViewer(
  dish: {
    kitchenId: string;
    sourceKitchenPackId: string | null;
  },
  packRef: { packId: string; recipeId: string },
  visibility: ViewerPackVisibility,
  database: CircleDishesDb,
  env: Record<string, string | undefined>,
  ownerVisibleCache?: Map<string, Awaited<ReturnType<typeof readVisibleKitchenPacks>>>,
): Promise<{ pack: Pack; recipe: Recipe; sourceKitchenPackId: string | null } | null> {
  const bundled = visibility.bundledPacksById.get(packRef.packId);
  if (bundled) {
    const bundledRecipe = bundled.recipes.find((r) => r.id === packRef.recipeId);
    if (!bundledRecipe) return null;
    return { pack: bundled, recipe: bundledRecipe, sourceKitchenPackId: null };
  }

  let targetKitchenPackId = dish.sourceKitchenPackId;
  if (targetKitchenPackId === null) {
    let ownerPacks = ownerVisibleCache?.get(dish.kitchenId);
    if (!ownerPacks) {
      ownerPacks = await readVisibleKitchenPacks(dish.kitchenId, database, env);
      ownerVisibleCache?.set(dish.kitchenId, ownerPacks);
    }
    targetKitchenPackId =
      ownerPacks.find(
        (record) =>
          (record.packId ?? (record.packJson as { id?: unknown } | null)?.id) ===
          packRef.packId,
      )?.id ?? null;
  }
  if (!targetKitchenPackId) {
    return null;
  }

  const dbPack = visibility.dbPacksByUuid.get(targetKitchenPackId);
  const dbRecipe = dbPack?.recipes.find((r) => r.id === packRef.recipeId);
  if (!dbPack || !dbRecipe) {
    return null;
  }
  return {
    pack: dbPack,
    recipe: dbRecipe,
    sourceKitchenPackId: targetKitchenPackId,
  };
}

function hasReadableRecipeContent(
  recipe: KitchenQueueRecipeData | null | undefined,
): boolean {
  if (!recipe) return false;
  const stepsCount = recipe.steps?.length ?? 0;
  const ingredientsCount = recipe.ingredients?.length ?? 0;
  return stepsCount > 0 || ingredientsCount > 0;
}

function visibleNoteForCircle(
  row: {
    notes: string;
    notePrivate: boolean;
    noteUpdatedAt: Date | null;
  },
  joinedAt: Date,
): string | null {
  if (row.notePrivate) return null;
  const trimmed = row.notes.trim();
  if (trimmed.length === 0) return null;
  if (row.noteUpdatedAt !== null && row.noteUpdatedAt.getTime() < joinedAt.getTime()) {
    return null;
  }
  return trimmed;
}

async function isCookLogRowPrivate(
  cookKitchenId: string,
  row: {
    docRecipeId: string | null;
    queueId: string | null;
    packSource: string | null;
    recipeIsPrivate: boolean;
    recipeTitle: string;
    recipeSnapshot: KitchenQueueRecipeData | null;
  },
  database: CircleDishesDb,
): Promise<{ isPrivate: boolean; docRow: typeof docRecipes.$inferSelect | null }> {
  if (row.recipeIsPrivate) {
    return { isPrivate: true, docRow: null };
  }

  let docRow: typeof docRecipes.$inferSelect | null = null;

  if (row.docRecipeId) {
    const [foundDoc] = await database
      .select()
      .from(docRecipes)
      .where(
        and(
          eq(docRecipes.id, row.docRecipeId),
          eq(docRecipes.kitchenId, cookKitchenId),
        ),
      )
      .limit(1);
    docRow = foundDoc ?? null;
    if (docRow?.isPrivate) {
      return { isPrivate: true, docRow };
    }
  }

  let queueRow: { isPrivate: boolean; source: string | null } | null = null;
  if (row.queueId) {
    const [foundQueue] = await database
      .select({
        isPrivate: kitchenQueue.isPrivate,
        recipeData: kitchenQueue.recipeData,
      })
      .from(kitchenQueue)
      .where(
        and(
          eq(kitchenQueue.id, row.queueId),
          eq(kitchenQueue.kitchenId, cookKitchenId),
        ),
      )
      .limit(1);
    if (foundQueue) {
      queueRow = {
        isPrivate: foundQueue.isPrivate,
        source: foundQueue.recipeData?.source ?? null,
      };
      if (foundQueue.isPrivate) {
        return { isPrivate: true, docRow };
      }
    }
  }

  const effectiveSource =
    row.packSource ?? row.recipeSnapshot?.source ?? queueRow?.source ?? null;
  if (!docRow && effectiveSource === "library") {
    const slug = slugify(row.recipeTitle);
    const matchingDocs = await database
      .select()
      .from(docRecipes)
      .where(
        and(
          eq(docRecipes.kitchenId, cookKitchenId),
          or(
            ...(slug ? [eq(docRecipes.docSlug, slug)] : []),
            sql`lower(${docRecipes.name}) = lower(${row.recipeTitle})`,
          ),
        ),
      )
      .orderBy(desc(docRecipes.isPrivate));
    docRow = matchingDocs[0] ?? null;
    if (matchingDocs.some((d) => d.isPrivate)) {
      return { isPrivate: true, docRow };
    }
  }

  return { isPrivate: false, docRow };
}

/**
 * Returns, for each other kitchen in the viewer's circle, its most recent
 * showing finished dish cooked after joining the circle. Always empty in
 * single-kitchen mode or when the kitchen is not in a circle.
 */
export async function getCircleDishesForKitchen(
  viewerKitchenId: string,
  database: CircleDishesDb = db,
  env: Record<string, string | undefined> = process.env,
): Promise<CircleDishSummary[]> {
  if (getDeploymentMode(env) !== "sign-in") {
    return [];
  }

  const [viewerMembership] = await database
    .select({ circleId: circleMembers.circleId })
    .from(circleMembers)
    .where(eq(circleMembers.kitchenId, viewerKitchenId))
    .limit(1);

  if (!viewerMembership) {
    return [];
  }

  const otherMembers = await database
    .select({
      kitchenId: kitchens.id,
      kitchenName: kitchens.name,
      joinedAt: circleMembers.joinedAt,
    })
    .from(circleMembers)
    .innerJoin(kitchens, eq(circleMembers.kitchenId, kitchens.id))
    .where(
      and(
        eq(circleMembers.circleId, viewerMembership.circleId),
        ne(circleMembers.kitchenId, viewerKitchenId),
      ),
    )
    .orderBy(asc(kitchens.name), asc(kitchens.slug));

  if (otherMembers.length === 0) {
    return [];
  }

  const latestPerMember = await Promise.all(
    otherMembers.map(async (member) => {
      const [dish] = await database
        .select({
          id: kitchenCookLog.id,
          kitchenId: kitchenCookLog.kitchenId,
          queueId: kitchenCookLog.queueId,
          docRecipeId: kitchenCookLog.docRecipeId,
          packSource: kitchenCookLog.packSource,
          sourceKitchenPackId: kitchenCookLog.sourceKitchenPackId,
          recipeIsPrivate: kitchenCookLog.recipeIsPrivate,
          recipeSnapshot: kitchenCookLog.recipeSnapshot,
          recipeTitle: kitchenCookLog.recipeTitle,
          cookedDay: kitchenCookLog.cookedDay,
          rating: kitchenCookLog.rating,
          notes: kitchenCookLog.notes,
          notePrivate: kitchenCookLog.notePrivate,
          noteUpdatedAt: kitchenCookLog.noteUpdatedAt,
        })
        .from(kitchenCookLog)
        .where(
          and(
            eq(kitchenCookLog.kitchenId, member.kitchenId),
            eq(kitchenCookLog.heldBack, false),
            gte(kitchenCookLog.cookedAt, member.joinedAt),
          ),
        )
        .orderBy(desc(kitchenCookLog.cookedAt), desc(kitchenCookLog.position))
        .limit(1);

      return dish ? { member, dish } : null;
    }),
  );

  const entries = latestPerMember.filter(
    (item): item is NonNullable<typeof item> => item !== null,
  );
  if (entries.length === 0) {
    return [];
  }

  const hasAnyPack = entries.some(
    ({ dish }) =>
      parsePackSource(dish.packSource ?? dish.recipeSnapshot?.source) !== null,
  );
  const visibility = hasAnyPack
    ? await loadViewerPackVisibility(viewerKitchenId, database, env)
    : null;
  const ownerVisibleCache = new Map<
    string,
    Awaited<ReturnType<typeof readVisibleKitchenPacks>>
  >();

  const docIds = [
    ...new Set(
      entries
        .map(({ dish }) => dish.docRecipeId)
        .filter((id): id is string => id !== null),
    ),
  ];
  const queueIds = [
    ...new Set(
      entries
        .map(({ dish }) => dish.queueId)
        .filter((id): id is string => id !== null),
    ),
  ];

  const privateDocIds = new Set<string>();
  const readableDocIds = new Set<string>();
  if (docIds.length > 0) {
    const docs = await database
      .select({
        id: docRecipes.id,
        isPrivate: docRecipes.isPrivate,
        extractionError: docRecipes.extractionError,
        ingredients: docRecipes.ingredients,
        steps: docRecipes.steps,
      })
      .from(docRecipes)
      .where(inArray(docRecipes.id, docIds));
    for (const d of docs) {
      if (d.isPrivate) privateDocIds.add(d.id);
      if (
        !d.extractionError &&
        ((d.steps?.length ?? 0) > 0 || (d.ingredients?.length ?? 0) > 0)
      ) {
        readableDocIds.add(d.id);
      }
    }
  }

  const privateQueueIds = new Set<string>();
  const libraryQueueSources = new Set<string>();
  if (queueIds.length > 0) {
    const qRows = await database
      .select({
        id: kitchenQueue.id,
        isPrivate: kitchenQueue.isPrivate,
        recipeData: kitchenQueue.recipeData,
      })
      .from(kitchenQueue)
      .where(inArray(kitchenQueue.id, queueIds));
    for (const q of qRows) {
      if (q.isPrivate) privateQueueIds.add(q.id);
      if (q.recipeData?.source === "library") {
        libraryQueueSources.add(q.id);
      }
    }
  }

  const results: CircleDishSummary[] = [];
  for (const { member, dish } of entries) {
    const packRef = parsePackSource(
      dish.packSource ?? dish.recipeSnapshot?.source,
    );
    if (packRef !== null) {
      const matchedPack = visibility
        ? await resolveDishPackForViewer(
            dish,
            packRef,
            visibility,
            database,
            env,
            ownerVisibleCache,
          )
        : null;
      if (!matchedPack) {
        results.push({
          logId: dish.id,
          recipeTitle: dish.recipeTitle,
          kitchenName: member.kitchenName,
          cookedDay: dish.cookedDay,
          rating: null,
          note: null,
          canOpenRecipe: false,
          packBlocked: true,
        });
        continue;
      }
    }

    let isPrivate =
      dish.recipeIsPrivate ||
      (dish.docRecipeId !== null && privateDocIds.has(dish.docRecipeId)) ||
      (dish.queueId !== null && privateQueueIds.has(dish.queueId));

    if (
      !isPrivate &&
      dish.docRecipeId === null &&
      ((dish.queueId !== null && libraryQueueSources.has(dish.queueId)) ||
        dish.recipeSnapshot?.source === "library")
    ) {
      const slug = slugify(dish.recipeTitle);
      const matchingDocs = await database
        .select({ isPrivate: docRecipes.isPrivate })
        .from(docRecipes)
        .where(
          and(
            eq(docRecipes.kitchenId, member.kitchenId),
            or(
              ...(slug ? [eq(docRecipes.docSlug, slug)] : []),
              sql`lower(${docRecipes.name}) = lower(${dish.recipeTitle})`,
            ),
          ),
        );
      if (matchingDocs.some((d) => d.isPrivate)) {
        isPrivate = true;
      }
    }

    const canReadRecipe =
      hasReadableRecipeContent(dish.recipeSnapshot) ||
      (dish.docRecipeId !== null && readableDocIds.has(dish.docRecipeId)) ||
      packRef !== null;

    results.push({
      logId: dish.id,
      recipeTitle: dish.recipeTitle,
      kitchenName: member.kitchenName,
      cookedDay: dish.cookedDay,
      rating: dish.rating,
      note: visibleNoteForCircle(dish, member.joinedAt),
      canOpenRecipe: !isPrivate && canReadRecipe,
      packBlocked: false,
    });
  }

  return results;
}

/**
 * Resolves a friend's shown dish for read-only viewing or queuing, enforcing
 * circle membership, join-time boundary, hold-back rule, recipe privacy, and
 * pack visibility. Throws `CircleNotAvailableError` on any denial.
 */
export async function resolveAccessibleCircleDish(
  viewerKitchenId: string,
  logId: string,
  database: CircleDishesDb = db,
  env: Record<string, string | undefined> = process.env,
): Promise<ReadOnlyCircleRecipe> {
  if (getDeploymentMode(env) !== "sign-in" || !UUID_PATTERN.test(logId)) {
    throw new CircleNotAvailableError();
  }

  const [viewerMember] = await database
    .select({ circleId: circleMembers.circleId })
    .from(circleMembers)
    .where(eq(circleMembers.kitchenId, viewerKitchenId))
    .limit(1);

  if (!viewerMember) {
    throw new CircleNotAvailableError();
  }

  const [row] = await database
    .select({
      id: kitchenCookLog.id,
      kitchenId: kitchenCookLog.kitchenId,
      queueId: kitchenCookLog.queueId,
      docRecipeId: kitchenCookLog.docRecipeId,
      packSource: kitchenCookLog.packSource,
      sourceKitchenPackId: kitchenCookLog.sourceKitchenPackId,
      recipeIsPrivate: kitchenCookLog.recipeIsPrivate,
      recipeSnapshot: kitchenCookLog.recipeSnapshot,
      recipeTitle: kitchenCookLog.recipeTitle,
      cookedDay: kitchenCookLog.cookedDay,
      cookedAt: kitchenCookLog.cookedAt,
      rating: kitchenCookLog.rating,
      notes: kitchenCookLog.notes,
      notePrivate: kitchenCookLog.notePrivate,
      noteUpdatedAt: kitchenCookLog.noteUpdatedAt,
      heldBack: kitchenCookLog.heldBack,
    })
    .from(kitchenCookLog)
    .where(eq(kitchenCookLog.id, logId))
    .limit(1);

  if (!row || row.kitchenId === viewerKitchenId || row.heldBack) {
    throw new CircleNotAvailableError();
  }

  const [cookMember] = await database
    .select({
      circleId: circleMembers.circleId,
      joinedAt: circleMembers.joinedAt,
      kitchenName: kitchens.name,
    })
    .from(circleMembers)
    .innerJoin(kitchens, eq(circleMembers.kitchenId, kitchens.id))
    .where(eq(circleMembers.kitchenId, row.kitchenId))
    .limit(1);

  if (!cookMember || cookMember.circleId !== viewerMember.circleId) {
    throw new CircleNotAvailableError();
  }

  if (row.cookedAt.getTime() < cookMember.joinedAt.getTime()) {
    throw new CircleNotAvailableError();
  }

  const { isPrivate, docRow } = await isCookLogRowPrivate(
    row.kitchenId,
    row,
    database,
  );
  if (isPrivate) {
    throw new CircleNotAvailableError();
  }

  const packRef = parsePackSource(
    row.packSource ?? row.recipeSnapshot?.source,
  );
  let resolvedSourceKitchenPackId: string | null = null;
  let packRecipeData: KitchenQueueRecipeData | null = null;
  if (packRef !== null) {
    const visibility = await loadViewerPackVisibility(
      viewerKitchenId,
      database,
      env,
    );
    const matchedPack = await resolveDishPackForViewer(
      row,
      packRef,
      visibility,
      database,
      env,
    );
    if (!matchedPack) {
      throw new CircleNotAvailableError();
    }
    resolvedSourceKitchenPackId = matchedPack.sourceKitchenPackId;
    if (!hasReadableRecipeContent(row.recipeSnapshot)) {
      const projected = packRecipeToQueueData(
        matchedPack.recipe,
        matchedPack.pack.id,
      );
      if (projected.ok) {
        packRecipeData = projected.projection.recipeData;
      }
    }
  }

  let recipe: KitchenQueueRecipeData | null = null;
  if (hasReadableRecipeContent(row.recipeSnapshot)) {
    recipe = row.recipeSnapshot!;
  } else if (docRow && !docRow.extractionError) {
    const fromDoc = docRecipeToQueueData(docRow);
    if (hasReadableRecipeContent(fromDoc)) {
      recipe = fromDoc;
    }
  } else if (hasReadableRecipeContent(packRecipeData)) {
    recipe = packRecipeData;
  }

  if (!recipe) {
    throw new CircleNotAvailableError();
  }

  const normalizedRecipe: KitchenQueueRecipeData = {
    ...recipe,
    name: recipe.name?.trim() || row.recipeTitle,
    source:
      packRef !== null
        ? row.packSource ?? row.recipeSnapshot?.source
        : recipe.source === "library"
          ? undefined
          : recipe.source,
  };

  return {
    logId: row.id,
    title: row.recipeTitle,
    kitchenName: cookMember.kitchenName,
    cookedDay: row.cookedDay,
    rating: row.rating,
    note: visibleNoteForCircle(row, cookMember.joinedAt),
    recipe: normalizedRecipe,
    isPackRecipe: packRef !== null,
    sourceKitchenPackId: resolvedSourceKitchenPackId,
  };
}

/**
 * Resolves a share-linked recipe (`/kitchen/shared/[recipeId]`). Opens only
 * for a signed-in member of a kitchen in the same circle as the owning
 * kitchen, when the recipe is not private. Throws `CircleNotAvailableError`
 * identically on every failure so callers never learn whether a recipe exists.
 */
export async function resolveSharedRecipe(
  viewerKitchenId: string,
  recipeId: string,
  database: CircleDishesDb = db,
  env: Record<string, string | undefined> = process.env,
): Promise<ReadOnlySharedRecipe> {
  if (getDeploymentMode(env) !== "sign-in" || !UUID_PATTERN.test(recipeId)) {
    throw new CircleNotAvailableError();
  }

  const [viewerMember] = await database
    .select({ circleId: circleMembers.circleId })
    .from(circleMembers)
    .where(eq(circleMembers.kitchenId, viewerKitchenId))
    .limit(1);

  if (!viewerMember) {
    throw new CircleNotAvailableError();
  }

  const [docRow] = await database
    .select()
    .from(docRecipes)
    .where(eq(docRecipes.id, recipeId))
    .limit(1);

  if (docRow) {
    if (docRow.isPrivate || docRow.extractionError) {
      throw new CircleNotAvailableError();
    }
    const [ownerMember] = await database
      .select({
        circleId: circleMembers.circleId,
        kitchenName: kitchens.name,
      })
      .from(circleMembers)
      .innerJoin(kitchens, eq(circleMembers.kitchenId, kitchens.id))
      .where(eq(circleMembers.kitchenId, docRow.kitchenId))
      .limit(1);

    if (!ownerMember || ownerMember.circleId !== viewerMember.circleId) {
      throw new CircleNotAvailableError();
    }

    const recipeData = docRecipeToQueueData(docRow);
    if (!hasReadableRecipeContent(recipeData)) {
      throw new CircleNotAvailableError();
    }

    return {
      recipeId: docRow.id,
      title: docRow.name,
      kitchenName: ownerMember.kitchenName,
      recipe: {
        ...recipeData,
        source: undefined,
      },
    };
  }

  const [queueRow] = await database
    .select()
    .from(kitchenQueue)
    .where(eq(kitchenQueue.id, recipeId))
    .limit(1);

  if (!queueRow || queueRow.isPrivate || !queueRow.recipeData) {
    throw new CircleNotAvailableError();
  }

  if (parsePackSource(queueRow.recipeData.source) !== null) {
    throw new CircleNotAvailableError();
  }

  const [ownerMember] = await database
    .select({
      circleId: circleMembers.circleId,
      kitchenName: kitchens.name,
    })
    .from(circleMembers)
    .innerJoin(kitchens, eq(circleMembers.kitchenId, kitchens.id))
    .where(eq(circleMembers.kitchenId, queueRow.kitchenId))
    .limit(1);

  if (!ownerMember || ownerMember.circleId !== viewerMember.circleId) {
    throw new CircleNotAvailableError();
  }

  if (queueRow.recipeData.source === "library" && queueRow.recipeData.name) {
    const slug = slugify(queueRow.recipeData.name);
    const matchingDocs = await database
      .select({ isPrivate: docRecipes.isPrivate })
      .from(docRecipes)
      .where(
        and(
          eq(docRecipes.kitchenId, queueRow.kitchenId),
          or(
            ...(slug ? [eq(docRecipes.docSlug, slug)] : []),
            sql`lower(${docRecipes.name}) = lower(${queueRow.recipeData.name})`,
          ),
        ),
      );
    if (matchingDocs.some((d) => d.isPrivate)) {
      throw new CircleNotAvailableError();
    }
  }

  if (!hasReadableRecipeContent(queueRow.recipeData)) {
    throw new CircleNotAvailableError();
  }

  return {
    recipeId: queueRow.id,
    title: queueRow.recipeData.name,
    kitchenName: ownerMember.kitchenName,
    recipe: {
      ...queueRow.recipeData,
      source:
        queueRow.recipeData.source === "library"
          ? undefined
          : queueRow.recipeData.source,
    },
  };
}

/**
 * Lists the other kitchens in the owner's circle and whether a pack owned by
 * this kitchen is shared with each of them.
 */
export async function getPackCircleSharesForOwner(
  ownerKitchenId: string,
  packId: string,
  database: CircleDishesDb = db,
  env: Record<string, string | undefined> = process.env,
): Promise<PackCircleSharesView> {
  if (getDeploymentMode(env) !== "sign-in") {
    throw new PackCircleShareError(
      "FORBIDDEN",
      "Pack sharing is only available in sign-in mode.",
    );
  }

  const [ownedPack] = await database
    .select({ id: kitchenPacks.id })
    .from(kitchenPacks)
    .where(
      and(
        eq(kitchenPacks.kitchenId, ownerKitchenId),
        eq(kitchenPacks.packId, packId),
      ),
    )
    .limit(1);

  if (!ownedPack) {
    throw new PackCircleShareError("NOT_FOUND", "Owned pack not found.");
  }

  const [ownerMembership] = await database
    .select({
      circleId: circles.id,
      circleName: circles.name,
    })
    .from(circleMembers)
    .innerJoin(circles, eq(circleMembers.circleId, circles.id))
    .where(eq(circleMembers.kitchenId, ownerKitchenId))
    .limit(1);

  const shareRows = await database
    .select({
      kitchenId: kitchens.id,
      slug: kitchens.slug,
      name: kitchens.name,
    })
    .from(kitchenPackShares)
    .innerJoin(kitchens, eq(kitchenPackShares.sharedWithKitchenId, kitchens.id))
    .where(
      and(
        eq(kitchenPackShares.kitchenPackId, ownedPack.id),
        ne(kitchens.id, ownerKitchenId),
      ),
    )
    .orderBy(asc(kitchens.name), asc(kitchens.slug));

  const sharedIds = new Set(shareRows.map((s) => s.kitchenId));

  const peerKitchens = ownerMembership
    ? await database
        .select({
          kitchenId: kitchens.id,
          slug: kitchens.slug,
          name: kitchens.name,
        })
        .from(circleMembers)
        .innerJoin(kitchens, eq(circleMembers.kitchenId, kitchens.id))
        .where(
          and(
            eq(circleMembers.circleId, ownerMembership.circleId),
            ne(circleMembers.kitchenId, ownerKitchenId),
          ),
        )
        .orderBy(asc(kitchens.name), asc(kitchens.slug))
    : [];

  const byKitchen = new Map<string, CirclePackShareTarget>();
  for (const k of peerKitchens) {
    byKitchen.set(k.kitchenId, {
      kitchenId: k.kitchenId,
      slug: k.slug,
      name: k.name,
      shared: sharedIds.has(k.kitchenId),
    });
  }
  for (const s of shareRows) {
    if (!byKitchen.has(s.kitchenId)) {
      byKitchen.set(s.kitchenId, {
        kitchenId: s.kitchenId,
        slug: s.slug,
        name: s.name,
        shared: true,
      });
    }
  }

  const combined = [...byKitchen.values()].sort(
    (a, b) => a.name.localeCompare(b.name) || a.slug.localeCompare(b.slug),
  );

  return {
    circleName: ownerMembership?.circleName ?? null,
    kitchens: combined,
  };
}

/**
 * Switches pack sharing on or off for a kitchen in the owning kitchen's
 * circle, and also lets an owner revoke sharing after a kitchen leaves.
 */
export async function setPackCircleShareForOwner(
  ownerKitchenId: string,
  ownerKitchenSlug: string,
  input: {
    packId: string;
    targetKitchenId: string;
    shared: boolean;
  },
  database: CircleDishesDb = db,
  env: Record<string, string | undefined> = process.env,
): Promise<{ packId: string; targetKitchenId: string; shared: boolean }> {
  if (getDeploymentMode(env) !== "sign-in") {
    throw new PackCircleShareError(
      "FORBIDDEN",
      "Pack sharing is only available in sign-in mode.",
    );
  }

  if (input.targetKitchenId === ownerKitchenId) {
    throw new PackCircleShareError(
      "BAD_REQUEST",
      "Cannot share a pack with its own kitchen.",
    );
  }

  const [ownedPack] = await database
    .select({ id: kitchenPacks.id, packId: kitchenPacks.packId })
    .from(kitchenPacks)
    .where(
      and(
        eq(kitchenPacks.kitchenId, ownerKitchenId),
        eq(kitchenPacks.packId, input.packId),
      ),
    )
    .limit(1);

  if (!ownedPack) {
    throw new PackCircleShareError("NOT_FOUND", "Owned pack not found.");
  }

  if (input.shared) {
    const [ownerMembership] = await database
      .select({ circleId: circleMembers.circleId })
      .from(circleMembers)
      .where(eq(circleMembers.kitchenId, ownerKitchenId))
      .limit(1);

    if (!ownerMembership) {
      throw new PackCircleShareError(
        "NOT_FOUND",
        "Your kitchen is not in a circle.",
      );
    }

    const [targetMembership] = await database
      .select({
        circleId: circleMembers.circleId,
        slug: kitchens.slug,
      })
      .from(circleMembers)
      .innerJoin(kitchens, eq(circleMembers.kitchenId, kitchens.id))
      .where(eq(circleMembers.kitchenId, input.targetKitchenId))
      .limit(1);

    if (!targetMembership || targetMembership.circleId !== ownerMembership.circleId) {
      throw new PackCircleShareError(
        "NOT_FOUND",
        "Target kitchen is not in your circle.",
      );
    }

    await shareKitchenPack(
      {
        pack: ownedPack.id,
        kitchenSlug: ownerKitchenSlug,
        withKitchenSlug: targetMembership.slug,
      },
      database,
      env,
    );
  } else {
    const [targetKitchen] = await database
      .select({ slug: kitchens.slug })
      .from(kitchens)
      .where(eq(kitchens.id, input.targetKitchenId))
      .limit(1);

    if (!targetKitchen) {
      throw new PackCircleShareError(
        "NOT_FOUND",
        "Target kitchen not found.",
      );
    }

    await unshareKitchenPack(
      {
        pack: ownedPack.id,
        kitchenSlug: ownerKitchenSlug,
        withKitchenSlug: targetKitchen.slug,
      },
      database,
      env,
    );
  }

  return {
    packId: ownedPack.packId,
    targetKitchenId: input.targetKitchenId,
    shared: input.shared,
  };
}
