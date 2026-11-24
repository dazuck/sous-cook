"use client";

import {
  Fragment,
  useId,
  useState,
  type CSSProperties,
  type ReactNode,
} from "react";
import type { Recipe } from "@sous/pack";
import type { PrepMode } from "@/lib/kitchen/cook-plan";
import {
  COOK_COPY,
  bindNumbers,
  type PrepAheadGroup,
  type PrepContent,
  type PrepMise,
} from "@/lib/kitchen/cook-view";
import { ServingStepper } from "./ServingStepper";
import { TickTile } from "./TickTile";
import { TimeLineWords } from "./TimeLineWords";

interface PrepScreenProps {
  prep: PrepContent;
  mode: PrepMode;
  /** The "Prep first | As I go" toggle; only while the cook is starting out. */
  showModeToggle: boolean;
  /** How long the prep still to do here takes, when it is known. */
  minutes: string | null;
  /**
   * How long the whole recipe takes, the time line's parts (`timeLine`,
   * slice T2), its ahead part left off: the make-ahead groups under it say
   * that. Null when there is nothing to say.
   */
  times: string[] | null;
  /**
   * A timer rings: the alarm owns the stage, so the mode toggle steps aside.
   */
  ringing?: boolean;
  onMode: (mode: PrepMode) => void;
  onTick: (id: string) => void;
  onAskAhead: (group: PrepAheadGroup) => void;
  /**
   * A row's timer offer (slice B5a, A9): the step's timer, on the Prep row
   * of the task that carries it, until it is started; then its clock is in
   * the ledge, as a step's is once the cook moves on.
   */
  rowTimer?: (taskId: string) => ReactNode;
  recipe?: Pick<Recipe, "serves_base" | "serves_estimated">;
  servings?: number;
  scales?: boolean;
  onServingsChange?: (servings: number) => void;
}

// A row is set like a step (600, tightened); what only comes up later is
// soft 500, so the two groups part by ink and weight, not by a heading colour.
// Its size steps down with the screen's fit (`--prep-fit`, on the screen):
// the chip's 30 cpx, so the ladder's last rung, 0.8, is 24 cpx and never
// under the meta's floor (V fix round 1; it was 22 / 28 px, under the floor
// on the tablet at every rung).
const ROW_SIZE =
  "text-[length:calc(var(--type-chip)*var(--prep-fit))] leading-[1.2] tracking-[-0.012em]";
// Prep's small words, beside and under the rows: the meta's 22 cpx, the
// floor, which the fit never takes them under (DS §2).
const META = "text-[length:var(--type-meta)]";
const ROW_TEXT = `${ROW_SIZE} font-semibold`;
const LATER_TEXT = `${ROW_SIZE} font-medium text-ink-soft`;
const HIT =
  "relative before:absolute before:inset-x-0 before:top-1/2 before:h-12 before:-translate-y-1/2 before:content-['']";
// The gaps between Prep's blocks step down with its type.
const FIT_GAP = "mb-[calc(18px*var(--prep-fit))]";
// Small text inside a row or the stage, which is set 600 and tightened.
const SMALL = "tracking-normal";
const FOCUS =
  "focus-visible:outline-3 focus-visible:outline-offset-3 focus-visible:outline-ink";
// A text button: ink, underlined softly.
// The way out of missed ahead work is reached for with messy hands: set like
// the rows, so it reads as a control, and a target's height at least as a hit
// area (DS §5), which hangs down over the open group's own work, never past it.
const ASK_LINK = `relative shrink-0 cursor-pointer whitespace-nowrap ${ROW_SIZE} font-semibold text-ink underline decoration-2 decoration-ink-soft underline-offset-[6px] ${FOCUS} before:absolute before:-inset-x-3 before:top-0 before:h-[var(--target)] before:content-['']`;
const EN_SPACE = " ";

/**
 * A small label beside a line: when it comes up, or (muted, as plain quiet
 * text) "assumed".
 */
