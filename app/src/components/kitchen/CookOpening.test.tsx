// @vitest-environment happy-dom
import { cleanup, fireEvent, render, screen } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { COOK_COPY } from "@/lib/kitchen/cook-view";
import { UNTITLED } from "@/lib/kitchen/dish-name";
import type { KitchenTimer } from "@/lib/kitchen/timers";
import { OpeningControls, openingWords, useOpeningKeys } from "./CookOpening";
import { TimerHere } from "./KitchenTimers";
import type { VoiceProps } from "./VoiceDot";

// Slice N2, N2-10; slice N3: the opening's words, its controls and Start's keys.

// happy-dom has no font loading; the controls' fit listens for fonts arriving.
const fonts = Object.assign(new EventTarget(), { status: "loaded" as const, ready: Promise.resolve() });
Object.defineProperty(document, "fonts", { value: fonts, configurable: true });

afterEach(() => {
  cleanup();
  vi.useRealTimers();
});

const T0 = Date.UTC(2026, 9, 11, 18, 0, 0);
beforeEach(() => {
  vi.useFakeTimers({ toFake: ["Date"] });
  vi.setSystemTime(T0);
});

const rice: KitchenTimer = {
  id: "q2:step-3",
  queueId: "q2",
  recipeName: "Rice",
  stepId: "step-3",
  label: "Simmer rice",
  durationMs: 900_000,
  endsAtEpochMs: T0 + 600_000,
};

describe("openingWords", () => {
  it("names a recipe with no name as the app does", () => {
    expect(openingWords("  ", null)).toEqual({ title: UNTITLED, handsOn: null });
  });

  it("says the kitchen row's hands-on words, the plan's or the recipe's stated time's, and none where the row says none", () => {
    const ahead = { leads: [], unled: 0 };
    const said = (t: Parameters<typeof openingWords>[1]) => openingWords("Dal", t).handsOn?.replaceAll("\u00a0", " ") ?? null;
    expect(said({ source: "plan", total: 50, handsOn: 20, ahead })).toBe("20 min hands-on");
    expect(said({ source: "plan", total: 50, handsOn: 0, ahead })).toBe("Hands-free");
    expect(said({ source: "plan", total: 50, handsOn: 50, ahead })).toBe("All hands-on");
    // a plan of nominal guesses: the row says the recipe's stated time, and so does the opening
    expect(said({ source: "recipe", reason: "nominal", total: 45, handsOn: 20, ahead })).toBe("Recipe says 20 min hands-on");
    expect(said({ source: "recipe", reason: "nominal", total: 45, handsOn: null, ahead })).toBeNull();
    expect(said({ source: "none", reason: "no-plan", ahead })).toBeNull();
  });
});

function Keys({ onStart, live = true }: { onStart: () => void; live?: boolean }) {
  useOpeningKeys(onStart, live);
  return (
    <>
      <button type="button">Other control</button>
      <input aria-label="A field" />
    </>
  );
}

describe("useOpeningKeys", () => {
  it("starts on Enter, Space and → pressed on the page, once for a held key", () => {
    const onStart = vi.fn();
    render(<Keys onStart={onStart} />);
    fireEvent.keyDown(document.body, { key: "Enter" });
    fireEvent.keyDown(document.body, { key: " " });
    fireEvent.keyDown(document.body, { key: "ArrowRight" });
    fireEvent.keyDown(document.body, { key: "ArrowRight", repeat: true });
    expect(onStart).toHaveBeenCalledTimes(3);
  });

  it("leaves a focused control its Enter and Space, a field its keys, and waits while a popover holds them", () => {
    const onStart = vi.fn();
    render(<Keys onStart={onStart} />);
    const other = screen.getByRole("button", { name: "Other control" });
    fireEvent.keyDown(other, { key: "Enter" });
    fireEvent.keyDown(other, { key: " " });
    fireEvent.keyDown(screen.getByLabelText("A field"), { key: "ArrowRight" });
    const popover = document.createElement("div");
    popover.setAttribute("data-holds-keys", "");
    document.body.appendChild(popover);
    fireEvent.keyDown(document.body, { key: "Enter" });
    popover.remove();
    expect(onStart).not.toHaveBeenCalled();
    // A control's → is still Start's: no control moves with it.
    fireEvent.keyDown(other, { key: "ArrowRight" });
    expect(onStart).toHaveBeenCalledTimes(1);
  });

  it("does nothing while not live (a modal, Ask or a menu has the screen)", () => {
    const onStart = vi.fn();
    render(<Keys onStart={onStart} live={false} />);
    fireEvent.keyDown(document.body, { key: "Enter" });
    expect(onStart).not.toHaveBeenCalled();
  });
});

