/**
 * What the cook page opens on (slice B5b): the queue item as fetched, the
 * session the tablet kept for it, or neither. A pure function, so the order
 * of the rules is testable without React or a network.
 *
 * - A fetched recipe wins: the cook draws from it, resuming the kept session
 *   when the stored recipe is the one it was cooked from, and starting over
 *   with a note when it changed (B3).
 * - No recipe because the tablet is offline (React Query pauses the query,
 *   told the browser's state at load, `providers.tsx`; E6) or a try failed: a
 *   kept session draws the cook from its snapshot, at once, without waiting
 *   out the retries.
 * - Once a page load has drawn from the snapshot it stays on it (`latched`),
 *   so nothing swaps under the cook when the connection comes back.
 * - Offline with nothing kept: the error screen, worded for offline.
 * - An item still waiting for intake (cook-fidelity plan) waits until the
 *   page's ask for it has answered, and opens on the item that answer
 *   carries, never on a read after it that may have failed (round-3 review,
 *   C2). If it is still waiting then (the ask failed), it cooks as sent, said
 *   so on the info sheet, and asks for no plan: a plan worked out meanwhile
 *   could be the cut's.
 * - A cook already under way (a session kept for the item) never waits on
 *   intake and never meets a different recipe because of it (round-3 review,
 *   B1): still waiting, it goes on as sent; a cut that landed since it
 *   started as sent leaves it on its snapshot, the recipe it started.
 */

import type { Recipe } from "@sous/pack";
import type { KitchenQueueRecipeData } from "../../../drizzle/schema";
import type { IntakeSummary } from "../pack-convert/intake-state";
import { EMPTY_LIBRARY, type RecipeLibrary, type RecipeReading, type SourcePackInfo } from "../pack-convert/recipe-library";
import {
  recipeFingerprint,
  resumeFor,
  type Resume,
  type StoredSession,
} from "./cook-session";
import { openFailure } from "./open-failure";

/** The queue item as the cook page's query has it. */
export interface QueueRead {
  /** No data yet: the first fetch is in flight, or paused. */
  isLoading: boolean;
  /** The query is waiting for the browser to come back online. */
  paused: boolean;
  /**
   * Failed tries so far. A connection that is down while the browser says
   * it's online fails each try, and the error itself only comes after the
   * retries (about 7 s).
   */
  failures: number;
  item:
    | {
        recipeData: KitchenQueueRecipeData | null;
        packRecipe: Recipe | null;
        cookPlan: unknown;
        servesEstimate?: number | null;
        servesEstimateBasis?: string | null;
        conversionError?: string | null;
        /** How the row was read (slice B5d): a `pack:` row natively, behind the guard. */
        reading?: RecipeReading;
        library?: RecipeLibrary;
        /** Whether the cook page may scale the recipe's serving count (slice B5c, B5c-13); absent reads as false. */
        scales?: boolean;
        sourcePack?: SourcePackInfo;
        /** Intake's state (cook-fidelity plan); absent reads as never asked for. */
        intake?: IntakeSummary;
      }
    | null
    | undefined;
  error: { data?: { code?: string } | null } | null;
}

/** Placeholder copy, awaiting a rewrite (B5.md B3, B5, E6). */
export const OPEN_COPY = {
  changed: "This recipe changed since you started, so the cook starts again.",
  offline: "Offline",
  offlineNothingKept: "You're offline, and this recipe isn't saved on this tablet.",
} as const;

/** Placeholder copy (cook-fidelity plan; standing agent call, DECISIONS 2026-10-26), awaiting a rewrite. */
export const INTAKE_COPY = {
  shownAsSent: "Shown as written — Sous couldn't re-cut this recipe's steps.",
} as const;

export type CookOpen =
  | { kind: "wait" }
  | {
      kind: "cook";
      from: "live";
      recipe: KitchenQueueRecipeData;
      packRecipe: Recipe;
      /** The library entries its refs name: empty unless read natively (slice B5d). */
      library: RecipeLibrary;
      /** Whether the cook page may scale the recipe's serving count (slice B5c, B5c-13). */
      scales: boolean;
      sourcePack?: SourcePackInfo;
      storedPlan: unknown;
      fingerprint: string;
      start: Resume;
      /** The recipe reads as it came: intake failed, or never finished. */
      shownAsSent: boolean;
      /** Whether the cook may take a plan: not while intake could still swap the recipe. */
      plans: boolean;
    }
  | { kind: "cook"; from: "snapshot"; stored: StoredSession }
  /** `code` as `openFailure` gives it, or OFFLINE. */
  | { kind: "fail"; code: string };

/**
 * `stored` is undefined until the page has read the tablet's storage (after
 * mount, so the first render matches the server's); null when nothing is
 * kept. `intakeAsked` is true once the page's ask for this item's intake has
 * answered or failed; `intakeAnswer` is the item the answer carried, which
 * stands in for the read.
 */
export function openCook(
  read: QueueRead,
  stored: StoredSession | null | undefined,
  latched: "live" | "snapshot" | null,
  { intakeAsked = false, intakeAnswer = null }: { intakeAsked?: boolean; intakeAnswer?: QueueRead["item"] } = {},
): CookOpen {
  if (stored === undefined) return { kind: "wait" };
  if (latched === "snapshot" && stored !== null) return { kind: "cook", from: "snapshot", stored };

  const item = intakeAnswer ?? read.item;
  if (item?.packRecipe && item.recipeData) {
    const intake = item.intake?.state ?? "none";
    if (intake === "pending" && stored === null && !intakeAsked) return { kind: "wait" };
    if (intake === "normalized" && stored?.snapshot.shownAsSent === true) {
      return { kind: "cook", from: "snapshot", stored };
    }
    const fingerprint = recipeFingerprint(item);
    return {
      kind: "cook",
      from: "live",
      recipe: item.recipeData,
      packRecipe: item.packRecipe,
      library: item.library ?? EMPTY_LIBRARY,
      scales: item.scales ?? false,
      ...(item.sourcePack !== undefined && { sourcePack: item.sourcePack }),
      storedPlan: item.cookPlan,
      fingerprint,
      start: resumeFor(stored, fingerprint),
      shownAsSent: intake === "as-sent" || intake === "pending",
      plans: intake !== "pending",
    };
  }

  const unreachable = read.paused || (!item && (read.error !== null || read.failures > 0));
  if (unreachable && stored !== null) return { kind: "cook", from: "snapshot", stored };
  if (read.paused) return { kind: "fail", code: "OFFLINE" };
  if (read.isLoading) return { kind: "wait" };
  return { kind: "fail", code: openFailure(item, read.error) ?? "NOT_FOUND" };
}

/**
 * The one quiet line the cook shows about itself (B3, B5), or null: offline
 * while drawn from the snapshot, else the changed recipe's note until the
 * cook's first move.
 */
export function cookNotice(opts: {
  changed: boolean;
  moved: boolean;
  fromSnapshot: boolean;
  online: boolean;
}): string | null {
  if (opts.fromSnapshot && !opts.online) return OPEN_COPY.offline;
  if (opts.changed && !opts.moved) return OPEN_COPY.changed;
  return null;
}
