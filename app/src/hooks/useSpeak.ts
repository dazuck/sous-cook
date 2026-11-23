"use client";

import { useCallback, useEffect, useRef, useState } from "react";
import { hush, speak } from "@/lib/kitchen/speak";

/**
 * Chrome can fail to fire `end` (a voice that never loads, a tab put away
 * mid-sentence), which would hold the mic for good, so the hold lifts after
 * this long whatever the synthesizer says (B5d, D13).
 */
export const SPEAK_HOLD_CAP_MS = 15_000;

/**
 * Speech for the cook page (slice B5d, D13): `say` speaks an answer, and
 * `speaking` is true while it is being said, so the mic can be held and the
 * answer isn't heard as a command. It lifts when the speech ends or fails,
 * or at SPEAK_HOLD_CAP_MS.
 */
export function useSpeak(): { speaking: boolean; say: (text: string) => boolean } {
  const [speaking, setSpeaking] = useState(false);
  const cap = useRef<ReturnType<typeof setTimeout> | null>(null);
  const turn = useRef(0);

  const clearCap = () => {
    if (cap.current !== null) clearTimeout(cap.current);
    cap.current = null;
  };

  const say = useCallback((text: string) => {
    const mine = ++turn.current;
    clearCap();
    const lift = () => {
      // An older answer, cancelled by this one, doesn't lift this one's hold.
      if (turn.current !== mine) return;
      clearCap();
      setSpeaking(false);
    };
    const started = speak(text, { onDone: lift });
    if (!started) {
      setSpeaking(false);
      return false;
    }
    setSpeaking(true);
    cap.current = setTimeout(lift, SPEAK_HOLD_CAP_MS);
    return true;
  }, []);

  useEffect(
    () => () => {
      clearCap();
      hush();
    },
    [],
  );

  return { speaking, say };
}
