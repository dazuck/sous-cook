// @vitest-environment happy-dom
import { TRPCClientError } from "@trpc/client";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { CookReport } from "./report-capture";
import { recentEvents, resetEventLog } from "./report-events";
import {
  OUTBOX_CAP,
  OUTBOX_KEY,
  createReportOutbox,
  outcomeOf,
  type OutboxEntry,
  type ReportSender,
  type StringStore,
} from "./report-outbox";

// The outbox between a flag and `cook_reports` (B2 decision 6; ported from
// player/tests/feedbackQueue.test.ts). Storage is best-effort: quota pressure
// thins reports before it loses them, and the in-memory list stays
// authoritative for the session. Sending runs on triggers, never a timer.

function memoryStore(): StringStore & { map: Map<string, string> } {
  const map = new Map<string, string>();
  return {
    map,
    getItem: (key) => map.get(key) ?? null,
    setItem: (key, value) => map.set(key, value),
    removeItem: (key) => map.delete(key),
  };
}

/** A store that refuses writes larger than `limit` characters, like a full disk. */
function boundedStore(limit: number): StringStore & { map: Map<string, string> } {
  const base = memoryStore();
  return {
    ...base,
    setItem: (key, value) => {
      if (value.length > limit) throw new DOMException("quota", "QuotaExceededError");
      base.map.set(key, value);
    },
  };
}

/** Like boundedStore, but `limit` can change between two writes. */
function tighteningStore(limit: number): StringStore & { map: Map<string, string>; limit: number } {
  const base = memoryStore();
  const store = {
    ...base,
    limit,
    setItem: (key: string, value: string) => {
      if (value.length > store.limit) throw new DOMException("quota", "QuotaExceededError");
      base.map.set(key, value);
    },
  };
  return store;
}

/** A server that never answers: everything stays as it was stored. */
const silent: ReportSender = {
  submit: () => new Promise(() => {}),
  annotate: () => new Promise(() => {}),
};

function trpcError(code: string, httpStatus: number): TRPCClientError<never> {
  return TRPCClientError.from({
    error: { code: -32600, message: code, data: { code, httpStatus } },
  });
}

const offline = () => Promise.reject(new TypeError("Failed to fetch"));


/** A scripted server: each call takes the next answer, and every call is kept. */
function scripted(
  answers: { submit?: (() => Promise<unknown>)[]; annotate?: (() => Promise<unknown>)[] } = {},
) {
  const submits: CookReport[] = [];
  const annotates: { id: string; note: string }[] = [];
  const sender: ReportSender = {
    submit: (report) => {
      submits.push(report);
      const next = answers.submit?.shift();
      return next ? next() : Promise.resolve();
    },
    annotate: (id, note) => {
      annotates.push({ id, note });
      const next = answers.annotate?.shift();
      return next ? next() : Promise.resolve();
    },
  };
  return { sender, submits, annotates };
}

let serial = 0;
function report(dom = '<div id="root"></div>'): CookReport {
  serial += 1;
  return {
    id: `r${String(serial).padStart(3, "0")}`,
    capturedAt: "2026-10-04T10:00:00.000Z",
    build: "b-1",
    path: "/kitchen/queue/q1",
    screen: "step",
    queueId: null,
    recipeName: "Mole",
    stepKey: "s1",
    chapterId: null,
    planVersion: 4,
    plan: null,
    state: { mode: "go", pos: 1, ticked: [], passed: [], kept: [] },
    context: {
      viewport: { w: 1280, h: 800, dpr: 2 },
      ua: "test-agent",
      online: true,
      voice: { mode: null, status: "unsupported" },
      ask: { sessionId: "cook-queue-1", open: false },
      layers: { pane: false, card: null, more: false },
      part: null,
    },
    events: [{ at: "2026-10-04T09:59:59.000Z", kind: "step", detail: "next → 1" }],
    dom,
    domTruncated: false,
    note: "",
  };
}

function stored(backing: StringStore): OutboxEntry[] {
  return JSON.parse(backing.getItem(OUTBOX_KEY) ?? "[]") as OutboxEntry[];
}

/** A waiting entry as storage holds it. */
function toWaiting(r: CookReport): OutboxEntry {
  const { id, capturedAt, recipeName, screen, note } = r;
  return { id, capturedAt, recipeName, screen, note, status: "waiting", sentNote: "", report: r };
}

/** What one entry costs in storage, whole and stripped of its DOM. */
function entrySizes(dom: string): { whole: number; stripped: number } {
  const whole = memoryStore();
  createReportOutbox(whole, silent).add(report(dom));
  const wholeSize = (whole.getItem(OUTBOX_KEY) ?? "").length;
  // A single entry over the limit lands stripped (rung 2).
  const thin = boundedStore(wholeSize - 1);
  createReportOutbox(thin, silent).add(report(dom));
  return { whole: wholeSize, stripped: (thin.getItem(OUTBOX_KEY) ?? "").length };
}

const flagNotes = () => recentEvents().filter((e) => e.kind === "flag");

/** Lets every pending promise in a flush settle. */
async function settle(): Promise<void> {
  for (let i = 0; i < 20; i += 1) await Promise.resolve();
}

beforeEach(() => {
  resetEventLog();
});

afterEach(() => {
  vi.useRealTimers();
});

