// @vitest-environment happy-dom
import { TRPCClientError } from "@trpc/client";
import { act, cleanup, fireEvent, render, screen, within } from "@testing-library/react";
import { StrictMode } from "react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { CookReport } from "@/lib/kitchen/report-capture";
import { createReportOutbox, type ReportOutbox, type StringStore } from "@/lib/kitchen/report-outbox";
import { BACK_TO_KITCHEN } from "./BorrowedScreen";
import { CLEAR_ARM_MS, FlaggedEntry, REPORTS_COPY, ReportsPanel, dayOf, endRoom, footClip, keepClear, restAt, whereOf } from "./ReportsPanel";
import { NOTE_MAX_BYTES, type FlagStep } from "@/lib/kitchen/report-capture";
import { createMissLog } from "@/lib/kitchen/flag-misses";

// Review on the hub (B2 decision 10; ported from
// player/tests/ReportsPanel.test.tsx without its share cases: the DB took
// sharing's place). A quiet count while this tablet holds reports or missed
// one, a list to note them in (panel round 4: the unsent quoted with their
// notes in the margin, the sent a line each), a line on a row the DB doesn't
// hold yet, and a clear that wants a second tap and takes only what the DB
// holds.

// The list's fade watches for the fonts landing; happy-dom has no FontFaceSet.
Object.defineProperty(document, "fonts", { value: new EventTarget(), configurable: true });

function memoryStore(): StringStore {
  const map = new Map<string, string>();
  return {
    getItem: (key) => map.get(key) ?? null,
    setItem: (key, value) => map.set(key, value),
    removeItem: (key) => map.delete(key),
  };
}

type Answer = "ok" | "offline" | "refused" | "silent";

function answer(how: Answer): Promise<unknown> {
  if (how === "ok") return Promise.resolve();
  if (how === "silent") return new Promise(() => {});
  if (how === "offline") return Promise.reject(new TypeError("Failed to fetch"));
  return Promise.reject(
    TRPCClientError.from({
      error: { code: -32600, message: "BAD_REQUEST", data: { code: "BAD_REQUEST", httpStatus: 400 } },
    }),
  );
}

let outbox: ReportOutbox;
let submits: Record<string, Answer>;
let annotating: Answer;
let annotates: { id: string; note: string }[];

function report(id: string, capturedAt: string, over: Partial<CookReport> = {}): CookReport {
  return {
    id,
    capturedAt,
    build: "b-1",
    path: "/kitchen/queue/q1",
    screen: "step",
    queueId: null,
    recipeName: "Mole",
    stepKey: "s1",
    chapterId: null,
    planVersion: 4,
    plan: null,
    state: { mode: "go", pos: 1, ticked: [], passed: [], kept: [] },
    context: {
      viewport: { w: 1280, h: 800, dpr: 2 },
      ua: "test-agent",
      online: true,
      voice: { mode: null, status: "unsupported" },
      ask: { sessionId: "cook-queue-1", open: false },
      layers: { pane: false, card: null, more: false },
      part: null,
    },
    events: [],
    dom: "<div></div>",
    domTruncated: false,
    note: "",
    ...over,
  };
}

/** The step each report was flagged on, by id; a report not here has none stored. */
let stepOf: Record<string, FlagStep | null> = {};

/** Flags each report in turn and lets the server's answer to it land. */
async function flag(...reports: CookReport[]) {
  for (const r of reports) {
    await outbox.add(r, stepOf[r.id]);
    if (submits[r.id] !== "silent") await outbox.flush();
  }
}

function panel(onClose = vi.fn()) {
  render(<ReportsPanel outbox={() => outbox} onClose={onClose} />);
  return onClose;
}

const rows = () => screen.getAllByRole("listitem");
const notes = () => screen.getAllByPlaceholderText(REPORTS_COPY.placeholder) as HTMLTextAreaElement[];

beforeEach(() => {
  stepOf = {};
  submits = {};
  annotating = "ok";
  annotates = [];
  outbox = createReportOutbox(memoryStore(), {
    submit: (r) => answer(submits[r.id] ?? "ok"),
    annotate: (id, note) => {
      annotates.push({ id, note });
      return answer(annotating);
    },
  });
});

afterEach(() => {
  cleanup();
  vi.useRealTimers();
});

/** A row's part, by its data attribute, as text. */
const part = (row: Element | undefined, name: string) =>
  row?.querySelector(`[data-report-${name}]`)?.textContent ?? null;


/** Opens a sent row to its note, by tapping its line. */
const openRow = (i: number) => fireEvent.click(within(rows()[i]!).getByRole("button"));

