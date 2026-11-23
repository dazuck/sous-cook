/**
 * Timer parity (slice B5d, B5.md §B5d D4): a pack recipe read natively takes
 * its timers from its own `timer_sec`, never from its text. So every step of
 * every pack file the registry lists must agree with the reading B5a gives
 * the same text (`textTimerSec`), or sit on the reviewed exception list below
 * with its reason. A step whose text states a length and whose `timer_sec` is
 * null would otherwise lose, read natively, the timer its projection had.
 *
 * Probed 2026-10-10: the Fannie Farmer draft's 69 steps state one length,
 * Parker House Rolls' bake ("twelve to fifteen minutes"), which already
 * carries 720 s, so the planned fill had nothing to fill.
 */

import { readFileSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";
import { parsePack, type Pack } from "@sous/pack";
import { SHELF_SOURCES } from "../shelf/registry";
import { textTimerSec } from "./convert";

const PACKS_DIR = fileURLToPath(new URL("../../../../packs/", import.meta.url));

/**
 * Steps whose `timer_sec` may differ from their text's reading, each with its
 * reason, reviewed by hand: `<packId>/<recipeId>/<stepId>`. Empty today.
 */
const EXCEPTIONS: ReadonlyMap<string, string> = new Map();

interface Mismatch {
  step: string;
  pack: number | null;
  text: number | null;
}

/** Every step of `pack` whose own timer and its text's reading disagree. */
function timerMismatches(pack: Pack): Mismatch[] {
  return pack.recipes.flatMap((recipe) =>
    recipe.steps.flatMap((step) => {
      const own = step.timer_sec ?? null;
      const text = textTimerSec(step.text);
      return own === text ? [] : [{ step: `${pack.id}/${recipe.id}/${step.id}`, pack: own, text }];
    }),
  );
}

function registryPacks(): Pack[] {
  return SHELF_SOURCES.flatMap((source) => {
    if (source.source.type !== "pack-file") return [];
    const parsed = parsePack(JSON.parse(readFileSync(path.join(PACKS_DIR, source.source.path), "utf8")));
    if (!parsed.ok) throw new Error(`${source.id} doesn't parse`);
    return [parsed.value];
  });
}

describe("timer parity (B5d D4)", () => {
  it("lists at least one pack file to check", () => {
    expect(registryPacks().length).toBeGreaterThan(0);
  });

  it("every registry pack step's timer_sec is what its text gives it, or a reviewed exception", () => {
    const unexplained = registryPacks()
      .flatMap(timerMismatches)
      .filter((m) => !EXCEPTIONS.has(m.step));
    expect(unexplained).toEqual([]);
  });

  it("Fannie: one stated length in 69 steps, already 720 s", () => {
    const fannie = registryPacks().find((p) => p.id === "fannie-farmer-1896")!;
    const steps = fannie.recipes.flatMap((r) => r.steps);
    expect(steps).toHaveLength(69);
    expect(steps.filter((s) => s.timer_sec != null).map((s) => [s.id, s.timer_sec])).toEqual([["bake", 720]]);
  });

  it("catches a step that states a length with no timer_sec, and one timed with none stated", () => {
    const fannie = registryPacks().find((p) => p.id === "fannie-farmer-1896")!;
    const pack = structuredClone(fannie);
    const rolls = pack.recipes.find((r) => r.id === "parker-house-rolls")!;
    rolls.steps.find((s) => s.id === "bake")!.timer_sec = null;
    rolls.steps.find((s) => s.id === "scald-milk")!.timer_sec = 60;
    expect(timerMismatches(pack)).toEqual([
      { step: "fannie-farmer-1896/parker-house-rolls/scald-milk", pack: 60, text: null },
      { step: "fannie-farmer-1896/parker-house-rolls/bake", pack: null, text: 720 },
    ]);
  });
});
