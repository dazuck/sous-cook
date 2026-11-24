/**
 * The Cook Log write and the rating, against a real Postgres (PGlite) and a
 * Cook Log scripted at its edge (the cook-log hook, connected to
 * `scriptedCookLog`), in a kitchen set to New York. The rules for a cook's
 * row are tested in hooks/cook-log.test.ts; here the point is what lands on
 * the queue item.
 */

import {
  describe,
  it,
  expect,
  beforeAll,
  beforeEach,
  afterEach,
  vi,
} from "vitest";
import type { PGlite } from "@electric-sql/pglite";
import { TRPCError } from "@trpc/server";
import { eq } from "drizzle-orm";

vi.mock("next/server", async (importOriginal) => ({
  ...(await importOriginal<typeof import("next/server")>()),
  after: vi.fn(),
}));

vi.mock("./kitchen/zone", () => ({ KITCHEN_TIME_ZONE: "America/New_York" }));

vi.mock("./hooks/connected", async () => {
  const { HOOK_NAMES } = await import("./hooks/types");
  return { connected: Object.fromEntries(HOOK_NAMES.map((name) => [name, true])) };
});

vi.mock("./hooks/registry", async () => {
  const { scriptedCookLog } = await import("./__tests__/scripted-cook-log");
  return { hook: () => scriptedCookLog((url, init) => mockFetch(url, init)) };
});

vi.mock("@/lib/db", async () =>
  (await import("./__tests__/test-db")).mockDbModule(),
);

vi.mock("./kitchen-queue", async (importOriginal) => {
  const actual = await importOriginal<typeof import("./kitchen-queue")>();
  return { ...actual, getQueueItem: vi.fn(actual.getQueueItem) };
});

import * as dbModule from "./db";
import { db, kitchenQueue } from "./db";
import { callerFor, homeKitchen, seedKitchen } from "./__tests__/kitchens";
import {
  CookLogConflict,
  CookLogItemNotFound,
  cookLogStatus,
  dismissCookAsk as dismissCookAskForKitchen,
  LOST_WRITE_MS,
  logCook as logCookForKitchen,
  logCookInBackground as logCookInBackgroundForKitchen,
  openCookAsk as openCookAskForKitchen,
  rateCook as rateCookForKitchen,
  retryCookLog as retryCookLogForKitchen,
} from "./kitchen-cook-log";
import {
  getQueueItem,
  updateQueueStatus as updateQueueStatusForKitchen,
  type QueueFinish,
  type QueueStatus,
} from "./kitchen-queue";

const client = (dbModule as unknown as { client: PGlite }).client;
let kitchenId: string;
let router: ReturnType<typeof callerFor>;

/** The Cook Log's transport: every request the grid makes goes through it. */
const mockFetch = vi.fn();

beforeAll(async () => {
  const home = await homeKitchen(db);
  kitchenId = home.id;
  router = callerFor(home);
});

beforeEach(async () => {
  mockFetch.mockReset();
  await client.exec(
    "delete from kitchen_queue; delete from invites; delete from members; delete from auth_session; delete from auth_account; delete from auth_user;",
  );
  await client.exec("delete from kitchens where slug <> 'home'");
});

const updateQueueStatus = (
  queueId: string,
  status: QueueStatus,
  finish?: QueueFinish,
) => updateQueueStatusForKitchen(kitchenId, queueId, status, finish);
const logCook = (queueId: string, now?: Date) =>
  logCookForKitchen(kitchenId, queueId, now);
const logCookInBackground = (queueId: string) =>
  logCookInBackgroundForKitchen(kitchenId, queueId);
const retryCookLog = (queueId: string, now?: Date) =>
  retryCookLogForKitchen(kitchenId, queueId, now);
const rateCook = (
  input: { queueId: string; rating: number; notes?: string },
  now?: Date,
) => rateCookForKitchen(kitchenId, input, now);
const openCookAsk = (_ignoredUser: string, now?: Date) =>
  openCookAskForKitchen(kitchenId, now);
const dismissCookAsk = (queueId: string) =>
  dismissCookAskForKitchen(kitchenId, queueId);

afterEach(() => {
  vi.restoreAllMocks();
});

/** 2026-10-04 19:02 in New York. */
const DONE = new Date("2026-10-04T23:02:00Z");
const HEADER = ["timestamp", "recipe_name", "recipe_anchor", "rating", "notes"];
const LOG = {
  row: 4,
  timestamp: "2026-10-04 19:02",
  recipeName: "Dal",
  adopted: false,
};

function ok(data: unknown) {
  return { ok: true, json: async () => data };
}

function refused(status: number, body: string) {
  return { ok: false, status, text: async () => body };
}

/** A log with `rows` in it, accepting one append at the next row. */
function sheetAccepting(rows: string[][]) {
  mockFetch
    .mockResolvedValueOnce(ok({ values: rows }))
    .mockResolvedValueOnce(
      ok({
        updates: {
          updatedRange: `'Cook Log'!A${rows.length + 1}:E${rows.length + 1}`,
        },
      }),
    );
}

async function completedItem(
  values: Partial<typeof kitchenQueue.$inferInsert> = {},
): Promise<string> {
  const [row] = await db
    .insert(kitchenQueue)
    .values({
      kitchenId,
      recipeData: { name: "Dal" },
      status: "completed",
      completedAt: DONE,
      ...values,
    })
    .returning({ id: kitchenQueue.id });
  return row.id;
}

async function item(id: string) {
  const found = await getQueueItem(kitchenId, id);
  if (!found) throw new Error(`missing ${id}`);
  return found;
}

const minutesAfterDone = (m: number) =>
  new Date(DONE.getTime() + m * 60 * 1000);

const MISSING = "00000000-0000-4000-8000-000000000000";

/**
 * Runs `change` on the item right after the next read of it, before the
 * caller acts on what it read: the window between a write's (or a rating's)
 * read and its claim.
 */
async function afterNextRead(
  change: (id: string) => Promise<unknown>,
  skip = 0,
) {
  const actual =
    await vi.importActual<typeof import("./kitchen-queue")>("./kitchen-queue");
  for (let i = 0; i < skip; i++) {
    vi.mocked(getQueueItem).mockImplementationOnce((kId: string, id: string) =>
      actual.getQueueItem(kId, id),
    );
  }
  vi.mocked(getQueueItem).mockImplementationOnce(async (kId: string, id: string) => {
    const read = await actual.getQueueItem(kId, id);
    await change(id);
    return read;
  });
}

async function reopen(id: string) {
  await updateQueueStatus(id, "cooking");
}

