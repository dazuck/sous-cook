/**
 * What the cook screen knows at a flag, as `buildReport` takes it (B2
 * decision 5): the screen in hand, or the one that borrowed it, the step and
 * chapter under it, and the session's committed state as plain data. Pure:
 * the cook screen reads its layers and the flow's part through refs and
 * hands them over at the flag.
 */

import type { CookSession } from "./cook-session";
import { cookView, screensOf, stepKey, stepName } from "./cook-view";
import type { CookSnapshot, FlagStep, ReportScreen } from "./report-capture";

/** The layers the cook screen can have open over the steps, as it holds them. */
export interface CookLayers {
  allSteps?: boolean;
  ingredients?: boolean;
  info: boolean;
  wholeCook?: boolean;
  pane?: boolean;
  /** A bar's card, and on which whole cook it is open. */
  card?: "pane" | "screen" | null;
  more: boolean;
  level?: 0 | 1 | 2 | 3;
  read?: boolean;
}

export interface SnapshotInputs {
  queueId: string | null;
  recipeName: string;
  session: CookSession;
  layers: CookLayers;
  part: CookSnapshot["part"];
  voice: CookSnapshot["voice"];
  ask: CookSnapshot["ask"];
}

/** The borrowed screen on top, else null. One borrows the screen at a time. */
function borrowed(layers: CookLayers): ReportScreen | null {
  if (layers.level === 3 || layers.wholeCook) return "whole-cook";
  if (layers.allSteps) return "all-steps";
  if (layers.ingredients) return "ingredients";
  if (layers.info) return "info";
  return null;
}

export function cookSnapshot(inputs: SnapshotInputs): CookSnapshot {
  const { plan, source, state } = inputs.session;
  const screens = screensOf(plan, state.mode, state.ticked);
  const here = screens[state.pos];
  if (here === undefined) {
    throw new Error(`No screen at ${String(state.pos)} of the cook being flagged`);
  }
  // Steps are counted as the cook moves through them, the Prep screen left
  // out; "Prep first"'s prep pages are steps and count (DS v1.59).
  const steps = screens.filter((s) => s.kind !== "prep");
  const view = cookView(plan, source, state);
  // The line the step screen draws for it, lead and all, which the panel's
  // row quotes (panel round 4).
  const line = view.stack[0]?.text;
  const step: FlagStep | null =
    here.kind === "prep"
      ? null
      : {
          n: steps.indexOf(here) + 1,
          of: steps.length,
          name: stepName(here.item, source.kind === "as-written" ? "text" : "label"),
          ...(line === undefined ? {} : { line }),
        };
  const now = view.chapters?.find((c) => c.state === "now");
  const { layers } = inputs;
  return {
    queueId: inputs.queueId,
    recipeName: inputs.recipeName,
    plan,
    planVersion: plan.version,
    state: {
      mode: state.mode,
      pos: state.pos,
      ticked: [...state.ticked],
      passed: [...state.passed],
      kept: [...state.kept],
    },
    screen: borrowed(layers) ?? here.kind,
    stepKey: here.kind === "prep" ? "prep" : stepKey(here.item),
    chapterId: now === undefined ? null : now.id,
    part: inputs.part,
    layers: {
      pane: layers.pane ?? false,
      card: layers.card ?? null,
      more: layers.more,
      level: layers.level,
      read: layers.read,
    },
    voice: inputs.voice,
    ask: inputs.ask,
    step,
  };
}

const SCREENS: [keyof CookLayers, ReportScreen][] = [
  ["allSteps", "all-steps"],
  ["ingredients", "ingredients"],
  ["info", "info"],
  ["wholeCook", "whole-cook"],
];

const LEVEL_NAMES: Record<0 | 1 | 2 | 3, string> = {
  0: "now",
  1: "until you can step away",
  2: "whole cook",
  3: "whole recipe",
};

/**
 * What opened and closed between two renders, as a flag's lead-up logs it
 * (B2 decision 9, N13): the borrowed screens, the pane, then a card, and the
 * look-ahead levels and reads. More's menu is left out, as a flag by touch
 * always opens it.
 */
export function layerChanges(was: CookLayers, now: CookLayers): string[] {
  const changes: string[] = [];
  for (const [layer, name] of SCREENS) {
    if (Boolean(was[layer]) !== Boolean(now[layer])) changes.push(`${name} ${now[layer] ? "open" : "close"}`);
  }
  if (Boolean(was.pane) !== Boolean(now.pane)) changes.push(`pane ${now.pane ? "open" : "close"}`);
  if (was.card !== now.card) {
    if (was.card !== null && was.card !== undefined) changes.push(`card close (${was.card})`);
    if (now.card !== null && now.card !== undefined) changes.push(`card open (${now.card})`);
  }
  if (was.level !== undefined && now.level !== undefined && was.level !== now.level) {
    changes.push(`look-ahead ${LEVEL_NAMES[was.level]} → ${LEVEL_NAMES[now.level]}`);
  }
  if (Boolean(was.read) !== Boolean(now.read)) {
    changes.push(`read ${now.read ? "open" : "close"}`);
  }
  return changes;
}
