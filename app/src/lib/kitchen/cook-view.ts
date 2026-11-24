/**
 * Cook view: the pure model behind the cook screen.
 *
 * The cook steps through a sequence of screens. In "As I go" that is a Prep
 * screen when the plan has mise or ahead work, then the flow cards from
 * `cook-schedule.ts`. In "Prep first" the prep is ordinary step pages
 * (`prepPages`; 2026-11-22, DS v1.59): one per prep card of the plan,
 * before the first cooking step, a card of several jobs as one page of tick
 * rows. The Prep screen then stands only for a plan with make-ahead work and
 * no mise (`hasPrepScreen`). This module owns the position, what counts as
 * done, and what each screen shows, so the rules the UI depends on are tested
 * without a DOM:
 *
 *   - the mode switches only at the first screen (`setMode`); the "Prep first
 *     | As I go" toggle shows on the Prep screen (and on the opening);
 *   - the stack is the current screen and the next two, the two ahead read
 *     as one-line glances, with a marker where the next chapter begins;
 *   - chapters (Prep, then batches of work that end where the cook's hands
 *     come free; `cook-chapters.ts`) read now, running, done or next from
 *     what the cook has done, not where they are;
 *   - Next from the Prep screen resumes at the first unfinished step, so a
 *     mid-cook mode switch never sends the cook back over finished work.
 *
 * Done is two sets:
 *
 *   - `ticked`: mise the cook ticked, on the Prep screen or on a prep page's
 *     tick rows. Leaving the Prep screen ticks, in "As I go", the part that
 *     comes before the first cooking step. Ticked mise is scheduled into the
 *     prep block, so in "As I go" it drops out of the steps; a prep page stays
 *     where it is, ticked or not.
 *   - `passed`: tasks on screens the cook has moved past, prep pages
 *     included. Landing on a screen (Back, a jump) reopens its tasks.
 *
 * Mode changes only at the first screen, and ticks only on the Prep screen
 * or the prep page in hand; everywhere else the sequence is fixed, which
 * keeps positions stable while the cook moves around.
 */

import {
  isCurrentCookPlan,
  leadMinutes,
  type CookPlan,
  type CookTask,
  type PrepMode,
} from "./cook-plan";
import { freeAfter, stretchesOf, type FreeTime } from "./cook-chapters";
import { flow, isPot, prepFlow, withMiseNeeds, type FlowItem } from "./cook-schedule";

/** The eyebrow's count: "last step" at the very end, else the steps left. */
function stretchCountWords(left: number, free: number | null): string {
  if (left === 1) return free === null ? "last step" : "this step";
  return `${left} steps`;
}

/** The eyebrow's place at its longest. */
function stretchPlaceWords(left: number, free: number | null): string {
  if (free !== null) return `${stretchCountWords(left, free)}, then about ${free} min free`;
  return left === 1 ? "last step" : `${left} steps to the table`;
}

/** Placeholder copy, awaiting a rewrite. */
export const COOK_COPY = {
  prepChapter: "Prep",
  /** A prep page's place among the plan's prep pages, after "Prep" in its eyebrow (DS v1.59). */
  prepPlace: (at: number, of: number) => `${at} of ${of}`,
  /** A tick row's own minutes on a prep page. */
  rowMinutes: (n: number) => `${n} min`,
  cookChapter: "Cook",
  prepTitle: "Get set up",
  whileLead: "Meanwhile,",
  thenLead: "Then",
  /** As I go: a task done while something cooks, named by what is cooking. */
  whileYou: (label: string) => `while you ${label}`,
  /** Prep first: a movable task that can wait for a window in the steps. */
  orWhen: (when: string) => `or ${when}`,
  nothingAhead: "Nothing needs doing ahead.",
  nothingBefore: "Nothing to do before you start.",
  beforeYouStart: "Before you start",
  laterHeading: "As you cook",
  laterMore: (n: number) => `${n} more ${n === 1 ? "comes" : "come"} up as you cook`,
  /**
   * Prep's folds (DS §5, the Prep screen), when it is taller than the stage:
   * the ticked rows folded into one line at the list's head, and the rows to
   * do past the edge.
   */
  miseDone: (n: number) => `${n} done`,
  miseMore: (n: number) => `${n} more`,
  /** With the ticked rows open, the rows to do as one line at the list's foot, which closes them. */
  miseToDo: (n: number) => `${n} to do`,
  /** The make-ahead work folded to one line, which opens it: a count of its tasks. */
  aheadFolded: (n: number) => `${n} to do ahead`,
  /** With one make-ahead group open, the others folded to one line, which closes it: a count of their tasks. */
  aheadOthers: (n: number) => `${n} more to do ahead`,
  /** The mise list folded to one line while make-ahead work is open. */
  miseCount: (todo: number, done: number) =>
    [todo > 0 && `${todo} to do`, done > 0 && `${done} done`].filter(Boolean).join(", "),
  pending: "Working out the prep…",
  failed: "No prep plan for this one",
  later: "The prep plan is ready for next time",
  modeGroup: "When to prep",
  prepFirst: "Prep first",
  asIGo: "As I go",
  missedAhead: "Missed it? Ask Sous",
  missedAheadMany: "Missed these? Ask Sous",
  /** The opening's Ahead note ends in the half that carries the meaning; its name says it whole (DECISIONS 2026-11-24). */
  missedAheadShort: "Missed it?",
  missedAheadManyShort: "Missed these?",
  aheadUntimed: "Ahead of time",
  assumed: "assumed",
  allAssumed: "The recipe doesn't list these; they're read from its steps.",
  noSteps: "This recipe has no steps.",
  back: "Previous step",
  forward: "Next step",
  /** Forward on a step that pages, with more of it to come. */
  forwardMore: "The rest of this step",
  /**
   * A pack recipe's typed steps (slice B5d, D8–D9). Placeholder copy,
   * awaiting a rewrite. Forward on a checkpoint confirms it.
   */
  looksRight: "Looks right",
  /** On a checkpoint: what to look for, the states' looks and the hints. */
  notYet: "Not yet",
  /** "Not yet" open: back to the check itself. */
  backToCheck: "Back to the check",
  /** A checkpoint passed before, on a return to it: a status, never a button. */
  checked: "Checked",
  /** A collapsed interlude, read before on this tablet: open it again. */
  readAgain: "Read it again",
  /** Before an interlude's title, for a screen reader. */
  aside: "Aside",
  finish: "Done cooking",
  finishFailed: "Not saved. Try again",
  /**
   * The quiet line once the app finished a cook left on its last screen
   * (cook-fidelity decision 7): said until the cook goes on or leaves.
   * Placeholder copy.
   */
  finishedNotPressed: "Logged as cooked, since nothing moved for a while. Carry on and it reopens.",
  /** The ledge on a borrowed screen: the way back to the steps. */
  backToCooking: "Back to cooking",
  /** A stretch's or a chart bar's state, read out after its name. */
  stateUnderWay: "under way",
  stateDone: "done",
  /** A peeked step not yet reached. */
  stateToCome: "to come",
  /**
   * Under a part of a step too long for one screen: forward shows the rest.
   * Placeholder copy (DECISIONS 2026-10-04, fix round 2).
   */
  continues: "Continues",
  /**
   * Where a part of a step too long for one screen stands among its parts.
   * "Part" is said, not left to the figures, since the eyebrow counts steps
   * ("Blend mole, 1 of 4" at the top). Said to a screen reader only: the
   * eyebrow's count is the screen's one drawn counter (V fix round 1).
   * Placeholder copy (DECISIONS 2026-10-04, fix round 2).
   */
  partPlace: (at: number, of: number) => `Part ${at} of ${of}`,
  /**
   * An ingredient's amount (slice B4 step 8). The conversions popover heads
   * what the recipe states, then what is computed from it.
   */
  statedHeading: "Recipe says",
  statedHeadingFor: (serves: number) => `Recipe says, for ${serves}`,
  conversionsHeading: "Conversions",
  /** On a scaled count's popover when rounding moved the number ("Exactly 5⅓"). */
  exactCount: (exact: string) => `Exactly ${exact}`,
  /** Beside an amount the app shows in the source's own words ("a pinch of"). */
  asWritten: "as written",
  asWrittenFor: (serves: number) => `as written, for ${serves}`,
  /** The scale suffix in the top line and on the opening's "Get out" head. */
  scaleNote: (servings: number) => `for ${servings}`,
  /** Prep's note while scaled: the plan's task text keeps the recipe's own numbers. */
  prepScaleNote: (serves: number) => `The steps keep the recipe's amounts, for ${serves}.`,
  /** Ask's context line when scaled. */
  askScaleContext: (servings: number, servesBase: number) =>
    `Cooking for ${servings}; the recipe serves ${servesBase}.`,
  /** The Ingredients sheet's how-much line for a line with no amount. */
  toTaste: "to taste — start small",
  unstated: "the recipe doesn't say",
  /**
   * The eyebrow's place (slice N2, N2-6): where the cook is in the stretch in
   * hand. `left` counts the stretch's screens from the step in hand on, that
   * step included; `free` is the break after it in minutes (`freeMinutes`),
   * null with no break ahead. Placeholder copy, awaiting a rewrite.
   */
  stretchPlace: stretchPlaceWords,
  /**
   * The place one step shorter: without "about". With no break ahead there is
   * no "about" to drop, so it is the long form.
   */
  stretchPlaceShort: (left: number, free: number | null) =>
    free === null
      ? stretchPlaceWords(left, free)
      : `${stretchCountWords(left, free)}, then ${free} min free`,
  /** The place at its shortest: the count alone. */
  stretchCount: stretchCountWords,
  /** A break's field at the stretch and the chart: the figure, then the word. */
  freeField: { minutes: (n: number) => `${n} min`, word: "free" },
  /** Whole recipe's divider between two stretches (N2-5). */
  freeDivider: (n: number) => `about ${n} min free`,
  /** The nudge on the last step before a break (N2-8). */
  stepAway: (n: number) => `After this step: about ${n} min free. Step away.`,
  /**
   * The walk-away line in the step's meta (look-ahead slice 1, DS v1.62; the approved drawing's
   * words): the break's minutes as said, with no "Step away." (the ruled row in the peek says it).
   */
  stepAwayMeta: (n: number) => `After this step: about ${n} min free.`,
  /** The peek's ruled rows (DS v1.62). One wording for a fold: "N more steps, then". */
  peekThen: "then",
  peekMore: (n: number) => `${n} more ${n === 1 ? "step" : "steps"}, then`,
  peekFree: (n: number) => `${n} min free`,
  peekWhile: (verb: string) => `while it ${verb}`,
  peekTable: "on the table",
  peekIn: (time: string) => `in about ${time}`,
  peekAfter: (label: string) => `after that: ${label}`,
  /** The strip's controls (DS v1.62): the line's own target, and the arrows on the sheet's edge. */
  peekExpand: "Show the whole cook",
  peekCollapse: "Put away",
  /** A running step's time left on the chart (N2-2): `time` as `hm` says it. */
  timeLeft: (time: string) => `${time} left`,
  /** A stretch over its span on the chart (N2-4). */
  stretchLabel: (n: number) => `${n} ${n === 1 ? "step" : "steps"}`,
  /** The opening's one ember (N2-10). */
  start: "Start",
  /** The look-ahead levels (P58, slice N; N2-1). */
  untilStepAway: "Until you can step away",
  wholeCook: "Whole cook",
  wholeRecipe: "Whole recipe",
  goToStep: "Go to this step",
  /** Prep read at the whole cook (slice N3): its Go. */
  goToPrep: "Go to Prep",
  youAreHere: "You're here",
  saySueBack: "Say “Sue, back”",
  saySueStop: "Say “Sue, stop”",
  saySueClose: "Say “Sue, close”",
  andMoreSteps: (n: number) => `and ${n} more ${n === 1 ? "step" : "steps"}`,
  /** The whole cook's fold line (slice N3): the steps folded, then their planned time. */
  andMoreStepsFor: (n: number, time: string) => `and ${n} more ${n === 1 ? "step" : "steps"}, ${time}`,
  /** Prep's card at the whole cook (slice N3): what is left, then Prep's minutes. */
  prepToDo: (n: number) => `${n} to do`,
  prepDone: "done",
  prepAllAsYouCook: "all as you cook",
  /** The opening's ingredient list heading. */
  getOut: "Get out",
  /** The opening's ahead work, before its notes (the timetable, SPEC §6). */
  ahead: "Ahead",
  /** The end of a list cut short (the opening's Get out). */
  andMore: (n: number) => `and ${n} more`,
  /** The strip map at the sheet's level 1 (SPEC §10): its words. */
  stripNow: "now",
  stripNext: "next",
  stripIn: (minutes: number) => `in ${minutes} min`,
  stripMore: (n: number) => `${n} more`,
  /** Under the time to the table, on the plate and in level 2's header. */
  toTheTable: "to the table",
  /** A derived plan's level 1, by name (the strip map; slice T3). As written it stays `untilStepAway`. */
  lookAhead: "Look ahead",
  /** As I go's saving, beside the old serve line for a moment after the switch (SPEC §11). */
  sooner: (time: string) => `${time} sooner`,
  /** The cook page for a recipe the app can't read as a pack recipe. */
  unreadable: "Couldn't read this recipe.",
} as const;

