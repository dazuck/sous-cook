/**
 * Kitchen Queue Module (F2)
 *
 * Manages the kitchen queue for cross-device recipe sending.
 * Recipes can be sent from chat on one device and picked up
 * on the tablet in the kitchen.
 */

import { randomUUID } from "node:crypto";
import { eq, and, desc, inArray, isNotNull, isNull, ne, or, sql, type SQL } from "drizzle-orm";
import type { AnyPgColumn } from "drizzle-orm/pg-core";
import { conversationLogs, db, kitchenQueue } from "./db";
import type {
  KitchenQueueStatus,
  KitchenQueueRecipeData,
} from "../../drizzle/schema";
import {
  COOK_PLAN_VERSION,
  isCurrentCookPlan,
  type CookPlan,
} from "./kitchen/cook-plan";
import {
  CookPlanCapReached,
  CookPlanDerivationError,
  deriveCookPlanOutcome,
  type CookPlanRejection,
  type DerivedCookPlan,
} from "./kitchen/cook-plan-derive";
import { isAllowanceUsed, kitchenMeter } from "./ai";
import { isSettledPlanError, type PlanCopy } from "./kitchen/cook-plan-stamp";
import { callCostUsd, formatUsd } from "./cook-plan-cost";
import { storedEstimate } from "./pack-convert/convert";
import {
  intakeStamp,
  runIntake,
  type IntakeOutcome,
  type IntakeRejection,
} from "./pack-convert/intake";
import {
  INTAKE_FOR_NOW,
  INTAKE_MAX_TRIES,
  INTAKE_STATE_ERRORS,
  intakeErrorAfter,
  isSettledIntakeError,
  openedBeforeCut,
  queueIntake,
  type QueueIntake,
} from "./pack-convert/intake-state";
import { sourceHash } from "./serves-estimate-plan";
import { ACTIVITY_SLACK_MS, REOPEN_WINDOW_MS } from "./kitchen/auto-finish";

// =============================================================================
// Types
// =============================================================================

/**
 * Queue status (re-exported for convenience)
 */
export type QueueStatus = KitchenQueueStatus;

/**
 * Input for adding a recipe to the kitchen queue.
 * Either recipeNotionId OR recipeData must be provided.
 */
export interface KitchenQueueInput {
  /** Notion page ID for an existing recipe */
  recipeNotionId?: string;
  /** Full recipe data for imported/pasted recipes */
  recipeData?: KitchenQueueRecipeData;
  /**
   * Sous's estimate of the serving count when the recipe states none (slice
   * B4b), stored beside the recipe in its own columns, never in it.
   */
  servesEstimate?: { count: number; basis: string };
  /**
   * A plan or settled error worked out ahead of time (slice P), already
   * checked against this recipe by `storedPlanToCopy`. Written in the insert;
   * the row is a snapshot, so a later change to its source never reaches it.
   */
  plan?: PlanCopy;
  /**
   * Ask for the intake pass (cook-fidelity plan): the webhook's agent
   * recipes only. Records which recipe it is for; `ensureIntake` runs it.
   */
  intake?: boolean;
}

/**
 * A queue item from the database
 */
export type KitchenQueueItemDB = typeof kitchenQueue.$inferSelect;

/**
 * A queue item after tRPC serialization (dates become strings)
 */
export type KitchenQueueItem = Omit<
  KitchenQueueItemDB,
  | "createdAt"
  | "startedAt"
  | "completedAt"
  | "ratingClosedAt"
  | "cookLogClaimedAt"
  | "lastScreenActiveAt"
> & {
  createdAt: Date | string;
  startedAt: Date | string | null;
  completedAt: Date | string | null;
  ratingClosedAt: Date | string | null;
  cookLogClaimedAt: Date | string | null;
  lastScreenActiveAt: Date | string | null;
};

// =============================================================================
// Type Guards
// =============================================================================

const VALID_QUEUE_STATUSES: QueueStatus[] = [
  "pending",
  "cooking",
  "completed",
  "cancelled",
];

/**
 * Validates that a string is a valid QueueStatus
 */
export function isValidQueueStatus(status: string): status is QueueStatus {
  return VALID_QUEUE_STATUSES.includes(status as QueueStatus);
}

// =============================================================================
// Queue Operations
// =============================================================================

/**
 * Adds a recipe to a kitchen's queue.
 *
 * @param kitchenId - The owning kitchen ID
 * @param input - Queue input with either recipeNotionId or recipeData
 * @returns The created queue item ID
 * @throws Error if input validation fails
 */
