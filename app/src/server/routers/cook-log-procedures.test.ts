/**
 * The Cook Log wiring in the router: a real transition into "completed"
 * schedules one write with `after()`, a repeat Done schedules none, and the
 * retry and rating procedures validate input, answer CONFLICT for the
 * typed conflicts and NOT_FOUND for a missing item. The write itself is tested in `kitchen-cook-log.test.ts`.
 */

import { describe, it, expect, vi, beforeEach } from "vitest";
import { TRPCError } from "@trpc/server";

vi.mock("next/server", async (importOriginal) => ({
  ...(await importOriginal<typeof import("next/server")>()),
  after: vi.fn(),
}));

// The cook-log hook reads connected here; the last block switches it off.
vi.mock("../../lib/hooks/connected", async () => {
  const { HOOK_NAMES } = await import("../../lib/hooks/types");
  return { connected: Object.fromEntries(HOOK_NAMES.map((name) => [name, true])) };
});

vi.mock("../../lib/kitchen-queue", async (importOriginal) => ({
  ...(await importOriginal<typeof import("../../lib/kitchen-queue")>()),
  getQueueItem: vi.fn(),
  updateQueueStatus: vi.fn(),
}));

// A start finishes any cook left on its last screen (cook-fidelity decision 7;
// tested against a database in `kitchen-auto-finish.test.ts`): none here.
vi.mock("../../lib/kitchen-auto-finish", async (importOriginal) => ({
  ...(await importOriginal<typeof import("../../lib/kitchen-auto-finish")>()),
  finishLeftCooks: vi.fn(),
}));

vi.mock("../../lib/kitchen-cook-log", async (importOriginal) => ({
  ...(await importOriginal<typeof import("../../lib/kitchen-cook-log")>()),
  logCookInBackground: vi.fn(),
  rateCook: vi.fn(),
  retryCookLog: vi.fn(),
}));

import { after } from "next/server";
import { getQueueItem, updateQueueStatus } from "../../lib/kitchen-queue";
import { finishLeftCooks } from "../../lib/kitchen-auto-finish";
import {
  CookLogConflict,
  CookLogItemNotFound,
  logCookInBackground,
  rateCook,
  retryCookLog,
} from "../../lib/kitchen-cook-log";
import { connected } from "../../lib/hooks/connected";
import { callerFor } from "../../lib/__tests__/kitchens";

const HOME = { id: "00000000-0000-4000-8000-000000000001", slug: "home" };
const caller = callerFor(HOME);
const QUEUE_ID = "3f1c2a9e-5b7d-4e8f-9a0b-1c2d3e4f5a6b";
const LOG = {
  row: 4,
  timestamp: "2026-10-04 19:02",
  recipeName: "Dal",
  adopted: false,
};

/** Runs what the procedure handed to `after()`, as Next would post-response. */
function runScheduled(): void {
  for (const [task] of vi.mocked(after).mock.calls) {
    (task as () => unknown)();
  }
}

beforeEach(() => {
  vi.clearAllMocks();
  connected["cook-log"] = true;
  vi.mocked(getQueueItem).mockResolvedValue({
    id: QUEUE_ID,
    targetUser: "cook",
  } as never);
});

