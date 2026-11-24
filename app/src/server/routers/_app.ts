import { after } from "next/server";
import { TRPCError } from "@trpc/server";
import { router, publicProcedure, kitchenProcedure } from "../trpc";
import { requireOwnedQueueItem } from "../kitchen-access";
import { z } from "zod";
import {
  syncRecipesFromDoc,
  getDocRecipeBySlug,
  docRecipeToQueueData,
} from "../../lib/recipe-sync";
import { cachedIdeasCount, getRecipeIdeas, saveRecipeIdea } from "../../lib/recipe-ideas";
import { HOUSEHOLD_PACK, PACK_FILE_SOURCES } from "../../lib/shelf/registry";
import { PACK_PLANS_DIR, loadAppPackFiles, loadAppShelf } from "../../lib/shelf/load";
import { packPlanFor, readPackPlanFile } from "../../lib/pack-cook-plans";
import { libraryPlanReport } from "../../lib/library-cook-plans";
import { packView, shelfView } from "../../lib/shelf/view-build";
import { packRecipeToQueueData, parsePackSource } from "../../lib/pack-convert/to-queue";
import type { KitchenQueueRecipeData } from "../../../drizzle/schema";
import { storedPlanToCopy, type StoredPlan } from "../../lib/kitchen/cook-plan-stamp";
import { connected } from "../../lib/hooks/connected";
import { hook } from "../../lib/hooks/registry";
import {
  parseGroceryInput,
  reconcileRecipeIngredients,
} from "../../lib/pantry-reconciliation";
import {
  CANT_ESTIMATE_SERVES,
  CANT_READ_RECIPE,
  queueRefusal,
  readQueueItem,
  servesForQueue,
} from "../../lib/pack-convert/queue-recipe";
import { storedEstimate, type ServesEstimateInput } from "../../lib/pack-convert/convert";
import { withCookRecipe } from "../../lib/pack-convert/intake-state";
import { chatCookingAssistant, type Message } from "../../lib/claude";
import { AnswerCutOff, ASK_CUT_OFF_CODE } from "../../lib/kitchen/ask-failure";
import {
  addToKitchenQueue,
  getKitchenQueue,
  getQueueItem,
  updateQueueStatus,
  removeFromQueue,
  getRecentCookingItems,
  cookPlanForCook,
  ensureIntakeForCook,
  prepareQueueItemInBackground,
  type KitchenQueueItem,
} from "../../lib/kitchen-queue";
import {
  CookLogConflict,
  CookLogItemNotFound,
  dismissCookAsk,
  logCookInBackground,
  openCookAsk,
  rateCook,
  retryCookLog,
} from "../../lib/kitchen-cook-log";
import {
  autoFinishCook,
  finishLeftCooks,
  reopenAutoFinished,
  reportLastScreen,
} from "../../lib/kitchen-auto-finish";
import { ACTIVITY_SLACK_MS, AUTO_FINISH_IDLE_MS } from "../../lib/kitchen/auto-finish";
import {
  CookReportInputSchema,
  NoteSchema,
  REPORTS_PER_DAY,
  annotateCookReport,
  storeCookReport,
} from "../../lib/cook-reports";
import {
  extractRecipeFromUrl,
  extractRecipeFromText,
  extractRecipeFromImage,
} from "../../lib/recipe-import";
import { isAllowanceUsed, kitchenMeter } from "../../lib/ai";

// Zod schema for chat messages (with optional image support)
const MessageSchema = z.object({
  role: z.enum(["user", "assistant"]),
  content: z.string(),
  /** Optional image data for vision-capable messages */
  image: z
    .object({
      base64: z.string(),
      mimeType: z.string().optional(),
    })
    .optional(),
});

const ChatInputSchema = z.object({
  sessionId: z.string(),
  messages: z.array(MessageSchema),
});

const CookingTimerSnapshotSchema = z.object({
  id: z.string(),
  label: z.string(),
  remainingSec: z.number(),
  status: z.enum(["running", "expired"]),
});

// The prep jobs in hand, as the cook's screen says them (`askInHand`). The
// bounds are well past any plan's page: they stop a runaway request and
// never turn a real page's question away.
const CookingPrepSchema = z.object({
  jobs: z
    .array(
      z.object({
        text: z.string().max(2000),
        amounts: z.array(z.string().max(500)).max(60),
        done: z.boolean(),
      }),
    )
    .max(60),
});

const CookingChatInputSchema = ChatInputSchema.extend({
  currentRecipe: z.string().optional(),
  queueId: z.string().min(1).optional(),
  servings: z.number().positive().optional(),
  servesBase: z.number().positive().optional(),
  currentStepIndex: z.number().int().min(0).optional(),
  prep: CookingPrepSchema.optional(),
  timers: z.array(CookingTimerSnapshotSchema).optional(),
  includeRecipeContext: z.boolean().optional(),
});

// ==========================================================================
// Chat Persistence Schemas (F1)
// ==========================================================================

