"use client";

import {
  useEffect,
  useId,
  useImperativeHandle,
  useLayoutEffect,
  useRef,
  useState,
  type MouseEvent,
  type PointerEvent,
  type ReactNode,
  type Ref,
  type RefObject,
} from "react";
import type { Recipe } from "@sous/pack";
import type { PrepMode } from "@/lib/kitchen/cook-plan";
import {
  COOK_COPY,
  bindNumbers,
  prepEyebrow,
  type CookView,
  type PrepAheadGroup,
  type StackLine,
} from "@/lib/kitchen/cook-view";
import { holdAmbientFor } from "@/lib/ambient/advance";
import { emberHolder } from "@/lib/kitchen/ember-holder";
import { fitStack, stepWords } from "@/lib/kitchen/fit-stack";
import { keyBelongsToTarget } from "@/lib/kitchen/key-target";
import { tapFenced, tapZone, type TapPoint } from "@/lib/kitchen/tap-zone";
import type { IngredientLine, StoredIngredientLines } from "@/lib/kitchen/ingredient-display";
import { twoLines } from "@/lib/kitchen/two-lines";
import { useFinishArm } from "@/hooks/useFinishArm";
import { useSwipeGesture } from "@/hooks/useSwipeGesture";
import { EDGE_X } from "./cook-edge";
import { Pair, PAIRS, STEP_TONE } from "./StepPairs";
import { PrepRows } from "./PrepRows";
import { PrepScreen } from "./PrepScreen";
import { ServingStepper } from "./ServingStepper";
import { useNow } from "./KitchenTimers";
import { AlarmBand } from "./AlarmBand";
import { SoundOff, TimerLine } from "./TimerLine";
import { TimerLedge } from "./TimerLedge";
import type { TimerOffer } from "@/lib/kitchen/timer-attach";
import { hasHowToCheck, howToCheckText, type ScreenStep } from "@/lib/kitchen/step-types";
import type { AnswerChoice } from "@/lib/kitchen/how-much";
import type { KitchenTimer } from "@/lib/kitchen/timers";
import { heardLine, type VoiceProps } from "./VoiceDot";
import { CookSheet, type CookSheetProps } from "./CookSheet";
import { ACTION, ACTION_AT_REST, ACTION_IN_FORCE, FOOT_FILL, FOOT_FILL_END, FOOT_FILL_WAITS } from "./control-style";
import { createPortal } from "react-dom";

/** What the cook screen hands the look-ahead; the flow adds the page's own parts. */
export type LookProps = Omit<
  CookSheetProps,
  "stageRef" | "stackRef" | "footRef" | "slotRef" | "fit" | "fitReady" | "stepText" | "stepShape" | "alarm" | "onAlarmTap" | "nudge" | "onMode"
> & { nudge: CookSheetProps["nudge"] };

/**
 * Where finishing stands: ready to finish, saving (the cook is being marked
 * done, or is and the page is leaving), or failed to save, to try again.
 */
export type FinishState = "ready" | "saving" | "failed";

interface CookFlowProps {
  view: CookView;
  mode: PrepMode;
  /**
   * The recipe's time line (`recipeTimeLine`, without its ahead part), at
   * Prep's head; absent or null when there is nothing to say.
   */
  times?: string[] | null;
  /** The pack recipe's ingredients as the cook reads them, by the plan's stored index. */
  ingredients: StoredIngredientLines;
  onNext: () => void;
  onBack: () => void;
  onMode: (mode: PrepMode) => void;
  onTick: (id: string) => void;
  onFinish: () => void;
  onAskAhead: (group: PrepAheadGroup) => void;
  /** Saving waits on the finish control; a failure says so on it. */
  finish: FinishState;
  /**
   * Arrow keys, swipes and taps on the stage move through the flow; off while
   * a modal or panel is open. None of them finishes: that takes the finish
   * control itself.
   */
  navEnabled: boolean;
  /**
   * The voice, for the line that says what it heard, lifted over the foot's
   * middle (`HeardLift`). Ask Sous itself is in the top line (v1.60).
   */
  voice?: VoiceProps;
  /** Ask's panel is open: its own line says what the voice heard, so the foot's stands down. */
  askOpen?: boolean;
  /**
   * Moves for a forward or back that comes from outside the flow (voice),
   * so a step that pages turns its parts there too.
   */
  navRef?: Ref<CookFlowNav>;
  /** The kitchen's timers as this screen draws them (slice B5a); none when absent. */
  timers?: CookTimers;
  /**
   * Quiet lines the stage says once, at its top, in ink-soft: a reset of
   * saved data, and (B5b) a cook started again or the tablet offline.
   */
  notices?: readonly string[];
  /**
   * The look-ahead (P58, slice N): the band under the step and the sheet it
   * pulls up into. Absent on a recipe with no steps, which has no band.
   */
  look?: LookProps | null;
  /** "After this step: about 50 min free.", on the step's meta (look-ahead slice 1); null where it doesn't apply. */
  away?: string | null;
  /** Whole recipe has the screen: the stage and the foot are inert under it. */
  restInert?: boolean;
  resumePart?: number;
  /** The stage width `resumePart` was paged at: it is restored only at that width. */
  resumeWidth?: number;
  /** The part now shown, and the stage width it is paged at. */
  onPart?: (part: number, width: number) => void;
  /** What kind of step the step in hand is (slice B5d); an action when absent. */
  stepType?: StepTypeProps;
  /** "How much" just answered (slice B5d, D13): on its pair if drawn, else on the stage's answer line. */
  answer?: AnswerShown | null;
  /**
   * The opening shows (slice N2, N2-10; N3): the foot steps aside, as the
   * sheet hosts the opening's controls (`OpeningControls`). The stage's own
   * moves wait (`navEnabled` is off).
   */
  opening?: { onStart: () => void } | null;
  /** Whether Back is enabled on the first screen to return to the opening. */
  canBackAtStart?: boolean;
  recipe?: Pick<Recipe, "serves_base" | "serves_estimated">;
  servings?: number;
  scales?: boolean;
  onServingsChange?: (servings: number) => void;
}

/** The step in hand's kind and its controls (slice B5d, D8–D10). */
export interface StepTypeProps {
  step: ScreenStep;
  /** A checkpoint's "Not yet" is open: the stage shows how to check. */
  howToCheck?: boolean;
  onNotYet?: () => void;
  /** A checkpoint the cook has passed before, come back to. */
  checked?: boolean;
  /** An interlude read before on this tablet: drawn to its title. */
  collapsed?: boolean;
  onOpen?: () => void;
}

/** A "how much" answer as the flow draws it (slice B5d, D13). */
export interface AnswerShown {
  /** Changes with each answer, so a new one is drawn afresh. */
  key: number;
  /** Stored indices it answers for; one, drawn on its pair when that pair is on screen. */
  indices: readonly number[];
  shown: string;
  /** "Which?": the lines to pick from, each a target. */
  choices?: readonly AnswerChoice[];
  onChoose?: (index: number) => void;
}

/**
 * The kitchen's timers on the cook screen (slice B5a, A7, A8, A10): the step
 * in hand's offer or clock, in its meta; every other timer in the ledge.
 */
export interface CookTimers {
  /** The step in hand's timer to start; null on Prep or a step with none. */
  offer: TimerOffer | null;
  /** That step's timer while it runs; null before it starts and once it ends. */
  stepTimer: KitchenTimer | null;
  /** The step's timer ended and was dismissed in this cook: it says so, and offers it again. */
  done?: boolean;
  /** The step's timer is ringing: the band carries it, the meta only says so. */
  ringing?: boolean;
  /** Every other running timer in the kitchen, for the foot's well. */
  ledge: readonly KitchenTimer[];
  /**
   * The finished timers not yet dismissed, the one finished longest first:
   * the alarm, which takes the stage (`AlarmBand`) and holds the ember.
   */
  expired: readonly KitchenTimer[];
  /** The running timer that ends soonest, the one a running clock's ember goes to. */
  soonestRunning: string | null;
  soundLocked: boolean;
  onStart: () => void;
  onDismiss: (id: string) => void;
  onAllowSound: () => void;
  /**
   * On Prep, the offer on a make-ahead or mise row (A9): the step's timer
   * not yet started; null for a row with none, or once it runs (its clock
   * is in the ledge).
   */
  prepOffer?: (taskId: string) => TimerOffer | null;
  onStartOffer?: (offer: TimerOffer) => void;
}

/**
 * A forward or back from outside the flow. Each says whether it moved
 * inside a step that pages (revealing its rest, or returning to its first
 * part); when it didn't, the caller moves the steps. `finishable` says the
 * finish is up, on the last screen's last part, and has been up long enough
 * to finish from, as the forward button holds it. `part` names the part on
 * show of a step that pages, from 1, for a flag's report; null when it fits.
 */
export interface CookFlowNav {
  forward: () => boolean;
  back: () => boolean;
  finishable: () => boolean;
  part: () => { at: number; of: number } | null;
}

type Role = "now";

// DS §3's one curve, `--ease` in styles/tokens.css. Written out because
// WAAPI's `easing` doesn't resolve var().
const EASE = "cubic-bezier(0.32, 0.72, 0, 1)";

// The one bold element: now, the step in hand, 600 at the step's size
// (`--type-step`, 64 cpx; the fit takes it down the ladder), its words in the
// ember's holder's tone (`HOLDS_EMBER`), the rest of it in ink. Now stands alone.
const ITEM =
  "relative origin-top-left leading-[1.15] tracking-[-0.012em] transition-colors duration-[320ms] ease-[var(--ease)]";
