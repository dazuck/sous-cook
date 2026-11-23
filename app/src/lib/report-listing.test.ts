/**
 * What `scripts/list-reports.ts` prints (B2 step 6), against fixture rows:
 * the 24 h header, a summary per report, the F3 warning, Ask's last exchange,
 * and the full report by id. The script only adds the queries.
 */

import { describe, expect, it } from "vitest";
import {
  formatFull,
  formatHeader,
  formatSummary,
  movedBeforeFlag,
  parseListArgs,
  type AskExchange,
  type ListedReport,
} from "./report-listing";

const TZ = "UTC";

function row(overrides?: Partial<ListedReport>): ListedReport {
  return {
    id: "0f8fad5b-d9cb-469f-a165-70867728950e",
    kitchenId: "00000000-0000-4000-8000-000000000001",
    kitchenSlug: "home",
    createdAt: new Date("2026-10-04T18:00:01.000Z"),
    capturedAt: new Date("2026-10-04T18:00:00.500Z"),
    build: "b-123",
    path: "/kitchen/queue/4b1d6f9e-8a51-4c43-9d7c-5a0c2f3e1b2a",
    screen: "step",
    queueId: "4b1d6f9e-8a51-4c43-9d7c-5a0c2f3e1b2a",
    recipeName: "Mole",
    stepKey: "s2+s3",
    chapterId: "batch:s2",
    planVersion: 4,
    state: { mode: "go", pos: 3, ticked: ["m1"], passed: ["s1"], kept: [] },
    context: {
      viewport: { w: 1280, h: 800, dpr: 2 },
      ua: "test-agent",
      online: true,
      voice: { mode: "always", status: "listening" },
      ask: { sessionId: "cook-queue-1770000000000", open: false },
      layers: { pane: true, card: null, more: false },
      part: { at: 1, of: 2 },
    },
    events: [
      { at: "2026-10-04T17:50:00.000Z", kind: "cook", detail: "open" },
      { at: "2026-10-04T17:55:00.000Z", kind: "step", detail: "next → 1" },
      { at: "2026-10-04T17:56:00.000Z", kind: "step", detail: "next → 2" },
      { at: "2026-10-04T17:57:00.000Z", kind: "layer", detail: "pane open" },
      { at: "2026-10-04T17:58:00.000Z", kind: "voice", detail: 'next ("sue next")' },
      { at: "2026-10-04T17:59:00.000Z", kind: "step", detail: "next → 3" },
    ],
    domTruncated: false,
    domBytes: 48_213,
    note: "",
    noteAt: null,
    ...overrides,
  };
}

describe("parseListArgs", () => {
  it("defaults to the last 20, deploy checks hidden, text out", () => {
    expect(parseListArgs([])).toEqual({
      since: null,
      limit: 20,
      id: null,
      dom: null,
      json: false,
      all: false,
    });
  });

  it("reads every flag", () => {
    expect(
      parseListArgs([
        "--since",
        "2026-10-01",
        "--limit",
        "5",
        "--id",
        "0f8fad5b-d9cb-469f-a165-70867728950e",
        "--dom",
        "out.html",
        "--json",
        "--all",
      ]),
    ).toEqual({
      since: new Date("2026-10-01"),
      limit: 5,
      id: "0f8fad5b-d9cb-469f-a165-70867728950e",
      dom: "out.html",
      json: true,
      all: true,
    });
  });

  it("refuses what it can't read, rather than guess", () => {
    expect(() => parseListArgs(["--since", "yesterday"])).toThrow(/--since/);
    expect(() => parseListArgs(["--limit", "0"])).toThrow(/--limit/);
    expect(() => parseListArgs(["--limit"])).toThrow(/--limit/);
    expect(() => parseListArgs(["--id", "r001"])).toThrow(/--id/);
    expect(() => parseListArgs(["--dom", "x.html"])).toThrow(/--dom needs --id/);
    expect(() => parseListArgs(["--write"])).toThrow(/--write/);
  });
});

describe("movedBeforeFlag (F3)", () => {
  it("names a step under 2 s before the flag, with its gap in ms", () => {
    const events = [
      ...row().events,
      { at: "2026-10-04T18:00:00.160Z", kind: "step" as const, detail: "next → 4" },
    ];
    expect(movedBeforeFlag(row({ events }))).toEqual({ ms: 340, detail: "next → 4" });
  });

  it("is quiet when the last step is 2 s old or more", () => {
    const events = [{ at: "2026-10-04T17:59:58.500Z", kind: "step" as const, detail: "next → 4" }];
    expect(movedBeforeFlag(row({ events }))).toBeNull();
    expect(movedBeforeFlag(row())).toBeNull();
  });

  it("looks at steps only: a voice command alone is not a move", () => {
    const events = [{ at: "2026-10-04T18:00:00.400Z", kind: "voice" as const, detail: "next" }];
    expect(movedBeforeFlag(row({ events }))).toBeNull();
  });
});

