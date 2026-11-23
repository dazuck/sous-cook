/**
 * Read-only database helpers shared by `scripts/list-reports.ts` and its tests:
 * Ask's last exchange from `conversation_logs`, and each report's queue item
 * intake line from `kitchen_queue`, both scoped to the report's kitchen.
 */

import { and, desc, eq, inArray, sql } from "drizzle-orm";
import { conversationLogs, db, kitchenQueue } from "./db";
import { describeIntake, queueIntake } from "./pack-convert/intake-state";
import type { AskExchange, ListedReport } from "./report-listing";

/** The last message of a role in the report's Ask session within the report's kitchen, at or before the flag. */
export async function lastMessage(
  report: Pick<ListedReport, "kitchenId" | "context" | "capturedAt">,
  role: "user" | "assistant",
): Promise<string | null> {
  const [row] = await db
    .select({ content: conversationLogs.content })
    .from(conversationLogs)
    .where(
      and(
        eq(conversationLogs.kitchenId, report.kitchenId),
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

export async function askExchange(
  report: Pick<ListedReport, "kitchenId" | "context" | "capturedAt">,
): Promise<AskExchange | null> {
  if (report.context.ask.sessionId === "") return null;
  return {
    question: await lastMessage(report, "user"),
    answer: await lastMessage(report, "assistant"),
  };
}

/**
 * Each report's queue item's intake line, keyed by report id. Joins strictly
 * within the report's kitchen so a report naming another kitchen's queue id
 * receives no line.
 */
export async function intakeLines(
  reports: readonly Pick<ListedReport, "id" | "kitchenId" | "queueId">[],
): Promise<Map<string, string>> {
  const ids = [...new Set(reports.map((r) => r.queueId).filter((id): id is string => id !== null))];
  if (ids.length === 0) return new Map();
  const kitchenIds = [...new Set(reports.map((r) => r.kitchenId))];
  const rows = await db.query.kitchenQueue.findMany({
    // Narrows the rows read; the composite kitchenId:queueId map key below is what keeps kitchens apart.
    where: and(inArray(kitchenQueue.kitchenId, kitchenIds), inArray(kitchenQueue.id, ids)),
  });
  const lineByKitchenAndQueue = new Map<string, string>();
  for (const row of rows) {
    const line = describeIntake(queueIntake(row), {
      nudges: row.intakeNudges,
      attempts: row.intakeAttempts,
    });
    if (line !== null) {
      lineByKitchenAndQueue.set(`${row.kitchenId}:${row.id}`, line);
    }
  }
  const lines = new Map<string, string>();
  for (const report of reports) {
    if (report.queueId === null) continue;
    const line = lineByKitchenAndQueue.get(`${report.kitchenId}:${report.queueId}`);
    if (line !== undefined) {
      lines.set(report.id, line);
    }
  }
  return lines;
}
