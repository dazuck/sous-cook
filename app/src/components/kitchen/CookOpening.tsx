"use client";

/**
 * The opening (slice N2, N2-10; slice N3; the timetable, DECISIONS
 * 2026-10-20): the whole cook before Prep, the whole screen, with no top line
 * and no foot. The sheet draws the timetable with the title over it
 * (`CookSheet`, `Timetable`); this module holds the words it gets, the
 * controls it hosts and the keys that start the cook.
 *
 * The controls hold the opening's one act, Start, which is the screen's
 * ember. Back, Ask and the forward step aside: the kitchen is More's way out.
 * A timer still running from another recipe keeps its well before Start, and
 * an alarm stands there too, its "Done" the tap that stops it, as the opening
 * doesn't fold on an alarm. While it rings Start waits in sand (`emberHolder`:
 * the alarm holds the screen's one ember).
 */

import { type RefObject, useEffect, useLayoutEffect, useRef } from "react";
import { dishName } from "@/lib/kitchen/dish-name";
import type { ShownTimes } from "@/lib/kitchen/recipe-times";
import { handsOnWords } from "@/lib/kitchen/time-line";
import { keyBelongsToTarget } from "@/lib/kitchen/key-target";
import type { KitchenTimer } from "@/lib/kitchen/timers";
import { COOK_COPY } from "@/lib/kitchen/cook-view";
import { FOOT_FILL, FOOT_FILL_WAITS } from "./control-style";
import { cpxLength, edgePx } from "./cook-edge";
import { TimerLedge } from "./TimerLedge";
import { VoiceDotButton, type VoiceProps } from "./VoiceDot";

/**
 * What the opening says over the timetable: the dish, and its hands-on
 * minutes. Its totals are the toggle's and the serve
 * line's; the ahead work is its own line (SPEC §6).
 */
export interface OpeningWords {
  title: string;
  /** The hands-on words as the kitchen row says them (`handsOnWords`); null when it says none. */
  handsOn: string | null;
}

/**
 * The opening's words: the dish's name as the app writes it, and the hands-on
 * words the kitchen row's time line says, from the same `shownTimes`
 * (`handsOnWords`): the plan's minutes, or the recipe's stated time as the
 * recipe's, "all hands-on" and "hands-free" included. Where the row says no
 * hands-on, neither does the opening.
 */
export function openingWords(name: string, times: ShownTimes | null): OpeningWords {
  return { title: dishName(name), handsOn: times ? handsOnWords(times) : null };
}

/**
 * Start's keys: Enter, Space and → start the cook from anywhere on the
 * opening. A key that belongs to what has focus (a field, another control's
 * Enter or Space) stays its own, as does any key while a popover holds the
 * keys; a held key starts once.
 */
