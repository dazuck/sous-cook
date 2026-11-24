import { beforeEach, describe, expect, it, vi, type Mock } from "vitest";
import { createAckAudio } from "./ack-audio";
import { CLIP_NAMES, YES_CHEF_TAKES } from "./ack-clips";
import type { SueReplies } from "./cook-prefs";
import { FakeAudioContext, clipBytes } from "./testing/fakeAudioContext";
import { SPOKEN_PER_COOK, createAcknowledger, type Acknowledger } from "./voice-ack";
import type { VoiceCommand } from "./wake-word";

let ctx: FakeAudioContext;
let report: Mock<(level: "warn" | "error", message: string, detail?: unknown) => void>;
let setting: SueReplies;
let draws: number[];

/** The real acknowledger over the real sounds, on a fake browser context; `draws` are the dice. */
async function sue(): Promise<Acknowledger> {
  const audio = createAckAudio({
    context: () => ctx.as(),
    fetchClip: (url) => Promise.resolve(clipBytes(url)),
    report,
  });
  await audio.warm();
  return createAcknowledger({ audio, mode: () => setting, random: () => draws.shift() ?? 0.99 });
}

const UNDERSTOOD = [523.25, 783.99];
const NOT_UNDERSTOOD = [392, 293.66];
const pitches = () => ctx.notes().map((n) => n.frequency);

beforeEach(() => {
  ctx = new FakeAudioContext();
  report = vi.fn<(level: "warn" | "error", message: string, detail?: unknown) => void>();
  setting = "voice";
  draws = [];
});

describe("the clips", () => {
  it("are fetched only with Sounds and voice, never for Off or Sounds", async () => {
    const fetched: string[] = [];
    const audio = createAckAudio({
      context: () => ctx.as(),
      fetchClip: (url) => {
        fetched.push(url);
        return Promise.resolve(clipBytes(url));
      },
      report,
    });
    const ack = createAcknowledger({ audio, mode: () => setting, random: () => 0.99 });
    for (const off of ["off", "sounds"] as const) {
      setting = off;
      ack.warm();
      expect(fetched, off).toEqual([]);
    }
    setting = "voice";
    ack.warm();
    expect(fetched).toHaveLength(CLIP_NAMES.length);
  });
});

describe("sounds", () => {
  it("a command carried out sounds understood, and says nothing for the commands the screen shows", async () => {
    const ack = await sue();
    for (const command of ["next", "back", "done", "close", "next-few", "how-much-more", "whole-recipe", "not-yet", "dismiss-timer", "how-much"] as const) {
      ctx.started = [];
      ack.commandDone(command, `sue ${command}`);
      expect(pitches(), command).toEqual(UNDERSTOOD);
      expect(ctx.clips(), command).toEqual([]);
    }
  });

  it("a question handed to Ask sounds understood", async () => {
    const ack = await sue();
    ack.asked();
    expect(pitches()).toEqual(UNDERSTOOD);
    expect(ctx.clips()).toEqual([]);
  });

  it("anything not understood, or refused, sounds lower and falling, and never speaks", async () => {
    const ack = await sue();
    ack.notUnderstood();
    expect(pitches()).toEqual(NOT_UNDERSTOOD);
    expect(ctx.clips()).toEqual([]);
  });

  it("an interim command sounds at once; the command's end then adds no second sound", async () => {
    const ack = await sue();
    ack.listenStarted();
    ack.heardCommand();
    expect(pitches()).toEqual(UNDERSTOOD);
    ack.heardCommand();
    ack.commandDone("next", "next");
    expect(pitches()).toEqual(UNDERSTOOD);
    // The next listen is its own.
    ack.listenStarted();
    ack.commandDone("back", "back");
    expect(pitches()).toEqual([...UNDERSTOOD, ...UNDERSTOOD]);
  });

  it("an interim sound for a command that then fails is followed by the lower one", async () => {
    const ack = await sue();
    ack.listenStarted();
    ack.heardCommand();
    ack.notUnderstood();
    expect(pitches()).toEqual([...UNDERSTOOD, ...NOT_UNDERSTOOD]);
  });
});

describe("the setting", () => {
  it("off is silence, whatever is said", async () => {
    setting = "off";
    const ack = await sue();
    ack.listenStarted();
    ack.heardCommand();
    ack.commandDone("flag", "sue flag");
    ack.asked();
    ack.notUnderstood();
    expect(ctx.started).toEqual([]);
  });

  it("sounds makes sounds and speaks nothing, even for a timer or a flag", async () => {
    setting = "sounds";
    draws = [0, 0, 0, 0];
    const ack = await sue();
    ack.commandDone("flag", "sue flag");
    ack.commandDone("set-timer", "set a timer for 10 minutes");
    ack.commandDone("start-timer", "timer");
    expect(ctx.clips()).toEqual([]);
    expect(pitches()).toHaveLength(6);
  });

  it("voice makes the same sounds and may speak; a change applies to the next command", async () => {
    setting = "sounds";
    draws = [0.99];
    const ack = await sue();
    ack.commandDone("flag", "flag");
    expect(ctx.clips()).toEqual([]);
    setting = "voice";
    ack.commandDone("flag", "flag");
    expect(ctx.clips()).toEqual(["flagged"]);
  });
});

