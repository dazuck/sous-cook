// @vitest-environment happy-dom
import { cleanup, fireEvent, render, screen } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { TimerOffer } from "@/lib/kitchen/timer-attach";
import type { KitchenTimer } from "@/lib/kitchen/timers";
import { AlarmBand } from "./AlarmBand";
import { TimerHere } from "./KitchenTimers";
import { Clock, TIMER_COPY, TimerLine } from "./TimerLine";
import { TimerLedge, ledgeLead } from "./TimerLedge";

// Slice B5a, A7 and A8: the timer's four states, and the ledge. Ported in
// spirit from the Player's TimerChips.test.tsx (B5.md, the Player test map).

afterEach(cleanup);

const T0 = Date.UTC(2026, 9, 6, 18, 0, 0);
const offer: TimerOffer = {
  id: "q1:step-2",
  queueId: "q1",
  recipeName: "Shakshuka",
  stepId: "step-2",
  label: "Cook peppers",
  durationMs: 600_000,
  durationSec: 600,
};
const running: KitchenTimer = { ...offer, endsAtEpochMs: T0 + 600_000 };

function line(over: Partial<Parameters<typeof TimerLine>[0]> = {}) {
  const props = {
    offer,
    timer: null,
    now: T0,
    ember: false,
    soundLocked: false,
    onStart: vi.fn(),
    onAllowSound: vi.fn(),
    ...over,
  };
  // The step's line is on its own cook.
  render(
    <TimerHere queueId="q1">
      <TimerLine {...props} />
    </TimerHere>,
  );
  return props;
}

describe("TimerLine", () => {
  it("offers the recipe's stated length as one ghost word, which starts it", () => {
    const props = line();
    const start = screen.getByRole("button", { name: "Start 10 min timer" });
    expect(start.className).toContain("text-ink-soft");
    expect(start.className).not.toContain("before:border");
    expect(start.querySelector("svg")).not.toBeNull();
    fireEvent.click(start);
    expect(props.onStart).toHaveBeenCalledOnce();
  });

  it("fills the offer in ember when it is the next act (the last part): the one call to action", () => {
    line({ ember: true });
    const start = screen.getByRole("button", { name: "Start 10 min timer" });
    expect(start.className).toContain("bg-ember");
    expect(start.className).toContain("text-paper");
  });

  it("runs as a clock that is not a button, its digits alone in Caprasimo (the step names it)", () => {
    line({ timer: running, now: T0 + 133_000 });
    expect(screen.queryByRole("button")).toBeNull();
    const clock = screen.getByRole("timer", { name: "Cook peppers, 7:47 left" });
    expect(clock.textContent).toBe("7:47");
    const digits = clock.querySelector("[aria-hidden]")!;
    expect(digits.className).toContain("--font-display");
    expect(digits.className).toContain("text-ink");
  });

  it("draws the running digits in ember when the clock holds the screen's ember", () => {
    line({ timer: running, now: T0, ember: true });
    expect(screen.getByRole("timer").querySelector("[aria-hidden]")!.className).toContain("text-ember");
  });

  it("grows its last ten seconds, and beats in colour only when it holds the ember", () => {
    line({ timer: running, now: T0 + 591_000 });
    const digits = screen.getByRole("timer").querySelector("[aria-hidden]")!;
    expect(digits.className).toContain("timer-pulse");
    expect(digits.className).not.toContain("timer-beat");
    expect(digits.getAttribute("data-final-ten")).toBe("true");
    cleanup();
    line({ timer: running, now: T0 + 591_000, ember: true });
    expect(screen.getByRole("timer").querySelector("[aria-hidden]")!.className).toContain("timer-beat");
  });

  it("says the step's timer is done once stopped, with Again to time it once more", () => {
    const props = line({ done: true });
    expect(screen.getByText("10 min timer done")).toBeTruthy();
    fireEvent.click(screen.getByRole("button", { name: "Start the 10 min timer again" }));
    expect(props.onStart).toHaveBeenCalledOnce();
  });
});

describe("the alarm", () => {
  it("off its step, is one target that dismisses it, saying how long ago only past a minute", () => {
    const onDismiss = vi.fn();
    render(<Clock timer={running} now={T0 + 600_000 + 3 * 60_000} ember={false} size="chip" onDismiss={onDismiss} />);
    const alarm = screen.getByRole("button", { name: /Cook peppers timer: Finished 3 min ago/ });
    expect(alarm.textContent).toContain(TIMER_COPY.done);
    expect(alarm.querySelector(".timer-alarm")).not.toBeNull();
    fireEvent.click(alarm);
    expect(onDismiss).toHaveBeenCalledWith("q1:step-2");
    cleanup();
    render(<Clock timer={running} now={T0 + 600_000 + 5_000} ember={false} size="chip" onDismiss={onDismiss} />);
    expect(screen.getByRole("button").textContent).not.toContain("Finished");
  });

  it("on the cook screen, is the stage's band: Done at the step's size, named, with how to stop it", () => {
    const onDismiss = vi.fn();
    const rice = { ...running, id: "r", label: "Rice", endsAtEpochMs: T0 - 120_000 };
    render(<AlarmBand expired={[rice, running]} now={T0 + 600_001} onDismiss={onDismiss} />);
    const band = screen.getByRole("button", { name: /Rice timer: Finished 12 min ago/ });
    expect(band.textContent).toContain("Rice, and 1 more");
    expect(band.textContent).toContain(TIMER_COPY.stopHint);
    expect(band.querySelector(".timer-alarm")!.className).toContain("--type-step");
    fireEvent.click(band);
    expect(onDismiss).toHaveBeenCalledWith("r");
  });

  it("says the sound is off beside a running clock, and a tap on it allows it", () => {
    const props = line({ timer: running, now: T0, soundLocked: true });
    fireEvent.click(screen.getByRole("button", { name: TIMER_COPY.soundOff }));
    expect(props.onAllowSound).toHaveBeenCalledOnce();
  });

  it("says nothing of the sound at an offer: no timer runs yet", () => {
    line({ soundLocked: true });
    expect(screen.queryByRole("button", { name: TIMER_COPY.soundOff })).toBeNull();
  });
});