async function reopenAndFinish(id: string) {
  await updateQueueStatus(id, "cooking");
  expect((await updateQueueStatus(id, "completed")).completed).toBe(true);
}

/**
 * A Cook Log with state: an append lands in it, and a later read sees it. A
 * read takes its snapshot when called and answers after `readDelayMs`; the
 * first read can also be held until `holdFirstRead` settles.
 */
function liveSheet(
  initial: string[][],
  {
    readDelayMs = 0,
    holdFirstRead,
  }: { readDelayMs?: number; holdFirstRead?: Promise<void> } = {},
) {
  const rows = initial.map((r) => [...r]);
  const appended: string[][] = [];
  const puts: string[] = [];
  let reads = 0;
  mockFetch.mockImplementation(async (url: string, init?: RequestInit) => {
    if (init?.method === "POST") {
      const [values] = JSON.parse(String(init.body)).values as string[][];
      rows.push(values);
      appended.push(values);
      return ok({
        updates: { updatedRange: `'Cook Log'!A${rows.length}:E${rows.length}` },
      });
    }
    if (init?.method === "PUT") {
      puts.push(decodeURIComponent(url));
      return ok({});
    }
    const snapshot = rows.map((r) => [...r]);
    reads += 1;
    if (reads === 1 && holdFirstRead) await holdFirstRead;
    await new Promise((resolve) => setTimeout(resolve, readDelayMs));
    return ok({ values: snapshot });
  });
  return { rows, appended, puts };
}

describe("cookLogStatus", () => {
  const completed = {
    status: "completed" as const,
    completedAt: DONE,
    cookLog: null,
    cookLogError: null,
    cookLogClaimedAt: null,
  };

  it("is writing while a write holds its claim, over an earlier error", () => {
    const claimed = {
      ...completed,
      cookLogError: "Cook Log API 503",
      cookLogClaimedAt: minutesAfterDone(10),
    };
    expect(cookLogStatus(claimed, minutesAfterDone(11))).toBe("writing");
    const expiry = new Date(minutesAfterDone(10).getTime() + LOST_WRITE_MS);
    expect(cookLogStatus(claimed, expiry)).toBe("writing");
    expect(cookLogStatus(claimed, new Date(expiry.getTime() + 1))).toBe("failed");
  });

  it("is failed once a claim with nothing stored has expired", () => {
    const claimed = { ...completed, cookLogClaimedAt: minutesAfterDone(10) };
    expect(cookLogStatus(claimed, minutesAfterDone(13))).toBe("failed");
  });

  it("reads a serialized claim", () => {
    const claimed = {
      ...completed,
      cookLogClaimedAt: minutesAfterDone(10).toISOString(),
    };
    expect(cookLogStatus(claimed, minutesAfterDone(11))).toBe("writing");
  });

  it("is writing at 0 and 1 minutes, failed at 3 with nothing stored", () => {
    expect(cookLogStatus(completed, minutesAfterDone(0))).toBe("writing");
    expect(cookLogStatus(completed, minutesAfterDone(1))).toBe("writing");
    expect(cookLogStatus(completed, minutesAfterDone(3))).toBe("failed");
  });

  it("turns failed just past the lost-write limit", () => {
    const at = new Date(DONE.getTime() + LOST_WRITE_MS);
    expect(cookLogStatus(completed, at)).toBe("writing");
    expect(cookLogStatus(completed, new Date(at.getTime() + 1))).toBe("failed");
  });

  it("is logged with a row and failed with an error, at any time", () => {
    const now = minutesAfterDone(0);
    expect(cookLogStatus({ ...completed, cookLog: LOG }, now)).toBe("logged");
    expect(cookLogStatus({ ...completed, cookLogError: "HTTP 403" }, now)).toBe(
      "failed",
    );
  });

  it("reads a serialized completedAt", () => {
    expect(
      cookLogStatus(
        { ...completed, completedAt: DONE.toISOString() },
        minutesAfterDone(3),
      ),
    ).toBe("failed");
  });

  it("is none for an item that isn't a completed cook", () => {
    expect(cookLogStatus({ ...completed, status: "cooking" })).toBe("none");
    expect(cookLogStatus({ ...completed, completedAt: null })).toBe("none");
  });
});

