import { useLayoutEffect, useRef, useState } from "react";

/**
 * The two shapes Ask Sous takes on the cook screen (DS §5 Ask, v1.60;
 * DECISIONS 2026-11-22 "Ask Sous is a side panel", call 1):
 *
 * - `side`: a panel beside the step, on a screen that is landscape and tall
 *   enough to hold a conversation. The step stays on screen.
 * - `sheet`: a full sheet over the step, everywhere else: portrait, and a
 *   phone on its side.
 *
 * One rule, read in script, because the form decides behaviour as well as
 * layout (whether the step still moves under Ask, where a ringing timer is
 * drawn): the two must never disagree.
 */
export type AskForm = "side" | "sheet";

/** The least height, in CSS px, a landscape screen needs for the side panel. */
export const ASK_SIDE_MIN_HEIGHT = 560;

/** The form for a screen of this size, in CSS px. A square screen is not landscape. */
export function askFormFor(width: number, height: number): AskForm {
  return width > height && height >= ASK_SIDE_MIN_HEIGHT ? "side" : "sheet";
}

/**
 * The form for this screen, following it as the tablet turns; the sheet on
 * the server, where Ask is never open.
 *
 * The screen, never the keyboard: the app's pages shrink under the soft
 * keyboard (`interactiveWidget: "resizes-content"`, `app/layout.tsx`), which
 * takes the tablet's 800 px of height under the side panel's 560. So while
 * Ask is open (`open`) a change of height alone never makes the screen
 * shorter than it has been at this width: the panel that opened beside the
 * step stays beside it with the keyboard up (call 9). A change of width is
 * the screen turning, and decides afresh; so does Ask closing.
 *
 * Known edges, left as they are (review round 2): Ask opened while another
 * field's keyboard is up, or the screen turned with the keyboard up, takes
 * the shrunk page's shape until the keyboard goes down, and then the
 * screen's. Nothing but the page's size says a keyboard is up.
 */
export function useAskForm(open = false): AskForm {
  const [form, setForm] = useState<AskForm>("sheet");
  const openNow = useRef(open);
  /** Reads the window and sets the form; the resize listener's, shared with Ask's closing. */
  const decideNow = useRef<(() => void) | null>(null);
  useLayoutEffect(() => {
    /** The tallest the page has been at this width while Ask was open. */
    let seen: { width: number; height: number } | null = null;
    const decide = () => {
      const { innerWidth: width, innerHeight: height } = window;
      const full = openNow.current && seen !== null && seen.width === width ? Math.max(seen.height, height) : height;
      seen = { width, height: full };
      setForm(askFormFor(width, full));
    };
    decideNow.current = decide;
    decide();
    window.addEventListener("resize", decide);
    return () => {
      window.removeEventListener("resize", decide);
      decideNow.current = null;
    };
  }, []);
  useLayoutEffect(() => {
    openNow.current = open;
    // As Ask closes nothing is held any longer, and no resize comes to say
    // so: the form is read from the window as it stands, for the next opening.
    if (!open) decideNow.current?.();
  }, [open]);
  return form;
}