const ROLE_CLASS: Record<Role, string> = {
  now: "font-semibold text-[length:var(--type-step)] text-ink",
};
// The body column, DS §6: words run no wider than 872 cpx.
const COLUMN = "max-w-[calc(872*var(--cpx))]";
// The step's words hold the screen's one ember (DS §1, slice V's V2) in
// ember-700, the reading weight of ember, until something else claims it
// (`emberHolder`): then they fade to ink over the step's 320 ms, at once under
// reduced motion. Its head and the meta stay as they are.
const HOLDS_EMBER: Record<"ember" | "ink" | "soft", string> = {
  // As the sheet rises the step's ember turns ink-soft before it fades
  // (`--look-tone`, set by the sheet only while it rises): never ember through the ground (§1, N4).
  ember: `${STEP_TONE} [color:var(--look-tone,var(--ember-700))]`,
  ink: `${STEP_TONE} text-ink`,
  soft: `${STEP_TONE} text-ink-soft`,
};
// Above the stack, under the top line (6 + 80 + 6 cpx): to DS §6's body
// column at 104 cpx in landscape, and to the portrait anchor at 150 cpx
// (V.md decision 8, P43(h)), where the screen has height to spare.
const STAGE_TOP = "h-[calc(12*var(--cpx))] shrink-0 portrait:h-[calc(58*var(--cpx))]";

const FOCUS =
  "focus-visible:outline-3 focus-visible:outline-offset-3 focus-visible:outline-ink";

function Icon({ d }: { d: string }) {
  return (
    <svg
      viewBox="0 0 24 24"
      fill="none"
      stroke="currentColor"
      strokeWidth="2.4"
      strokeLinecap="round"
      strokeLinejoin="round"
      aria-hidden="true"
      className="size-[calc(30*var(--cpx))] shrink-0"
    >
      <path d={d} />
    </svg>
  );
}

const CHEV_L = "M15 5l-7 7 7 7";
const CHEV_R = "M9 5l7 7-7 7";
const CHECK = "M5 12.5l4.5 4.5L19 7.5";

/** Whether a meta's pair is shown on the current step, by stored index. */
function pairShown(ingredientIdx: readonly number[], index: number): boolean {
  return ingredientIdx.includes(index);
}

// A prep page's eyebrow (DS v1.59): "Prep" in ink 600, then its place, its
// dish and a tick-row page's minutes in ink-soft 500, at the chip's size, where
// As I go's mise step says "Prep".
// It sits close over its words, the space scale's second step apart: the
// room a wider gap took is room a tick row needs on a full page.
const PREP_EYEBROW =
  "mb-[var(--space-2)] text-[length:var(--type-chip)] leading-[1.25] font-medium tracking-normal text-ink-soft";

function PrepEyebrow({ line }: { line: StackLine }) {
  return (
    <div data-mise-eyebrow data-prep-eyebrow className={`max-w-[calc(872*var(--cpx))] ${PREP_EYEBROW}`}>
      <span className="font-semibold text-ink">{COOK_COPY.prepChapter}</span>
      {prepEyebrow(line).map((part) => (
        <span key={part}> · {bindNumbers(part)}</span>
      ))}
    </div>
  );
}

/**
 * Under the current line: how long it takes, and what goes in.
 */
function Meta({
  line,
  ingredients,
  hidden = false,
  timer,
  keepTime = false,
  ringing = false,
  acts,
  discussed = null,
  away = null,
}: {
  line: Pick<StackLine, "minutes" | "implied" | "ingredientIdx">;
  /**
   * "After this step: about 50 min free." (look-ahead slice 1, DS v1.62): the
   * walk-away line, on the step's meta under its minutes, where the start
   * nudge doesn't take the nudge's slot. It goes with the meta as the sheet rises.
   */
  away?: string | null;
  /**
   * The step's own acts after its time (slice B5d, D8): a checkpoint's
   * "Checked" and "Not yet", where B5a's offer stands.
   */
  acts?: ReactNode;
  /** The stored index of the pair "how much" just answered, drawn as discussed. */
  discussed?: number | null;
  ingredients: StoredIngredientLines;
  hidden?: boolean;
  /**
   * The step's timer (B5a, A7), drawn where its minutes were: the recipe's
   * stated length is the wait's one number, so the plan's estimate gives way.
   */
  timer?: ReactNode;
  /** The step's clock runs: its row stays while the sheet rises (N10). */
  keepTime?: boolean;
  /**
   * A timer rings: the meta steps aside with the lookahead, so the step keeps
   * its words under the alarm (design round 3). The fit's probe reads the mark
   * and leaves the meta out too.
   */
  ringing?: boolean;
}) {
  // An index past the list, or at a blank line the converter skipped, pairs nothing.
  const pairs = line.ingredientIdx
    .map((i) => ({ i, line: ingredients[i] }))
    .filter((pair): pair is { i: number; line: IngredientLine } => pair.line !== undefined && pair.line !== null);
  if (!timer && !acts && !line.minutes && !line.implied && !away && pairs.length === 0) return null;
  return (
    <div data-meta data-ringing={ringing ? "1" : undefined} hidden={hidden || ringing} className="pt-[var(--space-4)]">
      {(timer || acts || line.minutes || line.implied) && (
        <div
          data-time
          data-no-tap={timer || acts ? "" : undefined}
          style={keepTime ? undefined : { opacity: "var(--look-meta, 1)" }}
          className="mb-[var(--space-2)] flex flex-wrap items-center gap-[var(--space-3)] text-[length:var(--type-meta)] leading-[1.3] font-medium tracking-normal text-ink-soft"
        >
          {timer ?? (line.minutes && bindNumbers(line.minutes))}
          {line.implied && <span>{COOK_COPY.assumed}</span>}
          {acts}
        </div>
      )}
      {away && (
        <p
          data-step-away
          style={{ opacity: "var(--look-meta, 1)" }}
          className="m-0 mb-[var(--space-2)] text-[length:var(--type-meta)] leading-[1.3] font-medium tracking-normal text-ink-soft"
        >
          {away}
        </p>
      )}
      {pairs.length > 0 && (
        // A pair's amount opens its conversions: the pairs are not the page.
        <ul data-no-tap data-pairs className={PAIRS} style={{ opacity: "var(--look-meta, 1)" }}>
          {pairs.map((pair, i) => (
            <li key={i}>
              <Pair line={pair.line} discussed={discussed === pair.i} />
            </li>
          ))}
        </ul>
      )}
    </div>
  );
}

// A pack recipe's typed steps (slice B5d, D8–D9).
// An interlude's title, its kind line: the chip's size, 600, ink-soft.
const ASIDE_TITLE_ALONE = "text-[length:var(--type-chip)] leading-[1.25] font-semibold tracking-normal text-ink-soft";
const ASIDE_TITLE = `mb-[var(--space-3)] ${ASIDE_TITLE_ALONE}`;
// An interlude's words: an aside, one size down from the step (44 of 64 cpx,
// DS §2's title size, in em so the fit's ladder still takes it down, clamped at
// the 22 cpx meta floor), at the reading weight. Never ember (`aside`).
const ASIDE_WORDS = "text-[length:max(var(--type-meta),0.6875em)] font-medium leading-[1.25]";
// A step's own act ("Not yet", "Back to the check", "Read it again"): an
// action word in its hairline ring (DS §6, v1.16), as every word that does
// something on the kitchen's screens is; the ring is what tells it from the
// words around it (critic round 1: as a bare word "Not yet" read as a
// status). Its target 80 cpx tall reaches into the gaps around the row.
const STEP_ACT = `-my-[calc(14*var(--cpx))] ${ACTION} ${ACTION_AT_REST}`;
const STEP_ACT_OPEN = `-my-[calc(14*var(--cpx))] ${ACTION} ${ACTION_IN_FORCE}`;

// A "which" choice in the answer's lift: a ghost word in ink, a target tall.
const CHOICE =
  "inline-flex min-h-[var(--target)] cursor-pointer items-center rounded-full px-[calc(18*var(--cpx))] text-[length:var(--type-meta)] leading-tight font-semibold text-ink transition-[background-color] duration-[320ms] ease-[var(--ease)] active:bg-sand focus-visible:outline-3 focus-visible:outline-offset-3 focus-visible:outline-ink";

/** An interlude's title over its words: what the aside is about. */
function AsideTitle({ title }: { title: string }) {
  if (title === "") return null;
  return (
    <p data-interlude="title" className={`${COLUMN} ${ASIDE_TITLE}`}>
      <span className="sr-only">{COOK_COPY.aside}: </span>
      {title}
    </p>
  );
}

/**
 * A checkpoint's acts in its time line (D8): "Checked" in herb where the
 * cook has passed it before (a status, never a button), then "Not yet",
 * which shows how to check in the step's place, and "Back to the check",
 * which puts it away. "Not yet" is drawn only with something to show.
 */
function CheckpointActs({
  checked,
  notYet,
  open,
  onNotYet,
  controls,
}: {
  checked: boolean;
  notYet: boolean;
  open: boolean;
  onNotYet?: () => void;
  /** The step's words, which "Not yet" swaps. */
  controls?: string;
}) {
  return (
    <>
      {checked && (
        <span data-checked className="inline-flex items-center gap-[calc(6*var(--cpx))] font-semibold [color:var(--herb)]">
          <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.6" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true" className="size-[1em]">
            <path d={CHECK} />
          </svg>
          {COOK_COPY.checked}
        </span>
      )}
      {notYet && (
        <button type="button" data-not-yet aria-expanded={open} aria-controls={controls} onClick={onNotYet} className={open ? STEP_ACT_OPEN : STEP_ACT}>
          {open ? COOK_COPY.backToCheck : COOK_COPY.notYet}
        </button>
      )}
    </>
  );
}

