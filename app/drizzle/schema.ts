import {
  pgTable,
  text,
  timestamp,
  uuid,
  jsonb,
  integer,
  bigint,
  boolean,
  index,
  unique,
  uniqueIndex,
  check,
  type AnyPgColumn,
} from "drizzle-orm/pg-core";
import { sql } from "drizzle-orm";
import type { CookPlan } from "../src/lib/kitchen/cook-plan";
import type { CookReportInput } from "../src/lib/cook-reports";
import { authUser } from "./auth-schema";

export * from "./auth-schema";

// Every kitchen table has row-level security on with no policies (`enableRLS`):
// on a hosted Postgres with a public Data API (Supabase's default grants) its
// `anon` role could otherwise read and write the table. The app connects as
// the tables' owner, which RLS doesn't bind unless forced.

// =============================================================================
// Kitchens and webhook tokens
// =============================================================================

/**
 * A household's space. Its queue, recipes, Ask history, reports, webhook tokens
 * and AI spend belong to it.
 */
export const kitchens = pgTable(
  "kitchens",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    slug: text("slug").notNull().unique(),
    name: text("name").notNull(),
    /** Optional per-kitchen monthly AI cap in micro-dollars; null uses the deployment default. */
    aiMonthlyCapMicros: bigint("ai_monthly_cap_micros", { mode: "number" }),
    createdAt: timestamp("created_at", { withTimezone: true })
      .defaultNow()
      .notNull(),
  },
  (t) => [
    check(
      "kitchens_slug_shape",
      sql`${t.slug} ~ '^[a-z0-9]+(-[a-z0-9]+)*$' and length(${t.slug}) <= 40`,
    ),
    check("kitchens_name_length", sql`length(${t.name}) between 1 and 80`),
    check(
      "kitchens_cap_nonnegative",
      sql`${t.aiMonthlyCapMicros} is null or ${t.aiMonthlyCapMicros} >= 0`,
    ),
  ],
).enableRLS();

/**
 * Per-kitchen bearer tokens for the webhook endpoints, stored only as their
 * SHA-256 hex digest.
 */
export const kitchenWebhookTokens = pgTable(
  "kitchen_webhook_tokens",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    kitchenId: uuid("kitchen_id")
      .notNull()
      .references(() => kitchens.id, { onDelete: "restrict" }),
    tokenSha256: text("token_sha256").notNull().unique(),
    label: text("label").notNull(),
    createdAt: timestamp("created_at", { withTimezone: true })
      .defaultNow()
      .notNull(),
    lastUsedAt: timestamp("last_used_at", { withTimezone: true }),
    revokedAt: timestamp("revoked_at", { withTimezone: true }),
  },
  (t) => [
    check(
      "kitchen_webhook_tokens_sha256_shape",
      sql`${t.tokenSha256} ~ '^[0-9a-f]{64}$'`,
    ),
    index("kitchen_webhook_tokens_kitchen_idx").on(t.kitchenId),
  ],
).enableRLS();

/** Role a signed-in person holds inside their kitchen. */
export type MemberRole = "owner" | "cook";

/**
 * A signed-in person belonging to one kitchen (`user_id` is unique so a person
 * belongs to at most one kitchen).
 */
export const members = pgTable(
  "members",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    kitchenId: uuid("kitchen_id")
      .notNull()
      .references(() => kitchens.id, { onDelete: "restrict" }),
    userId: text("user_id")
      .notNull()
      .unique()
      .references(() => authUser.id, { onDelete: "cascade" }),
    role: text("role").$type<MemberRole>().notNull(),
    createdAt: timestamp("created_at", { withTimezone: true })
      .defaultNow()
      .notNull(),
  },
  (t) => [
    check("members_role_known", sql`${t.role} in ('owner', 'cook')`),
    index("members_kitchen_idx").on(t.kitchenId),
  ],
).enableRLS();

/**
 * Invite list managed by the operator script. An invite is pending when both
 * `revoked_at` and `accepted_at` are null, accepted when `accepted_at` is set
 * and `revoked_at` is null, and revoked when `revoked_at` is set.
 */
