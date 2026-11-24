/**
 * The outbox between a flag and `cook_reports` (B2 decision 6; ported from
 * Player's `feedbackQueue`). The tablet goes offline and the DB can be down,
 * so a capture is stored here first, as `waiting`, and sent when a trigger
 * comes: a new flag or note, the page loading (`start`), or `online`. Never a
 * timer. Once sent, the entry keeps a stub the hub lists (id, time, recipe,
 * screen, note); the DOM and events live in the DB.
 *
 * The in-memory list is authoritative for the session; storage is
 * best-effort, and quota pressure thins reports before it loses them. Another
 * tab writes the same key, so each write folds in what storage holds by id,
 * and each tab hears the other's writes (`storage`) — fix round 1, LOW-6.
 */

import { TRPCClientError } from "@trpc/client";
import {
  NOTE_MAX_BYTES,
  cutToJsonBytes,
  type CookReport,
  type FlagStep,
  type ReportScreen,
} from "./report-capture";
import { recordEvent } from "./report-events";

/** Player's key: one outbox per origin, whichever app wrote it. */
export const OUTBOX_KEY = "sous-feedback";
export const OUTBOX_CAP = 20;

export interface StringStore {
  getItem(key: string): string | null;
  setItem(key: string, value: string): void;
  removeItem(key: string): void;
}

/**
 * `waiting` until the server takes it; `refused` when the server said the
 * report itself is wrong (kept, never sent again); `sent` once stored.
 */
export type OutboxStatus = "waiting" | "sent" | "refused";

export interface OutboxEntry {
  id: string;
  capturedAt: string;
  recipeName: string;
  screen: ReportScreen;
  /** What the cook typed on the hub. It rides on the submit, then goes by annotate. */
  note: string;
  status: OutboxStatus;
  /** The note the DB holds once sent; while `note` differs, it is still to go. */
  sentNote: string;
  /** The whole capture until it is sent; a sent entry is a stub. */
  report: CookReport | null;
  /** Storage was tight and this entry was stored without its DOM. */
  domDropped?: true;
  /**
   * The step in hand, by place and name, for the panel's row; null on Prep.
   * Absent on an entry stored before fix round 1b, which names its screen only.
   */
  step?: FlagStep | null;
}

/** The two write procedures, injected so the outbox runs without a server. */
export interface ReportSender {
  submit: (report: CookReport) => Promise<unknown>;
  annotate: (id: string, note: string) => Promise<unknown>;
}

/**
 * What the pill says: the capture is safe, it is nowhere (F2), or the tablet
 * already holds `OUTBOX_CAP` flags still to send and took no more (F11).
 */
export type FlagResult = "flagged" | "failed" | "full";

/**
 * How a failed send is taken. A schema refusal (`BAD_REQUEST`) and a report
 * id the server already holds under another kitchen (`CONFLICT`) will never
 * be taken, so both are final; the rate cap (F7), a server without the
 * procedure (F8), auth refusals, any other error and the network all leave
 * the entry to go again.
 */
export function outcomeOf(error: unknown): "refused" | "retry" {
  if (!(error instanceof TRPCClientError)) return "retry";
  const data = error.data as { code?: unknown } | null | undefined;
  return data?.code === "BAD_REQUEST" || data?.code === "CONFLICT" ? "refused" : "retry";
}

// Function properties, not methods: the closures are `this`-free, and
// callers pluck them off the object (useSyncExternalStore takes them bare).
export interface ReportOutbox {
  /**
   * Stores a capture and sends what is waiting. "flagged" as soon as the
   * capture is stored; with no storage at all, only once it is sent (F2).
   */
  add: (report: CookReport, step?: FlagStep | null) => Promise<FlagResult>;
  /** Newest first: the flag just pressed is the one being reviewed. */
  list: () => readonly OutboxEntry[];
  /** Writes the cook's note, cut to the server's cap, and sends it. A no-op on an id not here. */
  annotate: (id: string, note: string) => void;
  /**
   * Removes sent entries whose note is in the DB too; given `ids`, only those
   * of them, so a clear takes what it showed when armed (fix round 2, LOW-3).
   * This tablet only: the DB keeps everything.
   */
  clearSent: (ids?: ReadonlySet<string>) => void;
  /**
   * Removes a flag the server refused, which it will never take: the cook's
   * way to let it go (fix round 2). A no-op on any other entry.
   */
  dismiss: (id: string) => void;
  /** One send run; a trigger during a run makes it go round once more. */
  flush: () => Promise<void>;
  /**
   * Drops every entry this page holds and stops writing or sending for the
   * rest of the page's life; for a page about to reload because storage was
   * emptied.
   */
  forget: () => void;
  /** Sends what waits now and on each `online`; returns the stop. */
  start: (target?: Window) => () => void;
  subscribe: (listener: () => void) => () => void;
}