describe("add and list", () => {
  it("lists newest first and notifies subscribers", () => {
    const outbox = createReportOutbox(memoryStore(), silent);
    const counts: number[] = [];
    const unsubscribe = outbox.subscribe(() => counts.push(outbox.list().length));
    const first = report();
    const second = report();
    void outbox.add(first);
    void outbox.add(second);
    unsubscribe();
    expect(outbox.list().map((e) => e.id)).toEqual([second.id, first.id]);
    expect(counts).toEqual([1, 2]);
  });

  it("holds a new capture as waiting, whole", () => {
    const outbox = createReportOutbox(memoryStore(), silent);
    const captured = report();
    void outbox.add(captured);
    const [entry] = outbox.list();
    expect(entry?.status).toBe("waiting");
    expect(entry?.report).toEqual(captured);
    expect(entry).toMatchObject({
      id: captured.id,
      capturedAt: captured.capturedAt,
      recipeName: "Mole",
      screen: "step",
      note: "",
    });
  });

  it("keeps the step in hand for the row, and keeps it past the send (C3)", async () => {
    const { sender } = scripted();
    const backing = memoryStore();
    const outbox = createReportOutbox(backing, sender);
    const step = { n: 3, of: 9, name: "Grind the paste", line: "Meanwhile, grind the paste fine." };
    void outbox.add(report(), step);
    void outbox.add(report(), null);
    expect(outbox.list().map((e) => e.step)).toEqual([null, step]);
    await settle();
    expect(outbox.list().map((e) => [e.status, e.step])).toEqual([
      ["sent", null],
      ["sent", step],
    ]);
    expect(createReportOutbox(backing, silent).list().map((e) => e.step)).toEqual([null, step]);
  });

  it("persists across outbox instances", () => {
    const backing = memoryStore();
    const captured = report();
    void createReportOutbox(backing, silent).add(captured);
    expect(
      createReportOutbox(backing, silent)
        .list()
        .map((e) => e.id),
    ).toEqual([captured.id]);
  });

  it("refuses a flag past a cap of flags still to send, and keeps every one of them (F11)", async () => {
    // A flag the cook made never vanishes to make room (fix round 1, M4):
    // the new one is refused, and the pill says so, as it does a failure.
    const backing = memoryStore();
    const outbox = createReportOutbox(backing, silent);
    const reports = Array.from({ length: OUTBOX_CAP }, () => report());
    const results = await Promise.all(reports.map((r) => outbox.add(r)));
    expect(OUTBOX_CAP).toBe(20);
    expect(OUTBOX_KEY).toBe("sous-feedback");
    expect(results.every((r) => r === "flagged")).toBe(true);
    const before = backing.getItem(OUTBOX_KEY);

    const extra = report();
    await expect(outbox.add(extra)).resolves.toBe("full");
    const ids = outbox.list().map((e) => e.id);
    expect(ids).toHaveLength(OUTBOX_CAP);
    expect(ids).toEqual(reports.map((r) => r.id).reverse());
    expect(backing.getItem(OUTBOX_KEY)).toBe(before);
    expect(flagNotes().map((e) => e.detail)).toContain(
      "the tablet holds 20 flags still to send — a new flag was refused",
    );
  });

  it("makes room by dropping the oldest flag the DB holds whole", async () => {
    const { sender } = scripted({ submit: [() => Promise.resolve(), () => Promise.resolve()] });
    const backing = memoryStore();
    const first = createReportOutbox(backing, sender);
    const older = report();
    const newer = report();
    void first.add(older);
    void first.add(newer);
    await settle();
    expect(first.list().map((e) => e.status)).toEqual(["sent", "sent"]);
    // A later session, offline: the cap fills with waiting reports.
    const outbox = createReportOutbox(backing, silent);
    const waiting = Array.from({ length: OUTBOX_CAP - 1 }, () => report());
    for (const r of waiting) await expect(outbox.add(r)).resolves.toBe("flagged");
    const ids = outbox.list().map((e) => e.id);
    expect(ids).toHaveLength(OUTBOX_CAP);
    expect(ids).not.toContain(older.id);
    expect(ids).toContain(newer.id);
    expect(ids).toContain(waiting[0]?.id);
  });

  it("never drops a sent flag whose note is still to go, nor one the server refused", async () => {
    const { sender } = scripted({
      submit: [() => Promise.resolve(), () => Promise.reject(trpcError("BAD_REQUEST", 400))],
      annotate: [() => new Promise(() => {})],
    });
    const backing = memoryStore();
    const first = createReportOutbox(backing, sender);
    const noted = report();
    const wrong = report();
    void first.add(noted);
    await settle();
    void first.add(wrong);
    await settle();
    first.annotate(noted.id, "the pane covered the step");
    expect(first.list().map((e) => [e.id, e.status])).toEqual([
      [wrong.id, "refused"],
      [noted.id, "sent"],
    ]);
    const outbox = createReportOutbox(backing, silent);
    for (const r of Array.from({ length: OUTBOX_CAP - 2 }, () => report())) void outbox.add(r);
    await expect(outbox.add(report())).resolves.toBe("full");
    expect(outbox.list().map((e) => e.id)).toEqual(expect.arrayContaining([noted.id, wrong.id]));
  });
});