/**
 * "How much", answered where the pair isn't drawn (D13): the voice's echo
 * lifted over the foot's middle, where the dot is, in Paper with its
 * hairline and no shadow (DS §1's lifted surface). The answer in ink at the
 * meta's size; for "which", each line a target. It stands for the answer's
 * linger and never moves the stage (it is out of the fit).
 */
function AnswerLift({
  answer,
  anchorRef,
  rowRef,
}: {
  answer: AnswerShown;
  /** What it stands over: the band, or the foot where there is none. */
  anchorRef: RefObject<HTMLDivElement | null>;
  /** The foot's row, whose middle it stands over: the row is the step's column wide. */
  rowRef: RefObject<HTMLDivElement | null>;
}) {
  // Over the band (the foot where there is none), clear of its marks. Drawn in the body, not
  // the foot: the foot fades and goes inert under Whole recipe and the
  // modals, and an answer asked there must still be read and its choices
  // tapped (B5d verify round 1). Being in the body it takes its place from
  // what it stands over, sideways too: the foot's row narrows beside Ask's
  // side panel (v1.60), and the answer stands over the row's middle, not
  // the screen's, where the panel would cover its end.
  const [at, setAt] = useState<{ bottom: number; centre: number; width: number } | null>(null);
  useLayoutEffect(() => {
    const place = () => {
      const over = anchorRef.current?.getBoundingClientRect();
      const row = rowRef.current?.getBoundingClientRect();
      const next = {
        bottom: over ? Math.max(0, window.innerHeight - over.top) : 0,
        centre: row ? row.left + row.width / 2 : window.innerWidth / 2,
        width: row ? row.width : window.innerWidth,
      };
      setAt((was) =>
        was && was.bottom === next.bottom && was.centre === next.centre && was.width === next.width ? was : next,
      );
    };
    place();
    window.addEventListener("resize", place);
    // The panel opening or closing under a standing answer moves the anchor with no resize of the window.
    const row = rowRef.current;
    const watch = row && typeof ResizeObserver !== "undefined" ? new ResizeObserver(place) : null;
    if (row) watch?.observe(row);
    return () => {
      window.removeEventListener("resize", place);
      watch?.disconnect();
    };
  }, [anchorRef, rowRef]);
  if (at === null) return null;
  return createPortal(
    <div
      key={answer.key}
      data-answer
      data-no-tap
      style={{
        bottom: `calc(${String(at.bottom)}px + var(--space-2))`,
        left: `${String(at.centre)}px`,
        maxWidth: `min(calc(${String(at.width)}px - 2 * var(--space-4)), calc(720 * var(--cpx)))`,
      }}
      className="fixed z-[70] w-max -translate-x-1/2 animate-dot-in rounded-[var(--radius-2)] border border-ink/[.11] bg-paper px-[calc(24*var(--cpx))] py-[calc(14*var(--cpx))] text-[length:var(--type-meta)] leading-[1.3] font-medium tracking-normal text-ink"
    >
      <p className="text-[length:var(--type-meta)] leading-[var(--leading-normal)] font-semibold text-ink">
        {answer.shown}
      </p>
      {answer.choices && answer.choices.length > 0 && (
        <div className="mt-[var(--space-1)] -mx-[calc(18*var(--cpx))] -mb-[calc(14*var(--cpx))] flex flex-wrap gap-x-[var(--space-1)]">
          {answer.choices.map((choice) => (
            <button
              key={choice.index}
              type="button"
              data-choice={choice.index}
              onClick={() => answer.onChoose?.(choice.index)}
              className={CHOICE}
            >
              {choice.name}
            </button>
          ))}
        </div>
      )}
    </div>,
    document.body,
  );
}

interface Snap {
  /** Offsets from the scroller's content box, free of any running transform. */
  x: number;
  y: number;
  w: number;
  fontSize: number;
  /** Figtree is variable, so a line's weight can glide with its size. */
  weight: number;
  role: string;
  /** The line itself, kept so a line that leaves can be cloned as it last was. */
  el: HTMLElement;
  /** What the line shows: a glance (its label) or the step's text. */
  face: string | undefined;
  /** A copy of the line as measured, for the cross-fade when its face changes. */
  copy: HTMLElement;
}

interface Snapshot {
  pos: number;
  items: Map<string, Snap>;
}

function measure(stack: HTMLElement): Map<string, Snap> {
  const items = new Map<string, Snap>();
  stack.querySelectorAll<HTMLElement>(":scope > [data-line]").forEach((el) => {
    // A line the fit dropped isn't on screen: it leaves, or rises in, as
    // a line that comes or goes.
    if (el.style.display === "none") return;
    items.set(el.dataset.line ?? "", {
      x: stack.offsetLeft + el.offsetLeft,
      y: stack.offsetTop + el.offsetTop,
      w: el.offsetWidth,
      fontSize: parseFloat(getComputedStyle(el).fontSize),
      weight: parseFloat(getComputedStyle(el).fontWeight),
      role: el.dataset.role ?? "",
      el,
      face: el.querySelector<HTMLElement>("[data-face]")?.dataset.face,
      copy: el.cloneNode(true) as HTMLElement,
    });
  });
  return items;
}

const LINKING = ["id", "for", "aria-labelledby", "aria-describedby", "aria-controls"];

/**
 * A copy of a line React has just removed. The detached node still holds what
 * it last showed (a Prep tick made a moment ago included). Ids and the
 * attributes that point at them are stripped, so the copy never answers for
 * the live line that may share them.
 */
function ghostOf(el: HTMLElement): HTMLElement {
  const ghost = el.cloneNode(true) as HTMLElement;
  ghost.removeAttribute("data-line");
  const selector = LINKING.map((name) => `[${name}]`).join(",");
  for (const node of [ghost, ...ghost.querySelectorAll(selector)]) {
    for (const name of LINKING) node.removeAttribute(name);
  }
  // A running clock's digits fly on to where the timer goes next
  // (`clock-flight`); the copy keeps their room but never draws a second clock.
  for (const digits of ghost.querySelectorAll<HTMLElement>('[data-timer="running"]')) {
    digits.style.visibility = "hidden";
  }
  return ghost;
}

function sameLines(a: Map<string, Snap>, b: Map<string, Snap>): boolean {
  if (a.size !== b.size) return false;
  for (const [key, snap] of a) {
    if (b.get(key)?.role !== snap.role) return false;
  }
  return true;
}

/**
 * The advance: the leaving step cross-fades out via a ghost, the entering
 * step fades in (DS §3, 320 ms; 200 ms under reduced motion). If the leaving
 * step holds ember, it turns ink-soft in colour before fading. Arriving ember
 * fades in ink-soft, then turns ember.
 */
function useStackMotion(
  pos: number,
  lines: string,
  scrollerRef: RefObject<HTMLDivElement | null>,
  stackRef: RefObject<HTMLDivElement | null>,
  ghostRef: RefObject<HTMLDivElement | null>,
) {
  const snapshot = useRef<Snapshot | null>(null);
  // Scroll position as the cook last left it, which is where the lines were
  // on screen when they pressed Next.
  const lastScroll = useRef(0);

  useEffect(() => {
    const scroller = scrollerRef.current;
    const stack = stackRef.current;
    if (!scroller || !stack) return;
    const onScroll = () => {
      lastScroll.current = scroller.scrollTop;
    };
    // A resize (rotation, fonts arriving) moves every line; re-measure so the
    // next advance starts from where the lines really are.
    const resize = new ResizeObserver(() => {
      if (snapshot.current) {
        snapshot.current = { ...snapshot.current, items: measure(stack) };
      }
    });
    scroller.addEventListener("scroll", onScroll, { passive: true });
    resize.observe(stack);
    return () => {
      scroller.removeEventListener("scroll", onScroll);
      resize.disconnect();
    };
  }, [scrollerRef, stackRef]);

  useLayoutEffect(() => {
    const scroller = scrollerRef.current;
    const stack = stackRef.current;
    const ghosts = ghostRef.current;
    if (!scroller || !stack || !ghosts) return;

    const prev = snapshot.current;
    const scrollBefore = lastScroll.current;
    if (prev && prev.pos !== pos) scroller.scrollTop = 0;
    const scrollAfter = scroller.scrollTop;
    lastScroll.current = scrollAfter;

    const items = measure(stack);
    snapshot.current = { pos, items };
    if (!prev || sameLines(prev.items, items)) return;

    // Every animation the advance starts, so the ambient light can hold still
    // for as long as any of them runs (P67, DS §1.1).
    const started: Animation[] = [];
    const track = (a: Animation | undefined): Animation | undefined => {
      if (a) started.push(a);
      return a;
    };

    const reduce = window.matchMedia("(prefers-reduced-motion: reduce)").matches;
    const dur = reduce ? 200 : 320;

    prev.items.forEach((snap, key) => {
      if (items.has(key)) return;
      const ghost = ghostOf(snap.el);
      Object.assign(ghost.style, {
        position: "absolute",
        left: `${snap.x}px`,
        top: `${snap.y - scrollBefore}px`,
        width: `${snap.w}px`,
        margin: "0",
        // A line still in the stack that the fit dropped leaves as it was.
        display: "",
      });
      ghosts.appendChild(ghost);

      const emberEl = ghost.querySelector<HTMLElement>("[data-ember]");
      if (emberEl) {
        if (reduce) {
          emberEl.style.color = "var(--ink-soft)";
        } else {
          track(
            emberEl.animate(
              [
                { color: "var(--ember-700)" },
                { color: "var(--ink-soft)", offset: 0.4 },
                { color: "var(--ink-soft)" },
              ],
              { duration: 320, easing: EASE, fill: "forwards" },
            ),
          );
        }
      }

      const fade = track(
        ghost.animate(
          reduce
            ? [{ opacity: 1 }, { opacity: 0 }]
            : emberEl
              ? [{ opacity: 1 }, { opacity: 1, offset: 0.4 }, { opacity: 0 }]
              : [{ opacity: 1 }, { opacity: 0 }],
          { duration: dur, easing: EASE, fill: "forwards" },
        ),
      )!;
      const remove = () => ghost.remove();
      fade.onfinish = remove;
      fade.oncancel = remove;
    });

    stack.querySelectorAll<HTMLElement>(":scope > [data-line]").forEach((el) => {
      const key = el.dataset.line ?? "";
      const was = prev.items.get(key);
      const now = items.get(key);
      if (!now) return;
      if (!was) {
        const emberEl = el.querySelector<HTMLElement>("[data-ember]");
        if (emberEl) {
          track(
            emberEl.animate(
              reduce
                ? [{ color: "var(--ink-soft)" }, { color: "var(--ink-soft)", offset: 0.99 }, { color: "var(--ember-700)" }]
                : [{ color: "var(--ink-soft)" }, { color: "var(--ink-soft)", offset: 0.6 }, { color: "var(--ember-700)" }],
              { duration: reduce ? 200 : 320, easing: EASE, fill: "backwards" },
            ),
          );
        }
        track(el.animate([{ opacity: 0 }, { opacity: 1 }], { duration: dur, easing: EASE, fill: "backwards" }));
        return;
      }
      const dx = was.x - now.x;
      const dy = was.y - scrollBefore - (now.y - scrollAfter);
      const scale = was.fontSize / now.fontSize;
      const moved = Math.abs(dx) > 0.5 || Math.abs(dy) > 0.5 || Math.abs(scale - 1) > 0.01;
      if (moved) {
        track(el.animate(
          reduce
            ? [{ opacity: 0 }, { opacity: 1 }]
            : [
                { transform: `translate(${dx}px, ${dy}px) scale(${scale})` },
                { transform: "none" },
              ],
          { duration: dur, easing: EASE },
        ));
      }
    });
    holdAmbientFor(started);
  }, [pos, lines, scrollerRef, stackRef, ghostRef]);
}

