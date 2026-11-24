// @vitest-environment happy-dom
import { cleanup, render } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";

// The clocks' flight (`clock-flight`) records where each timer's digits stand, by the timer's id.
vi.mock("./clock-flight", () => ({ markClock: vi.fn(), flyClockIn: vi.fn() }));
import { flyClockIn, markClock } from "./clock-flight";
import { TimerLedge } from "./TimerLedge";

afterEach(() => {
  cleanup();
  vi.mocked(markClock).mockClear();
  vi.mocked(flyClockIn).mockClear();
});

const T0 = Date.now();
const timer = (id: string, label: string, durationMs: number, left: number) => ({
  id,
  queueId: "q1",
  recipeName: "Roast",
  stepId: id,
  label,
  durationMs,
  endsAtEpochMs: T0 + left,
});

describe("TimerLedge, still: the foot's held room (DECISIONS 2026-11-24)", () => {
  const timers = [timer("q1:rest", "Rest chicken", 900_000, 899_000), timer("q1:roast", "Roast chicken", 3_000_000, 1_200_000)];

  it("the well's own clocks mark where they stand, so a clock can fly from there", () => {
    render(<TimerLedge timers={timers} emberId={null} onDismiss={vi.fn()} />);
    expect([...new Set(vi.mocked(markClock).mock.calls.map((c) => c[0]))].sort()).toEqual(["q1:rest", "q1:roast"]);
  });

  it("held still, it marks no clock and flies none: the room it holds is no place a clock stood", () => {
    render(<TimerLedge timers={timers} emberId={null} onDismiss={vi.fn()} at={T0} still />);
    expect(markClock).not.toHaveBeenCalled();
    expect(flyClockIn).not.toHaveBeenCalled();
    // No live clock to announce either.
    expect(document.querySelectorAll('[role="timer"]')).toHaveLength(0);
  });

  it("held still, each clock stands at its whole length, so the room never narrows as the digits count down", () => {
    const { container } = render(<TimerLedge timers={timers} emberId={null} onDismiss={vi.fn()} at={T0 + 61_000} still />);
    expect(container.textContent).toContain("15:00");
    expect(container.textContent).toContain("50:00");
    expect(container.textContent).not.toContain("13:58");
  });

  it("held still, it never subscribes to the clock, so nothing in it draws again on the tick; the well's own clocks do", () => {
    vi.useFakeTimers();
    try {
      const still = render(<TimerLedge timers={timers} emberId={null} onDismiss={vi.fn()} at={T0} still />);
      expect(vi.getTimerCount()).toBe(0);
      still.unmount();
      render(<TimerLedge timers={timers} emberId={null} onDismiss={vi.fn()} />);
      expect(vi.getTimerCount()).toBeGreaterThan(0);
    } finally {
      cleanup();
      vi.useRealTimers();
    }
  });

  it("held still, a clock past its end is still its whole length as text: no alarm, no button, whatever the moment (review round 3)", () => {
    const { container } = render(<TimerLedge timers={timers} emberId={null} onDismiss={vi.fn()} at={T0 + 2_000_000} still />);
    expect(container.querySelector("button")).toBeNull();
    expect(container.querySelector('[data-timer="alarm"]')).toBeNull();
    expect(container.textContent).toContain("15:00");
    expect(container.textContent).toContain("50:00");
  });
});