const STATUSES: readonly string[] = ["waiting", "sent", "refused"];

function isStep(value: unknown): value is FlagStep {
  if (typeof value !== "object" || value === null) return false;
  const s = value as Partial<Record<keyof FlagStep, unknown>>;
  return (
    typeof s.n === "number" &&
    typeof s.of === "number" &&
    typeof s.name === "string" &&
    (s.line === undefined || typeof s.line === "string")
  );
}

function isEntry(value: unknown): value is OutboxEntry {
  if (typeof value !== "object" || value === null) return false;
  const e = value as Partial<Record<keyof OutboxEntry, unknown>>;
  if (typeof e.id !== "string" || typeof e.capturedAt !== "string") return false;
  if (typeof e.recipeName !== "string" || typeof e.screen !== "string") return false;
  if (typeof e.status !== "string" || !STATUSES.includes(e.status)) return false;
  if (e.step !== undefined && e.step !== null && !isStep(e.step)) return false;
  // A sent entry is a stub; any other holds the capture it has to send.
  if (e.status === "sent") return e.report === null;
  return (
    typeof e.report === "object" &&
    e.report !== null &&
    (e.report as { id?: unknown }).id === e.id
  );
}

/** Reads storage that may refuse even to be read (a blocked origin). */
function read(backing: StringStore): string | null {
  try {
    return backing.getItem(OUTBOX_KEY);
  } catch {
    return null;
  }
}

function forget(backing: StringStore): void {
  try {
    backing.removeItem(OUTBOX_KEY);
  } catch {
    // Nothing stored can come back through a store that refuses.
  }
}

/** In the DB, note and all: the only entry the tablet may let go of. */
const whole = (e: OutboxEntry): boolean => e.status === "sent" && e.note === e.sentNote;

/**
 * Down to `limit` entries if it can be done by dropping entries the DB holds
 * whole, oldest first. Never an entry still to send, a note still to go or
 * one the server refused: each is the only copy of something the cook made
 * (F11, fix round 1 M4), so a list of those stays over the limit.
 */
function trimmed(entries: readonly OutboxEntry[], limit: number): OutboxEntry[] {
  const next = entries.slice();
  while (next.length > limit) {
    const oldest = next.findLastIndex(whole);
    if (oldest === -1) break;
    next.splice(oldest, 1);
  }
  return next;
}

/** One entry per id, the first (newest) kept. */
function unique(entries: readonly OutboxEntry[]): OutboxEntry[] {
  const seen = new Set<string>();
  return entries.filter((e) => !seen.has(e.id) && seen.add(e.id));
}

/** The stored list, or why it can't be used. */
function parse(raw: string): OutboxEntry[] | "unreadable" | "wrong shape" {
  let parsed: unknown;
  try {
    parsed = JSON.parse(raw);
  } catch {
    return "unreadable";
  }
  if (!Array.isArray(parsed) || !parsed.every(isEntry)) return "wrong shape";
  // A missing note would leak `undefined` into a field the panel renders as text.
  return unique(
    parsed.map((e) => ({
      ...e,
      note: typeof e.note === "string" ? e.note : "",
      sentNote: typeof e.sentNote === "string" ? e.sentNote : "",
    })),
  );
}

function load(backing: StringStore): OutboxEntry[] {
  const raw = read(backing);
  if (raw === null) return [];
  const parsed = parse(raw);
  if (typeof parsed === "string") {
    forget(backing);
    recordEvent("flag", `stored flags ${parsed === "unreadable" ? "were unreadable" : "had the wrong shape"} — cleared`);
    return [];
  }
  return trimmed(parsed, OUTBOX_CAP);
}

