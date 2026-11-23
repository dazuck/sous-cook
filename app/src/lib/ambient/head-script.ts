import { ambientEngine } from "./engine";

/**
 * The root layout's inline <head> script (P67). It runs before the first
 * paint and sets `--ambient-t` on <html> from the same engine the client
 * component ticks with, so a cold load at night paints the night stop at once
 * and no 60 s transition has anything to animate from.
 *
 * `place` and `force` are the household's configuration, serialized in.
 */
export function ambientHeadScript(
  place: { lat: number; lng: number; tz: string },
  force: string | null,
): string {
  return (
    `(function(){var e=(${ambientEngine.toString()})();` +
    `document.documentElement.style.setProperty("--ambient-t",` +
    `e.cssValue(new Date(),location.search,${JSON.stringify(force)},${JSON.stringify(place)}));})();`
  );
}
