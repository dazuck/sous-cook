import { describe, expect, it } from "vitest";
import { afterListen, askOnCommand } from "./ask-listen";

// DECISIONS 2026-11-22 "Ask Sous is a side panel": calls 5, 7 and 13, and
// review round 1 (the mic's listen whatever the conversation holds; the
// topmost thing closes first; a mic that fails before it hears).
describe("askOnCommand: what a command heard with Ask open does to Ask", () => {
  const open = { open: true, modal: false, listen: null, over: false, close: false, backsOut: false } as const;

  it("does nothing to an Ask that is closed", () => {
    expect(askOnCommand({ ...open, open: false, listen: "heard", close: true, backsOut: true })).toBe("stays");
  });

  it("closes Ask and lets the command act when the capsule's mic opened it only to listen (call 13)", () => {
    for (const listen of ["armed", "heard"] as const) {
      // Beside the step and over it alike: the command acts as it would from a closed Ask.
      expect(askOnCommand({ ...open, listen, backsOut: true })).toBe("closes-then-acts");
      expect(askOnCommand({ ...open, listen, modal: true, backsOut: true })).toBe("closes-then-acts");
      // A command that would not back out of a sheet, a timer's say, acts too.
      expect(askOnCommand({ ...open, listen, modal: true })).toBe("closes-then-acts");
      // "Close" closes Ask, and that is all it does.
      expect(askOnCommand({ ...open, listen, close: true, backsOut: true })).toBe("closes");
    }
  });

  it("closes on \"close\" in either shape, and on next, back and done over the sheet only (calls 5, 7)", () => {
    expect(askOnCommand({ ...open, close: true, backsOut: true })).toBe("closes");
    expect(askOnCommand({ ...open, modal: true, close: true, backsOut: true })).toBe("closes");
    expect(askOnCommand({ ...open, modal: true, backsOut: true })).toBe("closes");
    // Beside the step they move the step and the panel stays.
    expect(askOnCommand({ ...open, backsOut: true })).toBe("stays");
    // A timer's command closes nothing.
    expect(askOnCommand({ ...open, modal: true })).toBe("stays");
  });

  it("leaves Ask alone while something is over the cook: the topmost thing closes first", () => {
    expect(askOnCommand({ ...open, over: true, close: true, backsOut: true })).toBe("stays");
    expect(askOnCommand({ ...open, over: true, modal: true, backsOut: true })).toBe("stays");
    // A listen the capsule started waits too: it closes Ask once it has come to nothing (`afterListen`).
    expect(askOnCommand({ ...open, over: true, listen: "armed", close: true, backsOut: true })).toBe("stays");
  });
});

describe("afterListen: a listen the capsule's mic started, as the voice's state moves (calls 13, 14)", () => {
  const at = { open: true, status: "ready", echo: false } as const;

  it("is nothing once dealt with, and is dealt with when Ask closes", () => {
    expect(afterListen(null, { ...at, status: "hearing" })).toEqual({ listen: null, close: false });
    expect(afterListen("armed", { ...at, open: false })).toEqual({ listen: null, close: false });
    expect(afterListen("heard", { ...at, open: false })).toEqual({ listen: null, close: false });
  });

  it("waits while armed, and is heard once the mic hears", () => {
    expect(afterListen("armed", at)).toEqual({ listen: "armed", close: false });
    expect(afterListen("armed", { ...at, status: "hearing" })).toEqual({ listen: "heard", close: false });
    expect(afterListen("heard", { ...at, status: "hearing" })).toEqual({ listen: "heard", close: false });
  });

  it("keeps Ask up while the heard line still speaks, then closes it: nothing was asked", () => {
    expect(afterListen("heard", { ...at, echo: true })).toEqual({ listen: "heard", close: false });
    expect(afterListen("heard", at)).toEqual({ listen: null, close: true });
  });

  it("takes a mic that failed to start as a listen that is over: its line shows, then Ask closes (review round 2)", () => {
    // The start failed at once: the voice never said "hearing", only its trouble line, the mic back at ready.
    expect(afterListen("armed", { ...at, echo: true })).toEqual({ listen: "heard", close: false });
    expect(afterListen("heard", { ...at, echo: true })).toEqual({ listen: "heard", close: false });
    expect(afterListen("heard", at)).toEqual({ listen: null, close: true });
  });

  it("keeps Ask open on a refused or stalled mic, and lets the listen go, before it ever heard or after", () => {
    for (const status of ["blocked", "stalled"] as const) {
      expect(afterListen("heard", { ...at, status })).toEqual({ listen: null, close: false });
      expect(afterListen("armed", { ...at, status })).toEqual({ listen: null, close: false });
      expect(afterListen("armed", { ...at, status, echo: true })).toEqual({ listen: null, close: false });
    }
  });
});
