/**
 * A cook session: the plan being cooked, where it came from, and the cook's
 * place in it. A pure reducer, so the rule for a plan that arrives mid-cook
 * is testable without React.
 *
 * The rule: a plan arriving while the cook is still on the first screen, with
 * nothing done, replaces the as-written plan. Once the cook has moved or
 * ticked anything, the session is settled and a new plan waits for the next
 * open, because swapping the screens under a cook mid-recipe loses their
 * place.
 *
 * The session is also kept on the tablet (slice B5b), one per queue item, so
 * a reload mid-cook resumes where the cook was: see "The stored session"
 * below.
 */

import { z } from "zod";
import { parseCommonsFile, parseRecipe, parseStatesFile, type Recipe } from "@sous/pack";
import { EMPTY_LIBRARY, type RecipeLibrary, type RecipeReading, type SourcePackInfo } from "../pack-convert/recipe-library";
import {
  browserSessionStore,
  readStored,
  removeStored,
  safeLocalStorage,
  writeStored,
  type ListedStore,
  type StringStore,
} from "@/lib/persist/safe-storage";
import type { KitchenQueueRecipeData } from "../../../drizzle/schema";
import {
  COOK_PLAN_VERSION,
  identityPlan,
  isCurrentCookPlan,
  type CookPlan,
  type PrepMode,
  type RecipeForPlan,
} from "./cook-plan";
import {
  back,
  goToMark,
  initialCookState,
  jumpTo,
  next,
  prepPages,
  screensOf,
  setMode,
  toggleTick,
  type CookState,
  type PlanSource,
} from "./cook-view";

const SAME_SERVINGS = 1e-9;

/**
 * The serving counts the stepper steps through (slice B5c, B5c-3): whole
 * numbers from 1 to 4 × `servesBase` (rounded down), plus `servesBase` itself
 * so a non-whole base (e.g. 2.5) stays reachable in order.
 */
export function steppingCounts(servesBase: number): number[] {
  const cap = Math.max(1, Math.floor(4 * servesBase));
  const counts: number[] = [];
  let addedBase = !(Number.isFinite(servesBase) && servesBase > 0);
  for (let i = 1; i <= cap; i++) {
    if (!addedBase && servesBase < i - SAME_SERVINGS) {
      counts.push(servesBase);
      addedBase = true;
    }
    if (!addedBase && Math.abs(servesBase - i) <= SAME_SERVINGS) {
      addedBase = true;
    }
    counts.push(i);
  }
  if (!addedBase) counts.push(servesBase);
  return counts;
}

/**
 * Whether `servings` is a legal stepper count for `servesBase` (B5c-3, B5c-5):
 * the base itself, or a whole number in `1 .. floor(4 × servesBase)`.
 */
export function isValidServings(servings: number, servesBase: number): boolean {
  if (!Number.isFinite(servings) || servings <= 0) return false;
  if (Math.abs(servings - servesBase) <= SAME_SERVINGS) return true;
  const cap = Math.floor(4 * servesBase);
  return Number.isInteger(servings) && servings >= 1 && servings <= cap;
}

export interface CookSession {
  plan: CookPlan;
  source: PlanSource;
  state: CookState;
  /** The cook has moved or ticked something; plans no longer swap in. */
  settled: boolean;
  /**
   * Checkpoint screens the cook confirmed by moving on (slice B5d, D8), by
   * their task id: "Checked" on a return, kept with the session so it
   * survives a reload. `state.passed` can't hold it: landing on a screen
   * reopens its tasks. Absent in a session kept before (read as none).
   */
  checked?: ReadonlySet<string>;
  /**
   * The serving count chosen by the cook (slice B5c, B5c-5). Absent when at
   * the recipe's own `serves_base`.
   */
  servings?: number;
}

