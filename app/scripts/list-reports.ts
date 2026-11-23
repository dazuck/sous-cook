/**
 * Reads cook reports (B2): the only way to read them, since no tRPC
 * procedure returns a report (decision 7). Read-only: it never writes to the
 * DB. Formatting lives in src/lib/report-listing.ts.
 *
 *   env -u DATABASE_URL pnpm dotenv -o -e .env.local -- npx tsx scripts/list-reports.ts [flags]
 *
 *   --since <date>   reports flagged since then (2026-10-01, or a date-time)
 *   --limit <n>      how many, newest first (default 20)
 *   --id <uuid>      one report in full (all but the DOM's text)
 *   --dom <file>     with --id: write that report's DOM to a new file
 *   --json           JSON instead of text (with --id, the DOM included)
 *   --all            include the deploy's own round-trip (screen deploy-check)
 *
 * Reports hold recipe text in their DOMs, and with Ask open, Ask's view;
 * the summary joins Ask's last exchange from conversation_logs, and, for a
 * queue item that asked for intake, a line on it (cut, waiting, or shown as
 * sent with why; cook-fidelity plan). Keep output where the household's
 * cooking data can go.
 */

import { writeFileSync } from "node:fs";
import { and, desc, eq, gte, inArray, ne, sql, type SQL } from "drizzle-orm";
import { conversationLogs, cookReports, db, kitchenQueue } from "../src/lib/db";
import { describeIntake, queueIntake } from "../src/lib/pack-convert/intake-state";
import {
  DEPLOY_CHECK_SCREEN,
  RATE_WINDOW_MS,
  countCookReportsSince,
} from "../src/lib/cook-reports";
import {
  formatFull,
  formatHeader,
  formatSummary,
  parseListArgs,
  type AskExchange,
  type FullReport,
  type ListedReport,
} from "../src/lib/report-listing";

const timeZone = Intl.DateTimeFormat().resolvedOptions().timeZone;

const listed = {
  id: cookReports.id,
  createdAt: cookReports.createdAt,
  capturedAt: cookReports.capturedAt,
  build: cookReports.build,
  path: cookReports.path,
  screen: cookReports.screen,
  queueId: cookReports.queueId,
  recipeName: cookReports.recipeName,
  stepKey: cookReports.stepKey,
  chapterId: cookReports.chapterId,
  planVersion: cookReports.planVersion,
  state: cookReports.state,
  context: cookReports.context,
  events: cookReports.events,
  domTruncated: cookReports.domTruncated,
  domBytes: sql<number>`octet_length(${cookReports.dom})`.mapWith(Number),
  note: cookReports.note,
  noteAt: cookReports.noteAt,
};

/** The last message of a role in the report's Ask session, at or before the flag. */
async function lastMessage(report: ListedReport, role: "user" | "assistant"): Promise<string | null> {
  const [row] = await db
    .select({ content: conversationLogs.content })
    .from(conversationLogs)
    .where(
      and(
        eq(conversationLogs.sessionId, report.context.ask.sessionId),
        eq(conversationLogs.role, role),
        // created_at is a timestamp without zone, written in the session's
        // TimeZone; the cast reads the flag's moment in that same zone.
        sql`${conversationLogs.createdAt} <= ${report.capturedAt.toISOString()}::timestamptz::timestamp`,
      ),
    )
    .orderBy(desc(conversationLogs.createdAt))
    .limit(1);
  return row ? row.content : null;
}

async function askExchange(report: ListedReport): Promise<AskExchange | null> {
  if (report.context.ask.sessionId === "") return null;
  return {
    question: await lastMessage(report, "user"),
    answer: await lastMessage(report, "assistant"),
  };
}

/** Each report's queue item's intake line, by queue id; a row that never asked has none. */
async function intakeLines(reports: readonly ListedReport[]): Promise<Map<string, string>> {
  const ids = [...new Set(reports.map((r) => r.queueId).filter((id): id is string => id !== null))];
  if (ids.length === 0) return new Map();
  const rows = await db.query.kitchenQueue.findMany({ where: inArray(kitchenQueue.id, ids) });
  const lines = new Map<string, string>();
  for (const row of rows) {
    const line = describeIntake(queueIntake(row), { nudges: row.intakeNudges, attempts: row.intakeAttempts });
    if (line !== null) lines.set(row.id, line);
  }
  return lines;
}

async function main(): Promise<void> {
  const options = parseListArgs(process.argv.slice(2));

  if (options.id !== null) {
    const [report] = await db
      .select({ ...listed, plan: cookReports.plan, dom: cookReports.dom })
      .from(cookReports)
      .where(eq(cookReports.id, options.id));
    if (!report) throw new Error(`No report ${options.id}`);
    const full: FullReport = report;
    if (options.dom !== null) {
      // "wx": never over an existing file.
      writeFileSync(options.dom, full.dom, { flag: "wx" });
      console.log(`Wrote ${full.domBytes} bytes of DOM to ${options.dom}`);
    }
    if (options.json) {
      console.log(JSON.stringify(full, null, 2));
    } else {
      console.log(formatFull(full, await askExchange(full), timeZone));
      const intake = full.queueId === null ? undefined : (await intakeLines([full])).get(full.queueId);
      if (intake !== undefined) console.log(intake);
    }
    return;
  }

  const filters: SQL[] = [];
  if (!options.all) filters.push(ne(cookReports.screen, DEPLOY_CHECK_SCREEN));
  if (options.since) filters.push(gte(cookReports.capturedAt, options.since));
  const reports: ListedReport[] = await db
    .select(listed)
    .from(cookReports)
    .where(and(...filters))
    .orderBy(desc(cookReports.capturedAt))
    .limit(options.limit);
  const lastDay = await countCookReportsSince(new Date(Date.now() - RATE_WINDOW_MS));

  if (options.json) {
    console.log(JSON.stringify({ lastDay, reports }, null, 2));
    return;
  }
  console.log(
    formatHeader(
      { lastDay, shown: reports.length, since: options.since, all: options.all },
      timeZone,
    ),
  );
  const intakes = await intakeLines(reports);
  for (const report of reports) {
    console.log("");
    for (const line of formatSummary(report, await askExchange(report), timeZone)) console.log(line);
    const intake = report.queueId === null ? undefined : intakes.get(report.queueId);
    if (intake !== undefined) console.log(`  ${intake}`);
  }
}

main()
  .then(() => process.exit(0))
  .catch((err) => {
    console.error(err instanceof Error ? err.message : err);
    process.exit(1);
  });