export async function addToKitchenQueue(
  kitchenId: string,
  input: KitchenQueueInput,
): Promise<{ id: string }> {
  // Validate that at least one of recipeNotionId or recipeData is provided
  if (!input.recipeNotionId && !input.recipeData) {
    throw new Error("Either recipeNotionId or recipeData must be provided");
  }

  const [inserted] = await db
    .insert(kitchenQueue)
    .values({
      kitchenId,
      recipeNotionId: input.recipeNotionId ?? null,
      recipeData: input.recipeData ?? null,
      status: "pending" as const,
      servesEstimate: input.servesEstimate?.count ?? null,
      servesEstimateBasis: input.servesEstimate?.basis ?? null,
      // The stored recipe the estimate goes with, hashed as the estimates
      // file hashes a queue row (serves-estimate-plan.ts).
      servesEstimateSourceHash:
        input.servesEstimate && input.recipeData
          ? sourceHash("kitchen_queue", input.recipeData)
          : null,
      cookPlan: input.plan?.cookPlan ?? null,
      cookPlanError: input.plan?.cookPlanError ?? null,
      intakeSourceHash:
        input.intake && input.recipeData
          ? sourceHash("kitchen_queue", input.recipeData)
          : null,
    })
    .returning({ id: kitchenQueue.id });

  return { id: inserted!.id };
}

/**
 * Gets recipes in a kitchen's queue for the given status.
 *
 * @param kitchenId - The owning kitchen ID
 * @param status - Optional status filter (default: "pending")
 * @returns Array of queue items, newest first
 */
export async function getKitchenQueue(
  kitchenId: string,
  status: QueueStatus = "pending",
): Promise<KitchenQueueItem[]> {
  return db.query.kitchenQueue.findMany({
    where: and(
      eq(kitchenQueue.kitchenId, kitchenId),
      eq(kitchenQueue.status, status),
    ),
    orderBy: [desc(kitchenQueue.createdAt)],
  });
}

/**
 * Gets a single queue item owned by the given kitchen.
 *
 * @param kitchenId - The owning kitchen ID
 * @param queueId - The queue item ID
 * @returns The queue item or null if not found in this kitchen
 */
export async function getQueueItemForKitchen(
  kitchenId: string,
  queueId: string,
): Promise<KitchenQueueItem | null> {
  const item = await db.query.kitchenQueue.findFirst({
    where: and(
      eq(kitchenQueue.kitchenId, kitchenId),
      eq(kitchenQueue.id, queueId),
    ),
  });

  return item ?? null;
}

/** Alias for `getQueueItemForKitchen`; every read is scoped to a kitchen. */
export const getQueueItem = getQueueItemForKitchen;

/**
 * How a finish came about: the cook's press, the open page's own finish of a
 * cook idle on its last screen (its last activity `at`, by the page), or the
 * server's of a cook whose last-screen activity is at or before `idleBefore`.
 */
export type QueueFinish =
  | { by: "pressed" }
  | { by: "auto"; at: Date; interactedAt: Date }
  | { by: "auto"; idleBefore: Date };

/**
 * Updates the status of a queue item, stamping the cook's real transitions.
 *
 * Into "cooking" from any other status sets `started_at`; a resume (already
 * cooking) changes nothing. Into "completed" from any other status sets
 * `completed_at` and clears the previous cook's Cook Log fields; a second
 * Done (a double tap, another device) matches no row and changes nothing.
 * A start belongs to the cook it began, so a finish that doesn't come straight
 * from "cooking" (Mark as done from the queue, after the item was finished
 * and put back, or a cook put back or cancelled) clears `started_at`: the
 * measurement reads it as no-start, never as an old cook's start
 * (T follow-up, item 5).
 * Both are conditional UPDATEs, so of two concurrent calls only the first
 * transitions; the database clock stamps both.
 *
 * How the cook finished is kept as `finished_by` (cook-fidelity decision 7):
 * "pressed" unless `finish` says "auto", the app finishing a cook left on its
 * last screen (`kitchen-auto-finish.ts`). An auto-finish takes only a cook
 * that is cooking and holds last-screen activity, read off the row as the
 * UPDATE runs, never as an earlier read found it:
 *   - `at`, the open page's finish: dated to the activity the page names, and
 *     refused over activity reported after it, past the slack between two
 *     readings of one activity, and over a touch newer than `interactedAt`
 *     (the page's last, by its own clock) from any page;
 *   - `idleBefore`, the server's (a sweep, a cook's next start): only a row
 *     whose activity is at or before it, dated to that activity.
 * Either is never dated before the cook's start or after now.
 *
 * A cook reopened after an auto-finish (still cooking, `finished_by` "auto",
 * `completed_at` the first finish's) keeps its Cook Log row, its closed ask
 * and a write's live claim when it finishes again within `REOPEN_WINDOW_MS`
 * of that first finish, so the row moves to the new time rather than a
 * second one logged. Later, it is a new cook: no row, its ask open. A fresh
 * start clears all three auto-finish columns.
 *
 * @param queueId - The queue item ID
 * @param status - The new status
 * @param finish - Into "completed" only: how, and for "auto", by whose reading
 * @returns `completed: true` only when this call moved the item into
 *   "completed": the caller's cue to log the cook; `started: true` only when
 *   it moved the item into "cooking": a cook's start, the cue to finish any
 *   cook left on its last screen
 * @throws Error if status is invalid
 */
