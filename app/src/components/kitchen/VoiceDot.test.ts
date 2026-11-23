import { describe, expect, it, vi } from "vitest";
import type { VoiceEcho, VoiceStatus } from "@/hooks/useKitchenVoiceCommands";
import { heardLine, VOICE_COPY, type VoiceProps } from "./VoiceDot";

function voice(status: VoiceStatus, echo: VoiceEcho | null = null): VoiceProps {
  return { mode: "always", status, echo, onTap: vi.fn() };
}

describe("heardLine: what floats over Ask Sous (P63 (a))", () => {
  it("is nothing at rest, whatever voice is doing, so Ask keeps its words", () => {
    for (const status of ["listening", "ready", "off", "paused", "blocked", "stalled"] as const) {
      expect(heardLine(voice(status)), status).toBeNull();
    }
  });

  it("is nothing where there is no voice, or the browser can't listen", () => {
    expect(heardLine(undefined)).toBeNull();
    expect(heardLine(voice("unsupported", { kind: "unknown", heard: "sue flip it" }))).toBeNull();
  });

  it("is what was misheard, said as the dot says it", () => {
    expect(heardLine(voice("listening", { kind: "unknown", heard: "sue flip it" }))).toBe(
      VOICE_COPY.unknown("sue flip it"),
    );
    expect(heardLine(voice("listening", { kind: "near-miss", heard: "flip it" }))).toBe(VOICE_COPY.nearMiss("flip it"));
  });

  it("is the echo of a command, the wake word, and a command's reply", () => {
    expect(heardLine(voice("listening", { kind: "command", command: "next", heard: "Sue, next" }))).toBe("“Sue, next”");
    expect(heardLine(voice("listening", { kind: "armed" }))).toBe(VOICE_COPY.armed);
    expect(
      heardLine(voice("listening", { kind: "reply", heard: "sue set a timer", text: "Couldn't set that timer" })),
    ).toBe("Couldn't set that timer");
  });

  it("is a question handed to Ask, a listen that heard nothing, and a listen that failed", () => {
    expect(heardLine(voice("listening", { kind: "asked", text: "How long do I rest it?" }))).toBe(
      VOICE_COPY.asked("How long do I rest it?"),
    );
    expect(heardLine({ ...voice("ready", { kind: "silence" }), mode: "tap" })).toBe(VOICE_COPY.silence);
    expect(heardLine({ ...voice("ready", { kind: "trouble" }), mode: "tap" })).toBe(VOICE_COPY.trouble);
  });

  it("is the listen in progress, when voice listens on a tap", () => {
    expect(heardLine({ ...voice("hearing"), mode: "tap" })).toBe(VOICE_COPY.hearing);
  });
});