/**
 * Where the plan came from; an as-written plan says why on the first screen.
 * "later": a plan arrived after the cook had started, so it waits for the
 * next open.
 */
export type PlanSource =
  | { kind: "derived" }
  | { kind: "as-written"; reason: "pending" | "failed" | "later" };

export interface CookState {
  mode: PrepMode;
  /** Index into the screen sequence. */
  pos: number;
  ticked: ReadonlySet<string>;
  passed: ReadonlySet<string>;
  /**
   * Mise the cook unticked on the Prep screen. In "As I go", leaving Prep
   * leaves it open, to come back as a step, so Next never undoes an untick.
   * "Prep first" has no step for it to come back as, so there Next still
   * counts it done.
   */
  kept: ReadonlySet<string>;
}

/**
 * A screen of the sequence: the Prep screen, or a step. A step with `prep`
 * set is one of "Prep first"'s prep pages (`prepPages`), which stand before
 * the first cooking step and make up the Prep chapter.
 */
export type Screen = { kind: "prep" } | { kind: "step"; item: FlowItem; prep?: true };

export type ChapterState = "now" | "running" | "done" | "next";

/**
 * A chapter is Prep, or a stretch: the steps up to a break of 10+ idle
 * minutes (slice N2, `stretchesOf`). One derivation feeds the eyebrow, the
 * chart, Whole recipe's dividers and the report's `chapterId`.
 */
export interface Chapter {
  /**
   * "prep", or "stretch:{key}" keyed by the stretch's first screen. Ids follow
   * the screens, so a mode switch or a tick on Prep can change them.
   */
  id: string;
  /** The stretch's opening move; shown nowhere since N2, kept for reports. */
  name: string;
  /**
   * The break after the stretch, in plan minutes: from when the cook's hands
   * come free to the next stretch's first start, and its minutes as said
   * (`freeMinutes`). Null for Prep and the last stretch.
   */
  free: FreeTime | null;
  state: ChapterState;
  /**
   * Where the cook is inside the current chapter: the screen in hand, counted
   * from 1 in cook order, of the chapter's screens. Null on every other
   * chapter, and on a chapter of one screen, where "1 of 1" says nothing.
   */
  place: { at: number; of: number } | null;
  /** Screen positions in cook order that this chapter spans. */
  at: number[];
}

/**
 * Where the next chapter begins, marked above the first lookahead line that
 * belongs to it. `wait` is the natural break that ends the chapter before, in
 * minutes rounded to 5; null where the chapter was cut at the cap.
 */
export interface StackMarker {
  wait: number | null;
}

/** One line of the lookahead stack. */
export interface StackLine {
  /** "prep", or the screen's task ids joined with "+". */
  key: string;
  /** The Prep screen, a screen of mise only, or cooking. */
  kind: "prep" | "mise" | "cook";
  text: string;
  /**
   * The line as a one-line glance ahead: the step's label with its lead
   * ("Meanwhile, chop greens"), merged mise joining its labels. A recipe as
   * written has only mechanical labels (its steps' first words), so there the
   * glance is the step's text, which the stack ends in a word-ellipsis.
   */
  glance: string;
  /**
   * The step itself, with no lead: its label, merged mise joining its labels,
   * or as written its text. What a paged step's later parts head with, where
   * "Meanwhile" would say nothing.
   */
  name: string;
  /** Set on a lookahead line that opens the next chapter; null otherwise. */
  marker: StackMarker | null;
  ingredientIdx: number[];
  minutes: string | null;
  /** True when any task on the screen is assumed rather than in the recipe. */
  implied: boolean;
  /** Quiet household marginalia / author note penciled for this step. */
  marginalia?: string | null;
  /**
   * Set on a "Prep first" prep page (DS v1.59): its place among the plan's
   * prep pages, null where the plan has one (as a chapter of one screen says
   * no "1 of 1"), and its dish, null in a one-dish plan and for the planner's
   * generic branch. Unset on every other line, As I go's prep steps included.
   */
  prep?: { count: { at: number; of: number } | null; dish: string | null };
  /**
   * A prep page that merges several jobs: one tick row a job, in the page's
   * order. Unset on a page of one job, which reads as any step does.
   */
  rows?: PrepRow[];
}

/** One job of a merged prep page: a row the cook ticks. */
export interface PrepRow {
  id: string;
  text: string;
  ingredientIdx: number[];
  /** Its own minutes, short ("2 min"); null when the plan gave no estimate. */
  minutes: string | null;
  /** Read from the steps, not listed by the recipe. */
  implied: boolean;
  /** Done on the cook's record (`isDone`): ticked here, or passed in the steps. */
  done: boolean;
}

export interface PrepAhead {
  id: string;
  text: string;
  /** Short imperative ("soak the beans"), for "I was meant to …". */
  label: string;
  lead: string | null;
}

/** Ahead tasks sharing a lead, so the lead and the Ask are said once. */
export interface PrepAheadGroup {
  lead: string | null;
  items: PrepAhead[];
  /**
   * The group on one line, from the short labels ("grate garlic", "juice
   * lemon"), each kept whole on its line where it is drawn.
   */
  labels: string[];
}

export interface PrepMise {
  id: string;
  text: string;
  label: string;
  ingredientIdx: number[];
  implied: boolean;
  minutes: string | null;
  done: boolean;
  /**
   * Done before cooking starts, so ticked here: all of it in "Prep first";
   * in "As I go", the mise the schedule puts before the first cooking step.
   */
  before: boolean;
  /** As I go, for the rest: when the task comes up in the steps. */
  when: string | null;
}

export interface PrepContent {
  /**
   * Longest lead first, a need never after what needs it (`aheadGroups`);
   * a group's lead may be its dependent's where a stored plan's own is
   * shorter.
   */
  ahead: PrepAheadGroup[];
  /** Shown in place of the ahead list when there is nothing to do ahead. */
  aheadNote: string | null;
  mise: PrepMise[];
  /** As I go, when all the mise comes up in the steps: said in place of the ticks. */
  beforeNote: string | null;
  /** Said once, in place of a mark on every row, when all the mise is assumed. */
  assumedNote: string | null;
}

