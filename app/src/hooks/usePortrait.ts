import { useSyncExternalStore } from "react";

/** Tailwind's `portrait:`. */
export const PORTRAIT = "(orientation: portrait)";

function subscribe(onChange: () => void) {
  const query = window.matchMedia(PORTRAIT);
  query.addEventListener("change", onChange);
  return () => query.removeEventListener("change", onChange);
}

/**
 * Whether the screen is taller than wide; false on the server. For a
 * control that moves between rows as the tablet turns (the pack view's
 * search), where CSS alone would draw it twice.
 */
export function usePortrait(): boolean {
  return useSyncExternalStore(
    subscribe,
    () => window.matchMedia(PORTRAIT).matches,
    () => false,
  );
}
