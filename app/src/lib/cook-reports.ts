/**
 * Cook reports on the server (B2 decisions 7 and 8): the input's shape and
 * size caps, and the three queries the two write procedures need. There is
 * no read of report bodies here or over tRPC; `scripts/list-reports.ts` reads
 * them with prod credentials.
 */

import { eq, gt, sql } from "drizzle-orm";
import { z } from "zod";
import { cookReports, db } from "./db";
import {
  DOM_MAX_BYTES,
  NOTE_MAX_BYTES,
  PLAN_MAX_BYTES,
  REPORT_INPUT_MAX_BYTES,
  REPORT_SCREENS,
  byteLength,
  jsonBytes,
} from "./kitchen/report-capture";
import { EVENT_CAPACITY, EVENT_MAX_BYTES, REPORT_EVENT_KINDS } from "./kitchen/report-events";

/** The global cap on stored reports per rolling 24 h (decision 8). */
export const REPORTS_PER_DAY = 100;
export const RATE_WINDOW_MS = 24 * 60 * 60 * 1000;

// The size caps live beside the client's cuts, which measure the same way.
export { EVENT_MAX_BYTES, PLAN_MAX_BYTES, REPORT_INPUT_MAX_BYTES };

/** The screen `scripts/list-reports.ts` hides: the deploy's own round-trip. */
export const DEPLOY_CHECK_SCREEN = "deploy-check";

const withinBytes = (max: number) => (text: string) => byteLength(text) <= max;

const IdList = z.array(z.string().max(128)).max(1000);

const EventSchema = z
  .object({
    at: z.string().max(40),
    kind: z.enum(REPORT_EVENT_KINDS),
    detail: z.string(),
  })
  .refine((event) => jsonBytes(event) <= EVENT_MAX_BYTES, {
    message: `an event is at most ${EVENT_MAX_BYTES} bytes`,
  });

export const NoteSchema = z
  .string()
  .refine(withinBytes(NOTE_MAX_BYTES), { message: `a note is at most ${NOTE_MAX_BYTES} bytes` });

/**
 * A report as the outbox sends it (`CookReport`). Unknown keys are dropped at
 * every level, so the row holds the named fields only (F12).
 */
export const CookReportInputSchema = z
  .object({
    id: z.uuid(),
    capturedAt: z.iso.datetime(),
    build: z.string().min(1).max(128),
    path: z.string().max(2048),
    screen: z.enum([...REPORT_SCREENS, DEPLOY_CHECK_SCREEN]),
    queueId: z.uuid().nullable(),
    recipeName: z.string().max(500),
    stepKey: z.string().max(256).nullable(),
    chapterId: z.string().max(256).nullable(),
    planVersion: z.number().int().nullable(),
    plan: z
      .unknown()
      .transform((plan) => plan ?? null)
      .refine((plan) => jsonBytes(plan) <= PLAN_MAX_BYTES, {
        message: `a plan is at most ${PLAN_MAX_BYTES} bytes`,
      }),
    state: z.object({
      mode: z.string().max(16),
      pos: z.number().int(),
      ticked: IdList,
      passed: IdList,
      kept: IdList,
    }),
    context: z.object({
      viewport: z.object({ w: z.number(), h: z.number(), dpr: z.number() }),
      ua: z.string().max(512),
      online: z.boolean(),
      voice: z.object({
        mode: z.enum(["always", "tap"]).nullable(),
        status: z.string().max(32),
      }),
      ask: z.object({ sessionId: z.string().max(200), open: z.boolean() }),
      layers: z.object({
        pane: z.boolean(),
        card: z.enum(["pane", "screen"]).nullable(),
        more: z.boolean(),
        level: z.number().int().min(0).max(3).optional(),
        read: z.boolean().optional(),
      }),
      part: z.object({ at: z.number().int(), of: z.number().int() }).nullable(),
    }),
    events: z.array(EventSchema).max(EVENT_CAPACITY),
    dom: z
      .string()
      .refine(withinBytes(DOM_MAX_BYTES), { message: `the DOM is at most ${DOM_MAX_BYTES} bytes` }),
    domTruncated: z.boolean(),
    note: NoteSchema,
  })
  .refine((report) => jsonBytes(report) <= REPORT_INPUT_MAX_BYTES, {
    message: `a report is at most ${REPORT_INPUT_MAX_BYTES} bytes`,
  });