export async function updateQueueStatus(
  kitchenId: string,
  queueId: string,
  status: QueueStatus,
  finish: QueueFinish = { by: "pressed" },
): Promise<{ completed: boolean; started: boolean }> {
  if (!isValidQueueStatus(status)) {
    throw new Error(`Invalid queue status: ${status}`);
  }

  if (status === "cooking") {
    const moved = await db
      .update(kitchenQueue)
      .set({ status, startedAt: sql`now()`, finishedBy: null, lastScreenActiveAt: null, lastInteractionAt: null })
      .where(
        and(
          eq(kitchenQueue.kitchenId, kitchenId),
          eq(kitchenQueue.id, queueId),
          ne(kitchenQueue.status, status),
        ),
      )
      .returning({ id: kitchenQueue.id });
    return { completed: false, started: moved.length > 0 };
  }

  if (status === "completed") {
    const active = kitchenQueue.lastScreenActiveAt;
    // When this finish dates the cook, before the start's floor and now's cap.
    const when =
      finish.by === "pressed"
        ? sql`now()`
        : "at" in finish
          ? sql`${finish.at.toISOString()}::timestamptz`
          : sql`${active}`;
    const completedAt = sql`least(greatest(${when}, coalesce(${kitchenQueue.startedAt}, ${when})), now())`;
    // Read off the row as it was: a cook reopened after an auto-finish,
    // finished again within the window of its first finish.
    const carried = sql`(${kitchenQueue.status} = 'cooking' and ${kitchenQueue.finishedBy} = 'auto' and ${kitchenQueue.completedAt} is not null and ${completedAt} <= ${kitchenQueue.completedAt} + ${`${REOPEN_WINDOW_MS} milliseconds`}::interval)`;
    const moved = await db
      .update(kitchenQueue)
      .set({
        status,
        completedAt,
        finishedBy: finish.by,
        // The row as it was: only a cook's own finish keeps its start.
        startedAt: sql`case when ${kitchenQueue.status} = 'cooking' then ${kitchenQueue.startedAt} end`,
        cookLog: sql`case when ${carried} then ${kitchenQueue.cookLog} end`,
        cookLogError: null,
        // A write still under way for the first finish holds on: it moves
        // its row to this finish once it lands (`logCook`).
        cookLogClaimedAt: sql`case when ${carried} then ${kitchenQueue.cookLogClaimedAt} end`,
        ratingClosedAt: sql`case when ${carried} then ${kitchenQueue.ratingClosedAt} end`,
      })
      .where(
        finish.by === "pressed"
          ? and(
              eq(kitchenQueue.kitchenId, kitchenId),
              eq(kitchenQueue.id, queueId),
              ne(kitchenQueue.status, status),
            )
          : and(
              eq(kitchenQueue.kitchenId, kitchenId),
              eq(kitchenQueue.id, queueId),
              eq(kitchenQueue.status, "cooking"),
              // Off the last screen (another page stepped back): never.
              sql`${active} is not null`,
              ...("at" in finish
                ? [
                    // Activity reported since loses the page's finish, past the
                    // slack between two readings of the same activity.
                    sql`${active} <= ${new Date(finish.at.getTime() + ACTIVITY_SLACK_MS).toISOString()}::timestamptz`,
                    // And so does a newer touch, on this page or another.
                    sql`(${kitchenQueue.lastInteractionAt} is null or ${kitchenQueue.lastInteractionAt} <= ${finish.interactedAt.toISOString()}::timestamptz)`,
                  ]
                : [sql`${active} <= ${finish.idleBefore.toISOString()}::timestamptz`]),
            ),
      )
      .returning({ id: kitchenQueue.id });
    return { completed: moved.length > 0, started: false };
  }

  await db
    .update(kitchenQueue)
    .set({ status })
    .where(and(eq(kitchenQueue.kitchenId, kitchenId), eq(kitchenQueue.id, queueId)));
  return { completed: false, started: false };
}

/**
 * Removes an item from a kitchen's queue.
 *
 * @param kitchenId - The owning kitchen ID
 * @param queueId - The queue item ID to remove
 */
export async function removeFromQueue(
  kitchenId: string,
  queueId: string,
): Promise<void> {
  await db
    .delete(kitchenQueue)
    .where(and(eq(kitchenQueue.kitchenId, kitchenId), eq(kitchenQueue.id, queueId)));
}