export interface CookView {
  /** How many screens the sequence has. */
  screens: number;
  pos: number;
  onPrep: boolean;
  showModeToggle: boolean;
  /** The cook runs the recipe as written (no plan yet, or none): its note's row stands (N2). */
  asWritten: boolean;
  /**
   * Prep, if any, then the stretches; null as written (no minutes to cut by)
   * and with no step screens.
   */
  chapters: Chapter[] | null;
  /**
   * The stretch in hand (N2-6): its screens left from the step in hand on,
   * that step included, and the break after it in minutes as said, null with
   * no break ahead. Null on Prep and as written.
   */
  stretch: { left: number; free: number | null } | null;
  /**
   * The eyebrow's place on its ladder, longest first (N2-6): "Prep" on Prep,
   * else the stretch words; null as written.
   */
  place: { long: string; short: string; count: string } | null;
  /** The step in hand, or Prep; null on a cook with no steps/screens. */
  now: StackLine | null;
  /** The stack containing now alone ([now]), kept for backwards compatibility. */
  stack: StackLine[];
  /** The Prep screen's content; null on every other screen. */
  prep: PrepContent | null;
  note: string | null;
  isLast: boolean;
  /** Optional plan, mode, and ticked references for phase and peek-step derivation. */
  plan?: CookPlan;
  mode?: PrepMode;
  ticked?: ReadonlySet<string>;
}

export function initialCookState(mode: PrepMode): CookState {
  return { mode, pos: 0, ticked: new Set(), passed: new Set(), kept: new Set() };
}

/** Whether the plan has prep at all: mise, or work to do ahead. */
export function hasPrep(plan: CookPlan): boolean {
  return plan.tasks.some((t) => t.kind === "mise" || t.kind === "ahead");
}

/**
 * Whether the sequence opens on the Prep screen. In "As I go", whenever the
 * plan has prep. In "Prep first" the mise is step pages instead
 * (`prepPages`), so the Prep screen stands only where there are none to
 * replace it: make-ahead work and no mise (DS v1.59).
 */
export function hasPrepScreen(plan: CookPlan, mode: PrepMode): boolean {
  if (!hasPrep(plan)) return false;
  return mode === "go" || !plan.tasks.some((t) => t.kind === "mise");
}

/** Most tick rows one prep page holds; a longer merged card runs on over pages of near-equal length. */
export const PREP_ROWS_MAX = 4;

const NOTHING_TICKED: ReadonlySet<string> = new Set();

/**
 * "Prep first"'s prep pages, in the order the prep block does them: one per
 * prep card of the plan (`prepFlow`, the cards As I go steps through and the
 * opening lists), a card of more than `PREP_ROWS_MAX` jobs cut into pages of
 * near-equal length. None in "As I go", where the mise comes up in the steps.
 * The pages never depend on what is ticked: in "Prep first" every mise task
 * is up front, so a tick moves nothing.
 */
export function prepPages(plan: CookPlan, mode: PrepMode): FlowItem[] {
  return mode === "first" ? prepFlow(plan, "first", NOTHING_TICKED, PREP_ROWS_MAX) : [];
}

/** How many screens stand before the first cooking step: the Prep screen, or the prep pages. */
export function prepScreenCount(plan: CookPlan, mode: PrepMode): number {
  return (hasPrepScreen(plan, mode) ? 1 : 0) + prepPages(plan, mode).length;
}

/** The Prep screen, if the sequence has one; "Prep first"'s prep pages; then the flow cards. */
export function screensOf(
  plan: CookPlan,
  mode: PrepMode,
  ticked: ReadonlySet<string>,
): Screen[] {
  const pages = prepPages(plan, mode).map((item): Screen => ({ kind: "step", item, prep: true }));
  const steps = flow(plan, mode, ticked).map(
    (item): Screen => ({ kind: "step", item }),
  );
  return hasPrepScreen(plan, mode) ? [{ kind: "prep" }, ...pages, ...steps] : [...pages, ...steps];
}

function stateScreens(plan: CookPlan, state: CookState): Screen[] {
  return screensOf(plan, state.mode, state.ticked);
}

function isUnfinished(screen: Screen, state: CookState): boolean {
  return (
    screen.kind === "step" &&
    screen.item.tasks.some(
      (t) => !state.passed.has(t.id) && !state.ticked.has(t.id),
    )
  );
}

/** Moves to `pos`, reopening the tasks on the screen it lands on. */
function land(screens: Screen[], state: CookState, pos: number): CookState {
  const screen = screens[pos];
  const passed = new Set(state.passed);
  if (screen.kind === "step") {
    for (const t of screen.item.tasks) passed.delete(t.id);
  }
  return { ...state, pos, passed };
}

/**
 * The mise done before cooking starts. In "As I go" that is the mise whose
 * card the schedule puts before the first card with cooking on it, placed as
 * if nothing were ticked, so the split holds still while the cook ticks.
 * With no cooking at all, it is all of it.
 */
export function miseBefore(plan: CookPlan, mode: PrepMode): Set<string> {
  const mise = plan.tasks.filter((t) => t.kind === "mise");
  if (mode === "first") return new Set(mise.map((t) => t.id));
  const cards = flow(plan, "go", new Set());
  const firstCook = cards.findIndex((c) => c.tasks.some((t) => t.kind === "cook"));
  const early = firstCook === -1 ? cards : cards.slice(0, firstCook);
  return new Set(early.flatMap((c) => c.tasks).filter((t) => t.kind === "mise").map((t) => t.id));
}

/**
 * Whether the Prep screen has work to do before Step 1 in `mode`: either
 * make-ahead tasks or mise scheduled before the first cook card. When false
 * (e.g. "As I go" with all mise inline and no make-ahead), Starting from the
 * opening skips the empty Prep screen and lands directly on Step 1.
 */
export function hasUpfrontPrep(plan: CookPlan, mode: PrepMode): boolean {
  return plan.tasks.some((t) => t.kind === "ahead") || miseBefore(plan, mode).size > 0;
}

/**
 * Leaving the Prep screen: the mise done before cooking counts as done (all
 * of it in "Prep first"; in "As I go", not what the cook unticked there),
 * and the cook resumes at the first unfinished step.
 */
function leavePrep(plan: CookPlan, state: CookState): CookState {
  const done = [...miseBefore(plan, state.mode)].filter(
    (id) => state.mode === "first" || !state.kept.has(id),
  );
  const ticked = new Set([...state.ticked, ...done]);
  const left = { ...state, ticked };
  // Ticked mise leaves the steps in As I go, so look for the resume point in
  // the screens as they stand once it is ticked.
  const screens = screensOf(plan, state.mode, ticked);
  const target = screens.findIndex((s) => isUnfinished(s, left));
  if (target !== -1) return { ...left, pos: target };
  // Nothing left unfinished: the first step, or Prep itself when it is all
  // there is, where the finish then shows.
  return { ...left, pos: Math.min(1, screens.length - 1) };
}

/**
 * Advances one screen. Leaving the Prep screen resumes at the first unfinished
 * step (and in "Prep first" counts all the mise as done). On the last screen
 * it does nothing; the UI shows Done instead.
 */
export function next(plan: CookPlan, state: CookState): CookState {
  const screens = stateScreens(plan, state);
  if (state.pos >= screens.length - 1) return state;
  const current = screens[state.pos];
  if (current.kind === "prep") return leavePrep(plan, state);

  const passed = new Set(state.passed);
  for (const t of current.item.tasks) passed.add(t.id);
  return { ...state, pos: state.pos + 1, passed };
}

export function back(plan: CookPlan, state: CookState): CookState {
  if (state.pos === 0) return state;
  return land(stateScreens(plan, state), state, state.pos - 1);
}

/**
 * Jumps to a screen (from All Steps or the map); out of range does nothing.
 * A jump away from Prep is looking around, not saying the prep is done, so
 * unlike Next it ticks nothing, even in "Prep first".
 */
export function jumpTo(plan: CookPlan, state: CookState, pos: number): CookState {
  const screens = stateScreens(plan, state);
  if (!Number.isInteger(pos) || pos < 0 || pos >= screens.length) return state;
  return land(screens, state, pos);
}

/**
 * Goes to a strip mark's screen, the chart's Go (N2). The strip numbers its
 * marks as the cook stands on leaving Prep (`rowState`): in As I go leaving
 * ticks the mise done before cooking, whose steps then go and the batches
 * recut, so on Prep a mark's screen counts those screens, not Prep's own.
 * A Go from Prep to a step therefore leaves Prep as Next does, then lands,
 * as the retired chapters menu's jump from Prep did (`leavePrep`); Prep's own
 * mark, and any Go from a step, is a plain `jumpTo`. Out of range does nothing.
 */
export function goToMark(plan: CookPlan, state: CookState, pos: number): CookState {
  const onPrep = stateScreens(plan, state)[state.pos]?.kind === "prep";
  if (!onPrep || pos === 0) return jumpTo(plan, state, pos);
  const left = leavePrep(plan, state);
  const screens = stateScreens(plan, left);
  if (!Number.isInteger(pos) || pos < 0 || pos >= screens.length) return state;
  return land(screens, left, pos);
}

/** Switches prep mode; only on the Prep screen. */
export function setMode(state: CookState, mode: PrepMode): CookState {
  if (state.pos !== 0 || state.mode === mode) return state;
  return { ...state, mode };
}