export function useOpeningKeys(onStart: () => void, live: boolean): void {
  const start = useRef(onStart);
  useEffect(() => {
    start.current = onStart;
  });
  useEffect(() => {
    if (!live) return;
    const onKey = (e: KeyboardEvent) => {
      if (e.defaultPrevented || e.repeat || e.altKey || e.ctrlKey || e.metaKey) return;
      if (e.key !== "Enter" && e.key !== " " && e.key !== "ArrowRight") return;
      if (keyBelongsToTarget(e) || document.querySelector("[data-holds-keys]")) return;
      const target = e.target instanceof Element ? e.target : null;
      // A focused control's Enter and Space are its own (Start's included: its click starts).
      if (e.key !== "ArrowRight" && target?.closest("button, a[href], [role='button'], summary")) return;
      e.preventDefault();
      start.current();
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [live]);
}

/**
 * What the opening's row gives up to stay inside the screen's edges, in
 * order: the well's rungs, as the foot gives them (`FOOT_GIVES` in
 * `CookFlow.tsx`, DS §5 timers: "where the foot is shortest the well gives
 * last"): the clock's label stays its name, then the second clock goes
 * (still said), then the lead clock's digits step down to the chip's size.
 * Only the well gives; the voice dot and Start never do.
 */
const OPENING_GIVES = ["data-ledge-short", "data-ledge-one", "data-ledge-small"] as const;

/**
 * The row's fit, read off the row before paint: while it is wider than the
 * screen between its edges (`--edge` each side), it gives one rung at a time.
 * It fits again when what the row holds changes, when the screen's width
 * does, and when the faces arrive. The sheet measures the row after this, so
 * it places the row at the width it settled on.
 */
function useOpeningRowFit(row: RefObject<HTMLDivElement | null>, content: string) {
  useLayoutEffect(() => {
    const el = row.current;
    if (!el) return;
    const host = (): Element => el.closest("[data-cook-sheet]") ?? document.documentElement;
    // More stands at the row's right, 12 cpx after it (the timetable's opening, SPEC §6), so the
    // row's room is what the edges leave less More and that gap.
    const room = () => {
      const more = host().querySelector<HTMLElement>("[data-sheet-more]");
      return host().clientWidth - 2 * edgePx(el) - (more ? more.offsetWidth + cpxLength(el, 12) : 0);
    };
    const fit = () => {
      for (const give of OPENING_GIVES) el.removeAttribute(give);
      for (const give of OPENING_GIVES) {
        if (el.getBoundingClientRect().width <= room() + 0.5) return;
        el.setAttribute(give, "");
      }
    };
    fit();
    let width = host().clientWidth;
    const resize = new ResizeObserver(() => {
      if (host().clientWidth === width) return;
      width = host().clientWidth;
      fit();
    });
    resize.observe(host());
    document.fonts.addEventListener("loadingdone", fit);
    return () => {
      resize.disconnect();
      document.fonts.removeEventListener("loadingdone", fit);
    };
  }, [row, content]);
}

/**
 * The opening's controls (slice N3, N3-4(d)): the voice dot whenever voice is
 * supported (the foot's own rule), the well (an alarm first, then running
 * timers), and Start, in one row 12 cpx apart. The sheet places the row: at
 * the title band's right end in landscape, centred in the foot band in
 * portrait (`placeOverview`). Where the row is wider than the screen between
 * its edges, the well gives as the foot's does (`OPENING_GIVES`).
 */
export function OpeningControls({
  onStart,
  well,
  voice,
}: {
  onStart: () => void;
  /** The kitchen's timers, where the screen draws them; null where it draws none. */
  well: {
    /** Timers that rang and wait to be stopped: the well leads with them. */
    expired: readonly KitchenTimer[];
    /** Timers running, any recipe's. */
    running: readonly KitchenTimer[];
    onDismiss: (id: string) => void;
  } | null;
  voice?: VoiceProps;
}) {
  const ringing = (well?.expired.length ?? 0) > 0;
  const clocks = well ? [...well.expired, ...well.running] : [];
  const speaks = voice !== undefined && voice.status !== "unsupported";
  const rowRef = useRef<HTMLDivElement>(null);
  useOpeningRowFit(rowRef, `${speaks}|${ringing}|${clocks.map((t) => `${t.id}:${t.recipeName}:${t.label}`).join(",")}`);
  return (
    <div ref={rowRef} data-opening-controls className="group/foot flex items-center gap-[calc(12*var(--cpx))] whitespace-nowrap">
      {speaks && <VoiceDotButton {...voice} />}
      {well && clocks.length > 0 && (
        <div data-opening-well className="flex items-center">
          <TimerLedge timers={clocks} emberId={null} onDismiss={well.onDismiss} />
        </div>
      )}
      <button
        type="button"
        data-opening-start
        onClick={onStart}
        className={`${FOOT_FILL} px-[calc(36*var(--cpx))] ${ringing ? FOOT_FILL_WAITS : "bg-ember text-paper"}`}
      >
        {COOK_COPY.start}
      </button>
    </div>
  );
}