describe("annotate", () => {
  it("writes a note onto an existing entry, in memory and in storage", () => {
    const backing = memoryStore();
    const outbox = createReportOutbox(backing, silent);
    const captured = report();
    void outbox.add(captured);
    outbox.annotate(captured.id, "no way to exit cook mode");
    expect(outbox.list()[0]?.note).toBe("no way to exit cook mode");
    expect(stored(backing)[0]?.note).toBe("no way to exit cook mode");
  });

  it("is a no-op on an id that is not in the outbox", () => {
    const backing = memoryStore();
    const outbox = createReportOutbox(backing, silent);
    void outbox.add(report());
    const before = backing.getItem(OUTBOX_KEY);
    outbox.annotate("not-a-real-id", "ignored");
    expect(backing.getItem(OUTBOX_KEY)).toBe(before);
  });

  it("is a no-op when the note is unchanged: no needless persist or notify", () => {
    const backing = memoryStore();
    const outbox = createReportOutbox(backing, silent);
    const captured = report();
    void outbox.add(captured);
    outbox.annotate(captured.id, "timer looks like an ingredient chip");
    const before = backing.getItem(OUTBOX_KEY);
    let notified = false;
    const unsubscribe = outbox.subscribe(() => {
      notified = true;
    });
    outbox.annotate(captured.id, "timer looks like an ingredient chip");
    unsubscribe();
    expect(backing.getItem(OUTBOX_KEY)).toBe(before);
    expect(notified).toBe(false);
  });

  it("cuts a note to 4 KB, the server's cap, on a whole character", () => {
    const outbox = createReportOutbox(memoryStore(), silent);
    const captured = report();
    void outbox.add(captured);
    outbox.annotate(captured.id, "é".repeat(3000));
    const note = outbox.list()[0]?.note ?? "";
    expect(new TextEncoder().encode(note).length).toBe(4096);
    expect(note).toBe("é".repeat(2048));
  });

  it("leaves a stripped DOM stripped after annotating", () => {
    const { whole } = entrySizes("x".repeat(2_000));
    const backing = boundedStore(whole - 1);
    const captured = report("x".repeat(2_000));
    void createReportOutbox(backing, silent).add(captured);
    const reloaded = createReportOutbox(backing, silent);
    const [before] = reloaded.list();
    expect(before?.domDropped).toBe(true); // the fixture really did strip it
    reloaded.annotate(captured.id, "a note");
    const [after] = reloaded.list();
    expect(after?.report?.dom).toBe("");
    expect(after?.domDropped).toBe(true);
    const [again] = createReportOutbox(backing, silent).list();
    expect(again?.domDropped).toBe(true);
    expect(again?.note).toBe("a note");
  });

  it("marks a stripped report's DOM as cut, so the row it becomes says so", () => {
    const { whole } = entrySizes("x".repeat(2_000));
    const backing = boundedStore(whole - 1);
    void createReportOutbox(backing, silent).add(report("x".repeat(2_000)));
    const [entry] = createReportOutbox(backing, silent).list();
    expect(entry?.report?.domTruncated).toBe(true);
  });

  it("says so when a note on an older flag is too tight to reach storage", () => {
    // Only one stripped entry fits: a note on the older one can't be the
    // entry rung 3 keeps.
    const { stripped } = entrySizes("x".repeat(300));
    const backing = boundedStore(stripped + 20);
    const outbox = createReportOutbox(backing, silent);
    const older = report("x".repeat(300));
    void outbox.add(older);
    void outbox.add(report("x".repeat(300)));
    outbox.annotate(older.id, "no way to exit cook mode");
    expect(flagNotes().map((n) => n.detail)).toContain(
      "storage was tight — this note may not survive a reload",
    );
    // Memory still holds it; only storage lost it.
    expect(outbox.list().find((e) => e.id === older.id)?.note).toBe("no way to exit cook mode");
  });

  it("stays quiet when the annotated report is the one storage kept", () => {
    const { stripped } = entrySizes("x".repeat(300));
    const backing = boundedStore(stripped + 20);
    const outbox = createReportOutbox(backing, silent);
    void outbox.add(report("x".repeat(300)));
    const newest = report("x".repeat(300));
    void outbox.add(newest);
    outbox.annotate(newest.id, "clear note");
    expect(flagNotes().map((n) => n.detail)).not.toContain(
      "storage was tight — this note may not survive a reload",
    );
  });

  it("warns when clearing a displaced report's note fails to reach storage, as writing would", () => {
    const { stripped } = entrySizes("x".repeat(300));
    const backing = boundedStore(stripped + 20);
    const outbox = createReportOutbox(backing, silent);
    const older = report("x".repeat(300));
    void outbox.add(older);
    void outbox.add(report("x".repeat(300)));
    outbox.annotate(older.id, "something");
    const before = flagNotes().length;
    outbox.annotate(older.id, "");
    const after = flagNotes();
    expect(after).toHaveLength(before + 1);
    expect(after.at(-1)?.detail).toBe("storage was tight — this note may not survive a reload");
  });

  it("a note cleared under total storage refusal comes back stale on reload", () => {
    const backing = tighteningStore(100_000);
    const outbox = createReportOutbox(backing, silent);
    const only = report("x".repeat(50));
    void outbox.add(only);
    outbox.annotate(only.id, "wrong note");
    backing.limit = 0; // storage now refuses every shape
    const before = flagNotes().length;
    outbox.annotate(only.id, "");
    const after = flagNotes();
    expect(after.length).toBeGreaterThan(before);
    expect(after.at(-1)?.detail).toBe("storage was tight — this note may not survive a reload");
    backing.limit = 100_000;
    expect(createReportOutbox(backing, silent).list()[0]?.note).toBe("wrong note");
    expect(outbox.list()[0]?.note).toBe("");
  });

  it("stays quiet clearing a note that does reach storage", () => {
    const outbox = createReportOutbox(memoryStore(), silent);
    const captured = report();
    void outbox.add(captured);
    outbox.annotate(captured.id, "something");
    const before = flagNotes().length;
    outbox.annotate(captured.id, "");
    expect(flagNotes()).toHaveLength(before);
  });

  it("stays quiet annotating at the everyone-stripped-but-kept rung", () => {
    const { whole, stripped } = entrySizes("x".repeat(300));
    // Two stripped entries fit; one whole plus one stripped doesn't.
    const twoStripped = 2 * stripped + 1;
    expect(whole + stripped + 1).toBeGreaterThan(twoStripped + 60);
    const backing = boundedStore(twoStripped + 60);
    const outbox = createReportOutbox(backing, silent);
    const older = report("x".repeat(300));
    void outbox.add(older);
    void outbox.add(report("x".repeat(300)));
    const before = flagNotes().length;
    outbox.annotate(older.id, "a");
    expect(flagNotes()).toHaveLength(before);
    expect(stored(backing)).toHaveLength(2);
  });

  it("warns when storage refuses every shape and a note cannot land anywhere", () => {
    const { stripped } = entrySizes("x".repeat(300));
    const backing = boundedStore(stripped - 10);
    const outbox = createReportOutbox(backing, silent);
    const captured = report("x".repeat(300));
    void outbox.add(captured);
    const before = flagNotes().length;
    outbox.annotate(captured.id, "a note storage will refuse entirely");
    const after = flagNotes();
    expect(after.length).toBeGreaterThan(before);
    expect(after.at(-1)?.detail).toBe("storage was tight — this note may not survive a reload");
  });
});

describe("quota pressure", () => {
  it("strips DOM from older stored flags first, keeping the newest whole", () => {
    const { whole, stripped } = entrySizes("x".repeat(300));
    const backing = boundedStore(whole + stripped + 10);
    expect(2 * whole).toBeGreaterThan(whole + stripped + 10);
    const outbox = createReportOutbox(backing, silent);
    const first = report("x".repeat(300));
    const second = report("x".repeat(300));
    void outbox.add(first);
    void outbox.add(second);
    // Memory never thins.
    expect(outbox.list().map((e) => e.report?.dom.length)).toEqual([300, 300]);
    const onDisk = stored(backing);
    expect(onDisk.map((e) => e.id)).toEqual([second.id, first.id]);
    expect(onDisk[0]?.report?.dom).toBe("x".repeat(300));
    expect(onDisk[1]?.report?.dom).toBe("");
    expect(onDisk[1]?.domDropped).toBe(true);
  });

  it("a reload gets the stripped survivors", () => {
    const { whole } = entrySizes("x".repeat(2_000));
    const backing = boundedStore(whole - 1);
    void createReportOutbox(backing, silent).add(report("x".repeat(2_000)));
    const [reloaded] = createReportOutbox(backing, silent).list();
    expect(reloaded?.domDropped).toBe(true);
    expect(reloaded?.report?.dom).toBe("");
  });

  it("keeps every capture whole in memory when storage refuses everything", () => {
    const outbox = createReportOutbox(boundedStore(0), silent);
    const first = report("<div>first</div>");
    const second = report("<div>second</div>");
    void outbox.add(first);
    void outbox.add(second);
    expect(outbox.list().map((e) => e.report?.dom)).toEqual(["<div>second</div>", "<div>first</div>"]);
    expect(flagNotes().length).toBeGreaterThan(0);
  });

  it("says how far degradation went, once per rung, not per tap", () => {
    // One stripped entry fits, two don't, and a whole one never does: the
    // first write lands stripped, every later one on rung 3.
    const { stripped } = entrySizes("x".repeat(300));
    resetEventLog(); // measuring thinned a store of its own
    const backing = boundedStore(stripped + 20);
    const outbox = createReportOutbox(backing, silent);
    void outbox.add(report("x".repeat(300)));
    void outbox.add(report("x".repeat(300)));
    void outbox.add(report("x".repeat(300)));
    expect(outbox.list()).toHaveLength(3);
    expect(stored(backing)).toHaveLength(1);
    const notes = flagNotes();
    expect(notes.map((n) => n.detail)).toContain(
      "storage was tight — only the newest capture reached storage",
    );
    // All-stripped, then newest-only: the third tap at the same rung adds nothing.
    expect(notes).toHaveLength(2);
  });

  it("a refusing store costs at most four write attempts per tap", () => {
    const backing = boundedStore(0);
    let attempts = 0;
    const counting: StringStore = {
      ...backing,
      setItem: (key, value) => {
        attempts += 1;
        backing.setItem(key, value);
      },
    };
    const outbox = createReportOutbox(counting, silent);
    for (const r of Array.from({ length: OUTBOX_CAP }, () => report())) void outbox.add(r);
    attempts = 0;
    void outbox.add(report());
    expect(attempts).toBeLessThanOrEqual(4);
  });
});