describe("logCook", () => {
  it("appends the cook at its completion time and stores the row", async () => {
    const id = await completedItem({ cookLogError: "earlier failure" });
    sheetAccepting([HEADER, ["2026-10-04 12:00", "Mole", "Mole", "", ""]]);

    const outcome = await logCook(id);

    const log = { ...LOG, row: 3 };
    expect(outcome).toEqual({ status: "logged", log });
    const after = await item(id);
    expect(after.cookLog).toEqual(log);
    expect(after.cookLogError).toBeNull();
    const [, init] = mockFetch.mock.calls[1];
    expect(JSON.parse((init as RequestInit).body as string)).toEqual({
      values: [["2026-10-04 19:02", "Dal", "Dal", "", ""]],
    });
  });

  it("adopts the row another writer already wrote that day", async () => {
    const id = await completedItem();
    mockFetch.mockResolvedValueOnce(
      ok({ values: [HEADER, ["2026-10-04 18:30", "dal", "dal", "", ""]] }),
    );

    const outcome = await logCook(id);

    expect(outcome).toEqual({
      status: "logged",
      log: { row: 2, timestamp: "2026-10-04 18:30", recipeName: "dal", adopted: true },
    });
    expect(mockFetch).toHaveBeenCalledTimes(1);
  });

  it("stores a failure of the log as the error and returns it", async () => {
    const id = await completedItem();
    mockFetch
      .mockResolvedValueOnce(ok({ values: [HEADER] }))
      .mockResolvedValueOnce(refused(403, "The caller does not have permission"));

    const outcome = await logCook(id);

    expect(outcome).toEqual({
      status: "failed",
      error: "Cook Log API 403: The caller does not have permission",
    });
    const after = await item(id);
    expect(after.cookLogError).toBe(
      "Cook Log API 403: The caller does not have permission",
    );
    expect(after.cookLog).toBeNull();
  });

  it("stores 'no recipe name' for an item without one, calling nothing", async () => {
    const id = await completedItem({
      recipeData: null,
      recipeNotionId: "notion-page",
    });

    expect(await logCook(id)).toEqual({ status: "failed", error: "no recipe name" });
    expect((await item(id)).cookLogError).toBe("no recipe name");
    expect(mockFetch).not.toHaveBeenCalled();
  });

  it("returns a stored row without writing again", async () => {
    const id = await completedItem({ cookLog: LOG });

    expect(await logCook(id)).toEqual({ status: "logged", log: LOG });
    expect(mockFetch).not.toHaveBeenCalled();
  });

  it("throws for an item that isn't a completed cook", async () => {
    const id = await completedItem({ status: "cooking", completedAt: null });

    await expect(logCook(id)).rejects.toThrow("is not a completed cook");
  });

  it("releases its claim with the outcome, a row or an error", async () => {
    const logged = await completedItem();
    sheetAccepting([HEADER, HEADER, HEADER]);
    await logCook(logged, minutesAfterDone(0));
    expect((await item(logged)).cookLogClaimedAt).toBeNull();

    const failed = await completedItem();
    mockFetch.mockResolvedValueOnce(refused(503, "unavailable"));
    await logCook(failed, minutesAfterDone(0));
    const after = await item(failed);
    expect(after.cookLogError).toBe("Cook Log API 503: unavailable");
    expect(after.cookLogClaimedAt).toBeNull();
  });

  it("is a writing conflict, calling nothing, while another write holds the claim", async () => {
    const id = await completedItem({
      cookLogError: "Cook Log API 503",
      cookLogClaimedAt: minutesAfterDone(5),
    });

    await expect(logCook(id, minutesAfterDone(6))).rejects.toMatchObject({
      reason: "writing",
    });
    expect(mockFetch).not.toHaveBeenCalled();
    expect((await item(id)).cookLogError).toBe("Cook Log API 503");
  });

  it("takes over a claim older than the lost-write limit", async () => {
    const id = await completedItem({ cookLogClaimedAt: minutesAfterDone(5) });
    sheetAccepting([HEADER, HEADER, HEADER]);

    expect(await logCook(id, minutesAfterDone(8))).toEqual({
      status: "logged",
      log: LOG,
    });
  });

  it("holds a claim exactly LOST_WRITE_MS old, and takes it a millisecond later", async () => {
    const claimed = minutesAfterDone(5);
    const id = await completedItem({ cookLogClaimedAt: claimed });
    sheetAccepting([HEADER, HEADER, HEADER]);
    const expiry = new Date(claimed.getTime() + LOST_WRITE_MS);

    await expect(logCook(id, expiry)).rejects.toMatchObject({ reason: "writing" });
    expect(mockFetch).not.toHaveBeenCalled();

    expect(await logCook(id, new Date(expiry.getTime() + 1))).toEqual({
      status: "logged",
      log: LOG,
    });
  });

  it("claims a cook whose completed_at carries microseconds", async () => {
    // The database clock stamps Done in microseconds; the item is read in ms,
    // truncated. .123999 truncates to .123 but rounds to .124, so a claim
    // that rounded would never match the read.
    const id = await completedItem();
    await client.query(
      "update kitchen_queue set completed_at = '2026-10-04 23:02:00.123999+00' where id = $1",
      [id],
    );
    sheetAccepting([HEADER, HEADER, HEADER]);

    expect(await logCook(id, minutesAfterDone(1))).toEqual({
      status: "logged",
      log: LOG,
    });
  });

  it("is not found for an id with no queue item", async () => {
    await expect(logCook(MISSING)).rejects.toBeInstanceOf(CookLogItemNotFound);
  });
});

describe("the item changes between the write's read and its claim", () => {
  it("a cook reopened and finished again isn't claimed: nothing is written for it", async () => {
    const id = await completedItem();
    const sheet = liveSheet([HEADER]);
    await afterNextRead(reopenAndFinish);

    await expect(logCook(id, minutesAfterDone(1))).rejects.toMatchObject({
      reason: "not-completed",
      message: expect.stringMatching(/reopened before its Cook Log write started/),
    });
    expect(mockFetch).not.toHaveBeenCalled();
    const between = await item(id);
    expect(between.cookLog).toBeNull();
    expect(between.cookLogClaimedAt).toBeNull();

    // The new cook's own write lands its own row, at its own time.
    const outcome = await logCook(id);
    expect(outcome.status).toBe("logged");
    expect(sheet.appended).toHaveLength(1);
    expect(sheet.appended[0][0]).not.toBe("2026-10-04 19:02");
    expect((await item(id)).cookLog).toEqual(
      (outcome as { log: unknown }).log,
    );
  });

  it("a cook reopened (not finished again) is not-completed, calling nothing", async () => {
    const id = await completedItem();
    await afterNextRead(reopen);

    await expect(logCook(id, minutesAfterDone(1))).rejects.toMatchObject({
      reason: "not-completed",
    });
    expect(mockFetch).not.toHaveBeenCalled();
  });

  it("a row stored meanwhile for the same cook is the answer, calling nothing", async () => {
    const id = await completedItem();
    await afterNextRead((queueId) =>
      db.update(kitchenQueue).set({ cookLog: LOG }).where(eq(kitchenQueue.id, queueId)),
    );

    expect(await logCook(id, minutesAfterDone(1))).toEqual({
      status: "logged",
      log: LOG,
    });
    expect(mockFetch).not.toHaveBeenCalled();
  });

  it("a retry, for a cook finished again since it read, is not-completed, calling nothing", async () => {
    const id = await completedItem({ cookLogError: "Cook Log API 503" });
    await afterNextRead(reopenAndFinish);

    await expect(retryCookLog(id)).rejects.toMatchObject({
      reason: "not-completed",
    });
    expect(mockFetch).not.toHaveBeenCalled();
    expect((await item(id)).cookLogClaimedAt).toBeNull();
  });

  it("a rating from failed, for a cook finished again since it read, is CONFLICT not-completed", async () => {
    const id = await completedItem({ cookLogError: "Cook Log API 503" });
    // Skip the router's ownership check read so the race lands between rateCook's read and its claim.
    await afterNextRead(reopenAndFinish, 1);

    const error = await router
      .rateCook({ queueId: id, rating: 2 })
      .catch((e: unknown) => e);

    expect(error).toBeInstanceOf(TRPCError);
    expect(error).toMatchObject({ code: "CONFLICT", message: "not-completed" });
    expect(mockFetch).not.toHaveBeenCalled();
    const after = await item(id);
    expect(after.cookLog).toBeNull();
    expect(after.ratingClosedAt).toBeNull();
  });

  it("a move's claim does not land on a row moved to another kitchen after the follow read", async () => {
    const { kitchen: other } = await seedKitchen(db, {
      slug: "other-kitchen",
      name: "Other",
    });
    // A cook log stamped at a time other than the finish time, so logging has to move the row.
    const id = await completedItem({
      cookLog: { ...LOG, timestamp: "2026-10-04 18:00" },
    });
    let afterMove: unknown = null;
    // Skip logCook's own read; move the row to the other kitchen right after the next one,
    // which is the read the move makes before it claims the row.
    await afterNextRead(async (queueId) => {
      await db
        .update(kitchenQueue)
        .set({ kitchenId: other.id })
        .where(eq(kitchenQueue.id, queueId));
      afterMove = (
        await db.select().from(kitchenQueue).where(eq(kitchenQueue.id, queueId))
      )[0];
    }, 1);

    await expect(logCook(id, minutesAfterDone(1))).rejects.toThrow();

    expect(afterMove).not.toBeNull();
    expect(
      (await db.select().from(kitchenQueue).where(eq(kitchenQueue.id, id)))[0],
    ).toEqual(afterMove);
    expect(mockFetch).not.toHaveBeenCalled();
  });
});