export type CookAction =
  | { type: "next" }
  | { type: "back" }
  | { type: "jump"; pos: number }
  /** The chart's Go (N2): `pos` counts screens as the strip does (`goToMark`). */
  | { type: "goMark"; pos: number }
  | { type: "mode"; mode: PrepMode }
  | { type: "tick"; id: string }
  | { type: "offer"; plan: CookPlan; source: PlanSource }
  /** A checkpoint screen confirmed (B5d): its task id. */
  | { type: "check"; id: string }
  /** Set the serving count (B5c-5): never sets `settled`. */
  | { type: "servings"; servings: number };

/**
 * What deriving on open has said so far: nothing yet (not asked, or in
 * flight), a plan (null when derivation failed), or a failed request.
 */
export type EnsureOutcome = "waiting" | "failed" | { plan: unknown };

/**
 * The plan to cook and where it came from. A current stored plan wins, then
 * one derived on open; otherwise the recipe runs as written, saying whether
 * the prep is still being worked out or there won't be any.
 */
export function resolvePlan(
  recipe: RecipeForPlan,
  stored: unknown,
  ensured: EnsureOutcome,
): { plan: CookPlan; source: PlanSource } {
  if (isCurrentCookPlan(stored)) return { plan: stored, source: { kind: "derived" } };
  if (typeof ensured === "object" && isCurrentCookPlan(ensured.plan)) {
    return { plan: ensured.plan, source: { kind: "derived" } };
  }
  return {
    plan: identityPlan(recipe),
    source: {
      kind: "as-written",
      reason: ensured === "waiting" ? "pending" : "failed",
    },
  };
}

export function startSession(
  plan: CookPlan,
  source: PlanSource,
  mode: PrepMode,
): CookSession {
  return { plan, source, state: initialCookState(mode), settled: false };
}

export function hasProgress(state: CookState, part = 0): boolean {
  return state.pos > 0 || part > 0 || state.ticked.size > 0 || state.passed.size > 0 || state.kept.size > 0;
}

function sameSource(a: PlanSource, b: PlanSource): boolean {
  return a.kind === b.kind && (a.kind === "derived" || a.reason === (b as typeof a).reason);
}

function samePlan(a: CookPlan, b: CookPlan): boolean {
  return a === b || JSON.stringify(a) === JSON.stringify(b);
}

function offer(session: CookSession, plan: CookPlan, source: PlanSource): CookSession {
  if (samePlan(session.plan, plan)) {
    return sameSource(session.source, source) ? session : { ...session, source };
  }
  if (!session.settled) {
    return {
      plan,
      source,
      state: initialCookState(session.state.mode),
      settled: false,
      ...(session.servings !== undefined && { servings: session.servings }),
      ...(session.checked !== undefined && { checked: session.checked }),
    };
  }
  // Settled: the new plan applies on the next open. An as-written session
  // says so instead of still claiming the prep is being worked out.
  if (session.source.kind === "as-written" && session.source.reason !== "later") {
    return { ...session, source: { kind: "as-written", reason: "later" } };
  }
  return session;
}

function move(session: CookSession, state: CookState): CookSession {
  if (state === session.state) return session;
  return { ...session, state, settled: session.settled || hasProgress(state) };
}

export function reduceSession(session: CookSession, action: CookAction): CookSession {
  const { plan, state } = session;
  switch (action.type) {
    case "next":
      return move(session, next(plan, state));
    case "back":
      return move(session, back(plan, state));
    case "jump":
      return move(session, jumpTo(plan, state, action.pos));
    case "goMark":
      return move(session, goToMark(plan, state, action.pos));
    case "mode":
      return move(session, setMode(state, action.mode));
    case "tick":
      return move(session, toggleTick(plan, state, action.id));
    case "offer":
      return offer(session, action.plan, action.source);
    case "check":
      if (session.checked?.has(action.id)) return session;
      return { ...session, checked: new Set([...(session.checked ?? []), action.id]) };
    case "servings":
      if (session.servings === action.servings) return session;
      return { ...session, servings: action.servings };
  }
}