export const invites = pgTable(
  "invites",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    email: text("email").notNull(),
    kitchenId: uuid("kitchen_id").references(() => kitchens.id, {
      onDelete: "restrict",
    }),
    newKitchenName: text("new_kitchen_name"),
    newKitchenSlug: text("new_kitchen_slug"),
    role: text("role").$type<MemberRole>().notNull(),
    invitedAt: timestamp("invited_at", { withTimezone: true })
      .defaultNow()
      .notNull(),
    acceptedAt: timestamp("accepted_at", { withTimezone: true }),
    acceptedUserId: text("accepted_user_id").references(() => authUser.id, {
      onDelete: "set null",
    }),
    revokedAt: timestamp("revoked_at", { withTimezone: true }),
  },
  (t) => [
    check(
      "invites_email_normalized",
      sql`${t.email} = lower(btrim(${t.email})) and position('@' in ${t.email}) > 1`,
    ),
    check(
      "invites_new_kitchen_name_length",
      sql`length(${t.newKitchenName}) between 1 and 80`,
    ),
    check(
      "invites_new_kitchen_slug_shape",
      sql`${t.newKitchenSlug} ~ '^[a-z0-9]+(-[a-z0-9]+)*$' and length(${t.newKitchenSlug}) <= 40`,
    ),
    check("invites_role_known", sql`${t.role} in ('owner', 'cook')`),
    check(
      "invites_target_one",
      sql`(${t.kitchenId} is null) <> (${t.newKitchenName} is null)`,
    ),
    check(
      "invites_new_kitchen_pair",
      sql`(${t.newKitchenName} is null) = (${t.newKitchenSlug} is null)`,
    ),
    check(
      "invites_new_kitchen_owner",
      sql`${t.newKitchenName} is null or ${t.role} = 'owner'`,
    ),
    uniqueIndex("invites_live_email_unique")
      .on(t.email)
      .where(sql`${t.revokedAt} is null`),
    uniqueIndex("invites_pending_slug_unique")
      .on(t.newKitchenSlug)
      .where(sql`${t.revokedAt} is null and ${t.acceptedAt} is null`),
  ],
).enableRLS();

// AI conversation logs - for debugging and learning
export const conversationLogs = pgTable(
  "conversation_logs",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    kitchenId: uuid("kitchen_id")
      .notNull()
      .references(() => kitchens.id, {
        onDelete: "restrict",
      }),
    memberId: uuid("member_id").references(() => members.id, {
      onDelete: "set null",
    }),
    sessionId: text("session_id").notNull(),
    role: text("role").notNull(), // 'user' | 'assistant' | 'system'
    content: text("content").notNull(),
    context: jsonb("context"), // Notion data snapshot used in this message
    createdAt: timestamp("created_at").defaultNow().notNull(),
  },
  (t) => [
    index("conversation_logs_kitchen_session_idx").on(t.kitchenId, t.sessionId),
  ],
).enableRLS();

// =============================================================================
// Chat Persistence (F1)
// =============================================================================

/**
 * Extracted recipe ingredient type
 */
export type ChatRecipeIngredient = {
  item: string;
  amount?: string;
  unit?: string;
};

// =============================================================================
// Kitchen Queue (F2)
// =============================================================================

/**
 * Queue status for kitchen recipes
 */
export type KitchenQueueStatus =
  | "pending"
  | "cooking"
  | "completed"
  | "cancelled";

/**
 * How a cook's latest finish came about (cook-fidelity plan, decision 7):
 * "pressed", the cook's own Done (or Mark as done on the queue screen), or
 * "auto", finished by the app once the cook sat on its last screen with
 * nothing moving (`src/lib/kitchen-auto-finish.ts`): "finished (not pressed)".
 */
export type FinishedBy = "pressed" | "auto";

/**
 * Recipe data stored in the queue (for recipes without Notion IDs)
 */
