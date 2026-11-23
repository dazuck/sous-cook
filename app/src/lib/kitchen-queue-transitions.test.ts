/**
 * Status transitions against a real Postgres (PGlite, in memory).
 *
 * The start and finish stamps are conditional UPDATEs: only a real
 * transition stamps, and only the first of two Dones reports `completed`.
 * That guarantee lives in SQL, so these run the real queries.
 */

import { describe, it, expect, beforeAll, beforeEach, vi } from "vitest";
import { eq } from "drizzle-orm";
import type { PGlite } from "@electric-sql/pglite";

vi.mock("./db", async () => {
  const { PGlite } = await import("@electric-sql/pglite");
  const { drizzle } = await import("drizzle-orm/pglite");
  const schema = await import("../../drizzle/schema");
  const client = new PGlite();
  return { ...schema, db: drizzle(client, { schema }), client };
});

import * as dbModule from "./db";
import { db, kitchenQueue } from "./db";
import { getQueueItem, updateQueueStatus } from "./kitchen-queue";
import { ACTIVITY_SLACK_MS, REOPEN_WINDOW_MS } from "./kitchen/auto-finish";

const client = (dbModule as unknown as { client: PGlite }).client;

beforeAll(async () => {
  const { generateDrizzleJson, generateMigration } = await import(
    "drizzle-kit/api"
  );
  const statements = await generateMigration(
    generateDrizzleJson({}),
    generateDrizzleJson({ kitchenQueue }),
  );
  for (const statement of statements) await client.exec(statement);
});

beforeEach(async () => {
  await client.exec("delete from kitchen_queue");
});

const LOGGED = {
  row: 7,
  timestamp: "2026-10-04 19:02",
  recipeName: "Dal",
  adopted: false,
};

async function insertItem(
  values: Partial<typeof kitchenQueue.$inferInsert> = {},
): Promise<string> {
  const [row] = await db
    .insert(kitchenQueue)
    .values({ recipeData: { name: "Dal" }, targetUser: "cook", ...values })
    .returning({ id: kitchenQueue.id });
  return row.id;
}

async function item(id: string) {
  const found = await getQueueItem(id);
  if (!found) throw new Error(`missing ${id}`);
  return found;
}

const EARLIER = new Date("2026-10-01T23:00:00Z");

describe("updateQueueStatus: into cooking", () => {
  it("stamps started_at on the transition from pending", async () => {
    const id = await insertItem();
    const before = Date.now();

    expect(await updateQueueStatus(id, "cooking")).toEqual({ completed: false, started: true });

    const after = await item(id);
    expect(after.status).toBe("cooking");
    expect(after.startedAt).toBeInstanceOf(Date);
    // PGlite's clock is this process's clock; allow for rounding to the ms.
    expect((after.startedAt as Date).getTime()).toBeGreaterThanOrEqual(before - 5);
    expect(after.completedAt).toBeNull();
  });

  it("leaves started_at alone on a resume (cooking to cooking)", async () => {
    const id = await insertItem({ status: "cooking", startedAt: EARLIER });

    // No start: the caller finishes no cook left on its last screen for it.
    expect(await updateQueueStatus(id, "cooking")).toEqual({ completed: false, started: false });

    expect((await item(id)).startedAt).toEqual(EARLIER);
  });

  it("re-stamps started_at when a completed item is cooked again", async () => {
    const id = await insertItem({ status: "completed", startedAt: EARLIER });

    await updateQueueStatus(id, "cooking");

    const after = await item(id);
    expect(after.status).toBe("cooking");
    expect((after.startedAt as Date).getTime()).toBeGreaterThan(EARLIER.getTime());
  });
});