describe("updateKitchenQueueStatus", () => {
  it("schedules one Cook Log write after a real transition into completed", async () => {
    vi.mocked(updateQueueStatus).mockResolvedValue({ completed: true, started: false });

    await expect(
      caller.updateKitchenQueueStatus({ queueId: QUEUE_ID, status: "completed" }),
    ).resolves.toEqual({ success: true });

    expect(after).toHaveBeenCalledTimes(1);
    expect(logCookInBackground).not.toHaveBeenCalled();
    runScheduled();
    expect(logCookInBackground).toHaveBeenCalledExactlyOnceWith(HOME.id, QUEUE_ID);
  });

  it("schedules nothing for a repeat Done, and still answers success", async () => {
    vi.mocked(updateQueueStatus).mockResolvedValue({ completed: false, started: false });

    await expect(
      caller.updateKitchenQueueStatus({ queueId: QUEUE_ID, status: "completed" }),
    ).resolves.toEqual({ success: true });
    expect(after).not.toHaveBeenCalled();
  });

  it("schedules nothing for a start that leaves no other cook finished", async () => {
    vi.mocked(updateQueueStatus).mockResolvedValue({ completed: false, started: true });
    vi.mocked(finishLeftCooks).mockResolvedValue([]);

    await caller.updateKitchenQueueStatus({ queueId: QUEUE_ID, status: "cooking" });

    expect(updateQueueStatus).toHaveBeenCalledWith(HOME.id, QUEUE_ID, "cooking");
    expect(finishLeftCooks).toHaveBeenCalledWith(HOME.id, QUEUE_ID);
    expect(after).not.toHaveBeenCalled();
  });

  it("finishes no left cook for a repeat start (a retry after a lost answer)", async () => {
    vi.mocked(updateQueueStatus).mockResolvedValue({ completed: false, started: false });

    await caller.updateKitchenQueueStatus({ queueId: QUEUE_ID, status: "cooking" });

    expect(finishLeftCooks).not.toHaveBeenCalled();
  });

  it("schedules nothing when the update fails", async () => {
    vi.mocked(updateQueueStatus).mockRejectedValue(new Error("db down"));

    await expect(
      caller.updateKitchenQueueStatus({ queueId: QUEUE_ID, status: "completed" }),
    ).rejects.toThrow(/db down/);
    expect(after).not.toHaveBeenCalled();
  });
});

describe("retryCookLog", () => {
  it("returns the outcome", async () => {
    vi.mocked(retryCookLog).mockResolvedValue({ status: "logged", log: LOG });

    await expect(caller.retryCookLog({ queueId: QUEUE_ID })).resolves.toEqual({
      status: "logged",
      log: LOG,
    });
    expect(retryCookLog).toHaveBeenCalledWith(HOME.id, QUEUE_ID);
  });

  it("answers CONFLICT with the reason for an unfinished cook", async () => {
    vi.mocked(retryCookLog).mockRejectedValue(
      new CookLogConflict("not-completed", "not finished"),
    );

    await expect(caller.retryCookLog({ queueId: QUEUE_ID })).rejects.toMatchObject({
      code: "CONFLICT",
      message: "not-completed",
    });
  });

  it("rejects an id that is not a uuid", async () => {
    await expect(caller.retryCookLog({ queueId: "abc" })).rejects.toThrow();
    expect(retryCookLog).not.toHaveBeenCalled();
  });

  it("answers NOT_FOUND for an id with no queue item", async () => {
    vi.mocked(retryCookLog).mockRejectedValue(new CookLogItemNotFound(QUEUE_ID));

    await expect(caller.retryCookLog({ queueId: QUEUE_ID })).rejects.toMatchObject({
      code: "NOT_FOUND",
    });
  });
});

