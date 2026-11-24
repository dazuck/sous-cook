// @vitest-environment happy-dom
import { act, renderHook } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { createAckAudio } from "@/lib/kitchen/ack-audio";
import { CLIP_NAMES, clipUrl } from "@/lib/kitchen/ack-clips";
import { SUE_REPLIES_KEY, getSueReplies, setSueReplies, type SueReplies } from "@/lib/kitchen/cook-prefs";
import { resetEventLog } from "@/lib/kitchen/report-events";
import { FakeAudioContext } from "@/lib/kitchen/testing/fakeAudioContext";
import { createAcknowledger } from "@/lib/kitchen/voice-ack";
import { COMMAND_QUIET_MS, QUIET_MS } from "@/lib/kitchen/tap-listen";
import type { VoiceCommand } from "@/lib/kitchen/wake-word";
import { FakeSpeechRecognition } from "./testing/fakeSpeechRecognition";
import { sueAck } from "./testing/sueAck";
import { useKitchenVoiceCommands, type UseKitchenVoiceCommandsOptions } from "./useKitchenVoiceCommands";

/**
 * Sue's sounds and rare spoken confirmations as the cook's voice meets them
 * (`lib/kitchen/voice-ack.ts` holds the rules; these are the hook's wiring):
 * which outcome sounds, when, that touch sounds nothing, and that an
 * acknowledgement never holds the microphone.
 */

const ANDROID =
  "Mozilla/5.0 (Linux; Android 16; Pixel Tablet) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/140.0.0.0 Safari/537.36";
const UNDERSTOOD = [523.25, 783.99];
const NOT_UNDERSTOOD = [392, 293.66];

let received: VoiceCommand[];
let sue: ReturnType<typeof sueAck>;

beforeEach(() => {
  vi.useFakeTimers();
  FakeSpeechRecognition.reset();
  vi.stubGlobal("webkitSpeechRecognition", FakeSpeechRecognition);
  received = [];
  sue = sueAck("sounds");
  resetEventLog();
});

afterEach(() => {
  vi.useRealTimers();
  vi.unstubAllGlobals();
  vi.restoreAllMocks();
});

function listen(options: Partial<UseKitchenVoiceCommandsOptions> = {}) {
  const hook = renderHook(() =>
    useKitchenVoiceCommands({
      enabled: true,
      onCommand: (c) => void received.push(c),
      acknowledger: sue.ack,
      ...options,
    }),
  );
  return { ...hook, rec: FakeSpeechRecognition.current };
}

const say = (rec: FakeSpeechRecognition, text: string, isFinal = true) => act(() => rec.say(text, isFinal));
const wait = (ms: number) => act(() => vi.advanceTimersByTime(ms));
const pitches = () => sue.ctx.notes().map((n) => n.frequency);
const talk = (result: { current: { talk: () => void } }) => act(() => result.current.talk());

describe("Sue's sounds where voice listens all the time", () => {
  it("a command said to Sous sounds understood, once, as it acts", () => {
    const { rec } = listen();
    say(rec, "Sue, next");
    expect(received).toEqual(["next"]);
    expect(pitches()).toEqual(UNDERSTOOD);
  });

  it("something said to Sous that isn't a command sounds lower; talk not for Sous sounds nothing", () => {
    const { rec } = listen();
    say(rec, "next");
    say(rec, "we should call Sue next time");
    expect(pitches()).toEqual([]);
    say(rec, "Sue, flip it");
    expect(pitches()).toEqual(NOT_UNDERSTOOD);
  });

  it("a command the page declines (no checkpoint to ask about) is not understood", () => {
    const { rec } = listen({ onCommand: () => false });
    say(rec, "Sue, not yet");
    expect(pitches()).toEqual(NOT_UNDERSTOOD);
  });

  it("a refusal (a reply string) is not understood, and nothing is said", async () => {
    sue.state.mode = "voice";
    await sue.audio.warm();
    // Dice that would speak, for a command that could earn a confirmation: the refusal alone keeps it quiet.
    sue.state.draws = [0.9];
    const { rec } = listen({ onCommand: () => "That timer's running" });
    say(rec, "Sue, start the timer");
    expect(pitches()).toEqual(NOT_UNDERSTOOD);
    expect(sue.ctx.clips()).toEqual([]);
  });

  it("a near miss of the wake word is shown and sounds lower, never acts", () => {
    const { rec } = listen();
    say(rec, "shoe next");
    expect(received).toEqual([]);
    expect(pitches()).toEqual(NOT_UNDERSTOOD);
  });

  it("off is silence", () => {
    sue.state.mode = "off";
    const { rec } = listen();
    say(rec, "Sue, next");
    say(rec, "Sue, flip it");
    expect(received).toEqual(["next"]);
    expect(sue.ctx.started).toEqual([]);
  });
});