describe("updateQueueStatus: into completed", () => {
  it("stamps completed_at and reports the transition", async () => {
    const id = await insertItem({ status: "cooking", startedAt: EARLIER });

    expect(await updateQueueStatus(id, "completed")).toEqual({ completed: true, started: false });

    const after = await item(id);
    expect(after.status).toBe("completed");
    expect((after.completedAt as Date).getTime()).toBeGreaterThan(EARLIER.getTime());
    expect(after.startedAt).toEqual(EARLIER);
  });

  it("clears the previous cook's Cook Log fields on entry", async () => {
    const id = await insertItem({
      status: "cooking",
      cookLog: LOGGED,
      cookLogError: "HTTP 403",
      cookLogClaimedAt: EARLIER,
      ratingClosedAt: EARLIER,
    });

    await updateQueueStatus(id, "completed");

    const after = await item(id);
    expect(after.cookLog).toBeNull();
    expect(after.cookLogError).toBeNull();
    expect(after.cookLogClaimedAt).toBeNull();
    expect(after.ratingClosedAt).toBeNull();
  });

  it("a second Done changes nothing and reports no transition", async () => {
    const id = await insertItem({
      status: "completed",
      completedAt: EARLIER,
      cookLog: LOGGED,
      ratingClosedAt: EARLIER,
    });

    expect(await updateQueueStatus(id, "completed")).toEqual({ completed: false, started: false });

    const after = await item(id);
    expect(after.completedAt).toEqual(EARLIER);
    expect(after.cookLog).toEqual(LOGGED);
    expect(after.ratingClosedAt).toEqual(EARLIER);
  });

  it("of two concurrent Dones, exactly one transitions", async () => {
    const id = await insertItem({ status: "cooking" });

    const results = await Promise.all([
      updateQueueStatus(id, "completed"),
      updateQueueStatus(id, "completed"),
    ]);

    expect(results.filter((r) => r.completed)).toHaveLength(1);
  });

  // T follow-up, item 5: a start counts only for the cook it began. A finish
  // that doesn't come straight from cooking had no start this app saw, so the
  // measurement reads it as no-start rather than an old cook's start.
  it("a cook finished, reopened to the queue and finished again keeps no start", async () => {
    const id = await insertItem({
      status: "completed",
      startedAt: EARLIER,
      completedAt: EARLIER,
    });

    await updateQueueStatus(id, "pending");
    expect(await updateQueueStatus(id, "completed")).toEqual({ completed: true, started: false });

    const after = await item(id);
    expect(after.startedAt).toBeNull();
    expect((after.completedAt as Date).getTime()).toBeGreaterThan(EARLIER.getTime());
  });

  it("a cook put back in the queue, or cancelled, then marked done keeps no start", async () => {
    for (const between of ["pending", "cancelled"] as const) {
      const id = await insertItem({ status: "cooking", startedAt: EARLIER });

      await updateQueueStatus(id, between);
      expect(await updateQueueStatus(id, "completed")).toEqual({ completed: true, started: false });

      expect((await item(id)).startedAt).toBeNull();
    }
  });

  it("a missing id is a no-op", async () => {
    const other = await insertItem({ status: "cooking" });

    expect(
      await updateQueueStatus("00000000-0000-4000-8000-000000000000", "completed"),
    ).toEqual({ completed: false, started: false });
    expect((await item(other)).status).toBe("cooking");
  });
});

describe("updateQueueStatus: other statuses", () => {
  it("sets pending or cancelled without touching the stamps", async () => {
    const id = await insertItem({
      status: "completed",
      startedAt: EARLIER,
      completedAt: EARLIER,
    });

    expect(await updateQueueStatus(id, "cancelled")).toEqual({ completed: false, started: false });

    const [row] = await db
      .select()
      .from(kitchenQueue)
      .where(eq(kitchenQueue.id, id));
    expect(row.status).toBe("cancelled");
    expect(row.startedAt).toEqual(EARLIER);
    expect(row.completedAt).toEqual(EARLIER);
  });
});