// ---------------------------------------------------------------------------
// The stored session (slice B5b, B5.md B1–B4)
//
// One per queue item, in localStorage under `sous-cook:<queueId>`, through the
// schema-checked envelope of `safe-storage.ts`. It holds the session as it
// stands (the plan being cooked, not only the place), the fingerprint of the
// stored recipe it was cooked from, and a snapshot of what the page needs to
// draw the cook with no connection. A session that can't be read, or whose
// place doesn't fit its plan, is cleared with a notice: resuming at a
// mismatched step is the one thing it must never do.
// ---------------------------------------------------------------------------

export const SESSION_PREFIX = "sous-cook:";
/**
 * 2 since Prep became step pages (DS v1.59): "Prep first" numbers its screens
 * differently. A version-1 session is renumbered on load (`placeFromV1`).
 */
export const SESSION_VERSION = 2;
/** Sessions kept at most; the least recently saved go first. */
export const MAX_SESSIONS = 10;

/**
 * What the reset line says when a kept session couldn't be read (E8, fix
 * round 1): its own words, never the timers'. Placeholder copy.
 */
export const SESSION_RESET_COPY = "Saved cook progress couldn't be read, so this cook starts again.";

export function sessionKey(queueId: string): string {
  return `${SESSION_PREFIX}${queueId}`;
}

/** What the cook page draws from when the queue item can't be fetched. */
export interface CookSnapshot {
  recipeData: KitchenQueueRecipeData;
  packRecipe: Recipe;
  /** The plan stored on the queue item when last seen; it may be stale or absent. */
  cookPlan: unknown;
  /**
   * The library entries a natively read pack recipe's refs name (slice B5d,
   * D6), so an offline open still draws a checkpoint's evidence. Absent in a
   * snapshot kept before B5d, read as none.
   */
  library?: RecipeLibrary;
  /**
   * Whether the cook page may scale the recipe's serving count (slice B5c,
   * B5c-13). Absent in a snapshot kept before B5c, read as false (locked).
   */
  scales?: boolean;
  sourcePack?: SourcePackInfo;
  /** The recipe read as it came, intake having failed (cook-fidelity plan). Absent reads as false. */
  shownAsSent?: boolean;
}

export interface StoredSession {
  fingerprint: string;
  savedAt: number;
  session: CookSession;
  snapshot: CookSnapshot;
  /** The part of a paged step the cook was on, and the stage width it was paged at. */
  part?: number;
  partWidth?: number;
}

/** The stored recipe's columns the fingerprint covers (B3). */
export interface FingerprintedRow {
  recipeData: KitchenQueueRecipeData | null;
  servesEstimate?: number | null;
  servesEstimateBasis?: string | null;
  /** How the row was read (slice B5d); "native" and "adapted" change the fingerprint. */
  reading?: RecipeReading;
  /** The recipe as read: covered by the fingerprint when read natively or adapted. */
  packRecipe?: Recipe | null;
}

/** JSON with every object's keys sorted: jsonb keeps no key order. */
function canonicalJson(value: unknown): string {
  if (Array.isArray(value)) return `[${value.map(canonicalJson).join(",")}]`;
  if (value !== null && typeof value === "object") {
    const entries = Object.entries(value as Record<string, unknown>)
      .filter(([, v]) => v !== undefined)
      .sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0));
    return `{${entries.map(([k, v]) => `${JSON.stringify(k)}:${canonicalJson(v)}`).join(",")}}`;
  }
  return JSON.stringify(value) ?? "null";
}

/**
 * Which stored recipe a session was cooked from (B3): FNV-1a, 53 bits, over
 * the recipe as stored and its serving estimate. Synchronous, so the first
 * draw never waits on a hash (E9). Not a security hash; two recipes that
 * collide would resume one's place on the other, at 1 in 2^53.
 */