describe("logCookInBackground", () => {
  it("never rejects: a failure of the log is stored and logged", async () => {
    const id = await completedItem();
    const logged = vi.spyOn(console, "error").mockImplementation(() => {});
    mockFetch.mockRejectedValueOnce(new Error("network down"));

    await expect(logCookInBackground(id)).resolves.toBeUndefined();

    expect((await item(id)).cookLogError).toBe("network down");
    expect(logged).toHaveBeenCalledWith(
      `Cook Log write failed for queue item ${id}: network down`,
    );
  });

  it("skips quietly while another write holds the claim", async () => {
    const id = await completedItem({ cookLogClaimedAt: new Date() });
    const info = vi.spyOn(console, "info").mockImplementation(() => {});
    const error = vi.spyOn(console, "error").mockImplementation(() => {});

    await expect(logCookInBackground(id)).resolves.toBeUndefined();

    expect(info).toHaveBeenCalledExactlyOnceWith(
      `Cook Log write skipped for queue item ${id}: another write holds it`,
    );
    expect(error).not.toHaveBeenCalled();
    expect(mockFetch).not.toHaveBeenCalled();
  });

  it("never rejects: a missing item is logged", async () => {
    const logged = vi.spyOn(console, "error").mockImplementation(() => {});

    await expect(
      logCookInBackground("00000000-0000-4000-8000-000000000000"),
    ).resolves.toBeUndefined();
    expect(logged).toHaveBeenCalledOnce();
  });
});

describe("retryCookLog", () => {
  it("refuses while the first write may still be running", async () => {
    const id = await completedItem();

    expect(await retryCookLog(id, minutesAfterDone(1))).toEqual({
      status: "writing",
    });
    expect(mockFetch).not.toHaveBeenCalled();
  });

  it("writes from failed: a stored error", async () => {
    const id = await completedItem({ cookLogError: "Cook Log API 503" });
    sheetAccepting([HEADER, HEADER, HEADER]);

    expect(await retryCookLog(id, minutesAfterDone(1))).toEqual({
      status: "logged",
      log: LOG,
    });
    expect((await item(id)).cookLog).toEqual(LOG);
  });

  it("writes from failed: a lost write", async () => {
    const id = await completedItem();
    sheetAccepting([HEADER, HEADER, HEADER]);

    expect((await retryCookLog(id, minutesAfterDone(3))).status).toBe("logged");
  });

  it("returns the row of a logged item without writing", async () => {
    const id = await completedItem({ cookLog: LOG });

    expect(await retryCookLog(id)).toEqual({ status: "logged", log: LOG });
    expect(mockFetch).not.toHaveBeenCalled();
  });

  it("returns another failure as an outcome", async () => {
    const id = await completedItem({ cookLogError: "Cook Log API 503" });
    mockFetch.mockResolvedValueOnce(refused(503, "unavailable"));

    expect(await retryCookLog(id)).toEqual({
      status: "failed",
      error: "Cook Log API 503: unavailable",
    });
  });

  it("is a conflict for an item that isn't a completed cook", async () => {
    const id = await completedItem({ status: "cooking", completedAt: null });

    await expect(retryCookLog(id)).rejects.toMatchObject({
      reason: "not-completed",
    });
  });

  it("is not found for an id with no queue item", async () => {
    await expect(retryCookLog(MISSING)).rejects.toBeInstanceOf(
      CookLogItemNotFound,
    );
  });
});

