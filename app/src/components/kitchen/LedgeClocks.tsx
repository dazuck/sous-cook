"use client";

/**
 * The kitchen's timers on a borrowed screen's or page's ledge (slice B5a,
 * A8): "anything that takes the screen keeps running timers in view". The
 * ledge's capsule is one target, the way back, so the clock stands in the
 * bar beside it, not inside it: a running clock takes no tap (the tap there
 * is still the capsule's), a finished one is its own dismiss target. A
 * borrowed screen has no step and keeps its own one ember (the full screen's
 * map keeps its bar), so a running clock here is ink; only an alarm is ember.
 *
 * One clock, on one row, between the capsule's right end and the screen's
 * edge: the alarm first, else the soonest, the others said in words. Its box
 * is measured from the capsule as drawn (labels differ, "Back to the
 * kitchen", "Back to cooking"), never assumed, so nothing reaches the capsule
 * or runs off the screen (the re-verify of 4bbf470: at 800 px "Done" and
 * "3:02:05" ran past the edge). The box is a size container: under 200 px the
 * digits step down to the meta's 22 cpx and "Done"'s ring tightens; under
 * 170 px the name goes, still said. The sound-off ghost isn't here: a tap on
 * the ledge is the tap that lets the chime sound.
 */

import { useLayoutEffect, useRef, useState } from "react";
import { Clock } from "./TimerLine";
import { ledgeLead } from "./TimerLedge";
import { useKitchenTimers, useNow } from "./KitchenTimers";

/** The gap between the capsule and the clock: the space scale's 16 cpx. */
const GAP = "calc(16*var(--cpx))";

/**
 * The ledge bar's class while a clock is drawn in it: `relative`, so the
 * clock's box has the bar to stand in. Only then: a positioned bar is its
 * own layer, and Chrome rasterizes the screen's dotted rules a shade lighter
 * under it ("1 tbsp" on Ingredients; the re-verify's bisect of 25dca90), so
 * a ledge with no clock stays exactly main's.
 */
export function useLedgeBarClass(): string {
  const { timers } = useKitchenTimers();
  return timers.length > 0 ? "relative" : "";
}

export function LedgeClocks({ inline = false }: { inline?: boolean } = {}) {
  const { timers, dismiss } = useKitchenTimers();
  const now = useNow(timers.length > 0);
  const lead = ledgeLead(timers, now);
  const ref = useRef<HTMLDivElement>(null);
  // Where the capsule ends, in px from the bar's left; null until measured.
  const [from, setFrom] = useState<number | null>(null);
  const shown = lead !== null;
  useLayoutEffect(() => {
    if (inline) return;
    const box = ref.current;
    const bar = box?.parentElement;
    const capsule = bar?.firstElementChild;
    if (!shown || !box || !bar || !(capsule instanceof HTMLElement) || capsule === box) return;
    const measure = () => {
      // Layout boxes, not the drawn ones: a borrowed screen rises in by a
      // transform, which a ResizeObserver never reports. The bar is the
      // capsule's offset parent (it is `relative`).
      setFrom(Math.ceil(capsule.offsetLeft + capsule.offsetWidth));
    };
    measure();
    const resize = new ResizeObserver(measure);
    resize.observe(bar);
    resize.observe(capsule);
    return () => resize.disconnect();
  }, [shown, inline]);
  if (lead === null) return null;
  if (inline) {
    return (
      <div
        ref={ref}
        data-ledge-clocks
        className="pointer-events-none ml-auto flex min-w-0 flex-1 @container items-center justify-end [&_button]:pointer-events-auto"
      >
        <Clock timer={lead} now={now} ember={false} size="ledge" more={timers.length - 1} ledge onDismiss={dismiss} />
      </div>
    );
  }
  return (
    <div
      ref={ref}
      data-ledge-clocks
      style={{ left: from === null ? undefined : `calc(${from}px + ${GAP})`, visibility: from === null ? "hidden" : undefined }}
      className="pointer-events-none absolute inset-y-0 right-[var(--edge,24px)] @container flex min-w-0 items-center justify-end [&_button]:pointer-events-auto"
    >
      <Clock timer={lead} now={now} ember={false} size="ledge" more={timers.length - 1} ledge onDismiss={dismiss} />
    </div>
  );
}
