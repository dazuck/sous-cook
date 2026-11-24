import { readFileSync } from "node:fs";
import { join } from "node:path";
import type { Page } from "@playwright/test";
import { test, expect } from "./fixtures";
import { readQueueRowByName } from "./db";
import { installFakeSpeech } from "./fake-speech";
import { RECIPE_NAMES } from "./seed-data";

/**
 * Sue's replies in a real browser, as the repository ships: with every
 * recorded clip (app/public/sounds/sue/, docs/voice-replies.md). The sounds
 * a command makes and when, nothing for touch, the spoken confirmation
 * playing from the real files, the setting in More, and every clip
 * answering and decoding in Chromium. The rules are unit-tested in
 * `src/lib/kitchen/voice-ack.test.ts`, the hook's wiring in
 * `src/hooks/useKitchenVoiceCommands.ack.test.ts`, and a build without the
 * clips in the unit tests that stub the build's switch.
 *
 * Commands are heard through a recognizer the spec talks to
 * (`fake-speech.ts`). The page's AudioContext is watched, not replaced: each
 * oscillator and each buffer started is recorded as it starts, with the clip
 * named by its file's bytes, so a test says "the flagged clip" and not "some
 * sound".
 */

const CLIP_DIR = join(__dirname, "../public/sounds/sue");
const RECORD = JSON.parse(readFileSync(join(__dirname, "../scripts/data/sue-clips.json"), "utf8")) as {
  clips: { name: string; seconds: number; bytes: number }[];
};
const CLIP_NAMES = RECORD.clips.map((c) => c.name);

/** The same sum over a file's bytes the page computes, so a started buffer names its clip. */
function checksum(bytes: Uint8Array): number {
  let h = 2166136261;
  for (const b of bytes) h = Math.imul(h ^ b, 16777619) >>> 0;
  return h;
}
const SUMS = new Map(CLIP_NAMES.map((n) => [checksum(new Uint8Array(readFileSync(join(CLIP_DIR, `${n}.mp3`)))), n]));

declare global {
  interface Window {
    __ack: { notes: { f: number; type: string }[]; clips: number[]; decoded: number };
  }
}

/** Runs in the page, so it must stand alone: no imports, no outside names. */
function watchAudio() {
  const log = { notes: [] as { f: number; type: string }[], clips: [] as number[], decoded: 0 };
  window.__ack = log;
  const sums = new WeakMap<AudioBuffer, number>();
  const sum = (bytes: Uint8Array) => {
    let h = 2166136261;
    for (const b of bytes) h = Math.imul(h ^ b, 16777619) >>> 0;
    return h;
  };
  const proto = AudioContext.prototype;
  const createOscillator = proto.createOscillator;
  proto.createOscillator = function (this: AudioContext) {
    const osc = createOscillator.call(this);
    const start = osc.start.bind(osc);
    osc.start = (when?: number) => {
      log.notes.push({ f: Math.round(osc.frequency.value * 100) / 100, type: osc.type });
      start(when);
    };
    return osc;
  };
  const decode = proto.decodeAudioData as (this: AudioContext, data: ArrayBuffer) => Promise<AudioBuffer>;
  proto.decodeAudioData = function (this: AudioContext, data: ArrayBuffer) {
    const mine = sum(new Uint8Array(data.slice(0)));
    return decode.call(this, data).then((buffer) => {
      sums.set(buffer, mine);
      log.decoded += 1;
      return buffer;
    });
  } as typeof proto.decodeAudioData;
  const createBufferSource = proto.createBufferSource;
  proto.createBufferSource = function (this: AudioContext) {
    const source = createBufferSource.call(this);
    const start = source.start.bind(source);
    source.start = (when?: number) => {
      if (source.buffer) log.clips.push(sums.get(source.buffer) ?? -1);
      start(when);
    };
    return source;
  };
}

const UNDERSTOOD = [523.25, 783.99];
const NOT_UNDERSTOOD = [392, 293.66];

const say = (page: Page, text: string, isFinal = true) =>
  page.evaluate(([t, f]) => window.__speech.say(t, f), [text, isFinal] as const);
const notes = (page: Page) => page.evaluate(() => window.__ack.notes.filter((n) => n.f < 800 && n.f !== 880).map((n) => n.f));
const clips = async (page: Page) => (await page.evaluate(() => window.__ack.clips)).map((s) => SUMS.get(s) ?? `unknown ${s}`);
const dot = (page: Page) => page.locator("[data-voice]").last();