describe("ReportsPanel", () => {
  it("quotes the line the cook was reading on a flag still to send, who and when above it (panel round 4)", async () => {
    submits = { sear: "offline" };
    stepOf = {
      sear: { n: 2, of: 6, name: "Sear the chicken", line: "Sear the chicken skin-side down until it lifts clean, 6 minutes." },
      fry: { n: 3, of: 9, name: "Fry parathas", line: "Meanwhile, fry the parathas in a dry skillet until crisp." },
    };
    await flag(
      report("sear", "2026-10-04T18:10:00.000Z"),
      report("fry", "2026-10-04T18:30:00.000Z", { recipeName: "Roast chicken" }),
    );
    panel();
    expect(screen.getByRole("heading", { name: REPORTS_COPY.kind })).toBeTruthy();
    // Still to send, they lead with no cook heads: the recipe rides in the meta.
    expect(document.querySelector("[data-report-head]")).toBeNull();
    const [fry, sear] = rows();
    expect(part(fry, "subject")).toBe("Meanwhile, fry the parathas in a dry skillet until crisp.");
    expect(part(sear, "subject")).toBe("Sear the chicken skin-side down until it lifts clean, 6 minutes.");
    expect(part(fry, "meta")).toMatch(/^Roast chicken · Step 3 of 9 · .*\d{1,2}:\d{2}.* · Waiting to send$/);
    expect(part(sear, "meta")).toMatch(/^Mole · Step 2 of 6 · /);
    // The note's field sits in the row's margin, open, its question showing.
    const margin = fry!.querySelector("[data-report-margin]") as HTMLElement;
    const field = within(margin).getByRole("textbox");
    expect(field.className).toContain("placeholder:text-ink-soft");
    expect(field.className).not.toContain("placeholder:text-transparent");
  });

  it("opens the meta on where when a flag has no recipe name, with no stray dot before it", async () => {
    submits = { a: "offline", b: "offline" };
    stepOf = { a: { n: 2, of: 6, name: "Sear the chicken" }, b: null };
    await flag(
      report("a", "2026-10-04T18:10:00.000Z", { recipeName: "" }),
      report("b", "2026-10-04T18:11:00.000Z", { recipeName: "  ", screen: "prep" }),
    );
    panel();
    const [prep, step] = rows();
    expect(part(step, "meta")).toMatch(/^Step 2 of 6 · .*\d{1,2}:\d{2}.* · Waiting to send$/);
    // Its moment alone, then the status: the day, if any, and the time.
    expect(part(prep, "meta")).toMatch(/^[^·\s][^·]*\d{1,2}:\d{2}[^·]* · Waiting to send$/);
    // Its field's name opens on where, too.
    expect(within(step!).getByRole("textbox").getAttribute("aria-label")).toMatch(/^Note for Step 2 of 6: Sear the chicken, /);
  });

  it("quotes the step's name for a flag kept before the line was, and names Prep and a borrowed screen", async () => {
    submits = { prep: "offline" };
    stepOf = { prep: null, a: { n: 2, of: 5, name: "Sauté the onion" }, b: null };
    await flag(
      report("prep", "2026-10-04T18:00:00.000Z", { screen: "prep" }),
      report("a", "2026-10-04T18:01:00.000Z", { screen: "ingredients" }),
      report("b", "2026-10-04T18:02:00.000Z", { screen: "whole-cook" }),
      report("c", "2026-10-04T18:03:00.000Z"),
    );
    stepOf = {};
    panel();
    const [c, b, a, prep] = rows();
    // Stored with no step at all, a flag names its screen.
    expect(part(c, "subject")).toBe("Step");
    expect([part(b, "subject"), part(b, "meta")?.split(" · ")[1]]).toEqual(["Whole recipe", "Prep"]);
    expect([part(a, "subject"), part(a, "meta")?.split(" · ")[1]]).toEqual(["Ingredients", "Step 2 of 5"]);
    expect(part(prep, "subject")).toBe("Prep");
    expect(part(prep, "meta")?.split(" · ")).toHaveLength(3);
  });

  it("sets the sent under one head per cook, one line each: the line and its time, nothing more", async () => {
    stepOf = {
      sear: { n: 2, of: 6, name: "Sear the chicken" },
      fry: { n: 3, of: 9, name: "Fry parathas", line: "Fry the parathas until crisp." },
    };
    await flag(
      report("sear", "2026-10-04T18:10:00.000Z"),
      report("fry", "2026-10-04T18:30:00.000Z", { recipeName: "Roast chicken" }),
    );
    panel();
    // The recipe once per cook, in the display face, the day beside it.
    const heads = [...document.querySelectorAll("[data-report-head]")];
    expect(heads.map((h) => h.textContent)).toEqual(["Roast chicken", "Mole"]);
    expect(heads.every((h) => h.tagName === "H3")).toBe(true);
    expect(screen.getAllByText("Mole")).toHaveLength(1);
    expect(screen.getAllByText(dayOf("2026-10-04T18:00:00.000Z"))).toHaveLength(2);
    const [fry, sear] = rows();
    expect(part(fry, "subject")).toBe("Fry the parathas until crisp.");
    expect(part(sear, "subject")).toBe("Sear the chicken");
    expect(part(fry, "time")).toMatch(/^\d{1,2}:\d{2}/);
    // No status, no place, no field: the line is the row's one control.
    expect(fry!.querySelector("[data-report-status], [data-report-meta]")).toBeNull();
    expect(within(fry!).queryByRole("textbox")).toBeNull();
    expect(within(fry!).getByRole("button").getAttribute("aria-expanded")).toBe("false");
  });

  it("opens a sent row to its note on a tap, the keyboard in it, and closes it from the line", async () => {
    await flag(report("a", "2026-10-04T18:00:00.000Z"), report("b", "2026-10-04T18:01:00.000Z"));
    panel();
    openRow(1);
    expect(within(rows()[1]!).getByRole("button").getAttribute("aria-expanded")).toBe("true");
    expect(document.activeElement).toBe(notes()[0]);
    expect(within(rows()[0]!).queryByRole("textbox")).toBeNull();
    fireEvent.change(notes()[0]!, { target: { value: "the chip wraps" } });
    fireEvent.blur(notes()[0]!);
    // One open at a time: opening another closes the first.
    openRow(0);
    expect(within(rows()[1]!).queryByRole("textbox")).toBeNull();
    expect(within(rows()[0]!).getByRole("textbox")).toBeTruthy();
    // Closed, a row shows its note on its line.
    expect(part(rows()[1], "note")).toBe("the chip wraps");
    openRow(0);
    expect(screen.queryByRole("textbox")).toBeNull();
    expect(part(rows()[0], "note")).toBeNull();
  });

  it("says the day of each cook: today, yesterday, else the date", () => {
    const now = new Date(2026, 9, 4, 20, 0);
    expect(dayOf(new Date(2026, 9, 4, 0, 5).toISOString(), now)).toBe(REPORTS_COPY.today);
    expect(dayOf(new Date(2026, 9, 3, 23, 55).toISOString(), now)).toBe(REPORTS_COPY.yesterday);
    expect(dayOf(new Date(2026, 9, 1, 12, 0).toISOString(), now)).not.toMatch(/Today|Yesterday/);
  });

  it("splits a cook's flags by day, as two cooks", async () => {
    await flag(report("a", "2026-10-01T18:00:00.000Z"), report("b", "2026-10-04T18:00:00.000Z"));
    panel();
    expect([...document.querySelectorAll("[data-report-head]")].map((h) => h.textContent)).toEqual([
      "Mole",
      "Mole",
    ]);
  });

  it("sets what is still to send above a rule, the sent below it (fix round 2, item 2)", async () => {
    submits = { waits: "offline", wrong: "refused" };
    await flag(
      report("sent1", "2026-10-04T18:00:00.000Z"),
      report("sent2", "2026-10-04T18:01:00.000Z"),
      report("wrong", "2026-10-04T18:02:00.000Z"),
      // Last, as a send that can't reach the server holds the ones after it.
      report("waits", "2026-10-04T18:03:00.000Z"),
    );
    panel();
    const rule = document.querySelector("[data-report-rule]")!;
    expect(rule.textContent).toContain(REPORTS_COPY.sentCount(2));
    expect(within(rule as HTMLElement).getByRole("button", { name: REPORTS_COPY.clear(2) })).toBeTruthy();
    // The rule is solid to the list's fades, Clear and all (panel round 4).
    expect(rule.hasAttribute("data-report-solid")).toBe(true);
    const before = (row: Element) => !!(row.compareDocumentPosition(rule) & Node.DOCUMENT_POSITION_FOLLOWING);
    const [waits, wrong, sent2, sent1] = rows();
    expect([waits, wrong, sent2, sent1].map((row) => before(row!))).toEqual([true, true, false, false]);
    expect([waits, wrong, sent2, sent1].map((row) => part(row, "status"))).toEqual([
      REPORTS_COPY.waiting,
      REPORTS_COPY.refused,
      null,
      null,
    ]);
  });

  it("draws no rule and no Clear while nothing is sent", async () => {
    submits = { a: "offline" };
    await flag(report("a", "2026-10-04T18:00:00.000Z"));
    panel();
    expect(document.querySelector("[data-report-rule]")).toBeNull();
    expect(screen.queryByRole("button", { name: /^Clear/ })).toBeNull();
  });

  it("says its hint once, above the list", async () => {
    await flag(report("a", "2026-10-04T18:00:00.000Z"));
    panel();
    expect(screen.getAllByText(REPORTS_COPY.hint)).toHaveLength(1);
  });

  it("says a refused flag in ink, not ember, with no note to type and a way to let it go", async () => {
    submits = { wrong: "refused" };
    await flag(report("kept", "2026-10-04T18:00:00.000Z"), report("wrong", "2026-10-04T18:01:00.000Z"));
    panel();
    const [wrong] = rows();
    const status = wrong!.querySelector("[data-report-status]")!;
    expect(status.className).toContain("text-ink");
    expect(status.className).toContain("font-semibold");
    expect(wrong!.innerHTML).not.toContain("ember");
    expect(within(wrong!).queryByRole("textbox")).toBeNull();
    expect(within(wrong!).getByText(REPORTS_COPY.refusedNext)).toBeTruthy();
    fireEvent.click(within(wrong!).getByRole("button", { name: REPORTS_COPY.dismiss }));
    expect(outbox.list().map((e) => e.id)).toEqual(["kept"]);
    expect(rows()).toHaveLength(1);
  });

  it("sets Clear at rest and Dismiss as one ghost form, a hand's height, sand only pressed (V11, B2 review gap 7)", async () => {
    submits = { wrong: "refused" };
    await flag(report("kept", "2026-10-04T18:00:00.000Z"), report("wrong", "2026-10-04T18:01:00.000Z"));
    panel();
    const clear = screen.getByRole("button", { name: REPORTS_COPY.clear(1) });
    const dismiss = screen.getByRole("button", { name: REPORTS_COPY.dismiss });
    for (const ghost of [clear, dismiss]) {
      const classes = ghost.className.split(/\s+/);
      // No fill at rest: a fill is only ever a pressed state.
      expect(classes.filter((c) => c.startsWith("bg-"))).toEqual([]);
      expect(classes).toContain("active:bg-sand");
      expect(classes).toContain("min-h-16");
      expect(classes).toContain("text-[22px]");
      expect(classes).toContain("text-ink");
    }
    // Armed, it is still the panel's one fill: ember, paper words.
    fireEvent.click(clear);
    const armed = screen.getByRole("button", { name: REPORTS_COPY.clearArmed(1) });
    expect(armed.className.split(/\s+/)).toContain("bg-ember");
  });

  it("names a borrowed screen over the step or Prep under it", () => {
    const step = { n: 2, of: 5, name: "Sauté the onion" };
    expect(whereOf({ screen: "ingredients", step })).toBe("Ingredients, from step 2 of 5: Sauté the onion");
    expect(whereOf({ screen: "whole-cook", step: null })).toBe("Whole recipe, from prep");
    expect(whereOf({ screen: "step", step })).toBe("Step 2 of 5: Sauté the onion");
    expect(whereOf({ screen: "prep", step: null })).toBe("Prep");
  });

  it("names each screen as the cook knows it, for a flag stored with no step", async () => {
    const screens = ["prep", "step", "all-steps", "ingredients", "info", "whole-cook"] as const;
    await flag(
      ...screens.map((s, i) => report(s, `2026-10-04T18:0${String(i)}:00.000Z`, { screen: s })),
    );
    panel();
    const subjects = rows().map((row) => part(row, "subject"));
    expect(subjects).toEqual(["Whole recipe", "Recipe info", "Ingredients", "All steps", "Step", "Prep"]);
  });

  it("gives two flags in the same minute distinct accessible names, seconds unseen", async () => {
    submits = { first: "offline" };
    await flag(report("first", "2026-10-04T18:00:05.000Z"), report("second", "2026-10-04T18:00:41.000Z"));
    panel();
    const [a, b] = notes();
    expect(a?.getAttribute("aria-label")).not.toBe(b?.getAttribute("aria-label"));
    expect(part(rows()[0], "meta")).not.toMatch(/\d+:\d+:\d+/);
  });

  it("saves a note typed and blurred to the outbox, and sends it", async () => {
    await flag(report("a", "2026-10-04T18:00:00.000Z"));
    panel();
    openRow(0);
    fireEvent.change(notes()[0]!, { target: { value: "the timer chip reads like an ingredient" } });
    expect(outbox.list()[0]?.note).toBe("");
    await act(async () => {
      fireEvent.blur(notes()[0]!);
      await outbox.flush();
    });
    expect(outbox.list()[0]?.note).toBe("the timer chip reads like an ingredient");
    expect(annotates).toEqual([{ id: "a", note: "the timer chip reads like an ingredient" }]);
  });

  it("says Saved under a note once the outbox holds it, until it is typed in again (C6)", async () => {
    submits = { a: "offline" };
    await flag(report("a", "2026-10-04T18:00:00.000Z"), report("b", "2026-10-04T18:01:00.000Z"));
    panel();
    const saved = () => rows().map((row) => row.querySelector("[data-report-saved]")?.textContent ?? null);
    expect(saved()).toEqual([null, null]);
    fireEvent.change(notes()[1]!, { target: { value: "the chip wraps" } });
    fireEvent.blur(notes()[1]!);
    expect(saved()).toEqual([null, REPORTS_COPY.saved]);
    // Focus leaving a field with nothing new saves nothing, and says nothing.
    fireEvent.blur(notes()[0]!);
    expect(saved()).toEqual([null, REPORTS_COPY.saved]);
    fireEvent.change(notes()[1]!, { target: { value: "the chip wraps twice" } });
    expect(saved()).toEqual([null, null]);
  });

  it("shows a note already saved", async () => {
    submits = { a: "offline" };
    await flag(report("a", "2026-10-04T18:00:00.000Z"));
    outbox.annotate("a", "saved before the reload");
    panel();
    expect(notes()[0]?.value).toBe("saved before the reload");
  });

  it("saves a note cleared back to empty", async () => {
    submits = { a: "offline" };
    await flag(report("a", "2026-10-04T18:00:00.000Z"));
    outbox.annotate("a", "stale note");
    panel();
    fireEvent.change(notes()[0]!, { target: { value: "" } });
    // `??`, not `||`: an empty draft is the cook's, not a reason to show the old note.
    expect(notes()[0]?.value).toBe("");
    fireEvent.blur(notes()[0]!);
    expect(outbox.list()[0]?.note).toBe("");
  });

  it("says when a row is not in the DB yet, and why (F1, F6)", async () => {
    submits = { waits: "offline", wrong: "refused" };
    await flag(
      report("sent", "2026-10-04T18:00:00.000Z"),
      report("wrong", "2026-10-04T18:01:00.000Z"),
      report("waits", "2026-10-04T18:02:00.000Z"),
    );
    panel();
    const [waits, wrong, sent] = rows();
    expect(within(waits!).queryByText(REPORTS_COPY.waiting)).not.toBeNull();
    expect(within(wrong!).queryByText(REPORTS_COPY.refused)).not.toBeNull();
    expect(within(sent!).queryByText(REPORTS_COPY.waiting)).toBeNull();
    expect(within(sent!).queryByText(REPORTS_COPY.refused)).toBeNull();
  });

  it("follows the outbox: a row waiting to send goes under the rule once sent", async () => {
    submits = { a: "offline" };
    await flag(report("a", "2026-10-04T18:00:00.000Z"));
    panel();
    expect(screen.queryByText(REPORTS_COPY.waiting)).not.toBeNull();
    submits = {};
    await act(() => outbox.flush());
    expect(screen.queryByText(REPORTS_COPY.waiting)).toBeNull();
    expect(rows()[0]?.hasAttribute("data-report-sent")).toBe(true);
  });

  it("clears on a second tap only what the DB holds, and stays open on what's left", async () => {
    submits = { waits: "offline" };
    annotating = "silent";
    await flag(
      report("sent", "2026-10-04T18:00:00.000Z"),
      report("noted", "2026-10-04T18:01:00.000Z"),
      report("waits", "2026-10-04T18:02:00.000Z"),
    );
    // Sent, with a note the DB doesn't hold yet.
    outbox.annotate("noted", "the pane covered the step");
    const onClose = panel();
    fireEvent.click(screen.getByRole("button", { name: REPORTS_COPY.clear(1) }));
    expect(outbox.list()).toHaveLength(3);
    // Armed, it says what it takes in ember, and the row it takes steps back (C5).
    const armed = screen.getByRole("button", { name: REPORTS_COPY.clearArmed(1) });
    expect(armed.className).toContain("bg-ember");
    expect(armed.className).not.toContain("bg-sand");
    expect(rows().map((row) => row.hasAttribute("data-clears"))).toEqual([false, false, true]);
    fireEvent.click(screen.getByRole("button", { name: REPORTS_COPY.clearArmed(1) }));
    expect(outbox.list().map((e) => e.id)).toEqual(["waits", "noted"]);
    expect(rows()).toHaveLength(2);
    expect(rows().some((row) => row.hasAttribute("data-clears"))).toBe(false);
    expect(onClose).not.toHaveBeenCalled();
  });

  it("closes once a clear leaves nothing", async () => {
    await flag(report("a", "2026-10-04T18:00:00.000Z"), report("b", "2026-10-04T18:01:00.000Z"));
    const onClose = panel();
    fireEvent.click(screen.getByRole("button", { name: /^Clear/ }));
    fireEvent.click(screen.getByRole("button", { name: REPORTS_COPY.clearArmed(2) }));
    expect(outbox.list()).toHaveLength(0);
    expect(onClose).toHaveBeenCalledOnce();
  });

  it("saves a note still mid-edit before clearing, so its row stays", async () => {
    annotating = "silent";
    await flag(report("a", "2026-10-04T18:00:00.000Z"), report("b", "2026-10-04T18:01:00.000Z"));
    panel();
    openRow(0);
    fireEvent.change(notes()[0]!, { target: { value: "no way back to the step" } });
    fireEvent.click(screen.getByRole("button", { name: /^Clear/ }));
    fireEvent.click(screen.getByRole("button", { name: REPORTS_COPY.clearArmed(1) }));
    expect(outbox.list().map((e) => [e.id, e.note])).toEqual([["b", "no way back to the step"]]);
  });

  it("offers no clear while nothing is the DB's whole", async () => {
    annotating = "silent";
    await flag(report("a", "2026-10-04T18:00:00.000Z"));
    // Sent, with a note the DB doesn't hold yet.
    outbox.annotate("a", "the chip wraps");
    panel();
    const clear = screen.getByRole("button", { name: REPORTS_COPY.clear(0) }) as HTMLButtonElement;
    expect(clear.disabled).toBe(true);
    expect(clear.className).not.toContain("ember");
  });

  it("steps an armed row back to ink-soft, its note and its cook's head with it, never by opacity or a fill", async () => {
    await flag(
      report("a", "2026-10-04T18:00:00.000Z"),
      report("b", "2026-10-04T18:01:00.000Z", { recipeName: "Dal" }),
    );
    outbox.annotate("a", "the pane covered it");
    await outbox.flush();
    // Dal's note waits for the DB, so Clear can't take it.
    annotating = "silent";
    outbox.annotate("b", "the chip wraps");
    panel();
    const [dal, mole] = rows();
    expect(outbox.list().find((e) => e.id === "a")?.sentNote).toBe("the pane covered it");
    fireEvent.click(screen.getByRole("button", { name: REPORTS_COPY.clear(1) }));
    expect([dal, mole].map((row) => row!.hasAttribute("data-clears"))).toEqual([false, true]);
    for (const name of ["subject", "note"]) {
      expect(mole!.querySelector(`[data-report-${name}]`)!.className).toContain("text-ink-soft");
      expect(dal!.querySelector(`[data-report-${name}]`)!.className).not.toContain("text-ink-soft");
    }
    expect(mole!.className).not.toMatch(/opacity|bg-/);
    const heads = [...document.querySelectorAll("[data-report-head]")];
    expect(heads.map((h) => [h.textContent, h.className.includes("text-ink-soft")])).toEqual([
      ["Dal", false],
      ["Mole", true],
    ]);
  });

  // The armed Clear takes what it marked, and only that (fix round 2, LOW-3).
  it("keeps an armed clear to the rows it marked: a row sent since stays", async () => {
    submits = { later: "offline" };
    await flag(report("now", "2026-10-04T18:00:00.000Z"), report("later", "2026-10-04T18:01:00.000Z"));
    panel();
    fireEvent.click(screen.getByRole("button", { name: REPORTS_COPY.clear(1) }));
    submits = {};
    await act(() => outbox.flush());
    expect(outbox.list().every((e) => e.status === "sent")).toBe(true);
    // Still armed for the one it marked, and the row sent since isn't marked.
    expect(screen.queryByRole("button", { name: REPORTS_COPY.clearArmed(1) })).not.toBeNull();
    // Newest first: "later", sent since, then "now", the one marked.
    expect(rows().map((row) => row.hasAttribute("data-clears"))).toEqual([false, true]);
    fireEvent.click(screen.getByRole("button", { name: REPORTS_COPY.clearArmed(1) }));
    expect(outbox.list().map((e) => e.id)).toEqual(["later"]);
  });

  // Typed in, a marked row leaves the set for good (fix round 3, M2).
  it("keeps a marked row typed in out of the clear, once its note is sent too", async () => {
    await flag(report("a", "2026-10-04T18:00:00.000Z"), report("b", "2026-10-04T18:01:00.000Z"));
    panel();
    fireEvent.click(screen.getByRole("button", { name: REPORTS_COPY.clear(2) }));
    // Newest first: "b", then "a".
    openRow(0);
    fireEvent.change(notes()[0]!, { target: { value: "the chip wraps" } });
    expect(screen.queryByRole("button", { name: REPORTS_COPY.clearArmed(1) })).not.toBeNull();
    fireEvent.blur(notes()[0]!);
    await act(() => outbox.flush());
    expect(outbox.list().find((e) => e.id === "b")).toMatchObject({ note: "the chip wraps", sentNote: "the chip wraps" });
    expect(screen.queryByRole("button", { name: REPORTS_COPY.clearArmed(1) })).not.toBeNull();
    expect(rows().map((row) => row.hasAttribute("data-clears"))).toEqual([false, true]);
    fireEvent.click(screen.getByRole("button", { name: REPORTS_COPY.clearArmed(1) }));
    expect(outbox.list().map((e) => e.id)).toEqual(["b"]);
  });

  it("disarms rather than show an armed clear of nothing", async () => {
    annotating = "silent";
    await flag(report("a", "2026-10-04T18:00:00.000Z"));
    panel();
    fireEvent.click(screen.getByRole("button", { name: REPORTS_COPY.clear(1) }));
    expect(screen.queryByRole("button", { name: REPORTS_COPY.clearArmed(1) })).not.toBeNull();
    // Typing in the one marked row unmarks it: nothing is left to take.
    openRow(0);
    fireEvent.change(notes()[0]!, { target: { value: "the chip wraps" } });
    expect(screen.queryByRole("button", { name: /^Tap again/ })).toBeNull();
    expect(rows()[0]?.hasAttribute("data-clears")).toBe(false);
    fireEvent.click(screen.getByRole("button", { name: /^Clear/ }));
    expect(screen.queryByRole("button", { name: /^Tap again/ })).toBeNull();
    expect(outbox.list()).toHaveLength(1);
  });

  // Saved says what is stored (fix round 2, LOW-2): past the room a note has,
  // the field takes no more, and says so where Saved would.
  it("takes no more than a note can keep, says so, and saves what it shows", async () => {
    await flag(report("a", "2026-10-04T18:00:00.000Z"));
    panel();
    openRow(0);
    const long = "a".repeat(NOTE_MAX_BYTES + 1_107);
    fireEvent.change(notes()[0]!, { target: { value: long } });
    expect(notes()[0]?.value).toHaveLength(NOTE_MAX_BYTES);
    expect(part(rows()[0], "full")).toBe(REPORTS_COPY.full);
    fireEvent.blur(notes()[0]!);
    expect(outbox.list()[0]?.note).toBe(notes()[0]?.value);
    expect(part(rows()[0], "saved")).toBe(REPORTS_COPY.saved);
    expect(part(rows()[0], "full")).toBeNull();
  });

  it("sets Saved at the field's edge, where it moves nothing (item 8)", async () => {
    await flag(report("a", "2026-10-04T18:00:00.000Z"));
    panel();
    openRow(0);
    fireEvent.change(notes()[0]!, { target: { value: "the chip wraps" } });
    fireEvent.blur(notes()[0]!);
    const saved = rows()[0]!.querySelector("[data-report-saved]")!;
    expect(saved.className).toContain("absolute");
    expect(saved.parentElement?.contains(notes()[0]!)).toBe(true);
  });

  // A draft lives until it is saved (fix round 2, LOW-1): after, the field
  // shows what the outbox holds, so a later close writes nothing stale.
  it("shows a note saved elsewhere since its own save, and leaves it on close", async () => {
    await flag(report("a", "2026-10-04T18:00:00.000Z"));
    const onClose = vi.fn();
    const view = render(<ReportsPanel outbox={() => outbox} onClose={onClose} />);
    openRow(0);
    fireEvent.change(notes()[0]!, { target: { value: "from this tab" } });
    fireEvent.blur(notes()[0]!);
    // Another tab's save, landing here as the outbox's own update.
    act(() => outbox.annotate("a", "from the other tab, newer"));
    expect(notes()[0]?.value).toBe("from the other tab, newer");
    view.unmount();
    expect(outbox.list()[0]?.note).toBe("from the other tab, newer");
    await act(() => outbox.flush());
    expect(annotates.map((a) => a.note)).toEqual(["from this tab", "from the other tab, newer"]);
  });

  it("disarms an armed clear after 4 s", async () => {
    await flag(report("a", "2026-10-04T18:00:00.000Z"));
    vi.useFakeTimers({ toFake: ["setTimeout", "clearTimeout"] });
    panel();
    fireEvent.click(screen.getByRole("button", { name: /^Clear/ }));
    expect(screen.queryByRole("button", { name: REPORTS_COPY.clearArmed(1) })).not.toBeNull();
    act(() => vi.advanceTimersByTime(CLEAR_ARM_MS - 1));
    expect(screen.queryByRole("button", { name: REPORTS_COPY.clearArmed(1) })).not.toBeNull();
    act(() => vi.advanceTimersByTime(1));
    expect(screen.queryByRole("button", { name: /^Clear/ })).not.toBeNull();
    expect(outbox.list()).toHaveLength(1);
  });

  it("goes back to the kitchen by the ledge, the outbox untouched", async () => {
    await flag(report("a", "2026-10-04T18:00:00.000Z"));
    const onClose = panel();
    fireEvent.click(screen.getByRole("button", { name: BACK_TO_KITCHEN }));
    expect(onClose).toHaveBeenCalledOnce();
    expect(outbox.list()).toHaveLength(1);
  });

  it("says the flags the tablet didn't keep at its top, in ink, and lets them go as it closes", async () => {
    const misses = createMissLog();
    misses.add("failed");
    misses.add("full");
    misses.add("full");
    await flag(report("a", "2026-10-04T18:00:00.000Z"));
    const onClose = vi.fn();
    render(<ReportsPanel outbox={() => outbox} misses={misses} onClose={onClose} />);
    const said = [...document.querySelectorAll("[data-report-missed]")];
    expect(said.map((p) => p.textContent)).toEqual([
      "1 flag not kept: the tablet couldn't store it.",
      "2 flags not kept: the tablet already held 20 waiting to send.",
    ]);
    expect(said.every((p) => p.className.includes("text-ink") && !p.className.includes("ember"))).toBe(true);
    fireEvent.click(screen.getByRole("button", { name: BACK_TO_KITCHEN }));
    expect(onClose).toHaveBeenCalledOnce();
    expect(misses.read()).toEqual({ failed: 0, full: 0 });
  });

  it("says only the misses when the tablet holds no flag, not that nothing was flagged", () => {
    const misses = createMissLog();
    misses.add("failed");
    render(<ReportsPanel outbox={() => outbox} misses={misses} onClose={vi.fn()} />);
    expect(screen.getByText("1 flag not kept: the tablet couldn't store it.")).toBeTruthy();
    expect(screen.queryByText(REPORTS_COPY.empty)).toBeNull();
  });

  it("lets the misses go when it goes another way than the ledge, as when the route changes (verify round 5, LOW-3)", async () => {
    const misses = createMissLog();
    misses.add("failed");
    const onClose = vi.fn();
    const view = render(<ReportsPanel outbox={() => outbox} misses={misses} onClose={onClose} />);
    view.unmount();
    await Promise.resolve();
    expect(onClose).not.toHaveBeenCalled();
    expect(misses.read()).toEqual({ failed: 0, full: 0 });
  });

  it("keeps the misses through a development remount, the panel still up", async () => {
    const misses = createMissLog();
    misses.add("full");
    render(
      <StrictMode>
        <ReportsPanel outbox={() => outbox} misses={misses} onClose={vi.fn()} />
      </StrictMode>,
    );
    await act(async () => {
      await Promise.resolve();
    });
    expect(misses.read()).toEqual({ failed: 0, full: 1 });
    expect(screen.getByText("1 flag not kept: the tablet already held 20 waiting to send.")).toBeTruthy();
  });
});