describe("rateCook", () => {
  it("passes a valid rating and note through", async () => {
    vi.mocked(rateCook).mockResolvedValue({ rated: true, log: LOG });

    await expect(
      caller.rateCook({ queueId: QUEUE_ID, rating: 5, notes: "x".repeat(500) }),
    ).resolves.toEqual({ rated: true, log: LOG });
    expect(rateCook).toHaveBeenCalledWith(HOME.id, {
      queueId: QUEUE_ID,
      rating: 5,
      notes: "x".repeat(500),
    });
  });

  it("counts the note in characters, after trimming", async () => {
    vi.mocked(rateCook).mockResolvedValue({ rated: true, log: LOG });

    // 500 emoji are 1000 UTF-16 units, and 500 characters.
    await caller.rateCook({ queueId: QUEUE_ID, rating: 4, notes: "🍲".repeat(500) });
    expect(rateCook).toHaveBeenLastCalledWith(HOME.id, {
      queueId: QUEUE_ID,
      rating: 4,
      notes: "🍲".repeat(500),
    });

    await caller.rateCook({
      queueId: QUEUE_ID,
      rating: 4,
      notes: `  ${"x".repeat(498)}     `,
    });
    expect(rateCook).toHaveBeenLastCalledWith(HOME.id, {
      queueId: QUEUE_ID,
      rating: 4,
      notes: "x".repeat(498),
    });
  });

  it.each([
    ["rating 0", { rating: 0 }],
    ["rating 6", { rating: 6 }],
    ["a fractional rating", { rating: 3.5 }],
    ["a 501-character note", { rating: 4, notes: "x".repeat(501) }],
    ["a 501-emoji note", { rating: 4, notes: "🍲".repeat(501) }],
  ])("rejects %s without rating", async (_, input) => {
    const error = await caller
      .rateCook({ queueId: QUEUE_ID, ...input })
      .catch((e: unknown) => e);

    expect(error).toBeInstanceOf(TRPCError);
    expect((error as TRPCError).code).toBe("BAD_REQUEST");
    expect(rateCook).not.toHaveBeenCalled();
  });

  it.each(["writing", "row-moved"] as const)(
    "answers CONFLICT with the reason %s",
    async (reason) => {
      vi.mocked(rateCook).mockRejectedValue(new CookLogConflict(reason, "x"));

      await expect(
        caller.rateCook({ queueId: QUEUE_ID, rating: 4 }),
      ).rejects.toMatchObject({ code: "CONFLICT", message: reason });
    },
  );

  it("answers NOT_FOUND for an id with no queue item", async () => {
    vi.mocked(rateCook).mockRejectedValue(new CookLogItemNotFound(QUEUE_ID));

    await expect(
      caller.rateCook({ queueId: QUEUE_ID, rating: 4 }),
    ).rejects.toMatchObject({ code: "NOT_FOUND" });
  });

  it("lets any other error through as itself", async () => {
    vi.mocked(rateCook).mockRejectedValue(new Error("db down"));

    await expect(
      caller.rateCook({ queueId: QUEUE_ID, rating: 4 }),
    ).rejects.toMatchObject({ code: "INTERNAL_SERVER_ERROR", message: "db down" });
  });
});

describe("with no Cook Log connected", () => {
  beforeEach(() => {
    connected["cook-log"] = false;
  });

  it("Done, a start and an auto-finish schedule no write", async () => {
    vi.mocked(updateQueueStatus).mockResolvedValue({ completed: true, started: false });
    await caller.updateKitchenQueueStatus({ queueId: QUEUE_ID, status: "completed" });

    vi.mocked(updateQueueStatus).mockResolvedValue({ completed: false, started: true });
    vi.mocked(finishLeftCooks).mockResolvedValue(["left-on-its-last-screen"]);
    await caller.updateKitchenQueueStatus({ queueId: QUEUE_ID, status: "cooking" });

    expect(finishLeftCooks).toHaveBeenCalledWith(HOME.id, QUEUE_ID);
    expect(after).not.toHaveBeenCalled();
    expect(logCookInBackground).not.toHaveBeenCalled();
  });

  it("the retry and the rating answer that there is no log, and call nothing", async () => {
    expect(await caller.retryCookLog({ queueId: QUEUE_ID })).toEqual({
      status: "failed",
      error: "No Cook Log is connected",
    });
    expect(await caller.rateCook({ queueId: QUEUE_ID, rating: 4 })).toEqual({
      rated: false,
      error: "No Cook Log is connected",
    });
    expect(retryCookLog).not.toHaveBeenCalled();
    expect(rateCook).not.toHaveBeenCalled();
  });

  it("the kitchen has nothing to ask: no ask is read, and a dismiss is a no-op", async () => {
    // No database stands behind this test, so an answer means neither
    // procedure went looking for a cook.
    expect(await caller.getCookAsk({ userId: "cook" })).toBeNull();
    expect(await caller.dismissCookAsk({ queueId: QUEUE_ID })).toEqual({ success: true });
  });
});