describe("stored data", () => {
  it("normalizes a stored entry with no note", () => {
    const backing = memoryStore();
    void createReportOutbox(backing, silent).add(report());
    const legacy = stored(backing).map((e) => {
      const copy: Record<string, unknown> = { ...e };
      delete copy["note"];
      return copy;
    });
    backing.setItem(OUTBOX_KEY, JSON.stringify(legacy));
    expect(createReportOutbox(backing, silent).list()[0]?.note).toBe("");
  });

  it("resets unreadable data and says so in the event log", () => {
    const backing = memoryStore();
    backing.setItem(OUTBOX_KEY, "not json");
    expect(createReportOutbox(backing, silent).list()).toEqual([]);
    expect(backing.getItem(OUTBOX_KEY)).toBeNull();
    expect(flagNotes().map((n) => n.detail)).toEqual(["stored flags were unreadable — cleared"]);
  });

  it("reads an older entry with no step, and resets a malformed one", () => {
    const backing = memoryStore();
    void createReportOutbox(backing, silent).add(report());
    const [entry] = stored(backing);
    expect(entry).not.toHaveProperty("step");
    expect(createReportOutbox(backing, silent).list()).toHaveLength(1);
    backing.setItem(OUTBOX_KEY, JSON.stringify([{ ...entry, step: { n: "3", of: 9, name: "x" } }]));
    expect(createReportOutbox(backing, silent).list()).toEqual([]);
    // A step from before panel round 4 has no line; one with a line not text is malformed.
    backing.setItem(OUTBOX_KEY, JSON.stringify([{ ...entry, step: { n: 3, of: 9, name: "x" } }]));
    expect(createReportOutbox(backing, silent).list()[0]?.step).toEqual({ n: 3, of: 9, name: "x" });
    backing.setItem(OUTBOX_KEY, JSON.stringify([{ ...entry, step: { n: 3, of: 9, name: "x", line: 4 } }]));
    expect(createReportOutbox(backing, silent).list()).toEqual([]);
  });

  it("resets data of the wrong shape", () => {
    const backing = memoryStore();
    backing.setItem(OUTBOX_KEY, JSON.stringify({ not: "an array" }));
    expect(createReportOutbox(backing, silent).list()).toEqual([]);
    expect(flagNotes().map((n) => n.detail)).toEqual(["stored flags had the wrong shape — cleared"]);
  });

  it("resets entries with no status, or a sent entry that still holds its report", () => {
    const backing = memoryStore();
    void createReportOutbox(backing, silent).add(report());
    const [entry] = stored(backing);
    backing.setItem(OUTBOX_KEY, JSON.stringify([{ ...entry, status: "sending" }]));
    expect(createReportOutbox(backing, silent).list()).toEqual([]);
    backing.setItem(OUTBOX_KEY, JSON.stringify([{ ...entry, status: "sent" }]));
    expect(createReportOutbox(backing, silent).list()).toEqual([]);
    backing.setItem(OUTBOX_KEY, JSON.stringify([{ ...entry, report: null }]));
    expect(createReportOutbox(backing, silent).list()).toEqual([]);
  });

  it("keeps an id stored twice once, the newer copy", () => {
    const backing = memoryStore();
    const outbox = createReportOutbox(backing, silent);
    for (const r of Array.from({ length: OUTBOX_CAP }, () => report())) void outbox.add(r);
    const entries = stored(backing);
    const older = entries.slice(0, 5).map((e) => ({ ...e, note: "older copy" }));
    backing.setItem(OUTBOX_KEY, JSON.stringify([...entries, ...older]));
    const loaded = createReportOutbox(backing, silent).list();
    expect(loaded.map((e) => e.id)).toEqual(entries.map((e) => e.id));
    expect(loaded.some((e) => e.note === "older copy")).toBe(false);
  });

  it("trims an oversized stored outbox of flags the DB holds whole, never of flags still to send", () => {
    const backing = memoryStore();
    // Another app on this origin (the Player shares the key) or an older
    // build stored more than the cap: 23 waiting, then 2 sent stubs.
    const waiting = Array.from({ length: OUTBOX_CAP + 3 }, () => toWaiting(report()));
    const sentStubs = [report(), report()].map((r) => ({ ...toWaiting(r), status: "sent", report: null }));
    backing.setItem(OUTBOX_KEY, JSON.stringify([...waiting, ...sentStubs]));
    const loaded = createReportOutbox(backing, silent).list();
    expect(loaded.map((e) => e.id)).toEqual(waiting.map((e) => e.id));
  });
});

