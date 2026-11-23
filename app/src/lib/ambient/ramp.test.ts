import { afterEach, describe, expect, it } from "vitest";
import { calculateAmbientProgress, ambientProgressAt } from "./ramp";

describe("calculateAmbientProgress", () => {
  const sunset = new Date("2026-09-20T22:56:00.000Z"); // 6:56 PM EDT

  it("is 0 (full daytime) before 30 minutes prior to sunset", () => {
    // 45 minutes before sunset
    const now = new Date(sunset.getTime() - 45 * 60 * 1000);
    expect(calculateAmbientProgress(now, sunset, "America/New_York")).toBe(0);

    // exactly 30 minutes before sunset
    const start = new Date(sunset.getTime() - 30 * 60 * 1000);
    expect(calculateAmbientProgress(start, sunset, "America/New_York")).toBe(0);
  });

  it("eases linearly from 0 to 1 over the 90-minute sunset window", () => {
    // 15 minutes before sunset (15 min into 90 min window = 1/6)
    const t15mBefore = new Date(sunset.getTime() - 15 * 60 * 1000);
    expect(calculateAmbientProgress(t15mBefore, sunset, "America/New_York")).toBeCloseTo(15 / 90, 3);

    // Exactly at sunset (30 min into 90 min window = 1/3)
    expect(calculateAmbientProgress(sunset, sunset, "America/New_York")).toBeCloseTo(30 / 90, 3);

    // 15 minutes after sunset (45 min into 90 min window = 0.5)
    const t15mAfter = new Date(sunset.getTime() + 15 * 60 * 1000);
    expect(calculateAmbientProgress(t15mAfter, sunset, "America/New_York")).toBeCloseTo(0.5, 3);

    // 60 minutes after sunset (90 min into 90 min window = 1.0)
    const end = new Date(sunset.getTime() + 60 * 60 * 1000);
    expect(calculateAmbientProgress(end, sunset, "America/New_York")).toBe(1.0);
  });

  it("holds at 1.0 (night stop) after 60 minutes past sunset", () => {
    // 2 hours after sunset
    const lateNight = new Date(sunset.getTime() + 120 * 60 * 1000);
    expect(calculateAmbientProgress(lateNight, sunset, "America/New_York")).toBe(1.0);
  });

  describe("the morning window is the household's 6 to 7 am", () => {
    const originalTz = process.env.TZ;
    afterEach(() => {
      if (originalTz === undefined) delete process.env.TZ;
      else process.env.TZ = originalTz;
    });
    const NY = "America/New_York";
    const sunsetOfTheDay = new Date("2026-09-20T22:56:00.000Z");

    for (const tz of ["America/New_York", "UTC", "Asia/Tokyo"]) {
      it(`6:30 am in New York is half way to day on a ${tz} tablet`, () => {
        process.env.TZ = tz;
        const sixThirty = new Date("2026-09-20T10:30:00.000Z");
        expect(calculateAmbientProgress(sixThirty, sunsetOfTheDay, NY)).toBeCloseTo(0.5, 2);
      });
      it(`3 am in New York is night on a ${tz} tablet`, () => {
        process.env.TZ = tz;
        expect(calculateAmbientProgress(new Date("2026-09-20T07:00:00.000Z"), sunsetOfTheDay, NY)).toBe(1);
      });
      it(`10 pm in New York is night, not the next day's morning, on a ${tz} tablet`, () => {
        process.env.TZ = tz;
        const now = new Date("2026-09-21T02:00:00.000Z");
        expect(ambientProgressAt(now, { lat: 40.7, lng: -74, tz: NY })).toBe(1);
      });
    }
  });
});
