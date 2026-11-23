/**
 * Recipe library sync: the household's own recipes → doc_recipes cache.
 *
 * The recipes are read through the recipe-library hook (`lib/hooks/types.ts`,
 * `RecipeLibrarySource`), which gives the collection as a tree of tabs. The
 * library was first a document organised in tabs, and the names here keep
 * that word ("the Doc", `docSlug`); a tab is whatever the source nests.
 *
 * The tabs are nested to any depth:
 *   - Top-level tabs are categories (entrees, drinks, desserts, tried &
 *     liked, ...). A top-level tab's own text is an intro note.
 *   - Below the top level, a tab with child tabs is a sub-category (entrees >
 *     indian) and a tab with none is one recipe: its title names it, its body
 *     (headings, ingredient and step lines) is the recipe.
 * A recipe's category is its nearest category tab, so mains > soups >
 * lentil soup files under "soups". A cook may move tabs between
 * categories (for instance out of "quick & easy" into its cuisine); a re-sync that extracts the tab updates the category in
 * place, as does one that keeps the saved recipe. A failed extraction or a
 * skipped tab leaves the row, category included, as it was.
 *
 * Each recipe tab is run through the existing LLM extractor
 * (extractRecipeFromText), which sidesteps the long-input truncation seen
 * when the whole doc is sent at once. Identity is the kebab-case `docSlug` of
 * the tab title, so re-syncs upsert in place. Recipes whose extraction fails
 * keep their rawDocText plus an extractionError and are excluded from the
 * browsable library.
 *
 * A tab holding content that can't be synced is reported, never silently
 * dropped: a second tab with the same name, a title with nothing to slug, a
 * tab with only images, a tab that reads as a single line (too little to be
 * a recipe, so it is turned away before it costs an extraction; a recipe laid
 * out as one table row reads this way too), a top-level tab with no tabs
 * inside it (an emptied category, or a recipe put at the top level), and
 * content beside sub-tabs below the top level (a recipe that grew a sub-tab).
 * An empty tab is not a recipe yet and is passed over. A longer tab that
 * still holds no recipe (a rating and a link) reaches the extractor, which is
 * told to return nothing rather than invent one, and fails as having no
 * recipe. A tab of ingredients alone syncs as ingredients with no steps: a
 * method the model writes anyway is left out (groundRecipe), and the recipe
 * is named in the result's notices, as is one whose made-up notes were left
 * out. An extraction of a tab that hasn't changed since its saved recipe was
 * extracted never replaces that recipe with one lacking a part the tab
 * clearly gives (partsLost); the saved recipe is kept and the tab reported
 * as a failure instead. Any edit to the tab lets the next extraction
 * replace it.
 *
 * Serving counts (slice B4b): an extraction that states no count gets Sous's
 * estimate (`estimateServes`), stored beside the recipe
 * (`serves_estimate`, `serves_estimate_basis`, and the hash of the tab text
 * it was made from, `serves_estimate_source_hash`), never in `serves`. A tab
 * whose text hashes to its saved estimate's source keeps it with no call, so
 * a re-sync doesn't re-roll a count the cook has seen, and an estimate never
 * outlives the text it was made for (an older app's sync may have rewritten
 * the text beside it); an extraction that
 * states a count writes it and clears the estimate. An estimate that can't
 * be made fails that recipe's sync like a failed extraction: a saved recipe
 * is kept whole, a new one is stored as a failure and retried next sync.
 *
 * Known gaps, read but not reported: an image beside a recipe's text is
 * ignored (the text syncs; `nonText` marks it for the dry run), a date chip
 * reads as nothing, footnotes are not read, and a tab whose only content is
 * an unaccepted suggestion reads as empty.
 */

import {
  and,
  asc,
  eq,
  getTableColumns,
  isNotNull,
  isNull,
  notInArray,
  sql,
} from "drizzle-orm";
import { db, docRecipes } from "./db";
import {
  NO_PLAN,
  libraryRecipeLockKey,
  planBudget,
  planForChunk,
  readSavedPlan,
  type ChunkPlan,
  type LibraryPlanColumns,
  type PlanBudget,
} from "./library-cook-plans";
import { isSettledPlanError } from "./kitchen/cook-plan-stamp";
import { hook } from "./hooks/registry";
import type { LibraryTab } from "./hooks/types";
import {
  extractRecipeFromText,
  type ExtractionNotice,
  type ImportedRecipe,
} from "./recipe-import";
import { partsLost, type RecipePart } from "./recipe-grounding";
import { legacyToPackRecipe } from "./pack-convert/convert";
import { estimateServes, type ServesEstimate } from "./serves-estimate";
import { sourceHash } from "./serves-estimate-plan";
import type { KitchenQueueRecipeData } from "../../drizzle/schema";