function foot(over: { expired?: KitchenTimer[]; running?: KitchenTimer[]; voice?: VoiceProps } = {}) {
  const props = { onStart: vi.fn(), onDismiss: vi.fn() };
  render(
    <TimerHere queueId="q1">
      <OpeningControls
        onStart={props.onStart}
        well={{ expired: over.expired ?? [], running: over.running ?? [], onDismiss: props.onDismiss }}
        voice={over.voice}
      />
    </TimerHere>,
  );
  return props;
}

const voiceOff: VoiceProps = { mode: "always", status: "off", echo: null, onTap: () => {} };

describe("OpeningControls", () => {
  it("leads with the voice dot wherever voice is supported, and draws none where it is not (the foot's rule)", () => {
    foot({ voice: voiceOff });
    const row = document.querySelector("[data-opening-controls]")!;
    const dot = row.querySelector("[data-voice]");
    expect(dot).not.toBeNull();
    expect(row.firstElementChild).toBe(dot);
    cleanup();
    foot({ voice: { ...voiceOff, status: "unsupported" } });
    expect(document.querySelector("[data-opening-controls] [data-voice]")).toBeNull();
  });

  it("holds Start alone, in ember, and Start starts", () => {
    const props = foot();
    expect(document.querySelector("[data-opening-controls] [data-voice]")).toBeNull();
    const start = screen.getByRole("button", { name: COOK_COPY.start });
    expect(start.className).toContain("bg-ember");
    expect(document.querySelector("[data-opening-well]")).toBeNull();
    fireEvent.click(start);
    expect(props.onStart).toHaveBeenCalledTimes(1);
  });

  it("keeps a running timer's well beside Start", () => {
    foot({ running: [rice] });
    expect(document.querySelector("[data-opening-well] [data-ledge]")?.textContent).toContain("Simmer rice");
    expect(screen.getByRole("button", { name: COOK_COPY.start }).className).toContain("bg-ember");
  });

  it("puts an alarm in the well, where a tap stops it, and Start waits in sand while it rings", () => {
    const done = { ...rice, endsAtEpochMs: T0 - 5_000 };
    const props = foot({ expired: [done] });
    const start = screen.getByRole("button", { name: COOK_COPY.start });
    expect(start.className).toContain("bg-sand");
    expect(start.className).not.toContain("bg-ember");
    const alarm = document.querySelector<HTMLButtonElement>('[data-opening-well] [data-timer="alarm"]');
    expect(alarm).not.toBeNull();
    fireEvent.click(alarm!);
    expect(props.onDismiss).toHaveBeenCalledWith(done.id);
    expect(props.onStart).not.toHaveBeenCalled();
  });

  it("gives the well's rungs in the foot's order only while the row is wider than the screen, never the dot or Start", () => {
    // The screen is 800 wide; the row reads 900 until its label stays its name, then 700.
    const width = vi.spyOn(HTMLElement.prototype, "clientWidth", "get").mockReturnValue(800);
    const box = vi.spyOn(HTMLElement.prototype, "getBoundingClientRect").mockImplementation(function (this: HTMLElement) {
      const w = this.hasAttribute("data-opening-controls") ? (this.hasAttribute("data-ledge-short") ? 700 : 900) : 0;
      return { x: 0, y: 0, left: 0, top: 0, right: w, bottom: 0, width: w, height: 0, toJSON: () => ({}) } as DOMRect;
    });
    try {
      foot({ running: [rice, { ...rice, id: "q2:step-4", stepId: "step-4", label: "Rest the dough" }], voice: voiceOff });
      const row = document.querySelector("[data-opening-controls]")!;
      expect(row.hasAttribute("data-ledge-short")).toBe(true);
      expect(row.hasAttribute("data-ledge-one")).toBe(false);
      expect(row.hasAttribute("data-ledge-small")).toBe(false);
      expect(row.querySelector("[data-voice]")).not.toBeNull();
      expect(screen.getByRole("button", { name: COOK_COPY.start })).not.toBeNull();
      cleanup();
      // Where the row fits, nothing gives.
      width.mockReturnValue(1280);
      foot({ running: [rice] });
      const fits = document.querySelector("[data-opening-controls]")!;
      expect(["data-ledge-short", "data-ledge-one", "data-ledge-small"].some((g) => fits.hasAttribute(g))).toBe(false);
    } finally {
      width.mockRestore();
      box.mockRestore();
    }
  });
});

