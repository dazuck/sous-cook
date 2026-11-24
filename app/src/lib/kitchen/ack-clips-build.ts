/**
 * Whether a build carries Sue's clips: every one the player asks for, as a
 * file under `public/sounds/sue/`. `next.config.ts` asks this once, at build
 * time, and bakes the answer in as `SOUS_SUE_CLIPS`; the app reads it only
 * through `sueClipsShipped()` (`ack-clips.ts`). Nothing looks for the files
 * while the app runs.
 *
 * Node only: it reads the disk, so nothing in the browser imports it.
 */

import { existsSync } from "node:fs";
import { join } from "node:path";
import { CLIP_NAMES, SUE_CLIP_DIR } from "./ack-clips";

export function sueClipsInBuild(publicDir: string): boolean {
  return CLIP_NAMES.every((name) => existsSync(join(publicDir, SUE_CLIP_DIR, `${name}.mp3`)));
}
