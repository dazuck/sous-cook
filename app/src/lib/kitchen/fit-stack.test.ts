import { describe, expect, it } from "vitest";
import { FIT_UP, STEP_FIT_SCALES } from "./fit-scales";
import { fitStack, pageStarts, stepWords, type StackMeasure } from "./fit-stack";

const FLOOR = STEP_FIT_SCALES[STEP_FIT_SCALES.length - 1];

/**
 * A stand-in for the browser: every word is 10 px wide in a 100 px column at
 * full size (so 10 to a line, 12 at 0.8 rounds down), a line is 50 px tall at
 * full size, the cue a 30 px line and the meta a 40 px block.
 */
function measure(words: string[], over: Partial<StackMeasure> = {}): StackMeasure {
  return {
    room: 600,
    top: 100,
    words,
    pairs: 0,
    part: 0,
    now: (scale, from, to, last) => {
      const perLine = Math.floor(10 / scale);
      const lines = Math.ceil((to - from) / perLine);
      return lines * 50 * scale + (last ? 40 : 30);
    },
    ...over,
  };
}

const words = (n: number, end: (i: number) => boolean = () => false) =>
  Array.from({ length: n }, (_, i) => (end(i) ? `w${i}.` : `w${i}`));

describe("stepWords", () => {
  it("splits at spaces, keeping a number bound to its unit", () => {
    expect(stepWords("Add 2 cups water. Stir")).toEqual(["Add", "2 cups", "water.", "Stir"]);
  });
});

describe("pageStarts", () => {
  const fitsUpTo = (max: number) => (from: number, to: number, last: boolean) =>
    to - from <= (last ? max + 1 : max);
  const pages = (w: string[], fits: (from: number, to: number, last: boolean) => boolean) =>
    pageStarts(w, 0, fits);

  it("keeps a step that fits as one part", () => {
    expect(pages(words(5), fitsUpTo(5))).toEqual([0]);
  });

  it("cuts at the last sentence end that fits", () => {
    // Sentences end after words 2 and 5; 7 words fit before the cue.
    const w = words(12, (i) => i === 2 || i === 5);
    expect(pages(w, fitsUpTo(7))).toEqual([0, 6]);
  });

  it("cuts at the last word that fits when no sentence ends inside it", () => {
    expect(pages(words(20), fitsUpTo(7))).toEqual([0, 7, 14]);
  });

  it("reads ?, ! and a closing quote or bracket as a sentence end", () => {
    for (const end of ["done?", "now!", 'it."', "this.)", "so…"]) {
      const w = ["a", end, "b", "c", "d", "e"];
      expect(pages(w, fitsUpTo(3))).toEqual([0, 2]);
    }
  });

  it("leaves at least one word for the last part", () => {
    // Everything fits before the cue, but not after it with the meta.
    const w = words(4);
    expect(pages(w, (from, to, last) => (last ? to - from <= 2 : true))).toEqual([0, 3]);
  });

  it("moves on by a word at least when not one fits", () => {
    expect(pages(words(3), () => false)).toEqual([0, 1, 2]);
  });

  // The meta's pairs page after the words, one unit each: a part of 3 units.
  const units = (from: number, to: number) => to - from <= 3;

  it("pages the meta's pairs after the words when the last part can't hold them", () => {
    // 4 words and 3 pairs, 7 units: the words to 3, then a word and 2 pairs,
    // then the last pair.
    expect(pageStarts(words(4), 3, units)).toEqual([0, 3, 6]);
  });

  it("breaks between any two pairs, not back at the words' last sentence", () => {
    // "w0." ends a sentence, but a part of 4 fills on into the pairs.
    expect(pageStarts(words(3, (i) => i === 0), 3, (from, to) => to - from <= 4)).toEqual([0, 4]);
  });
});

