// @vitest-environment happy-dom
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import {
  ERROR_DETAIL_MAX,
  EVENT_CAPACITY,
  installErrorCapture,
  recentEvents,
  recordAsk,
  recordEvent,
  recordStep,
  recordVoice,
  redactError,
  resetEventLog,
} from "./report-events";

// The ring buffer a flag reads: what just happened, oldest first, capped
// (ported from player/tests/eventLog.test.ts, with the app's kinds and B2
// decision 9's redaction).

beforeEach(() => {
  resetEventLog();
});

afterEach(() => {
  vi.useRealTimers();
});

describe("recordEvent", () => {
  it("keeps events oldest first with timestamps to the millisecond", () => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date("2026-10-04T18:00:00.123Z"));
    recordEvent("voice", "next");
    vi.setSystemTime(new Date("2026-10-04T18:00:00.456Z"));
    recordEvent("voice", "back");
    const events = recentEvents();
    expect(events.map((e) => e.detail)).toEqual(["next", "back"]);
    expect(events.map((e) => e.at)).toEqual([
      "2026-10-04T18:00:00.123Z",
      "2026-10-04T18:00:00.456Z",
    ]);
  });

  it("drops the oldest past capacity", () => {
    for (let i = 0; i < EVENT_CAPACITY + 10; i += 1) {
      recordEvent("step", String(i));
    }
    const events = recentEvents();
    expect(events).toHaveLength(EVENT_CAPACITY);
    expect(events[0]?.detail).toBe("10");
    expect(events.at(-1)?.detail).toBe(String(EVENT_CAPACITY + 9));
  });

  it("holds 50, the report's cap", () => {
    expect(EVENT_CAPACITY).toBe(50);
  });

  it("hands out a copy, so a report taken now doesn't grow with later events", () => {
    recordEvent("flag", "touch");
    const taken = recentEvents();
    recordEvent("step", "next → 1");
    expect(taken).toHaveLength(1);
  });
});

describe("redactError", () => {
  it("strips query strings and fragments from URLs", () => {
    expect(
      redactError(
        "Failed to fetch https://kitchen.example.com/_next/static/chunks/a.js?dpl=dpl_123&token=x#frag",
      ),
    ).toBe("Failed to fetch https://kitchen.example.com/_next/static/chunks/a.js");
    expect(redactError("GET /api/trpc/cooking?batch=1&input=%7B%22q%22%7D 500")).toBe(
      "GET /api/trpc/cooking 500",
    );
    expect(redactError("at (https://x.test/app.js?v=2:10:4)")).toBe("at (https://x.test/app.js)");
  });

  it(`cuts to ${ERROR_DETAIL_MAX} characters`, () => {
    expect(ERROR_DETAIL_MAX).toBe(300);
    const long = "x".repeat(1000);
    expect(redactError(long)).toHaveLength(300);
  });

  it("leaves plain words be", () => {
    expect(redactError("Cannot read properties of undefined (reading 'pos')")).toBe(
      "Cannot read properties of undefined (reading 'pos')",
    );
  });
});

describe("installErrorCapture", () => {
  it("records window errors with their location, redacted", () => {
    const uninstall = installErrorCapture(window);
    try {
      window.dispatchEvent(
        new ErrorEvent("error", {
          message: "boom at https://x.test/q?secret=1",
          filename: "https://x.test/chunk.js?dpl=abc",
          lineno: 7,
        }),
      );
      const events = recentEvents();
      expect(events).toHaveLength(1);
      expect(events[0]?.kind).toBe("error");
      expect(events[0]?.detail).toBe("boom at https://x.test/q (https://x.test/chunk.js:7)");
    } finally {
      uninstall();
    }
  });

  it("records unhandled rejections, cut and redacted", () => {
    const uninstall = installErrorCapture(window);
    try {
      // A plain event carrying `reason` exercises the same handler on any DOM.
      const event = new Event("unhandledrejection");
      Object.assign(event, { reason: new Error(`nope /api/x?k=v ${"y".repeat(400)}`) });
      window.dispatchEvent(event);
      const events = recentEvents();
      expect(events).toHaveLength(1);
      expect(events[0]?.kind).toBe("error");
      expect(events[0]?.detail.startsWith("unhandled rejection: Error: nope /api/x y")).toBe(true);
      expect(events[0]?.detail).toHaveLength(ERROR_DETAIL_MAX);
    } finally {
      uninstall();
    }
  });

  it("records resource-load failures, which never bubble", () => {
    const uninstall = installErrorCapture(window);
    const img = document.createElement("img");
    img.setAttribute("src", "/assets/missing.png?v=3");
    document.body.append(img);
    try {
      img.dispatchEvent(new Event("error"));
      const events = recentEvents();
      expect(events).toHaveLength(1);
      expect(events[0]?.kind).toBe("error");
      expect(events[0]?.detail).toBe("failed to load /assets/missing.png");
    } finally {
      uninstall();
      img.remove();
    }
  });

  it("stops recording after uninstall", () => {
    const uninstall = installErrorCapture(window);
    uninstall();
    window.dispatchEvent(new ErrorEvent("error", { message: "late" }));
    expect(recentEvents()).toHaveLength(0);
  });
});