export type KitchenQueueRecipeData = {
  name: string;
  ingredients?: ChatRecipeIngredient[];
  steps?: string[];
  estimatedTime?: {
    active?: number;
    passive?: number;
    total?: number;
  };
  serves?: number;
  tags?: string[];
  notes?: string;
  /**
   * Per-step ingredient indices, parallel to `steps`: each entry holds the
   * 0-based indices into `ingredients` used by that step. Assigned by the
   * import LLM. Legacy rows are `undefined` and fall back to fuzzy matching.
   */
  stepIngredients?: number[][];
  source?: string; // URL or "pasted"
};

/**
 * The three checks on a table's serving estimate (slice B4b): the count is
 * positive, and the basis and the source hash are there exactly when the
 * count is. No check ties
 * the estimate to the stated count: rolled back, R19's sync would write a
 * newly stated count beside an old estimate, and the converter reads the
 * stated one first anyway.
 */
function servesEstimateChecks(
  table: string,
  t: {
    servesEstimate: AnyPgColumn;
    servesEstimateBasis: AnyPgColumn;
    servesEstimateSourceHash: AnyPgColumn;
  },
) {
  return [
    check(`${table}_serves_estimate_positive`, sql`${t.servesEstimate} > 0`),
    check(
      `${table}_serves_estimate_basis_paired`,
      sql`(${t.servesEstimate} is null) = (${t.servesEstimateBasis} is null)`,
    ),
    check(
      `${table}_serves_estimate_hash_paired`,
      sql`(${t.servesEstimate} is null) = (${t.servesEstimateSourceHash} is null)`,
    ),
  ];
}

/**
 * Kitchen queue - recipes sent from chat/other devices to kitchen
 */
