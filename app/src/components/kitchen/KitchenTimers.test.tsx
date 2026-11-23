// @vitest-environment happy-dom
import { act, cleanup, render, screen } from "@testing-library/react";
import { useLayoutEffect } from "react";
import { flushSync } from "react-dom";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { Chime } from "@/lib/kitchen/chime";
import { TIMERS_KEY, createTimerStore, type TimerStart } from "@/lib/kitchen/timer-store";
import { loadSession, SESSION_RESET_COPY } from "@/lib/kitchen/cook-session";
import { consumeCorruptionNotices, type StringStore } from "@/lib/persist/safe-storage";
import { KitchenHome } from "./KitchenHome";
import { KitchenTimersProvider, TimerNotices, useKitchenTimers, useNow, type KitchenTimers } from "./KitchenTimers";
import { strip, type Strip, type StripMark } from "@/lib/kitchen/cook-strip";
import { initialCookState, next, type CookState } from "@/lib/kitchen/cook-view";
import { timedStrip } from "@/lib/kitchen/cook-overview";
import { loadKitchenPlans } from "@/lib/kitchen/__tests__/load-kitchen-plans";
import { LedgeClocks } from "./LedgeClocks";

// Slice B5a, A11: one engine for every kitchen page.

const T0 = Date.UTC(2026, 9, 6, 18, 0, 0);

function memory(): StringStore {
  const data = new Map<string, string>();
  return {
    getItem: (k) => data.get(k) ?? null,
    setItem: (k, v) => void data.set(k, v),
    removeItem: (k) => void data.delete(k),
  };
}

function fakeChime(unlocked = true): Chime & { play: ReturnType<typeof vi.fn> } {
  let open = unlocked;
  return {
    unlock: () => {
      open = true;
    },
    unlocked: () => open,
    play: vi.fn(() => open),
  };
}

const rice: TimerStart = {
  id: "q1:step-1",
  queueId: "q1",
  recipeName: "Rice",
  stepId: "step-1",
  label: "Simmer rice",
  durationMs: 60_000,
};

let seen: KitchenTimers;
function Probe() {
  const value = useKitchenTimers();
  useLayoutEffect(() => {
    seen = value;
  });
  return <p data-testid="probe">{value.notices.join("|")}</p>;
}

function mount(store = createTimerStore(memory()), chime = fakeChime(), claims = memory()) {
  render(
    <KitchenTimersProvider store={store} chime={chime} claims={claims}>
      <Probe />
    </KitchenTimersProvider>,
  );
  return { store, chime };
}

beforeEach(() => {
  vi.useFakeTimers({ now: T0 });
  consumeCorruptionNotices();
});
afterEach(() => {
  cleanup();
  vi.useRealTimers();
});

