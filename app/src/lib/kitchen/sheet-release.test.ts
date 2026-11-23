import { describe, expect, it } from "vitest";
import {
  DEEPEST,
  SHEET_CONSTANTS,
  classify,
  pointerZone,
  reducedRelease,
  releaseLevel,
  velocity,
  type SheetGeometry,
} from "./sheet-release";

describe("sheet-release", () => {
  const geo: SheetGeometry = {
    width: 1280,
    height: 800,
    stageTop: 100,
    bandTop: 620,
    bandBottom: 700,
    footTop: 700,
  };

  describe("constants", () => {
    it("exports the prototype constants table", () => {
      expect(SHEET_CONSTANTS.FLICK).toBe(0.5);
      expect(SHEET_CONSTANTS.FLICK_FAR).toBe(1.2);
      expect(SHEET_CONSTANTS.PROJECT_MS).toBe(180);
      expect(SHEET_CONSTANTS.PUSH).toBe(0.3);
      expect(SHEET_CONSTANTS.SLOP_PULL).toBe(10);
      expect(SHEET_CONSTANTS.SLOP_SWIPE).toBe(14);
      expect(SHEET_CONSTANTS.DEAD_SIDE).toBe(48);
      expect(SHEET_CONSTANTS.DEAD_FOOT).toBe(24);
      expect(SHEET_CONSTANTS.SPRING_W).toBe(16);
      expect(SHEET_CONSTANTS.GATE_MS).toBe(140);
    });
  });

  describe("pointerZone and dead zones", () => {
    it("respects dead zones: side 48 px and bottom 24 px", () => {
      // Left dead zone (x < 48)
      expect(pointerZone(20, 650, geo, 0)).toBe("none");
      // Right dead zone (x > 1280 - 48 = 1232)
      expect(pointerZone(1250, 650, geo, 0)).toBe("none");
      // Bottom dead zone (y > 800 - 24 = 776)
      expect(pointerZone(500, 780, geo, 0)).toBe("none");
      // Valid zone outside dead zones
      expect(pointerZone(100, 650, geo, 0)).toBe("band");
    });

    it("identifies zones per level", () => {
      // At Now (level 0): band or foot
      expect(pointerZone(200, 650, geo, 0)).toBe("band");
      expect(pointerZone(200, 720, geo, 0)).toBe("foot");
      expect(pointerZone(200, 300, geo, 0)).toBe("stage");

      // At pinned level 1 or 2: sheet (below band), band, foot, stage
      expect(pointerZone(200, 650, geo, 1)).toBe("band");
      expect(pointerZone(200, 300, geo, 1)).toBe("stage");

      // At Whole recipe (level 3): none (column scrolls, ledge is button)
      expect(pointerZone(200, 650, geo, 3)).toBe("none");
      expect(pointerZone(200, 300, geo, 3)).toBe("none");
    });
  });

  describe("classify", () => {
    it("classifies tap at slop edges (|dx| <= 10 and |dy| <= 10)", () => {
      expect(classify(0, 0, "band", 0)).toBe("tap");
      expect(classify(5, -6, "band", 0)).toBe("tap");
      expect(classify(10, 10, "stage", 1)).toBe("tap");
    });

    it("classifies pull (|dy| > 10 and |dy| > 1.2 * |dx|) on pullable zones", () => {
      // Band at Now
      expect(classify(5, -15, "band", 0)).toBe("pull");
      // Foot at Now
      expect(classify(-8, -20, "foot", 0)).toBe("pull");
      // Pinned stage
      expect(classify(10, -25, "stage", 1)).toBe("pull");
      // Ratio not met: dy = 12, dx = 11 (12 <= 1.2 * 11 = 13.2) -> drift
      expect(classify(11, -12, "band", 0)).toBe("drift");
      // Stage at Now is not pullable
      expect(classify(5, -20, "stage", 0)).toBe("drift");
    });

    it("classifies swipe (|dx| > 14 and |dx| > 1.5 * |dy|) on stage", () => {
      // On stage:
      expect(classify(25, 5, "stage", 0)).toBe("swipe");
      expect(classify(-30, -10, "stage", 1)).toBe("swipe");
      // Ratio not met: dx = 20, dy = 15 (20 <= 1.5 * 15 = 22.5) -> drift
      expect(classify(20, 15, "stage", 0)).toBe("drift");
      // Sideways on band is drift (never swipe)
      expect(classify(50, 0, "band", 0)).toBe("drift");
    });

    it("returns none for zone 'none'", () => {
      expect(classify(0, -30, "none", 0)).toBe("none");
    });
  });

  describe("velocity", () => {
    it("returns 0 with 0 or 1 sample", () => {
      expect(velocity([])).toBe(0);
      expect(velocity([[100, 200]])).toBe(0);
    });

    it("returns 0 with equal timestamps", () => {
      expect(velocity([[100, 200], [100, 300]])).toBe(0);
    });

    it("computes px/ms over first and last of up to 8 samples", () => {
      // Moving up 100 px over 200 ms: dy = -100, dt = 200 -> v = -0.5 px/ms
      const samples: Array<[number, number]> = [
        [0, 500],
        [50, 480],
        [100, 450],
        [150, 420],
        [200, 400],
      ];
      expect(velocity(samples)).toBeCloseTo(-0.5, 3);
    });

    it("uses last 8 samples when more than 8 are given", () => {
      const samples: Array<[number, number]> = [];
      for (let i = 0; i < 15; i++) {
        samples.push([i * 20, 500 - i * 10]); // dy = -10 per 20 ms -> -0.5 px/ms
      }
      expect(velocity(samples)).toBeCloseTo(-0.5, 3);
    });
  });

  describe("releaseLevel", () => {
    const detents = [600, 300, 0] as const;

    it("-0.49 springs back, -0.5 pins one", () => {
      // Slower than FLICK (e.g. -0.49) springs back to pinned
      expect(
        releaseLevel({
          pinnedLevel: 0,
          currentDepth: 0.4,
          velocity: -0.49,
        }),
      ).toBe(0);

      // At or past FLICK (v = -0.5) pins one level
      expect(
        releaseLevel({
          pinnedLevel: 0,
          currentDepth: 0.4,
          velocity: -0.5,
        }),
      ).toBe(1);
    });

    it("-1.3 at depth 1.6 projects to further level", () => {
      const k = releaseLevel({
        pinnedLevel: 0,
        currentDepth: 1.6,
        currentY: 280,
        velocity: -1.3,
        detents,
      });
      // 1.6 is already half a level past level 1 (one + 0.5 = 1.5).
      // Projected Y = 280 - 1.3 * 180 = 46 px, closest to the chart (0 px).
      expect(k).toBe(2);
    });

    it("+0.3 or 8 px down from pinned goes to 0", () => {
      // Downward velocity >= PUSH (+0.3)
      expect(
        releaseLevel({
          pinnedLevel: 1,
          currentDepth: 1.0,
          velocity: 0.3,
        }),
      ).toBe(0);

      // Downward displacement > 8 px even at rest
      expect(
        releaseLevel({
          pinnedLevel: 2,
          currentDepth: 1.9,
          velocity: 0.05,
          netYDown: 9,
        }),
      ).toBe(0);
    });

    it("a cancel mid-pull returns the level held before the pull from any depth and velocity", () => {
      expect(
        releaseLevel({
          pinnedLevel: 1,
          currentDepth: 2.8,
          velocity: -2.5,
          cancelled: true,
        }),
      ).toBe(1);

      expect(
        releaseLevel({
          pinnedLevel: 0,
          currentDepth: 1.9,
          velocity: -1.8,
          cancelled: true,
        }),
      ).toBe(0);
    });

    it("clamps pinned level to 1..2 on upward flick: no pull reaches Whole recipe", () => {
      expect(
        releaseLevel({
          pinnedLevel: 2,
          currentDepth: 2.8,
          velocity: -2.0,
        }),
      ).toBe(DEEPEST);
      expect(
        releaseLevel({
          pinnedLevel: 1,
          currentDepth: 2.4,
          currentY: 40,
          velocity: -2.5,
          detents,
        }),
      ).toBe(2);
    });
  });

  describe("reducedRelease", () => {
    it("pull up past slop goes 1 level deeper (2 with FLICK_FAR)", () => {
      // 1 level deeper
      expect(reducedRelease(0, -15, -0.6)).toBe(1);
      expect(reducedRelease(1, -20, -0.8)).toBe(2);

      // 2 levels deeper with FLICK_FAR (v <= -1.2)
      expect(reducedRelease(0, -30, -1.3)).toBe(2);
      expect(reducedRelease(1, -30, -1.5)).toBe(2);
      expect(reducedRelease(2, -30, -1.5)).toBe(2);
    });

    it("push down goes to Now (0)", () => {
      expect(reducedRelease(1, 10, 0)).toBe(0);
      expect(reducedRelease(2, 5, 0.35)).toBe(0);
    });

    it("movement within slop keeps pinned level", () => {
      expect(reducedRelease(1, -5, -0.2)).toBe(1);
    });
  });
});