// Cook-fidelity plan, decision 7: a cook finishes by the cook's own press, or
// by the app once it sat on its last screen with nothing moving, dated to the
// cook's last activity, never to when the app noticed.
describe("updateQueueStatus: how the cook finished", () => {
  const ACTIVE = new Date("2026-10-01T23:40:00Z");

  it("a press is 'pressed', stamped by the database clock", async () => {
    const id = await insertItem({ status: "cooking", startedAt: EARLIER });

    await updateQueueStatus(id, "completed");

    const after = await item(id);
    expect(after.finishedBy).toBe("pressed");
    expect((after.completedAt as Date).getTime()).toBeGreaterThan(ACTIVE.getTime());
  });

  it("an auto-finish is 'auto', dated to the activity it was given", async () => {
    const id = await insertItem({ status: "cooking", startedAt: EARLIER, lastScreenActiveAt: ACTIVE });

    expect(await updateQueueStatus(id, "completed", { by: "auto", at: ACTIVE, interactedAt: ACTIVE })).toEqual({ completed: true, started: false });

    const after = await item(id);
    expect(after.status).toBe("completed");
    expect(after.finishedBy).toBe("auto");
    expect(after.completedAt).toEqual(ACTIVE);
    expect(after.startedAt).toEqual(EARLIER);
  });

  it("an auto-finish is never dated before the start or after now", async () => {
    const early = await insertItem({ status: "cooking", startedAt: ACTIVE, lastScreenActiveAt: EARLIER });
    await updateQueueStatus(early, "completed", { by: "auto", at: EARLIER, interactedAt: EARLIER });
    expect((await item(early)).completedAt).toEqual(ACTIVE);

    const late = await insertItem({ status: "cooking", startedAt: EARLIER, lastScreenActiveAt: EARLIER });
    const before = Date.now();
    await updateQueueStatus(late, "completed", { by: "auto", at: new Date(before + 60 * 60 * 1000), interactedAt: new Date(before + 60 * 60 * 1000) });
    const stamped = ((await item(late)).completedAt as Date).getTime();
    expect(stamped).toBeGreaterThanOrEqual(before - 5);
    expect(stamped).toBeLessThanOrEqual(Date.now() + 5);
  });

  it("an auto-finish takes only a cook that is cooking", async () => {
    for (const status of ["pending", "cancelled"] as const) {
      const id = await insertItem({ status });
      expect(await updateQueueStatus(id, "completed", { by: "auto", at: ACTIVE, interactedAt: ACTIVE })).toEqual({ completed: false, started: false });
      expect((await item(id)).status).toBe(status);
    }
  });

  it("an auto-finish loses to activity reported after the time it was given, past the slack", async () => {
    const later = new Date(ACTIVE.getTime() + ACTIVITY_SLACK_MS + 1);
    const id = await insertItem({ status: "cooking", startedAt: EARLIER, lastScreenActiveAt: later });

    expect(await updateQueueStatus(id, "completed", { by: "auto", at: ACTIVE, interactedAt: ACTIVE })).toEqual({ completed: false, started: false });
    expect((await item(id)).status).toBe("cooking");
  });

  it("a fresh start clears how the last cook finished, where it sat and its last touch", async () => {
    const id = await insertItem({
      status: "completed",
      completedAt: ACTIVE,
      finishedBy: "auto",
      lastScreenActiveAt: ACTIVE,
      lastInteractionAt: ACTIVE,
    });

    await updateQueueStatus(id, "cooking");

    const after = await item(id);
    expect(after.finishedBy).toBeNull();
    expect(after.lastScreenActiveAt).toBeNull();
    expect(after.lastInteractionAt).toBeNull();
  });

  it("refuses an auto-finish of a cook with no last-screen activity: it left the last screen elsewhere", async () => {
    const id = await insertItem({ status: "cooking", startedAt: EARLIER, lastScreenActiveAt: null });

    expect(await updateQueueStatus(id, "completed", { by: "auto", at: ACTIVE, interactedAt: ACTIVE })).toEqual({ completed: false, started: false });
    expect(
      await updateQueueStatus(id, "completed", { by: "auto", idleBefore: new Date() }),
    ).toEqual({ completed: false, started: false });
    expect((await item(id)).status).toBe("cooking");
  });

  it("the server's finish takes the activity the row holds as it finishes, and dates the cook to it", async () => {
    const id = await insertItem({ status: "cooking", startedAt: EARLIER, lastScreenActiveAt: ACTIVE });

    expect(await updateQueueStatus(id, "completed", { by: "auto", idleBefore: new Date() })).toEqual({
      completed: true,
      started: false,
    });
    const after = await item(id);
    expect(after.finishedBy).toBe("auto");
    expect(after.completedAt).toEqual(ACTIVE);
  });

  it("the server's finish refuses a cook whose activity is past its cutoff: a short timer just reported", async () => {
    const id = await insertItem({
      status: "cooking",
      startedAt: EARLIER,
      lastScreenActiveAt: new Date(Date.now() + 90_000),
    });

    expect(await updateQueueStatus(id, "completed", { by: "auto", idleBefore: new Date() })).toEqual({
      completed: false,
      started: false,
    });
    expect((await item(id)).status).toBe("cooking");
  });

  it("a cook reopened after an auto-finish keeps its Cook Log row and closed ask when it finishes again", async () => {
    const id = await insertItem({
      status: "cooking",
      startedAt: EARLIER,
      completedAt: new Date(Date.now() - 30 * 60_000),
      finishedBy: "auto",
      cookLog: LOGGED,
      ratingClosedAt: ACTIVE,
    });

    expect(await updateQueueStatus(id, "completed")).toEqual({ completed: true, started: false });

    const after = await item(id);
    expect(after.finishedBy).toBe("pressed");
    expect(after.cookLog).toEqual(LOGGED);
    expect(after.ratingClosedAt).toEqual(ACTIVE);
    expect(after.startedAt).toEqual(EARLIER);
  });

  it("a reopened cook finished past the window of its first finish is a new cook: no row, its ask open", async () => {
    const id = await insertItem({
      status: "cooking",
      startedAt: EARLIER,
      completedAt: new Date(Date.now() - REOPEN_WINDOW_MS - 60_000),
      finishedBy: "auto",
      cookLog: LOGGED,
      ratingClosedAt: ACTIVE,
    });

    expect(await updateQueueStatus(id, "completed")).toEqual({ completed: true, started: false });

    const after = await item(id);
    expect(after.cookLog).toBeNull();
    expect(after.ratingClosedAt).toBeNull();
  });

  it("a refinish within the window keeps the claim of a Cook Log write still under way", async () => {
    const claimed = new Date(Date.now() - 5_000);
    const id = await insertItem({
      status: "cooking",
      startedAt: EARLIER,
      completedAt: new Date(Date.now() - 30 * 60_000),
      finishedBy: "auto",
      cookLogClaimedAt: claimed,
    });

    await updateQueueStatus(id, "completed");
    expect((await item(id)).cookLogClaimedAt).toEqual(claimed);
  });

  it("refuses a finish of an unknown kind at the database", async () => {
    const id = await insertItem({ status: "cooking" });
    await expect(
      client.exec(`update kitchen_queue set finished_by = 'guessed' where id = '${id}'`),
    ).rejects.toThrow(/kitchen_queue_finished_by_known/);
  });
});
