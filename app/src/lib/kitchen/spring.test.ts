import { describe, expect, it } from "vitest";
import {
  EASE_POINTS,
  SPRING_W,
  ease,
  glideMs,
  settled,
  springAt,
} from "./spring";

describe("spring", () => {
  it("springAt never passes the target from any (x0, v0)", () => {
    const target = 200;

    // Positive displacement (above target):
    // 1. Moving away from target (positive v0)
    for (let t = 0; t <= 1.5; t += 0.02) {
      expect(springAt(target, 100, 500, t)).toBeGreaterThanOrEqual(target);
    }
    // 2. Moving toward target fast (negative v0) - clamps at target, never overshoots
    for (let t = 0; t <= 1.5; t += 0.02) {
      expect(springAt(target, 100, -2000, t)).toBeGreaterThanOrEqual(target);
    }
    // 3. At rest
    for (let t = 0; t <= 1.5; t += 0.02) {
      expect(springAt(target, 100, 0, t)).toBeGreaterThanOrEqual(target);
    }

    // Negative displacement (below target):
    // 1. Moving away from target (negative v0)
    for (let t = 0; t <= 1.5; t += 0.02) {
      expect(springAt(target, -100, -500, t)).toBeLessThanOrEqual(target);
    }
    // 2. Moving toward target fast (positive v0) - clamps at target, never overshoots
    for (let t = 0; t <= 1.5; t += 0.02) {
      expect(springAt(target, -100, 2000, t)).toBeLessThanOrEqual(target);
    }
    // 3. At rest
    for (let t = 0; t <= 1.5; t += 0.02) {
      expect(springAt(target, -100, 0, t)).toBeLessThanOrEqual(target);
    }
  });

  it("settles smoothly from 600 px at rest (under 1.5 px at 520 ms and under 0.4 px by 630 ms)", () => {
    const target = 0;
    const x0 = 600;
    expect(SPRING_W).toBe(16);
    const at520 = springAt(target, x0, 0, 0.52);
    expect(Math.abs(at520 - target)).toBeLessThan(1.5);
    const at630 = springAt(target, x0, 0, 0.63);
    expect(Math.abs(at630 - target)).toBeLessThan(0.4);

    // If angular frequency is tuned to 19 rad/s, it settles under 0.4 px by 520 ms
    const at520Tuned = springAt(target, x0, 0, 0.52, 19);
    expect(Math.abs(at520Tuned - target)).toBeLessThan(0.4);
  });

  it("settled returns true under 0.4 px after 80 ms, or after 1.2 s", () => {
    expect(settled(0.35, 0.1)).toBe(true);
    expect(settled(0.35, 0.05)).toBe(false);
    expect(settled(1.5, 0.52)).toBe(false);
    expect(settled(1.5, 1.21)).toBe(true);
  });

  it("glideMs(from, to) is 400 for one level and 520 for more, Esc included", () => {
    // 1 level: 400 ms
    expect(glideMs(0, 1)).toBe(400);
    expect(glideMs(1, 0)).toBe(400);
    expect(glideMs(1, 2)).toBe(400);
    expect(glideMs(2, 1)).toBe(400);
    expect(glideMs(2, 3)).toBe(400);
    expect(glideMs(3, 2)).toBe(400);

    // More than 1 level: 520 ms
    expect(glideMs(0, 2)).toBe(520);
    expect(glideMs(0, 3)).toBe(520);
    expect(glideMs(2, 0)).toBe(520);
    expect(glideMs(3, 0)).toBe(520); // Esc from Whole recipe to Now
  });

  it("the easing's control points match DS §3 (0.32, 0.72, 0, 1)", () => {
    expect(EASE_POINTS).toEqual([0.32, 0.72, 0, 1]);
    expect(ease(0)).toBe(0);
    expect(ease(1)).toBe(1);
    expect(ease(0.5)).toBeCloseTo(0.95, 1);
  });
});