// =============================================================================
// Chunking
// =============================================================================

/**
 * Normalizes a tab title for use as a category: lowercase, strip trailing "*"
 * markers used as needs-work flags, and collapse internal
 * whitespace.
 */
export function normalizeHeading(heading: string): string {
  return heading.replace(/\*+$/, "").replace(/\s+/g, " ").trim().toLowerCase();
}

/**
 * A category tab's title as written in the library, for display (slice S, S-D9):
 * trailing "*" needs-work markers and extra whitespace are stripped while case stays
 * ("quick & easy" stays lowercase if written that way).
 */
export function categoryTitle(heading: string): string {
  return heading.replace(/\*+\s*$/, "").replace(/\s+/g, " ").trim();
}

/** Drops a trailing "*" needs-work marker for display purposes. */
function cleanDisplayName(rawHeading: string): string {
  return rawHeading.replace(/\s*\*+\s*$/, "").trim();
}

/** Latin letters that don't decompose into a base letter plus an accent. */
const LATIN_LETTERS: Record<string, string> = {
  æ: "ae",
  œ: "oe",
  ø: "o",
  ł: "l",
  đ: "d",
  ð: "d",
  þ: "th",
  ß: "ss",
  ı: "i",
};

/**
 * kebab-case slug used as the stable recipe identity across re-syncs. Accents
 * are folded first, so "Crème brûlée" and "creme brulee" share a slug, and
 * letters like æ and ł are spelled out; a name with no Latin letters or
 * digits slugs to "".
 */
