/**
 * The kitchen's wall clock, in the household's zone (FP1, P65; D7). The
 * eyebrow over the home's dish follows it ("Tonight" from 2 pm, "Up next"
 * before), and the top line says the time. The zone is the household's
 * (`NEXT_PUBLIC_KITCHEN_TZ`, `lib/ambient/location.ts`), never the device's:
 * the kitchen is where it is whatever the tablet's clock is set to.
 */

/** The hour from which the queue's top is called tonight's. */
export const TONIGHT_FROM_HOUR = 14;

/** The hour (0 to 23) and minute `date` shows on a wall clock in `tz`. */
export function wallClock(date: Date, tz: string): { hour: number; minute: number } {
  const parts = new Intl.DateTimeFormat("en-US", {
    timeZone: tz,
    hourCycle: "h23",
    hour: "numeric",
    minute: "numeric",
  }).formatToParts(date);
  const get = (type: string) => Number(parts.find((p) => p.type === type)?.value);
  return { hour: get("hour") % 24, minute: get("minute") };
}

/** The eyebrow over the queue's top dish: it never claims a plan Sous didn't make. */
export function eyebrowAt(date: Date, tz: string): "Tonight" | "Up next" {
  return wallClock(date, tz).hour >= TONIGHT_FROM_HOUR ? "Tonight" : "Up next";
}

/** "6:12 pm": the top line's time, in the household's zone. */
export function clockText(date: Date, tz: string): string {
  const { hour, minute } = wallClock(date, tz);
  const h = hour % 12 === 0 ? 12 : hour % 12;
  return `${h}:${String(minute).padStart(2, "0")} ${hour < 12 ? "am" : "pm"}`;
}