describe("the ledge", () => {
  // The well reads the page's clock: pin it to the fixtures' time.
  beforeEach(() => void vi.useFakeTimers({ now: T0 }));
  afterEach(() => void vi.useRealTimers());

  const a: KitchenTimer = { ...running, id: "a", label: "Rice", endsAtEpochMs: T0 + 300_000 };
  const b: KitchenTimer = { ...running, id: "b", label: "Dal", endsAtEpochMs: T0 + 100_000 };
  const done: KitchenTimer = { ...running, id: "c", label: "Bread", endsAtEpochMs: T0 - 1_000 };

  it("leads with an alarm, else the soonest to end", () => {
    expect(ledgeLead([a, b], T0)?.id).toBe("b");
    expect(ledgeLead([a, b, done], T0)?.id).toBe("c");
    expect(ledgeLead([], T0)).toBeNull();
  });

  it("keeps the clock's size, name over digits, and shows the next timer's own digits", () => {
    // In a cook's well, its own timers: named by their steps.
    render(
      <TimerHere queueId="q1">
        <TimerLedge timers={[a, b]} emberId={null} onDismiss={vi.fn()} />
      </TimerHere>,
    );
    const ledge = document.querySelector("[data-ledge]")!;
    const clocks = ledge.querySelectorAll('[role="timer"]');
    expect(clocks).toHaveLength(2);
    expect(clocks[0]!.getAttribute("aria-label")).toBe("Dal, 1:40 left");
    expect(clocks[0]!.querySelector("[aria-hidden]")!.className).toContain("--type-title");
    expect(clocks[1]!.getAttribute("aria-label")).toBe("Rice, 5:00 left");
    expect(ledge.textContent).not.toContain("+1");
  });

  it("says a third and beyond in words, never a count badge", () => {
    const c: KitchenTimer = { ...running, id: "x", label: "Stock", endsAtEpochMs: T0 + 900_000 };
    render(<TimerLedge timers={[a, b, c]} emberId={null} onDismiss={vi.fn()} />);
    expect(document.querySelector("[data-ledge]")!.textContent).toContain("and 1 more");
  });

  it("draws nothing with no timers", () => {
    const { container } = render(<TimerLedge timers={[]} emberId={null} onDismiss={vi.fn()} />);
    expect(container.innerHTML).toBe("");
  });
});

describe("a timer's name, by where it is shown", () => {
  it("on its own cook, the step's; anywhere else, the recipe's then the step's", () => {
    const { unmount } = render(
      <TimerHere queueId="q1">
        <AlarmBand expired={[running]} now={T0 + 600_000} onDismiss={vi.fn()} />
      </TimerHere>,
    );
    expect(screen.getByRole("button").getAttribute("aria-label")).toMatch(/^Cook peppers timer/);
    unmount();
    render(
      <TimerHere queueId="q2">
        <AlarmBand expired={[running]} now={T0 + 600_000} onDismiss={vi.fn()} />
      </TimerHere>,
    );
    expect(screen.getByRole("button").getAttribute("aria-label")).toMatch(/^Shakshuka · Cook peppers timer/);
  });

  it("on the kitchen, which is no cook's, the recipe's too", () => {
    render(<Clock timer={running} now={T0} ember={false} size="title" onDismiss={vi.fn()} />);
    expect(screen.getByText("Shakshuka · Cook peppers")).toBeTruthy();
    // Said as it is drawn.
    expect(screen.getByRole("timer").getAttribute("aria-label")).toBe("Shakshuka · Cook peppers, 10:00 left");
  });
});

describe("an alarm on a ledge", () => {
  it("keeps the well's width for its name and says the time since rather than drawing it", () => {
    const long: KitchenTimer = {
      ...running,
      recipeName: "Chicken and Rice With Lemon, Garlic and a Great Many Herbs",
      label: "Simmer the rice until every grain is tender",
    };
    render(<Clock timer={long} now={T0 + 600_000 + 3 * 60_000} ember={false} size="title" stacked onDismiss={vi.fn()} />);
    const alarm = screen.getByRole("button");
    expect(alarm.getAttribute("aria-label")).toContain("Finished 3 min ago");
    expect(alarm.textContent).not.toContain("Finished");
    const name = alarm.querySelector("span")!;
    expect(name.className).toContain("max-w-[calc(180*var(--cpx))]");
    expect(name.className).toContain("truncate");
  });
});
