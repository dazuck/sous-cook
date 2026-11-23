// @vitest-environment happy-dom
import { act, renderHook } from "@testing-library/react";
import { StrictMode } from "react";
import { beforeEach, describe, expect, it } from "vitest";
import { ZUCCHINI_PLAN } from "@/lib/kitchen/__tests__/zucchini-wraps";
import { startSession } from "@/lib/kitchen/cook-session";
import { recentEvents, resetEventLog } from "@/lib/kitchen/report-events";
import { useCookSession } from "./useCookSession";

// The cook session as the queue page holds it, with each move logged for a
// flag's lead-up (B2 decision 9): once per action, where the reducer itself
// runs twice under StrictMode.

const start = () => startSession(ZUCCHINI_PLAN, { kind: "derived" }, "first");

beforeEach(resetEventLog);

function details() {
  return recentEvents().map((e) => [e.kind, e.detail]);
}

describe("useCookSession", () => {
  it("logs the open once, and each move once with where it left the cook, under StrictMode", () => {
    const { result } = renderHook(() => useCookSession("Zucchini wraps", start), {
      wrapper: StrictMode,
    });
    act(() => result.current[1]({ type: "next" }));
    act(() => result.current[1]({ type: "next" }));
    act(() => result.current[1]({ type: "back" }));
    expect(result.current[0].state.pos).toBe(1);
    expect(details()).toEqual([
      ["cook", "open Zucchini wraps"],
      ["step", "next → 1"],
      ["step", "next → 2"],
      ["step", "back → 1"],
    ]);
  });

  it("logs moves sent together in order, each from where the last left it", () => {
    const { result } = renderHook(() => useCookSession("Zucchini wraps", start));
    act(() => {
      result.current[1]({ type: "next" });
      result.current[1]({ type: "next" });
    });
    expect(result.current[0].state.pos).toBe(2);
    expect(details().slice(1)).toEqual([
      ["step", "next → 1"],
      ["step", "next → 2"],
    ]);
  });

  it("keeps the session after each move, with where the move left it (B5b)", () => {
    const saved: number[] = [];
    const { result } = renderHook(
      () => useCookSession("Zucchini wraps", start, (s) => saved.push(s.state.pos)),
      { wrapper: StrictMode },
    );
    act(() => result.current[1]({ type: "next" }));
    act(() => result.current[1]({ type: "next" }));
    // Kept as it opened (a resumed session is written back unchanged), then
    // after each move; StrictMode's second effect run only writes the same again.
    expect(saved.at(-1)).toBe(2);
    expect([...new Set(saved)]).toEqual([0, 1, 2]);
  });

  it("keeps one dispatch across renders", () => {
    const { result, rerender } = renderHook(() => useCookSession("Zucchini wraps", start));
    const first = result.current[1];
    act(() => first({ type: "next" }));
    rerender();
    expect(result.current[1]).toBe(first);
  });
});