describe("sending (F1, F4, F6–F9)", () => {
  it("sends a new capture on add and keeps a stub once it is sent", async () => {
    const { sender, submits } = scripted();
    const backing = memoryStore();
    const outbox = createReportOutbox(backing, sender);
    const captured = report();
    void outbox.add(captured);
    await settle();
    expect(submits.map((r) => r.id)).toEqual([captured.id]);
    expect(submits[0]).toEqual(captured);
    const [entry] = outbox.list();
    expect(entry?.status).toBe("sent");
    // The DOM and events are in the DB now; the tablet keeps what the hub lists.
    expect(entry).toEqual({
      id: captured.id,
      capturedAt: captured.capturedAt,
      recipeName: "Mole",
      screen: "step",
      note: "",
      status: "sent",
      sentNote: "",
      report: null,
    });
    expect(stored(backing)).toEqual([entry]);
  });

  it("F1: offline at the flag, the capture waits, and goes on `online`", async () => {
    const { sender, submits } = scripted({ submit: [offline] });
    const outbox = createReportOutbox(memoryStore(), sender);
    const stop = outbox.start(window);
    try {
      const captured = report();
      await expect(outbox.add(captured)).resolves.toBe("flagged");
      await settle();
      expect(outbox.list()[0]?.status).toBe("waiting");
      expect(outbox.list()[0]?.report).toEqual(captured);
      window.dispatchEvent(new Event("online"));
      await settle();
      expect(submits.map((r) => r.id)).toEqual([captured.id, captured.id]);
      expect(outbox.list()[0]?.status).toBe("sent");
    } finally {
      stop();
    }
  });

  it("F1: a capture left waiting goes when the page loads", async () => {
    const backing = memoryStore();
    void createReportOutbox(backing, scripted({ submit: [offline] }).sender).add(report());
    await settle();
    expect(stored(backing)[0]?.status).toBe("waiting");
    const { sender, submits } = scripted();
    const reloaded = createReportOutbox(backing, sender);
    expect(submits).toHaveLength(0); // creating it sends nothing; starting it does
    const stop = reloaded.start(window);
    await settle();
    stop();
    expect(submits).toHaveLength(1);
    expect(reloaded.list()[0]?.status).toBe("sent");
  });

  it("F1: a capture left waiting goes with the next flag, oldest first", async () => {
    const { sender, submits } = scripted({ submit: [offline] });
    const outbox = createReportOutbox(memoryStore(), sender);
    const first = report();
    void outbox.add(first);
    await settle();
    const second = report();
    void outbox.add(second);
    await settle();
    expect(submits.map((r) => r.id)).toEqual([first.id, first.id, second.id]);
    expect(outbox.list().map((e) => e.status)).toEqual(["sent", "sent"]);
  });

  it("never sends on a timer: a waiting capture stays put until a trigger", async () => {
    vi.useFakeTimers();
    const { sender, submits } = scripted({ submit: [offline] });
    const outbox = createReportOutbox(memoryStore(), sender);
    const stop = outbox.start(window);
    void outbox.add(report());
    await settle();
    const calls = submits.length;
    await vi.advanceTimersByTimeAsync(24 * 60 * 60 * 1000);
    stop();
    expect(submits).toHaveLength(calls);
    expect(vi.getTimerCount()).toBe(0);
  });

  it("stops listening for `online` once stopped", async () => {
    const { sender, submits } = scripted({ submit: [offline] });
    const outbox = createReportOutbox(memoryStore(), sender);
    outbox.start(window)();
    void outbox.add(report());
    await settle();
    const calls = submits.length;
    window.dispatchEvent(new Event("online"));
    await settle();
    expect(submits).toHaveLength(calls);
  });

  it("F4: a submit whose answer was lost goes again, and its success counts as sent", async () => {
    // The server stored the first try; the retry finds the row and answers
    // like any success.
    const { sender, submits } = scripted({ submit: [offline] });
    const outbox = createReportOutbox(memoryStore(), sender);
    const captured = report();
    void outbox.add(captured);
    await settle();
    await outbox.flush();
    expect(submits.map((r) => r.id)).toEqual([captured.id, captured.id]);
    expect(outbox.list()[0]?.status).toBe("sent");
  });

  it("F4: a note typed after a lost answer rides on the resend, which the server makes the row's", async () => {
    // The first submit stored the row with no note and its answer was lost;
    // the cook typed since. The resend carries the note, and the server sets
    // it on the row it already holds, so a success means the DB holds this
    // note and no annotate follows (fix round 1, M1).
    const { sender, submits, annotates } = scripted({ submit: [offline] });
    const outbox = createReportOutbox(memoryStore(), sender);
    const captured = report();
    void outbox.add(captured);
    await settle();
    outbox.annotate(captured.id, "the timer read as a step");
    await settle();
    expect(submits.map((r) => r.note)).toEqual(["", "the timer read as a step"]);
    expect(annotates).toEqual([]);
    expect(outbox.list()[0]).toMatchObject({
      status: "sent",
      note: "the timer read as a step",
      sentNote: "the timer read as a step",
    });
  });

  it("F4: triggers that overlap a send never submit the same capture twice at once", async () => {
    let release: () => void = () => {};
    const { sender, submits } = scripted({
      submit: [
        () =>
          new Promise<void>((resolve) => {
            release = resolve;
          }),
      ],
    });
    const outbox = createReportOutbox(memoryStore(), sender);
    void outbox.add(report());
    void outbox.flush();
    void outbox.flush();
    await settle();
    expect(submits).toHaveLength(1);
    release();
    await outbox.flush();
    expect(submits).toHaveLength(1);
    expect(outbox.list()[0]?.status).toBe("sent");
  });

  it("a capture added while a send is in flight goes in the same run", async () => {
    let release: () => void = () => {};
    const { sender, submits } = scripted({
      submit: [
        () =>
          new Promise<void>((resolve) => {
            release = resolve;
          }),
      ],
    });
    const outbox = createReportOutbox(memoryStore(), sender);
    const first = report();
    void outbox.add(first);
    await settle();
    const second = report();
    void outbox.add(second);
    release();
    await outbox.flush();
    expect(submits.map((r) => r.id)).toEqual([first.id, second.id]);
    expect(outbox.list().map((e) => e.status)).toEqual(["sent", "sent"]);
  });

  it("F6: a server refusal marks the capture refused, keeps it whole, and never sends it again", async () => {
    const { sender, submits } = scripted({
      submit: [() => Promise.reject(trpcError("BAD_REQUEST", 400))],
    });
    const outbox = createReportOutbox(memoryStore(), sender);
    const captured = report();
    void outbox.add(captured);
    await settle();
    const [entry] = outbox.list();
    expect(entry?.status).toBe("refused");
    expect(entry?.report).toEqual(captured);
    expect(flagNotes().map((n) => n.detail)).toContain("the server refused a report");
    await outbox.flush();
    void outbox.add(report());
    await settle();
    expect(submits.filter((r) => r.id === captured.id)).toHaveLength(1);
  });

  it("F6: a refusal doesn't hold up the captures behind it", async () => {
    const { sender, submits } = scripted({
      submit: [offline, () => Promise.reject(trpcError("BAD_REQUEST", 400))],
    });
    const outbox = createReportOutbox(memoryStore(), sender);
    const first = report();
    void outbox.add(first);
    await settle();
    const second = report();
    void outbox.add(second);
    await settle();
    expect(submits.map((r) => r.id)).toEqual([first.id, first.id, second.id]);
    expect(outbox.list().map((e) => e.status)).toEqual(["sent", "refused"]);
  });

  it("F7: over the rate cap, the capture waits and goes on the next trigger, never in a loop", async () => {
    const { sender, submits } = scripted({
      submit: [() => Promise.reject(trpcError("TOO_MANY_REQUESTS", 429))],
    });
    const outbox = createReportOutbox(memoryStore(), sender);
    void outbox.add(report());
    await settle();
    expect(submits).toHaveLength(1);
    expect(outbox.list()[0]?.status).toBe("waiting");
    await outbox.flush();
    expect(submits).toHaveLength(2);
    expect(outbox.list()[0]?.status).toBe("sent");
  });

  it("F7: a capped run stops, rather than spending a request on each capture behind it", async () => {
    const capped = () => Promise.reject(trpcError("TOO_MANY_REQUESTS", 429));
    const { sender, submits } = scripted({ submit: [offline, offline, capped] });
    const outbox = createReportOutbox(memoryStore(), sender);
    void outbox.add(report());
    await settle();
    void outbox.add(report());
    await settle();
    expect(submits).toHaveLength(2);
    await outbox.flush();
    expect(submits).toHaveLength(3);
    expect(outbox.list().map((e) => e.status)).toEqual(["waiting", "waiting"]);
  });

  it("notes still go while submits wait on the cap", async () => {
    const capped = () => Promise.reject(trpcError("TOO_MANY_REQUESTS", 429));
    const { sender, annotates } = scripted({
      submit: [() => Promise.resolve(), capped, capped, capped, capped],
    });
    const outbox = createReportOutbox(memoryStore(), sender);
    const sent = report();
    void outbox.add(sent);
    await settle();
    void outbox.add(report());
    await settle();
    outbox.annotate(sent.id, "the timer was wrong");
    await outbox.flush();
    expect(annotates).toEqual([{ id: sent.id, note: "the timer was wrong" }]);
  });

  it("F8: a server without the procedure (NOT_FOUND) leaves the capture waiting, not refused", async () => {
    const { sender } = scripted({ submit: [() => Promise.reject(trpcError("NOT_FOUND", 404))] });
    const outbox = createReportOutbox(memoryStore(), sender);
    void outbox.add(report());
    await settle();
    expect(outbox.list()[0]?.status).toBe("waiting");
  });

  it("F9: a note made before the capture is sent rides on the submit", async () => {
    const { sender, submits, annotates } = scripted({ submit: [offline] });
    const outbox = createReportOutbox(memoryStore(), sender);
    const captured = report();
    void outbox.add(captured);
    await settle();
    outbox.annotate(captured.id, "timer reads as an ingredient");
    await settle();
    expect(submits.at(-1)?.note).toBe("timer reads as an ingredient");
    expect(annotates).toEqual([]);
    expect(outbox.list()[0]).toMatchObject({
      status: "sent",
      note: "timer reads as an ingredient",
      sentNote: "timer reads as an ingredient",
    });
  });

  it("F9: a note on a sent capture goes by annotate", async () => {
    const { sender, annotates } = scripted();
    const outbox = createReportOutbox(memoryStore(), sender);
    const captured = report();
    void outbox.add(captured);
    await settle();
    outbox.annotate(captured.id, "the pane hid the timer");
    await settle();
    expect(annotates).toEqual([{ id: captured.id, note: "the pane hid the timer" }]);
    expect(outbox.list()[0]?.sentNote).toBe("the pane hid the timer");
  });

  it("F9: an annotate answering NOT_FOUND stays dirty and goes on the next trigger", async () => {
    const { sender, annotates } = scripted({
      annotate: [() => Promise.reject(trpcError("NOT_FOUND", 404))],
    });
    const outbox = createReportOutbox(memoryStore(), sender);
    const captured = report();
    void outbox.add(captured);
    await settle();
    outbox.annotate(captured.id, "late note");
    await settle();
    expect(outbox.list()[0]).toMatchObject({ note: "late note", sentNote: "" });
    await outbox.flush();
    expect(annotates).toHaveLength(2);
    expect(outbox.list()[0]?.sentNote).toBe("late note");
  });

  it("F9: a note typed while its submit is in flight goes after the submit", async () => {
    let release: () => void = () => {};
    const { sender, submits, annotates } = scripted({
      submit: [
        () =>
          new Promise<void>((resolve) => {
            release = resolve;
          }),
      ],
    });
    const outbox = createReportOutbox(memoryStore(), sender);
    const captured = report();
    void outbox.add(captured);
    await settle();
    outbox.annotate(captured.id, "typed mid-send");
    release();
    await outbox.flush();
    expect(submits[0]?.note).toBe("");
    expect(annotates).toEqual([{ id: captured.id, note: "typed mid-send" }]);
    expect(outbox.list()[0]).toMatchObject({ status: "sent", sentNote: "typed mid-send" });
  });

  it("a note on a refused capture stays on the tablet", async () => {
    const { sender, submits, annotates } = scripted({
      submit: [() => Promise.reject(trpcError("BAD_REQUEST", 400))],
    });
    const outbox = createReportOutbox(memoryStore(), sender);
    const captured = report();
    void outbox.add(captured);
    await settle();
    outbox.annotate(captured.id, "kept here");
    await settle();
    expect(outbox.list()[0]).toMatchObject({ status: "refused", note: "kept here" });
    expect(submits).toHaveLength(1);
    expect(annotates).toEqual([]);
  });
});

