import { existsSync, readdirSync, readFileSync, statSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { CLIP_NAMES, CLIP_TEXT, READ_BACKS, YES_CHEF_TAKES, clipUrl, readBackClip } from "./ack-clips";

const DIR = join(__dirname, "../../../public/sounds/sue");
const RECORD = join(__dirname, "../../../scripts/data/sue-clips.json");

// The repository ships without the clips and without the generator's record
// (docs/voice-replies.md), so as shipped there is nothing on disk to check and
// the two checks of the files themselves don't run. Once clips are made, by
// the generator or by hand, they hold for every one there.
const clipsHere = existsSync(DIR)
  ? readdirSync(DIR)
      .filter((f) => f.endsWith(".mp3"))
      .map((f) => f.replace(/\.mp3$/, ""))
  : [];

describe("Sue's clips on disk", () => {
  it("every clip the player asks for has its words and one path of its own", () => {
    // Seventeen, as docs/voice-replies.md says: three takes of "Yes, chef.", three confirmations, eleven read-backs.
    expect(CLIP_NAMES).toHaveLength(17);
    for (const name of CLIP_NAMES) {
      expect(CLIP_TEXT[name], name).toMatch(/\S/);
      expect(clipUrl(name)).toBe(`/sounds/sue/${name}.mp3`);
    }
    expect(new Set(CLIP_NAMES.map(clipUrl)).size).toBe(CLIP_NAMES.length);
  });

  it.runIf(clipsHere.length > 0)(
    "every clip there is one the player asks for, a real MP3 of a size a short clip has",
    () => {
      for (const name of clipsHere) {
        expect(CLIP_NAMES, name).toContain(name);
        const path = join(DIR, `${name}.mp3`);
        const bytes = readFileSync(path);
        // An MP3 starts with an ID3 tag or a frame sync (0xFF 0xE0+).
        const head = bytes.subarray(0, 3).toString("latin1");
        expect(head === "ID3" || (bytes[0] === 0xff && (bytes[1] & 0xe0) === 0xe0), name).toBe(true);
        expect(statSync(path).size, name).toBeGreaterThan(1500);
        expect(statSync(path).size, name).toBeLessThan(30_000);
      }
    },
  );

  it.runIf(existsSync(RECORD))(
    "the generator's record says the same: one voice, one style, each clip it made there and measured",
    () => {
      const record = JSON.parse(readFileSync(RECORD, "utf8")) as {
        voice: string;
        style: string;
        clips: { name: string; text: string; seconds: number; bytes: number }[];
      };
      expect(record.voice).toBeTruthy();
      expect(record.style).toBeTruthy();
      for (const clip of record.clips) {
        expect(CLIP_NAMES, clip.name).toContain(clip.name);
        expect(clip.text).toBe(CLIP_TEXT[clip.name]);
        expect(statSync(join(DIR, `${clip.name}.mp3`)).size).toBe(clip.bytes);
      }
    },
  );
});

describe("the read-backs", () => {
  it("name a clip for each whole common length, and none for any other", () => {
    expect(readBackClip(600)).toBe("read-10-minutes");
    expect(readBackClip(3600)).toBe("read-1-hour");
    expect(readBackClip(90)).toBeNull();
    expect(readBackClip(420)).toBeNull();
    expect(readBackClip(7200)).toBeNull();
  });

  it("say the length in words that match the length", () => {
    const words: Record<string, number> = { One: 1, Two: 2, Three: 3, Five: 5, Ten: 10, Fifteen: 15, Twenty: 20, "Twenty five": 25, Thirty: 30, "Forty five": 45 };
    for (const [seconds, { text }] of Object.entries(READ_BACKS)) {
      const n = Number(seconds);
      const [, count, unit] = /^(.*?) (minutes?|hour)\.$/.exec(text) ?? [];
      expect(unit, text).toBeTruthy();
      const minutes = unit === "hour" ? 60 * (words[count] ?? 0) : (words[count] ?? 0);
      expect(minutes * 60, text).toBe(n);
    }
  });

  it("keep three takes of Yes, chef.", () => {
    expect(YES_CHEF_TAKES).toHaveLength(3);
    for (const take of YES_CHEF_TAKES) expect(CLIP_TEXT[take]).toBe("Yes, chef.");
  });
});