describe("rateCook", () => {
  /** The whole log, with `row4` at row 4 (LOG's row). */
  function logWith(row4: string[]) {
    return ok({
      values: [HEADER, ["2026-10-02 18:00", "Rice"], ["2026-10-03 18:00", "Soup"], row4],
    });
  }

  it("rates the stored row and closes the ask", async () => {
    const id = await completedItem({ cookLog: LOG });
    mockFetch
      .mockResolvedValueOnce(logWith(["2026-10-04 19:02", "Dal"]))
      .mockResolvedValueOnce(ok({}));

    expect(await rateCook({ queueId: id, rating: 4, notes: "more salt" })).toEqual(
      { rated: true, log: LOG },
    );
    const [, init] = mockFetch.mock.calls[1];
    expect(JSON.parse((init as RequestInit).body as string)).toEqual({
      values: [["4", "more salt"]],
    });
    expect((await item(id)).ratingClosedAt).toBeInstanceOf(Date);
  });

  it("from failed, writes the row first, then rates it", async () => {
    const id = await completedItem({ cookLogError: "Cook Log API 503" });
    sheetAccepting([HEADER, HEADER, HEADER]);
    mockFetch
      .mockResolvedValueOnce(logWith(["2026-10-04 19:02", "Dal"]))
      .mockResolvedValueOnce(ok({}));

    expect(await rateCook({ queueId: id, rating: 5 })).toEqual({
      rated: true,
      log: LOG,
    });
    const after = await item(id);
    expect(after.cookLog).toEqual(LOG);
    expect(after.cookLogError).toBeNull();
    expect(after.ratingClosedAt).toBeInstanceOf(Date);
  });

  it("from failed, a second failed write leaves the ask open", async () => {
    const id = await completedItem({ cookLogError: "Cook Log API 503" });
    mockFetch.mockResolvedValueOnce(refused(503, "unavailable"));

    expect(await rateCook({ queueId: id, rating: 5 })).toEqual({
      rated: false,
      error: "Cook Log API 503: unavailable",
    });
    expect((await item(id)).ratingClosedAt).toBeNull();
  });

  it("is a conflict while the first write may still be running", async () => {
    const id = await completedItem();

    const error = await rateCook({ queueId: id, rating: 4 }, minutesAfterDone(1))
      .catch((e: unknown) => e);

    expect(error).toBeInstanceOf(CookLogConflict);
    expect((error as CookLogConflict).reason).toBe("writing");
    expect(mockFetch).not.toHaveBeenCalled();
  });

  it("stores the re-found row when the sheet moved", async () => {
    const id = await completedItem({ cookLog: LOG });
    mockFetch
      .mockResolvedValueOnce(
        ok({
          values: [
            HEADER,
            ["2026-10-04 19:02", "Dal"],
            ["2026-10-04 12:00", "Mole"],
            ["2026-10-04 12:00", "Mole"],
          ],
        }),
      )
      .mockResolvedValueOnce(ok({}));

    expect(await rateCook({ queueId: id, rating: 3 })).toEqual({
      rated: true,
      log: { ...LOG, row: 2 },
    });
    expect((await item(id)).cookLog).toEqual({ ...LOG, row: 2 });
  });

  it("is a row-moved conflict when no single row holds the cook", async () => {
    const id = await completedItem({ cookLog: LOG });
    mockFetch.mockResolvedValueOnce(logWith(["2026-10-04 12:00", "Mole"]));

    await expect(rateCook({ queueId: id, rating: 3 })).rejects.toMatchObject({
      reason: "row-moved",
    });
    const after = await item(id);
    expect(after.ratingClosedAt).toBeNull();
    expect(after.cookLog).toEqual(LOG);
  });

  it("returns a failed rating write and leaves the ask open", async () => {
    const id = await completedItem({ cookLog: LOG });
    vi.spyOn(console, "error").mockImplementation(() => {});
    mockFetch
      .mockResolvedValueOnce(logWith(["2026-10-04 19:02", "Dal"]))
      .mockResolvedValueOnce(refused(403, "read-only"));

    expect(await rateCook({ queueId: id, rating: 3 })).toEqual({
      rated: false,
      error: "Cook Log API 403: read-only",
    });
    expect((await item(id)).ratingClosedAt).toBeNull();
  });

  it("is a conflict for an item that isn't a completed cook", async () => {
    const id = await completedItem({ status: "pending", completedAt: null });

    await expect(rateCook({ queueId: id, rating: 3 })).rejects.toMatchObject({
      reason: "not-completed",
    });
  });

  it("is not found for an id with no queue item", async () => {
    await expect(
      rateCook({ queueId: MISSING, rating: 3 }),
    ).rejects.toBeInstanceOf(CookLogItemNotFound);
  });

  it("leaves a cook reopened and finished again during the rating alone", async () => {
    const id = await completedItem({ cookLog: LOG });
    let redone = false;
    mockFetch.mockImplementation(async (_url: string, init?: RequestInit) => {
      if (init?.method === "PUT") {
        // While the rating is in flight the cook is reopened and Done again:
        // a new cook, whose own write and ask start fresh.
        await updateQueueStatus(id, "cooking");
        redone = (await updateQueueStatus(id, "completed")).completed;
        return ok({});
      }
      return logWith(["2026-10-04 19:02", "Dal"]);
    });

    expect(await rateCook({ queueId: id, rating: 5 })).toEqual({
      rated: true,
      log: LOG,
    });
    expect(redone).toBe(true);
    const after = await item(id);
    expect(after.cookLog).toBeNull();
    expect(after.ratingClosedAt).toBeNull();
  });
});

describe("rateCook, reopened during the rating", () => {
  it("leaves the ask open on a cook reopened (not finished again) during the rating", async () => {
    const id = await completedItem({ cookLog: LOG });
    mockFetch.mockImplementation(async (_url: string, init?: RequestInit) => {
      if (init?.method === "PUT") {
        await reopen(id);
        return ok({});
      }
      return ok({ values: [HEADER, [], [], ["2026-10-04 19:02", "Dal"]] });
    });

    expect(await rateCook({ queueId: id, rating: 5 })).toEqual({
      rated: true,
      log: LOG,
    });
    const after = await item(id);
    expect(after.status).toBe("cooking");
    expect(after.cookLog).toEqual(LOG);
    expect(after.ratingClosedAt).toBeNull();
  });
});