// A note mid-edit is the cook's words: no way out of the panel drops it
// (fix round 1, M2). None of these blur the field first, as a browser
// doesn't when the field is taken off the page.
describe("leaving the panel with a note mid-edit", () => {
  const typing = "the timer chip reads like an ingredient";

  async function typeIntoOpenPanel() {
    await flag(report("a", "2026-10-04T18:00:00.000Z"));
    const view = render(<FlaggedEntry outbox={() => outbox} />);
    fireEvent.click(screen.getByRole("button", { name: REPORTS_COPY.entry(1) }));
    openRow(0);
    fireEvent.change(notes()[0]!, { target: { value: typing } });
    expect(outbox.list()[0]?.note).toBe("");
    return view;
  }

  it("saves it on Escape", async () => {
    await typeIntoOpenPanel();
    fireEvent.keyDown(document, { key: "Escape" });
    expect(screen.queryByRole("heading", { name: REPORTS_COPY.kind })).toBeNull();
    expect(outbox.list()[0]?.note).toBe(typing);
  });

  it("saves it on the ledge back to the kitchen", async () => {
    await typeIntoOpenPanel();
    fireEvent.click(screen.getByRole("button", { name: BACK_TO_KITCHEN }));
    expect(outbox.list()[0]?.note).toBe(typing);
  });

  it("saves it when the page goes elsewhere and the panel is taken down", async () => {
    const view = await typeIntoOpenPanel();
    view.unmount();
    expect(outbox.list()[0]?.note).toBe(typing);
  });

  it("saves it when the tab is hidden or closed, the panel still open", async () => {
    await typeIntoOpenPanel();
    act(() => {
      window.dispatchEvent(new Event("pagehide"));
    });
    expect(outbox.list()[0]?.note).toBe(typing);
    expect(screen.queryByRole("heading", { name: REPORTS_COPY.kind })).not.toBeNull();
  });

  it("saves only what changed: a note left as it was sends nothing", async () => {
    await flag(report("a", "2026-10-04T18:00:00.000Z"));
    render(<FlaggedEntry outbox={() => outbox} />);
    fireEvent.click(screen.getByRole("button", { name: REPORTS_COPY.entry(1) }));
    fireEvent.keyDown(document, { key: "Escape" });
    await act(() => outbox.flush());
    expect(annotates).toEqual([]);
  });
});