/**
 * Gets the most recent items with "cooking" status for a kitchen.
 * Useful for showing recently active cooking sessions that can be resumed.
 *
 * @param kitchenId - The owning kitchen ID
 * @param limit - Maximum number of items to return (default: 3)
 * @returns Array of cooking queue items, newest first
 */
export async function getRecentCookingItems(
  kitchenId: string,
  limit: number = 3,
): Promise<KitchenQueueItem[]> {
  return db.query.kitchenQueue.findMany({
    where: and(
      eq(kitchenQueue.kitchenId, kitchenId),
      eq(kitchenQueue.status, "cooking"),
    ),
    orderBy: [desc(kitchenQueue.createdAt)],
    limit,
  });
}

// =============================================================================
// Cook Plans
// =============================================================================

/** What a derivation left on the queue item: a plan, or why there isn't one. */
export type CookPlanOutcome =
  | { plan: CookPlan; error: null }
  | { plan: null; error: string };

/**
 * Rows a plan of `version` may be written to: no plan yet, or one from an
 * older version. Evaluated inside the UPDATE, so of two concurrent writers
 * only the first matches; Postgres re-checks the condition on the row the
 * first one committed.
 */
function acceptsPlan(version: number) {
  return or(
    isNull(kitchenQueue.cookPlan),
    sql`coalesce((${kitchenQueue.cookPlan} ->> 'version')::int, 0) < ${version}`,
  );
}

/**
 * Rows whose cook still meets the recipe a derive read: the cut when it read
 * one, else the recipe as sent. An intake cut is written once and never
 * changes, so whether there is one is enough. A cut that landed mid-derive
 * fails this, and the plan (worked out from the recipe as sent) isn't kept.
 */
function readsSameRecipe(intakeRecipe: KitchenQueueRecipeData | null) {
  return intakeRecipe === null ? isNull(kitchenQueue.intakeRecipe) : isNotNull(kitchenQueue.intakeRecipe);
}

/**
 * Returns true if `err` or any error in its `cause` chain carries a
 * PostgreSQL integrity constraint violation SQLSTATE (class 23: not-null,
 * foreign-key, unique, or check violation).
 */
function isIntegrityError(err: unknown): boolean {
  const seen = new Set<unknown>();
  let cur: unknown = err;
  while (cur !== null && cur !== undefined && typeof cur === "object" && !seen.has(cur)) {
    seen.add(cur);
    const code = (cur as { code?: unknown }).code;
    if (typeof code === "string" && code.startsWith("23")) {
      return true;
    }
    cur = (cur as { cause?: unknown }).cause;
  }
  return false;
}

async function storeCookPlan(
  kitchenId: string,
  queueId: string,
  plan: CookPlan,
  readFrom: KitchenQueueRecipeData | null,
): Promise<boolean> {
  const written = await db
    .update(kitchenQueue)
    .set({ cookPlan: plan, cookPlanError: null })
    .where(
      and(
        eq(kitchenQueue.kitchenId, kitchenId),
        eq(kitchenQueue.id, queueId),
        acceptsPlan(plan.version),
        readsSameRecipe(readFrom),
      ),
    )
    .returning({ id: kitchenQueue.id });
  return written.length > 0;
}

async function storeCookPlanError(
  kitchenId: string,
  queueId: string,
  error: string,
  readFrom: KitchenQueueRecipeData | null,
): Promise<boolean> {
  const written = await db
    .update(kitchenQueue)
    .set({ cookPlanError: error })
    .where(
      and(
        eq(kitchenQueue.kitchenId, kitchenId),
        eq(kitchenQueue.id, queueId),
        acceptsPlan(COOK_PLAN_VERSION),
        readsSameRecipe(readFrom),
      ),
    )
    .returning({ id: kitchenQueue.id });
  return written.length > 0;
}

async function getQueueItemOrThrow(
  kitchenId: string,
  queueId: string,
): Promise<KitchenQueueItem> {
  const item = await getQueueItem(kitchenId, queueId);
  if (!item) throw new Error(`Kitchen queue item not found: ${queueId}`);
  return item;
}

/**
 * What `deriveAndStoreCookPlan` returns for this item with no model call: its
 * current plan, or its stored settled error (`isSettledPlanError`). Null when
 * it would derive (no plan, a plan from an older version, a transient error).
 * The one rule for "this item still needs a derive", shared with
 * `scripts/backfill-cook-plans.ts`, whose check-only listing is exactly the
 * items its `--apply` would derive.
 */
export function cookPlanWithoutDerive(
  item: Pick<KitchenQueueItem, "cookPlan" | "cookPlanError">,
): CookPlanOutcome | null {
  if (isCurrentCookPlan(item.cookPlan)) {
    return { plan: item.cookPlan, error: null };
  }
  if (item.cookPlanError !== null && isSettledPlanError(item.cookPlanError)) {
    return { plan: null, error: item.cookPlanError };
  }
  return null;
}