describe("recordStep", () => {
  it("names each move of the cook session with the place it left the cook", () => {
    recordStep({ type: "next" }, 1);
    recordStep({ type: "back" }, 0);
    recordStep({ type: "jump", pos: 4 }, 4);
    recordStep({ type: "goMark", pos: 3 }, 3);
    recordStep({ type: "mode", mode: "go" }, 0);
    recordStep({ type: "tick", id: "m2" }, 0);
    expect(recentEvents().map((e) => `${e.kind}: ${e.detail}`)).toEqual([
      "step: next → 1",
      "step: back → 0",
      "step: jump → 4",
      "step: go from the chart → 3",
      "step: mode go → 0",
      "step: tick m2 → 0",
    ]);
  });

  it("names an offered plan by its source, never by its contents", () => {
    recordStep(
      {
        type: "offer",
        plan: { version: 4, tasks: [{ id: "s1", text: "secret words" }] } as never,
        source: { kind: "as-written", reason: "pending" },
      },
      0,
    );
    recordStep(
      { type: "offer", plan: {} as never, source: { kind: "derived" } },
      0,
    );
    const details = recentEvents().map((e) => e.detail);
    expect(details).toEqual(["offer as-written (pending) → 0", "offer derived → 0"]);
  });
});

describe("recordVoice", () => {
  it("records a command with what was heard", () => {
    recordVoice({ kind: "command", command: "next", heard: "sue next" });
    expect(recentEvents().map((e) => `${e.kind}: ${e.detail}`)).toEqual([
      'voice: next ("sue next")',
    ]);
  });

  it("records an unknown of at most three words past the address, with its words", () => {
    recordVoice({ kind: "unknown", heard: "sue flip it" });
    recordVoice({ kind: "unknown", heard: "hey sue chef flip it over" });
    recordVoice({ kind: "unknown", heard: "flip it now" });
    expect(recentEvents().map((e) => e.detail)).toEqual([
      'unknown ("sue flip it")',
      'unknown ("hey sue chef flip it over")',
      'unknown ("flip it now")',
    ]);
  });

  it("never records conversation: an unknown of more than three words", () => {
    // A tap hears whatever is said; Ask-length speech is not the log's.
    recordVoice({ kind: "unknown", heard: "how long do i rest the meat" });
    recordVoice({ kind: "unknown", heard: "sue the timer is wrong" });
    expect(recentEvents()).toHaveLength(0);
  });

  it("records the wake word alone, a near miss, silence and trouble by name", () => {
    recordVoice({ kind: "armed" });
    recordVoice({ kind: "near-miss", heard: "shoe next" });
    recordVoice({ kind: "silence" });
    recordVoice({ kind: "trouble" });
    expect(recentEvents().map((e) => e.detail)).toEqual([
      "armed",
      'near-miss ("shoe next")',
      "silence",
      "trouble",
    ]);
  });
});

describe("recordAsk", () => {
  it("records that Ask was used, never the words", () => {
    recordAsk("sent");
    recordAsk("answered");
    recordAsk("error");
    recordAsk("error: cut at the token cap");
    expect(recentEvents().map((e) => `${e.kind}: ${e.detail}`)).toEqual([
      "ask: sent",
      "ask: answered",
      "ask: error",
      "ask: error: cut at the token cap",
    ]);
  });
});
