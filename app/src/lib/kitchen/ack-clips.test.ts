import { createHash } from "node:crypto";
import { mkdirSync, mkdtempSync, readdirSync, readFileSync, rmSync, statSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import { CLIP_NAMES, CLIP_TEXT, READ_BACKS, YES_CHEF_TAKES, clipUrl, readBackClip, sueClipsShipped } from "./ack-clips";
import { sueClipsInBuild } from "./ack-clips-build";

const DIR = join(__dirname, "../../../public/sounds/sue");
const RECORD = join(__dirname, "../../../scripts/data/sue-clips.json");

// The repository ships every clip and the generator's record of them
// (docs/voice-replies.md); these checks hold for the files as shipped.
const clipsHere = readdirSync(DIR)
  .filter((f) => f.endsWith(".mp3"))
  .map((f) => f.replace(/\.mp3$/, ""));

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

  it(
    "every clip the player asks for is there, and every clip there is one it asks for: a real MP3 of a size a short clip has",
    () => {
      expect([...clipsHere].sort()).toEqual([...CLIP_NAMES].sort());
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

  it(
    "the generator's record says the same: one voice, one style, each clip it made there, measured, its size and its hash",
    () => {
      const record = JSON.parse(readFileSync(RECORD, "utf8")) as {
        voice: string;
        style: string;
        clips: { name: string; text: string; seconds: number; bytes: number; sha256: string }[];
      };
      expect(record.voice).toBeTruthy();
      expect(record.style).toBeTruthy();
      expect(record.clips.map((c) => c.name).sort()).toEqual([...CLIP_NAMES].sort());
      for (const clip of record.clips) {
        expect(CLIP_NAMES, clip.name).toContain(clip.name);
        expect(clip.text).toBe(CLIP_TEXT[clip.name]);
        const bytes = readFileSync(join(DIR, `${clip.name}.mp3`));
        expect(bytes.length, clip.name).toBe(clip.bytes);
        expect(createHash("sha256").update(bytes).digest("hex"), clip.name).toBe(clip.sha256);
      }
      // What a run spent is printed, never kept in the record (generate-sue-clips.ts).
      expect(Object.keys(record).sort()).toEqual(["clips", "generatedAt", "limits", "model", "note", "style", "voice"]);
    },
  );
});

describe("whether a build has the clips", () => {
  const dirs: string[] = [];
  /** A build's public folder holding these clip files (empty files: only their presence counts). */
  function publicWith(names: readonly string[]): string {
    const dir = mkdtempSync(join(tmpdir(), "sue-clips-public-"));
    dirs.push(dir);
    mkdirSync(join(dir, "sounds", "sue"), { recursive: true });
    for (const name of names) writeFileSync(join(dir, "sounds", "sue", `${name}.mp3`), "");
    return dir;
  }
  afterEach(() => {
    for (const dir of dirs.splice(0)) rmSync(dir, { recursive: true, force: true });
    vi.unstubAllEnvs();
  });

  it("is yes only with every clip there: none, or all but one, is no", () => {
    expect(sueClipsInBuild(mkdtempSync(join(tmpdir(), "sue-clips-none-")))).toBe(false);
    expect(sueClipsInBuild(publicWith([]))).toBe(false);
    expect(sueClipsInBuild(publicWith(CLIP_NAMES.slice(1)))).toBe(false);
    expect(sueClipsInBuild(publicWith(CLIP_NAMES))).toBe(true);
  });

  it("is read in the app from what the build baked in, and is no when nothing was", () => {
    expect(sueClipsShipped()).toBe(false);
    vi.stubEnv("SOUS_SUE_CLIPS", "0");
    expect(sueClipsShipped()).toBe(false);
    vi.stubEnv("SOUS_SUE_CLIPS", "1");
    expect(sueClipsShipped()).toBe(true);
  });

  it("is what next.config.ts bakes in, from this app's own public folder", async () => {
    const { default: config } = await import("../../../next.config");
    // The repository ships every clip, so its own build offers Sounds and voice.
    expect(sueClipsInBuild(join(__dirname, "../../../public"))).toBe(true);
    expect(config.env?.SOUS_SUE_CLIPS).toBe("1");
  });
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
