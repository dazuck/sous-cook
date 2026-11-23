// @vitest-environment happy-dom
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { CookReportInputSchema } from "../cook-reports";
import {
  DOM_MAX_BYTES,
  NOTE_MAX_BYTES,
  PLAN_MAX_BYTES,
  REPORT_INPUT_MAX_BYTES,
  buildReport,
  cutToJsonBytes,
  insertToFit,
  jsonBytes,
  type CaptureInputs,
  type CookReport,
} from "./report-capture";
import { EVENT_CAPACITY, EVENT_MAX_BYTES, recentEvents, recordEvent, resetEventLog } from "./report-events";
import { createReportOutbox, type StringStore } from "./report-outbox";

// What the client cuts, the server takes (fix round 1, LOW-8): the server
// measures a report, and each event in it, as JSON, where a `"` costs two
// bytes and a control character six. A cut measured on the raw text let a
// report through the tablet that the server then refused for good (F6).

const added: Element[] = [];

function mount(text: string): Element {
  const root = document.createElement("div");
  root.textContent = text;
  document.body.appendChild(root);
  added.push(root);
  return root;
}

beforeEach(() => {
  resetEventLog();
});

afterEach(() => {
  for (const node of added.splice(0)) node.remove();
});

function inputs(root: Element, plan: unknown = { version: 4 }): CaptureInputs {
  return {
    id: "0f8fad5b-d9cb-469f-a165-70867728950e",
    now: 1_770_000_000_000,
    build: "b-123",
    href: "https://kitchen.example.com/kitchen/queue/4b1d",
    online: true,
    ua: "test-agent",
    viewport: { w: 1280, h: 800, dpr: 2 },
    root,
    cook: {
      queueId: "4b1d6f9e-8a51-4c43-9d7c-5a0c2f3e1b2a",
      recipeName: "Mole",
      plan,
      planVersion: 4,
      state: { mode: "go", pos: 3, ticked: [], passed: [], kept: [] },
      screen: "step",
      stepKey: "s2",
      chapterId: null,
      step: null,
      part: null,
      layers: { pane: false, card: null, more: false },
      voice: { mode: "always", status: "listening" },
      ask: { sessionId: "cook-queue-1", open: false },
    },
    events: recentEvents(),
  };
}

const taken = (report: CookReport) => CookReportInputSchema.safeParse(report);

/** A control character: six bytes once escaped. */
const CONTROL = "\u0001";

// A full field takes no more (fix round 3, M1): what it held stays whole, and
// of an edit only what fits goes in, at the caret.
describe("insertToFit", () => {
  const full = "HEAD" + "a".repeat(8) + "TAIL";

  it("keeps an edit that fits as made", () => {
    expect(insertToFit("ab", "aXb", 2, 16)).toEqual({ text: "aXb", caret: 2, cut: false });
  });

  it("refuses what doesn't fit mid-text, keeping the end and the caret", () => {
    expect(insertToFit(full, "HEADXYZ" + full.slice(4), 7, 16)).toEqual({ text: full, caret: 4, cut: true });
    expect(insertToFit(full, "HEADX" + full.slice(4), 5, 16)).toEqual({ text: full, caret: 4, cut: true });
  });

  it("puts in what fits of a paste, at the caret, and the caret after it", () => {
    const room = "HEAD" + "a".repeat(5) + "TAIL";
    expect(insertToFit(room, "HEAD0123456789" + room.slice(4), 14, 16)).toEqual({
      text: "HEAD012" + room.slice(4),
      caret: 7,
      cut: true,
    });
  });

  it("takes what fits of a paste over a selection, the rest of the text whole", () => {
    expect(insertToFit(full, "HEAD0123456789" + full.slice(8), 14, 16)).toEqual({
      text: "HEAD0123" + full.slice(8),
      caret: 8,
      cut: true,
    });
  });

  it("measures as the server does and never leaves half a character", () => {
    expect(insertToFit("ab", 'a""b', 3, 5)).toEqual({ text: 'a"b', caret: 2, cut: true });
    expect(insertToFit("ab", "a🍳🍳b", 5, 7)).toEqual({ text: "a🍳b", caret: 3, cut: true });
  });

  it("keeps an edit that shrinks an over-full note", () => {
    expect(insertToFit("abcdef", "abdef", 2, 3)).toEqual({ text: "abdef", caret: 2, cut: false });
  });

  it("finds the edit by the text when the caret doesn't say", () => {
    expect(insertToFit("abcd", "abXYcd", 0, 5)).toEqual({ text: "abXcd", caret: 3, cut: true });
  });
});