describe("storage gone (F2)", () => {
  it("a capture storage can't hold is sent directly, and counts as flagged once sent", async () => {
    const { sender, submits } = scripted();
    const outbox = createReportOutbox(boundedStore(0), sender);
    const captured = report();
    await expect(outbox.add(captured)).resolves.toBe("flagged");
    expect(submits.map((r) => r.id)).toEqual([captured.id]);
    expect(outbox.list()[0]?.status).toBe("sent");
  });

  it("with no storage and no server, the flag fails, says so, and leaves nothing behind", async () => {
    const { sender } = scripted({ submit: [offline] });
    const outbox = createReportOutbox(boundedStore(0), sender);
    await expect(outbox.add(report())).resolves.toBe("failed");
    expect(outbox.list()).toEqual([]);
    expect(recentEvents().filter((e) => e.kind === "error").map((e) => e.detail)).toEqual([
      "a flag could be neither stored nor sent",
    ]);
  });

  it("a capture that reached storage counts as flagged without waiting for the server", async () => {
    const outbox = createReportOutbox(memoryStore(), silent);
    await expect(outbox.add(report())).resolves.toBe("flagged");
  });

  it("a store that throws on every touch reads as empty and refuses writes", async () => {
    const broken: StringStore = {
      getItem: () => {
        throw new DOMException("denied", "SecurityError");
      },
      setItem: () => {
        throw new DOMException("denied", "SecurityError");
      },
      removeItem: () => {
        throw new DOMException("denied", "SecurityError");
      },
    };
    const { sender } = scripted();
    const outbox = createReportOutbox(broken, sender);
    expect(outbox.list()).toEqual([]);
    await expect(outbox.add(report())).resolves.toBe("flagged");
  });
});