/** Every answer the server gave for a clip: its name, status and content type. */
function clipAnswers(page: Page) {
  const answers: { name: string; status: number; type: string }[] = [];
  page.on("response", (r) => {
    const path = new URL(r.url()).pathname;
    if (!path.startsWith("/sounds/sue/")) return;
    answers.push({ name: path.slice("/sounds/sue/".length).replace(/\.mp3$/, ""), status: r.status(), type: r.headers()["content-type"] ?? "" });
  });
  return answers;
}

/** Thin White Sauce, past its opening and its prep page, on its first cooking step, listening. */
async function toFirstStep(page: Page) {
  const row = await readQueueRowByName(RECIPE_NAMES.thinWhiteSauce);
  await page.goto(`/kitchen/queue/${row!.id}`);
  await page.locator("[data-opening-start]").click();
  await page.getByRole("button", { name: "Next step" }).click();
  await expect.poll(() => page.evaluate(() => window.__speech.listening())).toBe(1);
}

/** A tap anywhere unlocks the page's audio, as it does for the timer's chime. */
const tapPage = (page: Page) => page.getByRole("banner").click({ position: { x: 4, y: 4 } });

test.describe("Sue's replies", () => {
  test.beforeEach(async ({ page }) => {
    await page.addInitScript(installFakeSpeech);
    await page.addInitScript(watchAudio);
  });

  test("VOICE-1: Sue's replies is a row in More, Sounds until chosen, offering Sounds and voice, and the choice holds across a reload", async ({
    page,
  }) => {
    const answers = clipAnswers(page);
    const row = await readQueueRowByName(RECIPE_NAMES.thinWhiteSauce);
    await page.goto(`/kitchen/queue/${row!.id}`);
    await expect(page.locator("[data-opening-start]")).toBeVisible();
    const more = page.locator("[data-sheet-more]").getByRole("button", { name: "More" });
    await more.click();
    const replies = page.getByRole("button", { name: /^Sue's replies:/ });
    await expect(replies).toHaveText("Sue's replies: Sounds");
    expect(answers).toEqual([]);

    await replies.click();
    await expect(replies).toHaveText("Sue's replies: Sounds and voice");
    expect(await page.evaluate(() => localStorage.getItem("sous-sue-replies"))).toBe("voice");
    // Chosen, the clips are fetched once and kept decoded, every one found as audio.
    await expect.poll(() => page.evaluate(() => window.__ack.decoded)).toBe(CLIP_NAMES.length);
    expect(answers.map((a) => a.name).sort()).toEqual([...CLIP_NAMES].sort());
    for (const a of answers) {
      expect(a.status, a.name).toBe(200);
      expect(a.type, a.name).toMatch(/^audio\/mpeg/);
    }

    await replies.click();
    await expect(replies).toHaveText("Sue's replies: Off");
    // Opened afresh, as the next cook would be.
    await page.reload();
    await expect(page.locator("[data-opening-start]")).toBeVisible();
    await more.click();
    await expect(replies).toHaveText("Sue's replies: Off");
  });

  test("VOICE-2: every clip answers from the app as audio and decodes in Chromium, at the length the generator measured", async ({
    page,
  }) => {
    const answers = clipAnswers(page);
    await toFirstStep(page);
    const found = await page.evaluate(async (names) => {
      const ctx = new AudioContext();
      const out: Record<string, number> = {};
      for (const name of names) {
        const res = await fetch(`/sounds/sue/${name}.mp3`);
        if (!res.ok) throw new Error(`${name}: ${res.status}`);
        out[name] = (await ctx.decodeAudioData(await res.arrayBuffer())).duration;
      }
      return out;
    }, CLIP_NAMES);
    for (const { name, seconds } of RECORD.clips) {
      expect(found[name], name).toBeGreaterThan(0.25);
      expect(Math.abs(found[name] - seconds), `${name} decoded at ${found[name]} s, measured ${seconds} s`).toBeLessThan(0.12);
    }
    for (const a of answers) {
      expect(a.status, a.name).toBe(200);
      expect(a.type, a.name).toMatch(/^audio\/mpeg/);
    }
  });

  test("VOICE-3: a command said to Sue sounds understood; one not understood, lower; touch and talk not for Sue, nothing", async ({
    page,
  }) => {
    await toFirstStep(page);
    // A touch on the screen's own forward control moves the step and makes no sound.
    await tapPage(page);
    await page.keyboard.press("ArrowRight");
    await page.getByRole("button", { name: "Next step" }).click();
    expect(await notes(page)).toEqual([]);

    await say(page, "okay done");
    await say(page, "we should call Sue next");
    expect(await notes(page)).toEqual([]);

    await say(page, "Sue, back");
    expect(await notes(page)).toEqual(UNDERSTOOD);
    await say(page, "Sue, flip it");
    expect(await notes(page)).toEqual([...UNDERSTOOD, ...NOT_UNDERSTOOD]);
    // Sounds only, the setting until chosen: no clip, whatever was said.
    await say(page, "Sue, flag");
    expect(await clips(page)).toEqual([]);
  });

  test("VOICE-4: the sounds are lower and softer than the timer's chime, a sine for yes and a triangle for no", async ({ page }) => {
    await toFirstStep(page);
    await tapPage(page);
    await say(page, "Sue, next");
    await say(page, "Sue, flip it");
    const heard = await page.evaluate(() => window.__ack.notes);
    expect(heard.map((n) => n.type)).toEqual(["sine", "sine", "triangle", "triangle"]);
    // The chime's A5 and D6 are 880 and 1174.66.
    expect(Math.max(...heard.map((n) => n.f))).toBeLessThan(880);
  });

  test("VOICE-5: Off is silence", async ({ page }) => {
    await page.addInitScript(() => localStorage.setItem("sous-sue-replies", "off"));
    await toFirstStep(page);
    await tapPage(page);
    await say(page, "Sue, next");
    await say(page, "Sue, flip it");
    expect(await page.evaluate(() => window.__ack.notes)).toEqual([]);
  });

  test("VOICE-6: Sounds and voice: a flag said is confirmed by its clip, fetched from the app as audio, never by the browser's own voice, and the dot stays listening", async ({
    page,
  }) => {
    const answers = clipAnswers(page);
    // Not "Yes, chef" (the draw is under a third) and not the capped count: the plain clip.
    await page.addInitScript(() => {
      localStorage.setItem("sous-sue-replies", "voice");
      Math.random = () => 0.9;
      window.speechSynthesis.speak = () => {
        throw new Error("the browser's own voice was used");
      };
    });
    await toFirstStep(page);
    await tapPage(page);
    // The clips are fetched and decoded once the setting says voice.
    await expect.poll(() => page.evaluate(() => window.__ack.decoded)).toBe(CLIP_NAMES.length);
    await say(page, "Sue, flag");
    await expect.poll(() => clips(page)).toEqual(["flagged"]);
    expect(await notes(page)).toEqual(UNDERSTOOD);
    await expect(dot(page)).toHaveAttribute("data-voice", "listening");
    expect(answers.find((a) => a.name === "flagged")).toEqual({ name: "flagged", status: 200, type: expect.stringMatching(/^audio\/mpeg/) });
    // Said again, and again: three at most in one cook, every command still sounded.
    await say(page, "Sue, flag");
    await say(page, "Sue, flag");
    await say(page, "Sue, flag");
    expect(await clips(page)).toEqual(["flagged", "flagged", "flagged"]);
    expect(await notes(page)).toEqual([...UNDERSTOOD, ...UNDERSTOOD, ...UNDERSTOOD, ...UNDERSTOOD]);
  });

  test("VOICE-7: a timer said reads its length back from a clip", async ({ page }) => {
    await page.addInitScript(() => {
      localStorage.setItem("sous-sue-replies", "voice");
      Math.random = () => 0.9;
    });
    await toFirstStep(page);
    await tapPage(page);
    await expect.poll(() => page.evaluate(() => window.__ack.decoded)).toBe(CLIP_NAMES.length);
    await say(page, "Sue, set a timer for ten minutes");
    await expect.poll(() => clips(page)).toEqual(["read-10-minutes"]);
  });
});

test.describe("Sue's replies on Android, where a tap starts each listen", () => {
  test.use({
    userAgent:
      "Mozilla/5.0 (Linux; Android 16; Pixel Tablet) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/140.0.0.0 Safari/537.36",
  });

  test("VOICE-8: the tap unlocks the sound, the whole command heard sounds understood, and the dot isn't held", async ({ page }) => {
    await page.addInitScript(installFakeSpeech);
    await page.addInitScript(watchAudio);
    const row = await readQueueRowByName(RECIPE_NAMES.thinWhiteSauce);
    await page.goto(`/kitchen/queue/${row!.id}`);
    await page.locator("[data-opening-start]").click();
    await page.getByRole("button", { name: "Next step" }).click();
    await expect(dot(page)).toHaveAttribute("data-voice", "ready");
    await dot(page).click();
    await expect(dot(page)).toHaveAttribute("data-voice", "hearing");
    await say(page, "next", false);
    await expect.poll(() => notes(page)).toEqual(UNDERSTOOD);
    await say(page, "next");
    await expect(dot(page)).toHaveAttribute("data-voice", "ready");
    expect(await notes(page)).toEqual(UNDERSTOOD);
  });
});