describe("formatHeader", () => {
  it("leads with the 24 h counts per kitchen against the per-kitchen cap", () => {
    expect(
      formatHeader(
        { lastDayByKitchen: [{ kitchenSlug: "home", count: 3 }], shown: 3, since: null, all: false },
        TZ,
      ),
    ).toBe(
      "cook_reports: 3 in the last 24 h (home 3/100; cap 100 per kitchen). Showing 3, newest first; deploy checks hidden.",
    );
  });

  it("says none when no kitchen has reports in the last 24 h", () => {
    expect(
      formatHeader(
        { lastDayByKitchen: [], shown: 0, since: null, all: false },
        TZ,
      ),
    ).toBe(
      "cook_reports: 0 in the last 24 h (none; cap 100 per kitchen). Showing 0, newest first; deploy checks hidden.",
    );
  });

  it("says when a kitchen's cap is used up while another kitchen still has room", () => {
    expect(
      formatHeader(
        {
          lastDayByKitchen: [
            { kitchenSlug: "home", count: 100 },
            { kitchenSlug: "north", count: 2 },
          ],
          shown: 20,
          since: null,
          all: true,
        },
        TZ,
      ),
    ).toBe(
      "cook_reports: 102 in the last 24 h (home 100/100 (cap reached: new reports wait in the outbox), north 2/100; cap 100 per kitchen). Showing 20, newest first.",
    );
  });

  it("names the --since bound", () => {
    expect(
      formatHeader(
        {
          lastDayByKitchen: [{ kitchenSlug: "home", count: 1 }],
          shown: 0,
          since: new Date("2026-10-01T00:00:00Z"),
          all: false,
        },
        TZ,
      ),
    ).toBe(
      "cook_reports: 1 in the last 24 h (home 1/100; cap 100 per kitchen). Showing 0 since 2026-10-01 00:00:00Z, newest first; deploy checks hidden.",
    );
  });
});

describe("formatSummary", () => {
  it("names where and when: time, recipe, screen, step, chapter, mode, and kitchen", () => {
    const lines = formatSummary(row(), null, TZ);
    expect(lines[0]).toBe("2026-10-04 18:00:00Z  Mole · step · s2+s3 · chapter batch:s2 · go");
    expect(lines).toContain("  kitchen home · id 0f8fad5b-d9cb-469f-a165-70867728950e · build b-123 · part 1/2 · pane open · voice always/listening");
    expect(lines).toContain("  note: (none)");
  });

  it("prints the look-ahead's level and a step read (slice N), and leaves them out of a pre-N report", () => {
    const base = row().context;
    const n = row({
      screen: "whole-cook",
      context: { ...base, layers: { pane: false, card: null, more: false, level: 2, read: true } },
    });
    expect(formatSummary(n, null, TZ)).toContain(
      "  kitchen home · id 0f8fad5b-d9cb-469f-a165-70867728950e · build b-123 · part 1/2 · look-ahead Whole cook · step read · voice always/listening",
    );
    const atStretch = row({ context: { ...base, layers: { pane: false, card: null, more: false, level: 1, read: false } } });
    expect(formatSummary(atStretch, null, TZ).join("\n")).toContain("look-ahead Until you can step away");
    const atNow = row({ context: { ...base, layers: { pane: false, card: null, more: false, level: 0, read: false } } });
    expect(formatSummary(atNow, null, TZ).join("\n")).toContain("look-ahead Now");
    expect(formatSummary(row(), null, TZ).join("\n")).not.toContain("look-ahead");
  });

  it("prints the note when there is one", () => {
    expect(formatSummary(row({ note: "timer read 5, should be 8" }), null, TZ)).toContain(
      "  note: timer read 5, should be 8",
    );
  });

  it("shows the last 5 events with their times, oldest first", () => {
    const lines = formatSummary(row(), null, TZ);
    const at = lines.indexOf("  last events:");
    expect(lines.slice(at + 1, at + 6)).toEqual([
      "    17:55:00.000  step   next → 1",
      "    17:56:00.000  step   next → 2",
      "    17:57:00.000  layer  pane open",
      '    17:58:00.000  voice  next ("sue next")',
      "    17:59:00.000  step   next → 3",
    ]);
  });

  it("warns when the cook moved just before the flag (F3)", () => {
    const events = [{ at: "2026-10-04T18:00:00.160Z", kind: "step" as const, detail: "next → 4" }];
    expect(formatSummary(row({ events }), null, TZ)).toContain(
      "  ! moved 340 ms before the flag (next → 4): the DOM may be mid-motion",
    );
  });

  it("marks a cut DOM, a borrowed screen's layers and an open Ask", () => {
    const lines = formatSummary(
      row({
        screen: "all-steps",
        domTruncated: true,
        context: {
          ...row().context,
          layers: { pane: false, card: "screen", more: false },
          ask: { sessionId: "cook-queue-1", open: true },
          part: null,
        },
      }),
      null,
      TZ,
    );
    expect(lines).toContain(
      "  kitchen home · id 0f8fad5b-d9cb-469f-a165-70867728950e · build b-123 · card on screen · voice always/listening · Ask open · DOM cut at 200 KB",
    );
  });

  it("joins Ask's last exchange from conversation_logs", () => {
    const ask: AskExchange = { question: "how long do I rest it", answer: "About ten minutes." };
    const lines = formatSummary(row(), ask, TZ);
    expect(lines.slice(-3)).toEqual([
      "  Ask, last exchange (cook-queue-1770000000000):",
      "    you: how long do I rest it",
      "    sous: About ten minutes.",
    ]);
  });

  it("cuts a long Ask line to one readable line", () => {
    const ask: AskExchange = { question: "q", answer: `${"word ".repeat(100)}\nsecond line` };
    const sous = formatSummary(row(), ask, TZ).at(-1) ?? "";
    expect(sous.length).toBeLessThanOrEqual(4 + "sous: ".length + 200);
    expect(sous).not.toContain("\n");
    expect(sous.endsWith("…")).toBe(true);
  });
});

describe("formatFull", () => {
  it("prints the whole report but the DOM, which goes to a file", () => {
    const text = formatFull(
      { ...row(), plan: { version: 4, tasks: [] }, dom: "<div data-cook-root></div>" },
      null,
      TZ,
    );
    expect(text).toContain('"recipeName": "Mole"');
    expect(text).toContain('"plan": {');
    expect(text).toContain('"events": [');
    expect(text).not.toContain("data-cook-root");
    expect(text).toContain("DOM: 48213 bytes, whole. Write it out with --dom <file>.");
  });
});
