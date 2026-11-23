/**
 * What the kitchen home shows, decided apart from drawing it (FP1; P65 as
 * amended, D5 to D11). Pure: the home's component reads these and draws.
 */

/** A dish as the home names it. */
export interface HomeDish {
  id: string;
  name: string;
}

/** The one subject the body shows, the first of these that applies (P65). */
export type HomeSubject = "cooking" | "ask" | "queue" | "idle";

export function subjectOf(state: { cooking: number; queued: number; asking: boolean }): HomeSubject {
  if (state.cooking > 0) return "cooking";
  if (state.asking) return "ask";
  if (state.queued > 0) return "queue";
  return "idle";
}

/**
 * The "Then" line under Start: the next two dishes after the top one, each a
 * tap that starts it, and how many more there are (a tap that opens the queue).
 */
export function thenLine<T extends HomeDish>(queue: readonly T[]): { next: T[]; more: number } {
  const rest = queue.slice(1);
  return { next: rest.slice(0, 2), more: Math.max(0, rest.length - 2) };
}

/**
 * Made recently on the home: at most three names (R26 capped it at four; the
 * home's line has the room for three, D11).
 */
export const HOME_RECENT_CAP = 3;

/** The foot's right-hand word: where the queue screen is reached from. */
export type FootWord =
  | { kind: "up-next"; label: string }
  | { kind: "under-way"; label: string }
  | { kind: "made-recently"; label: string }
  | null;

/**
 * "Up next · N" while anything is queued; "Under way · M" with only cooks
 * (Mark as done needs Edit, which lives on that screen); "Made recently" in
 * the idle kitchen, where the line may have given way and the screen is the
 * way to it (D9, D11); otherwise no word.
 */
export function footWord(count: { queued: number; cooking: number; recent: number }): FootWord {
  if (count.queued > 0) return { kind: "up-next", label: `Up next · ${count.queued}` };
  if (count.cooking > 0) return { kind: "under-way", label: `Under way · ${count.cooking}` };
  if (count.recent > 0) return { kind: "made-recently", label: "Made recently" };
  return null;
}

/** The dish name's sizes, largest first: the closed scale's step, title and chip (F5). */
export const DISH_NAME_SIZES = ["var(--type-step)", "var(--type-title)", "var(--type-chip)"] as const;

/**
 * The idle shelf's cover scale as the body gives it up (D14, the
 * orchestrator's answer to Open question 2): the covers step down from 1
 * to a floor of 0.85, only after Made recently and the line above the shelf
 * have gone. Type never scales; only the objects do.
 */
export const SHELF_FITS = [0.95, 0.9, 0.85] as const;