// The foot's fade lies over space, never over words (fix round 2, item 4).
describe("footClip", () => {
  const FADE = 24;

  it("keeps the clip where nothing lies under the fade", () => {
    expect(footClip([[0, 40], [60, 100], [200, 260]], 150, FADE, 90)).toBe(150);
  });

  it("lifts the clip to the top of what the fade would lie over", () => {
    // [140, 180] spans the foot: the clip goes to its top, and the fade
    // above it, [116, 140), is clear.
    expect(footClip([[0, 40], [60, 100], [140, 180]], 160, FADE, 90)).toBe(140);
  });

  it("keeps lifting while the new fade lies over the part above", () => {
    expect(footClip([[0, 30], [60, 120], [130, 180]], 160, FADE, 50)).toBe(60);
  });

  it("lifts no higher than its floor, and then lies over heads only", () => {
    const parts: [number, number][] = [[0, 40], [60, 120], [130, 180]];
    expect(footClip(parts, 160, FADE, 100)).toBe(160);
    expect(footClip(parts, 160, FADE, 100, [[130, 150]])).toBe(130);
  });

  it("does nothing with no height", () => {
    expect(footClip([[0, 40]], 0, FADE, 0)).toBe(0);
  });
});

// The top's fade lies over space at rest: a scroll ending with a word under
// it glides on to the nearest rest point (fix round 2, item 4).
describe("restAt", () => {
  const FADE = 24;

  it("stays where no word lies under the fade", () => {
    expect(restAt([[30, 50], [-40, -10]], [60], 300, 900, FADE)).toBeNull();
  });

  it("settles the nearest rest point just under the fade", () => {
    // A line at [10, 30] lies under it; rest points 40 below and 90 above.
    expect(restAt([[10, 30]], [-90, 40, 300], 300, 900, FADE)).toBe(316);
    expect(restAt([[10, 30]], [-30, 140], 300, 900, FADE)).toBe(246);
  });

  it("settles for a word cut by the clipped edge", () => {
    expect(restAt([[-8, 12]], [50], 300, 900, FADE)).toBe(326);
  });

  it("stays at either end", () => {
    expect(restAt([[10, 30]], [40], 0, 900, FADE)).toBeNull();
    expect(restAt([[10, 30]], [40], 900, 900, FADE)).toBeNull();
  });

  it("goes no further than the list can scroll", () => {
    expect(restAt([[10, 30]], [200], 850, 900, FADE)).toBe(900);
  });

  it("stays when the nearest rest point is where it is", () => {
    expect(restAt([[10, 30]], [24.5], 300, 900, FADE)).toBeNull();
  });

  it("stays with nowhere to rest", () => {
    expect(restAt([[10, 30]], [], 300, 900, FADE)).toBeNull();
  });

  // After a clear the cook didn't leave the list at its end (fix round 3, LOW-5).
  it("after a clear, settles from the end too, to a rest point above", () => {
    expect(restAt([[10, 30]], [-60, 200], 900, 900, FADE, true)).toBe(816);
    // A rest point below can't come up, so it doesn't count as staying.
    expect(restAt([[10, 30]], [-60, 30], 900, 900, FADE, true)).toBe(816);
    expect(restAt([[10, 30]], [30], 900, 900, FADE, true)).toBeNull();
    expect(restAt([[30, 50]], [-60], 900, 900, FADE, true)).toBeNull();
  });
});