export const kitchenQueue = pgTable("kitchen_queue", {
  id: uuid("id").primaryKey().defaultRandom(),
  kitchenId: uuid("kitchen_id")
    .notNull()
    .references(() => kitchens.id, {
      onDelete: "restrict",
    }),
  recipeNotionId: text("recipe_notion_id"), // Reference to Notion recipe (optional)
  recipeData: jsonb("recipe_data").$type<KitchenQueueRecipeData>(), // Full recipe data if no Notion ID
  targetUser: text("target_user"), // deprecated cook slug; kept nullable until a later cleanup migration drops it
  status: text("status")
    .$type<KitchenQueueStatus>()
    .notNull()
    .default("pending"),
  createdAt: timestamp("created_at").defaultNow().notNull(),
  /**
   * The derived cook plan (`src/lib/kitchen/cook-plan.ts`), written once by
   * `deriveAndStoreCookPlan` and never over a current one. Null until derived;
   * a plan from an older `COOK_PLAN_VERSION` counts as absent.
   */
  cookPlan: jsonb("cook_plan").$type<CookPlan>(),
  /** Why the latest derivation failed; cleared when a plan is stored. */
  cookPlanError: text("cook_plan_error"),
  /** Set on the transition into "cooking"; a resume leaves it alone. */
  startedAt: timestamp("started_at", { withTimezone: true }),
  /** Set on the transition into "completed"; a second Done leaves it alone. */
  completedAt: timestamp("completed_at", { withTimezone: true }),
  /**
   * The Cook Log row this cook is in (`src/lib/kitchen-cook-log.ts`): written
   * after Done, or adopted when another writer had already logged it that day.
   */
  cookLog: jsonb("cook_log").$type<CookLogRef>(),
  /** Why the latest Cook Log write failed; cleared when a row is stored. */
  cookLogError: text("cook_log_error"),
  /**
   * When a Cook Log write took this item, so no second one starts while it
   * runs. Cleared with the outcome; one older than `LOST_WRITE_MS` was lost.
   */
  cookLogClaimedAt: timestamp("cook_log_claimed_at", { withTimezone: true }),
  /** When the app's "How was it?" closed: rated, or dismissed. */
  ratingClosedAt: timestamp("rating_closed_at", { withTimezone: true }),
  /**
   * Sous's estimate of how many the recipe serves, when the source states no
   * count (slice B4b; format v0.5 `serves_estimated`). Kept beside the
   * source, never written into it, so a stated count can't be overwritten; the
   * converter reads a stated count first. The basis is the estimator's one line
   * on what the count rests on, for review, never shown to the cook. The source
   * hash names the text the estimate was made from (`sourceHash`,
   * src/lib/serves-estimate-plan.ts), so an estimate is reused only for that
   * text. Null together. Prod gets them from
   * scripts/add-serves-estimate-columns.ts.
   */
  servesEstimate: integer("serves_estimate"),
  servesEstimateBasis: text("serves_estimate_basis"),
  servesEstimateSourceHash: text("serves_estimate_source_hash"),
  /**
   * The intake pass (cook-fidelity plan, `src/lib/pack-convert/intake.ts`):
   * an agent recipe re-cut by the import rules before the cook meets it. The
   * source hash is set at insert when intake is asked for (`sourceHash` of
   * `recipe_data`, which stays as sent), and names the recipe the cut was
   * made from; a row without it never gets intake. Then exactly one outcome,
   * written once with its stamp (`intakeStamp()`): the cut recipe, or why
   * there isn't one, which shows the recipe as sent. An error for now (a
   * timeout, a provider's 5xx) is the one outcome written over, by a later
   * try: `intakeAttempts` counts the runs that wrote, and the third error for
   * now is settled (`INTAKE_MAX_TRIES`). `intakeNudges` lists, with a kept
   * cut, the soft rules it still trips (`rule: detail`), for the reports and
   * the eval to count. Prod gets them from scripts/add-intake-columns.ts.
   */
  intakeRecipe: jsonb("intake_recipe").$type<KitchenQueueRecipeData>(),
  intakeError: text("intake_error"),
  intakeSourceHash: text("intake_source_hash"),
  intakeStamp: text("intake_stamp"),
  intakeAttempts: integer("intake_attempts"),
  intakeNudges: jsonb("intake_nudges").$type<string[]>(),
  /**
   * How the latest finish came about (`FinishedBy`); null before the column
   * existed and on a cook that hasn't finished. A cook reopened after an
   * auto-finish keeps "auto" while it cooks again: that tells its next finish
   * to update the Cook Log row it already has, not log a new cook. A fresh
   * start clears it. Prod gets it from scripts/add-auto-finish-columns.ts.
   */
  finishedBy: text("finished_by").$type<FinishedBy>(),
  /**
   * While the cook sits on its last screen, its last sign of life as the
   * tablet reported it: the latest touch or voice command, or the end of a
   * timer it is still running, whichever is later (so it can be in the
   * future while a timer runs). Null anywhere else. The app finishes a cook
   * whose last-screen activity is `AUTO_FINISH_IDLE_MS` old, dated to this
   * time, and a cook's next start finishes one that is past it. Prod gets it
   * from scripts/add-auto-finish-columns.ts.
   */
  lastScreenActiveAt: timestamp("last_screen_active_at", { withTimezone: true }),
  /**
   * When the cook last touched, keyed or spoke to a page of this cook, as
   * the report that set `last_screen_active_at` dated it (on or off the last
   * screen). A report of an older interaction is ignored, so a late report
   * from an idle screen never overwrites a newer one from another. A fresh
   * start clears it. Prod gets it from scripts/add-auto-finish-columns.ts.
   */
  lastInteractionAt: timestamp("last_interaction_at", { withTimezone: true }),
}, (t) => [
  ...servesEstimateChecks("kitchen_queue", t),
  check(
    "kitchen_queue_intake_recipe_or_error",
    sql`${t.intakeRecipe} is null or ${t.intakeError} is null`,
  ),
  check(
    "kitchen_queue_finished_by_known",
    sql`${t.finishedBy} in ('pressed', 'auto')`,
  ),
  index("kitchen_queue_kitchen_status_idx").on(
    t.kitchenId,
    t.status,
    t.createdAt,
  ),
]).enableRLS();