export function recipeFingerprint(row: FingerprintedRow): string {
  const text = canonicalJson({
    recipe: row.recipeData,
    estimate: row.servesEstimate ?? null,
    basis: row.servesEstimateBasis ?? null,
    // A pack row read natively or adapted is cooked from its pack recipe, which
    // the stored row doesn't hold (slice B5d, D6): a session kept on its
    // projection, or on an earlier version of the pack, is for another
    // recipe. Every other row's text, and so its fingerprint, is unchanged.
    native:
      row.reading === "native" || row.reading === "adapted"
        ? (row.packRecipe ?? undefined)
        : undefined,
  });
  // Two 32-bit FNV-1a lanes with different offsets, joined to 53 bits.
  let h1 = 0x811c9dc5;
  let h2 = 0x050c5d1f;
  for (let i = 0; i < text.length; i++) {
    const c = text.charCodeAt(i);
    h1 = Math.imul(h1 ^ c, 0x01000193) >>> 0;
    h2 = Math.imul(h2 ^ c, 0x01000193) >>> 0;
  }
  return ((h1 & 0x1fffff) * 0x100000000 + h2).toString(36);
}

const nonEmpty = z.string().min(1);

const planSchema = z
  .object({
    version: z.literal(COOK_PLAN_VERSION),
    tasks: z.array(
      z
        .object({
          id: nonEmpty,
          kind: z.enum(["ahead", "mise", "cook"]),
          text: z.string(),
          label: z.string(),
          ingredientIdx: z.array(z.number()),
          sourceStep: z.number().int().nullable(),
          implied: z.boolean(),
          needs: z.array(z.string()),
          branch: z.string(),
        })
        .passthrough(),
    ),
  })
  .passthrough();

const sourceSchema = z.union([
  z.object({ kind: z.literal("derived") }),
  z.object({
    kind: z.literal("as-written"),
    reason: z.enum(["pending", "failed", "later"]),
  }),
]);