describe("two writers at once", () => {
  const now = minutesAfterDone(1);
  const ROW2 = { ...LOG, row: 2 };

  it("a double retry from failed appends once", async () => {
    const id = await completedItem({ cookLogError: "Cook Log API 503" });
    const sheet = liveSheet([HEADER], { readDelayMs: 20 });

    const outcomes = await Promise.all([
      retryCookLog(id, now),
      retryCookLog(id, now),
    ]);

    expect(sheet.appended).toHaveLength(1);
    expect(outcomes).toContainEqual({ status: "logged", log: ROW2 });
    expect(outcomes).toContainEqual({ status: "writing" });
    expect((await item(id)).cookLog).toEqual(ROW2);
  });

  it("a retry and a rating from failed append once", async () => {
    const id = await completedItem({ cookLogError: "Cook Log API 503" });
    const sheet = liveSheet([HEADER], { readDelayMs: 20 });

    const [retried, rated] = await Promise.allSettled([
      retryCookLog(id, now),
      rateCook({ queueId: id, rating: 4 }, now),
    ]);

    expect(sheet.appended).toHaveLength(1);
    if (retried.status === "fulfilled" && retried.value.status === "logged") {
      expect(retried.value).toEqual({ status: "logged", log: ROW2 });
      expect(rated).toMatchObject({
        status: "rejected",
        reason: { reason: "writing" },
      });
      expect(sheet.puts).toHaveLength(0);
    } else {
      expect(retried).toEqual({
        status: "fulfilled",
        value: { status: "writing" },
      });
      expect(rated).toEqual({
        status: "fulfilled",
        value: { rated: true, log: ROW2 },
      });
    }
    expect((await item(id)).cookLog).toEqual(ROW2);
  });

  it("a double retry after a lost write appends once", async () => {
    const id = await completedItem();
    const sheet = liveSheet([HEADER], { readDelayMs: 20 });
    const later = minutesAfterDone(3);

    const outcomes = await Promise.all([
      retryCookLog(id, later),
      retryCookLog(id, later),
    ]);

    expect(sheet.appended).toHaveLength(1);
    expect(outcomes).toContainEqual({ status: "logged", log: ROW2 });
    expect(outcomes).toContainEqual({ status: "writing" });
  });

  it("a writer that outlived its claim doesn't overwrite the row stored since", async () => {
    const id = await completedItem();
    let release!: () => void;
    const held = new Promise<void>((resolve) => (release = resolve));
    const sheet = liveSheet([HEADER], { holdFirstRead: held });

    // A claims at +3 (the first write was lost) and stalls reading an empty log.
    const stale = retryCookLog(id, minutesAfterDone(3));
    await vi.waitFor(() => expect(mockFetch).toHaveBeenCalledTimes(1));
    // Past A's claim, B takes over, appends and stores its row.
    expect(await retryCookLog(id, minutesAfterDone(6))).toEqual({
      status: "logged",
      log: ROW2,
    });
    // A wakes, still holding an empty log, and appends a second row.
    release();
    const outcome = await stale;

    expect(sheet.appended).toHaveLength(2);
    expect(outcome).toEqual({ status: "logged", log: ROW2 });
    expect((await item(id)).cookLog).toEqual(ROW2);
  });

  it("a writer that outlived its claim doesn't release the claim taken since", async () => {
    const id = await completedItem();
    const gates = [Promise.withResolvers<void>(), Promise.withResolvers<void>()];
    let reads = 0;
    mockFetch.mockImplementation(async (_url: string, init?: RequestInit) => {
      if (init?.method === "POST") {
        return ok({ updates: { updatedRange: "'Cook Log'!A2:E2" } });
      }
      const gate = gates[reads++];
      await gate.promise;
      return gate === gates[0] ? refused(503, "unavailable") : ok({ values: [HEADER] });
    });

    // A claims at +3 and stalls; B takes over at +6 and stalls too.
    const stale = retryCookLog(id, minutesAfterDone(3));
    await vi.waitFor(() => expect(mockFetch).toHaveBeenCalledTimes(1));
    const current = retryCookLog(id, minutesAfterDone(6));
    await vi.waitFor(() => expect(mockFetch).toHaveBeenCalledTimes(2));
    // A fails: its error must not free B's claim, or a third write could start.
    gates[0].resolve();
    expect(await stale).toEqual({
      status: "failed",
      error: "Cook Log API 503: unavailable",
    });
    const during = await item(id);
    expect(during.cookLogError).toBeNull();
    expect(new Date(during.cookLogClaimedAt!)).toEqual(minutesAfterDone(6));
    expect(cookLogStatus(during, minutesAfterDone(7))).toBe("writing");

    gates[1].resolve();
    expect(await current).toEqual({ status: "logged", log: ROW2 });
    expect((await item(id)).cookLogClaimedAt).toBeNull();
  });

  it("a writer that outlived its claim, finishing while the new claim runs, stores nothing", async () => {
    const id = await completedItem();
    const gates = [Promise.withResolvers<void>(), Promise.withResolvers<void>()];
    let reads = 0;
    let appends = 0;
    mockFetch.mockImplementation(async (_url: string, init?: RequestInit) => {
      if (init?.method === "POST") {
        appends += 1;
        return ok({ updates: { updatedRange: `'Cook Log'!A${appends + 1}:E${appends + 1}` } });
      }
      await gates[reads++].promise;
      return ok({ values: [HEADER] });
    });

    // A claims at +3 and stalls; B takes over at +6 and stalls too.
    const stale = retryCookLog(id, minutesAfterDone(3));
    await vi.waitFor(() => expect(mockFetch).toHaveBeenCalledTimes(1));
    const current = retryCookLog(id, minutesAfterDone(6));
    await vi.waitFor(() => expect(mockFetch).toHaveBeenCalledTimes(2));
    // A appends, but its claim is B's now: it stores nothing and says so.
    gates[0].resolve();
    expect(await stale).toEqual({ status: "writing" });
    const during = await item(id);
    expect(during.cookLog).toBeNull();
    expect(new Date(during.cookLogClaimedAt!)).toEqual(minutesAfterDone(6));

    gates[1].resolve();
    expect(await current).toEqual({ status: "logged", log: { ...ROW2, row: 3 } });
    expect((await item(id)).cookLog).toEqual({ ...ROW2, row: 3 });
  });

  describe("the cook is reopened and finished again while its write is in flight", () => {
    const NEXT_DAY = new Date(DONE.getTime() + 24 * 60 * 60 * 1000);
    const NEW_COOK = {
      row: 2,
      timestamp: "2026-10-05 19:02",
      recipeName: "Dal",
      adopted: false,
    };

    /**
     * The first cook's write claims and stalls reading the log; meanwhile the
     * cook is reopened and Done again. The new cook is pinned to the next day,
     * so its write appends its own row rather than adopting the old one.
     */
    async function staleWriteAcrossRedone() {
      const id = await completedItem();
      const held = Promise.withResolvers<void>();
      const sheet = liveSheet([HEADER], { holdFirstRead: held.promise });
      const stale = logCook(id, minutesAfterDone(1));
      // Settle it now so an early rejection isn't unhandled while held.
      const settled = stale.then(
        (value) => ({ ok: true as const, value }),
        (error: unknown) => ({ ok: false as const, error }),
      );
      await vi.waitFor(() => expect(mockFetch).toHaveBeenCalledTimes(1));

      await updateQueueStatus(id, "cooking");
      expect((await updateQueueStatus(id, "completed")).completed).toBe(true);
      await client.query("update kitchen_queue set completed_at = $1 where id = $2", [
        NEXT_DAY.toISOString(),
        id,
      ]);
      return { id, sheet, settled, release: held.resolve };
    }

    it("the old write stores nothing, and the new cook's own write lands", async () => {
      const { id, sheet, settled, release } = await staleWriteAcrossRedone();

      // The old write wakes and appends the first cook's row, but must not
      // store it on the new cook.
      release();
      const outcome = await settled;
      expect(outcome.ok).toBe(false);
      expect((outcome as { error: unknown }).error).toMatchObject({
        reason: "not-completed",
        message: expect.stringMatching(/was reopened while its Cook Log row was written/),
      });
      const between = await item(id);
      expect(between.cookLog).toBeNull();
      expect(between.cookLogError).toBeNull();
      expect(between.cookLogClaimedAt).toBeNull();

      // The new cook's write: its own row, at its own time.
      const own = { ...NEW_COOK, row: 3 };
      expect(await logCook(id, new Date(NEXT_DAY.getTime() + 60_000))).toEqual({
        status: "logged",
        log: own,
      });
      expect(sheet.appended.map((r) => r[0])).toEqual([
        "2026-10-04 19:02",
        "2026-10-05 19:02",
      ]);
      expect((await item(id)).cookLog).toEqual(own);
    });

    it("when the new cook's row lands first, the old write doesn't answer with it", async () => {
      const { id, sheet, settled, release } = await staleWriteAcrossRedone();

      expect(await logCook(id, new Date(NEXT_DAY.getTime() + 60_000))).toEqual({
        status: "logged",
        log: NEW_COOK,
      });
      // A rating behind the old write would otherwise rate the new cook's row.
      release();
      const outcome = await settled;
      expect(outcome.ok).toBe(false);
      expect((outcome as { error: unknown }).error).toMatchObject({
        reason: "not-completed",
        message: expect.stringMatching(/was reopened while its Cook Log row was written/),
      });

      expect(sheet.appended).toHaveLength(2);
      expect((await item(id)).cookLog).toEqual(NEW_COOK);
    });

    it("a rating behind the old write is CONFLICT not-completed, rating nothing", async () => {
      const id = await completedItem({ cookLogError: "Cook Log API 503" });
      const held = Promise.withResolvers<void>();
      const sheet = liveSheet([HEADER], { holdFirstRead: held.promise });
      const rating = router
        .rateCook({ queueId: id, rating: 1, notes: "the earlier cook" })
        .catch((e: unknown) => e);
      await vi.waitFor(() => expect(mockFetch).toHaveBeenCalledTimes(1));

      await reopenAndFinish(id);
      held.resolve();

      const error = await rating;
      expect(error).toBeInstanceOf(TRPCError);
      expect(error).toMatchObject({ code: "CONFLICT", message: "not-completed" });
      expect(sheet.appended).toHaveLength(1);
      expect(sheet.puts).toHaveLength(0);
      const after = await item(id);
      expect(after.cookLog).toBeNull();
      expect(after.ratingClosedAt).toBeNull();
    });
  });
});

