// @vitest-environment happy-dom
import { act, renderHook } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { speak } from "@/lib/kitchen/speak";
import { SPEAK_HOLD_CAP_MS, useSpeak } from "./useSpeak";

// Speech for the cook page (slice B5d, D13; the Player's `speak.test.ts`).
// A synthesizer that records what it was asked and ends when told to.

interface FakeUtterance {
  text: string;
  lang: string;
  onend: (() => void) | null;
  onerror: (() => void) | null;
}

let spoken: FakeUtterance[];
let cancels: number;

function install() {
  spoken = [];
  cancels = 0;
  vi.stubGlobal(
    "SpeechSynthesisUtterance",
    class {
      lang = "";
      onend: (() => void) | null = null;
      onerror: (() => void) | null = null;
      constructor(public text: string) {}
    },
  );
  const done = new Set<FakeUtterance>();
  vi.stubGlobal("speechSynthesis", {
    speak: (u: FakeUtterance) => {
      const end = u.onend;
      u.onend = () => {
        done.add(u);
        end?.();
      };
      spoken.push(u);
    },
    cancel: () => {
      cancels += 1;
      for (const u of spoken) done.add(u);
    },
    get speaking() {
      return spoken.some((u) => !done.has(u));
    },
    pending: false,
  });
}

beforeEach(() => {
  vi.useFakeTimers();
  install();
});
afterEach(() => {
  vi.useRealTimers();
  vi.unstubAllGlobals();
});

describe("speak", () => {
  it("says it in en-US, cancelling only what is still being said", () => {
    expect(speak("1 cup of milk", { onDone: () => {} })).toBe(true);
    // Nothing was being said: no cancel, which Chrome can answer by dropping the speech.
    expect(cancels).toBe(0);
    expect(spoken).toMatchObject([{ text: "1 cup of milk", lang: "en-US" }]);
    speak("2 eggs", { onDone: () => {} });
    expect(cancels).toBe(1);
  });

  it("says nothing, and reports so, where there's no synthesizer", () => {
    vi.unstubAllGlobals();
    const original = Object.getOwnPropertyDescriptor(window, "speechSynthesis");
    // happy-dom ships none: delete any stand-in.
    if (original) Reflect.deleteProperty(window, "speechSynthesis");
    const onDone = vi.fn();
    expect(speak("x", { onDone })).toBe(false);
    expect(onDone).not.toHaveBeenCalled();
  });
});

describe("useSpeak", () => {
  it("is speaking until the speech ends", () => {
    const { result } = renderHook(() => useSpeak());
    act(() => void result.current.say("1 cup of milk"));
    expect(result.current.speaking).toBe(true);
    act(() => spoken[0]!.onend!());
    expect(result.current.speaking).toBe(false);
  });

  it("lifts on an error too", () => {
    const { result } = renderHook(() => useSpeak());
    act(() => void result.current.say("x"));
    act(() => spoken[0]!.onerror!());
    expect(result.current.speaking).toBe(false);
  });

  it("lifts at the cap when the synthesizer never says it ended", () => {
    const { result } = renderHook(() => useSpeak());
    act(() => void result.current.say("x"));
    act(() => vi.advanceTimersByTime(SPEAK_HOLD_CAP_MS - 1));
    expect(result.current.speaking).toBe(true);
    act(() => vi.advanceTimersByTime(1));
    expect(result.current.speaking).toBe(false);
  });

  it("a newer answer cancels the older, whose end doesn't lift the newer's hold", () => {
    const { result } = renderHook(() => useSpeak());
    act(() => void result.current.say("first"));
    act(() => void result.current.say("second"));
    expect(cancels).toBe(1);
    act(() => spoken[0]!.onend!());
    expect(result.current.speaking).toBe(true);
    act(() => spoken[1]!.onend!());
    expect(result.current.speaking).toBe(false);
  });

  it("never holds where nothing can be said", () => {
    vi.unstubAllGlobals();
    Reflect.deleteProperty(window, "speechSynthesis");
    const { result } = renderHook(() => useSpeak());
    let said = true;
    act(() => {
      said = result.current.say("x");
    });
    expect(said).toBe(false);
    expect(result.current.speaking).toBe(false);
  });
});