const storedSchema = z
  .object({
    fingerprint: nonEmpty,
    savedAt: z.number(),
    part: z.number().int().nonnegative().optional(),
    partWidth: z.number().int().positive().optional(),
    session: z.object({
      plan: planSchema,
      source: sourceSchema,
      settled: z.boolean(),
      state: z.object({
        mode: z.enum(["first", "go"]),
        pos: z.number().int().nonnegative(),
        ticked: z.array(z.string()),
        passed: z.array(z.string()),
        kept: z.array(z.string()),
      }),
      checked: z.array(z.string()).optional(),
      servings: z.number().optional(),
    }),
    snapshot: z.object({
      recipeData: z.object({ name: z.string() }).passthrough(),
      packRecipe: z.unknown(),
      cookPlan: z.unknown(),
      library: z.object({ states: z.unknown(), commons: z.unknown() }).optional(),
      scales: z.boolean().optional(),
      sourcePack: z
        .object({
          packId: nonEmpty,
          packTitle: nonEmpty,
          creatorName: nonEmpty,
          recipeId: nonEmpty,
          recipeTitle: nonEmpty,
          isAdapted: z.boolean(),
        })
        .optional(),
      shownAsSent: z.boolean().optional(),
    }),
  })
  .transform((stored, ctx): StoredSession => {
    const pack = parseRecipe(stored.snapshot.packRecipe);
    if (!pack.ok) {
      ctx.addIssue({ code: "custom", message: "the snapshot's recipe isn't a pack recipe" });
      return z.NEVER;
    }
    let library: RecipeLibrary = EMPTY_LIBRARY;
    if (stored.snapshot.library !== undefined) {
      const states = parseStatesFile(stored.snapshot.library.states);
      const commons = parseCommonsFile(stored.snapshot.library.commons);
      if (!states.ok || !commons.ok) {
        ctx.addIssue({ code: "custom", message: "the snapshot's library isn't a library" });
        return z.NEVER;
      }
      library = { states: states.value, commons: commons.value };
    }
    const plan = stored.session.plan as CookPlan;
    const { mode, pos, ticked, passed, kept } = stored.session.state;
    const state: CookState = {
      mode,
      pos,
      ticked: new Set(ticked),
      passed: new Set(passed),
      kept: new Set(kept),
    };
    const ids = new Set(plan.tasks.map((t) => t.id));
    const checked = stored.session.checked ?? [];
    if (![...ticked, ...passed, ...kept, ...checked].every((id) => ids.has(id))) {
      ctx.addIssue({ code: "custom", message: "the session names a task its plan doesn't have" });
      return z.NEVER;
    }
    // A plan its steps can't be walked on (a needs cycle) is no session this can read: an issue
    // like any other, so the read clears it with the notice rather than throwing out of the parse
    // (a throw inside a transform is not caught by `safeParse`).
    let screenCount: number;
    try {
      screenCount = screensOf(plan, mode, state.ticked).length;
    } catch (err) {
      ctx.addIssue({ code: "custom", message: `the session's plan can't be walked: ${err instanceof Error ? err.message : String(err)}` });
      return z.NEVER;
    }
    // A place past the plan's screens would draw a step the cook never saw.
    if (pos >= Math.max(1, screenCount)) {
      ctx.addIssue({ code: "custom", message: "the session's place is past its plan's screens" });
      return z.NEVER;
    }
    // B5c-5: an out-of-range serving count drops only the count and keeps
    // progress, logging a warning with the stored fingerprint and the value.
    const rawServings = stored.session.servings;
    let servings: number | undefined;
    if (rawServings !== undefined) {
      const base = pack.value.serves_base;
      if (!isValidServings(rawServings, base)) {
        console.warn(
          `Dropped out-of-range stored servings (${String(rawServings)}, base ${String(base)}) for session ${stored.fingerprint}`,
        );
      } else if (Math.abs(rawServings - base) > SAME_SERVINGS) {
        servings = rawServings;
      }
    }
    return {
      fingerprint: stored.fingerprint,
      savedAt: stored.savedAt,
      session: {
        plan,
        source: stored.session.source,
        settled: stored.session.settled,
        state,
        ...(checked.length > 0 && { checked: new Set(checked) }),
        ...(servings !== undefined && { servings }),
      },
      snapshot: {
        recipeData: stored.snapshot.recipeData as KitchenQueueRecipeData,
        packRecipe: pack.value,
        cookPlan: stored.snapshot.cookPlan,
        library,
        ...(stored.snapshot.scales !== undefined && { scales: stored.snapshot.scales }),
        ...(stored.snapshot.sourcePack !== undefined && { sourcePack: stored.snapshot.sourcePack }),
        ...(stored.snapshot.shownAsSent === true && { shownAsSent: true }),
      },
      part: stored.part,
      partWidth: stored.partWidth,
    };
  });

/** localStorage, as pruning needs it: one that can list its keys. */
export type { ListedStore } from "@/lib/persist/safe-storage";

/** The page's localStorage (or in-memory fallback when blocked), or null on the server. */
function browserStorage(): ListedStore | null {
  return safeLocalStorage();
}

/**
 * Keep the session for `queueId`. Nothing is kept until the cook has progress
 * (a fresh open has nothing to lose), and a session that has lost all of it
 * is removed. False when nothing was stored: no progress, or storage refused
 * (logged; the cook runs on unpersisted).
 */