/** Strips the internal kitchen identifier before sending a queue item to the client. */
function omitKitchenId<T extends { kitchenId?: unknown }>(item: T): Omit<T, "kitchenId"> {
  const { kitchenId: _kitchenId, ...rest } = item;
  return rest;
}

/**
 * A queue row as the cook page reads it (`getKitchenQueueItem`, and the
 * answer to `ensureIntake`). The recipe the cook meets: intake's cut when it
 * made one, else the recipe as sent, with the intake state beside it for the
 * info sheet and the page's wait (cook-fidelity plan). That recipe read as a
 * pack recipe (slice B4); the rest of the row rides along unchanged. One
 * that can't be read gives its reason. A `pack:` row reads its pack recipe
 * natively behind the reverse guard (slice B5d, D1–D5): only then are the
 * registry's pack files read, never the household's own library.
 */
async function readForCook(stored: KitchenQueueItem) {
  const item = withCookRecipe(stored);
  const files = parsePackSource(item.recipeData?.source) === null ? null : await loadAppPackFiles();
  const { log, ...reading } = readQueueItem(item, files);
  if (reading.conversionError !== null) {
    console.error(`[queue] item ${item.id}: can't read its recipe as a pack recipe: ${reading.conversionError}`);
  }
  for (const line of log) console.info(`[queue] item ${item.id}: ${line}`);
  return omitKitchenId({ ...item, ...reading });
}

const RecipeIngredientSchema = z.object({
  item: z.string(),
  amount: z.string().optional(),
  unit: z.string().optional(),
});

// ==========================================================================
// Kitchen Queue Schemas (F2)
// ==========================================================================

const KitchenQueueStatusSchema = z.enum([
  "pending",
  "cooking",
  "completed",
  "cancelled",
]);

const KitchenQueueRecipeDataSchema = z.object({
  name: z.string(),
  ingredients: z.array(RecipeIngredientSchema).optional(),
  steps: z.array(z.string()).optional(),
  estimatedTime: z
    .object({
      active: z.number().optional(),
      passive: z.number().optional(),
      total: z.number().optional(),
    })
    .optional(),
  serves: z.number().optional(),
  tags: z.array(z.string()).optional(),
  notes: z.string().optional(),
  // Per-step ingredient indices (parallel to steps). Must be declared here or
  // z.object() strips it from recipeData before it reaches the database.
  stepIngredients: z.array(z.array(z.number())).optional(),
  source: z.string().optional(),
});

/**
 * Refuses a recipe the cook page couldn't read before it is queued, as the
 * webhook's 422 does (B4 fix round 1, MED 3), so the sender sees why instead
 * of the cook meeting "Couldn't read this recipe" at the counter.
 */
function refuseUnreadable(
  recipeData: Parameters<typeof queueRefusal>[0],
  servesEstimate?: Parameters<typeof queueRefusal>[1],
): void {
  const refusal = queueRefusal(recipeData, servesEstimate);
  if (refusal !== null) {
    throw new TRPCError({ code: "UNPROCESSABLE_CONTENT", message: refusal });
  }
}

/**
 * Sous's serving estimate for a recipe that states no count (slice B4b),
 * made before the queue-time check. One that can't be made refuses the add
 * (`PRECONDITION_FAILED`, so the screen tells it from an unreadable recipe);
 * nothing is queued and no stand-in count is stored.
 */
async function servesEstimateFor(
  recipeData: Parameters<typeof servesForQueue>[0],
  options: Parameters<typeof servesForQueue>[1],
) {
  const serves = await servesForQueue(recipeData, options);
  if (!serves.ok) {
    console.error(`[queue] ${CANT_ESTIMATE_SERVES}: ${serves.reason}`);
    throw new TRPCError({
      code: "PRECONDITION_FAILED",
      message: `${CANT_ESTIMATE_SERVES}: ${serves.reason}`,
    });
  }
  return serves.servesEstimate;
}

/**
 * Queues a recipe with the plan worked out ahead for it (slice P decision 5):
 * a stored plan that passes its three checks, or a settled error made for the
 * same input, is written in the insert and nothing is scheduled. Anything
 * else counts as no stored plan, and the plan is derived after the response
 * as before. A stored plan that no longer validates is logged as an error
 * (it was checked when made); a mismatch (a changed recipe, an older prompt)
 * is expected and logged as info.
 */
async function queueWithStoredPlan(
  kitchenId: string,
  input: { recipeData: KitchenQueueRecipeData; servesEstimate?: ServesEstimateInput },
  stored: StoredPlan | null,
  label: string,
): Promise<{ id: string }> {
  const checked = stored === null ? null : storedPlanToCopy(stored, input.recipeData);
  if (checked !== null && !checked.ok && checked.reason !== "no plan") {
    const log = checked.reason.startsWith("invalid") ? console.error : console.info;
    log(`[queue] ${label}: stored cook plan not copied (${checked.reason}), deriving instead`);
  }
  const plan = checked?.ok ? checked.copy : undefined;
  const item = await addToKitchenQueue(kitchenId, { ...input, plan });
  if (plan === undefined) after(() => prepareQueueItemInBackground(kitchenId, item.id));
  return item;
}