describe("Sue's sounds and clips on a tablet, where a tap starts each listen", () => {
  beforeEach(() => {
    vi.spyOn(navigator, "userAgent", "get").mockReturnValue(ANDROID);
  });

  it("sounds understood at the first interim result that is a whole command, ahead of the action and of the quiet", () => {
    const { result, rec } = listen();
    talk(result);
    expect(pitches()).toEqual([]);
    say(rec, "next", false);
    // Not yet acted on (700 ms of quiet waits for a settle), but already heard.
    expect(received).toEqual([]);
    expect(pitches()).toEqual(UNDERSTOOD);
    wait(COMMAND_QUIET_MS);
    expect(received).toEqual(["next"]);
    // One sound for the command, not two.
    expect(pitches()).toEqual(UNDERSTOOD);
  });

  it("does not sound for words that are not yet a whole command, and sounds once they are", () => {
    const { result, rec } = listen();
    talk(result);
    say(rec, "sue", false);
    expect(pitches()).toEqual([]);
    say(rec, "sue next", false);
    expect(pitches()).toEqual(UNDERSTOOD);
  });

  it("a settled command sounds once, and the next tap's command sounds again", () => {
    const { result, rec } = listen();
    talk(result);
    say(rec, "back");
    expect(received).toEqual(["back"]);
    expect(pitches()).toEqual(UNDERSTOOD);
    talk(result);
    say(FakeSpeechRecognition.current, "next");
    expect(pitches()).toEqual([...UNDERSTOOD, ...UNDERSTOOD]);
  });

  it("a question for Ask sounds understood; nothing heard sounds lower", () => {
    const questions: string[] = [];
    const { result, rec } = listen({ onQuestion: (q) => questions.push(q) });
    talk(result);
    say(rec, "can I use butter instead", false);
    wait(QUIET_MS);
    expect(questions).toHaveLength(1);
    expect(pitches()).toEqual(UNDERSTOOD);
    talk(result);
    sue.ctx.started = [];
    act(() => FakeSpeechRecognition.current.fail("no-speech"));
    expect(pitches()).toEqual(NOT_UNDERSTOOD);
  });

  it("a command that falls to Ask as words is understood once as a question, not twice", () => {
    const questions: string[] = [];
    const { result, rec } = listen({ onCommand: () => false, onQuestion: (q) => questions.push(q) });
    talk(result);
    say(rec, "not yet");
    expect(questions).toEqual(["Not yet"]);
    // The interim already sounded understood; the question adds no second.
    expect(pitches()).toEqual(UNDERSTOOD);
  });

  it("said aloud, a timer or flag may earn a spoken confirmation that waits on no listen and never holds the mic", async () => {
    sue.state.mode = "voice";
    await sue.audio.warm();
    sue.state.draws = [0.9];
    const { result, rec } = listen();
    talk(result);
    say(rec, "flag");
    expect(sue.ctx.clips()).toEqual(["flagged"]);
    // Not held: not paused, taps are taken, and the recognizer was never stopped for it.
    expect(result.current.status).toBe("ready");
    talk(result);
    expect(result.current.status).toBe("hearing");
    expect(FakeSpeechRecognition.current.running).toBe(true);
  });

  it("a command that isn't one of the three never speaks, whatever the dice say", async () => {
    sue.state.mode = "voice";
    await sue.audio.warm();
    sue.state.draws = [0, 0, 0];
    const { result, rec } = listen();
    talk(result);
    say(rec, "next");
    expect(sue.ctx.clips()).toEqual([]);
  });
});

