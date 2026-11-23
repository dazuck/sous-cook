import { describe, expect, it, vi } from "vitest";
import { createChime } from "./chime";

// Ported from the Player's `tests/chime.test.ts` (B5a, A13).

function fakeContext(state: AudioContextState = "suspended") {
  const started: number[] = [];
  const node = () => ({
    connect: vi.fn().mockImplementation((next: unknown) => next),
    type: "sine",
    frequency: { value: 0 },
    gain: { setValueAtTime: vi.fn(), exponentialRampToValueAtTime: vi.fn() },
    start: (at: number) => started.push(at),
    stop: vi.fn(),
  });
  const ctx = {
    state,
    currentTime: 1,
    destination: {},
    resume: vi.fn().mockImplementation(() => {
      ctx.state = "running";
      return Promise.resolve();
    }),
    createOscillator: vi.fn().mockImplementation(node),
    createGain: vi.fn().mockImplementation(node),
  };
  return { ctx, started };
}

describe("createChime", () => {
  it("stays silent, and says so, until unlocked from a gesture", () => {
    const { ctx } = fakeContext();
    const chime = createChime(() => ctx as unknown as AudioContext);
    expect(chime.unlocked()).toBe(false);
    expect(chime.play()).toBe(false);
    chime.unlock();
    expect(ctx.resume).toHaveBeenCalledOnce();
    expect(chime.unlocked()).toBe(true);
    expect(chime.play()).toBe(true);
  });

  it("plays two tones", () => {
    const { ctx, started } = fakeContext("running");
    const chime = createChime(() => ctx as unknown as AudioContext);
    chime.unlock();
    chime.play();
    expect(started).toEqual([1, 1.18]);
  });

  it("makes one context however often it is unlocked", () => {
    const make = vi.fn().mockImplementation(() => fakeContext("running").ctx);
    const chime = createChime(make);
    chime.unlock();
    chime.unlock();
    expect(make).toHaveBeenCalledOnce();
  });

  it("is silent where there is no audio at all", () => {
    const chime = createChime(() => null);
    chime.unlock();
    expect(chime.unlocked()).toBe(false);
    expect(chime.play()).toBe(false);
  });
});