export function saveSession(
  queueId: string,
  fingerprint: string,
  session: CookSession,
  snapshot: CookSnapshot,
  now: number,
  backing: StringStore | null = browserStorage(),
  part?: number,
  partWidth?: number,
): boolean {
  if (!hasProgress(session.state, part)) {
    removeStored(sessionKey(queueId), backing);
    return false;
  }
  const { state } = session;
  const base = snapshot.packRecipe.serves_base;
  const scaledServings =
    session.servings !== undefined &&
    isValidServings(session.servings, base) &&
    Math.abs(session.servings - base) > SAME_SERVINGS
      ? session.servings
      : undefined;
  return writeStored(
    sessionKey(queueId),
    {
      fingerprint,
      savedAt: now,
      ...(part !== undefined && part > 0 ? { part, ...(partWidth !== undefined ? { partWidth } : {}) } : {}),
      session: {
        plan: session.plan,
        source: session.source,
        settled: session.settled,
        state: {
          mode: state.mode,
          pos: state.pos,
          ticked: [...state.ticked],
          passed: [...state.passed],
          kept: [...state.kept],
        },
        ...(session.checked !== undefined && session.checked.size > 0 && { checked: [...session.checked] }),
        ...(scaledServings !== undefined && { servings: scaledServings }),
      },
      snapshot,
    },
    backing,
    SESSION_VERSION,
  );
}

/** A version-1 envelope, read only as far as its place needs: the plan, and the state's place and ticks. */
const v1Schema = z.object({
  version: z.literal(1),
  state: z
    .object({
      session: z
        .object({
          plan: planSchema,
          state: z
            .object({
              mode: z.enum(["first", "go"]),
              pos: z.number().int().nonnegative(),
              ticked: z.array(z.string()),
              passed: z.array(z.string()),
            })
            .passthrough(),
        })
        .passthrough(),
    })
    .passthrough(),
});

/**
 * A place saved at version 1, in today's numbering (version 2; DS v1.59,
 * DECISIONS 2026-11-22). Version 1's "Prep first" was the Prep screen and
 * then the cooking steps; today's is the prep pages and then the cooking
 * steps. So for a plan with prep pages: the Prep screen becomes the first
 * page with a job not done, or the last page with all of it done; a cooking
 * step keeps its step, moved on by the pages before it less the Prep screen.
 * "As I go", and a plan with no mise, number as they did.
 */
export function placeFromV1(
  plan: CookPlan,
  state: { mode: PrepMode; pos: number; ticked: readonly string[]; passed: readonly string[] },
): number {
  const pages = prepPages(plan, state.mode);
  if (pages.length === 0) return state.pos;
  if (state.pos > 0) return state.pos + pages.length - 1;
  const done = new Set([...state.ticked, ...state.passed]);
  const open = pages.findIndex((page) => page.tasks.some((t) => !done.has(t.id)));
  return open === -1 ? pages.length - 1 : open;
}

/**
 * Rewrites a version-1 session in place at today's version, its place
 * renumbered (`placeFromV1`); the shape is otherwise the same. Anything it
 * can't read as version 1 it leaves alone, for `readStored` to clear with
 * the notice, as any stored session that doesn't read.
 */
function migrateStoredSession(key: string, backing: StringStore): void {
  let raw: string | null;
  try {
    raw = backing.getItem(key);
  } catch {
    return;
  }
  if (raw === null) return;
  let envelope: unknown;
  try {
    envelope = JSON.parse(raw);
  } catch {
    return;
  }
  const v1 = v1Schema.safeParse(envelope);
  if (!v1.success) return;
  const { plan, state } = v1.data.state.session;
  let pos: number;
  try {
    pos = placeFromV1(plan as CookPlan, state);
  } catch (err) {
    // A plan its steps can't be walked on (a needs cycle) is no version-1
    // session this can read: left as it is, the read below clears it with the
    // notice, rather than the cook page failing as it opens.
    console.warn(`Could not renumber stored ${key}:`, err);
    return;
  }
  const migrated = {
    ...v1.data,
    version: SESSION_VERSION,
    state: {
      ...v1.data.state,
      session: {
        ...v1.data.state.session,
        state: { ...state, pos },
      },
    },
  };
  try {
    backing.setItem(key, JSON.stringify(migrated));
  } catch (err) {
    // Storage that refuses the rewrite leaves the old envelope, which the
    // read below clears with the notice: said, never silent.
    console.warn(`Could not rewrite stored ${key}:`, err);
  }
}