export function CookPill({ children, muted = false }: { children: ReactNode; muted?: boolean }) {
  return (
    <span
      className={`inline-block whitespace-nowrap font-medium leading-none ${SMALL} ${
        muted
          ? `${META} text-ink-soft`
          : `rounded-full bg-sand px-[calc(12*var(--cpx))] py-[calc(8*var(--cpx))] ${META} text-ink`
      }`}
    >
      {children}
    </span>
  );
}

/** After a line that opens: down while shut, up once open. */
function Chevron({ open }: { open: boolean }) {
  return (
    <svg
      viewBox="0 0 24 24"
      width="20"
      height="20"
      fill="none"
      stroke="currentColor"
      strokeWidth="2.4"
      strokeLinecap="round"
      strokeLinejoin="round"
      aria-hidden="true"
      className={`ml-2 inline-block align-middle text-ink-soft transition-transform duration-[320ms] ease-[var(--ease)] ${
        open ? "rotate-180" : ""
      }`}
    >
      <path d="M6 9l6 6 6-6" />
    </svg>
  );
}

/**
 * Ahead work sharing a lead. Shut, it is one line: the lead, then the short
 * labels, each kept whole ("At least 4 hours before: grate garlic; juice
 * lemon"). Open, it is the lead over the full sentences, with the one way out
 * that serves the lot beside it; the group stands at least a target tall, so
 * that way out's hit area stays its own.
 */
function AheadGroup({
  group,
  open,
  onToggle,
  onAskAhead,
  rowTimer,
}: {
  group: PrepAheadGroup;
  open: boolean;
  onToggle: () => void;
  onAskAhead: (group: PrepAheadGroup) => void;
  rowTimer?: (taskId: string) => ReactNode;
}) {
  const headingId = useId();
  const listId = useId();
  return (
    <section aria-labelledby={headingId} className={open ? "min-h-[var(--target)]" : undefined}>
      {/* The way out follows the lead on its line rather than the column's
          far edge, where it read as detached from its group (C-review-3
          gap 8). */}
      <div className="flex items-baseline gap-x-6">
        <h3 id={headingId} className="min-w-0">
          <button
            type="button"
            aria-expanded={open}
            aria-controls={listId}
            onClick={onToggle}
            className={`${HIT} cursor-pointer text-left text-ink ${FOCUS}`}
          >
            <span className={`inline-block ${META} font-semibold leading-tight ${SMALL} first-letter:uppercase`}>
              {bindNumbers(`${group.lead ?? COOK_COPY.aheadUntimed}:`)}
            </span>
            {" "}
            {/* Open, the sentences say it: the labels are left to be heard,
                so the group and its way out still name the work. */}
            <span data-labels className={open ? "sr-only" : ROW_TEXT}>
              {group.labels.map((label, i) => (
                <Fragment key={i}>
                  {i > 0 && "; "}
                  <span className="whitespace-nowrap">{bindNumbers(label)}</span>
                </Fragment>
              ))}
            </span>
            <Chevron open={open} />
          </button>
        </h3>
        {open && (
          <button
            type="button"
            aria-describedby={headingId}
            onClick={() => onAskAhead(group)}
            className={ASK_LINK}
          >
            {group.items.length === 1 ? COOK_COPY.missedAhead : COOK_COPY.missedAheadMany}
          </button>
        )}
      </div>
      <ul id={listId} hidden={!open} className="mt-1 grid gap-3">
        {(open ? group.items : []).map((a) => {
          const timer = rowTimer?.(a.id);
          return (
            <li key={a.id} className={`text-ink ${ROW_TEXT}`}>
              {bindNumbers(a.text)}
              <RowTimer offer={timer} />
            </li>
          );
        })}
      </ul>
    </section>
  );
}

/** A row's timer offer, after its last word on the row's own line. */
function RowTimer({ offer }: { offer: ReactNode }) {
  if (!offer) return null;
  return <span className="ml-3 inline-flex align-middle">{offer}</span>;
}

