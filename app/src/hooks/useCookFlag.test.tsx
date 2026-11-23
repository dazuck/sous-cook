// @vitest-environment happy-dom
import { act, renderHook } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { CookReport, CookSnapshot, FlagStep } from "@/lib/kitchen/report-capture";
import type { FlagResult } from "@/lib/kitchen/report-outbox";
import { recentEvents, resetEventLog } from "@/lib/kitchen/report-events";
import type { Miss } from "@/lib/kitchen/flag-misses";
import { FLAG_ACK_MS, FLAG_FOLD_MS, useCookFlag, type CookFlagDeps } from "./useCookFlag";

// The flag on the cook page (B2 decisions 3–5, F2, F5): one synchronous
// capture into the outbox, and the pill's acknowledgment for 1.6 s, a flag
// kept or not; one not kept waits in the miss log for the hub (panel round 4).

function snapshot(pos: number): CookSnapshot {
  return {
    queueId: null,
    recipeName: "Zucchini wraps",
    plan: { version: 4 },
    planVersion: 4,
    state: { mode: "first", pos, ticked: [], passed: [], kept: [] },
    screen: "step",
    stepKey: "saute",
    chapterId: "batch:saute",
    step: { n: pos, of: 6, name: "Sauté the zucchini" },
    part: null,
    layers: { pane: false, card: null, more: false },
    voice: { mode: "always", status: "listening" },
    ask: { sessionId: "cook-queue-1", open: false },
  };
}

let clock = 1_770_000_000_000;
let ids = 0;
let added: CookReport[] = [];
let steps: (FlagStep | null)[] = [];
let answer: FlagResult = "flagged";
let missed: Miss[] = [];
let notes: [string, string][] = [];
let root: HTMLElement;

function deps(): CookFlagDeps {
  return {
    add: (report, step) => {
      added.push(report);
      steps.push(step);
      return Promise.resolve(answer);
    },
    now: () => clock,
    id: () => `00000000-0000-4000-8000-${String(++ids).padStart(12, "0")}`,
    build: () => "2026-10-04-abcd1234",
    miss: (why) => missed.push(why),
    annotate: (id, note) => notes.push([id, note]),
    noteOf: () => "",
  };
}

/** Flags, and lets the outbox's answer land. */
async function flagAt(flag: () => void) {
  await act(async () => {
    flag();
    await Promise.resolve();
  });
}

beforeEach(() => {
  vi.useFakeTimers({ toFake: ["setTimeout", "clearTimeout"] });
  clock = 1_770_000_000_000;
  ids = 0;
  added = [];
  steps = [];
  answer = "flagged";
  missed = [];
  notes = [];
  resetEventLog();
  root = document.createElement("div");
  root.setAttribute("data-cook-root", "");
  root.innerHTML = '<p>Sauté the onion</p><div data-capture-omit="">menu</div>';
  document.body.append(root);
});

afterEach(() => {
  root.remove();
  vi.useRealTimers();
});

