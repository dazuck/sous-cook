/**
 * What a Refresh of the household book says, in words (slice S, S-D13): one
 * status line under the pack view's search. Kept apart from recipe-sync
 * (which imports the database) so the client can use it. Every string is
 * placeholder copy.
 *
 * It is the tablet's trouble, never dinner's, so the screen sets it in ink
 * and never ember; the server's own message goes to the console only.
 */

import type { SyncRecipesResult } from "./recipe-sync";

/** Names shown before the rest collapse into "+N more". */
const NAMES_SHOWN = 3;

/** "A", "A and B", "A, B and C", "A, B and C +2 more". */
function names(list: readonly string[]): string {
  const shown = list.slice(0, NAMES_SHOWN);
  const rest = list.length - shown.length;
  const joined =
    shown.length <= 1 ? (shown[0] ?? "") : `${shown.slice(0, -1).join(", ")} and ${shown[shown.length - 1]}`;
  return rest > 0 ? `${joined} +${rest} more` : joined;
}

/** A recipe's name as a sentence opens with it: the first letter up, the rest as the Doc writes it. */
function opening(text: string): string {
  return text.charAt(0).toLocaleUpperCase() + text.slice(1);
}

// How the summary names each part a sync can leave out of a recipe.
const LEFT_OUT: Record<SyncRecipesResult["notices"][number]["kind"], string> = {
  "method-dropped": "steps",
  "notes-dropped": "notes",
};

/**
 * A finished Refresh in words: "Refreshed 50 of 52." then, for what failed,
 * "Lamb biryani and Seeded rye crackers didn't come through, so the
 * book keeps what it had of them." (a recipe that extracted before keeps
 * that version; one that never did stays marked in its chapter), what came
 * in without a part, and "1 no longer in the recipe library: Minced lamb." Names past
 * the third collapse into "+N more". Then the cook plans (slice P): "2
 * recipes need plan fixes: Tomato and herb salad and Lamb biryani." for
 * settled failures (a Doc edit is the fix), and "3 plans are still being
 * worked out, so Refresh again." for rows the budget didn't reach or whose
 * attempt failed for now.
 */
export function syncSummary(
  result: Pick<SyncRecipesResult, "succeeded" | "total" | "failures" | "notices" | "stale" | "plans">,
): string {
  const sentences = [
    result.succeeded === result.total
      ? `Refreshed all ${result.total} recipe${result.total === 1 ? "" : "s"}.`
      : `Refreshed ${result.succeeded} of ${result.total}.`,
  ];
  if (result.failures.length > 0) {
    const one = result.failures.length === 1;
    sentences.push(
      `${opening(names(result.failures.map((f) => f.name)))} didn't come through, so the book keeps what it had of ${one ? "it" : "them"}.`,
    );
  }
  for (const [kind, part] of Object.entries(LEFT_OUT)) {
    const left = result.notices.filter((n) => n.kind === kind).map((n) => n.name);
    if (left.length > 0) {
      sentences.push(`${opening(names(left))} came in without ${part}: the recipe library doesn't give them.`);
    }
  }
  if (result.stale.length > 0) {
    sentences.push(`${result.stale.length} no longer in the recipe library: ${names(result.stale)}.`);
  }
  const needFixes = result.plans.failed.filter((f) => f.settled).map((f) => f.name);
  if (needFixes.length > 0) {
    sentences.push(
      needFixes.length === 1
        ? `1 recipe needs a plan fix: ${names(needFixes)}.`
        : `${needFixes.length} recipes need plan fixes: ${names(needFixes)}.`,
    );
  }
  const working = result.plans.pending + result.plans.failed.filter((f) => !f.settled).length;
  if (working > 0) {
    sentences.push(
      working === 1
        ? "1 plan is still being worked out, so Refresh again."
        : `${working} plans are still being worked out, so Refresh again.`,
    );
  }
  return sentences.join(" ");
}

/** "1 recipe needs a plan fix." / "N recipes need plan fixes." (slice P). */
export function planFixesLine(n: number): string {
  return n === 1 ? "1 recipe needs a plan fix." : `${n} recipes need plan fixes.`;
}

export interface PackStatus {
  text: string;
  trouble: boolean;
}

/**
 * The household pack view's one status line (slice P decision 9): a running
 * Refresh says so; else the last Refresh's own words (which name any plan
 * fixes itself); else, while the library has settled plan failures, "N
 * recipes need plan fixes." in ink as the tablet's trouble; else nothing.
 * `needFixes` is null while the report hasn't come back or couldn't be read.
 */
export function householdStatus(input: {
  running: boolean;
  refreshed: PackStatus | null;
  needFixes: number | null;
  runningText: string;
}): PackStatus | null {
  if (input.running) return { text: input.runningText, trouble: false };
  if (input.refreshed) return input.refreshed;
  if (input.needFixes !== null && input.needFixes > 0) return { text: planFixesLine(input.needFixes), trouble: true };
  return null;
}

/**
 * Why a Refresh failed, as far as the cook can do anything about it, and
 * whether anything changed. An unreachable library fails before the
 * sync writes anything; any other failure (a timeout, a dropped connection,
 * a crash) may come after it wrote the Doc's order and some recipes.
 */
export type RefreshFailureCause = "unreached" | "no-recipes" | "stopped";

/**
 * Reads a failed Refresh's server message for its cause
 * (`syncRecipesFromDoc` words both). The library was out of reach when the
 * recipe-library hook's read failed. It was read but held no recipe tab when
 * none of its tabs is one a recipe sits in (both before any write).
 * Anything else stopped a Refresh that may have begun writing.
 */
export function refreshFailureCause(message: string): RefreshFailureCause {
  if (/No recipes found in the recipe library/i.test(message)) return "no-recipes";
  if (/Couldn't read the recipe library/i.test(message)) return "unreached";
  return "stopped";
}

/**
 * A Refresh that failed, in words that stay true: one that failed before it
 * wrote says nothing changed and the date the book shows; one that stopped
 * partway says the book keeps what it had, with whatever came in before it
 * stopped.
 */
export function refreshFailedLine(cause: RefreshFailureCause, syncedDate: string | null): string {
  if (cause === "no-recipes") {
    const shows = syncedDate === null ? "" : `: these are the recipes from ${syncedDate}`;
    return `The recipe library has no recipe tabs to read (each recipe is its own tab, inside a category tab), so nothing changed${shows}.`;
  }
  if (cause === "stopped") {
    return "The Refresh stopped before it finished: the book keeps what it had, with any recipes that came in before it stopped.";
  }
  return syncedDate === null
    ? "Couldn't reach the recipe library, so nothing changed."
    : `Couldn't reach the recipe library, so nothing changed: these are the recipes from ${syncedDate}.`;
}
