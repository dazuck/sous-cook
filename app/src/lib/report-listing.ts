/**
 * What `scripts/list-reports.ts` prints (B2 step 6), pure: its flags, the
 * header with the 24 h count, one summary per report, and a report in full.
 * Reading reports is this script's job alone (decision 7): there is no read
 * over tRPC. The script adds the queries; Ask's words come from
 * `conversation_logs`, joined by the session id a report carries.
 */

import type { CookReportInput } from "./cook-reports";
import { REPORTS_PER_DAY } from "./cook-reports";

/** A row as the listing reads it: everything but the plan and the DOM's text. */
export interface ListedReport {
  id: string;
  kitchenId: string;
  kitchenSlug: string;
  createdAt: Date;
  capturedAt: Date;
  build: string;
  path: string;
  screen: string;
  queueId: string | null;
  recipeName: string;
  stepKey: string | null;
  chapterId: string | null;
  planVersion: number | null;
  state: CookReportInput["state"];
  context: CookReportInput["context"];
  events: CookReportInput["events"];
  domTruncated: boolean;
  domBytes: number;
  note: string;
  noteAt: Date | null;
}

/** One kitchen's 24-hour report count against the per-kitchen daily cap. */
export interface KitchenReportCount {
  kitchenSlug: string;
  count: number;
}

export interface FullReport extends ListedReport {
  plan: unknown;
  dom: string;
}

/** The last question and answer in the report's Ask session, up to the flag. */
export interface AskExchange {
  question: string | null;
  answer: string | null;
}

export interface ListOptions {
  since: Date | null;
  limit: number;
  id: string | null;
  dom: string | null;
  json: boolean;
  all: boolean;
}

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

/** A step under this long before the flag means the DOM may be mid-motion (F3). */
export const MOVED_WINDOW_MS = 2000;
const LAST_EVENTS = 5;
const ASK_LINE_MAX = 200;

export function parseListArgs(argv: readonly string[]): ListOptions {
  const options: ListOptions = { since: null, limit: 20, id: null, dom: null, json: false, all: false };
  const valueOf = (i: number, flag: string): string => {
    const value = argv[i + 1];
    if (value === undefined || value.startsWith("--")) throw new Error(`${flag} needs a value`);
    return value;
  };
  for (let i = 0; i < argv.length; i += 1) {
    const flag = argv[i];
    switch (flag) {
      case "--since": {
        const value = valueOf(i, flag);
        // A date or date-time Date parses on its own; "yesterday" is refused.
        if (!/^\d{4}-\d{2}-\d{2}/.test(value) || Number.isNaN(Date.parse(value))) {
          throw new Error(`--since takes a date like 2026-10-01, not "${value}"`);
        }
        options.since = new Date(value);
        i += 1;
        break;
      }
      case "--limit": {
        const value = valueOf(i, flag);
        const n = Number(value);
        if (!Number.isInteger(n) || n < 1) throw new Error(`--limit takes a whole number from 1, not "${value}"`);
        options.limit = n;
        i += 1;
        break;
      }
      case "--id": {
        const value = valueOf(i, flag);
        if (!UUID.test(value)) throw new Error(`--id takes a report's uuid, not "${value}"`);
        options.id = value;
        i += 1;
        break;
      }
      case "--dom":
        options.dom = valueOf(i, flag);
        i += 1;
        break;
      case "--json":
        options.json = true;
        break;
      case "--all":
        options.all = true;
        break;
      default:
        throw new Error(`Unknown flag ${flag} (list-reports only reads)`);
    }
  }
  if (options.dom !== null && options.id === null) throw new Error("--dom needs --id: one report's DOM");
  return options;
}

/** "2026-10-04 18:00:00Z", or with the zone's short name outside UTC. */
export function formatTime(at: Date, timeZone: string): string {
  const parts = Object.fromEntries(
    new Intl.DateTimeFormat("en-US", {
      timeZone,
      year: "numeric",
      month: "2-digit",
      day: "2-digit",
      hour: "2-digit",
      minute: "2-digit",
      second: "2-digit",
      hourCycle: "h23",
      timeZoneName: "short",
    })
      .formatToParts(at)
      .map((p) => [p.type, p.value]),
  );
  const zone = parts.timeZoneName === "UTC" ? "Z" : ` ${parts.timeZoneName}`;
  return `${parts.year}-${parts.month}-${parts.day} ${parts.hour}:${parts.minute}:${parts.second}${zone}`;
}

/** "17:55:00.000" in the zone. */
function clock(at: Date, timeZone: string): string {
  return new Intl.DateTimeFormat("en-GB", {
    timeZone,
    hour: "2-digit",
    minute: "2-digit",
    second: "2-digit",
    fractionalSecondDigits: 3,
    hourCycle: "h23",
  }).format(at);
}