/**
 * The ideas count for the shelf's "Saved for later": the cache's, never a
 * read of the ideas hook; 0 with no ideas hook connected. A cache the DB
 * can't read leaves the count off rather than the shelf (the ideas are
 * non-critical, as the Ideas list's own cached fallback has it); it is logged.
 */
async function ideasCount(kitchenId: string): Promise<number | null> {
  if (!connected.ideas) return 0;
  try {
    return await cachedIdeasCount(kitchenId);
  } catch (error) {
    console.error("[shelf] the ideas cache couldn't be read:", error);
    return null;
  }
}

const AddToKitchenQueueSchema = z.object({
  recipeNotionId: z.string().optional(),
  recipeData: KitchenQueueRecipeDataSchema.optional(),
});

const NOTE_LIMIT = 500;

const RateCookSchema = z.object({
  queueId: z.string().uuid(),
  rating: z.number().int().min(1).max(5),
  /** Trimmed, then counted in characters (code points), not UTF-16 units. */
  notes: z
    .string()
    .trim()
    .refine((note) => [...note].length <= NOTE_LIMIT, {
      message: `A note is at most ${NOTE_LIMIT} characters`,
    })
    .optional(),
});

/**
 * A Cook Log conflict answers CONFLICT with the reason as its message
 * ("not-completed", "writing" or "row-moved"); the surface words it. A
 * missing queue item answers NOT_FOUND.
 */
async function answeringConflicts<T>(run: () => Promise<T>): Promise<T> {
  try {
    return await run();
  } catch (err) {
    if (err instanceof CookLogConflict) {
      throw new TRPCError({ code: "CONFLICT", message: err.reason, cause: err });
    }
    if (err instanceof CookLogItemNotFound) {
      throw new TRPCError({ code: "NOT_FOUND", message: err.message, cause: err });
    }
    throw err;
  }
}

/**
 * A page's last touch, by its clock. The pages' clocks are kept to the
 * network's time (DECISIONS 2026-10-26, auto-finish call 6), so one ahead of
 * the server's by more than the slack is set wrong, and is refused: its
 * touches would outrank every other page's until the server's clock caught up.
 */
function touchOf(interactedAt: number, now: number): Date {
  if (interactedAt > now + ACTIVITY_SLACK_MS) {
    throw new TRPCError({
      code: "BAD_REQUEST",
      message: "This tablet's clock is ahead of the server's; set it to the network's time",
    });
  }
  return new Date(interactedAt);
}