/** What storage holds now, written by any tab; null when there is nothing usable. */
function current(backing: StringStore): OutboxEntry[] | null {
  const raw = read(backing);
  if (raw === null) return null;
  const parsed = parse(raw);
  return typeof parsed === "string" ? null : parsed;
}

const RANK: Readonly<Record<OutboxStatus, number>> = { waiting: 0, refused: 1, sent: 2 };

/**
 * One flag as two lists hold it. `newer` has the last word on the note; the
 * status further along (waiting, then refused or sent) wins the capture, so a
 * flag the other tab sent is never sent again. A capture storage thinned for
 * quota gives way to one that still has its DOM.
 */
function combined(newer: OutboxEntry, older: OutboxEntry): OutboxEntry {
  const [ahead, behind] = RANK[older.status] > RANK[newer.status] ? [older, newer] : [newer, older];
  let entry = ahead;
  if (ahead.domDropped === true && behind.status === ahead.status && behind.domDropped !== true) {
    const { domDropped: _thinned, ...rest } = ahead;
    entry = { ...rest, report: behind.report };
  }
  return { ...entry, note: newer.note };
}

const newestFirst = (a: OutboxEntry, b: OutboxEntry): number =>
  a.capturedAt < b.capturedAt ? 1 : a.capturedAt > b.capturedAt ? -1 : 0;

/**
 * This tab's list and storage's folded by id. A flag this tab holds that
 * storage lacks is kept unless the DB holds it whole (another tab cleared it).
 * A flag only storage holds is another tab's: on hearing a write (`heard`)
 * every one is taken; on this tab's own write, a whole one is not, since it
 * may be one this tab has just cleared.
 */
function merged(mine: readonly OutboxEntry[], stored: readonly OutboxEntry[], heard: boolean): OutboxEntry[] {
  const theirs = new Map(stored.map((e) => [e.id, e]));
  const kept = mine.flatMap((m) => {
    const t = theirs.get(m.id);
    theirs.delete(m.id);
    if (t === undefined) return whole(m) ? [] : [m];
    return [heard ? combined(t, m) : combined(m, t)];
  });
  const adopted = [...theirs.values()].filter((t) => heard || !whole(t));
  return adopted.length === 0 ? kept : [...kept, ...adopted].sort(newestFirst);
}

function toEntry(report: CookReport, step: FlagStep | null | undefined): OutboxEntry {
  return {
    id: report.id,
    capturedAt: report.capturedAt,
    recipeName: report.recipeName,
    screen: report.screen,
    note: report.note,
    status: "waiting",
    sentNote: "",
    report,
    ...(step === undefined ? {} : { step }),
  };
}

/** The stub a sent entry keeps; `submitted` is the note that went with it. */
function toStub(entry: OutboxEntry, submitted: string): OutboxEntry {
  return {
    id: entry.id,
    capturedAt: entry.capturedAt,
    recipeName: entry.recipeName,
    screen: entry.screen,
    note: entry.note,
    status: "sent",
    sentNote: submitted,
    report: null,
    ...(entry.step === undefined ? {} : { step: entry.step }),
  };
}

/**
 * A stored entry without its DOM. The report it sends says its DOM was cut,
 * which a dropped one is, all of it.
 */
function stripped(entry: OutboxEntry): OutboxEntry {
  if (entry.report === null || entry.domDropped === true) return entry;
  return { ...entry, report: { ...entry.report, dom: "", domTruncated: true }, domDropped: true };
}

// Quota degradation thins what gets WRITTEN, never what's held: DOM snapshots
// drop from the older flags first (the newest is the one just pressed), then
// from all, then only the newest survives to storage. A fixed four-rung
// ladder, not a per-report loop, so a tap stays instant even when storage
// refuses every write.
const RUNG_NOTES: readonly (string | null)[] = [
  null,
  "storage was tight — older flags stored without their DOM",
  "storage was tight — all flags stored without their DOM",
  "storage was tight — only the newest capture reached storage",
  "storage refused the flag queue — flags live in memory only",
];