// The list stays at its end, so the end must be a place to rest: room past
// the last row lets it scroll on past a word its top fade would lie over
// (panel round 4).
describe("endRoom", () => {
  const FADE = 24;

  it("keeps none when the end leaves the fade over space", () => {
    // Scrolled to 100, the fade covers [100, 124]; the words lie either side.
    expect(endRoom([[60, 95], [130, 160]], 100, FADE, 200)).toBe(0);
  });

  it("keeps room enough to scroll past a word under the fade at the end", () => {
    expect(endRoom([[90, 110], [140, 160]], 100, FADE, 200)).toBe(10);
  });

  it("goes on past a word the room brings under the fade", () => {
    // Past the first, the second lies under the fade; past both, it is clear.
    expect(endRoom([[90, 110], [120, 150], [190, 210]], 100, FADE, 200)).toBe(50);
  });

  it("keeps none, not the cap, when only more would clear the fade: a tall last note runs under it (DS §5; verify round 5, LOW-5)", () => {
    // A note from 120 to 400: room of the cap's 200 would end at 300, the
    // fade still over the note, past a gap two fifths of the list.
    expect(endRoom([[90, 110], [120, 400]], 100, FADE, 200)).toBe(0);
    expect(endRoom([[90, 110], [120, 400]], 100, FADE, 300)).toBe(300);
  });

  it("keeps none for a list that doesn't scroll", () => {
    expect(endRoom([[0, 20]], 0, FADE, 200)).toBe(0);
  });
});