/** A queue item's row in the Cook Log, as last written or re-found. */
export type CookLogRef = {
  /** The row's number, from 1 (`CookLogGrid`, `src/lib/hooks/types.ts`). */
  row: number;
  /** The timestamp column as written: "YYYY-MM-DD HH:MM" in the kitchen's zone. */
  timestamp: string;
  /** The recipe-name column as written. */
  recipeName: string;
  /** True when the row was another writer's (or an earlier write's), not appended. */
  adopted: boolean;
};

// =============================================================================
// Recipe Library (the household's own recipes, read through the recipe-library hook)
// =============================================================================

/**
 * Recipes parsed from the household's recipe library.
 *
 * Identity is the stable `docSlug` (kebab-case of the heading name) so a
 * re-sync upserts in place rather than creating duplicates. A heading rename
 * changes the slug and yields a new row — the documented identity-drift
 * tradeoff (a periodic name-dedupe handles it; in-progress cooks are safe
 * because the kitchen queue snapshots full recipe data).
 *
 * Chunks whose LLM extraction fails keep their `rawDocText` plus an
 * `extractionError` so the failure is visible and fixable — never silently
 * dropped. Rows with a non-null `extractionError` are excluded from the
 * browsable library.
 */
export const docRecipes = pgTable("doc_recipes", {
  id: uuid("id").primaryKey().defaultRandom(),
  kitchenId: uuid("kitchen_id")
    .notNull()
    .references(() => kitchens.id, {
      onDelete: "restrict",
    }),
  docSlug: text("doc_slug").notNull(),
  name: text("name").notNull(),
  category: text("category"), // cuisine divider it fell under, e.g. "indian"
  ingredients: jsonb("ingredients").$type<ChatRecipeIngredient[]>(),
  steps: jsonb("steps").$type<string[]>(),
  estimatedTime: jsonb("estimated_time").$type<{
    active?: number;
    passive?: number;
    total?: number;
  }>(),
  serves: integer("serves"),
  tags: jsonb("tags").$type<string[]>(),
  notes: text("notes"),
  stepIngredients: jsonb("step_ingredients").$type<number[][]>(),
  rawDocText: text("raw_doc_text").notNull(),
  extractionError: text("extraction_error"),
  syncedAt: timestamp("synced_at").defaultNow().notNull(),
  /**
   * Sous's estimate of how many the recipe serves, when the source states no
   * count (slice B4b; format v0.5 `serves_estimated`). Kept beside the
   * source, never written into it, so a stated count can't be overwritten; the
   * converter reads a stated count first. The basis is the estimator's one line
   * on what the count rests on, for review, never shown to the cook. The source
   * hash names the text the estimate was made from (`sourceHash`,
   * src/lib/serves-estimate-plan.ts), so an estimate is reused only for that
   * text. Null together. Prod gets them from
   * scripts/add-serves-estimate-columns.ts.
   */
  servesEstimate: integer("serves_estimate"),
  servesEstimateBasis: text("serves_estimate_basis"),
  /**
   * Where the recipe stands in the Doc (slice S, S-D9): its index in the
   * sync's tab walk (`chunkRecipeTabs` order), and its nearest category
   * tab's title as the Doc writes it ("*" and extra whitespace stripped,
   * case kept; `category` stays the lowercase key). A row the walk no longer
   * produces has no position and sorts last in its chapter. Nullable and
   * additive: prod gets them from scripts/add-doc-recipe-order.ts.
   */
  docPosition: integer("doc_position"),
  categoryTitle: text("category_title"),
  servesEstimateSourceHash: text("serves_estimate_source_hash"),
  /**
   * The recipe's cook plan, worked out at Refresh or by the backfill (slice
   * P), or why it couldn't be (`cook_plan_error`; a settled error is never
   * retried for the same text, `isSettledPlanError`). The source hash is
   * `planSourceHash` of the derive input the plan or error was made from,
   * and the stamp is `cookPlanStamp()` of what made it; both are set exactly
   * when a plan or an error is. A plan is copied into a queue row only after
   * `verifyStoredPlan` (hash, stamp, validation), so a stale plan beside new
   * steps (the release before P rewrites steps and leaves these alone) is
   * never trusted. The shelf's reads leave `cook_plan` out
   * (`readFamilyLibrary`). Prod gets them from
   * scripts/add-library-cook-plan-columns.ts.
   */
  cookPlan: jsonb("cook_plan").$type<CookPlan>(),
  cookPlanError: text("cook_plan_error"),
  cookPlanSourceHash: text("cook_plan_source_hash"),
  cookPlanStamp: text("cook_plan_stamp"),
}, (t) => [
  ...servesEstimateChecks("doc_recipes", t),
  check(
    "doc_recipes_cook_plan_or_error",
    sql`${t.cookPlan} is null or ${t.cookPlanError} is null`,
  ),
  unique("doc_recipes_kitchen_slug_unique").on(t.kitchenId, t.docSlug),
]).enableRLS();