/**
 * The stack's foot: room kept under the last line, above the bottom band or
 * the screen's edge. It counts toward the stage, so the fit keeps it free.
 */
const STACK_FOOT = "var(--space-5)";
/**
 * Prep's foot, less than a step's: Prep's last line is a row or a fold line
 * at the rows' size, not a glance read across the room, and the room a foot
 * keeps is room a row could have (DS §5). In px: Prep's sizes are its own,
 * not yet on the counter scale.
 */
const PREP_FOOT = 16;
const TIGHT_FOOT = 8;

/** A CSS length (a token's `var()`, say) in px, as `host` resolves it. */
function lengthPx(host: HTMLElement, length: string): number {
  const probe = document.createElement("div");
  probe.style.cssText = `position:absolute;visibility:hidden;width:${length}`;
  host.appendChild(probe);
  const px = parseFloat(getComputedStyle(probe).width);
  probe.remove();
  return px;
}

/**
 * A stand-in for now, off the page: a copy laid where now is, which shows
 * the whole step (its words, time line, and amount pairs) at any size and
 * reports its height. Gone once read.
 */
function nowProbe(stack: HTMLElement, now: HTMLElement) {
  const probe = ghostOf(now);
  probe.removeAttribute("data-role");
  probe.setAttribute("aria-hidden", "true");
  Object.assign(probe.style, {
    position: "absolute",
    visibility: "hidden",
    top: `${now.offsetTop}px`,
    left: `${now.offsetLeft}px`,
    width: `${now.offsetWidth}px`,
    margin: "0",
  });
  // As it rests: under the lifted sheet a prep page's rows give their amounts' lines back (`PrepRows`).
  probe.style.setProperty("--look-meta", "1");
  stack.appendChild(probe);
  const text = probe.querySelector<HTMLElement>("[data-face]");
  const meta = probe.querySelector<HTMLElement>("[data-meta]");
  const time = probe.querySelector<HTMLElement>("[data-time]");
  // While a timer rings the meta steps aside (`Meta`'s `ringing`): no time,
  // no pairs to measure.
  const ringing = meta?.dataset.ringing === "1";
  const pairs = meta && !ringing ? [...meta.querySelectorAll<HTMLElement>("[data-pairs] > li")] : [];
  if (!text) {
    throw new Error("the current line has no text to measure");
  }
  return {
    pairs: pairs.length,
    height(fontSize: number, tight = false): number {
      probe.style.fontSize = `${fontSize}px`;
      if (meta) meta.style.paddingTop = tight ? "4px" : "";
      if (time) time.style.marginBottom = tight ? "2px" : "";
      for (const li of pairs) {
        li.style.marginTop = tight ? "-6px" : "";
        li.style.marginBottom = tight ? "-6px" : "";
      }
      return probe.offsetHeight;
    },
    remove: () => probe.remove(),
  };
}

/**
 * An element's height in whole px while `active`, kept up by a
 * ResizeObserver; 0 while not. For what stands over the stack and can grow
 * without the stack resizing (the alarm band), so the fit hears of it.
 */
function useObservedHeight(ref: RefObject<HTMLElement | null>, active: boolean): number {
  const [height, setHeight] = useState(0);
  useLayoutEffect(() => {
    const el = ref.current;
    if (!active || !el) return;
    const resize = new ResizeObserver(() => setHeight(Math.round(el.offsetHeight)));
    resize.observe(el);
    return () => resize.disconnect();
  }, [ref, active]);
  return active ? height : 0;
}

/**
 * The step fits by the ladder in `fitStack` (`STEP_FIT_SCALES` down to 0.5×,
 * DS §5): measured here, before the advance measures, so the motion starts
 * from the fitted sizes. Below 0.8×, the stage's top spacer closes, the
 * stack's foot compresses to `TIGHT_FOOT` (8 px), and the meta's top gap and
 * time line gap tighten so vertical whitespace gives way before smaller type
 * rungs are needed. If a step still runs past the stage at 0.5×, it stays
 * whole and `[data-stage]` scrolls vertically rather than splitting into pages.
 * The Prep screen fits itself by folding (`PrepScreen`, through `usePrepFit`).
 */
function useFitStack(
  pos: number,
  lines: string,
  onPrep: boolean,
  text: string | null,
  scrollerRef: RefObject<HTMLDivElement | null>,
  stackRef: RefObject<HTMLDivElement | null>,
  /**
   * What else moves the stack without resizing it: the stage's quiet lines
   * above it (B5a). The timer's row resizes the stack, which refits anyway.
   */
  shape = "",
  /** The nudge's line, px, reserved where it doesn't cost the step its size (N7, N10). */
  nudgeReserve = 0,
) {
  const owner = `${pos}\n${text}`;
  // `owner` is the step the fit last ran for: until it has run for this one
  // the step's block isn't its size yet (`ready`).
  const [fitOut, setFitOut] = useState<{ scale: number; nudge: boolean; owner: string | null }>({ scale: 1, nudge: false, owner: null });

  useLayoutEffect(() => {
    const scroller = scrollerRef.current;
    const stack = stackRef.current;
    if (!scroller || !stack) return;
    const fitFor = (prev: typeof fitOut, scale: number, nudge: boolean) =>
      prev.scale === scale && prev.nudge === nudge && prev.owner === owner ? prev : { scale, nudge, owner };
    const fit = () => {
      // A stage with no height isn't laid out (not yet, or hidden): there is
      // nothing to fit to. It refits when it gets a size.
      if (scroller.clientHeight === 0) {
        setFitOut((prev) => fitFor(prev, prev.scale, prev.nudge));
        return;
      }
      const stageTop = scroller.querySelector<HTMLElement>("[data-stage-top]");
      if (stageTop) stageTop.style.removeProperty("display");
      const line = (role: Role) =>
        stack.querySelector<HTMLElement>(`:scope > [data-role="${role}"]`);
      // Every line, not just this screen's: lines keep their element across
      // roles, so a dropped after line would stay dropped as next, and a
      // shrunk now line would stay shrunk as Prep's peek.
      stack.querySelectorAll<HTMLElement>(":scope > [data-line]").forEach((el) => {
        el.style.removeProperty("font-size");
        el.style.removeProperty("display");
        el.style.removeProperty("margin-top");
        el.querySelector<HTMLElement>("[data-meta]")?.style.removeProperty("padding-top");
        el.querySelector<HTMLElement>("[data-time]")?.style.removeProperty("margin-bottom");
        el.querySelectorAll<HTMLElement>("[data-pairs] > li").forEach((li) => {
          li.style.removeProperty("margin-top");
          li.style.removeProperty("margin-bottom");
        });
      });
      stack.style.paddingBottom = onPrep ? `${PREP_FOOT}px` : STACK_FOOT;
      const now = line("now");
      if (onPrep || !now || text === null) {
        setFitOut((prev) => fitFor(prev, prev.scale, prev.nudge));
        return;
      }
      const base = parseFloat(getComputedStyle(now).fontSize);
      const foot = lengthPx(stack, STACK_FOOT);
      const stageTopH = stageTop ? stageTop.offsetHeight || stack.offsetTop : 0;
      const tightGain = stageTopH + Math.max(0, foot - TIGHT_FOOT);
      const words = stepWords(text);
      const probe = nowProbe(stack, now);
      let fitted;
      try {
        fitted = fitStack({
          room: scroller.clientHeight - foot - 1,
          top: stack.offsetTop + now.offsetTop,
          words,
          pairs: probe.pairs,
          now: (scale) => probe.height(base * scale, scale < 0.8) - (scale < 0.8 ? tightGain : 0),
          nudgeReserve,
        });
      } finally {
        probe.remove();
      }
      if (fitted.scale < 0.8) {
        if (stageTop) stageTop.style.display = "none";
        stack.style.paddingBottom = `${TIGHT_FOOT}px`;
        const metaEl = now.querySelector<HTMLElement>("[data-meta]");
        const timeEl = now.querySelector<HTMLElement>("[data-time]");
        if (metaEl) metaEl.style.paddingTop = "4px";
        if (timeEl) timeEl.style.marginBottom = "2px";
        now.querySelectorAll<HTMLElement>("[data-pairs] > li").forEach((li) => {
          li.style.marginTop = "-6px";
          li.style.marginBottom = "-6px";
        });
      }
      now.style.fontSize = fitted.scale === 1 ? "" : `${base * fitted.scale}px`;
      setFitOut((prev) => fitFor(prev, fitted.scale, fitted.nudge));
    };
    fit();
    const resize = new ResizeObserver(() => {
      fit();
    });
    resize.observe(scroller);
    resize.observe(stack);
    const fonts = () => {
      fit();
    };
    document.fonts?.addEventListener("loadingdone", fonts);
    return () => {
      resize.disconnect();
      document.fonts?.removeEventListener("loadingdone", fonts);
    };
  }, [pos, lines, onPrep, text, owner, scrollerRef, stackRef, shape, nudgeReserve]);

  return { scale: fitOut.scale, nudge: fitOut.nudge, ready: fitOut.owner === owner };
}

