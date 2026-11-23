import { beforeEach, describe, expect, it, vi } from "vitest";
import { consumeCorruptionNotices, type StringStore } from "../persist/safe-storage";
import { TIMERS_KEY, createTimerStore, type TimerStart } from "./timer-store";

function memoryStore(): StringStore & { data: Map<string, string> } {
  const data = new Map<string, string>();
  return {
    data,
    getItem: (k) => data.get(k) ?? null,
    setItem: (k, v) => void data.set(k, v),
    removeItem: (k) => void data.delete(k),
  };
}

const T0 = Date.UTC(2026, 9, 6, 18, 0, 0);

const dal: TimerStart = {
  id: "q1:step-3",
  queueId: "q1",
  recipeName: "Dal",
  stepId: "step-3",
  label: "Simmer dal",
  durationMs: 9 * 60_000,
};

beforeEach(() => {
  consumeCorruptionNotices();
});

describe("timer store", () => {
  it("starts a timer at an absolute end time, and keeps it", () => {
    const backing = memoryStore();
    const store = createTimerStore(backing);
    expect(store.start(dal, T0)).toBe("started");
    expect(store.getSnapshot()).toEqual([{ ...dal, endsAtEpochMs: T0 + 9 * 60_000 }]);
    // A reload reads it back.
    expect(createTimerStore(backing).getSnapshot()).toEqual(store.getSnapshot());
  });

  it("replaces a timer with the same id on a tap, so starts never stack", () => {
    const store = createTimerStore(memoryStore());
    store.start(dal, T0);
    store.start(dal, T0 + 1000);
    expect(store.getSnapshot()).toHaveLength(1);
    expect(store.getSnapshot()[0]!.endsAtEpochMs).toBe(T0 + 1000 + 9 * 60_000);
  });

  it("leaves a running timer alone when asked not to restart it (voice is idempotent)", () => {
    const store = createTimerStore(memoryStore());
    store.start(dal, T0);
    expect(store.start(dal, T0 + 5000, { restart: false })).toBe("running");
    expect(store.getSnapshot()[0]!.endsAtEpochMs).toBe(T0 + 9 * 60_000);
  });

  it("dismisses one timer by id, and tells subscribers", () => {
    const store = createTimerStore(memoryStore());
    const heard = vi.fn();
    store.subscribe(heard);
    store.start(dal, T0);
    store.start({ ...dal, id: "adhoc:1", stepId: null, label: "Timer" }, T0);
    store.dismiss("q1:step-3");
    expect(store.getSnapshot().map((t) => t.id)).toEqual(["adhoc:1"]);
    expect(heard).toHaveBeenCalledTimes(3);
  });

  it("clears corrupt saved timers and says so once", () => {
    const backing = memoryStore();
    backing.setItem(TIMERS_KEY, JSON.stringify({ version: 1, state: [{ id: 3 }] }));
    expect(createTimerStore(backing).getSnapshot()).toEqual([]);
    expect(consumeCorruptionNotices()).toEqual([
      { store: TIMERS_KEY, reason: "stored data did not match the expected shape" },
    ]);
    expect(backing.data.has(TIMERS_KEY)).toBe(false);
  });

  it("takes another tab's write when told the key changed", () => {
    const backing = memoryStore();
    const here = createTimerStore(backing);
    const there = createTimerStore(backing);
    there.start(dal, T0);
    const heard = vi.fn();
    here.subscribe(heard);
    here.reload();
    expect(here.getSnapshot().map((t) => t.id)).toEqual(["q1:step-3"]);
    expect(heard).toHaveBeenCalledOnce();
  });

  it("gives the same snapshot until something changes", () => {
    const store = createTimerStore(memoryStore());
    expect(store.getSnapshot()).toBe(store.getSnapshot());
  });

  it("works with no storage at all", () => {
    const store = createTimerStore(null);
    expect(store.start(dal, T0)).toBe("started");
    expect(store.getSnapshot()).toHaveLength(1);
  });
});
