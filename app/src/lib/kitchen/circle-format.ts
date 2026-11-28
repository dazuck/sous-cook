const DAY_MS = 86_400_000;
const DAY_RE = /^(\d{4})-(\d{2})-(\d{2})$/;

const WEEKDAY_FORMAT = new Intl.DateTimeFormat("en-US", {
  weekday: "long",
  timeZone: "UTC",
});

const MONTH_DAY_FORMAT = new Intl.DateTimeFormat("en-US", {
  month: "short",
  day: "numeric",
  timeZone: "UTC",
});

const MONTH_DAY_YEAR_FORMAT = new Intl.DateTimeFormat("en-US", {
  month: "short",
  day: "numeric",
  year: "numeric",
  timeZone: "UTC",
});

/**
 * Formats a YYYY-MM-DD cook-log date into calm human relative wording:
 * "today", "yesterday", weekday name within 6 days, otherwise "Nov 20" (or
 * "Nov 20, 2025" when from another year).
 */
export function formatCircleDay(cookedDay: string, now: Date = new Date()): string {
  const match = DAY_RE.exec(cookedDay.trim());
  if (!match) return cookedDay;

  const year = Number(match[1]);
  const month = Number(match[2]);
  const day = Number(match[3]);
  const target = new Date(Date.UTC(year, month - 1, day));
  if (
    target.getUTCFullYear() !== year ||
    target.getUTCMonth() !== month - 1 ||
    target.getUTCDate() !== day
  ) {
    return cookedDay;
  }

  const todayUtc = Date.UTC(now.getFullYear(), now.getMonth(), now.getDate());
  const diffDays = Math.round((todayUtc - target.getTime()) / DAY_MS);

  if (diffDays === 0) return "today";
  if (diffDays === 1) return "yesterday";
  if (diffDays >= 2 && diffDays <= 6) return WEEKDAY_FORMAT.format(target);
  if (year === now.getFullYear()) return MONTH_DAY_FORMAT.format(target);
  return MONTH_DAY_YEAR_FORMAT.format(target);
}
