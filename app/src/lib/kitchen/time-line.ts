/**
 * The time line: one quiet line saying how long a recipe takes (PLAN
 * decision 10, slice T2), on the kitchen's queue rows, on Prep and in the
 * info sheet. "1 h 10 · 25 min hands-on", then the ahead work Prep opens
 * with, "+ marinate chicken at least 4 hours ahead".
 *
 * It reads `shownTimes` (`recipe-times.ts`) for the minutes: the plan's,
 * rounded up to 5, or the recipe's own as it states them, said as the
 * recipe's ("Recipe says 30 min"); with neither it says no minutes, never
 * "0 min". The ahead work is `aheadFirst` (`cook-view.ts`). Durations only,
 * no clock times.
 *
 * The line comes as parts, each one reading unit; a wrap falls between
 * words, and no-break spaces keep a duration whole ("1 h 10"), a dot on the
 * line it closes, and "+" on the word after it.
 */

import { aheadFirst, bindNumbers, LEAD_UNIT } from "./cook-view";
import { shownTimes, type ShownTimes, type StatedTime } from "./recipe-times";

const NBSP = " ";

/** What opens the ahead part after the minutes: "+", bound to the word after it. */
const AHEAD_MARK = `+${NBSP}`;

/** Whether a part is the ahead job after the minutes, the line's one place to break. */
export function isAheadPart(part: string): boolean {
  return part.startsWith(AHEAD_MARK);
}

/** "25 min", "1 h", "1 h 10", "2 h 05": whole minutes, never 0. */
export function durationText(minutes: number): string {
  if (!Number.isFinite(minutes) || minutes <= 0) {
    throw new Error(`durationText: ${minutes} is not a positive count of minutes`);
  }
  const whole = Math.max(1, Math.round(minutes));
  if (whole < 60) return `${whole}${NBSP}min`;
  const hours = Math.floor(whole / 60);
  const rest = whole % 60;
  return rest === 0
    ? `${hours}${NBSP}h`
    : `${hours}${NBSP}h${NBSP}${String(rest).padStart(2, "0")}`;
}

/** The ahead work named on the line (`aheadFirst`). */
export interface NamedAhead {
  label: string;
  lead: string | null;
}

/**
 * A lead that is a counted duration and "before" ("at least 4 hours
 * before", "a day before") reads as ahead of the cook; one that names a
 * time ("the night before") stays as written. Abbreviated units count
 * ("30 min before", "2 hr before"; T follow-up, item 3).
 */
const BEFORE_RE = new RegExp(String.raw`(?:\d|[¼½¾]|\ban?)\s*(?:${LEAD_UNIT}) before$`, "i");

/** The ahead part's words, each number bound to its unit (`bindNumbers`). */
function aheadWords({ label, lead }: NamedAhead): string {
  if (!lead) return bindNumbers(`${label} ahead`);
  return bindNumbers(`${label} ${BEFORE_RE.test(lead) ? lead.replace(/ before$/i, " ahead") : lead}`);
}

function minutesParts(total: number | null, handsOn: number | null): string[] {
  if (total !== null && handsOn !== null) {
    if (handsOn >= total) return [`${durationText(total)}, all hands-on`];
    if (handsOn === 0) return [`${durationText(total)}, hands-free`];
    return [`${durationText(total)}${NBSP}·`, `${durationText(handsOn)} hands-on`];
  }
  if (total !== null) return [durationText(total)];
  if (handsOn !== null) return [`${durationText(handsOn)} hands-on`];
  return [];
}

/**
 * The time line's hands-on words on a line of their own (the opening): what
 * the kitchen row says of the hands-on minutes, from the same `shownTimes`,
 * so the opening and the row never disagree. "25 min
 * hands-on", "All hands-on", "Hands-free"; the recipe's stated time as the
 * recipe's ("Recipe says 20 min hands-on"). Null when the row says none.
 */
export function handsOnWords(shown: ShownTimes): string | null {
  if (shown.source === "none" || shown.handsOn === null) return null;
  const { total, handsOn } = shown;
  let said: string;
  if (total !== null && handsOn >= total) said = "all hands-on";
  else if (handsOn === 0) said = "hands-free";
  else said = `${durationText(handsOn)} hands-on`;
  if (shown.source === "recipe") return `Recipe says ${said}`;
  return said[0].toUpperCase() + said.slice(1);
}

/**
 * The time line's parts, or null when there is nothing to say. `ahead` is
 * the plan's first ahead work; `{ ahead: false }` leaves it off, as Prep
 * does, its make-ahead groups standing right under the line.
 */
export function timeLine(
  shown: ShownTimes,
  ahead: NamedAhead | null,
  { ahead: withAhead = true }: { ahead?: boolean } = {},
): string[] | null {
  const parts = shown.source === "none" ? [] : minutesParts(shown.total, shown.handsOn);
  if (shown.source === "recipe" && parts.length > 0) parts[0] = `Recipe says ${parts[0]}`;

  if (withAhead && ahead) {
    const words = aheadWords(ahead);
    parts.push(
      parts.length > 0
        ? `${AHEAD_MARK}${words}`
        : words[0].toUpperCase() + words.slice(1),
    );
  }
  return parts.length > 0 ? parts : null;
}

/**
 * A recipe's time line from what a queue item holds: its stored plan (any
 * value; only a current plan counts, `shownTimes`) and the recipe's stated
 * time. The surfaces' one way in, so the rows, Prep and the sheet agree.
 */
export function recipeTimeLine(
  plan: unknown,
  stated: StatedTime,
  options: { ahead?: boolean } = {},
): string[] | null {
  return timeLine(shownTimes(plan, stated), aheadFirst(plan), options);
}

/** The line as one string, for a screen reader's label or a test. */
export function timeLineText(parts: string[]): string {
  return parts.join(" ");
}