/** The open queue items, split by whether a derive would run for them. */
export interface CookPlanBackfillSelection {
  /** Pending and cooking items. */
  open: KitchenQueueItem[];
  /** Those a derive would run for (`cookPlanWithoutDerive` is null). */
  todo: KitchenQueueItem[];
  /** Those without a current plan whose stored error is settled: never derived again. */
  settled: KitchenQueueItem[];
}

/**
 * What `scripts/backfill-cook-plans.ts` acts on: its check-only listing and
 * its `--apply` both read this, so the listing is exactly what `--apply`
 * would derive, and an empty `todo` means `--apply` would write nothing.
 */
export async function selectCookPlanBackfill(
  kitchenId: string,
): Promise<CookPlanBackfillSelection> {
  const open = await db.query.kitchenQueue.findMany({
    where: and(
      eq(kitchenQueue.kitchenId, kitchenId),
      inArray(kitchenQueue.status, ["pending", "cooking"]),
    ),
    orderBy: [kitchenQueue.createdAt],
  });
  return {
    open,
    todo: open.filter((item) => cookPlanWithoutDerive(item) === null),
    settled: open.filter(
      (item) => !isCurrentCookPlan(item.cookPlan) && cookPlanWithoutDerive(item) !== null,
    ),
  };
}

/**
 * Derives the item's cook plan and stores it, unless a current plan is
 * already stored. Safe to run concurrently for one item (queue-time `after()`
 * against ensure-on-open, or two devices): the first plan written wins, and
 * every caller gets that plan back. A failed derivation stores its reason,
 * never over a plan. Each call is one attempt; the caller decides when to
 * retry. A stored settled error (`isSettledPlanError`: the validator refused,
 * the model declined, the reply never fit) is returned with no model call,
 * since another attempt at the same text would fail the same way (slice P
 * decision 8); a transient one is retried.
 *
 * Only the derivation's failures become the stored error. A failure to store
 * throws: recording "the database refused the write" as the plan's error
 * would describe the storage, not the recipe.
 *
 * It plans the recipe the cook meets (`queueIntake`) and never runs intake
 * itself (`prepareQueueItemInBackground` runs both at queue time, in order).
 * A row still waiting for intake is planned as sent, which settles it as sent
 * (an old tablet asking before it asked for intake). An intake cut landing
 * mid-derive keeps the plan of the recipe as sent out: the derive runs once
 * more, on the cut.
 *
 * @throws Error if the item does not exist, was removed mid-derivation, or
 *   the plan or its error could not be stored
 */
export async function deriveAndStoreCookPlan(
  kitchenId: string,
  queueId: string,
  memberId: string | null = null,
): Promise<CookPlanOutcome> {
  return deriveAndStore(kitchenId, queueId, false, memberId);
}

async function deriveAndStore(
  kitchenId: string,
  queueId: string,
  again: boolean,
  memberId: string | null,
): Promise<CookPlanOutcome> {
  const item = await getQueueItemOrThrow(kitchenId, queueId);
  const settled = cookPlanWithoutDerive(item);
  if (settled) return settled;

  const sessionId = `cook-plan:${queueId}`;
  const derivation = randomUUID();
  let derived: DerivedCookPlan;
  try {
    derived = await deriveCookPlanOutcome(queueIntake(item).recipe ?? {}, {
      meter: kitchenMeter(kitchenId, memberId, "cook-plan"),
    });
  } catch (err) {
    if (
      (err instanceof CookPlanCapReached ||
        err instanceof CookPlanDerivationError) &&
      err.rejections.length > 0
    ) {
      await logCookPlanRejections(kitchenId, sessionId, derivation, err.rejections);
    }
    throw err;
  }
  await logCookPlanRejections(kitchenId, sessionId, derivation, derived.rejections);
  /** The cut landed since the read: this derive planned a recipe the cook no longer meets. */
  const cutSince = (winner: KitchenQueueItem) =>
    !again && item.intakeRecipe === null && winner.intakeRecipe !== null;

  if (derived.plan !== null) {
    if (await storeCookPlan(kitchenId, queueId, derived.plan, item.intakeRecipe)) {
      return { plan: derived.plan, error: null };
    }
    const winner = await getQueueItemOrThrow(kitchenId, queueId);
    if (isCurrentCookPlan(winner.cookPlan)) return { plan: winner.cookPlan, error: null };
    if (cutSince(winner)) return deriveAndStore(kitchenId, queueId, true, memberId);
    // A plan from a newer version is left alone but can't be read here.
    return { plan: derived.plan, error: null };
  }

  const { error } = derived;
  if (!(await storeCookPlanError(kitchenId, queueId, error, item.intakeRecipe))) {
    const winner = await getQueueItemOrThrow(kitchenId, queueId);
    if (isCurrentCookPlan(winner.cookPlan)) {
      return { plan: winner.cookPlan, error: null };
    }
    if (cutSince(winner)) return deriveAndStore(kitchenId, queueId, true, memberId);
  }
  return { plan: null, error };
}