describe("a spoken confirmation", () => {
  it("is for start-timer, set-timer and flag only", async () => {
    const ack = await sue();
    for (const command of ["next", "back", "done", "close", "next-few", "how-much-more", "whole-recipe", "not-yet", "dismiss-timer", "how-much"] as VoiceCommand[]) {
      draws = [0]; // would be "Yes, chef" if it were allowed
      ack.commandDone(command, command);
    }
    expect(ctx.clips()).toEqual([]);
    for (const command of ["flag", "start-timer", "set-timer"] as VoiceCommand[]) {
      draws = [0.5];
      ack.newCook();
      ack.commandDone(command, command === "set-timer" ? "set a timer for 10 minutes" : command);
    }
    expect(ctx.clips()).toHaveLength(3);
  });

  it("is about one in three Yes, chef, the rest what was done", async () => {
    const ack = await sue();
    draws = [0.1, 0]; // under a third: Yes, chef, then the take
    ack.commandDone("flag", "flag");
    expect(YES_CHEF_TAKES as readonly string[]).toContain(ctx.clips()[0]);
    ack.newCook();
    ctx.started = [];
    draws = [1 / 3]; // not under a third
    ack.commandDone("flag", "flag");
    expect(ctx.clips()).toEqual(["flagged"]);
  });

  it("reads a whole common timer back, and says only that it is on for any other length", async () => {
    const ack = await sue();
    draws = [0.9];
    ack.commandDone("set-timer", "sue set a timer for ten minutes");
    draws = [0.9];
    ack.commandDone("set-timer", "sue set a timer for 90 seconds");
    draws = [0.9];
    ack.commandDone("set-timer", "sue set a timer for 7 minutes");
    expect(ctx.clips()).toEqual(["read-10-minutes", "timer-on", "timer-on"]);
  });

  it("starting the step's timer takes turns between Timer's on and On it", async () => {
    const ack = await sue();
    draws = [0.9, 0.9];
    ack.commandDone("start-timer", "timer");
    ack.commandDone("start-timer", "timer");
    expect(ctx.clips()).toEqual(["timer-on", "on-it"]);
  });

  it("never says the same Yes, chef take twice running", async () => {
    const ack = await sue();
    // Every confirmation Yes, chef; the take draw is 0 each time.
    const said: string[] = [];
    for (let i = 0; i < 2; i++) {
      draws = [0, 0];
      ack.commandDone("start-timer", "timer");
      said.push(ctx.clips().at(-1) ?? "");
    }
    expect(said[0]).not.toBe(said[1]);
  });

  it("comes after the sound, not over it", async () => {
    const ack = await sue();
    draws = [0.9];
    ack.commandDone("flag", "flag");
    const lastNote = Math.max(...ctx.notes().map((n) => n.at));
    const clip = ctx.started.find((s) => s.kind === "clip");
    expect(clip?.at).toBeGreaterThan(lastNote + 0.1);
  });

  it("is capped at three per cook, then sounds only; a new cook starts the count again", async () => {
    const ack = await sue();
    expect(SPOKEN_PER_COOK).toBe(3);
    for (let i = 0; i < 5; i++) {
      draws = [0.9];
      ack.commandDone("flag", "flag");
    }
    expect(ctx.clips()).toEqual(["flagged", "flagged", "flagged"]);
    // Every command still sounded.
    expect(pitches()).toHaveLength(5 * 2);

    ack.newCook();
    draws = [0.9];
    ack.commandDone("flag", "flag");
    expect(ctx.clips()).toHaveLength(4);
  });

  it("a clip that won't play is no confirmation: the sound stands alone, it is logged, and it isn't counted", async () => {
    ctx.undecodable.add("flagged");
    const ack = await sue();
    for (let i = 0; i < 4; i++) {
      draws = [0.9];
      ack.commandDone("flag", "flag");
    }
    expect(ctx.clips()).toEqual([]);
    expect(pitches()).toHaveLength(8);
    expect(report.mock.calls.some((c) => c[0] === "error" && String(c[1]).includes('"flagged"'))).toBe(true);
    // Not spent: another clip that does decode is still said three times.
    for (let i = 0; i < 4; i++) {
      draws = [0.9];
      ack.commandDone("start-timer", "timer");
    }
    expect(ctx.clips()).toHaveLength(3);
  });

  it("never touches the browser's voice or the microphone", async () => {
    const speak = vi.fn();
    vi.stubGlobal("speechSynthesis", { speak, cancel: vi.fn(), speaking: false, pending: false });
    const ack = await sue();
    draws = [0.9];
    ack.commandDone("flag", "flag");
    expect(speak).not.toHaveBeenCalled();
    vi.unstubAllGlobals();
  });
});
