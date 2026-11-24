import { describe, expect, it, vi } from "vitest";
import { createAckAudio } from "./ack-audio";
import { CLIP_NAMES, clipUrl } from "./ack-clips";
import { FakeAudioContext, clipBytes } from "./testing/fakeAudioContext";

function setup(state: AudioContextState = "running") {
  const ctx = new FakeAudioContext(state);
  const report = vi.fn();
  const fetched: string[] = [];
  const fetchClip = vi.fn((url: string) => {
    fetched.push(url);
    return Promise.resolve(clipBytes(url));
  });
  const audio = createAckAudio({ context: () => ctx.as(), fetchClip, report });
  return { ctx, report, audio, fetched, fetchClip };
}

describe("Sue's two sounds", () => {
  it("understood rises, soft sines lower than the timer chime (A5, D6)", () => {
    const { ctx, audio } = setup();
    const end = audio.sound("understood");
    const notes = ctx.notes();
    expect(notes.map((n) => n.frequency)).toEqual([523.25, 783.99]);
    expect(notes.every((n) => n.type === "sine")).toBe(true);
    expect(Math.max(...notes.map((n) => n.frequency ?? 0))).toBeLessThan(880);
    // Starts at once (a hair after now), and tells when it ends.
    expect(notes[0].at).toBeCloseTo(ctx.currentTime, 1);
    expect(end).toBeGreaterThan(ctx.currentTime + 0.3);
    expect(end).toBeLessThan(ctx.currentTime + 0.5);
  });

  it("not understood falls, lower still, in a triangle wave", () => {
    const { ctx, audio } = setup();
    audio.sound("not-understood");
    const notes = ctx.notes();
    expect(notes.map((n) => n.frequency)).toEqual([392, 293.66]);
    expect(notes.every((n) => n.type === "triangle")).toBe(true);
  });

  it("stays silent and says so once while the page hasn't been tapped, and tries to wake", () => {
    const { ctx, audio, report } = setup("suspended");
    expect(audio.sound("understood")).toBeNull();
    expect(audio.sound("not-understood")).toBeNull();
    expect(ctx.started).toEqual([]);
    expect(ctx.resumes).toBe(2);
    expect(report).toHaveBeenCalledTimes(1);
    expect(report.mock.calls[0][0]).toBe("warn");
    expect(report.mock.calls[0][1]).toMatch(/locked/);
  });

  it("says once there is no WebAudio, and never throws", () => {
    const report = vi.fn();
    const audio = createAckAudio({ context: () => null, report });
    expect(audio.sound("understood")).toBeNull();
    expect(audio.sound("not-understood")).toBeNull();
    expect(audio.clip("flagged")).toBe(false);
    const noAudio = report.mock.calls.filter(([, message]) => /no WebAudio/.test(String(message)));
    expect(noAudio).toHaveLength(1);
    expect(noAudio[0][0]).toBe("warn");
  });
});

describe("Sue's clips", () => {
  it("fetches every clip in the set once, decodes it, and plays it by name", async () => {
    const { ctx, audio, fetched } = setup();
    await audio.warm();
    expect(fetched.sort()).toEqual(CLIP_NAMES.map(clipUrl).sort());
    await audio.warm();
    expect(fetched).toHaveLength(CLIP_NAMES.length);
    expect(audio.clip("flagged")).toBe(true);
    expect(ctx.clips()).toEqual(["flagged"]);
  });

  it("starts a clip no earlier than asked, and never in the past", async () => {
    const { ctx, audio } = setup();
    await audio.warm();
    audio.clip("on-it", ctx.currentTime + 2);
    audio.clip("on-it", ctx.currentTime - 5);
    const [late, now] = ctx.started.filter((s) => s.kind === "clip");
    expect(late.at).toBe(ctx.currentTime + 2);
    expect(now.at).toBeGreaterThanOrEqual(ctx.currentTime);
  });

  it("a clip that wasn't fetched is false and logged, not silent", async () => {
    const { ctx, audio, report } = setup();
    expect(audio.clip("flagged")).toBe(false);
    expect(audio.clip("flagged")).toBe(false);
    expect(ctx.clips()).toEqual([]);
    expect(report).toHaveBeenCalledTimes(1);
    expect(report.mock.calls[0][0]).toBe("error");
    expect(report.mock.calls[0][1]).toMatch(/flagged/);
  });

  it("a clip that 404s or won't decode is logged by name; the rest still play", async () => {
    const { ctx, report } = setup();
    ctx.undecodable.add("on-it");
    const original = createAckAudio({
      context: () => ctx.as(),
      report,
      fetchClip: (url) =>
        url.endsWith("timer-on.mp3") ? Promise.reject(new Error("answered 404")) : Promise.resolve(clipBytes(url)),
    });
    await original.warm();
    expect(original.clip("timer-on")).toBe(false);
    expect(original.clip("on-it")).toBe(false);
    expect(original.clip("flagged")).toBe(true);
    const said = report.mock.calls.filter((c) => c[0] === "error").map((c) => String(c[1]));
    expect(said.some((m) => m.includes('"timer-on"') && m.includes("didn't load"))).toBe(true);
    expect(said.some((m) => m.includes('"on-it"') && m.includes("didn't load"))).toBe(true);
  });

  it("a clip waits for the page's first tap, like the sounds", async () => {
    const { ctx, audio } = setup("suspended");
    await audio.warm();
    expect(audio.clip("flagged")).toBe(false);
    ctx.state = "running";
    expect(audio.clip("flagged")).toBe(true);
  });
});
