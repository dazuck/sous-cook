import { describe, expect, it } from "vitest";

import { saysOf } from "./says-of";

describe("saysOf", () => {
  it("is the same for two layouts that say the same, whichever object says it", () => {
    const place = () => ({ Y2: 12.5, opening: { chart: { x: 35, y: 200, w: 730, h: 400 }, ahead: null }, words: [{ x: 1, w: 16.9 }] });
    const a = place();
    const b = place();
    expect(a).not.toBe(b);
    expect(saysOf(a)).toBe(saysOf(b));
  });

  it("differs where one number moves (fonts arriving widen a word)", () => {
    const place = (w: number) => ({ words: [{ x: 1, w }] });
    expect(saysOf(place(16.99874496459961))).not.toBe(saysOf(place(20.401817321777344)));
  });

  it("reads a Map and a Set by what they hold, which plain JSON calls {} alike", () => {
    const withMap = (y: number) => ({ cy: new Map([[0, y]]) });
    expect(saysOf(withMap(10))).toBe(saysOf(withMap(10)));
    expect(saysOf(withMap(10))).not.toBe(saysOf(withMap(11)));
    const withSet = (n: number) => ({ named: new Set([n]) });
    expect(saysOf(withSet(1))).toBe(saysOf(withSet(1)));
    expect(saysOf(withSet(1))).not.toBe(saysOf(withSet(2)));
    // A Map is not mistaken for a plain object that holds the same.
    expect(saysOf({ cy: new Map() })).not.toBe(saysOf({ cy: {} }));
  });

  it("tells null from nothing drawn there", () => {
    expect(saysOf({ opening: null })).not.toBe(saysOf({ opening: {} }));
  });
});