describe("clearSent", () => {
  it("removes only sent entries with no unsent note, from this tablet", async () => {
    const { sender } = scripted({
      submit: [
        () => Promise.resolve(),
        () => Promise.resolve(),
        () => Promise.reject(trpcError("BAD_REQUEST", 400)),
        offline,
        offline,
      ],
      annotate: [offline],
    });
    const backing = memoryStore();
    const outbox = createReportOutbox(backing, sender);
    const sent = report();
    const dirty = report();
    const refused = report();
    const waiting = report();
    for (const r of [sent, dirty, refused, waiting]) {
      void outbox.add(r);
      await settle();
    }
    outbox.annotate(dirty.id, "not in the DB yet");
    await settle();
    outbox.clearSent();
    expect(outbox.list().map((e) => e.id)).toEqual([waiting.id, refused.id, dirty.id]);
    expect(stored(backing).map((e) => e.id)).toEqual([waiting.id, refused.id, dirty.id]);
  });

  it("notifies, and leaves storage alone when nothing is cleared", () => {
    const backing = memoryStore();
    const outbox = createReportOutbox(backing, silent);
    void outbox.add(report());
    const before = backing.getItem(OUTBOX_KEY);
    let notified = 0;
    outbox.subscribe(() => {
      notified += 1;
    });
    outbox.clearSent();
    expect(backing.getItem(OUTBOX_KEY)).toBe(before);
    expect(notified).toBe(0);
  });

  it("given ids, removes only those, and only while the DB still holds them whole (fix round 2, LOW-3)", async () => {
    const { sender } = scripted({ annotate: [offline, offline] });
    const backing = memoryStore();
    const outbox = createReportOutbox(backing, sender);
    const [marked, edited, later] = [report(), report(), report()];
    for (const r of [marked, edited]) {
      void outbox.add(r);
      await settle();
    }
    // Armed on these two; then one gets a note the DB doesn't hold yet, and
    // a third turns sent after the arming.
    const scope = new Set([marked.id, edited.id]);
    outbox.annotate(edited.id, "the chip wraps");
    await settle();
    void outbox.add(later);
    await settle();
    expect(outbox.list()[0]).toMatchObject({ id: later.id, status: "sent" });
    outbox.clearSent(scope);
    expect(outbox.list().map((e) => e.id)).toEqual([later.id, edited.id]);
    expect(stored(backing).map((e) => e.id)).toEqual([later.id, edited.id]);
  });
});

describe("dismiss (fix round 2, item 3)", () => {
  it("removes a flag the server refused, from memory and storage", async () => {
    const { sender } = scripted({ submit: [() => Promise.reject(trpcError("BAD_REQUEST", 400))] });
    const backing = memoryStore();
    const outbox = createReportOutbox(backing, sender);
    const kept = report();
    const refused = report();
    void outbox.add(refused);
    await settle();
    expect(outbox.list()[0]?.status).toBe("refused");
    void outbox.add(kept);
    await settle();
    outbox.dismiss(refused.id);
    expect(outbox.list().map((e) => e.id)).toEqual([kept.id]);
    expect(stored(backing).map((e) => e.id)).toEqual([kept.id]);
    // It stays gone through the next write, which folds storage back in.
    outbox.annotate(kept.id, "still here");
    expect(outbox.list().map((e) => e.id)).toEqual([kept.id]);
  });

  it("never takes a flag still to send, or one sent", async () => {
    const { sender } = scripted({ submit: [() => Promise.resolve(), offline] });
    const outbox = createReportOutbox(memoryStore(), sender);
    const [sent, waiting] = [report(), report()];
    for (const r of [sent, waiting]) {
      void outbox.add(r);
      await settle();
    }
    outbox.dismiss(sent.id);
    outbox.dismiss(waiting.id);
    expect(outbox.list().map((e) => e.status)).toEqual(["waiting", "sent"]);
  });
});

describe("two tabs on one storage (fix round 1, LOW-6)", () => {
  const ids = (entries: readonly OutboxEntry[]) => entries.map((e) => e.id).toSorted();

  /** Tells an outbox that another tab wrote, as the browser does. */
  function heard(target: EventTarget, key: string | null = OUTBOX_KEY): void {
    target.dispatchEvent(new StorageEvent("storage", { key }));
  }

  it("a flag in one tab never wipes a flag the other tab stored", () => {
    const backing = memoryStore();
    const first = createReportOutbox(backing, silent);
    const second = createReportOutbox(backing, silent);
    const a = report();
    const b = report();
    void first.add(a);
    void second.add(b);
    expect(ids(stored(backing))).toEqual(ids([toWaiting(a), toWaiting(b)]));
    // And a reload holds both.
    expect(ids(createReportOutbox(backing, silent).list())).toEqual([a.id, b.id]);
  });

  it("hears the other tab's write: its flag is listed here, and the panel is told", () => {
    const backing = memoryStore();
    const target = new EventTarget();
    const here = createReportOutbox(backing, silent);
    const stop = here.start(target as Window);
    const other = createReportOutbox(backing, silent);
    let notified = 0;
    here.subscribe(() => {
      notified += 1;
    });
    const theirs = report();
    void other.add(theirs);
    heard(target);
    expect(here.list().map((e) => e.id)).toEqual([theirs.id]);
    expect(notified).toBe(1);
    stop();
    void other.add(report());
    heard(target);
    expect(here.list()).toHaveLength(1);
  });

  it("ignores a write to another key", () => {
    const backing = memoryStore();
    const target = new EventTarget();
    const here = createReportOutbox(backing, silent);
    here.start(target as Window);
    void createReportOutbox(backing, silent).add(report());
    heard(target, "sous-something-else");
    expect(here.list()).toHaveLength(0);
  });

  it("takes the other tab's send and note on a flag both hold, and doesn't send it again", async () => {
    const backing = memoryStore();
    const target = new EventTarget();
    const shared = report();
    const parked = createReportOutbox(backing, silent);
    void parked.add(shared);
    const { sender, submits, annotates } = scripted();
    const here = createReportOutbox(backing, sender);
    here.start(target as Window);
    await settle();
    expect(submits).toHaveLength(1);
    // The parked tab hears the send, then the cook writes a note there.
    parked.start(target as Window);
    heard(target);
    expect(parked.list()[0]).toMatchObject({ status: "sent", report: null });
    parked.annotate(shared.id, "typed in the other tab");
    heard(target);
    expect(here.list()[0]).toMatchObject({ status: "sent", note: "typed in the other tab" });
    await here.flush();
    expect(submits).toHaveLength(1);
    expect(annotates).toEqual([{ id: shared.id, note: "typed in the other tab" }]);
  });

  it("a Clear in one tab is not undone by the other tab's next write", async () => {
    const backing = memoryStore();
    const target = new EventTarget();
    const here = createReportOutbox(backing, scripted().sender);
    here.start(target as Window);
    const done = report();
    void here.add(done);
    await settle();
    const other = createReportOutbox(backing, silent);
    other.clearSent();
    expect(stored(backing)).toEqual([]);
    // This tab writes before it hears of the clear.
    const next = report();
    void here.add(next);
    expect(stored(backing).map((e) => e.id)).toEqual([next.id]);
    heard(target);
    expect(here.list().map((e) => e.id)).toEqual([next.id]);
  });

  it("keeps a flag still to send that the other tab's list lacks, and its DOM over a thinned copy", () => {
    const backing = memoryStore();
    const target = new EventTarget();
    const here = createReportOutbox(backing, silent);
    here.start(target as Window);
    const mine = report('<div id="mine"></div>');
    void here.add(mine);
    // Another tab, quota-pressed, wrote this flag without its DOM, and lacks none of it.
    const thinned = { ...toWaiting(mine), report: { ...mine, dom: "", domTruncated: true }, domDropped: true };
    backing.setItem(OUTBOX_KEY, JSON.stringify([thinned]));
    heard(target);
    expect(here.list()[0]?.report?.dom).toBe('<div id="mine"></div>');
    backing.setItem(OUTBOX_KEY, "[]");
    heard(target);
    expect(here.list().map((e) => e.id)).toEqual([mine.id]);
  });

  it("holds the cap across both tabs: twenty waiting between them refuse a twenty-first", async () => {
    const backing = memoryStore();
    const first = createReportOutbox(backing, silent);
    const second = createReportOutbox(backing, silent);
    for (let i = 0; i < OUTBOX_CAP / 2; i += 1) {
      await expect(first.add(report())).resolves.toBe("flagged");
      await expect(second.add(report())).resolves.toBe("flagged");
    }
    await expect(first.add(report())).resolves.toBe("full");
    expect(stored(backing)).toHaveLength(OUTBOX_CAP);
  });
});