/**
 * The session stored for `queueId`; null when none, or it was cleared as
 * unreadable (with a notice). One saved at version 1 is renumbered first
 * (`migrateStoredSession`), so a cook under way resumes at its step.
 */
export function loadSession(
  queueId: string,
  backing: StringStore | null = browserStorage(),
): StoredSession | null {
  if (backing !== null) migrateStoredSession(sessionKey(queueId), backing);
  return readStored(sessionKey(queueId), storedSchema, backing, SESSION_VERSION, SESSION_RESET_COPY);
}

export type Resume =
  | { kind: "resume"; stored: StoredSession }
  /** A session was stored, for a recipe that has since changed: start over, and say so. */
  | { kind: "changed" }
  | { kind: "none" };

/** What an open does with a stored session, given the stored recipe's fingerprint now (B3). */
export function resumeFor(stored: StoredSession | null, fingerprint: string): Resume {
  if (stored === null) return { kind: "none" };
  return stored.fingerprint === fingerprint ? { kind: "resume", stored } : { kind: "changed" };
}

export function removeSession(
  queueId: string,
  backing: StringStore | null = browserStorage(),
): void {
  removeStored(sessionKey(queueId), backing);
}

// ---------------------------------------------------------------------------
// Per-tab serving count before progress (slice B5c, B5c-5)
//
// Held in `sessionStorage` under `sous.cook-scale.<queueId>` as
// `{ fingerprint, servings }`. Written on every change of count, with or
// without progress; setting the count back to base removes the entry.
// Read with its own small reader (never `readStored`), so a malformed entry
// is cleared with a `console.info` and no corruption notice.
// ---------------------------------------------------------------------------

export const TAB_SCALE_PREFIX = "sous.cook-scale.";

export function tabScaleKey(queueId: string): string {
  return `${TAB_SCALE_PREFIX}${queueId}`;
}

const tabScaleSchema = z.strictObject({
  fingerprint: nonEmpty,
  servings: z.number(),
});

function clearTabKey(key: string, backing: StringStore): void {
  try {
    backing.removeItem(key);
  } catch (err) {
    console.warn(`Could not clear tab scale ${key}:`, err);
  }
}

export function loadTabServings(
  queueId: string,
  fingerprint: string,
  servesBase: number,
  backing: StringStore | null = browserSessionStore(),
): number | null {
  if (backing === null) return null;
  const key = tabScaleKey(queueId);
  let raw: string | null;
  try {
    raw = backing.getItem(key);
  } catch (err) {
    console.warn(`Could not read tab scale ${key}:`, err);
    return null;
  }
  if (raw === null) return null;

  let parsedJson: unknown;
  try {
    parsedJson = JSON.parse(raw);
  } catch {
    clearTabKey(key, backing);
    console.info(`Cleared malformed tab scale ${key}: not valid JSON`);
    return null;
  }

  const parsed = tabScaleSchema.safeParse(parsedJson);
  if (!parsed.success) {
    clearTabKey(key, backing);
    console.info(`Cleared malformed tab scale ${key}: unexpected shape`);
    return null;
  }

  const { fingerprint: storedFp, servings } = parsed.data;
  if (
    storedFp !== fingerprint ||
    !isValidServings(servings, servesBase) ||
    Math.abs(servings - servesBase) <= SAME_SERVINGS
  ) {
    clearTabKey(key, backing);
    return null;
  }
  return servings;
}

export function saveTabServings(
  queueId: string,
  fingerprint: string,
  servings: number,
  servesBase: number,
  backing: StringStore | null = browserSessionStore(),
): void {
  if (backing === null) return;
  const key = tabScaleKey(queueId);
  if (!isValidServings(servings, servesBase) || Math.abs(servings - servesBase) <= SAME_SERVINGS) {
    clearTabKey(key, backing);
    return;
  }
  try {
    backing.setItem(key, JSON.stringify({ fingerprint, servings }));
  } catch (err) {
    console.warn(`Could not store tab scale ${key}:`, err);
  }
}

