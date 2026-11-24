// @vitest-environment happy-dom
import { act, renderHook } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { recentEvents, resetEventLog } from "@/lib/kitchen/report-events";
import {
  COMMAND_QUIET_MS,
  FIRST_WORDS_MS,
  MAX_LISTEN_MS,
  QUIET_MS,
} from "@/lib/kitchen/tap-listen";
import { ARM_WINDOW_MS, type VoiceCommand } from "@/lib/kitchen/wake-word";
import { FakeSpeechRecognition } from "./testing/fakeSpeechRecognition";
import { sueAck } from "./testing/sueAck";
import {
  ECHO_MS,
  MAX_FAILURES,
  MAX_RESTART_MS,
  QUICK_END_MS,
  RESTART_MS,
  useKitchenVoiceCommands,
  type UseKitchenVoiceCommandsOptions,
} from "./useKitchenVoiceCommands";

let commands: VoiceCommand[];

beforeEach(() => {
  vi.useFakeTimers();
  FakeSpeechRecognition.reset();
  vi.stubGlobal("webkitSpeechRecognition", FakeSpeechRecognition);
  commands = [];
  resetEventLog();
});

afterEach(() => {
  vi.useRealTimers();
  vi.unstubAllGlobals();
});

function listen(options: Partial<UseKitchenVoiceCommandsOptions> = {}) {
  const hook = renderHook((props: Partial<UseKitchenVoiceCommandsOptions>) =>
    useKitchenVoiceCommands({
      enabled: true,
      onCommand: (c) => void commands.push(c),
      // Sue's sounds on a fake context, so the browser's absence isn't logged on every test.
      acknowledger: sueAck().ack,
      ...props,
    }),
    { initialProps: options },
  );
  return { ...hook, rec: FakeSpeechRecognition.current };
}

const say = (rec: FakeSpeechRecognition, text: string, isFinal = true) =>
  act(() => rec.say(text, isFinal));
const wait = (ms: number) => act(() => vi.advanceTimersByTime(ms));