describe("openCookAsk", () => {
  /** Half an hour after DONE: 19:32 in New York, the same evening. */
  const EVENING = minutesAfterDone(30);

  /** The whole log, with `row4` at row 4 (LOG's row). */
  function logWith(row4: string[]) {
    return ok({
      values: [HEADER, ["2026-10-02 18:00", "Rice"], ["2026-10-03 18:00", "Soup"], row4],
    });
  }

  it("is null with no cook finished today", async () => {
    expect(await openCookAsk("cook", EVENING)).toBeNull();
    expect(mockFetch).not.toHaveBeenCalled();
  });

  it("holds the latest cook finished today whose ask is open", async () => {
    await completedItem({ completedAt: minutesAfterDone(-60), cookLogError: "Cook Log API 503" });
    const latest = await completedItem({
      recipeData: { name: "Mole" },
      completedAt: minutesAfterDone(-5),
      cookLogError: "Cook Log API 503",
    });
    await completedItem({ completedAt: minutesAfterDone(-1), ratingClosedAt: DONE });

    expect(await openCookAsk("cook", EVENING)).toEqual({
      queueId: latest,
      name: "Mole",
      state: "failed",
    });
  });

  it("asks of each cook in turn: once the latest closes, the one before", async () => {
    const earlier = await completedItem({ completedAt: minutesAfterDone(-60), cookLogError: "x" });
    const latest = await completedItem({ completedAt: minutesAfterDone(-5), cookLogError: "x" });

    expect((await openCookAsk("cook", EVENING))?.queueId).toBe(latest);
    await dismissCookAsk(latest);
    expect((await openCookAsk("cook", EVENING))?.queueId).toBe(earlier);
  });

  it("leaves out another kitchen's cooks, and cooks not finished", async () => {
    const { kitchen: other } = await seedKitchen(db, {
      slug: "other-kitchen",
      name: "Other Kitchen",
    });
    await completedItem({ kitchenId: other.id, cookLogError: "x" });
    await completedItem({ status: "cooking", completedAt: null });
    await completedItem({ status: "pending", completedAt: null });

    expect(await openCookAsk("cook", EVENING)).toBeNull();
  });

  it("goes at midnight in New York, not UTC", async () => {
    // DONE is 23:02 UTC: UTC's midnight comes first, an hour later.
    const id = await completedItem({ cookLogError: "x" });
    expect((await openCookAsk("cook", new Date("2026-10-05T00:30:00Z")))?.queueId).toBe(id);
    expect((await openCookAsk("cook", new Date("2026-10-05T03:59:00Z")))?.queueId).toBe(id);
    expect(await openCookAsk("cook", new Date("2026-10-05T04:00:00Z"))).toBeNull();
  });

  it("says writing while the first write may still be running, and reads no sheet", async () => {
    const id = await completedItem();

    expect(await openCookAsk("cook", minutesAfterDone(1))).toEqual({
      queueId: id,
      name: "Dal",
      state: "writing",
    });
    expect(mockFetch).not.toHaveBeenCalled();
  });

  it("says logged when the row has no rating yet, from one read of the sheet", async () => {
    const id = await completedItem({ cookLog: LOG });
    mockFetch.mockResolvedValueOnce(logWith(["2026-10-04 19:02", "Dal", "Dal", ""]));

    expect(await openCookAsk("cook", EVENING)).toEqual({ queueId: id, name: "Dal", state: "logged" });
    expect(mockFetch).toHaveBeenCalledTimes(1);
    expect((await item(id)).ratingClosedAt).toBeNull();
  });

  it("closes the ask of a cook rated by another writer, storing where the row was found", async () => {
    const id = await completedItem({ cookLog: LOG });
    mockFetch.mockResolvedValueOnce(
      ok({ values: [HEADER, ["2026-10-04 19:02", "Dal", "Dal", "5", "rated elsewhere"]] }),
    );

    expect(await openCookAsk("cook", EVENING)).toBeNull();
    const after = await item(id);
    expect(after.ratingClosedAt).toBeInstanceOf(Date);
    expect(after.cookLog).toEqual({ ...LOG, row: 2 });
  });

  it("after closing a cook rated elsewhere, asks of the one before", async () => {
    const earlier = await completedItem({ completedAt: minutesAfterDone(-60), cookLogError: "x" });
    await completedItem({ cookLog: LOG });
    mockFetch.mockResolvedValueOnce(logWith(["2026-10-04 19:02", "Dal", "Dal", "4"]));

    expect((await openCookAsk("cook", EVENING))?.queueId).toBe(earlier);
  });

  it("says row-moved when no single row holds the cook, and keeps the ask", async () => {
    const id = await completedItem({ cookLog: LOG });
    mockFetch.mockResolvedValueOnce(ok({ values: [HEADER, ["2026-10-04 12:00", "Mole"]] }));

    expect(await openCookAsk("cook", EVENING)).toEqual({ queueId: id, name: "Dal", state: "row-moved" });
    expect((await item(id)).ratingClosedAt).toBeNull();
  });

  it("says unread, keeps the ask and logs, when the sheet can't be read (T follow-up, item 2)", async () => {
    const id = await completedItem({ cookLog: LOG });
    mockFetch.mockResolvedValueOnce(refused(503, "unavailable"));
    const error = vi.spyOn(console, "error").mockImplementation(() => {});

    expect(await openCookAsk("cook", EVENING)).toEqual({ queueId: id, name: "Dal", state: "unread" });
    expect(error).toHaveBeenCalledWith(expect.stringContaining("Cook Log API 503: unavailable"));
    const after = await item(id);
    expect(after.ratingClosedAt).toBeNull();
    expect(after.cookLog).toEqual(LOG);
  });

  it("says unread when the read throws before an answer (a timeout, say)", async () => {
    await completedItem({ cookLog: LOG });
    mockFetch.mockRejectedValueOnce(new DOMException("The operation timed out.", "TimeoutError"));
    vi.spyOn(console, "error").mockImplementation(() => {});

    expect((await openCookAsk("cook", EVENING))?.state).toBe("unread");
  });

  it("is logged again once the sheet reads", async () => {
    const id = await completedItem({ cookLog: LOG });
    mockFetch.mockResolvedValueOnce(refused(503, "unavailable"));
    vi.spyOn(console, "error").mockImplementation(() => {});
    expect((await openCookAsk("cook", EVENING))?.state).toBe("unread");

    mockFetch.mockResolvedValueOnce(logWith(["2026-10-04 19:02", "Dal", "Dal", ""]));
    expect(await openCookAsk("cook", EVENING)).toEqual({ queueId: id, name: "Dal", state: "logged" });
  });

  describe("an unrated row found somewhere else (T follow-up, item 6)", () => {
    /** The cook's row moved up to row 2 (a row above it deleted), unrated. */
    const moved = () => ok({ values: [HEADER, ["2026-10-04 19:02", "Dal", "Dal", ""]] });

    it("keeps where it was found, so the next read finds it there first", async () => {
      const id = await completedItem({ cookLog: LOG });
      mockFetch.mockResolvedValueOnce(moved());

      expect(await openCookAsk("cook", EVENING)).toEqual({ queueId: id, name: "Dal", state: "logged" });
      const after = await item(id);
      expect(after.cookLog).toEqual({ ...LOG, row: 2 });
      expect(after.ratingClosedAt).toBeNull();
    });

    it("stores nothing when the row is where it was", async () => {
      const id = await completedItem({ cookLog: LOG });
      const update = vi.spyOn(db, "update");
      mockFetch.mockResolvedValueOnce(logWith(["2026-10-04 19:02", "Dal", "Dal", ""]));

      expect((await openCookAsk("cook", EVENING))?.state).toBe("logged");
      expect(update).not.toHaveBeenCalled();
      expect((await item(id)).cookLog).toEqual(LOG);
    });

    it("never overwrites a row stored while the sheet was read (a rating, say)", async () => {
      const id = await completedItem({ cookLog: LOG });
      const rated = { ...LOG, row: 3, adopted: true };
      mockFetch.mockImplementationOnce(async () => {
        await db.update(kitchenQueue).set({ cookLog: rated }).where(eq(kitchenQueue.id, id));
        return moved();
      });

      await openCookAsk("cook", EVENING);
      expect((await item(id)).cookLog).toEqual(rated);
    });

    it("never stores onto a cook reopened while the sheet was read", async () => {
      const id = await completedItem({ cookLog: LOG });
      mockFetch.mockImplementationOnce(async () => {
        await reopen(id);
        return moved();
      });

      await openCookAsk("cook", EVENING);
      const after = await item(id);
      expect(after.status).toBe("cooking");
      expect(after.cookLog).toEqual(LOG);
    });

    it("never stores onto a cook whose ask closed while the sheet was read", async () => {
      const id = await completedItem({ cookLog: LOG });
      mockFetch.mockImplementationOnce(async () => {
        await db.update(kitchenQueue).set({ ratingClosedAt: DONE }).where(eq(kitchenQueue.id, id));
        return moved();
      });

      await openCookAsk("cook", EVENING);
      const after = await item(id);
      expect(after.ratingClosedAt).toEqual(DONE);
      expect(after.cookLog).toEqual(LOG);
    });
  });

  it("names no recipe for an item that has none", async () => {
    const id = await completedItem({ recipeData: null, cookLogError: "no recipe name" });

    expect(await openCookAsk("cook", EVENING)).toEqual({ queueId: id, name: null, state: "failed" });
  });
});