import { strip } from "@/lib/kitchen/cook-strip";
import { initialCookState, next } from "@/lib/kitchen/cook-view";
import { placeOverview } from "@/lib/kitchen/overview-place";
import { buildTimetable } from "@/lib/kitchen/timetable-model";
import { advanceMeasure as measure } from "@/lib/kitchen/__tests__/advance-measure";
import { timetableCorpus } from "@/lib/kitchen/__tests__/timetable-corpus";
import { Timetable } from "./Timetable";

describe("Timetable: R4 Two-Column Opening & Level 2 Phase Outline (Slice 2B)", () => {
  const geo = {
    W: 1180,
    H: 820,
    c: 1,
    E: 35,
    top: 64,
    stepTop: 84,
    footTop: 740,
    ledgeTop: 718,
    portrait: false,
  };
  const ttDims = [
    { w: 120, h: 64 },
    { w: 110, h: 58 },
    { w: 100, h: 52 },
    { w: 96, h: 48 },
  ];

  const sampleGetOut = [
    { index: 0, amount: "1.8 kg", name: "whole chicken" },
    { index: 1, amount: "1 kg", name: "Maris Piper potatoes" },
    { index: 2, amount: "2 tbsp", name: "olive oil" },
  ];

  it("renders R4 Two-Column Opening with categorized Get out (Show amounts toggle, zero 'and N more') and 2..6 phases with movable prep capsule", () => {
    const entry = timetableCorpus().find((x) => x.name === "sunday-roast-dinner")!;
    const firstStrip = strip(entry.plan, initialCookState("first"), null, 0);
    const goStrip = strip(entry.plan, initialCookState("go"), null, 0);
    const tFirst = buildTimetable(entry.plan, firstStrip, goStrip, "first")!;
    const tGo = buildTimetable(entry.plan, firstStrip, goStrip, "go")!;

    const ovFirst = placeOverview({
      timetable: tFirst,
      other: tGo,
      geo,
      measure,
      chrome: { more: { w: 48, h: 48 }, controls: { w: 160, h: 56 }, hint: false },
      toggle: true,
      title: entry.name,
      opening: { getOut: sampleGetOut, scaleNote: "for 6", handsOn: "45 min hands-on" },
      read: null,
      topLine: false,
      ttDims,
    });

    const onAskAhead = vi.fn();
    const onMode = vi.fn();
    const r = render(
      <Timetable
        ov={ovFirst}
        rootRef={null}
        strip={firstStrip}
        opening={true}
        live={false}
        readMark={null}
        onRead={() => {}}
        onGo={() => {}}
        onWhole={() => {}}
        onClose={() => {}}
        onMode={onMode}
        getOut={sampleGetOut}
        scaleNote="for 6"
        readText={null}
        plan={entry.plan}
        state={initialCookState("first")}
        steps={entry.plan.tasks.map((t) => t.text)}
        onAskAhead={onAskAhead}
      />,
    );

    const getOutSec = r.container.querySelector<HTMLElement>("[data-get-out]")!;
    expect(getOutSec).not.toBeNull();
    expect(getOutSec.textContent).not.toMatch(/and \d+ more/);
    expect(getOutSec.querySelector("[data-scale-note]")?.textContent).toBe("for 6");

    const showBtn = getOutSec.querySelector<HTMLButtonElement>("[data-show-amounts]")!;
    expect(showBtn.textContent).toBe("Show amounts");
    expect(showBtn.getAttribute("aria-pressed")).toBe("false");
    fireEvent.click(showBtn);
    expect(showBtn.textContent).toBe("Hide amounts");
    expect(showBtn.getAttribute("aria-pressed")).toBe("true");

    // Ahead callout + "Missed it? Ask Sous"
    const ahead = r.container.querySelector<HTMLElement>("[data-ahead]")!;
    expect(ahead).not.toBeNull();
    const askBtn = ahead.querySelector<HTMLButtonElement>("[data-ask-ahead]")!;
    expect(askBtn.textContent).toBe(COOK_COPY.missedAhead);
    fireEvent.click(askBtn);
    expect(onAskAhead).toHaveBeenCalledTimes(1);

    // 2..6 phases in Prep first, with Phase 1 Prep and movable capsule
    const phasesFirst = [...r.container.querySelectorAll<HTMLElement>("[data-opening-flow] [data-phase-row]")];
    expect(phasesFirst.length).toBeGreaterThanOrEqual(2);
    expect(phasesFirst.length).toBeLessThanOrEqual(6);
    expect(phasesFirst[0].dataset.phaseKind).toBe("prep");
    expect(phasesFirst[0].querySelector("[data-movable-prep]")).not.toBeNull();
    expect(r.container.querySelector("[data-passive-window]")).not.toBeNull();

    // Switch to As I go: movable capsule moves into passive window ("Meanwhile ·")
    const ovGo = placeOverview({
      timetable: tGo,
      other: tFirst,
      geo,
      measure,
      chrome: { more: { w: 48, h: 48 }, controls: { w: 160, h: 56 }, hint: false },
      toggle: true,
      title: entry.name,
      opening: { getOut: sampleGetOut, scaleNote: "for 6", handsOn: "45 min hands-on" },
      read: null,
      topLine: false,
      ttDims,
    });
    r.rerender(
      <Timetable
        ov={ovGo}
        rootRef={null}
        strip={goStrip}
        opening={true}
        live={false}
        readMark={null}
        onRead={() => {}}
        onGo={() => {}}
        onWhole={() => {}}
        onClose={() => {}}
        onMode={onMode}
        getOut={sampleGetOut}
        scaleNote="for 6"
        readText={null}
        plan={entry.plan}
        state={initialCookState("go")}
        steps={entry.plan.tasks.map((t) => t.text)}
        onAskAhead={onAskAhead}
      />,
    );
    const meanwhileCapsule = r.container.querySelector<HTMLElement>("[data-passive-window] [data-movable-prep]")!;
    expect(meanwhileCapsule).not.toBeNull();
    expect(meanwhileCapsule.textContent).toContain("Meanwhile ·");
  });

  it("renders Level 2 Phase Outline with done, now, and ahead states and triggers onRead when a phase card is tapped", () => {
    const entry = timetableCorpus().find((x) => x.name === "sunday-roast-dinner")!;
    let state = initialCookState("first");
    state = next(entry.plan, state);
    state = next(entry.plan, state);
    const curStrip = strip(entry.plan, state, null, 0);
    const goStrip = strip(entry.plan, initialCookState("go"), null, 0);
    const tFirst = buildTimetable(entry.plan, curStrip, goStrip, "first")!;
    const tGo = buildTimetable(entry.plan, curStrip, goStrip, "go", { now: 0 })!;

    const ovWhole = placeOverview({
      timetable: tFirst,
      other: tGo,
      geo,
      measure,
      chrome: { more: { w: 48, h: 48 }, controls: null, hint: false },
      toggle: false,
      title: entry.name,
      opening: null,
      read: null,
      topLine: false,
      ttDims,
    });

    const onRead = vi.fn();
    const r = render(
      <Timetable
        ov={ovWhole}
        rootRef={null}
        strip={curStrip}
        opening={false}
        live={true}
        readMark={null}
        onRead={onRead}
        onGo={() => {}}
        onWhole={() => {}}
        onClose={() => {}}
        getOut={sampleGetOut}
        scaleNote={null}
        readText={null}
        plan={entry.plan}
        state={state}
      />,
    );

    const outline = r.container.querySelector<HTMLElement>("[data-phase-outline]")!;
    expect(outline).not.toBeNull();
    const rows = [...outline.querySelectorAll<HTMLElement>("[data-phase-row]")];
    expect(rows.length).toBeGreaterThanOrEqual(2);
    expect(rows.length).toBeLessThanOrEqual(6);

    const doneRow = rows.find((row) => row.dataset.phaseState === "done")!;
    expect(doneRow).toBeDefined();
    expect(doneRow.querySelector("[data-phase-num]")?.textContent).toBe("✓");
    expect(doneRow.querySelector("[data-phase-status]")?.textContent).toBe("done");

    const nowRow = rows.find((row) => row.dataset.phaseState === "now")!;
    expect(nowRow).toBeDefined();
    expect(nowRow.querySelector("[data-phase-status]")?.textContent).toMatch(/left$/);

    const cardBtn = nowRow.querySelector<HTMLButtonElement>("[data-card]")!;
    fireEvent.click(cardBtn);
    expect(onRead).toHaveBeenCalledWith(cardBtn.dataset.card);
  });
});