/**
 * The mise done before cooking starts: each row a tick, rendered in full in
 * its natural order. In "Prep first", rows that could wait for a hands-off
 * cooking window carry a quiet sand pill ("or while you …") after their words
 * so the cook sees what must be done before heat starts vs. what can wait.
 */
function MiseList({
  prep,
  mise,
  onTick,
  rowTimer,
}: {
  prep: PrepContent;
  mise: PrepMise[];
  onTick: (id: string) => void;
  rowTimer?: (taskId: string) => ReactNode;
}) {
  // Each tick is named by its whole line, marks included ("assumed"), so a
  // screen reader hears what a sighted cook reads.
  const lineId = useId();
  return (
    <ul data-mise className="grid gap-3">
      {mise.map((m, i) => (
        <li key={m.id} data-row className="flex items-start gap-4">
          <TickTile checked={m.done} labelledBy={`${lineId}-${i}`} onToggle={() => onTick(m.id)} />
          <p
            onClick={(e) => {
              const target = e.target instanceof Element ? e.target : null;
              if (target?.closest("button, a")) return;
              onTick(m.id);
            }}
            className={`min-w-0 flex-1 cursor-pointer select-none self-center py-1.5 transition-colors duration-[320ms] ease-[var(--ease)] ${ROW_TEXT} ${
              m.done ? "text-ink-soft" : "text-ink"
            }`}
          >
            {/* The row's words name its tick; its optional "or while…" mark and
                timer, after them, are not part of the name. */}
            <span id={`${lineId}-${i}`}>
              {bindNumbers(m.text)}
              <AssumedMark prep={prep} mise={m} />
            </span>
            {!m.done && m.when && <Mark>{bindNumbers(COOK_COPY.orWhen(m.when))}</Mark>}
            {!m.done && rowTimer && <RowTimer offer={rowTimer(m.id)} />}
          </p>
        </li>
      ))}
    </ul>
  );
}

/**
 * The marks run on after the words, so each stays with its own line. An en
 * space parts them: unlike a margin, it hangs at the end of the line when a
 * mark wraps, so the mark starts flush left.
 */
function Mark({ children, muted = false }: { children: ReactNode; muted?: boolean }) {
  return (
    <>
      {EN_SPACE}
      <span className="align-middle">
        <CookPill muted={muted}>{children}</CookPill>
      </span>
    </>
  );
}

function AssumedMark({ prep, mise }: { prep: PrepContent; mise: PrepMise }) {
  return mise.implied && !prep.assumedNote ? <Mark muted>{COOK_COPY.assumed}</Mark> : null;
}

// "As you cook" stands apart from the mise above it.
const LATER_GAP = "mt-[calc(24px*var(--prep-fit))]";

/**
 * As I go: the mise that comes up in the steps. Nothing to tick here — each
 * row says when it comes up, listed in full in its natural order.
 */
function LaterList({
  prep,
  mise,
}: {
  prep: PrepContent;
  mise: PrepMise[];
}) {
  const headingId = useId();
  return (
    <section aria-labelledby={headingId} className={LATER_GAP}>
      <h3
        id={headingId}
        className={`mb-2 ${META} font-semibold leading-tight ${SMALL} text-ink-soft`}
      >
        {COOK_COPY.laterHeading}
      </h3>
      <ul className="grid gap-2">
        {mise.map((m) => (
          <li key={m.id} className={LATER_TEXT}>
            {bindNumbers(m.text)}
            <AssumedMark prep={prep} mise={m} />
            {m.done ? (
              <Mark muted>{COOK_COPY.stateDone}</Mark>
            ) : (
              m.when && <Mark>{bindNumbers(m.when)}</Mark>
            )}
          </li>
        ))}
      </ul>
    </section>
  );
}

/**
 * The first screen: what should already have happened (ahead work) and the
 * prep itself — in "As I go", split into what is done before starting and what
 * comes up as they cook; in "Prep first", all in one checklist with "or while…"
 * pills on movable rows. All groups and rows render in full in their natural
 * order, and the stage scrolls vertically when the checklist runs taller than
 * the viewport.
 */
