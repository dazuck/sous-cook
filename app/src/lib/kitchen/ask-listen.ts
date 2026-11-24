import type { VoiceStatus } from "@/hooks/useKitchenVoiceCommands";

/**
 * Ask Sous and the voice on the cook screen (DS §5 Ask, v1.60; DECISIONS
 * 2026-11-22 "Ask Sous is a side panel", calls 5, 7, 13 and 14): the rules,
 * apart from the screen that follows them.
 */

/**
 * A listen the capsule's mic started by opening Ask: "armed" until the mic
 * hears, "heard" while and after it (and once a mic that never heard has
 * said why). Null once it has been dealt with, or the cook has put a hand
 * to the panel.
 */
export type CapsuleListen = "armed" | "heard" | null;

/**
 * What a command heard with Ask open does to Ask:
 *
 * - `closes-then-acts`: the capsule's mic opened Ask only to listen, and what
 *   it heard is a command: Ask goes, and the command acts as it would with
 *   Ask closed, whatever the conversation holds (call 13).
 * - `closes`: Ask closes and the command does nothing more: "close" in either
 *   shape; next, back and done over the sheet, which holds the step (call 5).
 * - `stays`: the command is not Ask's. With a modal or the top line's menu
 *   over the cook, that is every command: the topmost thing closes first.
 */
export function askOnCommand(at: {
  /** Ask is open. */
  open: boolean;
  /** Open as the sheet, which is modal. */
  modal: boolean;
  listen: CapsuleListen;
  /** A modal or the top line's menu is open over the cook. */
  over: boolean;
  /** The command is "close". */
  close: boolean;
  /** The command backs out of what is on top: next, back, done, close. */
  backsOut: boolean;
}): "closes-then-acts" | "closes" | "stays" {
  if (!at.open || at.over) return "stays";
  if (at.listen !== null) return at.close ? "closes" : "closes-then-acts";
  return at.close || (at.modal && at.backsOut) ? "closes" : "stays";
}

/**
 * The capsule's listen as the voice's state moves. A listen that ended in
 * nothing asked (silence, or words that were no question) closes Ask once
 * the heard line has cleared, whatever the conversation holds. A refused or
 * stalled mic keeps Ask open, where it says so (call 14), and lets the
 * listen go, whether or not the mic ever heard. A mic that failed to start
 * never says "hearing": it is back at ready with its trouble line showing,
 * and that listen is over like any other, so Ask closes once the line clears.
 */
export function afterListen(
  listen: CapsuleListen,
  at: { open: boolean; status: VoiceStatus; echo: boolean },
): { listen: CapsuleListen; close: boolean } {
  if (listen === null || !at.open) return { listen: null, close: false };
  if (at.status === "blocked" || at.status === "stalled") return { listen: null, close: false };
  if (at.status === "hearing") return { listen: "heard", close: false };
  if (listen === "armed" && at.status === "ready" && at.echo) return { listen: "heard", close: false };
  if (listen !== "heard" || at.echo) return { listen, close: false };
  return { listen: null, close: true };
}