describe("useKitchenVoiceCommands", () => {
  it("listens continuously, for final results only, while on", () => {
    const { result, rec } = listen();
    expect(rec).toMatchObject({ continuous: true, interimResults: false, running: true });
    expect(result.current.mode).toBe("always");
    expect(result.current.status).toBe("listening");
  });

  it("a command that declines (false: \"not yet\" off a checkpoint) echoes as not caught, as before B5d", () => {
    const { result, rec } = listen({ onCommand: () => false });
    say(rec, "Sue, not yet");
    expect(result.current.echo).toEqual({ kind: "unknown", heard: "sue not yet" });
  });

  it("acts on a command said to Sous and echoes it for a moment", () => {
    const { result, rec } = listen();
    say(rec, "Sue, next");
    expect(commands).toEqual(["next"]);
    expect(result.current.echo).toEqual({ kind: "command", command: "next", heard: "sue next" });
    wait(ECHO_MS);
    expect(result.current.echo).toBeNull();
  });

  it("never asks, listening all the time, whatever is said to Sous", () => {
    const questions: string[] = [];
    const { rec } = listen({ onQuestion: (q) => questions.push(q) });
    say(rec, "Sue, how much salt");
    say(rec, "Sue, what can I use instead of cream");
    expect(questions).toEqual([]);
  });

  it("does nothing for a command not said to Sous", () => {
    const { result, rec } = listen();
    say(rec, "next");
    say(rec, "okay done");
    expect(commands).toEqual([]);
    expect(result.current.echo).toBeNull();
  });

  it("waits after “Sue” alone for one bare command, and shows it's waiting", () => {
    const { result, rec } = listen();
    say(rec, "Sue");
    expect(result.current.echo).toEqual({ kind: "armed" });
    wait(ARM_WINDOW_MS - 1000);
    expect(result.current.echo).toEqual({ kind: "armed" });
    say(rec, "back");
    expect(commands).toEqual(["back"]);
  });

  it("lets the wait lapse", () => {
    const { result, rec } = listen();
    say(rec, "Sue");
    wait(ARM_WINDOW_MS + 1);
    expect(result.current.echo).toBeNull();
    say(rec, "next");
    expect(commands).toEqual([]);
  });

  it("shows what it heard when it can't act, without acting", () => {
    const { result, rec } = listen();
    say(rec, "Sue, flip it");
    expect(result.current.echo).toEqual({ kind: "unknown", heard: "sue flip it" });
    say(rec, "shoe next");
    expect(result.current.echo).toEqual({ kind: "near-miss", heard: "shoe next" });
    expect(commands).toEqual([]);
  });

  it("restarts when Chrome ends a session", () => {
    const { result, rec } = listen();
    wait(QUICK_END_MS);
    act(() => rec.end());
    expect(rec.running).toBe(false);
    expect(result.current.status).toBe("listening");
    wait(RESTART_MS);
    expect(rec.running).toBe(true);
    expect(rec.starts).toBe(2);
  });

  it("treats silence as an ending, not a failure", () => {
    const { result, rec } = listen();
    for (let i = 0; i < MAX_FAILURES + 2; i++) {
      // Chrome reports silence after several seconds of it.
      wait(QUICK_END_MS);
      act(() => rec.fail("no-speech"));
      wait(RESTART_MS);
      expect(rec.running).toBe(true);
    }
    expect(result.current.status).toBe("listening");
  });

  it("backs off on failures in a row, then stops until reset", () => {
    const { result, rec } = listen();
    for (let i = 1; i < MAX_FAILURES; i++) {
      act(() => rec.fail("network"));
      const delay = Math.min(RESTART_MS * 2 ** i, MAX_RESTART_MS);
      wait(delay - 1);
      expect(rec.running).toBe(false);
      wait(1);
      expect(rec.running).toBe(true);
    }
    act(() => rec.fail("network"));
    expect(result.current.status).toBe("stalled");
    wait(MAX_RESTART_MS * 2);
    expect(rec.running).toBe(false);

    act(() => result.current.reset());
    expect(result.current.status).toBe("listening");
    expect(rec.running).toBe(true);
  });

  it("counts a session Chrome ends at once, having heard nothing, as a failure", () => {
    const { result, rec } = listen();
    for (let i = 1; i < MAX_FAILURES; i++) {
      act(() => rec.end());
      wait(Math.min(RESTART_MS * 2 ** i, MAX_RESTART_MS));
      expect(rec.running).toBe(true);
    }
    act(() => rec.end());
    expect(result.current.status).toBe("stalled");
  });

  it("forgets earlier failures once a session runs cleanly", () => {
    const { result, rec } = listen();
    for (let i = 1; i < MAX_FAILURES; i++) {
      act(() => rec.fail("network"));
      wait(MAX_RESTART_MS);
    }
    wait(QUICK_END_MS);
    act(() => rec.end());
    wait(RESTART_MS);
    expect(rec.running).toBe(true);
    act(() => rec.fail("network"));
    expect(result.current.status).toBe("listening");
    wait(RESTART_MS * 2);
    expect(rec.running).toBe(true);
  });

  it("forgets earlier failures once it hears something", () => {
    const { result, rec } = listen();
    for (let i = 1; i < MAX_FAILURES; i++) {
      act(() => rec.fail("network"));
      wait(MAX_RESTART_MS);
    }
    say(rec, "the dal smells good");
    act(() => rec.fail("network"));
    expect(result.current.status).toBe("listening");
    wait(RESTART_MS * 2);
    expect(rec.running).toBe(true);
  });

  it("tries again when Chrome refuses to start a session, which no ending follows", () => {
    const { result, rec } = listen();
    rec.refuseStart = true;
    act(() => rec.end());
    wait(MAX_RESTART_MS * 2);
    expect(rec.refuseStart).toBe(false);
    expect(rec.running).toBe(true);
    expect(rec.starts).toBe(2);
    expect(result.current.status).toBe("listening");
  });

  it("counts no errors that arrive while held", () => {
    const { result, rec, rerender } = listen();
    for (let i = 1; i < MAX_FAILURES; i++) {
      act(() => rec.fail("network"));
      wait(MAX_RESTART_MS);
    }
    rerender({ paused: true });
    act(() => rec.onerror?.(Object.assign(new Event("error"), { error: "network" })));
    rerender({ paused: false });
    expect(result.current.status).toBe("listening");
    expect(rec.running).toBe(true);
  });

  it("stops at once on a denied or missing mic, and starts afresh once reset", () => {
    const { result, rec } = listen();
    act(() => rec.fail("not-allowed"));
    expect(result.current.status).toBe("blocked");
    wait(MAX_RESTART_MS * 2);
    expect(rec.starts).toBe(1);

    act(() => result.current.reset());
    expect(rec.starts).toBe(2);
    act(() => rec.fail("audio-capture"));
    expect(result.current.status).toBe("blocked");
  });

  it("holds while paused, ignoring what it hears, and resumes after", () => {
    const { result, rec, rerender } = listen();
    say(rec, "Sue");
    rerender({ paused: true });
    expect(result.current.status).toBe("paused");
    expect(rec.running).toBe(false);
    expect(result.current.echo).toBeNull();
    // A result still in flight when the pause began is dropped.
    say(rec, "Sue, next");
    wait(MAX_RESTART_MS);
    expect(rec.running).toBe(false);

    rerender({ paused: false });
    expect(rec.running).toBe(true);
    // The window "Sue" opened before the pause is gone.
    say(rec, "next");
    expect(commands).toEqual([]);
  });

  it("holds while the page is hidden, and resumes when it shows", () => {
    const { result, rec } = listen();
    const setHidden = (hidden: boolean) =>
      act(() => {
        Object.defineProperty(document, "hidden", { value: hidden, configurable: true });
        document.dispatchEvent(new Event("visibilitychange"));
      });
    setHidden(true);
    expect(result.current.status).toBe("paused");
    expect(rec.running).toBe(false);
    wait(MAX_RESTART_MS);
    expect(rec.running).toBe(false);
    setHidden(false);
    expect(result.current.status).toBe("listening");
    expect(rec.running).toBe(true);
  });

  it("never starts while off", () => {
    const { result, rec } = listen({ enabled: false });
    expect(result.current.status).toBe("off");
    expect(rec.starts).toBe(0);
  });

  it("says so where the browser can't listen", () => {
    vi.stubGlobal("webkitSpeechRecognition", undefined);
    const { result } = renderHook(() =>
      useKitchenVoiceCommands({ enabled: true, onCommand: () => {} }),
    );
    expect(result.current.status).toBe("unsupported");
  });

  it("logs each echo for a flag's lead-up, before the command acts (B2)", () => {
    const logged: string[] = [];
    const { rec } = listen({
      onCommand: (c) => void logged.push(...recentEvents().map((e) => e.detail), `acted ${c}`),
    });
    say(rec, "Sue, next");
    expect(logged).toEqual(['next ("sue next")', "acted next"]);
    say(rec, "Sue, flip it");
    say(rec, "Sue");
    expect(recentEvents().map((e) => [e.kind, e.detail])).toEqual([
      ["voice", 'next ("sue next")'],
      ["voice", 'unknown ("sue flip it")'],
      ["voice", "armed"],
    ]);
  });

  it("never logs talk addressed to Sous past three words (B2)", () => {
    const { rec } = listen();
    say(rec, "Sue");
    say(rec, "the dal needs more salt I think");
    say(rec, "Sue said the dal needs salt");
    expect(recentEvents().map((e) => e.detail)).toEqual(["armed"]);
  });

  it("keeps the session when the command handler changes", () => {
    const { rerender, rec } = listen();
    const later: VoiceCommand[] = [];
    rerender({ onCommand: (c) => void later.push(c) });
    expect(FakeSpeechRecognition.instances).toHaveLength(1);
    expect(rec.aborted).toBe(false);
    say(rec, "Sue, done");
    expect(later).toEqual(["done"]);
  });
});

