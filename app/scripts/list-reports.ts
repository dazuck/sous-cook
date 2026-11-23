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
import { and, asc, desc, eq, gte, ne, sql, type SQL } from "drizzle-orm";
import { cookReports, db, kitchens } from "../src/lib/db";
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
  type FullReport,
  type KitchenReportCount,
  type ListedReport,
} from "../src/lib/report-listing";
import { askExchange, intakeLines } from "../src/lib/report-listing-queries";

const timeZone = Intl.DateTimeFormat().resolvedOptions().timeZone;

const listed = {
  id: cookReports.id,
  kitchenId: kitchens.id,
  kitchenSlug: kitchens.slug,
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

async function main(): Promise<void> {
  const options = parseListArgs(process.argv.slice(2));

  if (options.id !== null) {
    const [report] = await db
      .select({ ...listed, plan: cookReports.plan, dom: cookReports.dom })
      .from(cookReports)
      .innerJoin(kitchens, eq(cookReports.kitchenId, kitchens.id))
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
      const intake = full.queueId === null ? undefined : (await intakeLines([full])).get(full.id);
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
    .innerJoin(kitchens, eq(cookReports.kitchenId, kitchens.id))
    .where(and(...filters))
    .orderBy(desc(cookReports.capturedAt))
    .limit(options.limit);

  const since24h = new Date(Date.now() - RATE_WINDOW_MS);
  const allKitchens = await db
    .select({ id: kitchens.id, slug: kitchens.slug })
    .from(kitchens)
    .orderBy(asc(kitchens.slug));
  const lastDayByKitchen: KitchenReportCount[] = [];
  for (const k of allKitchens) {
    const count = await countCookReportsSince(k.id, since24h);
    if (count > 0) {
      lastDayByKitchen.push({ kitchenSlug: k.slug, count });
    }
  }

  if (options.json) {
    console.log(JSON.stringify({ lastDayByKitchen, reports }, null, 2));
    return;
  }
  console.log(
    formatHeader(
      { lastDayByKitchen, shown: reports.length, since: options.since, all: options.all },
      timeZone,
    ),
  );
  const intakes = await intakeLines(reports);
  for (const report of reports) {
    console.log("");
    for (const line of formatSummary(report, await askExchange(report), timeZone)) console.log(line);
    const intake = report.queueId === null ? undefined : intakes.get(report.id);
    if (intake !== undefined) console.log(`  ${intake}`);
  }
}

main()
  .then(() => process.exit(0))
  .catch((err) => {
    console.error(err instanceof Error ? err.message : err);
    process.exit(1);
  });