/**
 * Single-row cache of the recipe-idea backlog doc, refreshed when read so the
 * ideas tab degrades to the last-known list if the doc fetch fails.
 */
export const recipeIdeasCache = pgTable(
  "recipe_ideas_cache",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    kitchenId: uuid("kitchen_id")
      .notNull()
      .references(() => kitchens.id, {
        onDelete: "restrict",
      }),
    text: text("text").notNull(),
    syncedAt: timestamp("synced_at").defaultNow().notNull(),
  },
  (t) => [unique("recipe_ideas_cache_kitchen_unique").on(t.kitchenId)],
).enableRLS();

// =============================================================================
// Cook reports (B2: the dogfood flag)
// =============================================================================

/**
 * One flagged moment of a cook, sent from the tablet's outbox
 * (`src/lib/kitchen/report-outbox.ts`). Written by `submitCookReport` and
 * `annotateCookReport` only; read with `scripts/list-reports.ts`, never over
 * tRPC. The id is the client's, so a resend conflicts instead of duplicating.
 * `queue_id` has no foreign key: queue rows get deleted, reports stay. The
 * DOM holds the screen as drawn, recipe text and an open Ask included.
 *
 * Row-level security is on with no policies (`enableRLS`, which `drizzle-kit
 * push` emits): Supabase's default grants would otherwise expose the table
 * to the Data API's `anon` role. The app connects as the owner, which RLS
 * doesn't bind. Prod gets the table from `scripts/add-cook-reports-table.ts`.
 */
export const cookReports = pgTable(
  "cook_reports",
  {
    id: uuid("id").primaryKey(),
    kitchenId: uuid("kitchen_id")
      .notNull()
      .references(() => kitchens.id, {
        onDelete: "restrict",
      }),
    memberId: uuid("member_id").references(() => members.id, {
      onDelete: "set null",
    }),
    createdAt: timestamp("created_at", { withTimezone: true })
      .defaultNow()
      .notNull(),
    capturedAt: timestamp("captured_at", { withTimezone: true }).notNull(),
    build: text("build").notNull(),
    path: text("path").notNull(),
    screen: text("screen").notNull(),
    queueId: uuid("queue_id"),
    recipeName: text("recipe_name").notNull(),
    stepKey: text("step_key"),
    chapterId: text("chapter_id"),
    planVersion: integer("plan_version"),
    plan: jsonb("plan"),
    // Typed as the server accepted them (`CookReportInputSchema`).
    state: jsonb("state").$type<CookReportInput["state"]>().notNull(),
    context: jsonb("context").$type<CookReportInput["context"]>().notNull(),
    events: jsonb("events").$type<CookReportInput["events"]>().notNull(),
    dom: text("dom").notNull(),
    domTruncated: boolean("dom_truncated").default(false).notNull(),
    note: text("note").default("").notNull(),
    noteAt: timestamp("note_at", { withTimezone: true }),
  },
  (t) => [
    index("cook_reports_created_at_idx").on(t.createdAt.desc()),
    index("cook_reports_kitchen_created_idx").on(t.kitchenId, t.createdAt),
  ],
).enableRLS();