export function PrepScreen({
  prep,
  minutes,
  times,
  onTick,
  onAskAhead,
  rowTimer,
  recipe,
  servings,
  scales = true,
  onServingsChange,
}: PrepScreenProps) {
  const now = prep.mise.filter((m) => m.before);
  const later = prep.mise.filter((m) => !m.before);

  // One make-ahead group open at a time, by its first task's id.
  const [aheadOpen, setAheadOpen] = useState<string | null>(null);
  const aheadKey = (group: PrepAheadGroup) => group.items[0].id;

  const effectiveServings = recipe ? (scales ? (servings ?? recipe.serves_base) : recipe.serves_base) : undefined;
  const hasScaleNote = Boolean(recipe && scales && effectiveServings !== undefined && effectiveServings !== recipe.serves_base);
  const notes = [prep.assumedNote, prep.aheadNote].filter(Boolean);
  const scale = 1;

  return (
    <div
      data-prep
      data-fit={scale}
      className={ROW_SIZE}
      style={{ "--prep-fit": scale } as CSSProperties}
    >
      {times && (
        // The whole recipe's time, as the kitchen's row said it: the meta's
        // quiet words, which the fit never steps down; a wrap falls between
        // the line's parts, never inside a duration (slice T2).
        <p data-times className={`${FIT_GAP} ${META} leading-tight font-medium ${SMALL} text-ink-soft last:mb-0`}>
          <TimeLineWords parts={times} />
        </p>
      )}
      {recipe && effectiveServings !== undefined && (
        <div data-prep-servings className={`${FIT_GAP} last:mb-0`}>
          <ServingStepper
            recipe={recipe}
            servings={effectiveServings}
            scales={scales}
            onChange={onServingsChange ?? (() => {})}
          />
          {hasScaleNote && (
            <p
              data-prep-scale-note
              className={`mt-2 ${META} leading-tight font-medium ${SMALL} text-ink-soft`}
            >
              {COOK_COPY.prepScaleNote(recipe.serves_base)}
            </p>
          )}
        </div>
      )}
      {prep.ahead.length > 0 && (
        <div className="mb-[calc(24px*var(--prep-fit))] grid gap-4 last:mb-0">
          {prep.ahead.map((group) => (
            <AheadGroup
              key={aheadKey(group)}
              group={group}
              open={aheadKey(group) === aheadOpen}
              onToggle={() => setAheadOpen(aheadOpen === aheadKey(group) ? null : aheadKey(group))}
              onAskAhead={onAskAhead}
              rowTimer={rowTimer}
            />
          ))}
        </div>
      )}
      {now.length > 0 && (later.length > 0 || Boolean(minutes)) && (
        <p
          data-before-head
          className={`mb-2 flex flex-wrap items-baseline gap-x-[var(--space-4)] gap-y-1 ${META} leading-tight ${SMALL} text-ink-soft`}
        >
          {later.length > 0 && <span className="font-semibold">{COOK_COPY.beforeYouStart}</span>}
          {minutes && <span className="font-medium">{bindNumbers(minutes)}</span>}
        </p>
      )}
      {now.length > 0 && (
        <MiseList
          prep={prep}
          mise={now}
          onTick={onTick}
          rowTimer={rowTimer}
        />
      )}
      {prep.beforeNote && (
        <p className={`text-ink ${ROW_TEXT}`}>{prep.beforeNote}</p>
      )}
      {later.length > 0 && <LaterList prep={prep} mise={later} />}
      {notes.length > 0 && (
        <div data-notes className={`mt-[18px] grid max-w-[60ch] gap-1.5 ${META} leading-[1.4] font-medium ${SMALL} text-ink-soft`}>
          {notes.map((n) => (
            <p key={n}>{n}</p>
          ))}
        </div>
      )}
    </div>
  );
}