/**
 * The foot (V4): one row in the frame's bottom band, in every layout and on
 * every recipe, under the stage and never over it. Back at the start, forward
 * at the end, so forward stands in the same place on every recipe; nothing
 * between them (slice N took the whole cook out of it, and v1.60 took Ask
 * Sous to the top line); a timer whose step isn't on screen sits beside Back,
 * the ledge (B5a, A8). What the voice heard floats over the row's middle, out
 * of the row (`HeardLift`, P63 (a)). The
 * band is 96 cpx, the row's 80 cpx targets 10 cpx off the screen's foot,
 * inside DS §6's bottom 100. Beside the pane it spans the steps' column, as
 * CookFlow does.
 */
const FOOT_PAD = "px-[calc(20*var(--cpx))] pt-[calc(6*var(--cpx))] pb-[calc(10*var(--cpx))]";
// The ends' tracks never go under their controls, so a row too short for
// its words runs past its edge, which `useFootFit` reads, rather than one
// control standing over the next.
const FOOT = `group/foot grid shrink-0 grid-cols-[minmax(max-content,1fr)_auto_minmax(max-content,1fr)] items-center gap-x-[calc(8*var(--cpx))] ${FOOT_PAD}`;
/**
 * The strip (look-ahead slice 1, DS v1.62): the foot with the progress line in its middle, Back
 * and Forward at its ends. The line takes what the ends leave, never under 120 cpx (call 6): a
 * row too short for that runs past its edge, and `useFootFit`'s give-way runs first.
 */
const FOOT_STRIP = `group/foot grid shrink-0 grid-cols-[max-content_minmax(calc(120*var(--cpx)),1fr)_max-content] items-center gap-x-[calc(8*var(--cpx))] ${FOOT_PAD}`;

/**
 * What the foot gives up to stay one row, in order, marked on the row for
 * the controls' styles: a checkpoint's "Looks right" first; then
 * the ledge clock's label, which stays its name (`data-ledge-short`, B5a);
 * then Finish's caption goes to two lines (`data-caption-wraps`, broken by
 * `twoLines`); and last the well's second clock and its digits' size. Nothing
 * shrinks: the words stay at the meta's size and the row cuts a line, not the
 * type (DS §2, the floor).
 */
const FOOT_GIVES = [
  // A checkpoint's "Looks right" goes first (B5d, D8): the step's own words
  // say what to check, and the chevron's name still says it.
  "data-forward-bare",
  "data-ledge-short",
  "data-caption-wraps",
  // The well gives last (B5a, after main's foot voice, 6f5102e): its second
  // clock goes (still said), then the lead clock's digits step down to the
  // chip's 30 cpx, so the row holds in portrait with two timers running.
  "data-ledge-one",
  "data-ledge-small",
] as const;

/**
 * The foot's fit, read off the row as the stack's is (`useFitStack`): from
 * every word, it gives up one thing at a time while the row runs past its
 * edge, before paint. It fits again when what the row holds changes
 * (`content`), when the row's width does, and when the faces arrive.
 */
function useFootFit(foot: RefObject<HTMLDivElement | null>, content: string) {
  useLayoutEffect(() => {
    const row = foot.current;
    if (!row) return;
    // The row's tracks and gaps against its content box. Each track is at
    // least its controls' width, so this is what the row needs.
    const over = () => {
      const style = getComputedStyle(row);
      const tracks = style.gridTemplateColumns.split(" ").map(parseFloat);
      const used = tracks.reduce((a, b) => a + b, 0) + parseFloat(style.columnGap) * (tracks.length - 1);
      const room = row.clientWidth - parseFloat(style.paddingLeft) - parseFloat(style.paddingRight);
      return used > room + 0.5;
    };
    const fit = () => {
      for (const give of FOOT_GIVES) row.removeAttribute(give);
      for (const give of FOOT_GIVES) {
        if (!over()) return;
        row.setAttribute(give, "");
      }
    };
    fit();
    let width = row.clientWidth;
    const resize = new ResizeObserver(() => {
      if (row.clientWidth === width) return;
      width = row.clientWidth;
      fit();
    });
    resize.observe(row);
    document.fonts.addEventListener("loadingdone", fit);
    return () => {
      resize.disconnect();
      document.fonts.removeEventListener("loadingdone", fit);
    };
  }, [foot, content]);
}
// At rest every control in the foot is a ghost, no fill; a press shows sand
// (DS §1, sand is the pressed state on the cook screen).
const PRESS = "transition-[background-color,opacity] duration-[320ms] ease-[var(--ease)] active:bg-sand";
const CHEVRON = `grid size-[var(--target)] shrink-0 cursor-pointer place-items-center rounded-full ${PRESS} ${FOCUS}`;

/**
 * A word in the foot, or in the pane's own foot: ink-soft at the meta's size
 * on a target-tall ghost, its glyph (if any) drawn at the same size before it.
 */
export const FOOT_GHOST = `inline-flex h-[var(--target)] min-w-0 shrink-0 cursor-pointer items-center justify-center gap-[calc(10*var(--cpx))] rounded-full px-[calc(26*var(--cpx))] text-center text-[length:var(--type-meta)] leading-tight font-medium text-ink-soft [&>svg]:size-[var(--type-meta)] ${PRESS} ${FOCUS}`;

/**
 * A foot word that can go to two lines (`FOOT_GIVES`): the second line is
 * its own box, inline until the row's give makes it a block, so the word's
 * box is only as wide as its longer line. The space before it is collapsed
 * at a line's start, and its name reads the same either way.
 */
function FootWords({ text, breaks }: { text: string; breaks: string }) {
  const [first, second] = twoLines(text);
  return (
    <>
      {first}
      {second && <span className={breaks}>{` ${second}`}</span>}
    </>
  );
}

/**
 * What the voice is hearing or just heard, lifted over the foot's middle,
 * where Ask Sous stood until v1.60 (P63 (a); DS §1's
 * lifted surface, §5's foot): where the answer to
 * "how much" lifts, over the band (over the foot where there is no band),
 * centred on the row, in Paper with its hairline and no shadow. Ink-soft at
 * the meta's size, as the foot's words and the dot's line are. A long phrase
 * wraps upward rather than being cut (words wrap before they go; a word too
 * long for the line breaks inside it). It is out of the row's tracks, so the
 * row never refits for it. It is not drawn while something else says what was
 * heard or the foot steps aside: Ask open (its own line), Whole recipe (the
 * borrowed ledge), the opening. It takes no taps and is said once, by the
 * voice's own live region (`VoiceSaid`).
 */
function HeardLift({ text }: { text: string }) {
  return (
    <p
      key={text}
      data-heard
      aria-hidden="true"
      style={{ bottom: "calc(100% + var(--space-2))" }}
      className="pointer-events-none absolute left-1/2 m-0 w-max max-w-[calc(100%-2*var(--space-4))] -translate-x-1/2 animate-dot-in rounded-[var(--radius-2)] border border-ink/[.11] bg-paper px-[calc(24*var(--cpx))] py-[calc(14*var(--cpx))] text-[length:var(--type-meta)] leading-[1.3] font-medium whitespace-normal [overflow-wrap:anywhere] text-ink-soft motion-reduce:animate-none"
    >
      {text}
    </p>
  );
}

/** Back: an ink-soft chevron, dimmed at the start (still focusable, so focus never drops). */
function BackButton({
  atStart,
  onBack,
}: {
  atStart: boolean;
  onBack: () => void;
}) {
  return (
    <button
      type="button"
      aria-label={COOK_COPY.back}
      aria-disabled={atStart || undefined}
      onClick={() => {
        if (!atStart) onBack();
      }}
      className={`${CHEVRON} justify-self-start text-ink-soft aria-disabled:cursor-default aria-disabled:opacity-35 aria-disabled:active:bg-transparent`}
    >
      <Icon d={CHEV_L} />
    </button>
  );
}

// Finish: a pill on the row, the check then its caption, at a target's
// height. It is the foot's one fill, so it stands on the cook view's edge
// (`--edge`), where the steps' words end, not on the row's padding, which
// only ghosts may reach (V fix round 1: it ran 21 px past the edge).
const FINISH = `${FOOT_FILL} ${FOOT_FILL_END} gap-[calc(10*var(--cpx))] pr-[calc(30*var(--cpx))] pl-[calc(24*var(--cpx))]`;