describe("KitchenTimersProvider", () => {
  it("chimes once as a timer ends, then every minute until five, and holds the alarm", () => {
    const { chime } = mount();
    act(() => void seen.start(rice));
    act(() => void vi.advanceTimersByTime(59_500));
    expect(chime.play).not.toHaveBeenCalled();
    expect(seen.expired.size).toBe(0);
    act(() => void vi.advanceTimersByTime(1_000));
    expect(chime.play).toHaveBeenCalledTimes(1);
    expect([...seen.expired]).toEqual(["q1:step-1"]);
    act(() => void vi.advanceTimersByTime(60_000));
    expect(chime.play).toHaveBeenCalledTimes(2);
    act(() => void vi.advanceTimersByTime(10 * 60_000));
    expect(chime.play).toHaveBeenCalledTimes(5);
    expect([...seen.expired]).toEqual(["q1:step-1"]);
  });

  it("stops chiming once dismissed", () => {
    const { chime } = mount();
    act(() => void seen.start(rice));
    act(() => void vi.advanceTimersByTime(60_500));
    act(() => seen.dismiss("q1:step-1"));
    act(() => void vi.advanceTimersByTime(5 * 60_000));
    expect(chime.play).toHaveBeenCalledTimes(1);
    expect(seen.timers).toEqual([]);
  });

  it("holds nothing as finished once the last ringing timer is dismissed, and a restart starts clean", () => {
    mount();
    act(() => void seen.start(rice));
    act(() => void vi.advanceTimersByTime(60_500));
    expect([...seen.expired]).toEqual(["q1:step-1"]);
    // It rings for a while: each tick finds the same finished set and changes nothing.
    act(() => void vi.advanceTimersByTime(3_000));
    act(() => void vi.advanceTimersByTime(3_000));
    act(() => seen.dismiss("q1:step-1"));
    expect(seen.timers).toEqual([]);
    expect(seen.expired.size).toBe(0);
    expect(seen.stopped.has("q1:step-1")).toBe(true);
    // Started again: it runs, and was never shown as finished on the way.
    act(() => void seen.start(rice));
    expect(seen.timers).toHaveLength(1);
    expect(seen.expired.size).toBe(0);
    act(() => void vi.advanceTimersByTime(1_000));
    expect(seen.expired.size).toBe(0);
  });

  it("holds nothing as finished after the last dismissal, with ticks from the ringing still queued", async () => {
    mount();
    act(() => void seen.start(rice));
    act(() => void vi.advanceTimersByTime(60_500));
    expect([...seen.expired]).toEqual(["q1:step-1"]);
    // It rings long enough for the screen to settle.
    act(() => void vi.advanceTimersByTime(1_000));
    act(() => void vi.advanceTimersByTime(1_000));
    // As in a browser: the ticks while it rings run outside any React batch. Each finds the same
    // finished set, so React queues it without rendering, and the dismissal renders ahead of it.
    const env = globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean };
    const wasAct = env.IS_REACT_ACT_ENVIRONMENT;
    env.IS_REACT_ACT_ENVIRONMENT = false;
    try {
      vi.advanceTimersByTime(2_000);
      flushSync(() => seen.dismiss("q1:step-1"));
      // React's own follow-up render runs on the real clock.
      vi.useRealTimers();
      await new Promise((resolve) => setTimeout(resolve, 50));
    } finally {
      env.IS_REACT_ACT_ENVIRONMENT = wasAct;
    }
    expect(seen.timers).toEqual([]);
    expect(seen.expired.size).toBe(0);
    // Started again after that: it runs, and carries no finish from before.
    act(() => void seen.start(rice));
    expect(seen.timers).toHaveLength(1);
    expect(seen.expired.size).toBe(0);
  });

  it("never chimes late for a timer that ended before the page loaded", () => {
    const store = createTimerStore(memory());
    store.start(rice, T0 - 10 * 60_000);
    const { chime } = mount(store);
    act(() => void vi.advanceTimersByTime(5_000));
    expect(chime.play).not.toHaveBeenCalled();
    expect([...seen.expired]).toEqual(["q1:step-1"]);
  });

  it("says the sound is off while a timer runs and the chime is locked, until a tap", () => {
    // A reload: the timer was started before, and no tap has come since.
    // (Starting one is a tap, which unlocks the chime.)
    const store = createTimerStore(memory());
    store.start(rice, T0);
    mount(store, fakeChime(false));
    act(() => void vi.advanceTimersByTime(600));
    expect(seen.soundLocked).toBe(true);
    act(() => {
      seen.allowSound();
      vi.advanceTimersByTime(600);
    });
    expect(seen.soundLocked).toBe(false);
  });

  // A touch's pointerdown is no user activation (HTML: pointerup, touchend
  // and click are), so a finger's first tap must unlock on its way up (B5a
  // verify, LOW; the tablet check stands).
  it.each(["pointerup", "touchend", "click", "pointerdown", "keydown"])("unlocks the chime on a %s anywhere", (type) => {
    const store = createTimerStore(memory());
    store.start(rice, T0);
    const chime = fakeChime(false);
    const unlock = vi.spyOn(chime, "unlock");
    mount(store, chime);
    act(() => void document.body.dispatchEvent(new Event(type, { bubbles: true })));
    expect(unlock).toHaveBeenCalledTimes(1);
  });

  it("starts a voice timer once: a second start of a running one is left alone", () => {
    mount();
    act(() => void seen.start(rice));
    act(() => void vi.advanceTimersByTime(10_000));
    let again: string = "";
    act(() => {
      again = seen.start(rice, { restart: false });
    });
    expect(again).toBe("running");
    expect(seen.timers[0]!.endsAtEpochMs).toBe(T0 + 60_000);
  });

  it("takes another tab's timers from a storage event", () => {
    const backing = memory();
    const store = createTimerStore(backing);
    mount(store);
    createTimerStore(backing).start(rice, T0);
    act(() => void window.dispatchEvent(new StorageEvent("storage", { key: TIMERS_KEY })));
    expect(seen.timers.map((t) => t.id)).toEqual(["q1:step-1"]);
  });

  it("says once that saved timers were reset, and the lines go when read", () => {
    const backing = memory();
    backing.setItem(TIMERS_KEY, "{broken");
    mount(createTimerStore(backing));
    expect(screen.getByTestId("probe").textContent).toBe("Saved timers couldn't be read and were reset.");
    act(() => seen.say("Offline"));
    expect(seen.notices).toEqual(["Saved timers couldn't be read and were reset.", "Offline"]);
    act(() => seen.clearNotices());
    expect(seen.notices).toEqual([]);
  });

  it("holds the screen awake while a timer exists, and lets it go after", async () => {
    const release = vi.fn().mockResolvedValue(undefined);
    const request = vi.fn().mockResolvedValue({ release });
    Object.defineProperty(navigator, "wakeLock", { configurable: true, value: { request } });
    mount();
    expect(request).not.toHaveBeenCalled();
    await act(async () => void seen.start(rice));
    expect(request).toHaveBeenCalledWith("screen");
    await act(async () => seen.dismiss("q1:step-1"));
    expect(release).toHaveBeenCalled();
    Reflect.deleteProperty(navigator, "wakeLock");
  });

  it("chimes from one tab: a hidden tab leaves a fresh claim alone", () => {
    const claims = memory();
    claims.setItem("sous-chimer", JSON.stringify({ tab: "other", at: T0 + 30_000 }));
    Object.defineProperty(document, "visibilityState", { configurable: true, value: "hidden" });
    const { chime } = mount(createTimerStore(memory()), fakeChime(), claims);
    act(() => void seen.start(rice));
    act(() => void vi.advanceTimersByTime(60_500));
    expect(chime.play).not.toHaveBeenCalled();
    Reflect.deleteProperty(document, "visibilityState");
  });
});