describe("fitStack: the ladder", () => {
  it("steps now up through FIT_UP when full size fits: 1.2, else 1.1", () => {
    // 20 words: at 1.2, 8 per line, 3 lines (180) + 40 = 220 + 100 = 320 <= 600.
    expect(fitStack(measure(words(20)))).toEqual({
      scale: FIT_UP[0],
      nudge: false,
      pages: null,
      part: 0,
    });
    // At room 310: 1.2 needs 320 (exceeds 310); 1.1 needs 305 <= 310.
    expect(fitStack(measure(words(20), { room: 310 }))).toEqual({
      scale: FIT_UP[1],
      nudge: false,
      pages: null,
      part: 0,
    });
  });

  it("keeps full size (1) when 1.1 does not fit", () => {
    // At room 280: 1.1 needs 305 > 280; scale 1 needs 100 + 140 = 240 <= 280.
    expect(fitStack(measure(words(20), { room: 280 }))).toEqual({
      scale: 1,
      nudge: false,
      pages: null,
      part: 0,
    });
  });

  it("steps now down to 0.9 when scale 1 does not fit", () => {
    // 60 words: scale 1 needs 100 + 340 = 440; room 420.
    // Scale 0.9 needs 100 + 310 = 410 <= 420.
    expect(fitStack(measure(words(60), { room: 420 }))).toEqual({
      scale: 0.9,
      nudge: false,
      pages: null,
      part: 0,
    });
  });

  it("steps now down through 0.8, 0.7, 0.6, and 0.5 (FLOOR) so long steps stay whole", () => {
    // 60 words:
    // - 0.8 (12/line, 5 lines): 100 + 200 + 40 = 340
    // - 0.7 (14/line, 5 lines): 100 + 175 + 40 = 315
    // - 0.6 (16/line, 4 lines): 100 + 120 + 40 = 260
    // - 0.5 (20/line, 3 lines): 100 + 75 + 40 = 215
    expect(fitStack(measure(words(60), { room: 380 }))).toEqual({
      scale: 0.8,
      nudge: false,
      pages: null,
      part: 0,
    });
    expect(fitStack(measure(words(60), { room: 320 }))).toEqual({
      scale: 0.7,
      nudge: false,
      pages: null,
      part: 0,
    });
    expect(fitStack(measure(words(60), { room: 280 }))).toEqual({
      scale: 0.6,
      nudge: false,
      pages: null,
      part: 0,
    });
    expect(fitStack(measure(words(60), { room: 230 }))).toEqual({
      scale: 0.5,
      nudge: false,
      pages: null,
      part: 0,
    });
  });

  it("keeps the step whole at FLOOR (0.5, pages: null) when even 0.5 overflows, so the stage scrolls instead of paging", () => {
    // 100 words at 0.5 (20/line, 5 lines): 100 + 125 + 40 = 265 > 200.
    const fit = fitStack(measure(words(100), { room: 200 }));
    expect(fit).toEqual({
      scale: FLOOR,
      nudge: false,
      pages: null,
      part: 0,
    });
  });

  it("is always on part 0 (pages: null)", () => {
    expect(fitStack(measure(words(100), { room: 200, part: 9 })).part).toBe(0);
    expect(fitStack(measure(words(20), { part: 3 })).part).toBe(0);
  });

  it("lets one word too tall for the stage overflow at FLOOR rather than loop", () => {
    expect(fitStack(measure(["w"], { room: 120 }))).toEqual({
      scale: FLOOR,
      nudge: false,
      pages: null,
      part: 0,
    });
  });

  describe("nudge reserve", () => {
    it("shows nudge when it fits without dropping scale", () => {
      // 20 words, room 600: at 1.2 needs 320; with 50 reserve = 370 <= 600.
      expect(fitStack(measure(words(20), { nudgeReserve: 50 }))).toEqual({
        scale: FIT_UP[0],
        nudge: true,
        pages: null,
        part: 0,
      });
    });

    it("the climb past full size gives way to the nudge: it shows at the step's own size", () => {
      // 20 words, room 330: without the nudge the step would climb to 1.2 (320).
      // With its 50 reserved, 1 fits (240 + 50 = 290): full size is the size
      // the ladder gives without it, so the nudge shows and the climb gives way.
      expect(fitStack(measure(words(20), { room: 330, nudgeReserve: 50 }))).toEqual({
        scale: 1,
        nudge: true,
        pages: null,
        part: 0,
      });
    });

    it("shows nudge at scale 1 when it fits at scale 1 with reserve", () => {
      // 20 words, room 290: 1.1 needs 305 > 290, so scale without reserve is 1 (needs 240).
      // With reserve 40: 240 + 40 = 280 <= 290. Nudge fits.
      expect(fitStack(measure(words(20), { room: 290, nudgeReserve: 40 }))).toEqual({
        scale: 1,
        nudge: true,
        pages: null,
        part: 0,
      });
    });

    it("drops nudge at scale 1 if reserve would drop it to 0.9", () => {
      // 20 words, room 260: scale without reserve is 1 (needs 240 <= 260).
      // With reserve 40: 240 + 40 = 280 > 260. Nudge is dropped; scale stays 1.
      expect(fitStack(measure(words(20), { room: 260, nudgeReserve: 40 }))).toEqual({
        scale: 1,
        nudge: false,
        pages: null,
        part: 0,
      });
    });

    describe("standing in the stack's foot (DECISIONS 2026-11-24)", () => {
      // The nudge is drawn over the stage's bottom edge; the stack's foot under the step's last row
      // is room it can stand in, as far as `nudgeFoot` says (the foot less the gap it keeps from the row).
      it("keeps the nudge the reserve alone would drop, at the step's own size, and says how much foot it took", () => {
        // 20 words, room 260: scale 1 needs 240. With 40 reserved, 280 > 260: dropped before.
        // With 25 of the foot to stand in, it needs 15 more: 255 <= 260.
        expect(fitStack(measure(words(20), { room: 260, nudgeReserve: 40, nudgeFoot: 25 }))).toEqual({
          scale: 1,
          nudge: true,
          pages: null,
          part: 0,
          footUsed: 20,
        });
      });

      it("never moves a step that kept its nudge without the foot: same size, no foot taken", () => {
        // Room 330: the nudge already shows at 1 (240 + 50 = 290). With the foot it could climb to
        // 1.1 (305 + 50 - 25 = 330), but a step that showed its nudge stays as it was.
        for (const room of [330, 600, 290]) {
          const before = fitStack(measure(words(20), { room, nudgeReserve: 50 }));
          expect(fitStack(measure(words(20), { room, nudgeReserve: 50, nudgeFoot: 25 }))).toEqual(before);
        }
      });

      it("drops the nudge still where the foot is not enough, and never drops the step's size for it", () => {
        // Room 260, 40 reserved, 15 of foot: 240 + 25 = 265 > 260. Not at 0.9 either: the size stays.
        expect(fitStack(measure(words(20), { room: 260, nudgeReserve: 40, nudgeFoot: 15 }))).toEqual({
          scale: 1,
          nudge: false,
          pages: null,
          part: 0,
        });
      });

      it("takes no foot below 0.8, where the foot is already the tight one", () => {
        // 60 words at room 270: 0.6 fits (260) but not with 40 reserved, even less 30 of foot (270).
        expect(fitStack(measure(words(60), { room: 270, nudgeReserve: 40, nudgeFoot: 30 }))).toMatchObject({ scale: 0.6, nudge: false });
      });
    });

    it("drops nudge when step overflows FLOOR", () => {
      expect(fitStack(measure(words(100), { room: 200, nudgeReserve: 40 }))).toMatchObject({
        scale: FLOOR,
        nudge: false,
      });
    });
  });

  describe("dal at 1280x800", () => {
    it("climbs to 1.1 or 1.2 because now stands alone without glances", () => {
      // Counter stage at 1280x800 has ~580 px height room for the stack.
      // Dal's simmer step has ~22 words. Without glances, it has plenty of room.
      const dalSimmer = measure(
        words(22),
        {
          room: 580,
          top: 16,
          now: (scale) => Math.round(180 * scale + 45),
        },
      );
      const fit = fitStack(dalSimmer);
      expect(fit.scale).toBeGreaterThanOrEqual(1.1);
      expect([1.1, 1.2]).toContain(fit.scale);
    });
  });
});