/** The latest step under 2 s before the flag, and how long before it (F3). */
export function movedBeforeFlag(report: ListedReport): { ms: number; detail: string } | null {
  const flagAt = report.capturedAt.getTime();
  let latest: { ms: number; detail: string } | null = null;
  for (const event of report.events) {
    if (event.kind !== "step") continue;
    const ms = flagAt - Date.parse(event.at);
    if (ms < 0 || ms >= MOVED_WINDOW_MS) continue;
    if (latest === null || ms < latest.ms) latest = { ms, detail: event.detail };
  }
  return latest;
}

export function formatHeader(
  counts: {
    lastDayByKitchen: readonly KitchenReportCount[];
    shown: number;
    since: Date | null;
    all: boolean;
  },
  timeZone: string,
): string {
  const total = counts.lastDayByKitchen.reduce((sum, entry) => sum + entry.count, 0);
  const perKitchen =
    counts.lastDayByKitchen.length === 0
      ? "none"
      : counts.lastDayByKitchen
          .map((entry) =>
            entry.count >= REPORTS_PER_DAY
              ? `${entry.kitchenSlug} ${entry.count}/${REPORTS_PER_DAY} (cap reached: new reports wait in the outbox)`
              : `${entry.kitchenSlug} ${entry.count}/${REPORTS_PER_DAY}`,
          )
          .join(", ");
  const since = counts.since ? ` since ${formatTime(counts.since, timeZone)}` : "";
  const hidden = counts.all ? "" : "; deploy checks hidden";
  return `cook_reports: ${total} in the last 24 h (${perKitchen}; cap ${REPORTS_PER_DAY} per kitchen). Showing ${counts.shown}${since}, newest first${hidden}.`;
}

function oneLine(text: string): string {
  const flat = text.replace(/\s+/g, " ").trim();
  return flat.length > ASK_LINE_MAX ? `${flat.slice(0, ASK_LINE_MAX - 1)}…` : flat;
}

/**
 * The look-ahead's levels by number, as a report's `layers.level` holds them
 * (P58), since slice N2. Before N2, 1 and 2 were Next few and How much more;
 * the report's build tells an older one apart.
 */
const LOOK_LEVELS = ["Now", "Until you can step away", "Whole cook", "Whole recipe"] as const;

function where(report: ListedReport): string[] {
  const { context } = report;
  return [
    `kitchen ${report.kitchenSlug}`,
    `id ${report.id}`,
    `build ${report.build}`,
    ...(context.part ? [`part ${context.part.at}/${context.part.of}`] : []),
    ...(context.layers.pane ? ["pane open"] : []),
    ...(context.layers.card ? [`card on ${context.layers.card}`] : []),
    ...(context.layers.more ? ["More open"] : []),
    // Slice N: the look-ahead's level and a step read in place; a pre-N report has neither.
    ...(context.layers.level !== undefined ? [`look-ahead ${LOOK_LEVELS[context.layers.level]}`] : []),
    ...(context.layers.read ? ["step read"] : []),
    `voice ${context.voice.mode ?? "unset"}/${context.voice.status}`,
    ...(context.ask.open ? ["Ask open"] : []),
    ...(context.online ? [] : ["offline"]),
    ...(report.domTruncated ? ["DOM cut at 200 KB"] : []),
  ];
}

export function formatSummary(
  report: ListedReport,
  ask: AskExchange | null,
  timeZone: string,
): string[] {
  const title = [
    report.recipeName,
    report.screen,
    ...(report.stepKey ? [report.stepKey] : []),
    ...(report.chapterId ? [`chapter ${report.chapterId}`] : []),
    report.state.mode,
  ].join(" · ");
  const lines = [
    `${formatTime(report.capturedAt, timeZone)}  ${title}`,
    `  ${where(report).join(" · ")}`,
    `  note: ${report.note === "" ? "(none)" : report.note}`,
  ];
  const moved = movedBeforeFlag(report);
  if (moved) {
    lines.push(`  ! moved ${moved.ms} ms before the flag (${moved.detail}): the DOM may be mid-motion`);
  }
  const recent = report.events.slice(-LAST_EVENTS);
  if (recent.length > 0) {
    lines.push("  last events:");
    for (const event of recent) {
      lines.push(`    ${clock(new Date(event.at), timeZone)}  ${event.kind.padEnd(5)}  ${event.detail}`);
    }
  }
  if (ask && (ask.question !== null || ask.answer !== null)) {
    lines.push(`  Ask, last exchange (${report.context.ask.sessionId}):`);
    if (ask.question !== null) lines.push(`    you: ${oneLine(ask.question)}`);
    if (ask.answer !== null) lines.push(`    sous: ${oneLine(ask.answer)}`);
  }
  return lines;
}

/** Everything but the DOM's text, which `--dom <file>` writes out. */
export function formatFull(report: FullReport, ask: AskExchange | null, timeZone: string): string {
  const { dom: _dom, ...rest } = report;
  const whole = report.domTruncated ? "cut at 200 KB" : "whole";
  return [
    ...formatSummary(report, ask, timeZone),
    "",
    JSON.stringify(rest, null, 2),
    "",
    `DOM: ${report.domBytes} bytes, ${whole}. Write it out with --dom <file>.`,
  ].join("\n");
}
