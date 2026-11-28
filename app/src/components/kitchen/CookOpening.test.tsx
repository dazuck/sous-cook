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

function foot(
  over: { expired?: KitchenTimer[]; running?: KitchenTimer[]; voice?: VoiceProps; micRef?: { current: HTMLButtonElement | null } } = {},
) {
  const props = { onStart: vi.fn(), onDismiss: vi.fn() };
  render(
    <TimerHere queueId="q1">
      <OpeningControls
        onStart={props.onStart}
        well={{ expired: over.expired ?? [], running: over.running ?? [], onDismiss: props.onDismiss }}
        voice={over.voice}
        micRef={over.micRef}
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

  it("draws the talk control as a mic, not the indicator dot, and hands it out for focus to come back to (v1.60)", () => {
    const micRef = { current: null as HTMLButtonElement | null };
    foot({ voice: { mode: "tap", status: "hearing", echo: null, onTap: () => {} }, micRef });
    const control = document.querySelector("[data-opening-controls] [data-voice]")!;
    expect(control.querySelector("[data-voice-dot]")).toBeNull();
    const mic = control.querySelector("[data-voice-mic]")!;
    expect(mic.hasAttribute("data-live")).toBe(true);
    expect(control.getAttribute("aria-label")).toBe("Stop listening");
    expect(micRef.current).toBe(control);
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
import { aheadGroups, initialCookState, missedAheadAsk, next, prepPages } from "@/lib/kitchen/cook-view";
import { placeOverview } from "@/lib/kitchen/overview-place";
import { LINE_FROM_FOOT } from "@/lib/kitchen/strip-map";
import { buildTimetable } from "@/lib/kitchen/timetable-model";
import { advanceMeasure as measure } from "@/lib/kitchen/__tests__/advance-measure";
import { timetableCorpus } from "@/lib/kitchen/__tests__/timetable-corpus";
import { storedIngredientLines } from "@/lib/kitchen/ingredient-display";
import { legacyToPackRecipe } from "@/lib/pack-convert/convert";
import { AMOUNT_RULE } from "./MeasurementPopover";
import { AHEAD_ROW, aheadRowPx, GET_OUT_LINES, Timetable } from "./Timetable";
import { loadCookPlanFixtures } from "@/lib/kitchen/__tests__/load-cook-plan-fixtures";
import { COLUMN, COLUMN_GAP, FOLDED_GAP, foldedCount, foldedWidthCpx, headRowCpx, listRowsCpx, noteFoldedCpx, wrapRuns, type NoteRun } from "./get-out-room";

/** A corpus meal's title as the cook page shows it: "sunday-roast-dinner" is "Sunday roast dinner". */
const titleOf = (name: string) => {
  const words = name.replace(/^pack:/, "").replace(/-/g, " ");
  return words.charAt(0).toUpperCase() + words.slice(1);
};

/** A note's words as drawn, run by run: each text with the size and weight it is set in. */
function drawnRuns(p: HTMLElement, c: number): NoteRun[] {
  const runs: NoteRun[] = [];
  const weightOf = (el: HTMLElement) => {
    const at = el.closest<HTMLElement>(".font-bold, .font-semibold, .font-medium");
    return at?.classList.contains("font-bold") ? 700 : at?.classList.contains("font-semibold") ? 600 : 500;
  };
  const walk = (el: HTMLElement) => {
    for (const n of el.childNodes) {
      if (n.nodeType === Node.TEXT_NODE) {
        const size = el.style.fontSize ? parseFloat(el.style.fontSize) / c : 22;
        runs.push({ text: n.textContent ?? "", size, weight: weightOf(el) });
      } else if (n instanceof HTMLElement) walk(n);
    }
  };
  walk(p);
  return runs;
}

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

  it("a prep mode chosen redraws the lines in a new scroll box, and the foot's fade listens to that box (review: React 2; the cookies, one height in both modes)", () => {
    const entry = timetableCorpus().find((x) => x.name === "chewy-oat-cookies")!;
    const firstStrip = strip(entry.plan, initialCookState("first"), null, 0);
    const goStrip = strip(entry.plan, initialCookState("go"), null, 0);
    const tFirst = buildTimetable(entry.plan, firstStrip, goStrip, "first")!;
    const tGo = buildTimetable(entry.plan, firstStrip, goStrip, "go")!;
    // A short landscape sheet, so the lines scroll in their box.
    const short = { ...geo, H: 420, footTop: 340, ledgeTop: 318 };
    const ovOf = (timetable: typeof tFirst, other: typeof tFirst) =>
      placeOverview({
        timetable,
        other,
        geo: short,
        measure,
        chrome: { more: { w: 48, h: 48 }, controls: { w: 160, h: 56 }, hint: false },
        toggle: true,
        title: entry.name,
        opening: { getOut: sampleGetOut, scaleNote: null, handsOn: "45 min hands-on" },
        read: null,
        topLine: false,
        ttDims,
      });
    const props = {
      rootRef: null,
      measureText: () => measure,
      opening: true,
      live: false,
      readMark: null,
      onRead: () => {},
      onGo: () => {},
      onWhole: () => {},
      onClose: () => {},
      onMode: () => {},
      getOut: sampleGetOut,
      scaleNote: null,
      readText: null,
      plan: entry.plan,
      steps: entry.plan.tasks.map((t) => t.text),
      onAskAhead: () => {},
    };
    const listening = new Set<EventTarget>();
    const add = HTMLElement.prototype.addEventListener;
    const spy = vi.spyOn(HTMLElement.prototype, "addEventListener").mockImplementation(function (this: HTMLElement, type, ...rest) {
      if (type === "scroll") listening.add(this);
      return add.call(this, type, ...rest);
    });
    try {
      const r = render(<Timetable {...props} ov={ovOf(tFirst, tGo)} strip={firstStrip} state={initialCookState("first")} />);
      const before = r.container.querySelector<HTMLElement>("[data-lines-scroll]")!;
      expect(before.querySelector("[data-meal-lines]")!.getAttribute("data-scroll")).toBe("true");
      const h = before.querySelector<HTMLElement>("[data-meal-lines]")!.style.height;
      r.rerender(<Timetable {...props} ov={ovOf(tGo, tFirst)} strip={goStrip} state={initialCookState("go")} />);
      const after = r.container.querySelector<HTMLElement>("[data-lines-scroll]")!;
      // The same height in both modes: only the mode says the box is new.
      expect(after.querySelector<HTMLElement>("[data-meal-lines]")!.style.height).toBe(h);
      expect(after).not.toBe(before);
      expect(listening.has(after)).toBe(true);
    } finally {
      spy.mockRestore();
    }
  });

  it("at the whole cook on the wide tablet the lines take the sheet down to the foot, 14 cpx over it: the roast mid-cook drawn whole, nothing kept for the old line", () => {
    const entry = timetableCorpus().find((x) => x.name === "sunday-roast-dinner")!;
    // 1280×800 as the cook screen lays it (`sheet-derived.test.ts`'s geometry).
    const c = 1280 / 960;
    const g = { W: 1280, H: 800, c, E: 48, top: 92 * c, stepTop: 104 * c, footTop: 800 - 100 * c, ledgeTop: 800 - 96 * c, portrait: false };
    let state = initialCookState("first");
    for (let i = 0; i < 6; i++) state = next(entry.plan, state);
    const s = strip(entry.plan, state, null, 0);
    const first = strip(entry.plan, initialCookState("first"), null, 0);
    const go = strip(entry.plan, initialCookState("go"), null, 0);
    const t = buildTimetable(entry.plan, s, go, "first")!;
    const other = buildTimetable(entry.plan, first, go, "go", { now: 0 })!;
    const ov = placeOverview({
      timetable: t,
      other,
      geo: g,
      measure,
      chrome: { more: { w: 56 * c, h: 56 * c }, controls: null, hint: false },
      toggle: false,
      title: "Sunday roast dinner",
      opening: null,
      read: null,
      topLine: false,
      ttDims,
    });
    // Where the cook screen's line stands (`layoutDerived`), as the sheet hands it over.
    const growFrom = (g.footTop - LINE_FROM_FOOT * c - ov.Y2) / c;
    const r = render(
      <Timetable
        ov={ov}
        rootRef={null}
        measureText={() => measure}
        strip={s}
        opening={false}
        live={false}
        readMark={null}
        onRead={() => {}}
        onGo={() => {}}
        onWhole={() => {}}
        onClose={() => {}}
        getOut={[]}
        scaleNote={null}
        readText={null}
        onSheet={{ growFrom, hide: [] }}
        plan={entry.plan}
        state={state}
        steps={entry.plan.tasks.map((x) => x.text)}
      />,
    );
    const box = r.container.querySelector<HTMLElement>("[data-whole-lines]")!;
    const bottom = (parseFloat(box.style.top) + parseFloat(box.style.height)) / c;
    const foot = (g.footTop - ov.Y2) / c;
    expect(bottom).toBeCloseTo(foot - 14, 3);
    const drawn = box.querySelector<HTMLElement>("[data-meal-lines]")!;
    expect(drawn.getAttribute("data-meal-lines")).toBe("columns");
    expect(drawn.getAttribute("data-scroll")).toBe("false");
    expect(parseFloat(drawn.style.height)).toBeLessThanOrEqual(parseFloat(box.style.height) + 0.5);
  });

  it("an opening with no Ahead work draws, Get out beside the lines and no Ahead note (the page threw reading the note it didn't have)", () => {
    const none = timetableCorpus().filter((x) => {
      const s1 = strip(x.plan, initialCookState("first"), null, 0);
      const s2 = strip(x.plan, initialCookState("go"), null, 0);
      return buildTimetable(x.plan, s1, s2, "first")!.ahead.length === 0;
    });
    expect(none.length).toBeGreaterThan(0);
    for (const entry of none) {
      const firstStrip = strip(entry.plan, initialCookState("first"), null, 0);
      const goStrip = strip(entry.plan, initialCookState("go"), null, 0);
      const tFirst = buildTimetable(entry.plan, firstStrip, goStrip, "first")!;
      const tGo = buildTimetable(entry.plan, firstStrip, goStrip, "go")!;
      const ov = placeOverview({
        timetable: tFirst,
        other: tGo,
        geo: { ...geo, W: 1280, H: 800, footTop: 720, ledgeTop: 698 },
        measure,
        chrome: { more: { w: 48, h: 48 }, controls: { w: 160, h: 56 }, hint: false },
        toggle: true,
        title: entry.name,
        opening: { getOut: sampleGetOut, scaleNote: null, handsOn: "20 min hands-on" },
        read: null,
        topLine: false,
        ttDims,
      });
      expect(ov.opening!.ahead, entry.name).toBeNull();
      const r = render(
        <Timetable
          ov={ov}
          rootRef={null}
          measureText={() => measure}
          strip={firstStrip}
          opening={true}
          live={false}
          readMark={null}
          onRead={() => {}}
          onGo={() => {}}
          onWhole={() => {}}
          onClose={() => {}}
          onMode={() => {}}
          getOut={sampleGetOut}
          scaleNote={null}
          readText={null}
          plan={entry.plan}
          state={initialCookState("first")}
          steps={entry.plan.tasks.map((t) => t.text)}
          onAskAhead={() => {}}
        />,
      );
      expect(r.container.querySelector("[data-get-out]"), entry.name).not.toBeNull();
      expect(r.container.querySelector("[data-meal-lines]"), entry.name).not.toBeNull();
      expect(r.container.querySelector("[data-ahead]"), entry.name).toBeNull();
      cleanup();
    }
  });

  it("'Missed it? Ask Sous' under the Ahead note on every stored meal with make-ahead work, wide and upright, and none without (DECISIONS 2026-11-24)", () => {
    const wide = { ...geo, W: 1280, H: 800, c: 1280 / 960, footTop: 720, ledgeTop: 698 };
    const upright = { W: 800, H: 1280, c: 800 / 600, E: 35, top: 64, stepTop: 84, footTop: 1200, ledgeTop: 1178, portrait: true };
    let withAhead = 0;
    let without = 0;
    for (const entry of timetableCorpus()) {
      const firstStrip = strip(entry.plan, initialCookState("first"), null, 0);
      const goStrip = strip(entry.plan, initialCookState("go"), null, 0);
      const tFirst = buildTimetable(entry.plan, firstStrip, goStrip, "first");
      const tGo = buildTimetable(entry.plan, firstStrip, goStrip, "go");
      if (!tFirst || !tGo) continue;
      const groups = aheadGroups(entry.plan);
      for (const [shape, g] of [["wide", wide], ["upright", upright]] as const) {
        const ov = placeOverview({
          timetable: tFirst,
          other: tGo,
          geo: g,
          measure,
          chrome: { more: { w: 48, h: 48 }, controls: { w: 160, h: 56 }, hint: false },
          toggle: true,
          title: entry.name,
          opening: { getOut: sampleGetOut, scaleNote: null, handsOn: "20 min hands-on" },
          read: null,
          topLine: false,
          ttDims,
        });
        const onAskAhead = vi.fn();
        const r = render(
          <Timetable
            ov={ov}
            rootRef={null}
            measureText={() => measure}
            strip={firstStrip}
            opening={true}
            live={false}
            readMark={null}
            onRead={() => {}}
            onGo={() => {}}
            onWhole={() => {}}
            onClose={() => {}}
            onMode={() => {}}
            getOut={sampleGetOut}
            scaleNote={null}
            readText={null}
            plan={entry.plan}
            state={initialCookState("first")}
            steps={entry.plan.tasks.map((t) => t.text)}
            onAskAhead={onAskAhead}
            stepper={{ recipe: { serves_base: 4, serves_estimated: true }, servings: 4, onChange: () => {} }}
          />,
        );
        const where = `${entry.name} ${shape}`;
        // Where the note is folded to leave Get out its two rows (DS v1.66), the ask is in it opened.
        const folded = r.container.querySelector<HTMLElement>("[data-ahead][data-ahead-fold='folded']");
        if (folded) {
          expect(shape, where).toBe("wide");
          fireEvent.click(folded);
        }
        const ask = r.container.querySelector<HTMLButtonElement>("[data-ask-ahead]");
        if (groups.length === 0) {
          expect(ask, where).toBeNull();
          without++;
          cleanup();
          continue;
        }
        withAhead++;
        expect(ask, where).not.toBeNull();
        const note = r.container.querySelector<HTMLElement>("[data-ahead]")!;
        const words = note.querySelector<HTMLElement>("p [data-ask-words]");
        // The note's last words, inline in its own text: no block of their own under it.
        expect(words, where).not.toBeNull();
        const text = note.querySelector("p")!;
        expect(text.lastElementChild, where).toBe(words);
        // The words' first half, the half that carries the meaning; the whole is the ask's name.
        expect(words!.textContent, where).toBe(missedAheadAsk(groups).words);
        // At the note's size, the 22 cpx floor, in a note that cuts nothing.
        expect(parseFloat(text.style.fontSize), where).toBeCloseTo(22 * g.c, 3);
        for (const el of [note, text]) expect(el.getAttribute("class") ?? "", where).not.toMatch(/\b(truncate|overflow-hidden|text-ellipsis)\b/);
        // The target is the whole note, at least 48 px tall, named by the ask's words; said once.
        expect(note.contains(ask), where).toBe(true);
        expect(ask!.getAttribute("aria-label"), where).toBe(missedAheadAsk(groups).label);
        expect(ask!.textContent, where).toBe("");
        expect(words!.getAttribute("aria-hidden"), where).toBe("true");
        // The note is the target, 48 px tall at least of its own, so the target never hangs past it
        // (into the body's clip above, or the stepper's touch below).
        expect(ask!.className.split(/\s+/), where).toEqual(expect.arrayContaining(["absolute", "inset-0"]));
        expect(ask!.className, where).not.toMatch(/translate|min-h/);
        expect(note.className.split(/\s+/), where).toEqual(expect.arrayContaining(["relative", "min-h-[48px]"]));
        // Its 48 px is a floor, never a size a full column may squeeze it to under its words.
        expect(note.className.split(/\s+/), where).toContain("shrink-0");
        // It lies over the note's words, so it is described by them: a finger exploring the note hears the work too.
        expect(ask!.getAttribute("aria-describedby"), where).toBe(text.id);
        expect(text.id, where).not.toBe("");
        // Its focus ring is drawn inside the note, which stands flush with columns that clip.
        expect(ask!.className.split(/\s+/), where).toContain("focus-visible:-outline-offset-4");
        // Upright, Get out's head row (the stepper's − and +, whose touch stands 24 cpx over their row)
        // keeps that room under the note, so neither takes the other's taps.
        const servings = r.container.querySelector("[role='group'][aria-label='Servings']");
        expect(servings, where).not.toBeNull();
        if (shape !== "wide") {
          const row = r.container.querySelector<HTMLElement>("[data-get-out-head-row]")!;
          expect(parseFloat(row.style.paddingTop), where).toBeCloseTo(24 * g.c, 3);
        }
        // In Get out's column wherever the note heads it.
        if (shape === "wide") expect(r.container.querySelector("[data-get-out]")!.contains(note), where).toBe(true);
        fireEvent.click(ask!);
        expect(onAskAhead, where).toHaveBeenCalledWith(groups);
        cleanup();
      }
    }
    expect(withAhead).toBeGreaterThanOrEqual(10);
    expect(without).toBeGreaterThan(0);
  });

  it("Get out keeps room for two rows: on the wide tablet the Ahead note folds to one line wherever at its full height it would leave the list less, and a note that fits is drawn as ever (DS v1.66)", () => {
    // Every stored meal with make-ahead work, its own Get out where the corpus keeps its ingredients,
    // at 1280×800 (the tablet) and 1280×680 (its Chrome tab), the serving stepper as the cook page
    // draws it there.
    const recipes = new Map(loadCookPlanFixtures().map((f) => [f.name, f.recipe]));
    const stepper = { recipe: { serves_base: 4, serves_estimated: true as const }, servings: 4, onChange: () => {} };
    let folded = 0;
    let fits = 0;
    for (const entry of timetableCorpus()) {
      const firstStrip = strip(entry.plan, initialCookState("first"), null, 0);
      const goStrip = strip(entry.plan, initialCookState("go"), null, 0);
      const tFirst = buildTimetable(entry.plan, firstStrip, goStrip, "first")!;
      const tGo = buildTimetable(entry.plan, firstStrip, goStrip, "go")!;
      if (!tFirst || !tGo) continue;
      const groups = aheadGroups(entry.plan);
      if (groups.length === 0) continue;
      const own = recipes.get(entry.name)?.ingredients.map((g, index) => ({ index, amount: null, name: g.item }));
      const getOut = own && own.length > 0 ? own : sampleGetOut;
      for (const H of [800, 680]) {
        const c = Math.min(1280 / 960, H / 600);
        const ov = placeOverview({
          timetable: tFirst,
          other: tGo,
          // The sheet's geometry as the cook screen lays it (`sheet-derived.test.ts`), its chrome at its size
          // there (More 104 × 80 cpx, the opening's controls 170 × 80, as Chromium draws them), and the
          // meal's own title, which takes one line or two and so moves the column's top.
          geo: { W: 1280, H, c, E: 48, top: 92 * c, stepTop: 104 * c, footTop: H - 100 * c, ledgeTop: H - 96 * c, portrait: false },
          measure,
          chrome: { more: { w: 104 * c, h: 80 * c }, controls: { w: 170 * c, h: 80 * c }, hint: false },
          toggle: true,
          title: titleOf(entry.name),
          opening: { getOut, scaleNote: null, handsOn: "45 min hands-on" },
          read: null,
          topLine: false,
          ttDims,
        });
        const onAskAhead = vi.fn();
        const r = render(
          <Timetable
            ov={ov}
            rootRef={null}
            measureText={() => measure}
            strip={firstStrip}
            opening={true}
            live={false}
            readMark={null}
            onRead={() => {}}
            onGo={() => {}}
            onWhole={() => {}}
            onClose={() => {}}
            onMode={() => {}}
            getOut={getOut}
            scaleNote={null}
            readText={null}
            plan={entry.plan}
            state={initialCookState("first")}
            steps={entry.plan.tasks.map((t) => t.text)}
            onAskAhead={onAskAhead}
            stepper={stepper}
          />,
        );
        const where = `${entry.name} at 1280×${H}`;
        const note = () => r.container.querySelector<HTMLElement>("[data-get-out] [data-ahead]")!;
        expect(note(), where).not.toBeNull();
        expect(note().getAttribute("data-ahead-form"), where).toBe("column");
        // The column as drawn: its height, Get out's head row with the stepper, the list's first two rows.
        const avail = parseFloat(r.container.querySelector<HTMLElement>("[data-opening-body]")!.style.height) / c;
        const head = headRowCpx({ heading: COOK_COPY.getOut, scaleNote: null, stepper: { words: "serves 4 (Sous's estimate)", scales: true }, amounts: true }, measure);
        const rows = listRowsCpx([{ items: getOut.map((g) => g.name) }], measure);
        const room = avail - COLUMN_GAP - head - COLUMN_GAP;
        const full = (p: HTMLElement) => Math.max(48 / c, wrapRuns(drawnRuns(p, c), COLUMN - 24, measure) * 26 + 12);
        if (note().getAttribute("data-ahead-fold") === "folded") {
          folded++;
          // Folded: one line, a 48 px target, "Ahead · 3 jobs" (one per job the note lists) whole, and the
          // mark that opens it; no cut words, no "Missed it?". Its name is the note's words and "Show all".
          const line = note();
          expect(line.tagName, where).toBe("BUTTON");
          expect(line.getAttribute("aria-expanded"), where).toBe("false");
          expect(line.getAttribute("aria-label"), where).toMatch(/^Ahead .+\. Show all$/);
          expect(line.className.split(/\s+/), where).toEqual(expect.arrayContaining(["min-h-[48px]", "shrink-0", "w-full", `gap-[calc(${FOLDED_GAP}*var(--cpx))]`]));
          const words = line.querySelector<HTMLElement>("[data-ahead-count]")!;
          expect(words?.textContent, where).toBe(`${COOK_COPY.ahead} ${foldedCount(groups.length)}`);
          expect(line.querySelector(".truncate, .text-ellipsis"), where).toBeNull();
          expect(line.textContent, where).not.toMatch(/…/);
          expect(parseFloat(words.style.fontSize), where).toBeCloseTo(22 * c, 3);
          const [aheadWord, count] = [...words.children] as HTMLElement[];
          expect(aheadWord.className.split(/\s+/), where).toEqual(expect.arrayContaining(["font-semibold", "text-ink"]));
          expect(parseFloat(aheadWord.style.fontSize), where).toBeCloseTo(24 * c, 3);
          expect(count.className.split(/\s+/), where).toContain("font-medium");
          // Whole in the column, with its chevron.
          expect(foldedWidthCpx(groups.length, COOK_COPY.ahead, measure), where).toBeLessThanOrEqual(COLUMN);
          expect(line.querySelector("[data-ask-words], [data-ask-ahead]"), where).toBeNull();
          expect(line.textContent, where).not.toMatch(/Missed/);
          expect(line.querySelector("svg"), where).not.toBeNull();
          // Folded, the list gets its two rows.
          expect(noteFoldedCpx(c) + rows, where).toBeLessThanOrEqual(room + 0.01);
          // A tap opens it in full, its ask at its end working as now, and the turned mark to fold it.
          fireEvent.click(line);
          const open = note();
          expect(open.getAttribute("data-ahead-fold"), where).toBe("open");
          expect(open.querySelector("p [data-ask-words]")?.textContent, where).toBe(missedAheadAsk(groups).words);
          // Opened, it was the note that left the list less than its two rows.
          expect(full(open.querySelector("p")!) + rows, where).toBeGreaterThan(room);
          const back = open.querySelector<HTMLButtonElement>("[data-ahead-fold-back]")!;
          expect(back.getAttribute("aria-expanded"), where).toBe("true");
          expect(back.className.split(/\s+/), where).toEqual(expect.arrayContaining(["h-[48px]", "w-[48px]"]));
          // Its whole square is its target: no rounding on it to let a finger near its corner through to
          // the ask under it; its ring, drawn inside, keeps the note's corner on a span of its own.
          expect(back.className, where).not.toMatch(/\brounded/);
          const ring = back.querySelector<HTMLElement>("[data-ahead-fold-ring]")!;
          expect(ring.className.split(/\s+/), where).toEqual(expect.arrayContaining(["inset-0", "pointer-events-none", "rounded-tr-[var(--radius-2)]", "group-focus-visible:-outline-offset-4"]));
          // It stands before the ask, so Tab and a swipe go on from it to the ask, not past it.
          const askBtn = open.querySelector<HTMLButtonElement>("[data-ask-ahead]")!;
          expect(back.compareDocumentPosition(askBtn) & Node.DOCUMENT_POSITION_FOLLOWING, where).toBeTruthy();
          expect(document.activeElement, where).toBe(back);
          fireEvent.click(open.querySelector<HTMLButtonElement>("[data-ask-ahead]")!);
          expect(onAskAhead, where).toHaveBeenCalledWith(groups);
          fireEvent.click(back);
          expect(note().getAttribute("data-ahead-fold"), where).toBe("folded");
          expect(document.activeElement, where).toBe(note());
        } else {
          fits++;
          // A note that leaves the list its two rows is drawn as ever: no mark, nothing folds.
          expect(note().tagName, where).toBe("DIV");
          expect(note().hasAttribute("data-ahead-fold"), where).toBe(false);
          expect(note().querySelector("[data-ahead-fold-back], [data-ahead-fold]"), where).toBeNull();
          expect(full(note().querySelector("p")!) + rows, where).toBeLessThanOrEqual(room + 0.01);
        }
        cleanup();
      }
    }
    expect(folded, "notes that fold").toBeGreaterThan(0);
    expect(fits, "notes that fit").toBeGreaterThan(0);
  });

  /** The cookies' opening at 1280×800, as the fold test lays it, with the given props over it. */
  const cookiesOpening = (props: Partial<React.ComponentProps<typeof Timetable>>, geoOver: Partial<typeof geo> = {}) => {
    const entry = timetableCorpus().find((x) => x.name === "chewy-oat-cookies")!;
    const firstStrip = strip(entry.plan, initialCookState("first"), null, 0);
    const goStrip = strip(entry.plan, initialCookState("go"), null, 0);
    const tFirst = buildTimetable(entry.plan, firstStrip, goStrip, "first")!;
    const tGo = buildTimetable(entry.plan, firstStrip, goStrip, "go")!;
    const c = 1280 / 960;
    const g = { W: 1280, H: 800, c, E: 48, top: 92 * c, stepTop: 104 * c, footTop: 800 - 100 * c, ledgeTop: 800 - 96 * c, portrait: false, ...geoOver };
    const getOut = [...(props.getOut ?? sampleGetOut)];
    const ov = placeOverview({
      timetable: tFirst,
      other: tGo,
      geo: g,
      measure,
      chrome: { more: { w: 104 * c, h: 80 * c }, controls: { w: 170 * c, h: 80 * c }, hint: false },
      toggle: true,
      title: titleOf(entry.name),
      opening: { getOut, scaleNote: null, handsOn: "10 min hands-on" },
      read: null,
      topLine: false,
      ttDims,
    });
    const all: React.ComponentProps<typeof Timetable> = {
      ov,
      rootRef: null,
      measureText: () => measure,
      strip: firstStrip,
      opening: true,
      live: false,
      readMark: null,
      onRead: () => {},
      onGo: () => {},
      onWhole: () => {},
      onClose: () => {},
      onMode: () => {},
      getOut,
      scaleNote: null,
      readText: null,
      plan: entry.plan,
      state: initialCookState("first"),
      steps: entry.plan.tasks.map((t) => t.text),
      ...props,
    };
    return all;
  };

  it("the cook page's fresh stepper each render (every timer tick) does not measure the note again: only its words and whether it scales do", () => {
    const measureText = vi.fn(() => measure);
    const stepper = { recipe: { serves_base: 4, serves_estimated: true as const }, servings: 4, onChange: () => {} };
    const props = cookiesOpening({ measureText, stepper, onAskAhead: () => {} });
    const r = render(<Timetable {...props} />);
    expect(r.container.querySelector("[data-ahead][data-ahead-fold='folded']")).not.toBeNull();
    const calls = measureText.mock.calls.length;
    // A tick: the same values in a new object, and a new onChange.
    r.rerender(<Timetable {...props} stepper={{ ...stepper, recipe: { ...stepper.recipe }, onChange: () => {} }} />);
    expect(measureText.mock.calls.length).toBe(calls);
    // A new serving count is new words: the note is measured again.
    r.rerender(<Timetable {...props} stepper={{ ...stepper, servings: 12 }} />);
    expect(measureText.mock.calls.length).toBeGreaterThan(calls);
  });

  it("the stacked and one-line notes keep their height in a full column with the ask or without it (shrink-0)", () => {
    // Upright: the stacked form; wide with no Get out: the one-line form. Each without its ask.
    const upright = { W: 800, H: 1280, c: 800 / 600, E: 35, top: 64, stepTop: 84, footTop: 1200, ledgeTop: 1178, portrait: true };
    for (const [form, props, g] of [
      ["stacked", {}, upright],
      ["row", { getOut: [] }, {}],
    ] as const) {
      const r = render(<Timetable {...cookiesOpening(props, g)} />);
      const note = r.container.querySelector<HTMLElement>("[data-ahead]")!;
      expect(note.getAttribute("data-ahead-form"), form).toBe(form);
      expect(note.querySelector("[data-ask-ahead]"), form).toBeNull();
      expect(note.className.split(/\s+/), form).toContain("shrink-0");
      cleanup();
    }
  });

  it("with Ahead work and no Get out, Ahead stands above the lines in its one-line form, the ask's words in its text at its size, and the lines leave it its real height: drawn whole or scrolling, never cut (review: bug 3; review round 3)", () => {
    // Every stored meal with make-ahead work, its Get out left empty so the note takes its one-line form,
    // on the tablet (1280×800) and in its Chrome tab (1280×680, where a unit is under 1.333 px); the
    // roast across tablet-shaped sheets from roomy to tight.
    const sheets: { name: string; H: number }[] = [];
    for (const entry of timetableCorpus()) for (const H of [800, 680]) sheets.push({ name: entry.name, H });
    for (let H = 560; H <= 900; H += 20) sheets.push({ name: "sunday-roast-dinner", H });
    let rowForm = 0;
    let tight = 0;
    for (const { name, H } of sheets) {
      const entry = timetableCorpus().find((x) => x.name === name)!;
      const firstStrip = strip(entry.plan, initialCookState("first"), null, 0);
      const goStrip = strip(entry.plan, initialCookState("go"), null, 0);
      const tFirst = buildTimetable(entry.plan, firstStrip, goStrip, "first");
      const tGo = buildTimetable(entry.plan, firstStrip, goStrip, "go");
      if (!tFirst || !tGo) continue;
      // The screen's real unit (`CookSheet`: 960 × 600 cpx fitted to it): 4/3 at 1280×800, 680/600 at
      // 1280×680; the foot and the ledge at their cpx heights (60 and 76.5) in it (review round 4).
      const c = Math.min(1280 / 960, H / 600);
      const ov = placeOverview({
        timetable: tFirst,
        other: tGo,
        geo: { ...geo, W: 1280, H, c, footTop: H - 60 * c, ledgeTop: H - 76.5 * c },
        measure,
        chrome: { more: { w: 48, h: 48 }, controls: { w: 160, h: 56 }, hint: false },
        toggle: true,
        title: entry.name,
        opening: { getOut: [], scaleNote: null, handsOn: "45 min hands-on" },
        read: null,
        topLine: false,
        ttDims,
      });
      const r = render(
        <Timetable
          ov={ov}
          rootRef={null}
          measureText={() => measure}
          strip={firstStrip}
          opening={true}
          live={false}
          readMark={null}
          onRead={() => {}}
          onGo={() => {}}
          onWhole={() => {}}
          onClose={() => {}}
          onMode={() => {}}
          getOut={[]}
          scaleNote={null}
          readText={null}
          plan={entry.plan}
          state={initialCookState("first")}
          steps={entry.plan.tasks.map((t) => t.text)}
          onAskAhead={() => {}}
        />,
      );
      const where = `${name} at 1280×${H}`;
      const flow = r.container.querySelector<HTMLElement>("[data-opening-flow]");
      const note = flow?.querySelector<HTMLElement>("[data-ahead]");
      if (!flow || !note) {
        cleanup();
        continue;
      }
      rowForm++;
      expect(r.container.querySelector("[data-get-out]"), where).toBeNull();
      expect(note.getAttribute("data-ahead-form"), where).toBe("row");
      // The ask's words in the note's own text, at its size (22 cpx, never under the floor), after its
      // cut part and never cut themselves; the whole note the target, named whole.
      const text = note.querySelector<HTMLElement>("p")!;
      const words = note.querySelector<HTMLElement>("[data-ask-words]");
      expect(words, where).not.toBeNull();
      expect(words!.closest("p"), where).toBe(text);
      expect(parseFloat(text.style.fontSize), where).toBeCloseTo(22 * ov.c, 3);
      expect(words!.style.fontSize, where).toBe("");
      expect(words!.closest(".truncate"), where).toBeNull();
      expect(words!.className.split(/\s+/), where).toEqual(expect.arrayContaining(["shrink-0", "whitespace-nowrap"]));
      // The full stop ends the part that is cut, so a cut note reads "… Missed it?", never "…. Missed it?".
      const cut = text.querySelector<HTMLElement>(".truncate");
      expect(cut, where).not.toBeNull();
      expect(cut!.textContent, where).toMatch(/\.$/);
      const after = text.textContent!.slice(text.textContent!.indexOf(cut!.textContent!) + cut!.textContent!.length);
      expect(after, where).toBe(` ${words!.textContent}`);
      const target = note.querySelector<HTMLElement>("[data-ask-ahead]");
      expect(target?.getAttribute("aria-label"), where).toMatch(/^Missed (it|these)\? Ask Sous$/);
      expect(note.className.split(/\s+/), where).toEqual(expect.arrayContaining(["relative", "min-h-[48px]", "shrink-0", "items-center", "py-[calc(4*var(--cpx))]"]));
      expect(note.className.split(/\s+/), where).not.toContain("overflow-hidden");
      expect(target!.className.split(/\s+/), where).toContain("inset-0");
      // The note's real height: its line and padding, 48 px at least; with the flow's gap under it.
      expect(flow.className.split(/\s+/), where).toContain("gap-[calc(4*var(--cpx))]");
      const noteHeight = Math.max(48, parseFloat(text.style.lineHeight) + 8 * ov.c);
      // The layout budgets that height (`aheadRowPx`), gap and all; on the tablet, exactly the old 40 units.
      expect(ov.c, where).toBeCloseTo(c, 6);
      expect(aheadRowPx(ov.c, true), where).toBeGreaterThanOrEqual(noteHeight + 4 * ov.c - 0.01);
      if (H === 800) expect(aheadRowPx(ov.c, true), where).toBeCloseTo(AHEAD_ROW * ov.c, 6);
      const drawn = flow.querySelector<HTMLElement>("[data-meal-lines]");
      if (drawn && drawn.getAttribute("data-scroll") === "false") {
        const room = parseFloat(flow.style.maxHeight) - noteHeight - 4 * ov.c;
        expect(parseFloat(drawn.style.height), where).toBeLessThanOrEqual(room + 0.5);
        if (parseFloat(drawn.style.height) > room - 8) tight++;
      }
      cleanup();
    }
    expect(rowForm).toBeGreaterThanOrEqual(20);
    // The sweep reaches drawings that need nearly all the room, so the row's height is what decides.
    expect(tight).toBeGreaterThan(0);
  });

  it("renders the opening: categorized Get out (Show amounts toggle, zero 'and N more'), Ahead at its head, and the meal as lines in the flow (DS v1.63)", () => {
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
        measureText={() => measure}
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
    // The roast's two make-ahead jobs (overnight, an hour before): one ask for both, in Prep's words for several.
    expect(askBtn.getAttribute("aria-label")).toBe(COOK_COPY.missedAheadMany);
    fireEvent.click(askBtn);
    expect(onAskAhead).toHaveBeenCalledTimes(1);

    // Ahead heads Get out's column, as drawn, so the flow's column opens on the meal's shape.
    expect(getOutSec.contains(ahead)).toBe(true);
    // In that narrow column the note wraps, its ask its last words: one nowrap line there
    // squeezed the note's words to nothing and clipped "Missed it? Ask Sous" itself.
    expect(ahead.querySelector("p")!.textContent).toMatch(/Dry-brine chicken/);
    const clips = /\b(truncate|whitespace-nowrap|overflow-hidden|text-ellipsis)\b/;
    // (The ask's own words hold together on one line: they are the one exception.)
    for (const el of [ahead, ...ahead.querySelectorAll<HTMLElement>("*:not([data-ask-words])")]) expect(el.getAttribute("class") ?? "").not.toMatch(clips);
    expect(ahead.getAttribute("data-ahead-form")).toBe("column");
    // The ask's words, kept on one line, fit one line of the note's text inside its padding (186 cpx).
    const inner = GET_OUT_LINES - 2 * 12;
    for (const words of [COOK_COPY.missedAheadShort, COOK_COPY.missedAheadManyShort]) expect(measure(words, 22, 600)).toBeLessThanOrEqual(inner);

    // The flow: the meal as lines, a column per dish, no phases; nothing in hand and nothing to tap before Start.
    const flow = r.container.querySelector<HTMLElement>("[data-opening-flow]")!;
    expect(flow.querySelector("[data-phase-row]")).toBeNull();
    expect(flow.querySelector("[data-meal-lines]")).not.toBeNull();
    expect([...flow.querySelectorAll("[data-line-head]")].map((h) => h.textContent)).toEqual(["Chicken", "Potatoes", "Gravy", "Beans"]);
    expect(flow.querySelector('[data-stop-state="now"]')).toBeNull();
    expect(flow.querySelector("button[data-card]")).toBeNull();
    // When the cook can walk away, and for how long: the ruled breaks with their words.
    expect([...flow.querySelectorAll("[data-line-free]")].map((b) => b.textContent)).toContain("50 min free");
    const prepFirst = [...flow.querySelectorAll<HTMLElement>("[data-line-stop]")].map((el) => el.textContent);
    // Prep first's pages are stops on their dishes' lines, marked as up-front prep.
    expect(flow.querySelectorAll("[data-line-stop][data-stop-prep]").length).toBeGreaterThan(0);

    // Switch to As I go: the lines are drawn again, the prep moved into the breaks
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
        measureText={() => measure}
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
    const asIGo = [...r.container.querySelectorAll<HTMLElement>("[data-opening-flow] [data-line-stop]")].map((el) => el.textContent);
    expect(asIGo).not.toEqual(prepFirst);
    expect(r.container.querySelector("[data-movable-prep]")).toBeNull();
    expect([...r.container.querySelectorAll("[data-opening-flow] [data-line-free]")].map((b) => b.textContent)).toContain("40 min free");
  });

  // Asked 2026-11-22: Get out's list scrolls in its column, and its amounts open their conversions.
  it("Get out's list is its column's scroller under a head that stays, and a shown amount with conversions is its pair's button, opening in the opening's layer", () => {
    const entry = timetableCorpus().find((x) => x.name === "sunday-roast-dinner")!;
    const firstStrip = strip(entry.plan, initialCookState("first"), null, 0);
    const goStrip = strip(entry.plan, initialCookState("go"), null, 0);
    const tFirst = buildTimetable(entry.plan, firstStrip, goStrip, "first")!;
    const tGo = buildTimetable(entry.plan, firstStrip, goStrip, "go")!;
    const ov = placeOverview({
      timetable: tFirst,
      other: tGo,
      geo,
      measure,
      chrome: { more: { w: 48, h: 48 }, controls: { w: 160, h: 56 }, hint: false },
      toggle: true,
      title: entry.name,
      opening: { getOut: sampleGetOut, scaleNote: null, handsOn: "45 min hands-on" },
      read: null,
      topLine: false,
      ttDims,
    });
    // The cook's own lines, as its steps' pairs read them: a measure, a count, a line with no amount.
    const converted = legacyToPackRecipe(
      {
        name: "Test",
        ingredients: [
          { item: "duck fat", amount: "4", unit: "tbsp" },
          { item: "lemon", amount: "1" },
          { item: "flaky salt" },
        ],
        steps: ["Cook."],
        serves: 4,
      },
      { id: "test" },
    );
    if (!converted.ok) throw new Error(JSON.stringify(converted.issues));
    const lines = storedIngredientLines(converted.recipe, 3);
    const fat = lines[0];
    if (fat?.kind !== "amount") throw new Error("duck fat is not a measured line");

    const r = render(
      <Timetable
        ov={ov}
        rootRef={null}
        measureText={() => measure}
        strip={firstStrip}
        opening={true}
        live={false}
        readMark={null}
        onRead={() => {}}
        onGo={() => {}}
        onWhole={() => {}}
        onClose={() => {}}
        onMode={() => {}}
        getOut={sampleGetOut}
        scaleNote={null}
        readText={null}
        plan={entry.plan}
        state={initialCookState("first")}
        ingredients={lines}
        steps={entry.plan.tasks.map((t) => t.text)}
      />,
    );
    const getOut = r.container.querySelector<HTMLElement>("[data-get-out]")!;
    const scroller = getOut.querySelector<HTMLElement>("[data-get-out-scroll]")!;
    // The head and its toggle stand outside the scroller; every group is inside it.
    expect(scroller.className).toContain("overflow-y-auto");
    expect(scroller.contains(getOut.querySelector("[data-get-out-head]"))).toBe(false);
    expect(scroller.contains(getOut.querySelector("[data-show-amounts]"))).toBe(false);
    for (const group of getOut.querySelectorAll("[data-get-out-group]")) expect(scroller.contains(group)).toBe(true);
    expect(getOut.querySelectorAll("li[data-row]").length).toBe(3);

    // Amounts hidden: names alone, nothing to tap; each item but its group's last ends in its dot.
    expect(getOut.querySelector("li[data-row] button")).toBeNull();
    for (const group of getOut.querySelectorAll("[data-get-out-group]")) {
      const items = [...group.querySelectorAll<HTMLElement>("li[data-row]")];
      items.forEach((li, i) => {
        expect(li.querySelectorAll("[data-dot]").length, li.textContent ?? "").toBe(i < items.length - 1 ? 1 : 0);
        if (i < items.length - 1) expect(li.lastElementChild).toBe(li.querySelector("[data-dot]"));
      });
    }

    fireEvent.click(getOut.querySelector<HTMLButtonElement>("[data-show-amounts]")!);
    const row = (index: number) => getOut.querySelector<HTMLElement>(`li[data-ingredient-index="${String(index)}"]`)!;
    // The measure: its pair is the button, the dotted rule under the amount (AMOUNT_RULE).
    const pair = row(0).querySelector<HTMLButtonElement>("button")!;
    // Its dot is set inside the button, after the name (the button is one box: outside it, a pair
    // wider than the column strands the dot on a line of its own), hidden from the button's name
    // (`opening.spec.ts` reads the name in a browser).
    expect(pair.textContent!.replace(/\s/g, " ")).toBe("4 tbsp duck fat · ");
    expect(row(0).querySelectorAll("[data-dot]").length).toBe(1);
    expect(pair.querySelector("[data-dot]")!.getAttribute("aria-hidden")).toBe("true");
    expect(pair.lastElementChild).toBe(pair.querySelector("[data-dot]"));
    expect(pair.className).toContain(AMOUNT_RULE);
    expect(pair.querySelector("[data-amount][data-amount-words]")!.textContent).toBe("4 tbsp");
    // The count and the line with no amount: plain words, no button.
    expect(row(1).querySelector("button")).toBeNull();
    expect(row(1).querySelector("[data-amount]")!.textContent).toBe("1");
    expect(row(1).querySelector("[data-amount-words]")).toBeNull();
    expect(row(2).querySelector("button")).toBeNull();

    // Tapped, its conversions open in the opening's layer, outside the column that scrolls.
    fireEvent.click(pair);
    const panel = r.container.querySelector<HTMLElement>("[data-holds-keys]")!;
    expect(panel.parentElement).toBe(r.container.querySelector("[data-opening][data-popover-layer]"));
    expect(scroller.contains(panel)).toBe(false);
    const said = [...panel.querySelectorAll("[data-row]")].map((el) => [...el.children].map((c) => c.textContent).join(" "));
    expect(said).toEqual([...fat.stated, ...fat.conversions].map((m) => `${m.unit} ${m.value}`));
  });

  it("a stop read or put away measures the meal's lines again only when their room changed (review: React 1)", () => {
    const entry = timetableCorpus().find((x) => x.name === "sunday-roast-dinner")!;
    let state = initialCookState("first");
    for (let i = 0; i < prepPages(entry.plan, "first").length + 1; i++) state = next(entry.plan, state);
    const curStrip = strip(entry.plan, state, null, 0);
    const goStrip = strip(entry.plan, initialCookState("go"), null, 0);
    const tFirst = buildTimetable(entry.plan, curStrip, goStrip, "first")!;
    const tGo = buildTimetable(entry.plan, curStrip, goStrip, "go", { now: 0 })!;
    // The sheet lays its place out again on a read (a new object, the same room).
    const place = () =>
      placeOverview({
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
    let calls = 0;
    const counted = (t: string, size: number, weight: number) => {
      calls++;
      return measure(t, size, weight);
    };
    const measureText = () => counted;
    const props = {
      rootRef: null,
      measureText,
      strip: curStrip,
      opening: false,
      live: true,
      onRead: () => {},
      onGo: () => {},
      onWhole: () => {},
      onClose: () => {},
      getOut: sampleGetOut,
      scaleNote: null,
      plan: entry.plan,
      state,
    };
    const r = render(<Timetable {...props} ov={place()} readMark={null} readText={null} />);
    expect(calls).toBeGreaterThan(0);
    const laid = calls;
    const mark = r.container.querySelector<HTMLButtonElement>('button[data-card][data-card-state="ahead"]')!.dataset.card!;
    r.rerender(<Timetable {...props} ov={place()} readMark={mark} readText="Coat potatoes" />);
    r.rerender(<Timetable {...props} ov={place()} readMark={null} readText={null} />);
    expect(calls).toBe(laid);
  });

  it("draws the whole cook as the meal's lines: work done folded, the step in hand the one ember, and a stop tapped reads it (DS v1.63)", () => {
    const entry = timetableCorpus().find((x) => x.name === "sunday-roast-dinner")!;
    // On the roast's second cooking step: its four prep pages (DS v1.59) and its first step behind it.
    let state = initialCookState("first");
    for (let i = 0; i < prepPages(entry.plan, "first").length + 1; i++) state = next(entry.plan, state);
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
        measureText={() => measure}
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

    expect(r.container.querySelector("[data-phase-outline]")).toBeNull();
    const whole = r.container.querySelector<HTMLElement>("[data-whole-lines]")!;
    expect(whole).not.toBeNull();
    // Work done: one quiet dot per line, no words.
    expect(whole.querySelector('[data-line-stop][data-stop-state="done"]')).toBeNull();
    expect(whole.querySelectorAll("[data-line-done]").length).toBeGreaterThan(0);
    // The step in hand: one stop, ember.
    const now = [...whole.querySelectorAll<HTMLElement>('[data-line-stop][data-stop-state="now"]')];
    expect(now).toHaveLength(1);
    expect(now[0].className).toContain("ember-700");
    // Every stop still to come is a button, none over another's (48 px tall where the rows leave room,
    // the layout's tests say); a tap reads its step.
    const buttons = [...whole.querySelectorAll<HTMLButtonElement>("button[data-card]")];
    expect(buttons.length).toBeGreaterThan(5);
    const box = (b: HTMLElement) => ["left", "top", "width", "height"].map((k) => parseFloat(b.style.getPropertyValue(k)));
    for (const a of buttons)
      for (const b of buttons) {
        if (a === b) continue;
        const [ax, ay, aw, ah] = box(a);
        const [bx, by, bw, bh] = box(b);
        const over = Math.min(ax + aw, bx + bw) - Math.max(ax, bx) > 0.5 && Math.min(ay + ah, by + bh) - Math.max(ay, by) > 0.5;
        expect(over, `${a.getAttribute("aria-label")} over ${b.getAttribute("aria-label")}`).toBe(false);
      }
    const nowBtn = buttons.find((b) => b.dataset.cardState === "now")!;
    fireEvent.click(nowBtn);
    expect(onRead).toHaveBeenCalledWith(nowBtn.dataset.card);
  });
});


// Review round 1 of prep pages (2026-11-23). The portrait opening fits its stack a step at a
// time before paint (DS v1.52), each step a nested update, and React allows 50 of those before it
// throws. One step a commit, the roast's fit took 24, and the sheet laying the place again while
// it ran (the fonts arriving, a prep page under the opening settling) started it over: the page
// went down (32d028f0 stopped only the restarts that said the same place).
describe("Timetable: the portrait opening's fit is short, and cannot run React out of updates", () => {
  const portrait = { W: 800, H: 1280, c: 1, E: 35, top: 64, stepTop: 84, footTop: 1200, ledgeTop: 1178, portrait: true };
  const ttDims = [
    { w: 120, h: 64 },
    { w: 110, h: 58 },
    { w: 100, h: 52 },
    { w: 96, h: 48 },
  ];
  const getOut = [
    { index: 0, amount: "1.8 kg", name: "whole chicken" },
    { index: 1, amount: "1 kg", name: "Maris Piper potatoes" },
  ];
  const entry = timetableCorpus().find((x) => x.name === "sunday-roast-dinner")!;
  const firstStrip = strip(entry.plan, initialCookState("first"), null, 0);
  const goStrip = strip(entry.plan, initialCookState("go"), null, 0);
  const tFirst = buildTimetable(entry.plan, firstStrip, goStrip, "first")!;
  const tGo = buildTimetable(entry.plan, firstStrip, goStrip, "go")!;
  const place = (scaleNote: string | null) =>
    placeOverview({
      timetable: tFirst,
      other: tGo,
      geo: portrait,
      measure,
      chrome: { more: { w: 48, h: 48 }, controls: { w: 160, h: 56 }, hint: false },
      toggle: true,
      title: entry.name,
      opening: { getOut, scaleNote, handsOn: "45 min hands-on" },
      read: null,
      topLine: false,
      ttDims,
    });

  /** The opening as the sheet draws it; `relay` hands back a way to lay the place again with a new note. */
  function Opening({ relay }: { relay?: (again: (note: string) => void) => void }) {
    const [note, setNote] = useState<string | null>(null);
    relay?.(setNote);
    const ov = useMemo(() => place(note), [note]);
    return (
      <Timetable
        ov={ov}
        rootRef={null}
        measureText={() => measure}
        strip={firstStrip}
        opening={true}
        live={false}
        readMark={null}
        onRead={() => {}}
        onGo={() => {}}
        onWhole={() => {}}
        onClose={() => {}}
        onMode={() => {}}
        getOut={getOut}
        scaleNote={note}
        readText={null}
        plan={entry.plan}
        state={initialCookState("first")}
        steps={entry.plan.tasks.map((t) => t.text)}
        onAskAhead={() => {}}
      />
    );
  }

  const body = () => document.querySelector<HTMLElement>("[data-opening-body]")!;
  const stepNow = () => Number(body().dataset.stackStep);
  /**
   * The roast's fit has 2 steps past step 0 since the flow became the meal's lines (DS v1.63), which
   * have no optional lines to give way: tight, then Get out's heads run in; past that the stack scrolls.
   */
  const LAST = 2;
  /**
   * Layout as the fit reads it: the body 100 px tall, the flow's foot past it while `over` says so.
   * `seen` counts the fit's measurements (one a commit).
   */
  function layout(over: (step: number, measured: number) => boolean) {
    const seen = { n: 0 };
    vi.spyOn(HTMLElement.prototype, "getBoundingClientRect").mockImplementation(function (this: HTMLElement) {
      const rect = (height: number) => ({ x: 0, y: 0, top: 0, left: 0, right: 0, width: 0, height, bottom: height, toJSON: () => ({}) });
      if (this.hasAttribute("data-opening-body")) return rect(100);
      if (this.hasAttribute("data-opening-flow")) {
        seen.n++;
        return rect(over(Number(body().dataset.stackStep), seen.n) ? 1000 : 50);
      }
      return rect(0);
    });
    return seen;
  }
  afterEach(() => {
    vi.restoreAllMocks();
  });

  it("stacks in portrait, and a stack that fits as it stands is measured once", () => {
    const seen = layout(() => false);
    render(<Opening />);
    expect(body().dataset.stackStep).toBe("0");
    expect(seen.n).toBe(1);
  });

  it("settles on the first step that fits, whichever it is, and scrolls only when none does", () => {
    for (let first = 0; first <= LAST + 1; first++) {
      const seen = layout((step) => step < first);
      render(<Opening />);
      const where = `first fit at step ${String(first)}`;
      expect(stepNow(), where).toBe(Math.min(first, LAST));
      expect(body().className.split(/\s+/).includes("overflow-y-auto"), where).toBe(first > LAST);
      // Never a step a render: the roast's longest fit is well under half of React's 50.
      expect(seen.n, where).toBeLessThanOrEqual(14);
      cleanup();
      vi.restoreAllMocks();
    }
  });

  it("the place laid again and again while the fit runs never takes the page down", async () => {
    let again: (note: string) => void = () => {};
    // A stack that never fits, and the sheet laying a new place on every tenth measurement.
    layout((_step, measured) => {
      if (measured % 10 === 0 && measured <= 60) again(`for ${String(measured)}`);
      return true;
    });
    expect(() => render(<Opening relay={(set) => (again = set)} />)).not.toThrow();
    // What it could not finish before paint it finishes on the frames after.
    for (let i = 0; i < 20 && !body().className.includes("overflow-y-auto"); i++) {
      await act(async () => {
        await new Promise((resolve) => requestAnimationFrame(() => resolve(null)));
      });
    }
    expect(stepNow()).toBe(LAST);
    expect(body().className.split(/\s+/)).toContain("overflow-y-auto");
  });

  /** One frame drawn: every frame asked for so far has come. */
  const frame = () =>
    act(async () => {
      await new Promise((resolve) => requestAnimationFrame(() => resolve(null)));
    });

  // Review round 2 of prep pages. Development runs the app under StrictMode, which rehearses an
  // unmount on every mount: the rehearsal cancelled the frame that starts the cap's count over and
  // nothing asked for another, so the count only grew, and from its 33rd step on every fit ran a
  // step a frame, an unfitted opening on the screen meanwhile.
  it("under StrictMode the cap's count still starts over with each frame: fit after fit runs whole before a paint", async () => {
    let again: (note: string) => void = () => {};
    const seen = layout(() => true);
    render(
      <StrictMode>
        <Opening relay={(set) => (again = set)} />
      </StrictMode>,
    );
    expect(stepNow()).toBe(LAST);
    await frame();
    // Fifteen more fits of a stack that never fits, a frame between them: well past the cap's 32 steps in all.
    for (let i = 1; i <= 15; i++) {
      act(() => again(`for ${String(i)}`));
      const where = `fit ${String(i + 1)}, ${String(seen.n)} steps in all`;
      expect(stepNow(), where).toBe(LAST);
      expect(body().className.split(/\s+/), where).toContain("overflow-y-auto");
      await frame();
    }
    expect(seen.n).toBeGreaterThan(40);
  });

  it("a step that waited for a frame is dropped once the fit has moved on: it never starts the newer fit over", async () => {
    let again: (note: string) => void = () => {};
    /** The step measured, in order, and how many had been when the last place was laid. */
    const steps: number[] = [];
    let last = -1;
    layout((step, measured) => {
      steps.push(step);
      // New places mid-fit, each as the fit reaches its middle step, run it past its cap: its 33rd step waits for a frame.
      if (step === 1 && measured <= 31) again(`for ${String(measured)}`);
      // And a place laid, and drawn at once, after the frame that starts the count over and before
      // the frame that step waits on (asked for here, between the two).
      if (measured === 2) {
        requestAnimationFrame(() => {
          last = steps.length;
          flushSync(() => again("the last"));
        });
      }
      return true;
    });
    render(<Opening relay={(set) => (again = set)} />);
    // The fit ran past its cap and stopped short, a step waiting.
    expect(steps).toHaveLength(33);
    expect(body().className.split(/\s+/)).not.toContain("overflow-y-auto");
    for (let i = 0; i < 5; i++) await frame();
    expect(last).toBe(33);
    expect(stepNow()).toBe(LAST);
    expect(body().className.split(/\s+/)).toContain("overflow-y-auto");
    // The last place's fit ran once from step 0, not twice.
    const after = steps.slice(last);
    expect(after.filter((step) => step === 0), after.join(" ")).toHaveLength(1);
  });
});

import { StrictMode, useMemo, useState } from "react";
import { flushSync } from "react-dom";
import { act } from "@testing-library/react";