export type CookReportInput = z.infer<typeof CookReportInputSchema>;

/**
 * The key of the transaction-scoped advisory lock that makes the cap one
 * decision at a time (fix round 1, M3). Arbitrary, and the only advisory lock
 * the kitchen takes; it is per database, so it holds across Vercel instances.
 */
export const REPORT_CAP_LOCK = 5_802_202;

/** How a submit went: stored, already stored under its id (F4, its note now this one), or over the cap (F7). */
export type StoreOutcome = "inserted" | "duplicate" | "capped";

/**
 * Stores a report under the global cap. The duplicate check, the count and
 * the insert run in one transaction behind `REPORT_CAP_LOCK`, so racing
 * submits, from one server or many, are decided one after another and never
 * store more than `REPORTS_PER_DAY` in a rolling day. A resend of a stored id
 * is a duplicate however full the day is: its row exists. The window is the
 * DB's clock, as `created_at` is.
 *
 * A duplicate's note becomes the row's (fix round 1, M1): the first submit's
 * answer was lost and the cook may have typed since, and the outbox takes
 * any success as the DB holding the note it sent. Only the note: the capture
 * itself is the moment as it stood and never changes. The resend's note is
 * the newest, since the outbox annotates only once a submit has succeeded.
 */
export async function storeCookReport(report: CookReportInput): Promise<StoreOutcome> {
  return db.transaction(async (tx) => {
    await tx.execute(sql`select pg_advisory_xact_lock(${REPORT_CAP_LOCK})`);
    const [existing] = await tx
      .select({ note: cookReports.note })
      .from(cookReports)
      .where(eq(cookReports.id, report.id))
      .limit(1);
    if (existing) {
      if (existing.note !== report.note) {
        await tx
          .update(cookReports)
          .set({ note: report.note, noteAt: sql`now()` })
          .where(eq(cookReports.id, report.id));
      }
      return "duplicate";
    }
    const [row] = await tx
      .select({ n: sql<number>`count(*)::int` })
      .from(cookReports)
      .where(
        gt(cookReports.createdAt, sql`now() - make_interval(secs => ${RATE_WINDOW_MS / 1000})`),
      );
    if (!row) throw new Error("count(*) on cook_reports returned no row");
    if (row.n >= REPORTS_PER_DAY) return "capped";
    await tx.insert(cookReports).values({
      id: report.id,
      capturedAt: new Date(report.capturedAt),
      build: report.build,
      path: report.path,
      screen: report.screen,
      queueId: report.queueId,
      recipeName: report.recipeName,
      stepKey: report.stepKey,
      chapterId: report.chapterId,
      planVersion: report.planVersion,
      plan: report.plan,
      state: report.state,
      context: report.context,
      events: report.events,
      dom: report.dom,
      domTruncated: report.domTruncated,
      note: report.note,
      noteAt: report.note === "" ? null : sql`now()`,
    });
    return "inserted";
  });
}

/** Sets a stored report's note; false when no report has the id. */
export async function annotateCookReport(id: string, note: string): Promise<boolean> {
  const rows = await db
    .update(cookReports)
    .set({ note, noteAt: sql`now()` })
    .where(eq(cookReports.id, id))
    .returning({ id: cookReports.id });
  return rows.length > 0;
}

/** Reports stored after `since` (`created_at` is the DB's clock). */
export async function countCookReportsSince(since: Date): Promise<number> {
  const [row] = await db
    .select({ n: sql<number>`count(*)::int` })
    .from(cookReports)
    .where(gt(cookReports.createdAt, since));
  if (!row) throw new Error("count(*) on cook_reports returned no row");
  return row.n;
}