describe("useCookFlag", () => {
  it("captures the cook root and the snapshot into the outbox, synchronously", () => {
    let pos = 1;
    const { result } = renderHook(() => useCookFlag(() => snapshot(pos), deps()));
    act(() => result.current.flag());
    pos = 2;
    expect(added).toHaveLength(1);
    const [report] = added;
    expect(report).toMatchObject({
      build: "2026-10-04-abcd1234",
      capturedAt: new Date(clock).toISOString(),
      screen: "step",
      stepKey: "saute",
      state: { pos: 1 },
      domTruncated: false,
    });
    expect(report?.dom).toContain("Sauté the onion");
    expect(report?.dom).not.toContain("menu");
    // The step goes to the outbox beside the report, for the panel's row.
    expect(steps).toEqual([{ n: 1, of: 6, name: "Sauté the zucchini" }]);
    expect(report).not.toHaveProperty("step");
  });

  it("says Noted for 1.6 s, then goes quiet", async () => {
    const { result } = renderHook(() => useCookFlag(() => snapshot(1), deps()));
    expect(result.current.ack).toBe("idle");
    await flagAt(result.current.flag);
    expect(result.current.ack).toBe("flagged");
    act(() => vi.advanceTimersByTime(FLAG_ACK_MS - 1));
    expect(result.current.ack).toBe("flagged");
    act(() => vi.advanceTimersByTime(1));
    expect(result.current.ack).toBe("idle");
  });

  it.each([
    ["failed", "the outbox could neither store nor send it (F2)"],
    ["full", "the tablet already holds as many flags still to send as it keeps (F11)"],
  ] as const)("says %s for 1.6 s too, and logs the miss for the hub, when %s", async (outcome, _why) => {
    answer = outcome;
    const { result } = renderHook(() => useCookFlag(() => snapshot(1), deps()));
    await flagAt(result.current.flag);
    expect(result.current.ack).toBe(outcome);
    expect(missed).toEqual([outcome]);
    // A flag not kept doesn't hold over the cook (panel round 4): it waits in the hub.
    act(() => vi.advanceTimersByTime(FLAG_ACK_MS));
    expect(result.current.ack).toBe("idle");
  });

  it("logs no miss for a flag kept", async () => {
    const { result } = renderHook(() => useCookFlag(() => snapshot(1), deps()));
    await flagAt(result.current.flag);
    expect(missed).toEqual([]);
  });

  it("a flag kept after one not kept says Noted, and goes after 1.6 s", async () => {
    answer = "failed";
    const { result } = renderHook(() => useCookFlag(() => snapshot(1), deps()));
    await flagAt(result.current.flag);
    answer = "flagged";
    await flagAt(result.current.flag);
    expect(result.current.ack).toBe("flagged");
    act(() => vi.advanceTimersByTime(FLAG_ACK_MS));
    expect(result.current.ack).toBe("idle");
  });

  it("folds a second flag within 2 s at the same place into the first (F5)", async () => {
    const { result } = renderHook(() => useCookFlag(() => snapshot(1), deps()));
    await flagAt(result.current.flag);
    act(() => vi.advanceTimersByTime(1000));
    clock += 1000;
    await flagAt(result.current.flag);
    expect(added).toHaveLength(1);
    // The acknowledgment repeats: a full 1.6 s from the second flag.
    act(() => vi.advanceTimersByTime(FLAG_ACK_MS - 1));
    expect(result.current.ack).toBe("flagged");
    act(() => vi.advanceTimersByTime(1));
    expect(result.current.ack).toBe("idle");
  });

  it("takes a second report once the cook has moved, or 2 s have gone", async () => {
    let pos = 1;
    const { result } = renderHook(() => useCookFlag(() => snapshot(pos), deps()));
    await flagAt(result.current.flag);
    pos = 2;
    await flagAt(result.current.flag);
    expect(added).toHaveLength(2);
    clock += FLAG_FOLD_MS;
    await flagAt(result.current.flag);
    expect(added).toHaveLength(3);
    expect(new Set(added.map((r) => r.id)).size).toBe(3);
  });

  it("logs each flag, and the folds", async () => {
    const { result } = renderHook(() => useCookFlag(() => snapshot(1), deps()));
    await flagAt(result.current.flag);
    await flagAt(result.current.flag);
    const flags = recentEvents().filter((e) => e.kind === "flag");
    expect(flags.map((e) => e.detail)).toEqual(["step at 1", "folded into the flag before it"]);
    // The report carries the lead-up, not its own flag.
    expect(added[0]?.events.some((e) => e.kind === "flag")).toBe(false);
  });

  it("says Failed, and logs why, with no cook root on the page", async () => {
    root.remove();
    const said = vi.spyOn(console, "error").mockImplementation(() => {});
    const { result } = renderHook(() => useCookFlag(() => snapshot(1), deps()));
    await flagAt(result.current.flag);
    expect(added).toHaveLength(0);
    expect(result.current.ack).toBe("failed");
    expect(missed).toEqual(["failed"]);
    expect(recentEvents().at(-1)).toMatchObject({ kind: "error" });
    expect(recentEvents().at(-1)?.detail).toMatch(/cook root/);
    expect(said).toHaveBeenCalledOnce();
    said.mockRestore();
  });

  it.each(["failed", "full"] as const)("does not fold into a flag the outbox didn't take (%s)", async (outcome) => {
    answer = outcome;
    const { result } = renderHook(() => useCookFlag(() => snapshot(1), deps()));
    await flagAt(result.current.flag);
    answer = "flagged";
    await flagAt(result.current.flag);
    expect(added).toHaveLength(2);
    expect(result.current.ack).toBe("flagged");
  });

  // Cook-fidelity decision 8: a flag taken by touch opens a note on it.
  describe("the flag's note", () => {
    it("names the flag taken at once, kept once the outbox keeps it, and a note goes to it", async () => {
      let keep: (r: FlagResult) => void = () => {};
      const d = { ...deps(), add: (report: CookReport) => {
        added.push(report);
        return new Promise<FlagResult>((resolve) => (keep = resolve));
      } };
      const { result } = renderHook(() => useCookFlag(() => snapshot(1), d));
      let taken: ReturnType<typeof result.current.flag> | undefined;
      act(() => {
        taken = result.current.flag();
      });
      const id = added[0]?.id;
      expect(taken).toEqual({ kind: "kept", id });
      // Not kept until the outbox says so.
      expect(result.current.kept).toBeNull();
      await act(async () => {
        keep("flagged");
        await Promise.resolve();
      });
      expect(result.current.kept).toBe(id);

      act(() => result.current.annotate(id!, "the stock was never put on"));
      expect(notes).toEqual([[id, "the stock was never put on"]]);
    });

    it("a fold names the flag it folded into", async () => {
      const { result } = renderHook(() => useCookFlag(() => snapshot(1), deps()));
      await flagAt(result.current.flag);
      let again: ReturnType<typeof result.current.flag> | undefined;
      await act(async () => {
        again = result.current.flag();
        await Promise.resolve();
      });
      expect(again).toEqual({ kind: "folded", id: added[0]?.id });
      expect(added).toHaveLength(1);
    });

    it.each(["failed", "full"] as const)("a flag the outbox answers %s is never kept", async (outcome) => {
      answer = outcome;
      const { result } = renderHook(() => useCookFlag(() => snapshot(1), deps()));
      await flagAt(result.current.flag);
      expect(result.current.kept).toBeNull();
    });

    it("a capture that fails says so at once", () => {
      root.remove();
      const said = vi.spyOn(console, "error").mockImplementation(() => {});
      const { result } = renderHook(() => useCookFlag(() => snapshot(1), deps()));
      let taken: ReturnType<typeof result.current.flag> | undefined;
      act(() => {
        taken = result.current.flag();
      });
      expect(taken).toEqual({ kind: "failed" });
      expect(result.current.kept).toBeNull();
      said.mockRestore();
      document.body.append(root);
    });
  });
});