/** `id` and every mise task that needs it, transitively. */
function withMiseDependents(plan: CookPlan, id: string): Set<string> {
  const closed = new Set<string>([id]);
  for (let grew = true; grew; ) {
    grew = false;
    for (const t of plan.tasks) {
      const madeFrom = t.needs.some((n) => closed.has(n));
      if (t.kind === "mise" && !closed.has(t.id) && madeFrom) {
        closed.add(t.id);
        grew = true;
      }
    }
  }
  return closed;
}

/**
 * Ticks or unticks a mise task: on the Prep screen, or a row of the prep page
 * in hand (a page of one job has no rows, so nothing there ticks). Ticking
 * also ticks the mise it is made from; unticking also unticks the mise made
 * from it, and reopens any of those the cook passed in the steps, so "not
 * done yet" always sticks (in "As I go", through Next from Prep too). On the
 * Prep screen in "As I go" only the mise done before cooking ticks; the rest
 * is done in the steps.
 */
export function toggleTick(plan: CookPlan, state: CookState, id: string): CookState {
  const task = plan.tasks.find((t) => t.id === id);
  if (task?.kind !== "mise") return state;
  const here = stateScreens(plan, state)[state.pos];
  if (here?.kind === "prep") {
    if (!miseBefore(plan, state.mode).has(id)) return state;
  } else if (!(here?.prep && here.item.tasks.length > 1 && here.item.tasks.some((t) => t.id === id))) {
    return state;
  }
  const ticked = new Set(state.ticked);
  const passed = new Set(state.passed);
  const kept = new Set(state.kept);
  if (isDone(state, id)) {
    for (const d of withMiseDependents(plan, id)) {
      ticked.delete(d);
      passed.delete(d);
      kept.add(d);
    }
  } else {
    for (const n of withMiseNeeds(plan, [id])) {
      ticked.add(n);
      kept.delete(n);
    }
  }
  return { ...state, ticked, passed, kept };
}

/**
 * The screen showing a recipe step, for All Steps. A step done on the Prep
 * screen (upfront mise, ahead work) maps to it; null if nothing cites it.
 */
export function screenForSourceStep(
  plan: CookPlan,
  state: CookState,
  step: number,
): number | null {
  const screens = stateScreens(plan, state);
  const cites = (s: Screen) => s.kind === "step" && s.item.tasks.some((t) => t.sourceStep === step);
  // The cooking screen first: a step chopped on a prep page and cooked later is found where it is
  // cooked (the recipe's step is the cooking), and one that is only prepped on its prep page.
  const cooking = screens.findIndex((s) => cites(s) && !(s.kind === "step" && s.prep));
  if (cooking !== -1) return cooking;
  const pos = screens.findIndex(cites);
  if (pos !== -1) return pos;
  const cited = plan.tasks.some((t) => t.sourceStep === step);
  return cited && hasPrepScreen(plan, state.mode) ? 0 : null;
}

/**
 * The recipe steps the cook is on and has finished, for All Steps. A step is
 * done once every mise and cook task citing it is done, so a step whose
 * slicing is ticked but whose sauté is still to come stays open. Ahead work
 * has no done state here, so a step only ahead work cites is never marked.
 */
export function sourceStepStates(
  plan: CookPlan,
  state: CookState,
): { current: Set<number>; done: Set<number> } {
  const screen = stateScreens(plan, state)[state.pos];
  const current = new Set<number>();
  if (screen?.kind === "step") {
    for (const t of screen.item.tasks) {
      if (t.sourceStep !== null) current.add(t.sourceStep);
    }
  }

  const open = new Set<number>();
  const cited = new Set<number>();
  for (const t of plan.tasks) {
    if (t.kind === "ahead" || t.sourceStep === null) continue;
    cited.add(t.sourceStep);
    if (!isDone(state, t.id)) open.add(t.sourceStep);
  }
  const done = new Set(
    [...cited].filter((step) => !open.has(step) && !current.has(step)),
  );
  return { current, done };
}

/**
 * The ahead work a time line names (`time-line.ts`): what the Prep screen
 * opens with, since it sets how early the cook has to start. That is the
 * first make-ahead group, named by its longest job, under its shown lead.
 * Null without ahead work or a current plan.
 */
export function aheadFirst(value: unknown): { label: string; lead: string | null } | null {
  if (!isCurrentCookPlan(value)) return null;
  const ahead = value.tasks.filter((t) => t.kind === "ahead");
  if (ahead.length === 0) return null;
  const group = aheadGroups(value)[0];
  const est = (id: string) => ahead.find((t) => t.id === id)?.minutes?.est ?? 0;
  const longest = group.items.reduce((a, b) => (est(b.id) > est(a.id) ? b : a));
  return { label: lowerFirst(longest.label), lead: group.lead };
}

/** What the Prep screen asks Claude when the cook missed ahead work. */
export function missedAheadQuestion(group: PrepAheadGroup): string {
  const when = group.lead ?? "ahead";
  const tail = "What's the quickest way through?";
  if (group.items.length === 1) {
    return `I was meant to ${group.items[0].label} ${when} and didn't. ${tail}`;
  }
  const labels = group.items.map((a) => a.label).join("; ");
  return `I was meant to do these ${when} and didn't: ${labels}. ${tail}`;
}

/**
 * The opening's one ask for all the make-ahead work, the last words of its Ahead note (DECISIONS
 * 2026-11-24): what the Prep screen's shortcut says and asks for one group, its words picked as Prep
 * picks them ("Missed it? Ask Sous" for one job, "Missed these? Ask Sous" for several). The note
 * draws their first half (`words`), which fits on one line of Get out's column; `label` is the name
 * it is said by. Where the work has several leads, each group is named with its own.
 */
export function missedAheadAsk(groups: readonly PrepAheadGroup[]): { label: string; words: string; question: string } {
  const jobs = groups.reduce((n, g) => n + g.items.length, 0);
  const label = jobs === 1 ? COOK_COPY.missedAhead : COOK_COPY.missedAheadMany;
  const words = jobs === 1 ? COOK_COPY.missedAheadShort : COOK_COPY.missedAheadManyShort;
  if (groups.length === 1) return { label, words, question: missedAheadQuestion(groups[0]) };
  const and = (labels: readonly string[]) =>
    labels.length === 1 ? labels[0] : `${labels.slice(0, -1).join(", ")} and ${labels[labels.length - 1]}`;
  const parts = groups.map((g) => `${and(g.items.map((a) => a.label))} ${g.lead ?? "ahead"}`);
  return { label, words, question: `I was meant to do these ahead and didn't: ${parts.join("; ")}. What's the quickest way through?` };
}

/**
 * The step in hand, for Ask Claude's quick questions: on the Prep screen the
 * prep still to do before cooking (its heading is no step to ask about), else
 * the current line.
 */
export function askStepText(view: CookView): string | undefined {
  if (view.prep) {
    const open = view.prep.mise.filter((m) => m.before && !m.done).map((m) => m.text);
    return open.length > 0 ? open.join("; ") : undefined;
  }
  return view.stack[0]?.text;
}

/**
 * What a screen reader hears as a look-ahead level settles: the level, and
 * the way back by voice only where voice hears "Sue" unasked (listening all
 * the time). Where a tap starts each listen, voice is off or there is no
 * mic, saying "Sue, back" to the room does nothing, so it names the level
 * alone.
 */
export function levelSaid(level: string, listening: boolean): string {
  return listening ? `${level}. ${COOK_COPY.saySueBack}` : `${level}.`;
}

/** One prep job as Sous is told it: its words, the amounts the cook reads, and whether it is ticked. */
export interface AskPrepJob {
  text: string;
  amounts: string[];
  done: boolean;
}

/** The cook is in prep, on these jobs: what Sous is told in place of a step of the recipe. */
export interface AskPrep {
  jobs: AskPrepJob[];
}

/**
 * The prep in hand, where the screen is prep: the jobs the panel's "About
 * this step" line names (`askStepText`), each with its ingredients as the
 * cook reads them. A "Prep first" prep page gives its jobs, ticked or not;
 * As I go's Prep screen gives the jobs still to do before cooking. Undefined
 * on every other screen, As I go's prep that comes up in the steps included:
 * the cook is cooking by then.
 *
 * `ingredients` is the recipe's lines by stored index, null for a blank one.
 */
function askPrep(view: CookView, ingredients: readonly (string | null)[]): AskPrep | undefined {
  const amounts = (idx: readonly number[]) =>
    idx.flatMap((i) => {
      const line = ingredients[i];
      return line === null || line === undefined ? [] : [line];
    });
  if (view.prep) {
    return {
      jobs: view.prep.mise
        .filter((m) => m.before && !m.done)
        .map((m) => ({ text: m.text, amounts: amounts(m.ingredientIdx), done: false })),
    };
  }
  const page = view.now;
  if (!page?.prep) return undefined;
  return {
    jobs: page.rows
      ? page.rows.map((r) => ({ text: r.text, amounts: amounts(r.ingredientIdx), done: r.done }))
      : [{ text: page.text, amounts: amounts(page.ingredientIdx), done: false }],
  };
}

/**
 * What Ask is told the cook has in hand: the screen's words (`askStepText`)
 * and either the recipe step it cites or, on prep, the prep jobs. On the
 * opening that is nothing: the whole cook shows there and no step is begun,
 * so Ask neither says "About this step" nor tells Sous which step the cook
 * is on, though the view under the opening is already the first screen's.
 *
 * On prep no step is given, whatever the jobs cite (review round 3): a prep
 * job cites the step it gets ready for, which the cook has not reached, and
 * Sous reads a step in hand as every step before it done.
 */
export function askInHand(
  opening: boolean,
  view: CookView,
  stepIndex: number | undefined,
  ingredients: readonly (string | null)[] = [],
): { text: string | undefined; index: number | undefined; prep: AskPrep | undefined } {
  if (opening) return { text: undefined, index: undefined, prep: undefined };
  const prep = askPrep(view, ingredients);
  return { text: askStepText(view), index: prep ? undefined : stepIndex, prep };
}

