import { beforeEach, describe, expect, it, vi } from "vitest";
import { z } from "zod";
import {
  consumeCorruptionNotices,
  readStored,
  removeStored,
  subscribeCorruptionNotices,
  writeStored,
  type StringStore,
} from "./safe-storage";

/** An in-memory store; `fail` makes the named method throw, as blocked storage does. */
function memoryStore(fail: Partial<Record<keyof StringStore, Error>> = {}) {
  const data = new Map<string, string>();
  const store: StringStore & { data: Map<string, string> } = {
    data,
    getItem: (key) => {
      if (fail.getItem) throw fail.getItem;
      return data.get(key) ?? null;
    },
    setItem: (key, value) => {
      if (fail.setItem) throw fail.setItem;
      data.set(key, value);
    },
    removeItem: (key) => {
      if (fail.removeItem) throw fail.removeItem;
      data.delete(key);
    },
  };
  return store;
}

const schema = z.object({ count: z.number().int().nonnegative(), label: z.string() });

beforeEach(() => {
  consumeCorruptionNotices();
  vi.restoreAllMocks();
});

describe("readStored and writeStored", () => {
  it("round-trips a value through its envelope", () => {
    const store = memoryStore();
    expect(writeStored("k", { count: 2, label: "rice" }, store)).toBe(true);
    expect(JSON.parse(store.data.get("k")!)).toEqual({
      version: 1,
      state: { count: 2, label: "rice" },
    });
    expect(readStored("k", schema, store)).toEqual({ count: 2, label: "rice" });
    expect(consumeCorruptionNotices()).toEqual([]);
  });

  it("reads nothing, and reports nothing, when the key is absent", () => {
    expect(readStored("k", schema, memoryStore())).toBeNull();
    expect(consumeCorruptionNotices()).toEqual([]);
  });

  it("clears stored data that isn't JSON, and says so once", () => {
    const store = memoryStore();
    store.data.set("k", "{not json");
    expect(readStored("k", schema, store)).toBeNull();
    expect(store.data.has("k")).toBe(false);
    expect(consumeCorruptionNotices()).toEqual([
      { store: "k", reason: "stored data was not valid JSON" },
    ]);
    expect(consumeCorruptionNotices()).toEqual([]);
  });

  it("a notice carries the reader's own words for its reset, for each kind of reset", () => {
    const store = memoryStore();
    store.data.set("a", "{not json");
    store.data.set("b", JSON.stringify({ version: 2, state: { count: 1, label: "x" } }));
    store.data.set("c", JSON.stringify({ version: 1, state: { count: -1, label: "x" } }));
    for (const key of ["a", "b", "c"]) expect(readStored(key, schema, store, 1, `${key} was reset.`)).toBeNull();
    expect(consumeCorruptionNotices().map((n) => [n.store, n.text])).toEqual([
      ["a", "a was reset."],
      ["b", "b was reset."],
      ["c", "c was reset."],
    ]);
  });

  it("clears stored data whose shape drifted, and says so", () => {
    const store = memoryStore();
    store.data.set("k", JSON.stringify({ version: 1, state: { count: -1, label: "x" } }));
    expect(readStored("k", schema, store)).toBeNull();
    expect(store.data.has("k")).toBe(false);
    expect(consumeCorruptionNotices()).toEqual([
      { store: "k", reason: "stored data did not match the expected shape" },
    ]);
  });

  it("treats a bare value with no envelope as drifted", () => {
    const store = memoryStore();
    store.data.set("k", JSON.stringify({ count: 1, label: "x" }));
    expect(readStored("k", schema, store)).toBeNull();
    expect(consumeCorruptionNotices()).toHaveLength(1);
  });

  it("clears a value written at another version rather than misreading it", () => {
    const store = memoryStore();
    store.data.set("k", JSON.stringify({ version: 2, state: { count: 1, label: "x" } }));
    expect(readStored("k", schema, store)).toBeNull();
    expect(store.data.has("k")).toBe(false);
    expect(consumeCorruptionNotices()).toEqual([
      { store: "k", reason: "stored data was written by another version" },
    ]);
  });

  it("reads a value at the version it is asked for", () => {
    const store = memoryStore();
    writeStored("k", { count: 3, label: "y" }, store, 2);
    expect(readStored("k", schema, store, 2)).toEqual({ count: 3, label: "y" });
  });

  it("keeps what the schema's defaults fill in", () => {
    const grown = z.object({ count: z.number(), extra: z.array(z.string()).default([]) });
    const store = memoryStore();
    store.data.set("k", JSON.stringify({ version: 1, state: { count: 1 } }));
    expect(readStored("k", grown, store)).toEqual({ count: 1, extra: [] });
    expect(consumeCorruptionNotices()).toEqual([]);
  });
});

describe("storage that fails", () => {
  it("reads nothing when storage throws on read, and reports no corruption", () => {
    vi.spyOn(console, "warn").mockImplementation(() => {});
    const store = memoryStore({ getItem: new Error("SecurityError") });
    expect(readStored("k", schema, store)).toBeNull();
    expect(consumeCorruptionNotices()).toEqual([]);
    expect(console.warn).toHaveBeenCalled();
  });

  it("returns false and logs when a write throws (quota, blocked)", () => {
    const warn = vi.spyOn(console, "warn").mockImplementation(() => {});
    const store = memoryStore({ setItem: new Error("QuotaExceededError") });
    expect(writeStored("k", { count: 1, label: "x" }, store)).toBe(false);
    expect(warn).toHaveBeenCalled();
  });

  it("still reports corruption when clearing the bad value throws", () => {
    vi.spyOn(console, "warn").mockImplementation(() => {});
    const store = memoryStore({ removeItem: new Error("blocked") });
    store.data.set("k", "nope");
    expect(readStored("k", schema, store)).toBeNull();
    expect(consumeCorruptionNotices()).toHaveLength(1);
  });

  it("reads nothing with no storage at all (the server)", () => {
    expect(readStored("k", schema, null)).toBeNull();
    expect(writeStored("k", { count: 1, label: "x" }, null)).toBe(false);
  });

  it("removes a key, and survives a remove that throws", () => {
    vi.spyOn(console, "warn").mockImplementation(() => {});
    const store = memoryStore();
    writeStored("k", { count: 1, label: "x" }, store);
    removeStored("k", store);
    expect(store.data.has("k")).toBe(false);
    expect(() => removeStored("k", memoryStore({ removeItem: new Error("x") }))).not.toThrow();
  });
});

describe("corruption notices", () => {
  it("tells subscribers when a notice arrives, until they unsubscribe", () => {
    const heard = vi.fn();
    const unsubscribe = subscribeCorruptionNotices(heard);
    const store = memoryStore();
    store.data.set("k", "bad");
    readStored("k", schema, store);
    expect(heard).toHaveBeenCalledTimes(1);
    unsubscribe();
    store.data.set("k", "bad");
    readStored("k", schema, store);
    expect(heard).toHaveBeenCalledTimes(1);
    expect(consumeCorruptionNotices()).toHaveLength(2);
  });
});