describe("Sounds and voice where the clips are missing", () => {
  let fetched: string[];
  let said: { level: string; message: string }[];
  let ctx: FakeAudioContext;

  beforeEach(() => {
    vi.spyOn(navigator, "userAgent", "get").mockReturnValue(ANDROID);
    // The app's own fetch of a clip, against a server that has none: every one answers 404.
    fetched = [];
    vi.stubGlobal(
      "fetch",
      vi.fn((url: string) => {
        fetched.push(url);
        return Promise.resolve(new Response(null, { status: 404 }));
      }),
    );
    said = [];
    ctx = new FakeAudioContext();
  });

  /** The hook on a device with this setting, its acknowledger reading the setting over the real sounds and fetch. */
  function onDevice(setting: SueReplies) {
    // Node's own global localStorage has no methods without a backing file, so a plain store stands in.
    const kept = new Map<string, string>([[SUE_REPLIES_KEY, setting]]);
    vi.stubGlobal("localStorage", {
      getItem: (k: string) => kept.get(k) ?? null,
      setItem: (k: string, v: string) => void kept.set(k, v),
      removeItem: (k: string) => void kept.delete(k),
    });
    const audio = createAckAudio({
      context: () => ctx.as(),
      report: (level, message) => void said.push({ level, message }),
    });
    return listen({ acknowledger: createAcknowledger({ audio, mode: getSueReplies, random: () => 0.9 }) });
  }

  const errors = () => said.filter((s) => s.level === "error").map((s) => s.message);

  afterEach(() => {
    vi.unstubAllEnvs();
  });

  it("in a build without them, a stored Sounds and voice acts as Sounds: nothing fetched, nothing said", () => {
    const { result, rec } = onDevice("voice");
    talk(result);
    say(rec, "flag");
    expect(received).toEqual(["flag"]);
    expect(ctx.notes().map((n) => n.frequency)).toEqual(UNDERSTOOD);
    expect(ctx.clips()).toEqual([]);
    expect(fetched).toEqual([]);
    expect(said).toEqual([]);
  });

  it("in a build with them, Sounds, the default, fetches no clip and a command sounds as ever", () => {
    vi.stubEnv("SOUS_SUE_CLIPS", "1");
    const { result, rec } = onDevice("sounds");
    talk(result);
    say(rec, "flag");
    expect(received).toEqual(["flag"]);
    expect(ctx.notes().map((n) => n.frequency)).toEqual(UNDERSTOOD);
    expect(fetched).toEqual([]);
    expect(said).toEqual([]);
  });

  it("in a build with them but a server without them, each clip is fetched and each missing one said once; a flag said sounds understood, speaks nothing, and the page carries on", async () => {
    vi.stubEnv("SOUS_SUE_CLIPS", "1");
    const { result, rec } = onDevice("voice");
    expect(fetched.sort()).toEqual(CLIP_NAMES.map(clipUrl).sort());
    await vi.waitFor(() => expect(errors()).toHaveLength(CLIP_NAMES.length));
    for (const name of CLIP_NAMES) {
      expect(errors().filter((m) => m.startsWith(`Sue's clip "${name}" didn't load`)), name).toHaveLength(1);
    }

    talk(result);
    say(rec, "flag");
    expect(received).toEqual(["flag"]);
    expect(ctx.notes().map((n) => n.frequency)).toEqual(UNDERSTOOD);
    expect(ctx.clips()).toEqual([]);
    // Asked for, the flag's clip says once more that it isn't there, by name.
    expect(errors().slice(CLIP_NAMES.length)).toEqual([`Sue's clip "flagged" isn't loaded; her sound stands alone.`]);
    // The page carries on: the next command is heard and sounds as before.
    talk(result);
    say(FakeSpeechRecognition.current, "next");
    expect(received).toEqual(["flag", "next"]);
    expect(ctx.notes().map((n) => n.frequency)).toEqual([...UNDERSTOOD, ...UNDERSTOOD]);
    expect(result.current.status).toBe("ready");

    // Turned off and back to voice, the page tries the clips again, and says nothing it has said already.
    fetched = [];
    act(() => setSueReplies("off"));
    act(() => setSueReplies("voice"));
    expect(fetched).toHaveLength(CLIP_NAMES.length);
    await act(async () => {
      await vi.advanceTimersByTimeAsync(0);
    });
    expect(errors()).toHaveLength(CLIP_NAMES.length + 1);
  });
});