describe("dismissCookAsk", () => {
  it("closes the ask, so it isn't asked again", async () => {
    const id = await completedItem({ cookLogError: "x" });

    await dismissCookAsk(id);

    expect((await item(id)).ratingClosedAt).toBeInstanceOf(Date);
    expect(await openCookAsk("cook", minutesAfterDone(30))).toBeNull();
  });

  it("keeps the first close on a second dismiss", async () => {
    const id = await completedItem({ cookLogError: "x", ratingClosedAt: DONE });

    await dismissCookAsk(id);

    expect((await item(id)).ratingClosedAt).toEqual(DONE);
  });

  it("is a conflict for an item that isn't a completed cook", async () => {
    const id = await completedItem({ status: "cooking", completedAt: null });

    await expect(dismissCookAsk(id)).rejects.toMatchObject({ reason: "not-completed" });
    expect((await item(id)).ratingClosedAt).toBeNull();
  });

  it("is not found for an id with no queue item", async () => {
    await expect(dismissCookAsk(MISSING)).rejects.toBeInstanceOf(CookLogItemNotFound);
  });

  it("is reached through the router, answering NOT_FOUND for a missing item", async () => {
    const id = await completedItem({ cookLogError: "x" });

    await expect(router.dismissCookAsk({ queueId: id })).resolves.toEqual({ success: true });
    expect((await item(id)).ratingClosedAt).toBeInstanceOf(Date);
    await expect(router.dismissCookAsk({ queueId: MISSING })).rejects.toMatchObject({ code: "NOT_FOUND" });
  });
});

describe("getCookAsk", () => {
  it("answers the open ask through the router for the session kitchen", async () => {
    // Finished just now: the router asks with the real clock.
    const id = await completedItem({ completedAt: new Date(), cookLogError: "x" });
    const { kitchen: other } = await seedKitchen(db, {
      slug: "other-ask",
      name: "Other Ask",
    });

    expect(await router.getCookAsk({})).toEqual({ queueId: id, name: "Dal", state: "failed" });
    expect(await callerFor(other).getCookAsk({})).toBeNull();
  });
});