/**
 * Keeps a number (digits or a vulgar fraction) on the line with the word
 * after it, so a wrap never leaves "1" at a line end and "cup" on the next.
 */
export function bindNumbers(text: string): string {
  return text.replace(/([\d\u00bc-\u00be\u2150-\u215e])\s+(?=\S)/g, "$1\u00a0");
}

/**
 * Ingredients already in the dish: those of passed cook tasks. Prepped mise
 * is still waiting on the board, so it does not count.
 */
export function usedIngredients(plan: CookPlan, state: CookState): Set<number> {
  const used = new Set<number>();
  for (const t of plan.tasks) {
    if (t.kind === "cook" && state.passed.has(t.id)) {
      for (const i of t.ingredientIdx) used.add(i);
    }
  }
  return used;
}

function hoursText(minutes: number): string {
  const halves = Math.round(minutes / 30);
  const whole = Math.floor(halves / 2);
  const half = halves % 2 === 1;
  return half ? `${whole}½ hours` : `${whole} ${whole === 1 ? "hour" : "hours"}`;
}

/** "About 15 minutes, mostly hands-free": estimates the way a cook says them. */
export function minutesLabel(est: number, handsOff: boolean): string {
  const minutes = Math.max(1, Math.round(est));
  const span =
    minutes < 60
      ? `${minutes} ${minutes === 1 ? "minute" : "minutes"}`
      : hoursText(minutes);
  return `About ${span}${handsOff ? ", mostly hands-free" : ""}`;
}

/** The label for a run of tasks; null if any lacks an estimate. */
function minutesFor(tasks: CookTask[]): string | null {
  if (tasks.length === 0 || tasks.some((t) => !t.minutes)) return null;
  const est = tasks.reduce((sum, t) => sum + t.minutes!.est, 0);
  return minutesLabel(est, tasks.every((t) => t.minutes!.handsOff));
}

function lowerFirst(text: string): string {
  return /^[A-Z][a-z]/.test(text) ? text[0].toLowerCase() + text.slice(1) : text;
}

function sentenceCase(text: string): string {
  return text.length === 0 ? text : text[0].toUpperCase() + text.slice(1);
}

/** Clauses as one run: "Slice a, mince b, and cut c", no closing stop. */
function joinClauses(parts: string[]): string {
  const clauses = parts.map((p, i) => {
    const bare = p.trim().replace(/[.;,]+$/, "");
    return i === 0 ? bare : lowerFirst(bare);
  });
  return clauses.length === 1
    ? clauses[0]
    : clauses.length === 2
      ? clauses.join(" and ")
      : `${clauses.slice(0, -1).join(", ")}, and ${clauses[clauses.length - 1]}`;
}

/** Merged mise reads as one sentence: "Slice a, mince b, and cut c." */
function joinSentence(parts: string[]): string {
  return `${joinClauses(parts)}.`;
}

function unique(values: number[]): number[] {
  return [...new Set(values)];
}

/** A step's key: its tasks' ids joined with "+", as the stack and the map name it. */
export function stepKey(item: FlowItem): string {
  return item.tasks.map((t) => t.id).join("+");
}

/** Tasks as one line: a task as written, or several as one sentence. */
function tasksText(tasks: CookTask[]): string {
  return tasks.length === 1 ? tasks[0].text : joinSentence(tasks.map((t) => t.text));
}

/**
 * A step's own words, with no lead: what the map reads in place, where
 * "Meanwhile" and "Then" would be relative to the step you're on, not the
 * one read.
 */
export function stepBody(item: FlowItem): string {
  return tasksText(item.tasks);
}

/** Where a glance comes from: the plan's labels, or a recipe as written's text. */
export type GlanceFrom = "label" | "text";

/**
 * A step's name: its glance with no lead ("Heat ghee", not "Meanwhile, heat
 * ghee"), which names it wherever the cook stands, as the reports panel's
 * rows do.
 */
export function stepName(item: FlowItem, glanceFrom: GlanceFrom): string {
  return sentenceCase(
    glanceFrom === "label" ? joinClauses(item.tasks.map((t) => t.label)) : tasksText(item.tasks),
  );
}

/**
 * A step as the stack says it. "Meanwhile" stays on the step you're on, since
 * something is still cooking; "Then" only reads ahead, as directions say it.
 * The glance takes the same lead.
 */
export function stepLine(
  item: FlowItem,
  current: boolean,
  glanceFrom: GlanceFrom = "label",
  lead: FlowItem["lead"] = item.lead,
): StackLine {
  const { tasks } = item;
  const led = (body: string) =>
    lead === "while"
      ? `${COOK_COPY.whileLead} ${lowerFirst(body)}`
      : lead === "then" && !current
        ? `${COOK_COPY.thenLead} ${lowerFirst(body)}`
        : sentenceCase(body);
  const body = tasksText(tasks);
  const name = glanceFrom === "label" ? joinClauses(tasks.map((t) => t.label)) : body;
  return {
    key: stepKey(item),
    kind: tasks.every((t) => t.kind === "mise") ? "mise" : "cook",
    text: lead === null || (lead === "then" && current) ? body : led(body),
    glance: led(name),
    name: sentenceCase(name),
    marker: null,
    ingredientIdx: unique(tasks.flatMap((t) => t.ingredientIdx)),
    minutes: minutesFor(tasks),
    implied: tasks.some((t) => t.implied),
  };
}

/** Ticked on the Prep screen, or passed in the steps. */
export function isDone(state: CookState, id: string): boolean {
  return state.ticked.has(id) || state.passed.has(id);
}

/** The mise still to do on the Prep screen; in As I go the rest comes up in the steps. */
function prepRemaining(plan: CookPlan, state: CookState): CookTask[] {
  const before = miseBefore(plan, state.mode);
  return plan.tasks.filter((t) => before.has(t.id) && !isDone(state, t.id));
}

function prepLine(plan: CookPlan, state: CookState): StackLine {
  return {
    key: "prep",
    kind: "prep",
    text: COOK_COPY.prepTitle,
    glance: COOK_COPY.prepTitle,
    name: COOK_COPY.prepTitle,
    marker: null,
    ingredientIdx: [],
    minutes: minutesFor(prepRemaining(plan, state)),
    implied: false,
  };
}

/**
 * The Prep screen read in place, from the map's prep band: its title and the
 * mise still to do there as one sentence ("Get set up: grate the cucumber,
 * and slice the onion."), or the title alone once it is all done.
 */
export function prepSummary(
  plan: CookPlan,
  state: CookState,
): { text: string; minutes: string | null } {
  const remaining = prepRemaining(plan, state);
  return {
    text:
      remaining.length === 0
        ? COOK_COPY.prepTitle
        : `${COOK_COPY.prepTitle}: ${lowerFirst(tasksText(remaining))}`,
    minutes: minutesFor(remaining),
  };
}

/** A chapter as the screens make it, before the cook's record is read. */
interface ChapterSpan {
  id: string;
  name: string;
  /** Its screens' positions, in cook order. */
  at: number[];
  /** The tasks whose doing makes it done. */
  tasks: string[];
  /** The break after it; null for Prep and the last stretch. */
  free: FreeTime | null;
}

/**
 * Prep, then the steps cut into stretches at their breaks (`cook-chapters.ts`).
 * A stretch is named by its opening move, the label of its first cooking task
 * (its first task when it is all mise); a plan with one stretch calls it
 * "Cook". The name is for reports only (N2-12).
 */
function chapterSpans(plan: CookPlan, screens: Screen[]): ChapterSpan[] {
  const spans: ChapterSpan[] = [];
  // Prep is the Prep screen, or "Prep first"'s prep pages: the screens before
  // the first cooking step.
  const firstCooking = screens.findIndex((s) => s.kind === "step" && !s.prep);
  const offset = firstCooking === -1 ? screens.length : firstCooking;
  if (offset > 0) {
    spans.push({
      id: "prep",
      name: COOK_COPY.prepChapter,
      at: screens.slice(0, offset).map((_, i) => i),
      tasks: plan.tasks.filter((t) => t.kind === "mise").map((t) => t.id),
      free: null,
    });
  }
  const items = screens.slice(offset).map(itemOf);
  const stretches = stretchesOf(items);
  for (const stretch of stretches) {
    const run = items.slice(stretch.start, stretch.end);
    const tasks = run.flatMap((item) => item.tasks);
    const opener = tasks.find((t) => t.kind === "cook") ?? tasks[0];
    spans.push({
      id: `stretch:${stepKey(run[0])}`,
      name: stretches.length === 1 ? COOK_COPY.cookChapter : sentenceCase(opener.label),
      at: run.map((_, i) => stretch.start + i + offset),
      tasks: tasks.map((t) => t.id),
      free: freeAfter(items, stretch),
    });
  }
  return spans;
}

/**
 * A chapter reads from the cook's record, not its place: a chapter a jump
 * skipped stays to come, one passed before a jump back stays done, and Prep
 * is done when the mise is, wherever the mode put it. Running is a chapter
 * part done, and Prep with no mise to tick reads done once the cook is past it.
 */
function chaptersOf(plan: CookPlan, state: CookState, screens: Screen[]): Chapter[] | null {
  const spans = chapterSpans(plan, screens);
  if (!spans.some((s) => s.id !== "prep")) return null;
  const now = cookNow(plan, state);

  return spans.map(({ id, name, at, tasks, free }) => ({
    id,
    name,
    free,
    at,
    state: chapterState(state, at, tasks, at.map((i) => screens[i]), now),
    place:
      at.length > 1 && at.includes(state.pos)
        ? { at: at.indexOf(state.pos) + 1, of: at.length }
        : null,
  }));
}

