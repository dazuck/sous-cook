"use client";

import { COOK_COPY } from "@/lib/kitchen/cook-view";
import type { IngredientLine } from "@/lib/kitchen/ingredient-display";
import { MeasurementPopover } from "./MeasurementPopover";

// A step's amount pairs, drawn the same wherever a step shows them: under a
// step's words (`CookFlow`'s meta) and under each tick row of a prep page
// (`PrepRows`, DS v1.59).

// A change of tone takes the step's 320 ms, at once under reduced motion.
export const STEP_TONE =
  "transition-colors duration-[var(--dur-step)] ease-[var(--ease)] motion-reduce:transition-none";

// What goes in reads as words, not chips (V8, DS §5): "½ tsp turmeric · 1 tbsp
// ghee" at the meta's size, the amount ink 600, the name ink-soft; an amount
// that opens (its conversions, or a moved count's "Exactly") sits over a
// dotted rule, which the popover's button draws (AMOUNT_RULE), and every other
// amount is plain words in the same type (DECISIONS 2026-10-26). A dot sets a pair off from the next one
// shown, after it, so pairs that wrap end a line on a dot and open the next on
// words. Each pair is padded up to a 48 px line pitch, its hit box the one
// stated exception to the 80 cpx target: pairs in running text can't each take
// 80 without the lines spreading apart, and flipping a unit comes after
// reading the amount.
const PAIRS_LIST =
  "flex flex-wrap items-center text-[length:var(--type-meta)] leading-[1.3] font-medium tracking-normal text-ink-soft";
export const PAIRS =
  `${PAIRS_LIST} ` +
  "[&>li:not([hidden]):has(~li:not([hidden]))]:after:px-[var(--space-2)] [&>li:not([hidden]):has(~li:not([hidden]))]:after:content-['·']";
// The same list where each pair carries its own dot (`Pair`'s `sep`), as the last of its words: a
// pair too long for its line wraps inside its own box, and a dot drawn after that box then stood
// alone on a line of its own (a tick row's amounts are narrower than a step's; review round 1 of
// prep pages). Inside the pair it follows the pair's last word, so no line starts on a dot or holds
// one alone. It is an element hidden from a screen reader, not the pair's `::after`: generated
// content is part of a button's name, and an amount's button read "20 tbsp dark soy sauce ·"
// (review round 2). It stays ink-soft while its pair is the one discussed.
export const PAIRS_OWN_DOT = PAIRS_LIST;
const SEP = "px-[var(--space-2)] font-medium text-ink-soft!";
// The padding centres the words in the pitch; the floor holds it at 48 when
// layout rounds the half-pitch down.
const PAIR = "inline-block min-h-[48px] py-[max(0px,calc((48px-1.3em)/2))]";
// The rule's colour and offset, for when the button draws it.
const AMOUNT = "font-semibold text-ink decoration-ink-soft underline-offset-[0.15em]";

/**
 * One pair's words (slice B4 step 8): the amount the recipe states, then the
 * name. A measured amount opens its conversions, and a scaled count its exact
 * count where rounding moved it; any other count, the source's own words ("a
 * pinch of", marked as written) and a measure with nothing to convert are
 * plain words; to taste and unstated show the name alone.
 */
// The pair "how much" just answered (B5d, D13; DS §5 "ember = the one being
// discussed"): its words in ember-700 for the answer's linger, holding the
// screen's one ember, then back to ink over the step's 320 ms.
const DISCUSSED = `${STEP_TONE} font-semibold [color:var(--ember-700)] [&_*]:[color:var(--ember-700)] [&_*]:decoration-[var(--ember-700)]`;

export function Pair({
  line,
  discussed = false,
  sep = false,
}: {
  line: IngredientLine;
  discussed?: boolean;
  /** Draws the dot that sets it off from the next pair itself (a `PAIRS_OWN_DOT` list). */
  sep?: boolean;
}) {
  // A name that was only the amount is empty: the amount stands alone (B4 fix round 3).
  const named = line.name === "" ? null : <> {line.name}</>;
  const pair = `${PAIR}${discussed ? ` ${DISCUSSED}` : ""}`;
  const dot = sep ? (
    <span data-pair-dot aria-hidden="true" className={SEP}>
      ·
    </span>
  ) : null;
  const mark = discussed ? { "data-discussed": "" } : {};
  switch (line.kind) {
    case "amount":
      return (
        <MeasurementPopover
          stated={line.stated}
          conversions={line.conversions}
          servesBase={line.servesBase}
          className={pair}
        >
          <span {...mark} data-amount-words className={AMOUNT}>{line.amount}</span>
          {named}
          {dot}
        </MeasurementPopover>
      );
    case "count":
      if (line.exact !== undefined) {
        return (
          <MeasurementPopover
            stated={[]}
            conversions={[]}
            exact={line.exact}
            className={pair}
          >
            <span {...mark} data-amount-words className={AMOUNT}>{line.amount}</span>
            {named}
            {dot}
          </MeasurementPopover>
        );
      }
      return (
        <span {...mark} className={pair}>
          <span data-amount-words className={AMOUNT}>{line.amount}</span>
          {named}
          {dot}
        </span>
      );
    case "as_written":
      return (
        <span {...mark} className={pair}>
          <span data-amount-words className={AMOUNT}>{line.amount}</span>
          {named}{" "}
          <span data-as-written>
            ({line.servesBase !== undefined ? COOK_COPY.asWrittenFor(line.servesBase) : COOK_COPY.asWritten})
          </span>
          {dot}
        </span>
      );
    case "to_taste":
    case "unstated":
      return (
        <span {...mark} className={pair}>
          {line.name}
          {dot}
        </span>
      );
  }
}