// The control the keyboard is in is the list's anchor (fix round 3, M3).
describe("keepClear", () => {
  const FADE = 24;

  it("stays while the control lies clear of both fades", () => {
    expect(keepClear(40, 200, 300, 900, 500, FADE)).toBeNull();
  });

  it("brings a control under the foot's fade up, just clear of it", () => {
    expect(keepClear(370, 466, 0, 900, 473, FADE)).toBe(17);
  });

  it("brings a control under the top's fade down, just clear of it", () => {
    expect(keepClear(10, 100, 300, 900, 500, FADE)).toBe(286);
    expect(keepClear(-50, 40, 300, 900, 500, FADE)).toBe(226);
  });

  it("keeps the top in view when the control is taller than the room", () => {
    expect(keepClear(100, 700, 300, 900, 500, FADE)).toBe(376);
  });

  it("stays at an end, where no fade is drawn", () => {
    expect(keepClear(5, 100, 0, 900, 500, FADE)).toBeNull();
    expect(keepClear(300, 498, 900, 900, 500, FADE)).toBeNull();
  });

  it("goes no further than the list can scroll", () => {
    expect(keepClear(400, 510, 880, 900, 500, FADE)).toBe(900);
  });
});

describe("the hub's count", () => {
  it("draws nothing while the tablet holds no reports", () => {
    const { container } = render(<FlaggedEntry outbox={() => outbox} />);
    expect(container.innerHTML).toBe("");
  });

  it("opens the panel from a quiet count, and comes back to it", async () => {
    await flag(report("a", "2026-10-04T18:00:00.000Z"), report("b", "2026-10-04T18:01:00.000Z"));
    render(<FlaggedEntry outbox={() => outbox} />);
    fireEvent.click(screen.getByRole("button", { name: REPORTS_COPY.entry(2) }));
    expect(screen.queryByRole("heading", { name: REPORTS_COPY.kind })).not.toBeNull();
    fireEvent.click(screen.getByRole("button", { name: BACK_TO_KITCHEN }));
    expect(screen.queryByRole("heading", { name: REPORTS_COPY.kind })).toBeNull();
    expect(screen.queryByRole("button", { name: REPORTS_COPY.entry(2) })).not.toBeNull();
  });

  it("appears when a report arrives", async () => {
    render(<FlaggedEntry outbox={() => outbox} />);
    await act(() => flag(report("a", "2026-10-04T18:00:00.000Z")));
    expect(screen.queryByRole("button", { name: REPORTS_COPY.entry(1) })).not.toBeNull();
  });

  it("names what it counts: the flagged screens, and any flag not kept", async () => {
    const misses = createMissLog();
    render(<FlaggedEntry outbox={() => outbox} misses={misses} />);
    act(() => misses.add("failed"));
    expect(screen.queryByRole("button", { name: REPORTS_COPY.notKept(1) })).not.toBeNull();
    await act(() => flag(report("a", "2026-10-04T18:00:00.000Z"), report("b", "2026-10-04T18:01:00.000Z")));
    expect(REPORTS_COPY.entry(2)).toBe("2 flagged screens");
    expect(screen.queryByRole("button", { name: `${REPORTS_COPY.entry(2)} · ${REPORTS_COPY.notKept(1)}` })).not.toBeNull();
  });

  it("is one of the header's action words: ink-soft at the meta's size in a hairline ring, no fill at rest, no chevron (V11, v1.16)", async () => {
    await flag(report("a", "2026-10-04T18:00:00.000Z"));
    render(<FlaggedEntry outbox={() => outbox} />);
    const entry = screen.getByRole("button", { name: REPORTS_COPY.entry(1) });
    const rest = entry.className.split(/\s+/).filter((c) => c !== "" && !c.split("[")[0]!.includes(":"));
    expect(rest).toContain("text-ink-soft");
    expect(rest).toContain("text-[length:var(--type-meta)]");
    expect(rest).toContain("min-h-[var(--target)]");
    expect(rest.some((c) => c.startsWith("bg-"))).toBe(false);
    expect(entry.className).toContain("active:before:bg-sand");
    expect(entry.className).toContain("before:border-ink/[.2]");
    expect(entry.querySelector("svg")).toBeNull();
  });

  it("lets the misses go once the panel has said them", () => {
    const misses = createMissLog();
    misses.add("full");
    const { container } = render(<FlaggedEntry outbox={() => outbox} misses={misses} />);
    fireEvent.click(screen.getByRole("button", { name: REPORTS_COPY.notKept(1) }));
    fireEvent.click(screen.getByRole("button", { name: BACK_TO_KITCHEN }));
    expect(container.innerHTML).toBe("");
  });
});
