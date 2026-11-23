/**
 * The kitchen's control styles (DS §6): ghost words, action words in their
 * hairline ring, and the focus ring. A leaf module, imported by the kitchen
 * home, the timers, Ask Sous and the reports, so none of them imports another
 * screen for a class string.
 */

export const FOCUS =
  "focus-visible:outline-3 focus-visible:outline-offset-3 focus-visible:outline-ink";

/**
 * A ghost word (V11, DS §6): no fill at rest, sand only while pressed, the
 * 22 cpx floor on an 80 cpx target. The header's words and a row's edit.
 */
export const GHOST = `inline-flex h-[var(--target)] shrink-0 cursor-pointer items-center rounded-full px-[calc(26*var(--cpx))] text-[length:var(--type-meta)] leading-tight whitespace-nowrap transition-colors duration-[320ms] ease-[var(--ease)] active:bg-sand ${FOCUS}`;
export const AT_REST = "font-medium text-ink-soft";
/** The option in force: ink at 600 over a 2 cpx ink rule (the Prep toggle's). */
export const IN_FORCE =
  "font-semibold text-ink underline decoration-ink decoration-[length:calc(2*var(--cpx))] underline-offset-[6px]";

/**
 * A hairline ring (DS §6, v1.16): what tells a word or a numeral that does
 * something from the words around it, since text alone didn't read as a
 * button (2026-10-06). 1 px, drawn inside the target so the ring is
 * what reaches the edge; sand fills it while pressed, and focus rings it.
 * Its shape and its colour are the caller's.
 */
export const RING =
  "outline-none transition-colors duration-[320ms] ease-[var(--ease)] before:absolute before:-z-10 before:border before:transition-colors before:duration-[320ms] before:ease-[var(--ease)] before:content-[''] active:before:bg-sand focus-visible:before:outline-3 focus-visible:before:outline-offset-3 focus-visible:before:outline-ink";

/**
 * An action word: a word that does something (Edit, Cookpacks, Import, Remove,
 * Mark as done, Add a note, Not now, Refresh), in a pill of hairline
 * on an 80 cpx target, the pill 52 cpx tall and 24 cpx past the word either
 * side. Choices among words stay ghost words, the one in force over a rule.
 */
export const ACTION = `relative isolate inline-flex h-[var(--target)] shrink-0 cursor-pointer items-center px-[calc(24*var(--cpx))] text-[length:var(--type-meta)] leading-tight whitespace-nowrap ${RING} before:inset-x-0 before:inset-y-[calc(14*var(--cpx))] before:rounded-full`;
/** An action word at rest: ink-soft in a ring of ink at 20%. */
export const ACTION_AT_REST = `${AT_REST} before:border-ink/[.2]`;
/** An action word in force (Edit on, the note open): word and ring in ink, the word at 600. */
export const ACTION_IN_FORCE = "font-semibold text-ink before:border-ink";

/**
 * The foot's one fill (DS §6): Finish, and the opening's Start (slice N2,
 * N2-10). A pill a target tall, 600 at the meta's size; the caller gives its
 * padding, its place on the row and its fill: ember while it is the next act,
 * `FOOT_FILL_WAITS` while it waits.
 */
export const FOOT_FILL = `inline-flex h-[var(--target)] shrink-0 cursor-pointer items-center rounded-full text-[length:var(--type-meta)] leading-tight font-semibold whitespace-nowrap transition-[background-color,color] duration-[320ms] ease-[var(--ease)] aria-disabled:cursor-default ${FOCUS}`;
/**
 * The fill waiting: sand with ink-soft words, as the one act does before it is
 * the next one (DS §1), while a timer rings or a save runs.
 */
export const FOOT_FILL_WAITS = "bg-sand text-ink-soft";
/** The fill at the row's end, on the cook view's edge (`--edge`), where the steps' words end, not on the row's padding. */
export const FOOT_FILL_END = "justify-self-end mr-[max(0px,calc(var(--edge)-20*var(--cpx)))]";
