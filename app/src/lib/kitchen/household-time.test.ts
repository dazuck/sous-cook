import { describe, expect, it } from "vitest";
import { clockText, eyebrowAt, wallClock } from "./household-time";

const NY = "America/New_York";
// 2026-10-10 is in daylight time: New York is UTC-4.
const at = (hh: number, mm: number) => new Date(Date.UTC(2026, 9, 10, hh + 4, mm));

describe("the eyebrow (F2)", () => {
  it("says Up next before 2 pm and Tonight from 2 pm, to the minute", () => {
    expect(eyebrowAt(at(13, 59), NY)).toBe("Up next");
    expect(eyebrowAt(at(14, 0), NY)).toBe("Tonight");
    expect(eyebrowAt(at(23, 59), NY)).toBe("Tonight");
  });

  it("says Up next just after midnight", () => {
    expect(eyebrowAt(at(0, 0), NY)).toBe("Up next");
  });

  it("follows the household's zone, not the device's", () => {
    // The same instant: 18:12 in New York is 15:12 in Los Angeles and 23:12 in London.
    const instant = at(18, 12);
    expect(eyebrowAt(instant, "America/Los_Angeles")).toBe("Tonight");
    // 10:00 in New York is 07:00 in Los Angeles: Up next in both; and 14:30 New York is
    // 11:30 in Los Angeles, where it is still Up next.
    expect(eyebrowAt(at(14, 30), NY)).toBe("Tonight");
    expect(eyebrowAt(at(14, 30), "America/Los_Angeles")).toBe("Up next");
  });
});

describe("the clock text", () => {
  it("reads as a wall clock", () => {
    expect(clockText(at(18, 12), NY)).toBe("6:12 pm");
    expect(clockText(at(0, 5), NY)).toBe("12:05 am");
    expect(clockText(at(12, 0), NY)).toBe("12:00 pm");
    expect(clockText(at(9, 3), NY)).toBe("9:03 am");
  });

  it("maps midnight to hour 0, not 24", () => {
    expect(wallClock(at(0, 0), NY)).toEqual({ hour: 0, minute: 0 });
  });
});