/**
 * A chapter whose tasks are all done still runs while one of its pots does:
 * a lone hands-off step (`isPot`) still going at the minute the cook is at, the rule
 * the map's running bar reads (`cook-map.ts`).
 */
function chapterState(
  state: CookState,
  at: number[],
  tasks: string[],
  screens: Screen[],
  now: number,
): ChapterState {
  if (at.includes(state.pos)) return "now";
  if (tasks.length === 0) return at.some((i) => i < state.pos) ? "done" : "next";
  const done = tasks.filter((t) => isDone(state, t)).length;
  if (done > 0 && done < tasks.length) return "running";
  if (done === 0) return "next";
  const potGoing = screens.some(
    (s) => s.kind === "step" && isPot(s.item) && s.item.start <= now && now < s.item.end,
  );
  return potGoing ? "running" : "done";
}

/**
 * The minute the cook is at: the current step's start. On the Prep screen it
 * is 0, until the cook comes back to Prep mid-cook: then it is where Next
 * resumes, since that is where the cook is in the dish.
 */
export function cookNow(plan: CookPlan, state: CookState): number {
  const screens = stateScreens(plan, state);
  const here = screens[state.pos];
  if (here?.kind === "step") return here.item.start;
  const revisit = screens.some(
    (s) => s.kind === "step" && s.item.tasks.every((t) => isDone(state, t.id)),
  );
  if (!revisit) return 0;
  const resume = screens[next(plan, state).pos];
  return resume?.kind === "step" ? resume.item.start : 0;
}

/** As I go: when a mise task comes up — inside a hands-off window, or before its first use. */
function whenInSteps(task: CookTask, plan: CookPlan, screens: Screen[]): string | null {
  const screenOf = (id: string) =>
    screens.findIndex(
      (s) => s.kind === "step" && s.item.tasks.some((t) => t.id === id),
    );
  const own = screens[screenOf(task.id)];
  if (own?.kind === "step" && own.item.during) {
    return COOK_COPY.whileYou(lowerFirst(own.item.during.label));
  }

  const firstUse = plan.tasks
    .filter((t) => t.needs.includes(task.id))
    .map((t) => ({ t, at: screenOf(t.id) }))
    .filter(({ at }) => at !== -1)
    .sort((a, b) => a.at - b.at)[0];
  return firstUse ? `before you ${firstUse.t.label}` : null;
}

/**
 * A lead's unit of time as a recipe writes it, abbreviated ("30 min", "2 hr",
 * "2 hrs") or not: the words the plan's lead bound reads (`cook-plan`'s
 * LEAD_UPPER_BOUND_RE). A regex source, for `aheadLead` and the time line.
 */
export const LEAD_UNIT = String.raw`min(?:ute)?s?|h(?:ou)?rs?|days?|nights?|weeks?`;

/** A lead that stops at its unit ("at least 4 hours", "30 min"). */
const UNIT_END_RE = new RegExp(String.raw`\b(?:${LEAD_UNIT})$`, "i");

/** Words for the cook's own day, in a lead. */
const SAME_DAY_RE = /\b(?:on\s+the|that|in\s+the|the\s+same)\s+day\b/i;

/**
 * A make-ahead lead as the cook reads it. Ahead work is all before the cook,
 * so a lead that stops at its duration ("at least 4 hours") means the same
 * as one that says so ("at least 4 hours before"): it reads with "before",
 * and the two are one wait, one group (DECISIONS 2026-10-04, fix round 2).
 * A lead meaning the cook's own day ("on the day", "earlier in the day", "the
 * same day", or an alternative holding one) gets no "before", which would
 * say the day before. Waits are read from the recipe's lead, never these
 * words (review fix rounds 3 and 4).
 */
function aheadLead(lead: string | undefined): string | null {
  if (!lead) return null;
  return UNIT_END_RE.test(lead) && !SAME_DAY_RE.test(lead)
    ? `${lead} before`
    : lead;
}

const QUARTERS = ["", "¼", "½", "¾"];

/**
 * A need's lead counted back from its dependent's rather than from the start
 * of the cook, as one lead from the start: the two waits added, `minutes` in
 * all. Under an hour it reads in minutes; whole days in days ("3 days
 * before"); otherwise in hours, rounded up to the quarter hour, never down,
 * so the cook isn't told to start late. Rounded, it says "about", since the
 * cook may start a little later than it says; exact, it says "at least" if
 * either lead does (DECISIONS 2026-10-04, review fix rounds 1 and 2).
 */
function addedLead(minutes: number, atLeast: boolean): string {
  let span: string;
  let shown: number;
  if (minutes < 60) {
    shown = Math.ceil(minutes);
    span = `${shown} ${shown === 1 ? "minute" : "minutes"}`;
  } else if (minutes % 1440 === 0) {
    shown = minutes;
    span = `${minutes / 1440} ${minutes === 1440 ? "day" : "days"}`;
  } else {
    shown = Math.ceil(minutes / 15) * 15;
    const [whole, quarter] = [Math.floor(shown / 60), (shown % 60) / 15];
    span = quarter === 0 && whole === 1 ? "1 hour" : `${whole}${QUARTERS[quarter]} hours`;
  }
  const prefix = shown !== minutes ? "about " : atLeast ? "at least " : "";
  return `${prefix}${span} before`;
}

const AT_LEAST_RE = /\bat\s+least\b/i;

/**
 * Ids in an order where every need comes before what needs it, plan order
 * breaking ties. The parser rejects a cycle, so every id is placed; any left
 * over would follow in plan order rather than be lost.
 */
function needsOrder(tasks: CookTask[]): string[] {
  const ids = new Set(tasks.map((t) => t.id));
  const waiting = new Map(
    tasks.map((t) => [t.id, t.needs.filter((n) => ids.has(n)).length]),
  );
  const placed: string[] = [];
  const done = new Set<string>();
  while (placed.length < tasks.length) {
    const next =
      tasks.find((t) => !done.has(t.id) && waiting.get(t.id) === 0) ??
      tasks.find((t) => !done.has(t.id))!;
    placed.push(next.id);
    done.add(next.id);
    for (const t of tasks) {
      if (t.needs.includes(next.id)) waiting.set(t.id, waiting.get(t.id)! - 1);
    }
  }
  return placed;
}

/**
 * The make-ahead groups, ordered so the cook never reads work before what it
 * needs. A lead counts back from the start of the cook; a plan stored before
 * that rule (`lead-order`) may count a need's lead back from the task using
 * it instead ("soften butter, 1 hour before" the creaming, done "at least 2
 * hours before"). So a need whose own lead is shorter shows the two added
 * ("at least 3 hours before"), counted from its nearest dependents with a
 * readable lead, through any without one; one with no lead, or the same wait
 * said differently by a direct dependent, shows its dependent's; a longer or
 * unreadable one keeps its own words. Minutes are read from the recipe's
 * leads, never from the words shown. One shown lead is one group unless that
 * would loop the groups, when it shows twice. Groups run by the longest
 * readable lead each holds up (its own,
 * or any group's waiting on it), so readable leads never go up down the list
 * unless a need forces it; leads that can't be read and hold up nothing
 * readable follow, then untimed work. Only a plan whose needs loop (which the
 * parser rejects) can still loop the groups; then every item is one untimed
 * group in needs order, since no one lead is true of all of them.
 * Items keep their own lead; within a group they run in needs order.
 */
