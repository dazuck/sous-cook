import { describe, expect, it } from "vitest";
import { formatCircleDay } from "./circle-format";

describe("formatCircleDay", () => {
  const now = new Date(2026, 10, 28, 15, 30, 0); // Saturday, Nov 28, 2026

  it("formats today and yesterday", () => {
    expect(formatCircleDay("2026-11-28", now)).toBe("today");
    expect(formatCircleDay("2026-11-27", now)).toBe("yesterday");
  });

  it("formats 2 to 6 days ago as weekday name", () => {
    expect(formatCircleDay("2026-11-26", now)).toBe("Thursday");
    expect(formatCircleDay("2026-11-24", now)).toBe("Tuesday");
    expect(formatCircleDay("2026-11-22", now)).toBe("Sunday");
  });

  it("formats 7+ days ago as month and day (with year if different year)", () => {
    expect(formatCircleDay("2026-11-21", now)).toBe("Nov 21");
    expect(formatCircleDay("2026-11-20", now)).toBe("Nov 20");
    expect(formatCircleDay("2025-11-20", now)).toBe("Nov 20, 2025");
  });

  it("returns invalid or malformed strings unchanged", () => {
    expect(formatCircleDay("2026-02-30", now)).toBe("2026-02-30");
    expect(formatCircleDay("sometime", now)).toBe("sometime");
  });
});