export function removeTabServings(
  queueId: string,
  backing: StringStore | null = browserSessionStore(),
): void {
  if (backing === null) return;
  clearTabKey(tabScaleKey(queueId), backing);
}

/**
 * The initial `CookSession` for `CookSessionView` (B5c-5, B5c-13):
 * - When a stored session with progress resumes (`start.kind === "resume"`),
 *   its session (including its range-checked `servings`) wins. On a snapshot
 *   open (`fromSnapshot: true`), the tab's entry is not consulted.
 * - Otherwise (`start.kind === "none"` or `"changed"`), the tab's entry is
 *   read (and removed quietly if its fingerprint no longer matches), falling
 *   back to the recipe's own count.
 */
export function initialSessionFor(opts: {
  id: string;
  recipe: RecipeForPlan;
  packRecipe: Recipe;
  storedPlan: unknown;
  fingerprint: string;
  start: Resume;
  fromSnapshot?: boolean;
  mode: PrepMode;
  tabBacking?: StringStore | null;
}): CookSession {
  if (opts.start.kind === "resume") {
    return opts.start.stored.session;
  }
  const tabServings = opts.fromSnapshot
    ? null
    : loadTabServings(opts.id, opts.fingerprint, opts.packRecipe.serves_base, opts.tabBacking);
  const { plan, source } = resolvePlan(opts.recipe, opts.storedPlan, "waiting");
  const session = startSession(plan, source, opts.mode);
  return tabServings !== null ? { ...session, servings: tabServings } : session;
}

/**
 * The active serving count on screen (B5c-13): while `scales` is false, the
 * multiplier is 1 (`serves_base`) whatever any stored count says.
 */
export function effectiveServings(
  packRecipe: Pick<Recipe, "serves_base">,
  session: Pick<CookSession, "servings">,
  scales: boolean,
): number {
  if (!scales) return packRecipe.serves_base;
  if (session.servings === undefined) return packRecipe.serves_base;
  return isValidServings(session.servings, packRecipe.serves_base)
    ? session.servings
    : packRecipe.serves_base;
}

/** When a stored entry was saved, without checking the rest; null when it can't be read. */
function savedAtOf(raw: string | null): number | null {
  try {
    const at = (JSON.parse(raw ?? "") as { state?: { savedAt?: unknown } }).state?.savedAt;
    return typeof at === "number" ? at : null;
  } catch {
    return null;
  }
}

/**
 * Housekeeping on a kitchen load (B4, E7): remove the sessions of items the
 * kitchen knows are finished, then keep the `keep` most recently saved. An
 * entry that can't be read goes first and quietly: it isn't the cook on
 * screen, which says so itself when it opens.
 */
export function pruneSessions(
  finished: Iterable<string>,
  backing: ListedStore | null = browserStorage(),
  keep = MAX_SESSIONS,
): void {
  if (backing === null) return;
  const done = new Set([...finished].map(sessionKey));
  let keys: string[];
  try {
    keys = Array.from({ length: backing.length }, (_, i) => backing.key(i)).filter(
      (k): k is string => k !== null && k.startsWith(SESSION_PREFIX),
    );
  } catch (err) {
    console.warn("Could not list the stored cook sessions:", err);
    return;
  }
  const live: { key: string; at: number }[] = [];
  for (const key of keys) {
    if (done.has(key)) {
      removeStored(key, backing);
      continue;
    }
    let raw: string | null = null;
    try {
      raw = backing.getItem(key);
    } catch {
      // Unreadable: pruned below as the oldest.
    }
    live.push({ key, at: savedAtOf(raw) ?? -Infinity });
  }
  live.sort((a, b) => b.at - a.at);
  for (const { key } of live.slice(keep)) removeStored(key, backing);
}