/**
 * Keeps each reply validation rejected in `conversation_logs`, under
 * `sessionId` (`cook-plan:<queueId>` for a queue row, `cook-plan:doc:<slug>`
 * for a library row), so a bad plan can be read back after the fact (the
 * stored error keeps only the rule). The context names the derivation (two
 * can run at once for one item) and the model call the reply came from. A
 * passing database failure is logged and ignored so the record does not
 * change the plan's outcome, while integrity constraint violations (SQLSTATE
 * class 23) are rethrown because they signal a bug such as a missing kitchen.
 */
export async function logCookPlanRejections(
  kitchenId: string,
  sessionId: string,
  derivation: string,
  rejections: readonly CookPlanRejection[],
): Promise<void> {
  if (rejections.length === 0) return;
  try {
    await db.insert(conversationLogs).values(
      rejections.map(({ call, raw, rule, detail }) => ({
        kitchenId,
        sessionId,
        role: "assistant",
        content: typeof raw === "string" ? raw : JSON.stringify(raw),
        context: { derivation, call, rule, detail },
      })),
    );
  } catch (err) {
    if (isIntegrityError(err)) throw err;
    console.error(`Could not log a rejected cook plan for ${sessionId}:`, err);
  }
}

// =============================================================================
// Intake
// =============================================================================

/**
 * Who asks for a row's intake, which decides what a failure for now does
 * once a cook may be on the row (cook-fidelity plan; round-3 review, B1):
 *
 * - `background`: the queue-time run and the backfill. Runs only while the
 *   row is still queued (status `pending`): once a cook has opened it, the
 *   cook page asks for itself. An error for now leaves it pending, up to
 *   `INTAKE_MAX_TRIES` runs.
 * - `opening`: the cook page, opening an item still waiting, with no session
 *   kept for it. The cook waits for the answer and starts on whatever it
 *   says, so an error for now is settled as sent (`openedBeforeCut`): the
 *   cook started on that recipe, and nothing tries again under it.
 * - `started`: the cook page, with a session kept for the item (the cook is
 *   under way on the recipe as sent). No model call: the row is settled as
 *   sent (`INTAKE_STATE_ERRORS.cookStarted`).
 */
export type IntakeAsk = "background" | "opening" | "started";

/**
 * Runs the intake pass for a row that asked for it and has no outcome yet,
 * or only an error for now (`queueIntake` state `pending`), and stores the
 * outcome: the cut, or why there isn't one. Any other row comes back as it
 * is, with no model call; so does a `background` ask on a row a cook has
 * opened (`IntakeAsk`). A cut or a settled error is final (one paid call or
 * two per run; a recipe shown as sent still cooks); an error for now leaves
 * the row pending for another try, at most `INTAKE_MAX_TRIES` runs in all,
 * the last settled (`intakeErrorAfter`; standing agent call, DECISIONS
 * 2026-10-26).
 *
 * The writes, each on a row with no plan or plan error (a plan worked out
 * from the recipe as sent keeps its recipe; the row then reads as sent):
 *
 * - A cut lands on a row with no cut and no settled error: over an error for
 *   now another run wrote meanwhile, too, so a slow good cut is never thrown
 *   away for a fast failure.
 * - An error for now lands only on a row with no cut, no settled error, and
 *   the run count this run read: an error never lands over a cut, and of two
 *   errors for now at once the first is kept and counted once.
 * - A settled error (the recipe shown as sent, for good) lands over an error
 *   for now another run wrote meanwhile, too: once the cook page has settled
 *   a row as sent, a background run's transient failure must not leave it
 *   pending for a later open to re-cut (round-4 review, H2).
 *
 * Each write counts the run (`intake_attempts`); a kept cut stores its
 * nudges, the soft rules it still trips (`intake_nudges`), for the reports
 * and the eval to count. Rejected cuts go to `conversation_logs` under
 * `intake:<id>`; each run logs its cost and its nudges.
 *
 * @throws Error if the item does not exist, or the outcome could not be stored
 */
export async function ensureIntake(
  kitchenId: string,
  queueId: string,
  ask: IntakeAsk = "background",
  memberId: string | null = null,
): Promise<QueueIntake> {
  return (await ensureIntakeForCook(kitchenId, queueId, ask, memberId)).intake;
}

