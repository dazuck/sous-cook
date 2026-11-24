/**
 * Auto-finish (cook-fidelity plan, decision 7) against a real Postgres
 * (PGlite) and a Cook Log scripted at its edge (the cook-log hook, connected
 * to `scriptedCookLog`), in a kitchen set to New York, through the router
 * where the app reaches it: the cook page's reports and its own finish, the
 * kitchen's sweep, and a cook's next start.
 */

import { afterEach, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import type { PGlite } from "@electric-sql/pglite";

const scheduled: (() => unknown)[] = [];
vi.mock("next/server", async (importOriginal) => ({
  ...(await importOriginal<typeof import("next/server")>()),
  after: vi.fn((task: () => unknown) => {
    scheduled.push(task);
  }),
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

import * as dbModule from "./db";
import { db, kitchenQueue } from "./db";
import {
  callerFor,
  homeKitchen,
  mintToken,
  seedKitchen,
} from "./__tests__/kitchens";
import { AUTO_FINISH_IDLE_MS, REOPEN_WINDOW_MS } from "./kitchen/auto-finish";
import {
  finishLeftCooks as finishLeftCooksForKitchen,
  reopenAutoFinished as reopenAutoFinishedForKitchen,
  reportLastScreen as reportLastScreenForKitchen,
  sweepIdleCooks as sweepIdleCooksForKitchen,
} from "./kitchen-auto-finish";
import { getQueueItem } from "./kitchen-queue";
import { openCookAsk as openCookAskForKitchen } from "./kitchen-cook-log";
import { cookLogTimestamp } from "./hooks/cook-log";
import { connected } from "./hooks/connected";
import { POST as sweepPost } from "../app/api/kitchen-queue/sweep/route";

const client = (dbModule as unknown as { client: PGlite }).client;
/** The Cook Log's transport: every request the grid makes goes through it. */
const mockFetch = vi.fn();
let kitchenId: string;
let homeToken: string;
let router: ReturnType<typeof callerFor>;

beforeAll(async () => {
  const home = await homeKitchen(db);
  kitchenId = home.id;
  router = callerFor(home);
  homeToken = await mintToken(db, home.id, "auto-finish-test");
});

beforeEach(async () => {
  vi.stubEnv("SOUS_SIGN_IN", "off");
  mockFetch.mockReset();
  connected["cook-log"] = true;
  scheduled.length = 0;
  await client.exec(
    "delete from kitchen_queue; delete from invites; delete from members; delete from auth_session; delete from auth_account; delete from auth_user;",
  );
  await client.exec(
    "delete from kitchen_webhook_tokens where kitchen_id <> (select id from kitchens where slug = 'home')",
  );
  await client.exec("delete from kitchens where slug <> 'home'");
});

afterEach(() => {
  vi.useRealTimers();
  vi.unstubAllEnvs();
});

const MIN = 60_000;

const reportLastScreen = (
  queueId: string,
  activeAt: Date | null,
  interactedAt: Date,
) => reportLastScreenForKitchen(kitchenId, queueId, activeAt, interactedAt);
const reopenAutoFinished = (queueId: string, now?: Date) =>
  reopenAutoFinishedForKitchen(kitchenId, queueId, now);
const finishLeftCooks = (_ignoredUser: string, starting: string, now?: Date) =>
  finishLeftCooksForKitchen(kitchenId, starting, now);
const sweepIdleCooks = (_ignoredUser: string, now?: Date, idleMs?: number) =>
  sweepIdleCooksForKitchen(kitchenId, now, idleMs);
const openCookAsk = (_ignoredUser: string, now?: Date) =>
  openCookAskForKitchen(kitchenId, now);

/** Runs what the router left for after the response: the Cook Log writes. */
async function runAfter() {
  const tasks = scheduled.splice(0);
  for (const task of tasks) await task();
}

function ok(data: unknown) {
  return { ok: true, json: async () => data };
}

/** A Cook Log with state: appends land in it, and PUTs are kept. */
function liveSheet(initial: string[][] = [["timestamp", "recipe_name", "recipe_anchor", "rating", "notes"]]) {
  const rows = initial.map((r) => [...r]);
  const puts: { url: string; body: string }[] = [];
  mockFetch.mockImplementation(async (url: string, init?: RequestInit) => {
    if (init?.method === "POST") {
      const [values] = JSON.parse(String(init.body)).values as string[][];
      rows.push(values);
      return ok({ updates: { updatedRange: `'Cook Log'!A${rows.length}:E${rows.length}` } });
    }
    if (init?.method === "PUT") {
      puts.push({ url: decodeURIComponent(url), body: String(init.body) });
      const range = /!([A-Z])(\d+)/.exec(decodeURIComponent(url));
      if (range && range[1] === "A") {
        const [[value]] = JSON.parse(String(init.body)).values as string[][];
        rows[Number(range[2]) - 1][0] = value;
      }
      return ok({});
    }
    return ok({ values: rows.map((r) => [...r]) });
  });
  return { rows, puts };
}

async function cooking(values: Partial<typeof kitchenQueue.$inferInsert> = {}): Promise<string> {
  const [row] = await db
    .insert(kitchenQueue)
    .values({
      kitchenId,
      recipeData: { name: "Farro risotto" },
      status: "cooking",
      startedAt: new Date(Date.now() - 90 * MIN),
      ...values,
    })
    .returning({ id: kitchenQueue.id });
  return row.id;
}

async function item(id: string, ownerKitchenId: string = kitchenId) {
  const found = await getQueueItem(ownerKitchenId, id);
  if (!found) throw new Error(`missing ${id}`);
  return found;
}

const ago = (minutes: number) => new Date(Date.now() - minutes * MIN);

/** A nightly job's call, using a per-kitchen webhook bearer token. */
async function sweep(body: unknown = {}, auth: string | null = `Bearer ${homeToken}`) {
  const headers: Record<string, string> = { "content-type": "application/json" };
  if (auth !== null) headers.authorization = auth;
  const res = await sweepPost(
    new Request("http://localhost/api/kitchen-queue/sweep", { method: "POST", headers, body: JSON.stringify(body) }),
  );
  return { status: res.status, json: await res.json() };
}

describe("reportLastScreen", () => {
  it("keeps where a cooking cook sits, and clears it off the last screen", async () => {
    const id = await cooking();
    const at = ago(3);

    expect(await reportLastScreen(id, at, at)).toEqual({ cooking: true, autoFinished: false });
    expect((await item(id)).lastScreenActiveAt).toEqual(at);
    expect((await item(id)).lastInteractionAt).toEqual(at);

    await reportLastScreen(id, null, ago(2));
    expect((await item(id)).lastScreenActiveAt).toBeNull();
  });

  it("a late report of an older touch never overwrites a newer one: two screens on one cook", async () => {
    const id = await cooking();
    // The tablet stepped back off the last screen two minutes ago.
    await reportLastScreen(id, null, ago(2));

    // The phone, idle on the last screen since ten minutes ago, reports late:
    // it changes nothing, and the cook is still cooking.
    expect(await reportLastScreen(id, ago(10), ago(10))).toEqual({ cooking: true, autoFinished: false });
    expect((await item(id)).lastScreenActiveAt).toBeNull();

    // A newer touch on the last screen does land, and an older one never undoes it.
    const touched = ago(1);
    await reportLastScreen(id, touched, touched);
    await reportLastScreen(id, ago(50), ago(50));
    await reportLastScreen(id, null, ago(5));
    expect((await item(id)).lastScreenActiveAt).toEqual(touched);
  });

  it("writes nothing to a cook that isn't cooking, and says when the app finished it", async () => {
    const id = await cooking({ status: "completed", completedAt: ago(10), finishedBy: "auto" });

    expect(await reportLastScreen(id, ago(1), ago(1))).toEqual({ cooking: false, autoFinished: true });
    expect((await item(id)).lastScreenActiveAt).toBeNull();
  });

  it("says a cook opened but never started (pending) isn't cooking, so the page won't try to finish it", async () => {
    const id = await cooking({ status: "pending", startedAt: null });

    expect(await reportLastScreen(id, ago(1), ago(1))).toEqual({ cooking: false, autoFinished: false });
  });
});

describe("sweepIdleCooks: the 45 minutes", () => {
  it("finishes a cook idle on its last screen past the wait, dated to its last activity", async () => {
    const last = ago(46);
    const id = await cooking({ lastScreenActiveAt: last });

    expect(await sweepIdleCooks("cook")).toEqual([id]);

    const after = await item(id);
    expect(after.status).toBe("completed");
    expect(after.finishedBy).toBe("auto");
    expect(after.completedAt).toEqual(last);
  });

  it("never finishes a cook on a screen that isn't its last, however long it sat", async () => {
    const id = await cooking({ startedAt: ago(600), lastScreenActiveAt: null });

    expect(await sweepIdleCooks("cook")).toEqual([]);
    expect((await item(id)).status).toBe("cooking");
  });

  it("never finishes a cook while its timer runs (its activity is the timer's end)", async () => {
    const timerEnds = new Date(Date.now() + 20 * MIN);
    const id = await cooking({ startedAt: ago(600), lastScreenActiveAt: timerEnds });

    expect(await sweepIdleCooks("cook")).toEqual([]);
    expect((await item(id)).status).toBe("cooking");
  });

  it("waits the whole 45 minutes", async () => {
    const id = await cooking({ lastScreenActiveAt: new Date(Date.now() - AUTO_FINISH_IDLE_MS + MIN) });

    expect(await sweepIdleCooks("cook")).toEqual([]);
    expect((await item(id)).status).toBe("cooking");
  });

  it("finishes only that kitchen's own cooks", async () => {
    const { kitchen: other } = await seedKitchen(db, {
      slug: "other-sweep",
      name: "Other Sweep",
    });
    const theirs = await cooking({ kitchenId: other.id, lastScreenActiveAt: ago(50) });

    expect(await sweepIdleCooks("cook")).toEqual([]);
    expect((await item(theirs, other.id)).status).toBe("cooking");
  });
});

describe("finishLeftCooks: the next cook starts", () => {
  it("finishes another cook left on its last screen at once, dated to its last activity", async () => {
    const last = ago(5);
    const left = await cooking({ lastScreenActiveAt: last });
    const next = await cooking({ status: "pending", startedAt: null });

    expect(await finishLeftCooks("cook", next)).toEqual([left]);

    const after = await item(left);
    expect(after.status).toBe("completed");
    expect(after.finishedBy).toBe("auto");
    expect(after.completedAt).toEqual(last);
  });

  it("leaves a cook reopened by a step back, until its page says where it sits", async () => {
    const id = await cooking({ status: "completed", completedAt: ago(10), finishedBy: "auto" });
    const next = await cooking({ status: "pending", startedAt: null });

    // The step back: the page's report (off the last screen) reaches a cook
    // still finished and writes nothing; the reopen follows it.
    await reportLastScreen(id, null, ago(0));
    expect(await reopenAutoFinished(id)).toEqual({ reopened: true });
    expect((await item(id)).lastScreenActiveAt).toBeNull();

    expect(await finishLeftCooks("cook", next)).toEqual([]);
    expect(await sweepIdleCooks("cook", new Date(Date.now() + 3 * 60 * MIN))).toEqual([]);
    expect((await item(id)).status).toBe("cooking");
  });

  it("leaves a cook mid-recipe, a cook with a timer running, and the one starting", async () => {
    const midway = await cooking({ lastScreenActiveAt: null });
    const simmering = await cooking({ lastScreenActiveAt: new Date(Date.now() + 10 * MIN) });
    const starting = await cooking({ lastScreenActiveAt: ago(5) });

    expect(await finishLeftCooks("cook", starting)).toEqual([]);
    for (const id of [midway, simmering, starting]) expect((await item(id)).status).toBe("cooking");
  });
});

describe("reopenAutoFinished", () => {
  it("puts an auto-finished cook back to cooking, keeping its start, row, how and when it finished", async () => {
    const started = ago(80);
    const finished = ago(30);
    const log = { row: 2, timestamp: "2026-10-25 18:40", recipeName: "Farro risotto", adopted: false };
    const id = await cooking({
      status: "completed",
      startedAt: started,
      completedAt: finished,
      finishedBy: "auto",
      cookLog: log,
    });

    expect(await reopenAutoFinished(id)).toEqual({ reopened: true });

    const after = await item(id);
    expect(after.status).toBe("cooking");
    // The first finish's time stays: the next finish moves its row only
    // within the reopen window of it (a later one is a new cook).
    expect(after.completedAt).toEqual(finished);
    expect(after.startedAt).toEqual(started);
    expect(after.cookLog).toEqual(log);
    expect(after.finishedBy).toBe("auto");
  });

  it("never reopens a cook the cook finished, or one finished past the window", async () => {
    const pressed = await cooking({ status: "completed", completedAt: ago(5), finishedBy: "pressed" });
    const old = await cooking({
      status: "completed",
      completedAt: new Date(Date.now() - REOPEN_WINDOW_MS - MIN),
      finishedBy: "auto",
    });

    expect(await reopenAutoFinished(pressed)).toEqual({ reopened: false });
    expect(await reopenAutoFinished(old)).toEqual({ reopened: false });
    expect((await item(pressed)).status).toBe("completed");
    expect((await item(old)).status).toBe("completed");
  });
});

describe("through the router: the same path as Done", () => {
  it("the page's own auto-finish completes the cook and logs it at its last activity, by the server's clock", async () => {
    const sheet = liveSheet();
    const id = await cooking({ lastScreenActiveAt: ago(46) });

    const before = Date.now();
    expect(await router.autoFinishCook({ queueId: id, idleForMs: 46 * MIN, interactedAt: Date.now() - (46 * MIN) })).toEqual({ autoFinished: true });
    const sent = Date.now();
    await runAfter();

    const after = await item(id);
    expect(after.finishedBy).toBe("auto");
    const at = new Date(after.completedAt as Date).getTime();
    expect(at).toBeGreaterThanOrEqual(before - 46 * MIN);
    expect(at).toBeLessThanOrEqual(sent - 46 * MIN);
    expect(after.cookLog?.row).toBe(2);
    expect(sheet.rows).toHaveLength(2);
    expect(sheet.rows[1][1]).toBe("Farro risotto");
  });

  it("with no Cook Log connected, a finish and the sweep finish the cook and write no row", async () => {
    connected["cook-log"] = false;
    const pressed = await cooking({ lastScreenActiveAt: ago(46) });
    const asleep = await cooking({ recipeData: { name: "Soup" }, lastScreenActiveAt: ago(50) });
    // A finish from days this kitchen had a log, its write lost: not retried without one.
    await cooking({ status: "completed", finishedBy: "auto", completedAt: ago(90), cookLogError: "Cook Log API 503" });

    expect(
      await router.autoFinishCook({ queueId: pressed, idleForMs: 46 * MIN, interactedAt: Date.now() - 46 * MIN }),
    ).toEqual({ autoFinished: true });
    expect(scheduled).toHaveLength(0);

    expect((await sweep()).json).toEqual({
      finished: [{ queueId: asleep, name: "Soup", cookLog: "none" }],
      relogged: [],
    });
    for (const id of [pressed, asleep]) {
      const after = await item(id);
      expect([after.status, after.finishedBy, after.cookLog, after.cookLogError]).toEqual(["completed", "auto", null, null]);
    }
    expect(await router.getCookAsk({})).toBeNull();
    expect(mockFetch).not.toHaveBeenCalled();
  });

  it("the kitchen's ask is a read: it finishes nothing, however long a cook sat", async () => {
    const id = await cooking({ lastScreenActiveAt: ago(50) });

    expect(await router.getCookAsk({})).toBeNull();
    expect((await item(id)).status).toBe("cooking");
    expect(mockFetch).not.toHaveBeenCalled();
  });

  it("the sweep finishes a cook left on its last screen, its row written before it answers", async () => {
    const sheet = liveSheet();
    const last = ago(50);
    const id = await cooking({ lastScreenActiveAt: last });
    const midway = await cooking({ lastScreenActiveAt: null });

    const res = await sweep();
    expect(res).toEqual({
      status: 200,
      json: { finished: [{ queueId: id, name: "Farro risotto", cookLog: "logged" }], relogged: [] },
    });
    expect(scheduled).toHaveLength(0);
    const after = await item(id);
    expect(after.finishedBy).toBe("auto");
    expect(after.completedAt).toEqual(last);
    expect(after.cookLog?.row).toBe(2);
    expect(sheet.rows).toHaveLength(2);
    expect((await item(midway)).status).toBe("cooking");
    // Asked of on the day it was cooked (read a minute on, so the test holds
    // across New York's midnight), its row already written.
    expect(await openCookAsk("cook", new Date(last.getTime() + MIN))).toEqual({
      queueId: id,
      name: "Farro risotto",
      state: "logged",
    });

    // Again: nothing more to finish, nothing more written.
    expect(await sweep()).toEqual({ status: 200, json: { finished: [], relogged: [] } });
    expect(sheet.rows).toHaveLength(2);
  });

  it("a sweep cut off part way leaves each cook it finished logged; the next one logs a finish left without a row", async () => {
    const sheet = liveSheet();
    const first = await cooking({ lastScreenActiveAt: ago(50) });
    // A finish an earlier sweep made but never logged (cut off, or the log down).
    const unlogged = await cooking({
      recipeData: { name: "Dal" },
      status: "completed",
      finishedBy: "auto",
      completedAt: ago(90),
      cookLogError: "Cook Log API 503",
    });

    const res = await sweep();
    expect(res.json).toEqual({
      finished: [{ queueId: first, name: "Farro risotto", cookLog: "logged" }],
      relogged: [{ queueId: unlogged, name: "Dal", cookLog: "logged" }],
    });
    expect(sheet.rows).toHaveLength(3);
    expect(await sweep()).toEqual({ status: 200, json: { finished: [], relogged: [] } });
  });

  it("the sweep logs each cook as it finishes it, before it finishes the next", async () => {
    liveSheet();
    const a = await cooking({ lastScreenActiveAt: ago(50) });
    const b = await cooking({ lastScreenActiveAt: ago(55) });
    const append = mockFetch.getMockImplementation()!;
    const seen: string[] = [];
    mockFetch.mockImplementation(async (url: string, init?: RequestInit) => {
      if (init?.method === "POST") {
        seen.push(`${(await item(a)).status}/${(await item(b)).status}`);
      }
      return append(url, init);
    });

    await sweep();
    // At the first row's write, one cook is finished and the other still cooking.
    expect(seen[0]).toMatch(/^(completed\/cooking|cooking\/completed)$/);
  });

  it("last night's sweep failed to log a cook it finished: tonight's retries it, though the finish is dated to activity a day before that", async () => {
    liveSheet();
    // Last active at 20:20 the night before last; finished by last night's
    // 21:00 sweep, dated to that activity; its write failed. Tonight, 21:00.
    const unlogged = await cooking({
      recipeData: { name: "Dal" },
      status: "completed",
      finishedBy: "auto",
      completedAt: ago(48 * 60 + 40),
      cookLogError: "Cook Log API 503",
    });

    expect((await sweep()).json).toEqual({
      finished: [],
      relogged: [{ queueId: unlogged, name: "Dal", cookLog: "logged" }],
    });
  });

  it("a write cut off with its claim held is left to its claim's 2 minutes, then retried", async () => {
    liveSheet();
    const held = { status: "completed", finishedBy: "auto", completedAt: ago(90) } as const;
    const live = await cooking({ ...held, recipeData: { name: "Dal" }, cookLogClaimedAt: ago(1) });
    const lost = await cooking({ ...held, recipeData: { name: "Soup" }, cookLogClaimedAt: ago(3) });

    expect((await sweep()).json).toEqual({
      finished: [],
      relogged: [{ queueId: lost, name: "Soup", cookLog: "logged" }],
    });
    expect((await item(live)).cookLog).toBeNull();
  });

  it("the sweep never relogs a cook the cook finished, one still being written, or one from days ago", async () => {
    liveSheet();
    await cooking({ status: "completed", finishedBy: "pressed", completedAt: ago(90), cookLogError: "x" });
    await cooking({ status: "completed", finishedBy: "auto", completedAt: ago(90), cookLogClaimedAt: new Date() });
    await cooking({ status: "completed", finishedBy: "auto", completedAt: ago(4 * 24 * 60), cookLogError: "x" });

    expect((await sweep()).json).toEqual({ finished: [], relogged: [] });
  });

  it("the sweep finishes only the token's kitchen", async () => {
    liveSheet();
    const { kitchen: other } = await seedKitchen(db, {
      slug: "other-sweep-route",
      name: "Other Sweep Route",
    });
    const otherToken = await mintToken(db, other.id, "other-sweep-token");
    const first = await cooking({ lastScreenActiveAt: ago(50) });
    const second = await cooking({ kitchenId: other.id, lastScreenActiveAt: ago(50) });

    expect(
      (await sweep({}, `Bearer ${otherToken}`)).json.finished.map(
        (f: { queueId: string }) => f.queueId,
      ),
    ).toEqual([second]);
    expect((await item(first)).status).toBe("cooking");
    expect((await sweep()).json.finished.map((f: { queueId: string }) => f.queueId)).toEqual([first]);
  });

  it("the sweep refuses a call without the webhook's token, and finishes nothing", async () => {
    const id = await cooking({ lastScreenActiveAt: ago(50) });

    expect((await sweep({}, null)).status).toBe(401);
    expect((await sweep({}, "Bearer wrong")).status).toBe(401);
    expect((await sweep({ targetUser: "Not A Slug" })).status).toBe(400);
    expect((await item(id)).status).toBe("cooking");
  });

  it("a Cook Log failure on an auto-finish shows as the pressed Done's does: failed, with retry", async () => {
    mockFetch.mockResolvedValue({ ok: false, status: 400, text: async () => "invalid_grant" });
    const last = ago(50);
    const id = await cooking({ lastScreenActiveAt: last });

    expect((await sweep()).json).toEqual({
      finished: [{ queueId: id, name: "Farro risotto", cookLog: "failed" }],
      relogged: [],
    });

    const after = await item(id);
    expect(after.cookLogError).toMatch(/Cook Log API 400/);
    expect(await openCookAsk("cook", new Date(last.getTime() + MIN))).toEqual({
      queueId: id,
      name: "Farro risotto",
      state: "failed",
    });

    // The retry is the same one Done's failure offers.
    liveSheet();
    expect((await router.retryCookLog({ queueId: id })).status).toBe("logged");
  });

  it("a repeat start (a retry after a lost answer) finishes no left cook", async () => {
    const started = await cooking({ startedAt: ago(1) });
    const left = await cooking({ lastScreenActiveAt: ago(1) });

    await router.updateKitchenQueueStatus({ queueId: started, status: "cooking" });
    expect((await item(left)).status).toBe("cooking");
  });

  it("a cook's start finishes the cook left on its last screen and logs it", async () => {
    const sheet = liveSheet();
    const left = await cooking({ lastScreenActiveAt: ago(3) });
    const next = await cooking({ status: "pending", startedAt: null });

    await router.updateKitchenQueueStatus({ queueId: next, status: "cooking" });
    await runAfter();

    expect((await item(left)).finishedBy).toBe("auto");
    expect((await item(left)).cookLog?.row).toBe(2);
    expect(sheet.rows).toHaveLength(2);
    expect((await item(next)).status).toBe("cooking");
  });

  it("a cook reopened and finished again updates its Cook Log row, never a second one", async () => {
    const sheet = liveSheet();
    const id = await cooking({ startedAt: ago(120), lastScreenActiveAt: ago(60) });

    await router.autoFinishCook({ queueId: id, idleForMs: 60 * MIN, interactedAt: Date.now() - (60 * MIN) });
    await runAfter();
    const last = new Date((await item(id)).completedAt as Date);
    expect(sheet.rows[1][0]).toBe(cookLogTimestamp(last));

    // A press back on the open cook: the cook goes on, and then Done.
    expect(await router.reopenCook({ queueId: id })).toEqual({ reopened: true });
    await router.updateKitchenQueueStatus({ queueId: id, status: "completed" });
    await runAfter();

    const after = await item(id);
    const moved = cookLogTimestamp(new Date(after.completedAt as Date));
    expect(moved).not.toBe(cookLogTimestamp(last));
    expect(sheet.rows).toHaveLength(2);
    expect(sheet.rows[1][0]).toBe(moved);
    expect(sheet.puts.map((p) => p.url)).toEqual([expect.stringContaining("'Cook Log'!A2")]);
    expect(after.finishedBy).toBe("pressed");
    expect(after.cookLog).toEqual({ row: 2, timestamp: moved, recipeName: "Farro risotto", adopted: false });
  });

  it("the page's report says when the cook was finished elsewhere", async () => {
    const id = await cooking({ status: "completed", completedAt: ago(5), finishedBy: "auto" });

    expect(await router.markCookActivity({ queueId: id, idleForMs: MIN, interactedAt: Date.now() - MIN })).toEqual({
      cooking: false,
      autoFinished: true,
    });
  });

  it("the page's activity is dated by the server's clock, a timer's run ahead included; its touch is the page's own time", async () => {
    const id = await cooking({ lastScreenActiveAt: null });
    const touch = Date.now() - 3_000;

    const before = Date.now();
    await router.markCookActivity({ queueId: id, idleForMs: -10 * MIN, interactedAt: touch });
    const sent = Date.now();
    const at = new Date((await item(id)).lastScreenActiveAt as Date).getTime();
    expect(at).toBeGreaterThanOrEqual(before + 10 * MIN);
    expect(at).toBeLessThanOrEqual(sent + 10 * MIN);
    expect((await item(id)).lastInteractionAt).toEqual(new Date(touch));

    // Off the last screen, the server keeps nothing.
    await router.markCookActivity({ queueId: id, idleForMs: null, interactedAt: touch });
    expect((await item(id)).lastScreenActiveAt).toBeNull();
  });

  it("one touch reported twice, the reports slow by different amounts: both land, in the order sent", async () => {
    const id = await cooking({ lastScreenActiveAt: null });
    // The press (on the last screen) and the step back it made, one touch.
    const touch = Date.now() - 5_000;

    await router.markCookActivity({ queueId: id, idleForMs: 4_000, interactedAt: touch });
    expect((await item(id)).lastScreenActiveAt).not.toBeNull();
    await router.markCookActivity({ queueId: id, idleForMs: null, interactedAt: touch });
    expect((await item(id)).lastScreenActiveAt).toBeNull();
    expect(await sweepIdleCooks("cook", new Date(Date.now() + 3 * 60 * MIN))).toEqual([]);
  });

  it("a report delayed in transit, of a touch older than a step back reported since, changes nothing", async () => {
    const id = await cooking({ lastScreenActiveAt: null });
    // The tablet steps back off the last screen now.
    await router.markCookActivity({ queueId: id, idleForMs: null, interactedAt: Date.now() });

    // The phone's report of a touch ten minutes ago, on the last screen,
    // arrives twelve minutes late: it says so, and is dropped.
    expect(
      await router.markCookActivity({ queueId: id, idleForMs: 0, interactedAt: Date.now() - 10 * MIN }),
    ).toEqual({ cooking: true, autoFinished: false });
    expect((await item(id)).lastScreenActiveAt).toBeNull();
    expect(await sweepIdleCooks("cook", new Date(Date.now() + 3 * 60 * MIN))).toEqual([]);
  });

  it("two pages, a timer running on one: the other's newer touch never lowers the timer's end", async () => {
    const id = await cooking({ lastScreenActiveAt: null });
    // The tablet: on the last screen, its timer ends in an hour.
    await router.markCookActivity({ queueId: id, idleForMs: -60 * MIN, interactedAt: Date.now() - 5 * MIN });
    const timerEnd = new Date((await item(id)).lastScreenActiveAt as Date).getTime();

    // The phone, which knows no such timer, touches the last screen since.
    await router.markCookActivity({ queueId: id, idleForMs: 0, interactedAt: Date.now() });
    expect(new Date((await item(id)).lastScreenActiveAt as Date).getTime()).toBe(timerEnd);

    // Nothing finishes it before the timer's end and the wait after it.
    expect(await sweepIdleCooks("cook", new Date(timerEnd + AUTO_FINISH_IDLE_MS - MIN))).toEqual([]);
    expect(await finishLeftCooks("cook", "00000000-0000-4000-8000-000000000999")).toEqual([]);
    expect((await item(id)).status).toBe("cooking");
  });

  it("the page's finish loses to a newer touch on another page", async () => {
    const id = await cooking({ lastScreenActiveAt: ago(46) });
    // The phone was touched on the last screen a minute after the tablet's last activity.
    await router.markCookActivity({ queueId: id, idleForMs: 45 * MIN, interactedAt: Date.now() - 45 * MIN });

    expect(
      await router.autoFinishCook({ queueId: id, idleForMs: 46 * MIN, interactedAt: Date.now() - 46 * MIN }),
    ).toEqual({ autoFinished: false });
    expect((await item(id)).status).toBe("cooking");
  });

  it("refuses a report from a page whose clock runs ahead of the server's", async () => {
    const id = await cooking({ lastScreenActiveAt: null });

    await expect(
      router.markCookActivity({ queueId: id, idleForMs: 0, interactedAt: Date.now() + 10 * MIN }),
    ).rejects.toThrow(/clock/);
    expect((await item(id)).lastInteractionAt).toBeNull();
  });

  it("refuses a page's finish of a cook that left its last screen on another page", async () => {
    const id = await cooking({ lastScreenActiveAt: null });

    expect(await router.autoFinishCook({ queueId: id, idleForMs: 46 * MIN, interactedAt: Date.now() - (46 * MIN) })).toEqual({ autoFinished: false });
    expect((await item(id)).status).toBe("cooking");
  });

  it("takes the page's finish though its reading of the activity falls a little before the report's", async () => {
    // The report arrived slowly, so the server dated the activity later than
    // the finish now does: the same activity, read twice.
    const id = await cooking({ lastScreenActiveAt: ago(45) });

    expect(await router.autoFinishCook({ queueId: id, idleForMs: 46 * MIN, interactedAt: Date.now() - (46 * MIN) })).toEqual({ autoFinished: true });
    expect((await item(id)).status).toBe("completed");
  });

  it("refuses a page's finish over activity reported later than the slack", async () => {
    const id = await cooking({ lastScreenActiveAt: ago(40) });

    expect(await router.autoFinishCook({ queueId: id, idleForMs: 46 * MIN, interactedAt: Date.now() - (46 * MIN) })).toEqual({ autoFinished: false });
    expect((await item(id)).status).toBe("cooking");
  });

  it("a cook reopened while its Cook Log row is written keeps the row, and its next finish moves it", async () => {
    const sheet = liveSheet();
    const id = await cooking({ startedAt: ago(120), lastScreenActiveAt: ago(60) });
    // The cook taps back while the append is on its way.
    const append = mockFetch.getMockImplementation()!;
    mockFetch.mockImplementation(async (url: string, init?: RequestInit) => {
      if (init?.method === "POST") expect(await reopenAutoFinished(id)).toEqual({ reopened: true });
      return append(url, init);
    });

    await router.autoFinishCook({ queueId: id, idleForMs: 60 * MIN, interactedAt: Date.now() - (60 * MIN) });
    await runAfter();
    mockFetch.mockImplementation(append);
    const reopened = await item(id);
    expect(reopened.status).toBe("cooking");
    expect(reopened.cookLog?.row).toBe(2);

    await router.updateKitchenQueueStatus({ queueId: id, status: "completed" });
    await runAfter();
    expect(sheet.rows).toHaveLength(2);
    expect(sheet.rows[1][0]).toBe(cookLogTimestamp(new Date((await item(id)).completedAt as Date)));
  });

  it("a refinish while the first row is still being appended: one row, moved to the refinish", async () => {
    const sheet = liveSheet();
    const id = await cooking({ startedAt: ago(120), lastScreenActiveAt: ago(60) });
    const append = mockFetch.getMockImplementation()!;
    let raced = false;
    mockFetch.mockImplementation(async (url: string, init?: RequestInit) => {
      if (init?.method === "POST" && !raced) {
        raced = true;
        // While the first row is on its way: the cook taps back, presses
        // Done, and that finish's own write runs to its end.
        expect(await router.reopenCook({ queueId: id })).toEqual({ reopened: true });
        await router.updateKitchenQueueStatus({ queueId: id, status: "completed" });
        await runAfter();
      }
      return append(url, init);
    });

    await router.autoFinishCook({ queueId: id, idleForMs: 60 * MIN, interactedAt: Date.now() - (60 * MIN) });
    await runAfter();

    const after = await item(id);
    expect(after.finishedBy).toBe("pressed");
    const moved = cookLogTimestamp(new Date(after.completedAt as Date));
    expect(sheet.rows).toHaveLength(2);
    expect(sheet.rows[1][0]).toBe(moved);
    expect(after.cookLog).toEqual({ row: 2, timestamp: moved, recipeName: "Farro risotto", adopted: false });
    expect(after.cookLogClaimedAt).toBeNull();
  });

  it("a refinish leaves another writer's adopted row at the time that writer gave it", async () => {
    const theirRow = ["2026-10-26 18:05", "Farro risotto", "", "", ""];
    const sheet = liveSheet([["timestamp", "recipe_name", "recipe_anchor", "rating", "notes"], theirRow]);
    const log = { row: 2, timestamp: "2026-10-26 18:05", recipeName: "Farro risotto", adopted: true };
    const id = await cooking({ completedAt: ago(30), finishedBy: "auto", cookLog: log });

    await router.updateKitchenQueueStatus({ queueId: id, status: "completed" });
    await runAfter();

    expect((await item(id)).cookLog).toEqual(log);
    expect(sheet.rows).toEqual([["timestamp", "recipe_name", "recipe_anchor", "rating", "notes"], theirRow]);
    expect(sheet.puts).toEqual([]);
  });

  it("a cook reopened and finished past the window of its first finish is logged as a new cook", async () => {
    const sheet = liveSheet([
      ["timestamp", "recipe_name", "recipe_anchor", "rating", "notes"],
      ["2026-10-19 18:40", "Farro risotto", "", "5", "great"],
    ]);
    const log = { row: 2, timestamp: "2026-10-19 18:40", recipeName: "Farro risotto", adopted: false };
    // Reopened on the Monday, inside the window, and never finished since.
    const id = await cooking({
      startedAt: ago(5 * 24 * 60),
      completedAt: new Date(Date.now() - REOPEN_WINDOW_MS - 60 * MIN),
      finishedBy: "auto",
      cookLog: log,
      ratingClosedAt: ago(4 * 24 * 60),
    });

    await router.updateKitchenQueueStatus({ queueId: id, status: "completed" });
    await runAfter();

    const after = await item(id);
    expect(after.ratingClosedAt).toBeNull();
    expect(after.cookLog?.row).toBe(3);
    expect(sheet.rows).toHaveLength(3);
    // Monday's rated row stays where it was.
    expect(sheet.rows[1]).toEqual(["2026-10-19 18:40", "Farro risotto", "", "5", "great"]);
  });

  it("refuses a page's finish before the wait is up", async () => {
    const id = await cooking();
    await expect(router.autoFinishCook({ queueId: id, idleForMs: AUTO_FINISH_IDLE_MS - 1, interactedAt: Date.now() - (AUTO_FINISH_IDLE_MS - 1) })).rejects.toThrow();
    expect((await item(id)).status).toBe("cooking");
  });
});