/**
 * Finish without the ember: it waits in sand with ink-soft words, as the one
 * act does before it is the next one (DS §1), while the step's timer is still
 * to start or a timer rings.
 */
const FINISH_WAITS = FOOT_FILL_WAITS;

/**
 * A checkpoint's forward (slice B5d, D8): "Looks right" and the chevron, in
 * ink at the meta's size, a ghost with no fill (sand while pressed), a target
 * tall. No ember: the step's words keep it. Where the foot is short its
 * words go first (`data-forward-bare`) and the chevron alone stays.
 */
const CAPTIONED = `inline-flex h-[var(--target)] shrink-0 cursor-pointer items-center justify-self-end gap-[calc(8*var(--cpx))] rounded-full pl-[calc(26*var(--cpx))] pr-[calc(14*var(--cpx))] group-data-[forward-bare]/foot:px-0 group-data-[forward-bare]/foot:w-[var(--target)] group-data-[forward-bare]/foot:justify-center text-[length:var(--type-meta)] leading-tight font-semibold whitespace-nowrap text-ink ${PRESS} ${FOCUS}`;

/**
 * Forward: an ink chevron, the one foot control in ink, as it is the one the
 * cook reaches for most; and on the last part of the last screen the check,
 * captioned and filled in ember, the screen's one call to action and its one
 * fill, so it reads as the end rather than another step. One button
 * throughout, so focus stays on it when Next becomes finish; it keeps the
 * row's end, so it grows leftward. While it saves, the finish waits in sand
 * with an ink-soft check and caption, as the one act does before it can be
 * acted on (DS §1, the one sand on the cook screen at rest); ember is never
 * faded. A finish that fails to save says so in the caption, and the check
 * tries again.
 */
function ForwardButton({
  lastScreen,
  finish,
  onNext,
  onFinish,
  ember = true,
  caption,
}: {
  lastScreen: boolean;
  finish: FinishState;
  onNext: () => void;
  onFinish: () => void;
  /**
   * Finish holds the screen's ember. It yields to the step's unstarted timer
   * and to an alarm (`emberHolder`, B5a): then it waits in sand, still the
   * act, not yet the next one (decided 2026-10-03).
   */
  ember?: boolean;
  /**
   * A checkpoint's forward, which confirms it (slice B5d, D8): the chevron
   * says "Looks right", in ink with no fill. Its words are the foot's first
   * give (`data-forward-bare`); its name always says it.
   */
  caption?: string;
}) {
  const isLast = lastScreen;
  const captioned = !isLast && caption !== undefined;
  const armed = useFinishArm(isLast);
  const saving = finish === "saving";
  const failed = isLast && finish === "failed";

  const onClick = () => {
    if (!isLast) onNext();
    else if (!saving && armed()) onFinish();
  };

  return (
    <>
      <button
        type="button"
        aria-label={isLast ? undefined : captioned ? caption : COOK_COPY.forward}
        data-caption={captioned ? "" : undefined}
        aria-disabled={(isLast && saving) || undefined}
        onClick={onClick}
        // A held Enter repeats clicks; one press is one step, and never a finish.
        onKeyDown={(e) => {
          if (e.repeat && e.key === "Enter") e.preventDefault();
        }}
        className={
          isLast
            ? `${FINISH} ${saving ? "bg-sand text-ink-soft" : ember ? "bg-ember text-paper" : FINISH_WAITS}`
            : captioned
              ? CAPTIONED
              : `${CHEVRON} justify-self-end text-ink`
        }
      >
        {captioned && (
          // Words first, then the way on: "Looks right ›". Hidden from a
          // screen reader, which hears the button's name.
          <span aria-hidden className="group-data-[forward-bare]/foot:hidden">
            {caption}
          </span>
        )}
        <Icon d={isLast ? CHECK : CHEV_R} />
        {isLast && (
          // A row too short for it: the caption takes two lines
          // (`useFootFit`).
          <span>
            <FootWords
              text={failed ? COOK_COPY.finishFailed : COOK_COPY.finish}
              breaks="group-data-[caption-wraps]/foot:block"
            />
          </span>
        )}
      </button>
      <span className="sr-only" role="status">
        {failed ? COOK_COPY.finishFailed : ""}
      </span>
    </>
  );
}

/**
 * An open popover (a measurement's conversions, the header's More)
 * marks itself; the arrows, swipes and taps wait until it closes.
 */
function popoverOpen(): boolean {
  return document.querySelector("[data-holds-keys]") !== null;
}

/**
 * The cook screen: chapters along the top, then the step you're on. The first
 * screen holds the prep; the last screen's forward control finishes the cook.
 */