/**
 * `ensureIntake`, answering with the row as well: the row as its outcome's
 * write left it, or, when there is nothing to run, the row as read. Each
 * outcome is one statement that writes only where its guard holds and
 * returns the row either way (`update … set col = case when <guard> then
 * <new> else col end where kitchen_id = … and id = … returning`), so no read
 * ever follows a write: a run that loses to another run's outcome answers
 * with that outcome, and a failed statement wrote nothing. The guard sits in
 * the SET clause rather than the WHERE clause so that, under read committed,
 * a row another run changed meanwhile is re-checked and returned as it now
 * stands; a CTE's separate SELECT of the row would read the statement's older
 * snapshot. The cook page's ask answers with this row.
 *
 * @throws as `ensureIntake`
 */
export async function ensureIntakeForCook(
  kitchenId: string,
  queueId: string,
  ask: IntakeAsk,
  memberId: string | null = null,
): Promise<{
  intake: QueueIntake;
  item: KitchenQueueItem;
  skippedForAllowance?: true;
}> {
  const item = await getQueueItemOrThrow(kitchenId, queueId);
  const before = queueIntake(item);
  if (before.state !== "pending" || item.recipeData === null) return { intake: before, item };
  if (ask === "background" && item.status !== "pending") return { intake: before, item };

  const open = and(
    isNotNull(kitchenQueue.intakeSourceHash),
    isNull(kitchenQueue.intakeRecipe),
    or(isNull(kitchenQueue.intakeError), sql`${kitchenQueue.intakeError} like ${`${INTAKE_FOR_NOW}%`}`),
    isNull(kitchenQueue.cookPlan),
    isNull(kitchenQueue.cookPlanError),
  );
  const attempts = (item.intakeAttempts ?? 0) + 1;
  const sameRuns =
    item.intakeAttempts === null
      ? isNull(kitchenQueue.intakeAttempts)
      : eq(kitchenQueue.intakeAttempts, item.intakeAttempts);
  // One statement per outcome: its guard picks, column by column, the new
  // value or the stored one, and the row comes back either way.
  const when = (guard: SQL | undefined) => (value: SQL, column: AnyPgColumn) =>
    sql`case when ${guard} then ${value} else ${column} end`;
  const asNow = ([now]: KitchenQueueItem[]) => {
    if (!now) throw new Error(`Kitchen queue item not found: ${queueId}`);
    return { intake: queueIntake(now), item: now };
  };
  const settle = async (error: string) => {
    const settled = isSettledIntakeError(error);
    const write = when(settled ? open : and(open, sameRuns));
    return asNow(
      await db
        .update(kitchenQueue)
        .set({
          intakeError: write(sql`${error}::text`, kitchenQueue.intakeError),
          intakeStamp: write(sql`${intakeStamp()}::text`, kitchenQueue.intakeStamp),
          intakeAttempts: write(
            settled ? sql`coalesce(${kitchenQueue.intakeAttempts}, 0) + 1` : sql`${attempts}::integer`,
            kitchenQueue.intakeAttempts,
          ),
        })
        .where(and(eq(kitchenQueue.kitchenId, kitchenId), eq(kitchenQueue.id, queueId)))
        .returning(),
    );
  };

  if (ask === "started") {
    console.info(`[intake] ${queueId}: shown as sent (${INTAKE_STATE_ERRORS.cookStarted})`);
    return settle(INTAKE_STATE_ERRORS.cookStarted);
  }

  const usage = { calls: 0, input: 0, output: 0 };
  let outcome: IntakeOutcome;
  try {
    outcome = await runIntake(item.recipeData, {
      meter: kitchenMeter(kitchenId, memberId, "intake"),
      servesEstimate: storedEstimate(item),
      onUsage: (u) => {
        if (u.sent === false) return;
        // A call that reported nothing (or threw) is counted at its bound.
        const reported = u.inputTokens > 0 || u.outputTokens > 0;
        usage.calls++;
        usage.input += reported ? u.inputTokens : u.bound.inputTokens;
        usage.output += reported ? u.outputTokens : u.bound.outputTokens;
      },
    });
  } catch (err) {
    if (isAllowanceUsed(err)) {
      if (ask === "background") {
        console.warn(`[ai-cap] intake not run for ${queueId}`);
        return { intake: before, item, skippedForAllowance: true };
      }
      throw err;
    }
    throw err;
  }
  const nudges = outcome.error === null ? outcome.nudges.map((n) => `${n.rule}: ${n.detail}`) : [];
  const error =
    outcome.error === null
      ? null
      : ask === "opening" && !isSettledIntakeError(outcome.error)
        ? openedBeforeCut(outcome.error)
        : intakeErrorAfter(outcome.error, attempts);
  const said =
    error === null
      ? `cut${nudges.length > 0 ? ` (kept with ${nudges.join("; ")})` : ""}`
      : isSettledIntakeError(error)
        ? `shown as sent (${error})`
        : `not cut yet, tries again (${error}; ${attempts} of ${INTAKE_MAX_TRIES} tries)`;
  console.info(
    `[intake] ${queueId}: ${said}; ` +
      `${usage.calls} call(s), ${usage.input} input + ${usage.output} output tokens, ` +
      `${formatUsd(callCostUsd(usage.input, usage.output))}`,
  );
  await logIntakeRejections(kitchenId, queueId, outcome.rejections);

  if (error !== null) return settle(error);
  const write = when(open);
  return asNow(
    await db
      .update(kitchenQueue)
      .set({
        intakeRecipe: write(sql`${JSON.stringify(outcome.recipe)}::jsonb`, kitchenQueue.intakeRecipe),
        intakeError: write(sql`null::text`, kitchenQueue.intakeError),
        intakeStamp: write(sql`${intakeStamp()}::text`, kitchenQueue.intakeStamp),
        intakeNudges: write(sql`${JSON.stringify(nudges)}::jsonb`, kitchenQueue.intakeNudges),
        intakeAttempts: write(sql`coalesce(${kitchenQueue.intakeAttempts}, 0) + 1`, kitchenQueue.intakeAttempts),
      })
      .where(and(eq(kitchenQueue.kitchenId, kitchenId), eq(kitchenQueue.id, queueId)))
      .returning(),
  );
}

