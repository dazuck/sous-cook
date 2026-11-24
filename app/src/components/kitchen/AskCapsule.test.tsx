// @vitest-environment happy-dom
import { cleanup, fireEvent, render, screen } from "@testing-library/react";
import { createRef } from "react";
import { afterEach, describe, expect, it, vi } from "vitest";
import { AskCapsule, type AskCapsuleHandle } from "./AskCapsule";
import { MicMark, VOICE_COPY, type VoiceProps } from "./VoiceDot";

// The capsule at the right end of the cook's top line (DS §5 Ask, v1.60;
// DECISIONS 2026-11-22 "Ask Sous is a side panel", calls 10 and 13): a mic,
// the words "Ask Sous" and a camera, each its own way into the panel.

afterEach(cleanup);

const voice = (status: VoiceProps["status"], mode: VoiceProps["mode"] = "tap") => ({ mode, status });

function capsule(over: Partial<Parameters<typeof AskCapsule>[0]> = {}) {
  const props = {
    label: "Ask Sous",
    short: "Ask",
    onWords: vi.fn(),
    onMic: vi.fn(),
    onPhoto: vi.fn(),
    voice: voice("ready"),
    ...over,
  };
  const view = render(<AskCapsule {...props} />);
  return { props, ...view };
}

const parts = () => [...document.querySelectorAll<HTMLButtonElement>("[data-ask-capsule] button")];
const mic = () => screen.getByRole("button", { name: VOICE_COPY.talk });
const words = () => screen.getByRole("button", { name: "Ask Sous" });
const camera = () => screen.getByRole("button", { name: "Take a photo for Sous" });
const tokens = (el: Element) => el.className.split(/\s+/);

describe("the capsule's three parts", () => {
  it("is the mic, the words and the camera, in that order, each a button with its name", () => {
    capsule();
    expect(parts()).toEqual([mic(), words(), camera()]);
    expect(parts().map((b) => b.getAttribute("type"))).toEqual(["button", "button", "button"]);
  });

  it("opens Ask three ways: the mic to talk, the words to type, the camera to show", () => {
    const { props } = capsule();
    fireEvent.click(mic());
    expect(props.onMic).toHaveBeenCalledOnce();
    expect(props.onWords).not.toHaveBeenCalled();
    fireEvent.click(words());
    expect(props.onWords).toHaveBeenCalledOnce();
    fireEvent.click(camera());
    expect(props.onPhoto).toHaveBeenCalledOnce();
    expect(props.onMic).toHaveBeenCalledOnce();
  });

  it("says Ask Sous in landscape and Ask in portrait, under the one name", () => {
    capsule();
    const [long, short] = [...words().querySelectorAll("span")];
    expect(long!.textContent).toBe("Ask Sous");
    expect(tokens(long!)).toContain("portrait:hidden");
    expect(short!.textContent).toBe("Ask");
    expect(tokens(short!)).toEqual(expect.arrayContaining(["hidden", "portrait:inline"]));
    // The words are read once, by the button's name, whichever is drawn.
    expect(words().getAttribute("aria-label")).toBe("Ask Sous");
  });

  it("has no mic where the browser cannot listen, and none before the page knows how it listens", () => {
    capsule({ voice: voice("unsupported") });
    expect(screen.queryByRole("button", { name: VOICE_COPY.talk })).toBeNull();
    expect(parts()).toEqual([words(), camera()]);
    cleanup();
    capsule({ voice: undefined });
    expect(parts()).toEqual([words(), camera()]);
  });

  it("has no camera where there is none to open", () => {
    capsule({ onPhoto: undefined });
    expect(parts()).toEqual([mic(), words()]);
  });
});

describe("the capsule's targets (DS §0.3: no target under 80 cpx)", () => {
  it("is a target tall, each part the row's full height", () => {
    capsule();
    expect(tokens(document.querySelector("[data-ask-capsule]")!)).toContain("h-[var(--target)]");
    for (const part of parts()) expect(tokens(part)).toContain("h-full");
  });

  it("keeps the mic a full target across at every width; the words and camera give side room in portrait", () => {
    capsule();
    expect(tokens(mic())).toContain("min-w-[var(--target)]");
    expect(tokens(mic()).filter((t) => t.startsWith("portrait:"))).toEqual([]);
    for (const part of [words(), camera()]) {
      expect(tokens(part)).toEqual(
        expect.arrayContaining(["min-w-[var(--target)]", "portrait:min-w-[calc(64*var(--cpx))]"]),
      );
    }
  });

  it("draws a Paper pill with its hairline, and nothing in it is ember", () => {
    capsule();
    const root = document.querySelector("[data-ask-capsule]")!;
    expect(tokens(root)).toEqual(expect.arrayContaining(["before:bg-paper", "before:border-ink/[.11]"]));
    for (const el of root.querySelectorAll("*")) {
      expect(String(el.getAttribute("class") ?? "")).not.toContain("ember");
    }
  });

  it("shows a ring on the part the keyboard is on", () => {
    capsule();
    for (const part of parts()) {
      expect(tokens(part)).toEqual(expect.arrayContaining(["focus-visible:outline-3", "focus-visible:outline-ink"]));
    }
  });
});

