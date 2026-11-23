import { beforeEach, describe, expect, it } from "vitest";
import { consumeCorruptionNotices } from "@/lib/persist/safe-storage";
import { INTERLUDES_KEY, INTERLUDES_RESET_COPY, isCollapsed, markSeen, timesSeen } from "./interlude-seen";

// The interlude count (slice B5d, B5.md §B5d D9).

function memory() {
  const data = new Map<string, string>();
  return {
    data,
    getItem: (k: string) => data.get(k) ?? null,
    setItem: (k: string, v: string) => void data.set(k, v),
    removeItem: (k: string) => void data.delete(k),
  };
}

beforeEach(() => consumeCorruptionNotices());

describe("interlude-seen", () => {
  it("shows in full until moved past once, then collapses", () => {
    const store = memory();
    const keys = ["commons:deep-frying"];
    expect(isCollapsed(keys, store)).toBe(false);
    expect(markSeen(keys, store)).toBe(true);
    expect(timesSeen(keys, store)).toBe(1);
    expect(isCollapsed(keys, store)).toBe(true);
  });

  it("the least familiar technique governs", () => {
    const store = memory();
    markSeen(["commons:deep-frying"], store);
    expect(isCollapsed(["commons:deep-frying", "commons:testing-fat-temperature"], store)).toBe(false);
    markSeen(["commons:testing-fat-temperature"], store);
    expect(isCollapsed(["commons:deep-frying", "commons:testing-fat-temperature"], store)).toBe(true);
  });

  it("a corrupt count is cleared, with its own reset line once", () => {
    const store = memory();
    store.data.set(INTERLUDES_KEY, JSON.stringify({ version: 1, state: { "commons:x": "two" } }));
    expect(isCollapsed(["commons:x"], store)).toBe(false);
    expect(store.data.has(INTERLUDES_KEY)).toBe(false);
    expect(consumeCorruptionNotices().map((n) => n.text)).toEqual([INTERLUDES_RESET_COPY]);
    expect(consumeCorruptionNotices()).toEqual([]);
  });

  it("with no storage, every interlude shows in full and nothing throws", () => {
    expect(isCollapsed(["commons:x"], null)).toBe(false);
    expect(markSeen(["commons:x"], null)).toBe(false);
  });

  it("storage that throws on write is no data loss", () => {
    const store = { ...memory(), setItem: () => { throw new Error("QuotaExceededError"); } };
    expect(markSeen(["commons:x"], store)).toBe(false);
  });
});