export function aheadGroups(plan: CookPlan): PrepAheadGroup[] {
  const tasks = plan.tasks.filter((t) => t.kind === "ahead");
  const order = needsOrder(tasks);
  const rank = new Map(order.map((id, i) => [id, i]));
  const byId = new Map(tasks.map((t) => [t.id, t]));
  const item = (t: CookTask): PrepAhead => ({
    id: t.id,
    text: t.text,
    label: t.label,
    lead: aheadLead(t.lead),
  });

  // Dependents first, so each need sees its dependents' shown leads. A shown
  // lead keeps its exact minutes beside its words, so a chain adds the exact
  // waits and rounds once, at the end.
  type Shown = { lead: string | null; min: number | null; atLeast: boolean };
  const shown = new Map<string, Shown>();
  const dependentsOf = (id: string) => tasks.filter((t) => t.needs.includes(id));
  for (const id of [...order].reverse()) {
    const own = aheadLead(byId.get(id)!.lead);
    // Minutes come from the recipe's words, never from the words shown.
    const ownMin = leadMinutes(byId.get(id)!.lead);
    const ownAtLeast = own !== null && AT_LEAST_RE.test(own);
    // A need with no lead of its own shows its direct dependent's: the one
    // that starts first, else the first.
    let direct: Shown | undefined;
    for (const d of dependentsOf(id)) {
      // Not yet shown only where the needs loop, and then (needsOrder breaks
      // a loop at the first task in plan order) never after a shown one, so
      // skipping it changes nothing today; it keeps the read below safe if
      // that order ever changes (review fix round 4).
      const s = shown.get(d.id);
      if (s === undefined) continue;
      if (direct === undefined || (s.min !== null && (direct.min === null || s.min > direct.min))) {
        direct = s;
      }
    }
    // A timed need counts from the nearest dependents whose lead can be read,
    // through any that can't, as the parser's lead-order check does; of those,
    // from the one that starts first.
    let target: (Shown & { direct: boolean }) | undefined;
    const seen = new Set<string>();
    const queue = dependentsOf(id).map((d) => ({ id: d.id, direct: true }));
    while (queue.length > 0) {
      const next = queue.shift()!;
      if (seen.has(next.id)) continue;
      seen.add(next.id);
      const s = shown.get(next.id);
      if (s === undefined) continue;
      // Through any dependent whose own lead can't be read, as the parser
      // reads, even one showing a lead it borrowed: what that lead came from
      // is reached anyway, and a longer wait may sit beyond it (B5a).
      if (s.min === null || leadMinutes(byId.get(next.id)!.lead) === null) {
        // A dependent with no lead at all only passes its dependent's on, so
        // what lies beyond it is as direct as it was (B5a verify round 1:
        // "a day ahead" and "the day before" through a lead-less task stay
        // one wait on one line).
        const passes = next.direct && !byId.get(next.id)!.lead;
        for (const d of dependentsOf(next.id)) queue.push({ id: d.id, direct: passes });
      } else if (target === undefined || s.min > target.min! || (s.min === target.min && next.direct)) {
        target = { ...s, direct: next.direct };
      }
    }
    let s: Shown = { lead: own, min: ownMin, atLeast: ownAtLeast };
    if (own === null) {
      if (direct !== undefined) s = direct;
    } else if (ownMin !== null && target !== undefined) {
      if (ownMin < target.min!) {
        const min = ownMin + target.min!;
        const atLeast = ownAtLeast || target.atLeast;
        s = { lead: addedLead(min, atLeast), min, atLeast };
      } else if (ownMin === target.min && target.direct) {
        // The same wait said differently: one wait, one group.
        s = target;
      }
    }
    shown.set(id, s);
  }

  // One lead is one group, unless joining it would loop the groups: work
  // under another lead between two "1 hour before" tasks, or two chains that
  // cross ("the morning of" → "1 hour", "1 hour" → "the morning of"). One
  // group would then sit both above and below other work, so the lead shows
  // again. Tasks go in needs order, so checking a task's own needs is enough:
  // it may join a group unless that group already leads, through the groups,
  // to one holding something it needs.
  //
  // A lead that can't be read joins its group blind to the waits around it,
  // so two "on the day" tasks, one needing an hour's work and one needed by
  // six hours' work, would put the hour above the six hours. Such a group's
  // tasks then each show their lead alone (`apart`), and the groups are
  // drawn again (slice V; KNOWN-ISSUES, "A shorter make-ahead lead can sit
  // above a longer one", closed).
  const apart = new Set<string>();
  const draw = () => {
    const groups: PrepAheadGroup[] = [];
    const groupOf = new Map<string, PrepAheadGroup>();
    const groupMin = new Map<PrepAheadGroup, number | null>();
    const before = new Map<PrepAheadGroup, Set<PrepAheadGroup>>();
    const alone = new Set<PrepAheadGroup>();
    const leadsTo = (from: PrepAheadGroup, to: PrepAheadGroup): boolean => {
      const seen = new Set<PrepAheadGroup>();
      const stack = [from];
      while (stack.length > 0) {
        const g = stack.pop()!;
        if (g === to) return true;
        if (seen.has(g)) continue;
        seen.add(g);
        for (const [d, froms] of before) if (froms.has(g)) stack.push(d);
      }
      return false;
    };
    for (const id of order) {
      const { lead, min } = shown.get(id)!;
      const needGroups = byId.get(id)!.needs.flatMap((n) => groupOf.get(n) ?? []);
      let group = apart.has(id)
        ? undefined
        : groups.find(
            (g) =>
              !alone.has(g) && g.lead === lead && needGroups.every((h) => h === g || !leadsTo(g, h)),
          );
      if (!group) {
        group = { lead, items: [], labels: [] };
        groups.push(group);
        groupMin.set(group, min);
        before.set(group, new Set());
        if (apart.has(id)) alone.add(group);
      } else if (min !== null && (groupMin.get(group) === null || min > groupMin.get(group)!)) {
        groupMin.set(group, min);
      }
      group.items.push(item(byId.get(id)!));
      groupOf.set(id, group);
      for (const h of needGroups) if (h !== group) before.get(group)!.add(h);
    }
    // A need placed after its dependent (only in a plan whose needs loop,
    // which the parser rejects) adds its edge here.
    for (const t of tasks) {
      for (const n of t.needs) {
        const from = groupOf.get(n);
        const to = groupOf.get(t.id)!;
        if (from && from !== to) before.get(to)!.add(from);
      }
    }
    return { groups, groupOf, groupMin, before };
  };
  // The longest readable lead a task holds up, task by task: its own shown
  // lead's, or that of any ahead task needing it, however far down. Unlike a
  // group's, this never borrows from a task it only shares a line with.
  const taskHolds = new Map<string, number | null>();
  const taskHoldOf = (id: string, seen: Set<string>): number | null => {
    if (taskHolds.has(id)) return taskHolds.get(id)!;
    let most = shown.get(id)!.min;
    seen.add(id);
    for (const d of dependentsOf(id)) {
      if (seen.has(d.id)) continue;
      const m = taskHoldOf(d.id, seen);
      if (m !== null && (most === null || m > most)) most = m;
    }
    seen.delete(id);
    taskHolds.set(id, most);
    return most;
  };

  let drawn = draw();
  for (;;) {
    splitUnreadable();
    const sorted = sortGroups(drawn);
    if (sorted === null) {
      // Only a plan whose needs loop (which the parser rejects) gets here.
      const all = order.map((id) => item(byId.get(id)!));
      return [{ lead: null, items: all, labels: all.map((a) => lowerFirst(a.label)) }];
    }
    // A shared line can still hold a shorter lead above a longer one (B5a;
    // the B4 verifier's repro, KNOWN-ISSUES "A restated lead can sit above a
    // longer one…"): a task with no lead shows its dependent's ("1 hour
    // before") and shares that line, while a 6-hour task needs it through
    // leads that can't be read. The line then holds the 6 hours, and so does
    // everything the other task on it needs, shown above them. A line whose
    // tasks hold up different waits across such a break goes apart, and the
    // groups are drawn again.
    const breaksAt: number[] = [];
    const heldBy = (g: PrepAheadGroup) =>
      Math.max(-1, ...g.items.map((a) => taskHoldOf(a.id, new Set()) ?? -1));
    for (let i = 0; i < sorted.length; i++) {
      const a = drawn.groupMin.get(sorted[i]);
      if (a === null || a === undefined) continue;
      for (let j = i + 1; j < sorted.length; j++) {
        const b = drawn.groupMin.get(sorted[j]);
        if (b !== null && b !== undefined && a < b && heldBy(sorted[i]) < b) breaksAt.push(b);
      }
    }
    const culprits = breaksAt.length === 0 ? [] : drawn.groups.filter((g) => {
      if (g.items.length < 2) return false;
      const held = g.items.map((a) => taskHoldOf(a.id, new Set()) ?? -1);
      return breaksAt.some((b) => Math.max(...held) >= b && Math.min(...held) < b);
    });
    if (culprits.length === 0) return finish(sorted);
    for (const g of culprits) for (const a of g.items) apart.add(a.id);
    drawn = draw();
  }

  /**
   * A group whose lead can't be read sits between all it needs and all that
   * needs it. If the shortest readable lead above it is shorter than the
   * longest below, its tasks go apart, and the groups are drawn again. A
   * readable group is checked after sorting, above.
   */
  function splitUnreadable(): void {
    for (;;) {
      const split = drawn.groups.filter((g) => {
        if (drawn.groupMin.get(g) !== null || g.items.length < 2) return false;
        const reach = (start: PrepAheadGroup, up: boolean): number[] => {
          const mins: number[] = [];
          const seen = new Set<PrepAheadGroup>([start]);
          const stack = [start];
          while (stack.length > 0) {
            const at = stack.pop()!;
            const nextGroups = up
              ? [...drawn.before.get(at)!]
              : drawn.groups.filter((d) => drawn.before.get(d)!.has(at));
            for (const h of nextGroups) {
              if (seen.has(h)) continue;
              seen.add(h);
              stack.push(h);
              const m = drawn.groupMin.get(h);
              if (m !== null && m !== undefined) mins.push(m);
            }
          }
          return mins;
        };
        const [above, below] = [reach(g, true), reach(g, false)];
        return above.length > 0 && below.length > 0 && Math.min(...above) < Math.max(...below);
      });
      if (split.length === 0) return;
      for (const g of split) for (const a of g.items) apart.add(a.id);
      drawn = draw();
    }
  }

  /**
   * Kahn's order over the groups: a group waits for every group holding
   * something it needs (`before`); of those ready, the longest lead goes
   * first. A group goes as early as the longest readable lead it holds up:
   * its own, or that of any group waiting on it, however far down. So a thaw
   * that can't be read but holds up a 2-hour marinade goes before a 1-hour
   * temper. Null when no group is ready, which only a looping plan allows.
   */
  function sortGroups({ groups, groupMin, before }: ReturnType<typeof draw>): PrepAheadGroup[] | null {
    const after = new Map(groups.map((g) => [g, new Set<PrepAheadGroup>()]));
    for (const [to, froms] of before) for (const from of froms) after.get(from)!.add(to);
    const holds = new Map<PrepAheadGroup, number | null>();
    const holdsOf = (g: PrepAheadGroup, seen: Set<PrepAheadGroup>): number | null => {
      if (holds.has(g)) return holds.get(g)!;
      let most = groupMin.get(g)!;
      seen.add(g);
      for (const d of after.get(g)!) {
        // A loop is caught below (no group ready); don't follow it here.
        if (seen.has(d)) continue;
        const m = holdsOf(d, seen);
        if (m !== null && (most === null || m > most)) most = m;
      }
      seen.delete(g);
      holds.set(g, most);
      return most;
    };
    const first = (g: PrepAheadGroup) =>
      Math.min(...g.items.map((a) => plan.tasks.findIndex((t) => t.id === a.id)));
    const priority = (g: PrepAheadGroup): [number, number, number] => {
      const min = holdsOf(g, new Set());
      return [min !== null ? 0 : g.lead !== null ? 1 : 2, -(min ?? 0), first(g)];
    };
    const sorted: PrepAheadGroup[] = [];
    while (sorted.length < groups.length) {
      const ready = groups.filter(
        (g) => !sorted.includes(g) && [...before.get(g)!].every((b) => sorted.includes(b)),
      );
      if (ready.length === 0) return null;
      ready.sort((a, b) => {
        const [pa, pb] = [priority(a), priority(b)];
        return pa[0] - pb[0] || pa[1] - pb[1] || pa[2] - pb[2];
      });
      sorted.push(ready[0]);
    }
    return sorted;
  }

  /** Items in needs order within each group, and the labels to match. */
  function finish(sorted: PrepAheadGroup[]): PrepAheadGroup[] {
    for (const g of sorted) {
      g.items.sort((a, b) => rank.get(a.id)! - rank.get(b.id)!);
      g.labels = g.items.map((a) => lowerFirst(a.label));
    }
    return sorted;
  }
}