// A reset read away from the cook page is said on the kitchen too, and kept
// for the tab until drawn, so timers never vanish unsaid when a page load
// drops the line (B5a verify, M2 and round 2).
describe("the reset line, said wherever it was read", () => {
  function broken() {
    const backing = memory();
    backing.setItem(TIMERS_KEY, "{broken");
    return createTimerStore(backing);
  }

  it("on the kitchen", () => {
    render(
      <KitchenTimersProvider store={broken()} chime={fakeChime()} claims={memory()}>
        <KitchenHome
          cooking={[]}
          queue={[]}
          recent={[]}
          onStart={vi.fn()}
          onRemove={vi.fn()}
          onMarkDone={vi.fn()}
          onOpenImport={vi.fn()}
        />
      </KitchenTimersProvider>,
    );
    expect(screen.getByRole("status").textContent).toBe("Saved timers couldn't be read and were reset.");
  });

  it("not over a borrowed page's ledge, whose label it would cover: it waits for the kitchen or the cook", () => {
    render(
      <KitchenTimersProvider store={broken()} chime={fakeChime()} claims={memory()}>
        <LedgeClocks />
      </KitchenTimersProvider>,
    );
    expect(screen.queryByRole("status")).toBeNull();
  });
});

// Round 2 (B5a verify): what rang and was stopped is the kitchen's record,
// not one cook screen's, so a stop from a borrowed ledge or the kitchen
// counts too; and a reset line is kept for the tab until a screen draws it.
describe("a timer stopped after it rang", () => {
  it("is recorded wherever it was stopped, and forgotten when it starts again", () => {
    const store = createTimerStore(memory());
    store.start(rice, T0 - 2 * 60_000);
    store.start({ ...rice, id: "q1:step-2", stepId: "step-2" }, T0);
    mount(store);
    act(() => void vi.advanceTimersByTime(600));
    act(() => seen.dismiss("q1:step-1"));
    expect([...seen.stopped]).toEqual(["q1:step-1"]);
    // A running timer taken away (none is, today) was never rung.
    act(() => seen.dismiss("q1:step-2"));
    expect([...seen.stopped]).toEqual(["q1:step-1"]);
    act(() => void seen.start(rice));
    expect([...seen.stopped]).toEqual([]);
  });
});