describe("useKitchenVoiceCommands on Android: one listen per tap", () => {
  const ANDROID =
    "Mozilla/5.0 (Linux; Android 16; Pixel Tablet) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/140.0.0.0 Safari/537.36";

  beforeEach(() => {
    vi.spyOn(navigator, "userAgent", "get").mockReturnValue(ANDROID);
  });

  afterEach(() => {
    vi.restoreAllMocks();
  });

  const talk = (result: { current: { talk: () => void } }) => act(() => result.current.talk());

  it("listens to nothing until tapped, as each start chimes", () => {
    const { result, rec } = listen();
    expect(result.current.mode).toBe("tap");
    expect(result.current.status).toBe("ready");
    wait(MAX_RESTART_MS * 2);
    expect(rec.starts).toBe(0);
  });

  it("listens once on a tap, for one command with no “Sue” needed", () => {
    const { result, rec } = listen();
    talk(result);
    expect(rec).toMatchObject({ continuous: true, interimResults: true, running: true });
    expect(result.current.status).toBe("hearing");
    say(rec, "next");
    expect(commands).toEqual(["next"]);
    expect(result.current.echo).toEqual({ kind: "command", command: "next", heard: "next" });
  });

  it("never starts again on its own once the listen ends", () => {
    const { result, rec } = listen();
    talk(result);
    say(rec, "Sue, back");
    act(() => rec.end());
    expect(result.current.status).toBe("ready");
    wait(MAX_RESTART_MS * 2);
    expect(rec.starts).toBe(1);
    expect(commands).toEqual(["back"]);
  });

  it("says it heard nothing when the listen ends in silence", () => {
    const { result, rec } = listen();
    talk(result);
    act(() => rec.fail("no-speech"));
    expect(result.current.echo).toEqual({ kind: "silence" });
    expect(result.current.status).toBe("ready");
    wait(MAX_RESTART_MS * 2);
    expect(rec.starts).toBe(1);
  });

  it("echoes what it can't use, and says when the listen failed", () => {
    const { result, rec } = listen();
    talk(result);
    say(rec, "flip");
    wait(QUIET_MS);
    expect(result.current.echo).toEqual({ kind: "unknown", heard: "flip" });
    act(() => rec.end());
    talk(result);
    act(() => rec.fail("network"));
    expect(result.current.echo).toEqual({ kind: "trouble" });
    expect(result.current.status).toBe("ready");
    expect(commands).toEqual([]);
  });

  it("after a tap, a command that declines is asked of Ask, as before B5d", () => {
    const questions: string[] = [];
    const { result, rec } = listen({ onCommand: () => false, onQuestion: (q) => questions.push(q) });
    talk(result);
    say(rec, "not yet");
    expect(questions).toEqual(["Not yet"]);
    expect(result.current.echo).toEqual({ kind: "asked", text: "Not yet" });
  });

  it("hands a question to Ask, as asked, and echoes it", () => {
    const questions: string[] = [];
    const { result, rec } = listen({ onQuestion: (q) => questions.push(q) });
    talk(result);
    // Not "how much salt": that is an amount question since B5d (D11), answered without Ask.
    say(rec, "Sue, can I use butter instead?");
    wait(QUIET_MS);
    expect(questions).toEqual(["Can I use butter instead?"]);
    expect(commands).toEqual([]);
    expect(result.current.echo).toEqual({ kind: "asked", text: "Can I use butter instead?" });
    expect(result.current.status).toBe("ready");
    // One tap, one question: what Chrome hands over after it is dropped.
    say(rec, "and what about oil instead");
    expect(questions).toHaveLength(1);
  });

  it("ends a listen under way when told to, and drops what it hears as it stops; never starts one", () => {
    const questions: string[] = [];
    const { result, rec } = listen({ onQuestion: (q) => questions.push(q) });
    // Nothing under way: ending starts nothing.
    act(() => result.current.end());
    expect(rec.starts).toBe(0);
    expect(result.current.status).toBe("ready");
    talk(result);
    expect(result.current.status).toBe("hearing");
    act(() => result.current.end());
    expect(result.current.status).toBe("ready");
    expect(rec.running).toBe(false);
    // What Chrome hands over as it stops counts for nothing.
    say(rec, "Sue, can I use butter instead?");
    wait(QUIET_MS);
    expect(questions).toEqual([]);
    expect(commands).toEqual([]);
    // Ending twice is still nothing, and the next tap listens afresh.
    act(() => result.current.end());
    expect(rec.starts).toBe(1);
    talk(result);
    expect(rec.starts).toBe(2);
    expect(result.current.status).toBe("hearing");
  });

  it("asks nothing when a tap hears a word too few to ask about", () => {
    const questions: string[] = [];
    const { result, rec } = listen({ onQuestion: (q) => questions.push(q) });
    talk(result);
    say(rec, "salt");
    wait(QUIET_MS);
    expect(questions).toEqual([]);
    expect(result.current.echo).toEqual({ kind: "unknown", heard: "salt" });
  });

  it("cancels on a second tap, dropping what Chrome hands over as it stops", () => {
    const { result, rec } = listen();
    rec.slowStop = true;
    talk(result);
    talk(result);
    expect(rec.stopped).toBe(true);
    expect(result.current.status).toBe("ready");
    say(rec, "next");
    act(() => rec.end());
    expect(commands).toEqual([]);
    expect(result.current.echo).toBeNull();
  });

  it("shows a denied mic, and tries again on the next tap", () => {
    const { result, rec } = listen();
    talk(result);
    act(() => rec.fail("not-allowed"));
    expect(result.current.status).toBe("blocked");
    talk(result);
    expect(rec.starts).toBe(2);
    expect(result.current.status).toBe("hearing");
  });

  it("recovers when Chrome refuses to start the listen", () => {
    const { result, rec } = listen();
    rec.refuseStart = true;
    talk(result);
    expect(rec.running).toBe(false);
    expect(result.current.status).toBe("ready");
    expect(result.current.echo).toEqual({ kind: "trouble" });
  });

  it("takes no tap while held, and a hold ends the listen", () => {
    const { result, rec, rerender } = listen();
    rec.slowStop = true;
    talk(result);
    rerender({ paused: true });
    expect(rec.stopped).toBe(true);
    expect(result.current.status).toBe("paused");
    // A result Chrome hands over as the hold stops it is dropped.
    say(rec, "next");
    act(() => rec.end());
    expect(commands).toEqual([]);
    talk(result);
    expect(rec.starts).toBe(1);
    rerender({ paused: false });
    expect(result.current.status).toBe("ready");
    expect(rec.running).toBe(false);
  });

  it("waits for a cancelled listen to end before listening again, and drops what it heard", () => {
    const { result, rec } = listen();
    rec.slowStop = true;
    talk(result);
    talk(result);
    talk(result);
    expect(result.current.status).toBe("hearing");
    expect(rec.starts).toBe(1);
    say(rec, "next");
    expect(commands).toEqual([]);
    act(() => rec.end());
    expect(rec.starts).toBe(2);
    expect(result.current.status).toBe("hearing");
    say(rec, "back");
    expect(commands).toEqual(["back"]);
  });

  it("takes a tap straight after a command as a new listen, not a cancel", () => {
    const { result, rec } = listen();
    rec.slowStop = true;
    talk(result);
    say(rec, "next");
    expect(result.current.status).toBe("ready");
    talk(result);
    expect(result.current.status).toBe("hearing");
    act(() => rec.end());
    expect(rec.starts).toBe(2);
    say(rec, "back");
    expect(commands).toEqual(["next", "back"]);
  });

  it("drops what a held listen hands over even once the hold lifts", () => {
    const { result, rec, rerender } = listen();
    rec.slowStop = true;
    talk(result);
    rerender({ paused: true });
    rerender({ paused: false });
    expect(result.current.status).toBe("ready");
    say(rec, "next");
    act(() => rec.end());
    expect(commands).toEqual([]);
    expect(rec.starts).toBe(1);
  });

  it("doesn't start a waiting listen once a hold comes", () => {
    const { result, rec, rerender } = listen();
    rec.slowStop = true;
    talk(result);
    talk(result);
    talk(result);
    rerender({ paused: true });
    act(() => rec.end());
    rerender({ paused: false });
    expect(rec.starts).toBe(1);
    expect(result.current.status).toBe("ready");
  });

  it("reads paused while held, even with the mic denied", () => {
    const { result, rec, rerender } = listen();
    talk(result);
    act(() => rec.fail("not-allowed"));
    rerender({ paused: true });
    expect(result.current.status).toBe("paused");
    rerender({ paused: false });
    expect(result.current.status).toBe("blocked");
  });

  it("is ready whether or not voice was switched off, as nothing listens untapped", () => {
    const { result } = listen({ enabled: false });
    expect(result.current.status).toBe("ready");
  });

  describe("a listen from a tap hears the cook out", () => {
    let questions: string[];
    const asking = () => listen({ onQuestion: (q) => void questions.push(q) });
    const logged = () => recentEvents().map((e) => e.detail);

    beforeEach(() => {
      questions = [];
    });

    it("hears a question through a pause, and asks it once the cook has been quiet", () => {
      const { result, rec } = asking();
      talk(result);
      say(rec, "The butter is still a little bit cold");
      wait(QUIET_MS - 1);
      expect(questions).toEqual([]);
      expect(result.current.status).toBe("hearing");
      expect(rec.running).toBe(true);

      say(rec, " should I melt it first");
      wait(QUIET_MS - 1);
      expect(questions).toEqual([]);
      wait(1);
      const asked = "The butter is still a little bit cold should I melt it first";
      expect(questions).toEqual([asked]);
      expect(result.current.echo).toEqual({ kind: "asked", text: asked });
      expect(result.current.status).toBe("ready");
      expect(rec.stopped).toBe(true);
      expect(rec.running).toBe(false);
      expect(logged()).toEqual(["listen ended: quiet, words heard, 3.6 s", "asked"]);
    });

    it("counts words still being heard, but not a final that only settles them", () => {
      const { result, rec } = asking();
      talk(result);
      say(rec, "is the oil", false);
      wait(QUIET_MS - 100);
      say(rec, "is the oil hot enough", false);
      wait(QUIET_MS - 100);
      expect(questions).toEqual([]);
      // The same words, settled: the quiet runs on from the last new word.
      say(rec, "Is the oil hot enough?");
      wait(99);
      expect(questions).toEqual([]);
      wait(1);
      expect(questions).toEqual(["Is the oil hot enough?"]);
    });

    it("acts on a settled command at once, as a tap always has, and nothing ends that listen again", () => {
      const { result, rec } = asking();
      talk(result);
      say(rec, "next");
      expect(commands).toEqual(["next"]);
      expect(rec.running).toBe(false);
      wait(MAX_LISTEN_MS);
      expect(commands).toEqual(["next"]);
      expect(questions).toEqual([]);
      // The command's echo says how the listen ended; nothing more is logged.
      expect(logged()).toEqual(['next ("next")']);
    });

    it("acts on a command still being heard after a short quiet, so “next few” isn't taken as “next”", () => {
      const { result, rec } = asking();
      talk(result);
      say(rec, "next", false);
      wait(COMMAND_QUIET_MS - 1);
      expect(commands).toEqual([]);
      say(rec, "next few", false);
      wait(COMMAND_QUIET_MS - 1);
      expect(commands).toEqual([]);
      wait(1);
      expect(commands).toEqual(["next-few"]);
      expect(rec.running).toBe(false);
      // It ended on its quiet, so that is logged beside the command's echo.
      expect(logged()).toEqual(["listen ended: quiet, words heard, 1.4 s", 'next-few ("next few")']);
    });

    it("takes what it heard as it stands at the longest listen", () => {
      const { result, rec } = asking();
      talk(result);
      const words: string[] = [];
      for (let at = 0; at < MAX_LISTEN_MS; at += 1000) {
        words.push("stir");
        say(rec, words.join(" "), false);
        wait(1000);
      }
      expect(questions).toEqual([`S${words.join(" ").slice(1)}`]);
      expect(rec.running).toBe(false);
      expect(logged()).toEqual(["listen ended: longest, words heard, 20.0 s", "asked"]);
    });

    it("ends a listen that hears no words at all, as heard nothing", () => {
      const { result, rec } = asking();
      talk(result);
      wait(FIRST_WORDS_MS - 1);
      expect(result.current.status).toBe("hearing");
      wait(1);
      expect(result.current.status).toBe("ready");
      expect(result.current.echo).toEqual({ kind: "silence" });
      expect(rec.running).toBe(false);
      expect(logged()).toEqual(["listen ended: no words, nothing heard, 8.0 s", "silence"]);
    });

    it("hands over what it heard when Chrome ends the listen itself, and says Chrome ended it", () => {
      const { result, rec } = asking();
      talk(result);
      say(rec, "The butter is still a little bit cold");
      wait(1000);
      act(() => rec.end());
      expect(questions).toEqual(["The butter is still a little bit cold"]);
      expect(result.current.status).toBe("ready");
      expect(logged()).toEqual(["listen ended: browser, words heard, 1.0 s", "asked"]);
      // Its quiet is over with it.
      wait(QUIET_MS);
      expect(questions).toHaveLength(1);
    });

    it("hands over words Chrome never settled when it ends the listen", () => {
      const { result, rec } = asking();
      talk(result);
      say(rec, "can I use butter", false);
      act(() => rec.end());
      expect(questions).toEqual(["Can I use butter"]);
    });

    it("says it heard nothing when Chrome ends the listen with no words and no error", () => {
      const { result, rec } = asking();
      talk(result);
      wait(500);
      act(() => rec.end());
      expect(result.current.echo).toEqual({ kind: "silence" });
      expect(logged()).toEqual(["listen ended: browser, nothing heard, 0.5 s", "silence"]);
    });

    it("reads Chrome on Android's repeated results as one question, and a repeated command once", () => {
      const { result, rec } = asking();
      talk(result);
      act(() =>
        rec.sayResults(
          [
            { transcript: "is the oil", isFinal: true },
            { transcript: "is the oil hot enough yet", isFinal: true },
          ],
          1,
        ),
      );
      wait(QUIET_MS);
      expect(questions).toEqual(["Is the oil hot enough yet"]);

      talk(result);
      act(() =>
        rec.sayResults([
          { transcript: "next", isFinal: true },
          { transcript: "next", isFinal: true },
        ]),
      );
      expect(commands).toEqual(["next"]);
    });

    it("hands over the words heard before an error, and logs the error", () => {
      const { result, rec } = asking();
      talk(result);
      say(rec, "can I use butter");
      act(() => rec.fail("network"));
      expect(questions).toEqual(["Can I use butter"]);
      expect(result.current.echo).toEqual({ kind: "asked", text: "Can I use butter" });
      expect(logged()).toEqual(["listen ended: error network, words heard, 0.0 s", "asked"]);
    });

    it("logs an error with no words, silence and a denied mic included", () => {
      const { result, rec } = asking();
      talk(result);
      act(() => rec.fail("no-speech"));
      talk(result);
      act(() => rec.fail("network"));
      talk(result);
      act(() => rec.fail("not-allowed"));
      expect(result.current.status).toBe("blocked");
      expect(logged()).toEqual([
        "listen ended: error no-speech, nothing heard, 0.0 s",
        "silence",
        "listen ended: error network, nothing heard, 0.0 s",
        "trouble",
        "listen ended: error not-allowed, nothing heard, 0.0 s",
      ]);
    });

    it("tells an abort it didn't ask for (the system taking the mic) from Chrome's own end", () => {
      const { result, rec } = asking();
      talk(result);
      say(rec, "can I use butter");
      wait(500);
      // Chrome reports "aborted", then ends the session.
      act(() => rec.abort());
      expect(questions).toEqual(["Can I use butter"]);
      expect(result.current.status).toBe("ready");

      talk(result);
      act(() => rec.abort());
      expect(result.current.echo).toBeNull();
      expect(logged()).toEqual([
        "listen ended: aborted, words heard, 0.5 s",
        "asked",
        "listen ended: aborted, nothing heard, 0.0 s",
      ]);
    });

    it("starts a queued tap's clocks when its session starts, not at the tap", () => {
      const { result, rec } = asking();
      rec.slowStop = true;
      talk(result);
      talk(result);
      // A tap while the cancelled session is still closing waits for it.
      talk(result);
      wait(FIRST_WORDS_MS + 1000);
      expect(result.current.status).toBe("hearing");
      expect(rec.starts).toBe(1);
      act(() => rec.end());
      expect(rec.starts).toBe(2);
      wait(FIRST_WORDS_MS - 1);
      expect(result.current.status).toBe("hearing");
      wait(1);
      expect(result.current.status).toBe("ready");
      expect(result.current.echo).toEqual({ kind: "silence" });
      expect(logged()).toEqual([
        "listen ended: cancelled, nothing heard, 0.0 s",
        "listen ended: no words, nothing heard, 8.0 s",
        "silence",
      ]);
    });

    it("logs a listen cancelled by a second tap, dropping its words", () => {
      const { result, rec } = asking();
      talk(result);
      say(rec, "the butter is");
      wait(1000);
      talk(result);
      wait(QUIET_MS);
      expect(questions).toEqual([]);
      expect(logged()).toEqual(["listen ended: cancelled, words heard, 1.0 s"]);
    });

    it("logs a listen a hold ends (Ask takes the mic, Sous speaks), dropping its words", () => {
      const { result, rec, rerender } = asking();
      const onQuestion = (q: string) => void questions.push(q);
      talk(result);
      say(rec, "the butter is");
      rerender({ onQuestion, paused: true });
      wait(QUIET_MS);
      expect(questions).toEqual([]);
      expect(logged()).toEqual(["listen ended: held, words heard, 0.0 s"]);
      // A hold with no listen under way logs nothing.
      rerender({ onQuestion, paused: false });
      rerender({ onQuestion, paused: true });
      expect(logged()).toHaveLength(1);
    });
  });
});
