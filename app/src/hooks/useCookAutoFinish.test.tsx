// @vitest-environment happy-dom
import { act, cleanup, renderHook } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { AUTO_FINISH_IDLE_MS } from "@/lib/kitchen/auto-finish";
import { useCookAutoFinish, type CookAutoFinishDeps, type CookAutoFinishInput } from "./useCookAutoFinish";

// The open cook page's side of auto-finish (cook-fidelity decision 7): the
// server is faked at the hook's three calls, and time is the test's clock.

const MIN = 60_000;
const START = Date.UTC(2026, 9, 25, 22, 0);

let reports: (number | null)[] = [];
/** When each report says the cook last touched the cook, by the test's clock. */
let touches: number[] = [];
let finishes: number[] = [];
let reopens = 0;
let serverSaysFinished = false;
let serverSaysCooking = true;
/** Holds the finish's answer until the test lets it go, when set. */
let finishGate: Promise<void> | null = null;
/** Holds the reports' answers until the test lets them go, when set. */
let reportGate: Promise<void> | null = null;
let reopenAnswer = true;
/** Holds the reopen's answer until the test lets it go, when set. */
let reopenGate: Promise<void> | null = null;
/** The next calls of each kind that fail, as a dropped connection does. */
let failReports = 0;
let failReopens = 0;
/** The reports in flight at once, at most. */
let inFlight = 0;
let mostInFlight = 0;

function deps(): CookAutoFinishDeps {
  return {
    // As the server does, by its clock (here the test's).
    report: async (_id, idleForMs, interactedAt) => {
      touches.push(interactedAt);
      inFlight += 1;
      mostInFlight = Math.max(mostInFlight, inFlight);
      try {
        if (failReports > 0) {
          failReports -= 1;
          throw new Error("network");
        }
        return await answerReport(idleForMs);
      } finally {
        inFlight -= 1;
      }
    },
    finish: async (_id, idleForMs) => {
      finishes.push(Date.now() - idleForMs);
      // As the server does: the cook is finished from here on.
      serverSaysFinished = true;
      if (finishGate) await finishGate;
      return { autoFinished: true };
    },
    reopen: async () => {
      reopens += 1;
      if (reopenGate) await reopenGate;
      if (failReopens > 0) {
        failReopens -= 1;
        throw new Error("network");
      }
      // As the server does: a cook it reopens is cooking again.
      if (reopenAnswer) serverSaysFinished = false;
      return { reopened: reopenAnswer };
    },
    now: () => Date.now(),
  };
}

/** The server's answer to a report, as it stands when the report arrives. */
async function answerReport(idleForMs: number | null) {
  reports.push(idleForMs === null ? null : Date.now() - idleForMs);
  const answer = { cooking: serverSaysCooking && !serverSaysFinished, autoFinished: serverSaysFinished };
  if (reportGate) await reportGate;
  return answer;
}

const d = deps();

/** The hook's input, the cook on its last screen, with `over` changed. */
function props(over: Partial<CookAutoFinishInput> = {}): CookAutoFinishInput {
  return { queueId: "q1", onLastScreen: true, timerEnds: [], timerIds: [], cookKey: "5", deps: d, ...over };
}

/** The cook page as it opens: nothing done on it yet. */
function open(initial: Partial<CookAutoFinishInput> = {}) {
  return renderHook((props: CookAutoFinishInput) => useCookAutoFinish(props), {
    initialProps: { ...props(), ...initial },
  });
}

/** The cook page opened, and the cook touching it at once (so it reports). */
function render(initial: Partial<CookAutoFinishInput> = {}) {
  const hook = open(initial);
  act(() => hook.result.current.touch());
  return hook;
}

/** Lets the hook's promises settle. */
const settle = () => act(async () => {});

async function pass(ms: number) {
  await act(async () => {
    await vi.advanceTimersByTimeAsync(ms);
  });
}