/** The rung on which storage refused every shape. */
const REFUSED = RUNG_NOTES.length - 1;

export function createReportOutbox(backing: StringStore, sender: ReportSender): ReportOutbox {
  let entries: OutboxEntry[] = load(backing);
  let forgotten = false;
  const listeners = new Set<() => void>();

  // Degrading silently would lose the very fact a dogfood log exists to
  // carry; saying it every tap would flood the ring buffer. Each rung is
  // noted once on the way down, and recovery re-arms the notes.
  let notedRung = 0;
  const noteRung = (rung: number): void => {
    if (rung > notedRung) {
      const note = RUNG_NOTES[rung];
      if (note !== null && note !== undefined) recordEvent("flag", note);
    }
    notedRung = rung;
  };

  // Returns the rung the write landed on (0–3), or REFUSED: annotate reads
  // it back to know whether its note reached storage, add whether its
  // capture did.
  const persist = (next: readonly OutboxEntry[]): number => {
    const rungs: readonly (readonly OutboxEntry[])[] = [
      next,
      next.map((e, i) => (i === 0 ? e : stripped(e))),
      next.map(stripped),
      next.slice(0, 1).map(stripped),
    ];
    for (const [index, rung] of rungs.entries()) {
      try {
        backing.setItem(OUTBOX_KEY, JSON.stringify(rung));
        noteRung(index);
        return index;
      } catch {
        // Try the next, thinner shape.
      }
    }
    noteRung(REFUSED);
    return REFUSED;
  };

  const notify = (): void => {
    for (const listener of listeners) listener();
  };

  /** This tab's list with what other tabs have stored since folded in. */
  const synced = (mine: readonly OutboxEntry[]): OutboxEntry[] => {
    const stored = current(backing);
    return trimmed(stored === null ? mine : merged(mine, stored, false), OUTBOX_CAP);
  };

  const commit = (next: OutboxEntry[]): number => {
    entries = synced(next);
    const rung = persist(entries);
    notify();
    return rung;
  };

  /** Rungs 0–2 keep every entry; rung 3 keeps only the newest. */
  const reached = (rung: number, id: string): boolean =>
    rung <= 2 || (rung === 3 && entries[0]?.id === id);

  /** Changes one entry if it is still here: a send's answer can outlive a clear. */
  const update = (id: string, change: (entry: OutboxEntry) => OutboxEntry): void => {
    if (!entries.some((e) => e.id === id)) return;
    commit(entries.map((e) => (e.id === id ? change(e) : e)));
  };

  const attempt = async (send: () => Promise<unknown>): Promise<"ok" | "refused" | "retry"> => {
    try {
      await send();
      return "ok";
    } catch (error) {
      return outcomeOf(error);
    }
  };

  /** Ids oldest first, from the list as it is now: a backlog goes in the order it was flagged. */
  const oldestFirst = (keep: (entry: OutboxEntry) => boolean): string[] =>
    entries
      .filter(keep)
      .map((e) => e.id)
      .reverse();

  // One run: submits, then notes. A submit the server didn't take for now
  // (down, capped, not deployed) ends the submits, since the rest would fare
  // the same; notes still try, as the rate cap doesn't bind them.
  const run = async (): Promise<void> => {
    for (const id of oldestFirst((e) => e.status === "waiting")) {
      if (forgotten) return;
      const entry = entries.find((e) => e.id === id);
      const captured = entry?.report;
      if (entry?.status !== "waiting" || !captured) continue;
      const note = entry.note;
      const outcome = await attempt(() => sender.submit({ ...captured, note }));
      if (forgotten) return;
      if (outcome === "retry") break;
      if (outcome === "refused") {
        update(id, (e) => ({ ...e, status: "refused" }));
        recordEvent("flag", "the server refused a report");
        continue;
      }
      update(id, (e) => toStub(e, note));
    }
    for (const id of oldestFirst((e) => e.status === "sent" && e.note !== e.sentNote)) {
      if (forgotten) return;
      const entry = entries.find((e) => e.id === id);
      if (entry?.status !== "sent" || entry.note === entry.sentNote) continue;
      const note = entry.note;
      const outcome = await attempt(() => sender.annotate(id, note));
      if (forgotten) return;
      if (outcome === "retry") break;
      // The outbox cuts a note to the server's cap, so a refusal here is a
      // bug, not the note: it is said once and not retried on every trigger.
      if (outcome === "refused") recordEvent("flag", "the server refused a note (BAD_REQUEST)");
      update(id, (e) => ({ ...e, sentNote: note }));
    }
  };

  let running: Promise<void> | null = null;
  let again = false;
  const flush = (): Promise<void> => {
    if (forgotten) return Promise.resolve();
    if (running !== null) {
      again = true;
      return running;
    }
    const rounds = async (): Promise<void> => {
      do {
        again = false;
        await run();
      } while (again && !forgotten);
    };
    running = rounds().finally(() => {
      running = null;
    });
    return running;
  };

  const remove = (id: string): void => {
    commit(entries.filter((e) => e.id !== id));
  };

  return {
    async add(report, step) {
      if (forgotten) return "failed";
      const others = trimmed(
        synced(entries).filter((e) => e.id !== report.id),
        OUTBOX_CAP - 1,
      );
      if (others.length >= OUTBOX_CAP) {
        // Every place is a flag still to send: refuse this one, out loud,
        // rather than drop one of those. Sending what waits frees places.
        recordEvent("flag", `the tablet holds ${String(OUTBOX_CAP)} flags still to send — a new flag was refused`);
        void flush();
        return "full";
      }
      const rung = commit([toEntry(report, step), ...others]);
      const sending = flush();
      if (reached(rung, report.id)) return "flagged";
      await sending;
      if (forgotten) return "failed";
      if (entries.find((e) => e.id === report.id)?.status === "sent") return "flagged";
      // Neither stored nor sent: the pill says so, and nothing stays behind
      // to go later, after the cook was told it didn't.
      remove(report.id);
      recordEvent("error", "a flag could be neither stored nor sent");
      return "failed";
    },
    list() {
      return entries;
    },
    annotate(id, note) {
      if (forgotten) return;
      const target = entries.find((e) => e.id === id);
      const next = cutToJsonBytes(note, NOTE_MAX_BYTES).text;
      if (target === undefined || target.note === next) return;
      const rung = commit(entries.map((e) => (e.id === id ? { ...e, note: next } : e)));
      // Otherwise memory and storage have just diverged for this entry, and
      // a write that didn't land (or a clear that left the old note on disk)
      // reappears on reload. That is said, as DOM thinning is.
      if (!reached(rung, id)) {
        recordEvent("flag", "storage was tight — this note may not survive a reload");
      }
      if (target.status !== "refused") void flush();
    },
    clearSent(ids) {
      if (forgotten) return;
      const next = entries.filter((e) => !whole(e) || (ids !== undefined && !ids.has(e.id)));
      if (next.length === entries.length) return;
      commit(next);
    },
    dismiss(id) {
      if (forgotten) return;
      if (entries.find((e) => e.id === id)?.status !== "refused") return;
      // Folded with storage first and written as is: `commit` would fold
      // storage in after, and take the refused flag back from it.
      entries = synced(entries).filter((e) => e.id !== id);
      persist(entries);
      notify();
    },
    flush,
    forget() {
      if (forgotten) return;
      forgotten = true;
      entries = [];
      again = false;
      notify();
    },
    start(target = window) {
      const onOnline = () => {
        if (forgotten) return;
        void flush();
      };
      // Another tab wrote: what it holds joins this list (`clear()` has no key).
      const onStorage = (event: StorageEvent) => {
        if (forgotten) return;
        if (event.key !== null && event.key !== OUTBOX_KEY) return;
        const stored = current(backing);
        if (stored === null) return;
        entries = trimmed(merged(entries, stored, true), OUTBOX_CAP);
        notify();
      };
      target.addEventListener("online", onOnline);
      target.addEventListener("storage", onStorage);
      void flush();
      return () => {
        target.removeEventListener("online", onOnline);
        target.removeEventListener("storage", onStorage);
      };
    },
    subscribe(listener) {
      listeners.add(listener);
      return () => {
        listeners.delete(listener);
      };
    },
  };
}