export const appRouter = router({
  // Health check endpoint
  health: publicProcedure.query(() => {
    return { status: "ok", timestamp: new Date().toISOString() };
  }),

  // ==========================================================================
  // Chat with Claude
  // ==========================================================================

  // Cooking assistant (mid-cook questions)
  chatCooking: kitchenProcedure
    .input(CookingChatInputSchema)
    .mutation(async ({ ctx, input }) => {
      const messages: Message[] = input.messages;
      try {
        return await chatCookingAssistant(
          ctx.kitchen.id,
          input.sessionId,
          messages,
          input.currentRecipe,
          {
            queueId: input.queueId,
            servings: input.servings,
            servesBase: input.servesBase,
            currentStepIndex: input.currentStepIndex,
            prep: input.prep,
            timers: input.timers,
            includeRecipeContext: input.includeRecipeContext,
            memberId: ctx.member?.id ?? null,
          },
        );
      } catch (err) {
        // A reply cut at the token cap answers its own code, so Ask says the
        // answer ran long rather than that it couldn't reach Sous.
        if (err instanceof AnswerCutOff) {
          throw new TRPCError({ code: ASK_CUT_OFF_CODE, message: err.message, cause: err });
        }
        throw err;
      }
    }),

  // ==========================================================================
  // Kitchen Queue (F2)
  // ==========================================================================

  // Add a recipe to the kitchen queue; its cook plan is derived after the
  // response, so the add stays fast and the plan is usually ready on open.
  addToKitchenQueue: kitchenProcedure
    .input(AddToKitchenQueueSchema)
    .mutation(async ({ ctx, input }) => {
      const servesEstimate = await servesEstimateFor(input.recipeData, {
        mayEstimate: true,
        meter: kitchenMeter(
          ctx.kitchen.id,
          ctx.member?.id ?? null,
          "serves-estimate",
        ),
      });
      refuseUnreadable(input.recipeData, servesEstimate);
      const item = await addToKitchenQueue(ctx.kitchen.id, {
        recipeNotionId: input.recipeNotionId,
        recipeData: input.recipeData,
        servesEstimate,
      });
      after(() => prepareQueueItemInBackground(ctx.kitchen.id, item.id));
      return item;
    }),

  // Get recipes in the kitchen queue for the session kitchen
  getKitchenQueue: kitchenProcedure
    .input(
      z.object({
        status: KitchenQueueStatusSchema.optional(),
      }),
    )
    .query(async ({ ctx, input }) => {
      const items = await getKitchenQueue(
        ctx.kitchen.id,
        input.status as
          | "pending"
          | "cooking"
          | "completed"
          | "cancelled"
          | undefined,
      );
      return items.map(omitKitchenId);
    }),

  // Get a single queue item by ID
  getKitchenQueueItem: kitchenProcedure
    .input(z.object({ queueId: z.string().uuid() }))
    .query(async ({ ctx, input }) => {
      const stored = await getQueueItem(ctx.kitchen.id, input.queueId);
      if (!stored) return null;
      return readForCook(stored);
    }),

  // The item's intake, run now if it was asked for and has no outcome yet
  // (cook-fidelity plan). The cook page calls this when it opens an item
  // still waiting for intake: `opening` with no session kept for it (the
  // page waits on the answer), `started` with one (the cook is under way on
  // the recipe as sent, so it settles as sent; round-3 review, B1). Answers
  // with the row its write stored, read for the cook as `getKitchenQueueItem`
  // reads it, so the page cooks what this call stored; nothing is read after
  // the write, so no failed read can lose a stored cut (C2; round-4, H1).
  // Never fails for the model: a failed intake comes back as sent.
  ensureIntake: kitchenProcedure
    .input(z.object({ queueId: z.string().uuid(), ask: z.enum(["opening", "started"]) }))
    .mutation(async ({ ctx, input }) => {
      await requireOwnedQueueItem(ctx.kitchen.id, input.queueId);
      const { item: stored } = await ensureIntakeForCook(
        ctx.kitchen.id,
        input.queueId,
        input.ask,
        ctx.member?.id ?? null,
      );
      return readForCook(stored);
    }),

  // The item's cook plan, derived now if the queue-time derivation hasn't
  // stored one. The cook view calls this once per open when it has no plan.
  // A settled error comes back with no model call (slice P decision 8). A
  // row still waiting for intake gets none (`cookPlanForCook`).
  ensureCookPlan: kitchenProcedure
    .input(z.object({ queueId: z.string().uuid() }))
    .mutation(async ({ ctx, input }) => {
      await requireOwnedQueueItem(ctx.kitchen.id, input.queueId);
      return cookPlanForCook(
        ctx.kitchen.id,
        input.queueId,
        ctx.member?.id ?? null,
      );
    }),

  // Update the status of a queue item. A real transition into "completed"
  // writes the cook to the Cook Log after the response (when a Cook Log is
  // connected), so Done never waits on it; a repeat Done schedules nothing.
  updateKitchenQueueStatus: kitchenProcedure
    .input(
      z.object({
        queueId: z.string().uuid(),
        status: KitchenQueueStatusSchema,
      }),
    )
    .mutation(async ({ ctx, input }) => {
      await requireOwnedQueueItem(ctx.kitchen.id, input.queueId);
      const { completed, started } = await updateQueueStatus(
        ctx.kitchen.id,
        input.queueId,
        input.status as "pending" | "cooking" | "completed" | "cancelled",
      );
      const logs = connected["cook-log"];
      if (completed && logs) {
        after(() => logCookInBackground(ctx.kitchen.id, input.queueId));
      }
      // A start finishes any cook left on its last screen: a real transition,
      // not a repeat of a start already made (a retry after a lost answer),
      // which could take a cook that only just reached its last screen.
      if (started) {
        const left = await finishLeftCooks(ctx.kitchen.id, input.queueId);
        if (logs) {
          for (const id of left) {
            after(() => logCookInBackground(ctx.kitchen.id, id));
          }
        }
      }
      return { success: true };
    }),

  // ==========================================================================
  // Auto-finish (cook-fidelity decision 7; src/lib/kitchen-auto-finish.ts)
  // ==========================================================================

  // The open cook page's report of where the cook sits: its last-screen
  // activity, or null off the last screen. Answers whether the app has
  // finished the cook, so the page learns of a sweep.
  // The page sends how long ago its last activity was (negative while a
  // timer runs on), which the server dates by its own clock, so a slow report
  // reads later, never earlier, and a tablet's clock set wrong can't finish a
  // cook early. It also sends its last touch, by its own clock, which orders
  // the reports of every page on the cook (`reportLastScreen`); a touch ahead
  // of the server's clock is refused, so a clock run fast can't shut the
  // other pages out.
  markCookActivity: kitchenProcedure
    .input(
      z.object({
        queueId: z.string().uuid(),
        idleForMs: z.number().int().nullable(),
        interactedAt: z.number().int().positive(),
      }),
    )
    .mutation(async ({ ctx, input }) => {
      await requireOwnedQueueItem(ctx.kitchen.id, input.queueId);
      const now = Date.now();
      const touched = touchOf(input.interactedAt, now);
      const at = input.idleForMs === null ? null : new Date(now - input.idleForMs);
      return reportLastScreen(ctx.kitchen.id, input.queueId, at, touched);
    }),

  // The open page's own finish of a cook idle on its last screen, dated to
  // its last activity; the same path as Done, without the pantry sheet.
  // Its idle time as the page counts it, at least the wait: never sooner.
  // Its last touch, by its own clock: a newer one on any page keeps the cook going.
  autoFinishCook: kitchenProcedure
    .input(
      z.object({
        queueId: z.string().uuid(),
        idleForMs: z.number().int().min(AUTO_FINISH_IDLE_MS),
        interactedAt: z.number().int().positive(),
      }),
    )
    .mutation(async ({ ctx, input }) => {
      await requireOwnedQueueItem(ctx.kitchen.id, input.queueId);
      const now = Date.now();
      const touched = touchOf(input.interactedAt, now);
      const at = new Date(now - input.idleForMs);
      const { finished, autoFinished } = await autoFinishCook(
        ctx.kitchen.id,
        input.queueId,
        at,
        touched,
      );
      if (finished && connected["cook-log"]) {
        after(() => logCookInBackground(ctx.kitchen.id, input.queueId));
      }
      return { autoFinished };
    }),

  // A press on the open cook after the app finished it: the cook goes on.
  reopenCook: kitchenProcedure
    .input(z.object({ queueId: z.string().uuid() }))
    .mutation(async ({ ctx, input }) => {
      await requireOwnedQueueItem(ctx.kitchen.id, input.queueId);
      return reopenAutoFinished(ctx.kitchen.id, input.queueId);
    }),

  // Write a finished cook's Cook Log row again, only once the first write
  // has failed (or was lost).
  retryCookLog: kitchenProcedure
    .input(z.object({ queueId: z.string().uuid() }))
    .mutation(async ({ ctx, input }) => {
      await requireOwnedQueueItem(ctx.kitchen.id, input.queueId);
      if (!connected["cook-log"]) {
        return { status: "failed" as const, error: "No Cook Log is connected" };
      }
      return answeringConflicts(() => retryCookLog(ctx.kitchen.id, input.queueId));
    }),

  // Rate a finished cook into its Cook Log row, with an optional note.
  rateCook: kitchenProcedure
    .input(RateCookSchema)
    .mutation(async ({ ctx, input }) => {
      await requireOwnedQueueItem(ctx.kitchen.id, input.queueId);
      if (!connected["cook-log"]) {
        return { rated: false as const, error: "No Cook Log is connected" };
      }
      return answeringConflicts(() => rateCook(ctx.kitchen.id, input));
    }),

  // The kitchen's "How was it?": today's latest finished cook with its ask
  // still open, or null (always null with no Cook Log connected). Reads the
  // cook's row while it asks, so a rating written there by anyone else closes
  // it. A read: it finishes nothing (the sweep does,
  // `POST /api/kitchen-queue/sweep`).
  getCookAsk: kitchenProcedure
    .input(z.object({}))
    .query(async ({ ctx }) => {
      if (!connected["cook-log"]) return null;
      return openCookAsk(ctx.kitchen.id);
    }),

  // "Not now": close a finished cook's ask unanswered.
  dismissCookAsk: kitchenProcedure
    .input(z.object({ queueId: z.string().uuid() }))
    .mutation(async ({ ctx, input }) => {
      await requireOwnedQueueItem(ctx.kitchen.id, input.queueId);
      if (!connected["cook-log"]) return { success: true };
      await answeringConflicts(() => dismissCookAsk(ctx.kitchen.id, input.queueId));
      return { success: true };
    }),

  // Remove a recipe from the queue
  removeFromKitchenQueue: kitchenProcedure
    .input(z.object({ queueId: z.string().uuid() }))
    .mutation(async ({ ctx, input }) => {
      await requireOwnedQueueItem(ctx.kitchen.id, input.queueId);
      await removeFromQueue(ctx.kitchen.id, input.queueId);
      return { success: true };
    }),

  // Get recent cooking items (for quick resume in kitchen mode)
  getRecentCookingItems: kitchenProcedure
    .input(
      z.object({
        limit: z.number().min(1).max(10).optional(),
      }),
    )
    .query(async ({ ctx, input }) => {
      const items = await getRecentCookingItems(ctx.kitchen.id, input.limit);
      return items.map(omitKitchenId);
    }),

  // ==========================================================================
  // Recipe Import (F3)
  // ==========================================================================

  // Import a recipe from a URL
  importRecipeFromUrl: kitchenProcedure
    .input(z.object({ url: z.string().url() }))
    .mutation(async ({ ctx, input }) => {
      const extraction = await extractRecipeFromUrl(
        input.url,
        kitchenMeter(ctx.kitchen.id, ctx.member?.id ?? null, "import-url"),
      );
      return {
        recipe: extraction?.recipe ?? null,
        notices: extraction?.notices ?? [],
        success: extraction !== null,
      };
    }),

  // Import a recipe from pasted text
  importRecipeFromText: kitchenProcedure
    .input(z.object({ text: z.string().min(10) }))
    .mutation(async ({ ctx, input }) => {
      const extraction = await extractRecipeFromText(input.text, {
        meter: kitchenMeter(
          ctx.kitchen.id,
          ctx.member?.id ?? null,
          "import-text",
        ),
      });
      return {
        recipe: extraction?.recipe ?? null,
        notices: extraction?.notices ?? [],
        success: extraction !== null,
      };
    }),

  // Import a recipe from an image (photo of recipe)
  importRecipeFromImage: kitchenProcedure
    .input(z.object({ imageBase64: z.string() }))
    .mutation(async ({ ctx, input }) => {
      const extraction = await extractRecipeFromImage(
        input.imageBase64,
        kitchenMeter(ctx.kitchen.id, ctx.member?.id ?? null, "import-photo"),
      );
      return {
        recipe: extraction?.recipe ?? null,
        notices: extraction?.notices ?? [],
        success: extraction !== null,
      };
    }),

  // ==========================================================================
  // Recipe Library (the household book + the recipe-idea backlog)
  // ==========================================================================

  // ==========================================================================
  // Cookpacks (slice S): the shelf, a pack, and a recipe from a pack to the queue
  // ==========================================================================

  // The shelf as it draws (S-D14): the household entry (none with no recipe
  // library connected), the creator packs in registry order, and the ideas
  // count from the cache (no hook is read). A pack that fails validation is
  // left off and logged.
  getShelf: kitchenProcedure.query(async ({ ctx }) => {
    if (!connected["recipe-library"]) {
      const shelf = await loadAppShelf(ctx.kitchen.id, { sources: PACK_FILE_SOURCES });
      return {
        ...shelfView(shelf, await ideasCount(ctx.kitchen.id)),
        household: null,
      };
    }
    const shelf = await loadAppShelf(ctx.kitchen.id);
    return shelfView(shelf, await ideasCount(ctx.kitchen.id));
  }),

  // A pack as its view draws it, or null when no pack on the shelf has the id.
  // Rows carry a title and one fact, never steps or ingredients.
  getPack: kitchenProcedure
    .input(z.object({ packId: z.string().min(1) }))
    .query(async ({ ctx, input }) => {
      if (!connected["recipe-library"]) {
        if (input.packId === HOUSEHOLD_PACK.id) {
          throw new TRPCError({ code: "NOT_FOUND", message: "Pack not found" });
        }
        return packView(
          await loadAppShelf(ctx.kitchen.id, { sources: PACK_FILE_SOURCES }),
          input.packId,
        );
      }
      return packView(await loadAppShelf(ctx.kitchen.id), input.packId);
    }),

  // The library's cook plans at a glance (slice P): the recipes whose plan
  // failed for good (a Doc edit is the fix), and how many still wait on one.
  // Free: it reads the columns, never a plan or the model.
  libraryPlanReport: kitchenProcedure.query(({ ctx }) => {
    if (!connected["recipe-library"]) {
      return { needFixes: [], pending: 0, total: 0 };
    }
    return libraryPlanReport(ctx.kitchen.id);
  }),

  // Re-sync the library from its source (read → chunk → extract → upsert)
  syncRecipes: kitchenProcedure.mutation(async ({ ctx }) => {
    if (!connected["recipe-library"]) {
      throw new TRPCError({
        code: "FORBIDDEN",
        message: "Recipe sync is not available: no recipe library is connected",
      });
    }
    return syncRecipesFromDoc(ctx.kitchen.id, {
      memberId: ctx.member?.id ?? null,
    });
  }),

  // Queues a recipe from a pack with the plan worked out ahead for it, or
  // derives its plan after the response when none fits (slice P).
  // The household pack's recipe is its library row, snapshotted as today
  // (its estimate carried, never made); a pack file's is projected into the
  // stored shape behind the round-trip guard (S-D12). Either way a recipe the
  // cook page couldn't read is refused with UNPROCESSABLE_CONTENT, so the
  // screen says "Couldn't read that recipe, so it wasn't sent."
  queueFromPack: kitchenProcedure
    .input(
      z.object({
        packId: z.string().min(1),
        recipeId: z.string().min(1),
      }),
    )
    .mutation(async ({ ctx, input }) => {
      let recipeData: KitchenQueueRecipeData;
      let servesEstimate: ServesEstimateInput | undefined;
      let stored: StoredPlan | null = null;
      if (input.packId === HOUSEHOLD_PACK.id) {
        if (!connected["recipe-library"]) {
          throw new TRPCError({ code: "NOT_FOUND", message: "Pack not found" });
        }
        const recipe = await getDocRecipeBySlug(ctx.kitchen.id, input.recipeId);
        if (!recipe) {
          throw new TRPCError({ code: "NOT_FOUND", message: `Recipe not found in the household book: ${input.recipeId}` });
        }
        if (recipe.extractionError) {
          throw new TRPCError({
            code: "UNPROCESSABLE_CONTENT",
            message: `Recipe "${recipe.name}" didn't come through on the last Refresh and has no cookable steps.`,
          });
        }
        recipeData = docRecipeToQueueData(recipe);
        // The library row's estimate travels with it; a send never estimates.
        servesEstimate = await servesEstimateFor(recipeData, {
          carried: storedEstimate(recipe),
          mayEstimate: false,
        });
        // The plan Refresh or the backfill worked out for the row (slice P).
        stored = {
          plan: recipe.cookPlan,
          error: recipe.cookPlanError,
          sourceHash: recipe.cookPlanSourceHash,
          stamp: recipe.cookPlanStamp,
        };
      } else {
        const shelf = await loadAppShelf(
          ctx.kitchen.id,
          connected["recipe-library"] ? undefined : { sources: PACK_FILE_SOURCES },
        );
        const pack = shelf.packs.find((p) => p.pack.id === input.packId)?.pack;
        const recipe = pack?.recipes.find((r) => r.id === input.recipeId);
        if (!pack || !recipe) {
          throw new TRPCError({ code: "NOT_FOUND", message: `No recipe ${input.recipeId} in pack ${input.packId}` });
        }
        const projected = packRecipeToQueueData(recipe, pack.id);
        if (!projected.ok) {
          console.error(`[queue] ${pack.id}/${recipe.id} doesn't round-trip, not queued:`, projected.differences);
          throw new TRPCError({
            code: "UNPROCESSABLE_CONTENT",
            message: `${CANT_READ_RECIPE}: ${projected.differences.join("; ")}`,
          });
        }
        if (projected.projection.dropped.length > 0) {
          console.info(`[queue] ${pack.id}/${recipe.id} queued without:`, projected.projection.dropped);
        }
        recipeData = projected.projection.recipeData;
        servesEstimate = projected.projection.servesEstimate ?? undefined;
        // The plan reviewed into the pack's committed plan file (slice P,
        // `app/pack-plans/`). An
        // unreadable file is logged and treated as holding no plan: the
        // golden test keeps one from merging, and the queue derives as before.
        const planFile = await readPackPlanFile(PACK_PLANS_DIR, pack.id);
        if (planFile.ok) {
          stored = packPlanFor(planFile.file, recipe.id);
        } else {
          console.error(`[queue] ${pack.id}/${recipe.id}: pack plan file unreadable, deriving instead: ${planFile.reason}`);
        }
      }
      refuseUnreadable(recipeData, servesEstimate);
      return queueWithStoredPlan(
        ctx.kitchen.id,
        { recipeData, servesEstimate },
        stored,
        `${input.packId}/${input.recipeId}`,
      );
    }),

  // Get the recipe-idea backlog (from the ideas hook, cached for resilience)
  getRecipeIdeas: kitchenProcedure.query(async ({ ctx }) => {
    if (!connected.ideas) {
      return { ideas: [], syncedAt: new Date(0), stale: false };
    }
    return getRecipeIdeas(ctx.kitchen.id);
  }),

  // Append a recipe idea to the ideas list ("save as inspiration")
  saveRecipeIdea: kitchenProcedure
    .input(z.object({ text: z.string().min(1) }))
    .mutation(async ({ input }) => {
      if (!connected.ideas) {
        return { success: false };
      }
      await saveRecipeIdea(input.text);
      return { success: true };
    }),

  // ==========================================================================
  // Cook reports (B2): write-only, read with scripts/list-reports.ts
  // ==========================================================================

  // Store a flagged moment. A resend of a stored id counts as sent and sets
  // the row's note to the one it carries; past the per-kitchen cap of 100
  // a day the outbox keeps the report waiting. A resend whose id belongs to
  // another kitchen answers CONFLICT.
  submitCookReport: kitchenProcedure
    .input(CookReportInputSchema)
    .mutation(async ({ ctx, input }) => {
      const outcome = await storeCookReport(ctx.kitchen.id, input, ctx.member?.id ?? null);
      if (outcome === "capped") {
        throw new TRPCError({
          code: "TOO_MANY_REQUESTS",
          message: `At most ${REPORTS_PER_DAY} reports a day`,
        });
      }
      if (outcome === "conflict") {
        throw new TRPCError({
          code: "CONFLICT",
          message: "Report id already in use",
        });
      }
      return { id: input.id, duplicate: outcome === "duplicate" };
    }),

  // Set a stored report's note. NOT_FOUND keeps the outbox's note dirty
  // until its report is sent (F9).
  annotateCookReport: kitchenProcedure
    .input(z.object({ id: z.uuid(), note: NoteSchema }))
    .mutation(async ({ ctx, input }) => {
      if (!(await annotateCookReport(ctx.kitchen.id, input.id, input.note))) {
        throw new TRPCError({ code: "NOT_FOUND", message: "No such report" });
      }
      return { id: input.id };
    }),

  // ==========================================================================
  // Grocery Intake & Pantry Reconciliation
  // ==========================================================================

  // Parse groceries from photo, pasted text, or voice transcript
  parseGroceryInput: kitchenProcedure
    .input(
      z.object({
        type: z.enum(["image", "text", "voice"]),
        content: z.string().min(1),
      }),
    )
    .mutation(async ({ ctx, input }) => {
      if (!connected.pantry) {
        return { items: [] };
      }
      const items = await parseGroceryInput(
        input,
        kitchenMeter(ctx.kitchen.id, ctx.member?.id ?? null, "grocery-parse"),
      );
      return { items };
    }),

  // Append new items to the pantry under target headings
  addIngredientsToPantry: kitchenProcedure
    .input(
      z.object({
        items: z
          .array(
            z.object({
              text: z.string().min(1),
              section: z.string().optional(),
            }),
          )
          .min(1),
      }),
    )
    .mutation(async ({ input }) => {
      if (!connected.pantry) {
        return { success: true, count: 0 };
      }
      const result = await hook("pantry").addItems(input.items);
      return { success: true, count: result.added };
    }),

  // Reconcile recipe ingredients against the pantry's items upon cook finish
  getRecipePantryReconciliation: kitchenProcedure
    .input(z.object({ queueId: z.string().uuid() }))
    .query(async ({ ctx, input }) => {
      const stored = await requireOwnedQueueItem(ctx.kitchen.id, input.queueId);
      if (!connected.pantry) {
        return { candidates: [] };
      }
      // The lines the cook cooked from: intake's cut when there is one.
      const item = withCookRecipe(stored);
      try {
        const docSections = await hook("pantry").readSections();
        const recipeIngredients = item.recipeData?.ingredients ?? [];
        const candidates = await reconcileRecipeIngredients(
          {
            docSections,
            recipeIngredients,
            recipeName: item.recipeData?.name,
          },
          kitchenMeter(
            ctx.kitchen.id,
            ctx.member?.id ?? null,
            "pantry-reconcile",
          ),
        );
        return { candidates };
      } catch (error) {
        if (isAllowanceUsed(error)) throw error;
        console.warn("Could not read the pantry for reconciliation:", error);
        return { candidates: [] };
      }
    }),

  // Apply confirmed deletions and quantity decrements to the pantry
  applyPantryReconciliation: kitchenProcedure
    .input(
      z.object({
        queueId: z.string().uuid().optional(),
        actions: z.array(
          z.object({
            action: z.enum(["delete", "decrement"]),
            oldText: z.string().min(1),
            newText: z.string().optional(),
            section: z.string().optional(),
          }),
        ),
      }),
    )
    .mutation(async ({ ctx, input }) => {
      if (input.queueId !== undefined) {
        await requireOwnedQueueItem(ctx.kitchen.id, input.queueId);
      }
      if (!connected.pantry) {
        return { success: true, updated: 0 };
      }
      const result = await hook("pantry").applyUpdates(input.actions);
      return { success: true, updated: result.updated };
    }),

  // ==========================================================================
  // Shopping List
  // ==========================================================================

  getShoppingList: kitchenProcedure.query(async () => {
    if (!connected["shopping-list"]) {
      return { items: [], syncedAt: new Date(0) };
    }
    return hook("shopping-list").list();
  }),

  addShoppingListItems: kitchenProcedure
    .input(
      z.object({
        items: z
          .array(
            z.object({
              item: z
                .string()
                .trim()
                .max(200)
                .transform((s) => s.replace(/^[•◦▪‣·*-]\s*/, "").trim())
                .pipe(z.string().min(1)),
              forRecipe: z.string().trim().max(200).nullish(),
            }),
          )
          .min(1)
          .max(50),
      }),
    )
    .mutation(async ({ input }) => {
      if (!connected["shopping-list"]) {
        return { added: [] };
      }
      return hook("shopping-list").add(input.items);
    }),

  removeShoppingListItem: kitchenProcedure
    .input(
      z.object({
        rawOrKey: z
          .string()
          .trim()
          .max(200)
          .transform((s) => s.replace(/^[•◦▪‣·*-]\s*/, "").trim())
          .pipe(z.string().min(1)),
      }),
    )
    .mutation(async ({ input }) => {
      if (!connected["shopping-list"]) {
        return { removed: false };
      }
      return hook("shopping-list").remove(input.rawOrKey);
    }),

  clearShoppingList: kitchenProcedure.mutation(async () => {
    if (!connected["shopping-list"]) {
      return { cleared: 0 };
    }
    return hook("shopping-list").clear();
  }),
});

export type AppRouter = typeof appRouter;