beforeEach(() => {
  vi.useFakeTimers({ toFake: ["Date", "setTimeout", "clearTimeout", "setInterval", "clearInterval"] });
  vi.setSystemTime(START);
  reports = [];
  touches = [];
  finishes = [];
  reopens = 0;
  serverSaysFinished = false;
  serverSaysCooking = true;
  finishGate = null;
  reportGate = null;
  reopenAnswer = true;
  reopenGate = null;
  failReports = 0;
  failReopens = 0;
  inFlight = 0;
  mostInFlight = 0;
});

afterEach(() => {
  cleanup();
  vi.useRealTimers();
});

describe("useCookAutoFinish", () => {
  it("finishes the cook 45 idle minutes on its last screen, dated to its last activity", async () => {
    const { result } = render();
    await settle();

    await pass(AUTO_FINISH_IDLE_MS - MIN);
    expect(finishes).toEqual([]);

    await pass(MIN);
    expect(finishes).toEqual([START]);
    expect(result.current.autoFinished).toBe(true);
  });

  it("never fires on a screen that isn't the last, however long it sits", async () => {
    const { result } = render({ onLastScreen: false });
    await settle();

    await pass(5 * AUTO_FINISH_IDLE_MS);
    expect(finishes).toEqual([]);
    expect(result.current.autoFinished).toBe(false);
  });

  it("opening the cook off its last screen sends nothing: an open writes nothing", async () => {
    const { rerender } = open({ onLastScreen: false });
    await settle();
    rerender(props({ onLastScreen: false, cookKey: "2" }));
    await settle();
    await pass(3 * MIN);
    expect(reports).toEqual([]);

    // Once it has been on its last screen, leaving it is said, so the server's sweep leaves it.
    rerender(props({ onLastScreen: true, cookKey: "5" }));
    await settle();
    rerender(props({ onLastScreen: false, cookKey: "4" }));
    await settle();
    expect(reports).toEqual([START, null]);
  });

  it("opening the cook on its last screen sends nothing, and never finishes it, until the cook acts there", async () => {
    // A cook with no steps, or one resumed on its last screen: the deploy
    // smoke opens such a cook, and an open must write nothing.
    const { result } = open();
    await settle();
    await pass(2 * AUTO_FINISH_IDLE_MS);
    expect(reports).toEqual([]);
    expect(finishes).toEqual([]);

    act(() => result.current.touch());
    await settle();
    expect(reports).toEqual([START + 2 * AUTO_FINISH_IDLE_MS]);
  });

  it("each report says when the cook last touched the cook, so the server can drop a late one", async () => {
    const { result } = render();
    await settle();
    await pass(10 * MIN);
    act(() => result.current.touch());
    await settle();
    expect(touches).toEqual([START, START + 10 * MIN]);
  });

  it("a cook finished elsewhere, then stepped back before the page heard: the next report's answer reopens it", async () => {
    const { result, rerender } = render();
    await settle();
    expect(reports).toEqual([START]);

    // The agent's sweep finishes it while the page is quiet; the cook steps
    // back, and that step's report is the page's first word of the finish.
    serverSaysFinished = true;
    rerender(props({ onLastScreen: false, cookKey: "4" }));
    await settle();
    await settle();
    expect(reopens).toBe(1);
    expect(result.current.autoFinished).toBe(false);
  });

  it("never fires while a timer runs: the idle wait starts when it ends", async () => {
    const ends = START + 60 * MIN;
    render({ timerEnds: [ends] });
    await settle();

    await pass(60 * MIN + AUTO_FINISH_IDLE_MS - MIN);
    expect(finishes).toEqual([]);

    await pass(MIN);
    expect(finishes).toEqual([ends]);
    // The server is told the cook's activity runs to the timer's end.
    expect(reports[0]).toBe(ends);
  });

  it("a timer dismissed early still holds the finish to its end, as the server holds it: the page's finish is dated there, not refused", async () => {
    const ends = START + 20 * MIN;
    const { result, rerender } = render({ timerIds: ["t1"], timerEnds: [ends] });
    await settle();
    await pass(MIN);
    // Dismissed a minute in, by a touch.
    act(() => result.current.touch());
    rerender(props({ timerIds: [], timerEnds: [] }));
    await settle();

    await pass(19 * MIN + AUTO_FINISH_IDLE_MS - MIN);
    expect(finishes).toEqual([]);
    await pass(MIN);
    // The server keeps the timer's end (it never comes down), so the finish
    // the page asks for is dated to it, which the server accepts.
    expect(finishes).toEqual([ends]);
  });

  it("a touch starts the wait again and reports the new minute", async () => {
    const { result } = render();
    await settle();
    await pass(30 * MIN);

    act(() => result.current.touch());
    await settle();
    const touchedAt = START + 30 * MIN;
    expect(reports.at(-1)).toBe(touchedAt);

    await pass(AUTO_FINISH_IDLE_MS - MIN);
    expect(finishes).toEqual([]);
    await pass(MIN);
    expect(finishes).toEqual([touchedAt]);
  });

  it("a press anywhere on the page counts as activity", async () => {
    render();
    await settle();
    await pass(20 * MIN);

    act(() => {
      document.body.dispatchEvent(new Event("pointerdown", { bubbles: true }));
    });
    await pass(AUTO_FINISH_IDLE_MS - MIN);
    expect(finishes).toEqual([]);
  });

  it("checks again as the tablet wakes, dated to the activity, not the wake", async () => {
    render();
    await settle();
    // A sleeping tablet runs no timers: the clock jumps with none fired.
    vi.setSystemTime(START + 3 * 60 * MIN);
    await act(async () => {
      document.dispatchEvent(new Event("visibilitychange"));
    });
    expect(finishes).toEqual([START]);
  });

  it("takes the server's word that the cook was finished elsewhere", async () => {
    serverSaysFinished = true;
    const { result } = render();
    await settle();

    expect(result.current.autoFinished).toBe(true);
  });

  it("reopens a finished cook when the cook acts on it, and only then", async () => {
    const { result, rerender } = render();
    await settle();
    await pass(AUTO_FINISH_IDLE_MS);
    expect(result.current.autoFinished).toBe(true);

    // A press that isn't the cook acting (a menu, the info) reopens nothing.
    act(() => result.current.touch());
    await settle();
    expect(reopens).toBe(0);

    rerender(props({ onLastScreen: false, cookKey: "4" }));
    await settle();
    expect(reopens).toBe(1);
    expect(result.current.autoFinished).toBe(false);
    // And tells the server at once where the reopened cook sits: off its last screen.
    expect(reports.at(-1)).toBeNull();
  });

  it("a timer started reopens it; one dismissed doesn't", async () => {
    const { result, rerender } = render({ timerIds: ["t1"], timerEnds: [START - MIN] });
    await settle();
    await pass(AUTO_FINISH_IDLE_MS);
    expect(result.current.autoFinished).toBe(true);

    rerender(props({ timerIds: [], timerEnds: [] }));
    await settle();
    expect(reopens).toBe(0);

    rerender(props({ timerIds: ["t2"], timerEnds: [Date.now() + 10 * MIN] }));
    await settle();
    expect(reopens).toBe(1);
  });

  it("never tries to finish a cook the server doesn't hold as cooking (opened, never started)", async () => {
    serverSaysCooking = false;
    const { result } = render();
    await settle();
    await pass(3 * AUTO_FINISH_IDLE_MS);
    expect(finishes).toEqual([]);
    expect(result.current.autoFinished).toBe(false);
  });

  it("a step taken while the finish is on its way reopens the cook once it lands", async () => {
    let land: () => void = () => {};
    finishGate = new Promise((resolve) => (land = resolve));
    const { result, rerender } = render();
    await settle();
    await pass(AUTO_FINISH_IDLE_MS);
    expect(finishes).toHaveLength(1);

    rerender(props({ onLastScreen: false, cookKey: "4" }));
    await settle();
    expect(reopens).toBe(0);
    await act(async () => {
      land();
    });
    await settle();
    expect(reopens).toBe(1);
    expect(result.current.autoFinished).toBe(false);
  });

  it("a step while a report is out: the reopen waits for its answer, goes once, and the cook goes on", async () => {
    const { result, rerender } = render();
    await settle();
    await pass(AUTO_FINISH_IDLE_MS);
    expect(result.current.autoFinished).toBe(true);

    // A report goes while the server holds the cook finished, and its answer
    // is slow; the cook ticks a line meanwhile.
    let answer: () => void = () => {};
    reportGate = new Promise((resolve) => (answer = resolve));
    act(() => result.current.touch());
    await pass(MIN);
    rerender(props({ cookKey: "5:ticked" }));
    await settle();
    expect(reopens).toBe(0);
    reportGate = null;
    await act(async () => {
      answer();
    });
    await settle();
    expect(reopens).toBe(1);
    expect(result.current.autoFinished).toBe(false);
  });

  it("every touch is reported, not only a new minute's", async () => {
    const { result } = render();
    await settle();
    await pass(10_000);
    act(() => result.current.touch());
    await settle();
    expect(touches).toEqual([START, START + 10_000]);
  });

  it("a tick is reported as it is made, so a later touch on a cook swept since doesn't reopen it", async () => {
    const { result, rerender } = render();
    await settle();
    await pass(5 * MIN);
    // A tick: the press (its report answered), then the line it ticks.
    act(() => result.current.touch());
    await settle();
    rerender(props({ cookKey: "5:ticked" }));
    await settle();

    // The tablet sleeps; the agent's sweep finishes the cook; a press on the
    // page as it wakes (the menu, say) is no act on the cook.
    serverSaysFinished = true;
    vi.setSystemTime(START + 5 * MIN + 2 * AUTO_FINISH_IDLE_MS);
    act(() => result.current.touch());
    await settle();
    expect(result.current.autoFinished).toBe(true);
    expect(reopens).toBe(0);
  });

  it("Done waits for a reopen on its way: a tick, then Done straight after, ends on Done", async () => {
    const { result, rerender } = render();
    await settle();
    await pass(AUTO_FINISH_IDLE_MS);
    expect(result.current.autoFinished).toBe(true);

    let land: () => void = () => {};
    reopenGate = new Promise((resolve) => (land = resolve));
    rerender(props({ cookKey: "5:ticked" }));
    await settle();
    expect(reopens).toBe(1);

    const seen: string[] = [];
    let done: Promise<void> = Promise.resolve();
    act(() => {
      done = result.current.inOrder(async () => {
        seen.push(serverSaysFinished ? "Done on a finished cook" : "Done on the cook");
      });
    });
    await settle();
    expect(seen).toEqual([]);
    await act(async () => {
      land();
      await done;
    });
    // Done went once the reopen had landed: the cook it completes is cooking.
    expect(seen).toEqual(["Done on the cook"]);
  });

  it("a report that never answers holds Done only until its call gives up (`fetchWithin`)", async () => {
    const warn = vi.spyOn(console, "warn").mockImplementation(() => {});
    let giveUp: () => void = () => {};
    const hung: CookAutoFinishDeps = {
      ...d,
      report: () =>
        new Promise((_resolve, reject) => {
          giveUp = () => reject(new DOMException("signal timed out", "TimeoutError"));
        }),
    };
    const { result } = render({ deps: hung });
    await settle();

    const seen: string[] = [];
    let done: Promise<void> = Promise.resolve();
    act(() => {
      done = result.current.inOrder(async () => {
        seen.push("Done");
      });
    });
    await settle();
    expect(seen).toEqual([]);
    await act(async () => {
      giveUp();
      await done;
    });
    expect(seen).toEqual(["Done"]);
    warn.mockRestore();
  });

  it("stays finished when the server won't reopen it (past the window)", async () => {
    reopenAnswer = false;
    const { result, rerender } = render();
    await settle();
    await pass(AUTO_FINISH_IDLE_MS);

    rerender(props({ cookKey: "5:ticked" }));
    await settle();
    expect(reopens).toBe(1);
    expect(result.current.autoFinished).toBe(true);
  });

  it("offline, sends nothing, and reports and reopens once the connection is back", async () => {
    const onLine = vi.spyOn(navigator, "onLine", "get").mockReturnValue(false);
    const { result, rerender } = render();
    await settle();
    expect(reports).toEqual([]);

    // Due while offline: nothing is sent, and the cook finishes once it can be.
    await pass(AUTO_FINISH_IDLE_MS + MIN);
    expect(finishes).toEqual([]);
    onLine.mockReturnValue(true);
    await act(async () => {
      window.dispatchEvent(new Event("online"));
    });
    expect(reports).toEqual([START]);
    expect(finishes).toEqual([START]);
    expect(result.current.autoFinished).toBe(true);

    // A move made offline reopens the cook when the connection comes back.
    onLine.mockReturnValue(false);
    await act(async () => {
      window.dispatchEvent(new Event("offline"));
    });
    rerender(props({ onLastScreen: false, cookKey: "4" }));
    await settle();
    expect(reopens).toBe(0);
    onLine.mockReturnValue(true);
    await act(async () => {
      window.dispatchEvent(new Event("online"));
    });
    expect(reopens).toBe(1);
    expect(result.current.autoFinished).toBe(false);
    onLine.mockRestore();
  });

  it("a report that fails is sent again a minute on, and the cook still finishes", async () => {
    failReports = 1;
    const warn = vi.spyOn(console, "warn").mockImplementation(() => {});
    const { result } = render();
    await settle();
    expect(reports).toEqual([]);

    await pass(MIN);
    expect(reports).toEqual([START]);
    await pass(AUTO_FINISH_IDLE_MS - MIN);
    expect(finishes).toEqual([START]);
    expect(result.current.autoFinished).toBe(true);
    warn.mockRestore();
  });

  it("a reopen that fails is tried again until it lands", async () => {
    const { result, rerender } = render();
    await settle();
    await pass(AUTO_FINISH_IDLE_MS);
    failReopens = 1;
    const error = vi.spyOn(console, "error").mockImplementation(() => {});

    rerender(props({ onLastScreen: false, cookKey: "4" }));
    await settle();
    expect(reopens).toBe(1);
    expect(result.current.autoFinished).toBe(true);
    await pass(MIN);
    expect(reopens).toBe(2);
    expect(result.current.autoFinished).toBe(false);
    error.mockRestore();
  });

  it("finished elsewhere while the cook acted (the report's answer says so): it reopens", async () => {
    let answer: () => void = () => {};
    const { result, rerender } = render({ onLastScreen: false });
    await settle();
    // The kitchen swept it; the page's next report is slow to come back.
    serverSaysFinished = true;
    reportGate = new Promise((resolve) => (answer = resolve));
    rerender(props({ onLastScreen: true, cookKey: "5" }));
    await settle();
    rerender(props({ onLastScreen: false, cookKey: "4" }));
    await settle();
    expect(reopens).toBe(0);
    serverSaysFinished = false;
    reportGate = null;
    await act(async () => {
      answer();
    });
    await settle();
    expect(reopens).toBe(1);
    expect(result.current.autoFinished).toBe(false);
  });

  it("sends one report at a time, in order", async () => {
    let answer: () => void = () => {};
    reportGate = new Promise((resolve) => (answer = resolve));
    const { rerender } = render();
    await settle();
    rerender(props({ onLastScreen: false, cookKey: "4" }));
    await settle();
    rerender(props({ onLastScreen: true, cookKey: "5" }));
    await settle();
    reportGate = null;
    await act(async () => {
      answer();
    });
    await settle();
    expect(mostInFlight).toBe(1);
    // The last one sent is the last the server took: on the last screen.
    expect(reports.at(-1)).toBe(START);
  });

  it("does nothing without a queue item (the fixture viewer)", async () => {
    render({ queueId: undefined });
    await settle();
    await pass(2 * AUTO_FINISH_IDLE_MS);
    expect(reports).toEqual([]);
    expect(finishes).toEqual([]);
  });
});