export function slugify(name: string): string {
  return name
    .normalize("NFKD")
    .replace(/\p{M}+/gu, "")
    .toLowerCase()
    .replace(/[æœøłđðþßı]/g, (letter) => LATIN_LETTERS[letter])
    .replace(/['’]/g, "")
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-+|-+$/g, "");
}

export interface RecipeChunk {
  /** Stable identity: kebab-case of the recipe name. */
  docSlug: string;
  /** Display name: the tab title, "*" stripped. */
  name: string;
  /** Nearest category tab, normalized; null only if every one is untitled. */
  category: string | null;
  /** The same tab's title as the Doc writes it (`categoryTitle`), or null with `category`. */
  categoryTitle: string | null;
  /** The recipe's index among the walk's recipes: its place in the Doc. */
  position: number;
  /** Tab title + body lines, fed to the extractor and kept for recovery. */
  rawText: string;
  /** The tab also holds images or other content the extractor can't read. */
  nonText: boolean;
}

/** A tab with recipe content that could not be synced, and why. */
export interface SkippedTab {
  name: string;
  error: string;
  /**
   * The slug the tab's title gives, when it gives one. A recipe row under
   * this slug is still in the doc, so it isn't reported as stale.
   */
  docSlug?: string;
}

/**
 * Walks the tab tree depth-first in doc order. Tabs with children are
 * categories; leaf tabs below the top level are recipes. The first tab to
 * claim a slug keeps it and later ones are reported in `skipped`, alongside
 * every other tab whose content can't be synced (see the module header).
 */
export function chunkRecipeTabs(tabs: LibraryTab[]): {
  chunks: RecipeChunk[];
  skipped: SkippedTab[];
} {
  const chunks: RecipeChunk[] = [];
  const skipped: SkippedTab[] = [];
  const seen = new Set<string>();

  function walk(
    level: LibraryTab[],
    category: { key: string; title: string } | null,
    topLevel: boolean,
  ): void {
    for (const tab of level) {
      const title = tab.title.trim();
      const name = cleanDisplayName(title);
      const label = name || title || "(untitled tab)";
      const docSlug = slugify(name);
      const skip = (error: string): void => {
        skipped.push(
          docSlug === "" ? { name: label, error } : { name, error, docSlug },
        );
      };
      const { children, lines } = tab;
      const hasContent = lines.length > 0 || tab.nonText;

      if (children.length > 0) {
        if (!topLevel && hasContent) {
          skip(
            "This tab has its own content and sub-tabs; only the sub-tabs " +
              "are synced. Move its content into a sub-tab of its own.",
          );
        }
        const key = normalizeHeading(title);
        walk(children, key ? { key, title: categoryTitle(title) } : category, false);
        continue;
      }

      if (!hasContent) continue;
      if (topLevel) {
        skip(
          "A top-level tab is a category, and this one has no recipe tabs " +
            "inside it.",
        );
        continue;
      }
      if (lines.length === 0) {
        skip(
          "The tab has no text to read, only images or other non-text " +
            "content.",
        );
        continue;
      }
      if (docSlug === "") {
        skip("The tab title has no Latin letters or digits to name it by.");
        continue;
      }
      if (seen.has(docSlug)) {
        skip(
          "Another tab has the same name (ignoring case, accents and " +
            "punctuation); only the first is synced.",
        );
        continue;
      }
      if (lines.length === 1) {
        skip(
          "The tab reads as a single line of text, too little for " +
            "ingredients and steps. Paste the recipe in, one ingredient " +
            "or step per line.",
        );
        continue;
      }
      seen.add(docSlug);

      chunks.push({
        docSlug,
        name,
        category: category?.key ?? null,
        categoryTitle: category?.title ?? null,
        position: chunks.length,
        rawText: [title, ...lines].join("\n"),
        nonText: tab.nonText,
      });
    }
  }

  walk(tabs, null, true);
  return { chunks, skipped };
}

// =============================================================================
// Sync
// =============================================================================

const EXTRACTION_CONCURRENCY = 4;

/** A recipe, or the reason there is none. */
type ExtractionOutcome = { chunk: RecipeChunk; notices: ExtractionNotice[] } & (
  { recipe: ImportedRecipe; error: null } | { recipe: null; error: string }
);

/** Runs `fn` over `items` with at most `limit` in flight, preserving order. */
async function mapWithConcurrency<T, R>(
  items: T[],
  limit: number,
  fn: (item: T) => Promise<R>,
): Promise<R[]> {
  const results: R[] = new Array(items.length);
  let cursor = 0;
  async function worker(): Promise<void> {
    while (cursor < items.length) {
      const index = cursor++;
      results[index] = await fn(items[index]);
    }
  }
  const workers = Array.from({ length: Math.min(limit, items.length) }, worker);
  await Promise.all(workers);
  return results;
}

async function extractChunk(chunk: RecipeChunk): Promise<ExtractionOutcome> {
  try {
    const extraction = await extractRecipeFromText(chunk.rawText);
    if (extraction === null) {
      return {
        chunk,
        recipe: null,
        notices: [],
        error: "No recipe content could be extracted from this section.",
      };
    }
    return { chunk, ...extraction, error: null };
  } catch (error) {
    return {
      chunk,
      recipe: null,
      notices: [],
      error: error instanceof Error ? error.message : String(error),
    };
  }
}

export interface SyncRecipesResult {
  total: number;
  succeeded: number;
  failed: number;
  failures: Array<{ name: string; error: string }>;
  /** Synced recipes with a part left out because the doc doesn't give it. */
  notices: Array<{ name: string } & ExtractionNotice>;
  /** Library recipes whose tab is gone from the doc (renamed or deleted). */
  stale: string[];
  /** The cook plans saved with this sync's recipes (slice P). */
  plans: SyncPlans;
}

/**
 * What a sync did about cook plans, over the recipes it saved:
 * - `derived`: plans worked out by this sync;
 * - `reused`: plans and settled errors kept because the recipe's derive
 *   input and the prompt are unchanged (no call);
 * - `pending`: recipes saved with no plan because the time budget ran out;
 * - `failed`: recipes saved with an error instead of a plan, derived now or
 *   kept; a settled one needs a Doc edit, a transient one is retried by the
 *   next Refresh.
 */
export interface SyncPlans {
  derived: number;
  reused: number;
  pending: number;
  failed: Array<{ name: string; error: string; settled: boolean }>;
}

export interface SyncRecipesOptions {
  /** When to stop starting plan derivations; defaults to the Refresh budget from the call. */
  planBudget?: PlanBudget;
}

function keptMessage(lost: RecipePart[]): string {
  const parts =
    lost.length === 1
      ? lost[0]
      : `${lost.slice(0, -1).join(", ")} and ${lost[lost.length - 1]}`;
  return (
    `This sync's extraction came back without its ${parts}, though the tab ` +
    "is unchanged and still gives them, so the saved recipe was kept."
  );
}

/** What a sync stores beside a recipe for its serving count. */
type ChunkServes =
  | { ok: true; servesEstimate: ServesEstimate | null }
  | { ok: false; reason: string };

/** The library row's stored estimate and the hash of the text it was made from, if any. */
async function savedEstimate(kitchenId: string, docSlug: string) {
  const [row] = await db
    .select({
      servesEstimate: docRecipes.servesEstimate,
      servesEstimateBasis: docRecipes.servesEstimateBasis,
      servesEstimateSourceHash: docRecipes.servesEstimateSourceHash,
    })
    .from(docRecipes)
    .where(
      and(
        eq(docRecipes.kitchenId, kitchenId),
        eq(docRecipes.docSlug, docSlug),
        isNull(docRecipes.extractionError),
      ),
    );
  return row;
}

/**
 * The serving estimate to store with an extraction: none when it states a
 * count; the saved one when the tab is unchanged since it was made; else one
 * estimator call over the tab's text.
 */
async function servesForChunk(
  kitchenId: string,
  chunk: RecipeChunk,
  recipe: ImportedRecipe,
): Promise<ChunkServes> {
  if (recipe.serves != null) return { ok: true, servesEstimate: null };
  const saved = await savedEstimate(kitchenId, chunk.docSlug);
  if (
    saved !== undefined &&
    saved.servesEstimateSourceHash === sourceHash("doc_recipes", chunk.rawText) &&
    saved.servesEstimate != null &&
    saved.servesEstimateBasis != null
  ) {
    return { ok: true, servesEstimate: { count: saved.servesEstimate, basis: saved.servesEstimateBasis } };
  }
  // The lines' readings, with a placeholder count: whether any gives an amount.
  const { report } = legacyToPackRecipe(
    { ...recipe, name: chunk.name },
    { id: chunk.docSlug, servesEstimate: { count: 1, basis: "probe" } },
  );
  const result = await estimateServes({
    name: chunk.name,
    ingredients: recipe.ingredients ?? [],
    steps: recipe.steps ?? [],
    sourceText: chunk.rawText,
    category: chunk.category,
    hasAmounts: report.hasAmounts,
  });
  return result.ok
    ? { ok: true, servesEstimate: result.estimate }
    : { ok: false, reason: result.reason };
}

/**
 * Writes one extraction to doc_recipes, returning an error message if the
 * write fails rather than throwing, so one bad row can't cost the rest of the
 * run.
 *
 * A failed extraction never overwrites a row that extracted before: that
 * recipe stays in the library as it was, and only a row that has never
 * extracted takes the new raw text and error. A successful extraction
 * replaces the saved recipe unless the tab is unchanged since the saved
 * recipe was extracted from it and the new extraction comes back without a
 * part the saved recipe has and the tab clearly gives; then the saved
 * recipe is kept, filed under the tab's current category, and the tab is
 * reported as a failure. An edited tab is always taken as the new
 * extraction reads it, since word overlap can't tell a part the family took
 * out from one the model dropped.
 * The saved recipe is read and replaced in one transaction holding a lock on
 * its slug, so two syncs running at once can't both check it and then both
 * write. The lock is a Postgres advisory lock rather than a row lock, which
 * would leave a recipe's first write, with no row yet to lock, unguarded.
 *
 * The cook plan (slice P) is written in the same upsert as the steps it was
 * made for, so a plan never sits beside other steps: a replaced recipe takes
 * `plan` (its new plan, its error, or none, clearing the old one), a kept
 * recipe keeps its saved plan with its saved steps, and a failed extraction
 * writes none (and, like the rest, only over a row that never extracted).
 */
async function saveRecipe(
  kitchenId: string,
  { chunk, recipe, error }: ExtractionOutcome,
  servesEstimate: ServesEstimate | null = null,
  plan: LibraryPlanColumns = NO_PLAN,
): Promise<string | null> {
  const values = {
    kitchenId,
    docSlug: chunk.docSlug,
    name: chunk.name,
    category: chunk.category,
    categoryTitle: chunk.categoryTitle,
    docPosition: chunk.position,
    ingredients: recipe?.ingredients ?? null,
    steps: recipe?.steps ?? null,
    estimatedTime: recipe?.estimatedTime ?? null,
    serves: recipe?.serves ?? null,
    tags: recipe?.tags ?? null,
    notes: recipe?.notes ?? null,
    stepIngredients: recipe?.stepIngredients ?? null,
    rawDocText: chunk.rawText,
    extractionError: error,
    syncedAt: new Date(),
    servesEstimate: servesEstimate?.count ?? null,
    servesEstimateBasis: servesEstimate?.basis ?? null,
    servesEstimateSourceHash: servesEstimate ? sourceHash("doc_recipes", chunk.rawText) : null,
    ...(recipe === null ? NO_PLAN : plan),
  };
  const { kitchenId: _kitchenId, docSlug: _docSlug, ...set } = values;

  try {
    if (recipe === null) {
      await db
        .insert(docRecipes)
        .values(values)
        .onConflictDoUpdate({
          target: [docRecipes.kitchenId, docRecipes.docSlug],
          set,
          setWhere: isNotNull(docRecipes.extractionError),
        });
      return null;
    }
    return await db.transaction(async (tx) => {
      await tx.execute(
        sql`select pg_advisory_xact_lock(hashtext(${libraryRecipeLockKey(kitchenId, chunk.docSlug)}))`,
      );
      const [saved] = await tx
        .select({
          name: docRecipes.name,
          ingredients: docRecipes.ingredients,
          steps: docRecipes.steps,
          notes: docRecipes.notes,
          rawDocText: docRecipes.rawDocText,
        })
        .from(docRecipes)
        .where(
          and(
            eq(docRecipes.kitchenId, kitchenId),
            eq(docRecipes.docSlug, chunk.docSlug),
            isNull(docRecipes.extractionError),
          ),
        );
      if (saved?.rawDocText === chunk.rawText) {
        const lost = partsLost(
          {
            name: saved.name,
            ingredients: saved.ingredients ?? undefined,
            steps: saved.steps ?? undefined,
            notes: saved.notes ?? undefined,
          },
          recipe,
          chunk.rawText,
        );
        if (lost.length > 0) {
          // The tab may have moved to another category without its text
          // changing, so the kept recipe still takes the tab's category.
          await tx
            .update(docRecipes)
            .set({ category: chunk.category, categoryTitle: chunk.categoryTitle, docPosition: chunk.position })
            .where(and(eq(docRecipes.kitchenId, kitchenId), eq(docRecipes.docSlug, chunk.docSlug)));
          return keptMessage(lost);
        }
      }
      await tx
        .insert(docRecipes)
        .values(values)
        .onConflictDoUpdate({
          target: [docRecipes.kitchenId, docRecipes.docSlug],
          set,
        });
      return null;
    });
  } catch (saveError) {
    const message =
      saveError instanceof Error ? saveError.message : String(saveError);
    return `Couldn't save: ${message}`;
  }
}

/**
 * Names of library recipes (rows that extracted) whose slug is not in
 * `keepSlugs`: their tab was renamed or deleted since they synced.
 */
export async function findStaleRecipes(
  kitchenId: string,
  keepSlugs: string[],
): Promise<string[]> {
  const rows = await db
    .select({ name: docRecipes.name })
    .from(docRecipes)
    .where(
      and(
        eq(docRecipes.kitchenId, kitchenId),
        isNull(docRecipes.extractionError),
        notInArray(docRecipes.docSlug, keepSlugs),
      ),
    )
    .orderBy(asc(docRecipes.name));
  return rows.map((r) => r.name);
}

/**
 * Every slug the doc still gives: its recipes, and its skipped tabs whose
 * title slugs. A row under one of these is not stale, even if this sync
 * couldn't refresh it.
 */
export function slugsInDoc(
  chunks: RecipeChunk[],
  skipped: SkippedTab[],
): string[] {
  const slugs = [
    ...chunks.map((c) => c.docSlug),
    ...skipped.flatMap((s) => (s.docSlug === undefined ? [] : [s.docSlug])),
  ];
  return [...new Set(slugs)];
}

/**
 * Writes the Doc's order onto the library (slice S, S-D9), in one statement,
 * before any paid extraction, so a sync that stops short still has it: every
 * row the walk produces takes its position and its category tab's title, and
 * a row it no longer produces (stale, renamed, deleted, or now a skipped tab)
 * loses its position and keeps its last title, so it sorts last in its
 * chapter. Rows the walk produces that have never been saved are written
 * with their order by the save itself.
 */
export async function writeDocOrder(
  kitchenId: string,
  chunks: readonly RecipeChunk[],
): Promise<void> {
  const walk =
    chunks.length === 0
      ? sql`select null::text as slug, null::integer as pos, null::text as title where false`
      : sql`values ${sql.join(
          chunks.map((c) => sql`(${c.docSlug}::text, ${c.position}::integer, ${c.categoryTitle}::text)`),
          sql`, `,
        )}`;
  await db.execute(sql`
    update doc_recipes set
      doc_position = w.pos,
      category_title = case when w.slug is null then doc_recipes.category_title else w.title end
    from doc_recipes r
    left join (${walk}) as w(slug, pos, title)
      on w.slug = r.doc_slug and r.kitchen_id = ${kitchenId}
    where doc_recipes.id = r.id
      and doc_recipes.kitchen_id = ${kitchenId}
      and r.kitchen_id = ${kitchenId}
      and (w.slug is not null or doc_recipes.doc_position is not null)`);
}

/**
 * Reads the recipe library's tabs, chunks them, extracts every recipe, and
 * upserts each into doc_recipes on (kitchenId, docSlug). Extractions run with
 * bounded concurrency and each recipe is written as soon as it extracts, so a
 * run cut short (a timeout, a crash) keeps what it finished. Skipped tabs count
 * toward `total` and are listed first in `failures`, then failed extractions
 * and writes in doc order.
 *
 * Throws when the library can't be read, and when no tab holds a recipe:
 * the library has changed shape, and a 0/0 result would hide that.
 *
 * This never deletes. Identity is the title slug, so renaming or deleting a
 * tab leaves its old row in the library; those come back in `stale` so the
 * drift is visible rather than silent.
 *
 * Each recipe's cook plan (slice P) is settled after its serving count and
 * before its save: kept when the extraction's derive input and the prompt
 * are unchanged, else derived once, until the time budget is spent; rows
 * after that save with no plan and count as `pending` (Refresh again).
 */
export async function syncRecipesFromDoc(
  kitchenId: string,
  options: SyncRecipesOptions = {},
): Promise<SyncRecipesResult> {
  const budget = options.planBudget ?? planBudget();
  // Named, so the screen can tell a library out of reach (nothing written
  // yet) from a Refresh that stopped partway (`refreshFailureCause`).
  let tabs: LibraryTab[];
  try {
    tabs = await hook("recipe-library").readTabs();
  } catch (error) {
    throw new Error(
      `Couldn't read the recipe library: ${error instanceof Error ? error.message : String(error)}`,
      { cause: error },
    );
  }
  const { chunks, skipped } = chunkRecipeTabs(tabs);
  if (chunks.length === 0) {
    throw new Error(
      "No recipes found in the recipe library. Each recipe should be its own " +
        "tab, inside a category tab.",
    );
  }

  // The Doc's order first: free, and kept even if the run is cut short.
  await writeDocOrder(kitchenId, chunks);

  const outcomes = await mapWithConcurrency(
    chunks,
    EXTRACTION_CONCURRENCY,
    async (chunk) => {
      const extraction = await extractChunk(chunk);
      if (extraction.recipe === null) {
        const saveError = await saveRecipe(kitchenId, extraction);
        return { name: chunk.name, error: extraction.error ?? saveError, notices: extraction.notices, plan: null };
      }
      const serves = await servesForChunk(kitchenId, chunk, extraction.recipe);
      if (!serves.ok) {
        // Saved as a failed extraction: a saved recipe is kept whole (the
        // upsert only overwrites a row that never extracted).
        const error = `Couldn't estimate a serving count: ${serves.reason}`;
        const saveError = await saveRecipe(kitchenId, { chunk, recipe: null, notices: [], error });
        return { name: chunk.name, error: saveError ?? error, notices: [], plan: null };
      }
      const plan = await planForChunk(
        kitchenId,
        chunk.docSlug,
        extraction.recipe,
        await readSavedPlan(kitchenId, chunk.docSlug),
        budget,
      );
      const saveError = await saveRecipe(kitchenId, extraction, serves.servesEstimate, plan.columns);
      // A kept recipe (or a failed write) didn't take this plan.
      return { name: chunk.name, error: saveError, notices: extraction.notices, plan: saveError === null ? plan : null };
    },
  );

  const failures: Array<{ name: string; error: string }> = [
    ...skipped.map(({ name, error }) => ({ name, error })),
  ];
  const notices: SyncRecipesResult["notices"] = [];
  for (const outcome of outcomes) {
    if (outcome.error !== null) {
      failures.push({ name: outcome.name, error: outcome.error });
      continue;
    }
    for (const notice of outcome.notices) {
      notices.push({ name: outcome.name, ...notice });
    }
  }

  const total = chunks.length + skipped.length;
  return {
    total,
    succeeded: total - failures.length,
    failed: failures.length,
    failures,
    notices,
    stale: await findStaleRecipes(kitchenId, slugsInDoc(chunks, skipped)),
    plans: tallyPlans(outcomes),
  };
}

/** The sync's plans, counted over the recipes saved with one. */
export function tallyPlans(
  outcomes: ReadonlyArray<{ name: string; plan: ChunkPlan | null }>,
): SyncPlans {
  const plans: SyncPlans = { derived: 0, reused: 0, pending: 0, failed: [] };
  for (const { name, plan } of outcomes) {
    if (plan === null || plan.outcome === "none") continue;
    if (plan.outcome === "pending") {
      plans.pending += 1;
      continue;
    }
    plans[plan.outcome] += 1;
    const error = plan.columns.cookPlanError;
    if (error !== null) plans.failed.push({ name, error, settled: isSettledPlanError(error) });
  }
  return plans;
}

// =============================================================================
// Read (browsable library)
// =============================================================================

export type DocRecipeRow = typeof docRecipes.$inferSelect;

/** A library row as the shelf reads it: everything but the cook plan itself. */
export type FamilyLibraryRow = Omit<DocRecipeRow, "cookPlan">;

/**
 * The family library as the shelf reads it (slice S, S-D8 and S-D9): every
 * row, failed extractions included, so a recipe that didn't come through is
 * named in its chapter rather than missing; in Doc order, rows with no
 * position (no longer in the walk) last, then by name. The cook plans (slice
 * P, about 300 KB over the library) stay behind: a send reads its one row's
 * plan with `getDocRecipeBySlug`.
 */
export async function readFamilyLibrary(
  kitchenId: string,
): Promise<FamilyLibraryRow[]> {
  const { cookPlan: _cookPlan, ...columns } = getTableColumns(docRecipes);
  return db
    .select(columns)
    .from(docRecipes)
    .where(eq(docRecipes.kitchenId, kitchenId))
    .orderBy(sql`${docRecipes.docPosition} asc nulls last`, asc(docRecipes.name));
}

/** Fetches a single library recipe for a kitchen by its slug, or null if absent. */
export async function getDocRecipeBySlug(
  kitchenId: string,
  docSlug: string,
): Promise<DocRecipeRow | null> {
  const row = await db.query.docRecipes.findFirst({
    where: and(
      eq(docRecipes.kitchenId, kitchenId),
      eq(docRecipes.docSlug, docSlug),
    ),
  });
  return row ?? null;
}

/** Maps a library recipe row into the kitchen-queue snapshot shape. */
export function docRecipeToQueueData(
  row: FamilyLibraryRow,
): KitchenQueueRecipeData {
  return {
    name: row.name,
    ingredients: row.ingredients ?? undefined,
    steps: row.steps ?? undefined,
    estimatedTime: row.estimatedTime ?? undefined,
    serves: row.serves ?? undefined,
    tags: row.tags ?? undefined,
    notes: row.notes ?? undefined,
    stepIngredients: row.stepIngredients ?? undefined,
    source: "library",
  };
}