describe("a reset line", () => {
  it("outlasts a page load until a screen has drawn it", () => {
    const session = memory();
    const backing = memory();
    backing.setItem(TIMERS_KEY, "{broken");
    render(
      <KitchenTimersProvider store={createTimerStore(backing)} chime={fakeChime()} claims={memory()} session={session}>
        <Probe />
      </KitchenTimersProvider>,
    );
    expect(seen.notices).toEqual(["Saved timers couldn't be read and were reset."]);
    cleanup();
    // The next page load, where the store reads clean.
    render(
      <KitchenTimersProvider store={createTimerStore(memory())} chime={fakeChime()} claims={memory()} session={session}>
        <Probe />
      </KitchenTimersProvider>,
    );
    expect(seen.notices).toEqual(["Saved timers couldn't be read and were reset."]);
    act(() => seen.noticesShown());
    cleanup();
    render(
      <KitchenTimersProvider store={createTimerStore(memory())} chime={fakeChime()} claims={memory()} session={session}>
        <Probe />
      </KitchenTimersProvider>,
    );
    expect(seen.notices).toEqual([]);
  });

  it("drawn, is not said again after a page load, even when a second line joined it (verify round 3)", () => {
    const session = memory();
    const backing = memory();
    backing.setItem(TIMERS_KEY, "{broken");
    const store = createTimerStore(backing);
    render(
      <KitchenTimersProvider store={store} chime={fakeChime()} claims={memory()} session={session}>
        <TimerNotices />
      </KitchenTimersProvider>,
    );
    expect(screen.getByRole("status").textContent).toBe("Saved timers couldn't be read and were reset.");
    // Another store read broken while the first line stands.
    act(() => {
      backing.setItem(TIMERS_KEY, "{broken again");
      store.reload();
    });
    cleanup();
    render(
      <KitchenTimersProvider store={createTimerStore(memory())} chime={fakeChime()} claims={memory()} session={session}>
        <Probe />
      </KitchenTimersProvider>,
    );
    expect(seen.notices).toEqual([]);
  });

  it("is not kept when it is only said for now (B5b's lines)", () => {
    const session = memory();
    render(
      <KitchenTimersProvider store={createTimerStore(memory())} chime={fakeChime()} claims={memory()} session={session}>
        <Probe />
      </KitchenTimersProvider>,
    );
    act(() => seen.say("Offline"));
    cleanup();
    render(
      <KitchenTimersProvider store={createTimerStore(memory())} chime={fakeChime()} claims={memory()} session={session}>
        <Probe />
      </KitchenTimersProvider>,
    );
    expect(seen.notices).toEqual([]);
  });
});

describe("the clocks over a borrowed ledge", () => {
  it("are one clock on one row at the chip's size, the others in words, with no sound-off ghost", () => {
    const store = createTimerStore(memory());
    store.start(rice, T0);
    store.start({ ...rice, id: "q2:step-1", queueId: "q2", recipeName: "Dal", label: "Simmer dal" }, T0 + 1_000);
    render(
      <KitchenTimersProvider store={store} chime={fakeChime(false)} claims={memory()}>
        <LedgeClocks />
      </KitchenTimersProvider>,
    );
    const clocks = document.querySelector("[data-ledge-clocks]")!;
    expect(clocks.querySelectorAll('[role="timer"]')).toHaveLength(1);
    expect(clocks.textContent).toContain("Rice · Simmer rice, and 1 more");
    expect(clocks.querySelector("[aria-hidden]")!.className).toContain("--type-chip");
    expect(clocks.querySelector("[data-sound-off]")).toBeNull();
  });
});