export function CookFlow({
  view,
  mode,
  times = null,
  ingredients,
  onNext,
  onBack,
  onMode,
  onTick,
  onFinish,
  onAskAhead,
  finish,
  navEnabled,
  voice,
  askOpen = false,
  navRef,
  timers,
  notices = [],
  look = null,
  away = null,
  restInert = false,
  stepType,
  answer = null,
  opening = null,
  canBackAtStart = false,
  recipe,
  servings,
  scales = true,
  onServingsChange,
}: CookFlowProps) {
  const scrollerRef = useRef<HTMLDivElement>(null);
  const stackRef = useRef<HTMLDivElement>(null);
  const ghostRef = useRef<HTMLDivElement>(null);
  // The step in hand's kind (B5d): a checkpoint whose "Not yet" is open shows
  // how to check in its words' place; an interlude read before shows its title.
  const wordsId = useId();
  const typed: ScreenStep = !view.onPrep && view.stack[0] && stepType ? stepType.step : { kind: "action" };
  // Never on a confirmed check's return, whose one state is "Checked" (UI verify round 3).
  const howToCheck =
    typed.kind === "checkpoint" && (stepType?.howToCheck ?? false) && !(stepType?.checked ?? false) && hasHowToCheck(typed);
  const collapsed = typed.kind === "interlude" && (stepType?.collapsed ?? false);
  const stepWordsShown = (text: string) =>
    howToCheck && typed.kind === "checkpoint" ? howToCheckText(typed) : collapsed && typed.kind === "interlude" ? typed.title : text;
  const lines = `${view.stack.map((line) => line.key).join(" ")}${howToCheck ? " how" : ""}${collapsed ? " folded" : ""}`;
  const stepText = !view.onPrep && view.stack[0] ? stepWordsShown(view.stack[0].text) : null;
  // The alarm band can grow while it stands ("Finished 1 min ago" joins its
  // line, and in portrait may wrap it), so the fit counts its height, not
  // just its being there (B5a verify, M4).
  const bandRef = useRef<HTMLDivElement>(null);
  const bandHeight = useObservedHeight(bandRef, (timers?.expired.length ?? 0) > 0);
  // Sound off while the clocks are in the well, not in the step's meta: the
  // ghost that lets the chime sound stands at the stage's top.
  const soundLine = !!timers && timers.soundLocked && timers.stepTimer === null && timers.ledge.length > 0;
  // The nudge's line above the band (N7, N10): reserved in the fit only where it doesn't cost the step its size.
  // Two lines at the chip's size until the sheet measures it where it stands.
  const [nudgeH, setNudgeH] = useState(() => {
    if (typeof window === "undefined") return 0;
    const c = Math.min(Math.max(innerWidth, innerHeight) / 960, Math.min(innerWidth, innerHeight) / 600);
    return Math.ceil(2 * 30 * c * 1.25 + 10 * c);
  });
  const nudgeWanted = !!look?.nudge && !view.onPrep;
  const { scale: fitScale, nudge: nudgeFits, ready: fitReady } = useFitStack(
    view.pos,
    lines,
    view.onPrep,
    stepText,
    scrollerRef,
    stackRef,
    // A ringing timer's band stands over the stack too, and a serving change can lengthen pairs.
    `${notices.join("\n")}|${timers?.expired.length ?? 0}|${bandHeight}|${soundLine ? "sound" : ""}|${servings ?? ""}`,
    nudgeWanted ? nudgeH : 0,
  );
  useStackMotion(view.pos, lines, scrollerRef, stackRef, ghostRef);

  const atStart = view.pos === 0 && !canBackAtStart;
  const isLast = view.isLast;
  const armed = useFinishArm(isLast);
  // "How much" answered (B5d, D13): on its pair while the pair is drawn at
  // Now; anywhere else on the foot's answer lift.
  const discussedIdx = (() => {
    // While a timer rings the meta steps aside (`Meta`'s `ringing`): no pair is drawn.
    if (answer === null || answer.indices.length !== 1 || (look?.level ?? 0) > 0) return null;
    if ((timers?.expired.length ?? 0) > 0) return null;
    const line = !view.onPrep ? view.stack[0] : undefined;
    const index = answer.indices[0]!;
    if (!line || collapsed || howToCheck) return null;
    return pairShown(line.ingredientIdx, index) ? index : null;
  })();
  const answerLifted = answer !== null && discussedIdx === null;
  // One ember (`emberHolder`, B5a A10): an alarm; on the last step the next
  // act, the step's unstarted timer and then Finish, which claims it from
  // the moment it is drawn, saving included (a finish waiting on its save is
  // sand, P27, and the step doesn't flare back for the moment it waits); a
  // running clock; else the step.
  const offer = !view.onPrep ? (timers?.offer ?? null) : null;
  const stepTimer = offer ? (timers?.stepTimer ?? null) : null;
  const expired = timers?.expired ?? [];
  const alarm = expired.length > 0;
  const holder = emberHolder({
    alarm,
    discussed: discussedIdx !== null,
    finish: isLast,
    // A timer that rang and was stopped ("timer done · Again") is spent: it
    // offers again, but the next act is Finish (B5a verify, H2).
    offer: offer !== null && stepTimer === null && !(timers?.done ?? false),
    timer: (timers?.soonestRunning ?? null) !== null,
  });
  // While a timer rings the step steps back to ink-soft: the alarm is the
  // stage's one subject until it is stopped (design round 2).
  // An interlude is an aside, never the instruction (B5d, D9): its words are
  // ink even while the step would hold the ember, which then goes unclaimed.
  const aside = typed.kind === "interlude";
  // How to check is reference reading, set in ink (critic round 2): ember is
  // for the act, and the states it names include the ones gone wrong.
  const quiet = aside || howToCheck;
  const stepTone = HOLDS_EMBER[holder === "step" && !quiet ? "ember" : alarm ? "soft" : "ink"];
  const stepEmber = holder === "step" && !quiet ? "" : undefined;
  // A checkpoint confirmed earlier, come back to: "Checked" is its one state,
  // with no question asked again (critic round 2).
  const checkedReturn = typed.kind === "checkpoint" && (stepType?.checked ?? false);
  const emberClock = holder === "timer" ? (timers?.soonestRunning ?? null) : null;
  const ledge = timers?.ledge ?? [];
  const anyClock = stepTimer !== null || ledge.length > 0 || alarm;
  const now = useNow(anyClock);
  const forward = () => {
    onNext();
  };
  const back = () => {
    onBack();
  };
  useImperativeHandle(navRef, () => ({
    forward: () => false,
    back: () => false,
    finishable: () => isLast && armed(),
    part: () => null,
  }));

  // The look-ahead (P58): the sheet's own handle, for the swipe's axis lock (N3a).
  const level = look?.level ?? 0;
  const footRef = useRef<HTMLDivElement>(null);
  const slotRef = useRef<HTMLDivElement>(null);
  const middleRef = useRef<HTMLDivElement>(null);
  const sheetHandle = look?.handleRef;

  // Swipe never finishes: finishing is a deliberate tap, not a stray gesture.
  // Like the arrows, it waits while a modal, panel or popover is open.
  // N3a axis lock: claimed touches never swipe.
  const swipeRef = useSwipeGesture<HTMLDivElement>({
    onSwipeLeft: () => {
      if (navEnabled && !isLast && !popoverOpen()) forward();
    },
    onSwipeRight: () => {
      if (navEnabled && !atStart && !popoverOpen()) back();
    },
    claimed: () => sheetHandle?.current?.claimed() ?? false,
  });

  // A tap on the stage turns the page (lib/kitchen/tap-zone.ts). The press is
  // read where it went down: one on a control, on Prep (its rows are the
  // job, and leaving it ticks them), on the scrollbar, or while a popover is
  // open (the press that closes it) is never a tap. The page turns on the
  // click, not the lift: a touch's click lands after the lift, on whatever is
  // under the finger then, so turning on the lift would hand it to a control
  // on the new page. The browser also withholds the click from a touch that
  // only stopped a scroll.
  const tapDown = useRef<TapPoint | null>(null);
  const onStageDown = (e: PointerEvent<HTMLDivElement>) => {
    tapDown.current = null;
    if (!e.isPrimary || e.button !== 0) return;
    const el = e.currentTarget;
    const onScrollbar = e.clientX - el.getBoundingClientRect().left >= el.clientLeft + el.clientWidth;
    const target = e.target instanceof Element ? e.target : null;
    if (!navEnabled || (view.onPrep && !alarm) || onScrollbar || popoverOpen() || (tapFenced(target) && !alarm)) return;
    tapDown.current = { x: e.clientX, y: e.clientY, t: performance.now() };
  };
  // While a timer rings, a tap on a control (a mise tick, an amount, a row's
  // offer) stops the alarm instead of reaching it: taken on the way down,
  // before the control's own handler (B5a verify, M1). The band's own button
  // is its dismiss, so it is let through.
  const onStageClickCapture = (e: MouseEvent<HTMLDivElement>) => {
    if (!alarm || !timers || !navEnabled || popoverOpen()) return;
    const target = e.target instanceof Element ? e.target : null;
    if (target?.closest("[data-alarm-band]")) return;
    e.stopPropagation();
    e.preventDefault();
    tapDown.current = null;
    timers.onDismiss(expired[0]!.id);
  };
  const onStageClick = (e: MouseEvent<HTMLDivElement>) => {
    const down = tapDown.current;
    tapDown.current = null;
    const target = e.target instanceof Element ? e.target : null;
    // While a timer rings, a tap anywhere on the stage stops it and moves
    // nothing: the hand that reaches for the screen is reaching for the alarm.
    if (alarm && timers && navEnabled && !popoverOpen()) {
      if (!target?.closest("[data-alarm-band]")) timers.onDismiss(expired[0]!.id);
      return;
    }
    // While pinned, tap zones are off: a tap on the stage returns to Now (N11).
    if (level > 0) {
      if (!down) return;
      look?.onLevel(0);
      return;
    }
    if (!down || !navEnabled || popoverOpen() || tapFenced(target)) return;
    const up = { x: e.clientX, y: e.clientY, t: performance.now() };
    const move = tapZone(down, up, e.currentTarget.getBoundingClientRect(), {
      atStart,
      isLast,
    });
    if (move === "next") forward();
    else if (move === "back") back();
  };

  const keys = useRef({ forward, back, atStart, isLast });
  useLayoutEffect(() => {
    keys.current = { forward, back, atStart, isLast };
  });

  useEffect(() => {
    if (!navEnabled) return;
    const onKey = (e: KeyboardEvent) => {
      if (e.defaultPrevented || e.altKey || e.ctrlKey || e.metaKey) return;
      // Arrows pressed in a field (Ask Claude, say), on media with controls or
      // in a widget that moves with them (a slider, a tab list) are that
      // element's, and must not turn the page as well.
      if (keyBelongsToTarget(e) || popoverOpen()) return;
      const k = keys.current;
      if (e.key === "ArrowRight" && !k.isLast) {
        e.preventDefault();
        k.forward();
      } else if (e.key === "ArrowLeft" && !k.atStart) {
        e.preventDefault();
        k.back();
      }
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [navEnabled]);

  const nowText = view.stack[0]?.text ?? COOK_COPY.noSteps;
  const finishing = view.isLast;
  const ledgeLead = ledge.length === 0 ? "" : `${ledge[0]!.id}:${ledge.length}`;
  const heard = heardLine(voice);
  useFootFit(
    footRef,
    [
      finishing,
      finishing && finish === "failed",
      ledgeLead,
      // A checkpoint's "Looks right" widens the forward (B5d verify round 1).
      typed.kind === "checkpoint" ? "looks-right" : "",
      opening ? "opening" : "",
    ].join("|"),
  );
  const padX = EDGE_X;
  const noteRow = view.note !== null || view.screens > 1;

  return (
    <div
      ref={swipeRef}
      className="relative flex min-h-0 flex-1 flex-col bg-ground"
    >
      {/* Beside Ask's side panel the stage gives up the panel's width
          (`--ask-room`, set on the cook's root; DS §5 Ask, v1.60), and the
          step fits again by its own ladder. The progress line's band does
          the same (`CookSheet`'s layer), and so does the foot: the panel
          runs the screen's height, and Back and Forward stand under the
          step. */}
      <div className="relative mr-[var(--ask-room,0px)] flex min-h-0 flex-1 flex-col">
        {/* Steps shrink down STEP_FIT_SCALES to 0.5×; auto scrolls if an
            unusually dense step or narrow window still runs past 0.5×. */}
        <div
          ref={scrollerRef}
          data-stage
          inert={restInert}
          style={{ touchAction: level > 0 ? "none" : undefined }}
          onPointerDown={onStageDown}
          onPointerCancel={() => {
            tapDown.current = null;
          }}
          onClickCapture={onStageClickCapture}
          onClick={onStageClick}
          className="relative min-h-0 flex-1 overflow-y-auto"
        >
          {view.asWritten && noteRow ? (
            // A cook as written keeps its note's row, which stays once it
            // empties after the first screen, so the steps don't jump up;
            // with one screen or none, it goes.
            <div data-no-tap className={`${padX} flex items-start pt-3 pb-5 md:pt-[22px] md:pb-[46px]`}>
              <p className="min-h-11 min-w-0 flex-1 pt-2 pb-3 text-[length:var(--type-meta)] leading-[1.3] font-medium text-ink-soft">
                {view.note}
              </p>
            </div>
          ) : !alarm ? (
            // The chapters live in the eyebrow now (V3): the body column
            // starts where DS §6's frame puts it, 104 cpx down in landscape;
            // in portrait the stack anchors at 150 cpx (V.md, P43(h)).
            <div aria-hidden data-stage-top className={STAGE_TOP} style={{ display: !view.onPrep && fitScale < 0.8 ? "none" : undefined }} />
          ) : null}
          {alarm && timers && (
            <div ref={bandRef} className={`${padX} mb-[var(--space-4)]`}>
              <AlarmBand expired={expired} now={now} onDismiss={timers.onDismiss} />
            </div>
          )}
          {soundLine && timers && (
            // Sound off with the clocks in the well (after a reload, before
            // a tap): the ghost that lets the chime sound stands here, as a
            // quiet line the fit counts (`shape`), not in the foot's row
            // (the merge with main's foot voice, 6f5102e: in portrait the
            // row ran off the screen).
            <div data-sound-line className={`${padX} -mt-[var(--space-1)] mb-[var(--space-4)]`}>
              <SoundOff onAllow={timers.onAllowSound} />
            </div>
          )}
          {notices.length > 0 && (
            // Quiet lines said once (B5a; B5b's too): ink-soft at the meta's
            // size above the stack, which the fit counts (`shape`).
            <div data-notices data-no-tap role="status" className={`${padX} -mt-[var(--space-1)] mb-[var(--space-4)]`}>
              {notices.map((line) => (
                <p key={line} className={`${COLUMN} text-[length:var(--type-meta)] leading-[1.3] font-medium text-ink-soft`}>
                  {line}
                </p>
              ))}
            </div>
          )}

          {(
            <div ref={stackRef} className={`relative ${padX}`} style={{ paddingBottom: view.onPrep ? PREP_FOOT : fitScale < 0.8 ? TIGHT_FOOT : STACK_FOOT }}>
            {/* An ingredients-only recipe: the note stands in for the method,
                so it lists every ingredient, and the finish is all there is. */}
            {view.stack.length === 0 && (
              <div data-no-steps="" className={`${ITEM} ${ROLE_CLASS.now}`}>
                <p data-face="text" className={`${COLUMN} text-pretty`}>
                  {COOK_COPY.noSteps}
                </p>
                {recipe && (
                  <div data-no-tap className="pt-[var(--space-4)]">
                    <ServingStepper
                      recipe={recipe}
                      servings={servings ?? recipe.serves_base}
                      scales={scales}
                      onChange={onServingsChange ?? (() => {})}
                    />
                  </div>
                )}
                <Meta
                  line={{
                    minutes: null,
                    implied: false,
                    ingredientIdx: ingredients.map((_, i) => i),
                  }}
                  ingredients={ingredients}
                />
              </div>
            )}
            {view.stack.map((line) => {
              const prep = line.kind === "prep" ? view.prep : null;
              return (
                <div
                  key={line.key}
                  data-line={line.key}
                  data-role="now"
                  className={`${ITEM} ${ROLE_CLASS.now}`}
                >
                  {prep ? (
                    <PrepScreen
                      prep={prep}
                      mode={mode}
                      showModeToggle={view.showModeToggle}
                      minutes={line.minutes}
                      times={times}
                      ringing={alarm}
                      onMode={onMode}
                      onTick={onTick}
                      onAskAhead={onAskAhead}
                      recipe={recipe}
                      servings={servings}
                      scales={scales}
                      onServingsChange={onServingsChange}
                      rowTimer={
                        timers?.prepOffer
                          ? (taskId) => {
                              const rowOffer = timers.prepOffer?.(taskId) ?? null;
                              if (rowOffer === null) return null;
                              return (
                                <TimerLine
                                  offer={rowOffer}
                                  timer={null}
                                  now={now}
                                  ember={false}
                                  soundLocked={false}
                                  onStart={() => timers.onStartOffer?.(rowOffer)}
                                  onAllowSound={timers.onAllowSound}
                                />
                              );
                            }
                          : undefined
                      }
                    />
                  ) : collapsed && typed.kind === "interlude" ? (
                    // An interlude read before on this tablet (B5d, D9): its
                    // title alone, and a way to read it again.
                    <div data-interlude="collapsed" data-no-tap className={`${COLUMN} flex flex-wrap items-center gap-x-[var(--space-3)] gap-y-[var(--space-2)]`}>
                      <p data-face="text" className={ASIDE_TITLE_ALONE}>
                        <span className="sr-only">{COOK_COPY.aside}: </span>
                        {typed.title}
                      </p>
                      <button type="button" aria-expanded={false} onClick={stepType?.onOpen} className={STEP_ACT}>
                        {COOK_COPY.readAgain}
                      </button>
                    </div>
                  ) : (
                    <>
                      {line.prep ? (
                        <PrepEyebrow line={line} />
                      ) : (
                        line.kind === "mise" && (
                          <div data-mise-eyebrow className={`${COLUMN} ${ASIDE_TITLE}`}>
                            {COOK_COPY.prepChapter}
                          </div>
                        )
                      )}
                      {aside && typed.kind === "interlude" && <AsideTitle title={typed.title} />}
                      {line.rows ? (
                        // A prep page of several small jobs (DS v1.59): tick rows where a step has its words.
                        <PrepRows rows={line.rows} ingredients={ingredients} onTick={onTick} discussed={discussedIdx} lifted={level > 0} />
                      ) : (
                        <p id={wordsId} data-face="text" data-ember={stepEmber} data-how-to-check={howToCheck ? "" : undefined} className={`${COLUMN} text-pretty ${aside || howToCheck ? ASIDE_WORDS : ""} ${stepTone}`}>
                          {bindNumbers(stepWordsShown(line.text))}
                        </p>
                      )}
                      {line.marginalia && (
                        <p data-marginalia className="mt-2 flex items-center gap-1.5 text-[length:var(--type-meta)] text-ink-soft">
                          <span aria-hidden="true" className="select-none text-ink-soft">✎</span>
                          <span>{line.marginalia}</span>
                        </p>
                      )}
                    </>
                  )}
                  {!prep && (
                    <Meta
                      // Tick rows carry their own minutes and amounts, and the eyebrow the page's time.
                      line={line.rows ? { minutes: null, implied: false, ingredientIdx: [] } : line}
                      ingredients={ingredients}
                      away={away}
                      ringing={alarm}
                      keepTime={stepTimer !== null}
                      discussed={discussedIdx}
                      acts={
                        typed.kind === "checkpoint" ? (
                          <CheckpointActs
                            checked={stepType?.checked ?? false}
                            notYet={hasHowToCheck(typed) && !checkedReturn}
                            open={howToCheck}
                            onNotYet={stepType?.onNotYet}
                            controls={wordsId}
                          />
                        ) : undefined
                      }
                      timer={
                        offer && timers ? (
                          <TimerLine
                            offer={offer}
                            timer={stepTimer}
                            done={timers.done ?? false}
                            ringing={timers.ringing ?? false}
                            now={now}
                            ember={stepTimer === null ? holder === "offer" : stepTimer.id === emberClock}
                            soundLocked={timers.soundLocked}
                            onStart={timers.onStart}
                            onAllowSound={timers.onAllowSound}
                          />
                        ) : undefined
                      }
                    />
                  )}
                </div>
              );
            })}
          </div>
          )}
        </div>
        <div
          ref={ghostRef}
          aria-hidden="true"
          inert
          className="pointer-events-none absolute inset-0 overflow-hidden"
        />
      </div>

      <p className="sr-only" aria-live="polite">
        {nowText}
      </p>
      {/* "How much", announced: a live region always there, so the answer is
          read out when it changes (B5d verify round 1). */}
      <span className="sr-only" role="status" data-answer-said>
        {answer?.shown ?? ""}
      </span>

      {/* The band's place in the flow: the stage fits above it. The sheet
          (fixed, over it) draws the band and everything it pulls up into. */}
      {look && <div ref={slotRef} data-band-slot aria-hidden className="w-full shrink-0" style={{ height: 0 }} />}
      {look && (
        <CookSheet
          {...look}
          onMode={onMode}
          nudge={nudgeWanted ? look.nudge : null}
          nudgeShown={nudgeFits}
          onNudgeHeight={setNudgeH}
          stageRef={scrollerRef}
          stackRef={stackRef}
          footRef={footRef}
          slotRef={slotRef}
          middleRef={middleRef}
          fit={fitScale}
          fitReady={fitReady}
          stepText={stepText}
          stepShape={`${view.pos}|${timers?.stepTimer?.id ?? ""}|${lines}`}
          alarm={alarm}
          onAlarmTap={() => {
            if (expired[0]) timers?.onDismiss(expired[0].id);
          }}
        />
      )}

      <div
        ref={footRef}
        data-foot
        inert={restInert || opening !== null}
        data-no-swipe={look ? "" : undefined}
        style={look ? { touchAction: "none" } : undefined}
        className={`${look ? FOOT_STRIP : FOOT} relative z-40 mr-[var(--ask-room,0px)]${opening ? " invisible" : ""}`}
      >
        {/* Back, then the well: a running timer whose step isn't on screen
            sits at the counter's edge, a place of its own that the middle's
            ghosts never move for (B5a, A8; design round 2). */}
        <div className="flex items-center gap-x-[var(--space-3)] justify-self-start">
          <BackButton
            atStart={(level === 0 || opening !== null) && atStart}
            onBack={level > 0 && !opening ? () => look?.onLevel(0) : back}
          />
          {timers && ledge.length > 0 && (
            <TimerLedge
              timers={ledge}
              emberId={emberClock}
              // The sound-off ghost isn't the foot's: it stands at the
              // stage's top (`soundLine`), which it has kept since the
              // foot's row held Ask Sous too (v1.48 to v1.59).
              soundLocked={false}
              onDismiss={timers.onDismiss}
              onAllowSound={timers.onAllowSound}
            />
          )}
        </div>
        {/* The middle is the strip's line (look-ahead slice 1): the sheet
            draws it here, and it is the way into the look-ahead (a pull or
            a tap). With no sheet it is empty and keeps Forward in its track. */}
        <div ref={middleRef} data-foot-middle aria-hidden={look ? undefined : "true"} className={look ? "relative min-w-0 self-stretch" : undefined} />
        <ForwardButton
          lastScreen={view.isLast}
          finish={finish}
          onNext={forward}
          onFinish={onFinish}
          ember={holder === "finish"}
          caption={typed.kind === "checkpoint" && !checkedReturn ? COOK_COPY.looksRight : undefined}
        />
        {/* The answer to "how much" is the voice's echo when it lifts (DS §5,
            quantity chips), so what was heard yields to it; and it stands down
            where something else says it or the foot steps aside. */}
        {heard !== null && !(answerLifted && answer) && !askOpen && !restInert && opening === null && (
          <HeardLift text={heard} />
        )}
        {answerLifted && answer && <AnswerLift answer={answer} anchorRef={look ? slotRef : footRef} rowRef={footRef} />}
      </div>
    </div>
  );
}