describe("cutToJsonBytes", () => {
  it("keeps text whose escaped form fits whole", () => {
    expect(cutToJsonBytes('say "next"', 12)).toEqual({ text: 'say "next"', cut: false });
  });

  it("cuts on escaped bytes: a quote costs two, a control character six", () => {
    expect(cutToJsonBytes('""""', 5)).toEqual({ text: '""', cut: true });
    expect(cutToJsonBytes(CONTROL.repeat(4), 13)).toEqual({ text: CONTROL.repeat(2), cut: true });
  });

  it("never leaves half a character", () => {
    const { text } = cutToJsonBytes("🍳🍳", 6);
    expect(text).toBe("🍳");
  });
});

describe("a report the client builds is one the server takes", () => {
  it("a DOM of 200 KB of quotes is cut to fit, and says so", () => {
    const report = buildReport(inputs(mount('"'.repeat(DOM_MAX_BYTES))));
    expect(report.domTruncated).toBe(true);
    expect(jsonBytes(report.dom) - 2).toBeLessThanOrEqual(DOM_MAX_BYTES);
    expect(taken(report).success).toBe(true);
  });

  it("an event of 300 control characters is cut to the server's 1 KB per event", () => {
    recordEvent("error", CONTROL.repeat(300));
    const [event] = recentEvents();
    expect(jsonBytes(event)).toBeLessThanOrEqual(EVENT_MAX_BYTES);
    expect(taken(buildReport(inputs(mount("the step")))).success).toBe(true);
  });

  it("a plan over 64 KB is left out rather than refuse the report, its version kept", () => {
    const plan = { version: 4, tasks: [{ id: "s1", text: "x".repeat(PLAN_MAX_BYTES) }] };
    const report = buildReport(inputs(mount("the step"), plan));
    expect(report.plan).toBeNull();
    expect(report.planVersion).toBe(4);
    expect(taken(report).success).toBe(true);
  });

  it("everything at its worst at once, with a 4 KB note of quotes, is still taken", async () => {
    for (let i = 0; i < EVENT_CAPACITY; i += 1) recordEvent("error", CONTROL.repeat(300));
    const plan = { version: 4, tasks: [{ id: "s1", text: "\n".repeat(PLAN_MAX_BYTES / 2 - 100) }] };
    const report = buildReport(inputs(mount('"'.repeat(DOM_MAX_BYTES)), plan));
    expect(report.plan).not.toBeNull();

    const sent: CookReport[] = [];
    const map = new Map<string, string>();
    const backing: StringStore = {
      getItem: (key) => map.get(key) ?? null,
      setItem: (key, value) => map.set(key, value),
      removeItem: (key) => map.delete(key),
    };
    const outbox = createReportOutbox(backing, {
      submit: (r) => {
        sent.push(r);
        return Promise.reject(new TypeError("Failed to fetch"));
      },
      annotate: () => Promise.resolve(),
    });
    await outbox.add(report);
    outbox.annotate(report.id, '"'.repeat(NOTE_MAX_BYTES));
    await outbox.flush();
    const last = sent.at(-1)!;
    expect(jsonBytes(last.note) - 2).toBeLessThanOrEqual(NOTE_MAX_BYTES);
    expect(jsonBytes(last)).toBeLessThanOrEqual(REPORT_INPUT_MAX_BYTES);
    expect(taken(last).success).toBe(true);
  });
});