// Slice B5b: the lines a cook says, over a provider that outlives every cook.
describe("a cook's own lines", () => {
  /** A cook session met broken, as the cook page's read finds it. */
  function metBroken(): StringStore {
    const backing = memory();
    backing.setItem("sous-cook:q1", "{broken");
    expect(loadSession("q1", backing)).toBeNull();
    return backing;
  }

  it("a persistent line outlasts the first move; a plain one does not; unsaid, it is plain again", () => {
    mount();
    act(() => {
      seen.say("Offline", { persistent: true });
      seen.say("Plain");
    });
    act(() => seen.clearNotices());
    expect(seen.notices).toEqual(["Offline"]);
    act(() => seen.unsay("Offline"));
    expect(seen.notices).toEqual([]);
    // Said again without the flag (the connection came back and went), it clears.
    act(() => seen.say("Offline"));
    act(() => seen.clearNotices());
    expect(seen.notices).toEqual([]);
  });

  it("the kitchen's notices never show a cook's reset line, and leave it waiting for the cook", () => {
    const tab = memory();
    metBroken();
    render(
      <KitchenTimersProvider store={createTimerStore(memory())} chime={fakeChime()} claims={memory()} session={tab}>
        <TimerNotices />
        <Probe />
      </KitchenTimersProvider>,
    );
    expect(seen.notices).toEqual([SESSION_RESET_COPY]);
    expect(screen.queryByRole("status")?.textContent ?? "").toBe("");
    // Still waiting in the tab: the kitchen drew nothing, so it marked nothing.
    cleanup();
    render(
      <KitchenTimersProvider store={createTimerStore(memory())} chime={fakeChime()} claims={memory()} session={tab}>
        <Probe />
      </KitchenTimersProvider>,
    );
    expect(seen.notices).toEqual([SESSION_RESET_COPY]);
  });

  it("dropped, a reset line met by a cook that never opened reaches no other cook", () => {
    const tab = memory();
    metBroken();
    render(
      <KitchenTimersProvider store={createTimerStore(memory())} chime={fakeChime()} claims={memory()} session={tab}>
        <Probe />
      </KitchenTimersProvider>,
    );
    act(() => seen.say("Saved timers kept"));
    expect(seen.notices).toEqual([SESSION_RESET_COPY, "Saved timers kept"]);
    act(() => seen.dropCookNotices());
    expect(seen.notices).toEqual(["Saved timers kept"]);
    cleanup();
    render(
      <KitchenTimersProvider store={createTimerStore(memory())} chime={fakeChime()} claims={memory()} session={tab}>
        <Probe />
      </KitchenTimersProvider>,
    );
    expect(seen.notices).toEqual([]);
  });
});

describe("the clock a cook reads (useNow)", () => {
  /** A kitchen plan cooked on until a pot runs: the strip the sheet lays out, and the pot. */
  function runningPot(): { s: Strip; pot: StripMark } {
    for (const f of loadKitchenPlans()) {
      let state: CookState = initialCookState("first");
      for (let i = 0; i < 40; i++) {
        const s = strip(f.plan, state, null, T0);
        const pot = s.marks.find((m) => m.pot && m.state === "running");
        if (pot) return { s, pot };
        const n = next(f.plan, state);
        if (n === state) break;
        state = n;
      }
    }
    throw new Error("no fixture runs a pot");
  }

  const tenMin: TimerStart = { ...rice, durationMs: 10 * 60_000 };

  it("lays the pot out at its real end on the render where the first timer starts, and after an idle while", () => {
    const { s, pot } = runningPot();
    // As CookScreen does: the clock runs while a timer does, and the sheet's strip is read on it.
    // The fake clock stands still inside a render: `at` is the time every render below happens at.
    let at = Date.now();
    const drawn: { now: number; at: number; end: number }[] = [];
    function Cook() {
      const k = useKitchenTimers();
      const now = useNow(k.timers.length > 0);
      useLayoutEffect(() => {
        seen = k;
      });
      const t = k.timers[0];
      if (t) {
        const timed = timedStrip(s, new Map([[pot.tasks[0], { endsAtEpochMs: t.endsAtEpochMs, done: false }]]), now);
        drawn.push({ now, at, end: timed.marks.find((m) => m.key === pot.key)!.end });
      }
      return null;
    }
    render(
      <KitchenTimersProvider store={createTimerStore(memory())} chime={fakeChime()} claims={memory()}>
        <Cook />
      </KitchenTimersProvider>,
    );
    act(() => void seen.start(tenMin));
    expect(drawn.length).toBeGreaterThan(0);
    for (const d of drawn) {
      expect(Math.abs(d.now - d.at), `read ${d.now} at ${d.at}`).toBeLessThan(500);
      expect(d.end).toBe(s.now + 10);
    }
    // The timer goes, the clock stops; two hours on, the next timer starts on the time it is.
    act(() => void seen.dismiss(tenMin.id));
    act(() => void vi.advanceTimersByTime(2 * 60 * 60_000));
    at = Date.now();
    drawn.length = 0;
    act(() => void seen.start(tenMin));
    expect(drawn.length).toBeGreaterThan(0);
    for (const d of drawn) {
      expect(Math.abs(d.now - d.at), `read ${d.now} at ${d.at}`).toBeLessThan(500);
      expect(d.end).toBe(s.now + 10);
    }
  });
});
