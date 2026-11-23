import { afterEach, describe, expect, it } from "vitest";
import { calculateSunset } from "./sunset";

const NY = "America/New_York";

describe("calculateSunset", () => {
  // A test kitchen in the zone, deliberately not the default place.
  const LAT = 40.7;
  const LNG = -74;

  it("calculates astronomical sunset in New York within 2 minutes of NOAA solar tables", () => {
    // Summer solstice: June 21, 2026. Sunset ~8:30 PM EDT
    const summer = calculateSunset(new Date("2026-06-21T18:00:00-04:00"), LAT, LNG, NY);
    // In UTC: 00:30 on June 22
    expect(summer.getUTCHours()).toBe(0);
    expect(summer.getUTCMinutes()).toBeGreaterThanOrEqual(28);
    expect(summer.getUTCMinutes()).toBeLessThanOrEqual(33);

    // Autumnal equinox: September 20, 2026. Sunset ~6:57 PM EDT
    const autumn = calculateSunset(new Date("2026-09-20T18:00:00-04:00"), LAT, LNG, NY);
    // In UTC: 22:56 on September 20
    expect(autumn.getUTCHours()).toBe(22);
    expect(autumn.getUTCMinutes()).toBeGreaterThanOrEqual(54);
    expect(autumn.getUTCMinutes()).toBeLessThanOrEqual(58);

    // Winter solstice: December 21, 2026. Sunset ~4:31 PM EST
    const winter = calculateSunset(new Date("2026-12-21T16:00:00-05:00"), LAT, LNG, NY);
    // In UTC: 21:31 on December 21
    expect(winter.getUTCHours()).toBe(21);
    expect(winter.getUTCMinutes()).toBeGreaterThanOrEqual(29);
    expect(winter.getUTCMinutes()).toBeLessThanOrEqual(33);
  });

  describe("the household's timezone, not the device's", () => {
    const originalTz = process.env.TZ;
    afterEach(() => {
      if (originalTz === undefined) delete process.env.TZ;
      else process.env.TZ = originalTz;
    });

    // 10 pm in New York on 2026-09-20 is already the 21st in UTC and in Tokyo.
    const tenPmNy = new Date("2026-09-21T02:00:00.000Z");
    const SEP_20_SUNSET_MS = Date.parse("2026-09-20T22:56:00.000Z");

    for (const tz of ["America/New_York", "UTC", "Asia/Tokyo", "Pacific/Auckland"]) {
      it(`a tablet set to ${tz} still gets the household's evening (Sep 20), not the next one`, () => {
        process.env.TZ = tz;
        const sunset = calculateSunset(tenPmNy, LAT, LNG, NY);
        expect(Math.abs(sunset.getTime() - SEP_20_SUNSET_MS)).toBeLessThan(3 * 60_000);
      });
    }

    it("is the same instant whatever the device's zone", () => {
      const answers = ["America/New_York", "UTC", "Asia/Tokyo"].map((tz) => {
        process.env.TZ = tz;
        return calculateSunset(new Date("2026-06-21T12:00:00.000Z"), LAT, LNG, NY).getTime();
      });
      expect(new Set(answers).size).toBe(1);
    });
  });
});
