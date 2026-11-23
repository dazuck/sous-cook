/**
 * A `Measure` for the unit tests from the app's own fonts: each character's
 * advance width as Chromium's canvas gives it in Figtree 500/600/700 and
 * Caprasimo (`fixtures/font-advances.json`: `measureText` at 1000 px, one
 * character at a time, with the faces in `public/fonts`). Summing advances
 * leaves out kerning, which narrows text, so a fit here is a fit on the
 * tablet's fonts with a hair to spare.
 */

import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

type Faces = Record<"text-500" | "text-600" | "text-700" | "display-400", Record<string, number>>;

const FACES = (
  // A path, not a URL: under a DOM environment the global URL is the DOM's, which node:fs refuses.
  JSON.parse(readFileSync(join(dirname(fileURLToPath(import.meta.url)), "fixtures", "font-advances.json"), "utf8")) as { faces: Faces }
).faces;

/** Text width at `size` (any unit; the width comes back in the same unit). */
export function advanceMeasure(text: string, size: number, weight: number, family: "text" | "display" = "text"): number {
  const face =
    family === "display" ? FACES["display-400"] : weight >= 700 ? FACES["text-700"] : weight >= 600 ? FACES["text-600"] : FACES["text-500"];
  let w = 0;
  for (const ch of text) w += face[ch] ?? face["n"];
  return (w / 1000) * size;
}