/**
 * Keeps each cut intake's check turned down in `conversation_logs`, under
 * `intake:<queueId>`, so a failed intake can be read back (the stored error
 * keeps only one rule). A passing database failure is logged and ignored,
 * while integrity constraint violations (SQLSTATE class 23) are rethrown.
 */
async function logIntakeRejections(
  kitchenId: string,
  queueId: string,
  rejections: readonly IntakeRejection[],
): Promise<void> {
  if (rejections.length === 0) return;
  const run = randomUUID();
  try {
    await db.insert(conversationLogs).values(
      rejections.map(({ attempt, recipe, violations }) => ({
        kitchenId,
        sessionId: `intake:${queueId}`,
        role: "assistant",
        content: JSON.stringify(recipe),
        context: { run, attempt, rules: violations.map((v) => `${v.rule}: ${v.detail}`) },
      })),
    );
  } catch (err) {
    if (isIntegrityError(err)) throw err;
    console.error(`Could not log a rejected intake for ${queueId}:`, err);
  }
}

/**
 * The plan the cook page asks for (`ensureCookPlan`): the stored one, or one
 * derived now (`deriveAndStoreCookPlan`). A row still waiting for intake
 * gets none and nothing is stored, so intake can still cut it: a plan of the
 * recipe as sent would settle it as sent.
 */
export async function cookPlanForCook(
  kitchenId: string,
  queueId: string,
  memberId: string | null = null,
): Promise<CookPlanOutcome> {
  const item = await getQueueItemOrThrow(kitchenId, queueId);
  if (queueIntake(item).state === "pending") return { plan: null, error: INTAKE_STATE_ERRORS.waiting };
  return deriveAndStoreCookPlan(kitchenId, queueId, memberId);
}

/**
 * Runs everything a queued row needs before the cook opens it, from `after()`
 * once the add has responded: intake in `"background"` mode (when asked for),
 * then the cook plan of the recipe the cook meets (`deriveAndStoreCookPlan`).
 * A row whose intake is skipped for an AI cap or failed for now (still
 * `pending`) gets no plan here: a plan of the recipe as sent would settle it
 * as sent, and the next open tries intake again, then plans. Never rejects:
 * a failed intake or derivation is already stored (settled or for the next
 * open to retry), an AI cap stops quietly after logging, and any other throw
 * (the item removed, the database down) has no caller left to tell, so each
 * is logged here.
 */
export async function prepareQueueItemInBackground(
  kitchenId: string,
  queueId: string,
): Promise<void> {
  try {
    const { intake, skippedForAllowance } = await ensureIntakeForCook(
      kitchenId,
      queueId,
      "background",
    );
    if (skippedForAllowance) return;
    if (intake.state === "pending") {
      console.warn(`Queue item ${queueId} not cut yet, tries again on open: ${intake.error}`);
      return;
    }
    if (intake.state === "as-sent") console.warn(`Queue item ${queueId} shown as sent: ${intake.error}`);
    const plan = await deriveAndStoreCookPlan(kitchenId, queueId);
    if (plan.error) console.warn(`No cook plan for queue item ${queueId}: ${plan.error}`);
  } catch (err) {
    if (isAllowanceUsed(err)) {
      console.warn(`[ai-cap] cook plan not derived for ${queueId}`);
      return;
    }
    console.error(`Preparing queue item ${queueId} failed:`, err);
  }
}