describe("the mic glyph (2026-11-22: a mic, not the dot)", () => {
  it("is an outline at rest, and fills and pulses while it listens", () => {
    for (const status of ["ready", "off", "paused", "blocked", "stalled"] as const) {
      const { container } = render(<MicMark status={status} />);
      const mark = container.querySelector("[data-voice-mic]")!;
      expect(mark.getAttribute("data-voice-mic")).toBe(status);
      expect(mark.hasAttribute("data-live")).toBe(false);
      expect(tokens(mark)).not.toContain("animate-dot-breathe");
      cleanup();
    }
    for (const status of ["listening", "hearing"] as const) {
      const { container } = render(<MicMark status={status} />);
      const mark = container.querySelector("[data-voice-mic]")!;
      expect(mark.hasAttribute("data-live")).toBe(true);
      // Still under reduced motion: filled, not pulsing.
      expect(tokens(mark)).toEqual(expect.arrayContaining(["animate-dot-breathe", "motion-reduce:animate-none"]));
      cleanup();
    }
  });

  it("is hidden from a screen reader: the button's name says what it does", () => {
    const { container } = render(<MicMark status="ready" />);
    expect(container.querySelector("svg")!.getAttribute("aria-hidden")).toBe("true");
  });

  it("names the mic by what a tap does: talk where voice listens on a tap, the switch where it listens all the time", () => {
    capsule({ voice: voice("ready", "tap") });
    expect(parts()[0]!.getAttribute("aria-label")).toBe(VOICE_COPY.talk);
    cleanup();
    capsule({ voice: voice("hearing", "tap") });
    expect(parts()[0]!.getAttribute("aria-label")).toBe(VOICE_COPY.stopTalking);
    cleanup();
    capsule({ voice: voice("listening", "always") });
    expect(parts()[0]!.getAttribute("aria-label")).toBe(VOICE_COPY.turnOff);
    cleanup();
    capsule({ voice: voice("off", "always") });
    expect(parts()[0]!.getAttribute("aria-label")).toBe(VOICE_COPY.turnOn);
  });

  it("marks the capsule's mic with how the voice stands, and holds a tap's listen while Sous speaks", () => {
    capsule({ voice: voice("paused") });
    expect(mic().getAttribute("data-voice")).toBe("paused");
    expect(mic().getAttribute("aria-disabled")).toBe("true");
    cleanup();
    // Listening all the time, a pause is not the mic refusing a tap.
    capsule({ voice: voice("paused", "always") });
    expect(parts()[0]!.hasAttribute("aria-disabled")).toBe(false);
  });
});

describe("the capsule on the pinned whole-cook chart, where the top line gives way (review round 1, call 26)", () => {
  const chart = () => document.querySelector("[data-ask-capsule-chart]")!;
  const chartParts = () => [...chart().querySelectorAll<HTMLButtonElement>("button")];

  it("is the mic and the short word, no camera, under its own mark: the top line's capsule is the one tests and focus find", () => {
    const { props } = capsule({ place: "chart" });
    expect(document.querySelector("[data-ask-capsule]")).toBeNull();
    expect(chartParts()).toEqual([mic(), words()]);
    expect(words().textContent).toBe("Ask");
    expect(words().getAttribute("aria-label")).toBe("Ask Sous");
    expect(screen.queryByRole("button", { name: "Take a photo for Sous" })).toBeNull();
    fireEvent.click(mic());
    expect(props.onMic).toHaveBeenCalledOnce();
    fireEvent.click(words());
    expect(props.onWords).toHaveBeenCalledOnce();
    // The same Paper pill, a target tall.
    expect(tokens(chart())).toEqual(expect.arrayContaining(["h-[var(--target)]", "before:bg-paper"]));
    expect(tokens(mic())).toContain("min-w-[var(--target)]");
    // The screen has one mic by `[data-voice]`, the top line's (or the panel's): the chart's says how
    // the voice stands under a mark of its own, since it waits in the page, hidden, while the top line shows.
    expect(mic().hasAttribute("data-voice")).toBe(false);
    expect(mic().getAttribute("data-chart-voice")).toBe("ready");
    expect(tokens(words())).toContain("min-w-[calc(64*var(--cpx))]");
    expect(tokens(words())).not.toContain("min-w-[var(--target)]");
  });

  it("is not drawn in portrait: the chart's first row has no room beside the dish's name there", () => {
    capsule({ place: "chart" });
    expect(tokens(chart())).toContain("portrait:hidden");
    // Nothing inside it hides by itself: it is whole, or not there.
    for (const part of chartParts()) expect(tokens(part).filter((t) => t.startsWith("portrait:"))).toEqual([]);
    cleanup();
    // The top line's capsule is drawn at every width.
    capsule();
    expect(tokens(document.querySelector("[data-ask-capsule]")!)).not.toContain("portrait:hidden");
  });

  it("is the words alone where the mic would not open Ask: voice listening all the time, or none", () => {
    capsule({ place: "chart", voice: voice("listening", "always") });
    expect(chartParts()).toEqual([words()]);
    cleanup();
    capsule({ place: "chart", voice: voice("unsupported") });
    expect(chartParts()).toEqual([words()]);
  });
});

describe("focus comes back to the part that opened Ask (call 7)", () => {
  it("focuses the mic, the words or the camera by name", () => {
    const ref = createRef<AskCapsuleHandle>();
    capsule({ ref });
    ref.current!.focus("mic");
    expect(document.activeElement).toBe(mic());
    ref.current!.focus("camera");
    expect(document.activeElement).toBe(camera());
    ref.current!.focus("words");
    expect(document.activeElement).toBe(words());
  });

  it("falls back to the words when the part is not drawn", () => {
    const ref = createRef<AskCapsuleHandle>();
    capsule({ ref, voice: voice("unsupported"), onPhoto: undefined });
    ref.current!.focus("mic");
    expect(document.activeElement).toBe(words());
    ref.current!.focus("camera");
    expect(document.activeElement).toBe(words());
  });
});