describe("outcomeOf", () => {
  it("maps the server's answers: BAD_REQUEST is refused, the rest wait", () => {
    expect(outcomeOf(trpcError("BAD_REQUEST", 400))).toBe("refused");
    expect(outcomeOf(trpcError("TOO_MANY_REQUESTS", 429))).toBe("retry");
    expect(outcomeOf(trpcError("NOT_FOUND", 404))).toBe("retry");
    expect(outcomeOf(trpcError("INTERNAL_SERVER_ERROR", 500))).toBe("retry");
    expect(outcomeOf(new TypeError("Failed to fetch"))).toBe("retry");
    expect(outcomeOf("weird")).toBe("retry");
  });
});

describe("forget", () => {
  it("empties list() and notifies listeners once", () => {
    const backing = memoryStore();
    const outbox = createReportOutbox(backing, silent);
    void outbox.add(report());
    expect(outbox.list()).toHaveLength(1);

    let notified = 0;
    outbox.subscribe(() => {
      notified += 1;
    });

    outbox.forget();
    expect(outbox.list()).toEqual([]);
    expect(notified).toBe(1);

    outbox.forget();
    expect(notified).toBe(1);
  });

  it("causes add to resolve failed and store nothing", async () => {
    const backing = memoryStore();
    const { sender, submits } = scripted();
    const outbox = createReportOutbox(backing, sender);
    outbox.forget();

    await expect(outbox.add(report())).resolves.toBe("failed");
    expect(outbox.list()).toEqual([]);
    expect(backing.getItem(OUTBOX_KEY)).toBeNull();
    expect(submits).toHaveLength(0);
  });

  it("makes annotate on an old id write nothing", () => {
    const backing = memoryStore();
    const { sender, submits, annotates } = scripted({ submit: [offline] });
    const outbox = createReportOutbox(backing, sender);
    const captured = report();
    void outbox.add(captured);
    backing.removeItem(OUTBOX_KEY);

    outbox.forget();
    outbox.annotate(captured.id, "typed after forget");

    expect(backing.getItem(OUTBOX_KEY)).toBeNull();
    expect(outbox.list()).toEqual([]);
    expect(submits).toHaveLength(1);
    expect(annotates).toEqual([]);
  });

  it("makes flush send nothing", async () => {
    const backing = memoryStore();
    const { sender, submits, annotates } = scripted({ submit: [offline] });
    const outbox = createReportOutbox(backing, sender);
    void outbox.add(report());
    await settle();
    expect(submits).toHaveLength(1);

    backing.removeItem(OUTBOX_KEY);
    outbox.forget();
    await outbox.flush();

    expect(submits).toHaveLength(1);
    expect(annotates).toEqual([]);
    expect(backing.getItem(OUTBOX_KEY)).toBeNull();
  });

  it("writes nothing and sends no further report when an in-flight send settles after forget", async () => {
    let releaseFirst: () => void = () => {};
    const { sender, submits } = scripted({
      submit: [
        () =>
          new Promise<void>((resolve) => {
            releaseFirst = resolve;
          }),
      ],
    });
    const backing = memoryStore();
    const outbox = createReportOutbox(backing, sender);
    const first = report();
    const second = report();
    void outbox.add(first);
    await settle();
    void outbox.add(second);
    expect(submits.map((r) => r.id)).toEqual([first.id]);

    backing.removeItem(OUTBOX_KEY);
    outbox.forget();
    releaseFirst();
    await settle();

    expect(backing.getItem(OUTBOX_KEY)).toBeNull();
    expect(outbox.list()).toEqual([]);
    expect(submits.map((r) => r.id)).toEqual([first.id]);
  });

  it("ignores storage events after forget", () => {
    const backing = memoryStore();
    const target = new EventTarget();
    const here = createReportOutbox(backing, silent);
    const stop = here.start(target as Window);
    try {
      let notified = 0;
      here.subscribe(() => {
        notified += 1;
      });
      here.forget();
      expect(notified).toBe(1);

      const other = createReportOutbox(backing, silent);
      void other.add(report());
      target.dispatchEvent(new StorageEvent("storage", { key: OUTBOX_KEY }));

      expect(here.list()).toEqual([]);
      expect(notified).toBe(1);
    } finally {
      stop();
    }
  });
});
