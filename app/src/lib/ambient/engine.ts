/**
 * The ambient light maths (P67), in one self-contained function.
 *
 * It closes over nothing, so `String(ambientEngine)` is a complete program:
 * the root layout inlines it in a <head> script, which sets `--ambient-t`
 * before the first paint, and the client component calls the very same
 * function for every later tick. One body, so the first paint and the
 * minute-by-minute value cannot drift apart (engine.test.ts runs the inlined
 * text against the module).
 *
 * Everything is the household's: the civil date, the sunset and the morning
 * window are computed in the household's IANA timezone, never the device's.
 */
export function ambientEngine() {
  const RAD = Math.PI / 180;
  const DEG = 180 / Math.PI;
  const MIN = 60_000;

  interface Civil {
    year: number;
    month: number;
    day: number;
    hour: number;
    minute: number;
    second: number;
  }

  /** The wall-clock date and time `date` shows in `tz`. */
  function civilIn(date: Date, tz: string): Civil {
    const parts = new Intl.DateTimeFormat("en-US", {
      timeZone: tz,
      hourCycle: "h23",
      year: "numeric",
      month: "numeric",
      day: "numeric",
      hour: "numeric",
      minute: "numeric",
      second: "numeric",
    }).formatToParts(date);
    const get = (type: string) => Number(parts.find((p) => p.type === type)!.value);
    return {
      year: get("year"),
      month: get("month"),
      day: get("day"),
      hour: get("hour"),
      minute: get("minute"),
      second: get("second"),
    };
  }

  /**
   * Official sunset (zenith 90°50') on the household's civil day containing
   * `date`, by the NOAA solar algorithm.
   */
  function calculateSunset(date: Date, lat: number, lng: number, tz: string): Date {
    const { year, month, day } = civilIn(date, tz);

    const isLeap = (year % 4 === 0 && year % 100 !== 0) || year % 400 === 0;
    const N = Math.floor((275 * month) / 9) - Math.floor((month + 9) / 12) * (isLeap ? 1 : 2) + day - 30;

    const lngHour = lng / 15;
    const t = N + (18 - lngHour) / 24;
    const M = 0.9856 * t - 3.289;
    const L = (M + 1.916 * Math.sin(M * RAD) + 0.02 * Math.sin(2 * M * RAD) + 282.634 + 360) % 360;
    const RA = (DEG * Math.atan(0.91764 * Math.tan(L * RAD)) + 360) % 360;
    const raAdjusted = (RA + (Math.floor(L / 90) * 90 - Math.floor(RA / 90) * 90)) / 15;

    const sinDec = 0.39782 * Math.sin(L * RAD);
    const cosDec = Math.cos(Math.asin(sinDec));
    const cosH = (Math.cos(90.833 * RAD) - sinDec * Math.sin(lat * RAD)) / (cosDec * Math.cos(lat * RAD));

    // Solar noon of the civil day, as a UTC instant. Sunset falls within
    // about 12 h of it, which picks the right UTC day for the clock time.
    const solarNoon = Date.UTC(year, month - 1, day, 12) - lngHour * 3_600_000;
    if (cosH > 1) return new Date(solarNoon + 12 * 3_600_000 - 1000); // the sun never rises
    if (cosH < -1) return new Date(solarNoon); // the sun never sets

    const H = (DEG * Math.acos(cosH)) / 15;
    const UT = (H + raAdjusted - 0.06571 * t - 6.622 - lngHour + 24) % 24;
    let result = Date.UTC(year, month - 1, day) + Math.floor(UT * 3600) * 1000;
    if (result < solarNoon - 12 * 3_600_000) result += 24 * 3_600_000;
    else if (result > solarNoon + 12 * 3_600_000) result -= 24 * 3_600_000;
    return new Date(result);
  }

  /**
   * Progress t, 0 (day) to 1 (night stop), at `now` given the day's sunset:
   * rising linearly from 30 min before sunset to 60 min after it, holding
   * through the night, easing back to 0 between 6:00 and 7:00 household time.
   */
  function calculateAmbientProgress(now: Date, sunset: Date, tz: string): number {
    const nowMs = now.getTime();
    const startMs = sunset.getTime() - 30 * MIN;
    if (nowMs < startMs) {
      const { hour, minute, second } = civilIn(now, tz);
      if (hour < 6) return 1;
      if (hour === 6) return Math.max(0, Math.min(1, 1 - (minute * 60 + second) / 3600));
      return 0;
    }
    return Math.max(0, Math.min(1, (nowMs - startMs) / (90 * MIN)));
  }

  /** The value for `now` at the household's place. */
  function ambientProgressAt(now: Date, place: { lat: number; lng: number; tz: string }): number {
    return calculateAmbientProgress(now, calculateSunset(now, place.lat, place.lng, place.tz), place.tz);
  }

  /** `?ambient=` (or the build's allowed force) pins the value: dusk is 1, day is 0. */
  function overrideOf(search: string, force: string | null): number | null {
    const q = new URLSearchParams(search).get("ambient") ?? force;
    if (q === "dusk" || q === "night" || q === "evening") return 1;
    if (q === "day") return 0;
    return null;
  }

  /** What `--ambient-t` is set to, as a CSS percentage. */
  function cssValue(
    now: Date,
    search: string,
    force: string | null,
    place: { lat: number; lng: number; tz: string },
  ): string {
    const t = overrideOf(search, force) ?? ambientProgressAt(now, place);
    return `${(t * 100).toFixed(2)}%`;
  }

  return { civilIn, calculateSunset, calculateAmbientProgress, ambientProgressAt, overrideOf, cssValue };
}