function prepContent(plan: CookPlan, state: CookState, screens: Screen[]): PrepContent {
  const ahead = aheadGroups(plan);
  const before = miseBefore(plan, state.mode);
  const goBefore = state.mode === "go" ? before : miseBefore(plan, "go");
  const goScreens = state.mode === "go" ? screens : screensOf(plan, "go", state.ticked);
  const mise = plan.tasks
    .filter((t) => t.kind === "mise")
    .map((t) => {
      const done = isDone(state, t.id);
      const early = before.has(t.id);
      return {
        id: t.id,
        text: t.text,
        label: t.label,
        ingredientIdx: t.ingredientIdx,
        implied: t.implied,
        minutes: minutesFor([t]),
        done,
        before: early,
        when: done || goBefore.has(t.id) ? null : whenInSteps(t, plan, goScreens),
      };
    });
  return {
    ahead,
    aheadNote: ahead.length === 0 ? COOK_COPY.nothingAhead : null,
    mise,
    beforeNote: mise.length > 0 && before.size === 0 ? COOK_COPY.nothingBefore : null,
    assumedNote:
      mise.length > 0 && mise.every((m) => m.implied) ? COOK_COPY.allAssumed : null,
  };
}

function itemOf(screen: Screen): FlowItem {
  if (screen.kind !== "step") throw new Error("the Prep screen is only ever first");
  return screen.item;
}

/** The planner's branch for a recipe that builds one thing (`cook-plan-derive`'s prompt): no dish to name. */
const GENERIC_BRANCH = "Cook";

/**
 * What a prep page adds to its line (DS v1.59): its place among the plan's
 * prep pages, its dish, and its tick rows when it merges several jobs.
 */
function prepPageLine(plan: CookPlan, state: CookState, item: FlowItem, line: StackLine): StackLine {
  const pages = prepPages(plan, state.mode);
  const key = stepKey(item);
  const at = pages.findIndex((p) => stepKey(p) === key);
  const dishes = new Set(plan.tasks.filter((t) => t.kind !== "ahead").map((t) => t.branch));
  const branch = item.tasks[0]?.branch ?? "";
  const dish = dishes.size > 1 && branch !== "" && branch !== GENERIC_BRANCH ? branch : null;
  const rows: PrepRow[] | undefined =
    item.tasks.length > 1
      ? item.tasks.map((t) => ({
          id: t.id,
          text: t.text,
          ingredientIdx: t.ingredientIdx,
          minutes: t.minutes ? COOK_COPY.rowMinutes(Math.max(1, Math.round(t.minutes.est))) : null,
          implied: t.implied,
          // Ticked, or passed in the steps before a switch to "Prep first":
          // the check `toggleTick` makes, so a tap always turns what it shows.
          done: isDone(state, t.id),
        }))
      : undefined;
  return {
    ...line,
    prep: { count: pages.length > 1 && at !== -1 ? { at: at + 1, of: pages.length } : null, dish },
    ...(rows ? { rows } : {}),
  };
}

/**
 * What a prep page's eyebrow says after "Prep" (DS v1.59), in order: its place
 * among the prep pages ("2 of 4"; left out when it is the only one), its dish,
 * and, on a page of tick rows, how long the page takes ("about 10 minutes":
 * a single job says its time under its words, as any step does) and, once for
 * the page, "assumed" when the recipe lists none of its jobs (a page where
 * only some are read from the steps marks those rows). Empty for a line that
 * is not a prep page.
 */
export function prepEyebrow(line: Pick<StackLine, "prep" | "rows" | "minutes">): string[] {
  if (!line.prep) return [];
  const { count, dish } = line.prep;
  const minutes = line.rows && line.minutes ? line.minutes.charAt(0).toLowerCase() + line.minutes.slice(1) : null;
  const assumed = line.rows && rowsAllAssumed(line.rows) ? COOK_COPY.assumed : null;
  return [count ? COOK_COPY.prepPlace(count.at, count.of) : null, dish, minutes, assumed].filter(
    (part): part is string => part !== null,
  );
}

/** Whether the recipe lists none of a tick-row page's jobs: the page says "assumed" once, in its eyebrow. */
export function rowsAllAssumed(rows: readonly Pick<PrepRow, "implied">[]): boolean {
  return rows.length > 0 && rows.every((row) => row.implied);
}

/**
 * The state the chapter row reads: on Prep, as it will stand once the cook
 * leaves (`leavePrep`), still on Prep. In As I go leaving ticks the mise done
 * before cooking, whose steps then go and the batches recut, so the row on
 * Prep is the one the cook steps through, not one that changes on Next. The
 * strip reads the same state (`strip`), so its stretches are the view's.
 */
export function rowState(plan: CookPlan, state: CookState, onPrep: boolean): CookState {
  return onPrep ? { ...leavePrep(plan, state), pos: state.pos } : state;
}

/**
 * The state the chapters, the strip's marks and Whole recipe's grouping count
 * their screens on: `rowState`, Prep known from the state itself (N2 verify
 * round 2). The read and Whole recipe's grouping read this; the strip and
 * `cookView` pass `rowState` their own on-Prep check, the same one while Prep
 * is only ever screen 0.
 */
export function chartState(plan: CookPlan, state: CookState): CookState {
  return rowState(plan, state, stateScreens(plan, state)[state.pos]?.kind === "prep");
}

/**
 * The stretch the step in hand belongs to, from that step on (N2-6): its
 * screens left, the step in hand included, and its break's minutes as said.
 * Null on Prep, as written, and on a position no stretch holds.
 */
function stretchInHand(
  chapters: Chapter[] | null,
  pos: number,
): CookView["stretch"] {
  const here = chapters?.find((c) => c.id !== "prep" && c.at.includes(pos));
  if (here === undefined) return null;
  return {
    left: here.at.length - here.at.indexOf(pos),
    free: here.free === null ? null : here.free.minutes,
  };
}

export function cookView(plan: CookPlan, source: PlanSource, state: CookState): CookView {
  const screens = stateScreens(plan, state);
  if (state.pos < 0 || state.pos >= Math.max(screens.length, 1)) {
    throw new RangeError(
      `cook view position ${state.pos} is outside ${screens.length} screens`,
    );
  }
  const onPrep = screens[state.pos]?.kind === "prep";
  const glanceFrom: GlanceFrom = source.kind === "as-written" ? "text" : "label";
  // Steps as written carry no idle time and no plan's labels, so there is
  // nothing to cut batches by: the row is the note's, as before slice C, and
  // no marker says a chapter begins.
  const row = rowState(plan, state, onPrep);
  const chapters =
    source.kind === "as-written" ? null : chaptersOf(plan, row, stateScreens(plan, row));
  const stretch = stretchInHand(chapters, state.pos);
  const here = screens[state.pos];
  const onPrepPage = here?.kind === "step" && here.prep === true;
  const place: CookView["place"] =
    chapters === null
      ? null
      : onPrep || onPrepPage
        ? { long: COOK_COPY.prepChapter, short: COOK_COPY.prepChapter, count: COOK_COPY.prepChapter }
        : stretch === null
          ? null
          : {
              long: COOK_COPY.stretchPlace(stretch.left, stretch.free),
              short: COOK_COPY.stretchPlaceShort(stretch.left, stretch.free),
              count: COOK_COPY.stretchCount(stretch.left, stretch.free),
            };

  const now = onPrep
    ? prepLine(plan, state)
    : here?.kind === "step"
      ? here.prep
        ? prepPageLine(plan, state, here.item, stepLine(here.item, true, glanceFrom))
        : stepLine(here.item, true, glanceFrom)
      : null;

  const view: CookView = {
    screens: screens.length,
    pos: state.pos,
    onPrep,
    showModeToggle: onPrep && plan.tasks.some((t) => t.kind === "mise"),
    asWritten: source.kind === "as-written",
    chapters,
    stretch,
    place,
    now,
    stack: now ? [now] : [],
    prep: onPrep ? prepContent(plan, state, screens) : null,
    // A recipe with no steps has nothing to plan, so no word on a plan either.
    note:
      state.pos === 0 && source.kind === "as-written" && screens.length > 0
        ? COOK_COPY[source.reason]
        : null,
    isLast: state.pos >= screens.length - 1,
  };
  Object.defineProperties(view, {
    plan: { value: plan, enumerable: false, configurable: true },
    mode: { value: state.mode, enumerable: false, configurable: true },
    ticked: { value: row.ticked, enumerable: false, configurable: true },
  });
  return view;
}
