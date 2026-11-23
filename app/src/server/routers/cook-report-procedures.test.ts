/**
 * The two report procedures (B2 decisions 7 and 8): a write-only door with
 * its size caps, the 100-a-day cap, a duplicate counting as sent (F4), and
 * annotate on a missing id answering NOT_FOUND (F9). The DB calls are mocked;
 * the e2e suite reads real rows back, and races the cap against the real DB
 * (`e2e/report-cap.spec.ts`).
 */

import { describe, it, expect, vi, beforeEach } from "vitest";

vi.mock("../../lib/cook-reports", async (importOriginal) => ({
  ...(await importOriginal<typeof import("../../lib/cook-reports")>()),
  storeCookReport: vi.fn(),
  annotateCookReport: vi.fn(),
}));

import { TRPCError } from "@trpc/server";
import {
  annotateCookReport,
  storeCookReport,
  RATE_WINDOW_MS,
  REPORT_INPUT_MAX_BYTES,
  REPORTS_PER_DAY,
} from "../../lib/cook-reports";
import { DOM_MAX_BYTES, NOTE_MAX_BYTES, type CookReport } from "../../lib/kitchen/report-capture";
import { appRouter } from "./_app";
import { callerFor } from "../../lib/__tests__/kitchens";

const HOME = { id: "00000000-0000-4000-8000-000000000001", slug: "home" };
const caller = callerFor(HOME);
const REPORT_ID = "0f8fad5b-d9cb-469f-a165-70867728950e";
const DAY_MS = 24 * 60 * 60 * 1000;

function report(overrides?: Partial<CookReport>): CookReport {
  return {
    id: REPORT_ID,
    capturedAt: "2026-10-04T18:00:00.123Z",
    build: "b-123",
    path: "/kitchen/queue/4b1d6f9e-8a51-4c43-9d7c-5a0c2f3e1b2a",
    screen: "step",
    queueId: "4b1d6f9e-8a51-4c43-9d7c-5a0c2f3e1b2a",
    recipeName: "Mole",
    stepKey: "s2+s3",
    chapterId: "batch:s2",
    planVersion: 4,
    plan: { version: 4, tasks: [{ id: "s1", text: "Toast the chiles" }] },
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
    events: [{ at: "2026-10-04T17:59:59.000Z", kind: "voice", detail: 'next ("sue next")' }],
    dom: "<div data-cook-root></div>",
    domTruncated: false,
    note: "",
    ...overrides,
  };
}

/** The tRPC code a rejected call carries. */
async function codeOf(call: Promise<unknown>): Promise<string> {
  try {
    await call;
  } catch (error) {
    if (error instanceof TRPCError) return error.code;
    throw error;
  }
  throw new Error("expected the call to be refused");
}

beforeEach(() => {
  vi.clearAllMocks();
  vi.mocked(storeCookReport).mockResolvedValue("inserted");
  vi.mocked(annotateCookReport).mockResolvedValue(true);
});

describe("submitCookReport", () => {
  it("stores the report as sent", async () => {
    await expect(caller.submitCookReport(report())).resolves.toEqual({
      id: REPORT_ID,
      duplicate: false,
    });
    expect(storeCookReport).toHaveBeenCalledTimes(1);
    expect(vi.mocked(storeCookReport).mock.calls[0]?.[0]).toBe(HOME.id);
    expect(vi.mocked(storeCookReport).mock.calls[0]?.[1]).toEqual(report());
  });

  it("counts a conflict on the id as sent (F4)", async () => {
    vi.mocked(storeCookReport).mockResolvedValue("duplicate");
    await expect(caller.submitCookReport(report())).resolves.toEqual({
      id: REPORT_ID,
      duplicate: true,
    });
  });

  it("stores what it names and nothing more: unknown fields are dropped (F12)", async () => {
    const extra = {
      ...report(),
      cookies: "sb-session=secret",
      context: { ...report().context, env: { KEY: "secret" } },
    };
    await caller.submitCookReport(extra as never);
    expect(JSON.stringify(vi.mocked(storeCookReport).mock.calls[0]?.[1])).not.toContain("secret");
  });

  it("takes the deploy check's screen, and refuses a screen it doesn't know", async () => {
    await caller.submitCookReport({ ...report(), screen: "deploy-check" } as never);
    expect(storeCookReport).toHaveBeenCalledTimes(1);
    expect(await codeOf(caller.submitCookReport({ ...report(), screen: "home" } as never))).toBe(
      "BAD_REQUEST",
    );
  });

  it("refuses an id that is not a uuid", async () => {
    expect(await codeOf(caller.submitCookReport(report({ id: "r001" })))).toBe("BAD_REQUEST");
    expect(storeCookReport).not.toHaveBeenCalled();
  });

  describe("size caps (decision 8, F6)", () => {
    it("takes a DOM of exactly 200 KB and refuses one byte more", async () => {
      expect(DOM_MAX_BYTES).toBe(200 * 1024);
      await caller.submitCookReport(report({ dom: "a".repeat(DOM_MAX_BYTES) }));
      expect(storeCookReport).toHaveBeenCalledTimes(1);
      expect(
        await codeOf(caller.submitCookReport(report({ dom: "a".repeat(DOM_MAX_BYTES + 1) }))),
      ).toBe("BAD_REQUEST");
      expect(storeCookReport).toHaveBeenCalledTimes(1);
    });

    it("counts the DOM in UTF-8 bytes, not characters", async () => {
      // 102,401 two-byte characters: under the cap in characters, over it in bytes.
      const dom = "é".repeat(DOM_MAX_BYTES / 2 + 1);
      expect(await codeOf(caller.submitCookReport(report({ dom })))).toBe("BAD_REQUEST");
    });

    it("takes a note of exactly 4 KB and refuses one byte more", async () => {
      expect(NOTE_MAX_BYTES).toBe(4 * 1024);
      await caller.submitCookReport(report({ note: "n".repeat(NOTE_MAX_BYTES) }));
      expect(
        await codeOf(caller.submitCookReport(report({ note: "n".repeat(NOTE_MAX_BYTES + 1) }))),
      ).toBe("BAD_REQUEST");
    });

    it("takes 50 events and refuses 51", async () => {
      const event = { at: "2026-10-04T17:59:59.000Z", kind: "step" as const, detail: "next → 1" };
      await caller.submitCookReport(report({ events: Array.from({ length: 50 }, () => event) }));
      expect(storeCookReport).toHaveBeenCalledTimes(1);
      expect(
        await codeOf(
          caller.submitCookReport(report({ events: Array.from({ length: 51 }, () => event) })),
        ),
      ).toBe("BAD_REQUEST");
    });

    it("refuses an event over 1 KB", async () => {
      const big = { at: "2026-10-04T17:59:59.000Z", kind: "error" as const, detail: "x".repeat(1024) };
      expect(await codeOf(caller.submitCookReport(report({ events: [big] })))).toBe("BAD_REQUEST");
    });

    it("refuses an event of a kind the log doesn't have", async () => {
      const odd = { at: "2026-10-04T17:59:59.000Z", kind: "keystroke", detail: "a" };
      expect(await codeOf(caller.submitCookReport(report({ events: [odd] as never })))).toBe(
        "BAD_REQUEST",
      );
    });

    it("takes a plan of 64 KB and refuses one over it", async () => {
      // {"t":"…"} is 8 bytes of JSON around the filler.
      const plan = (bytes: number) => ({ t: "p".repeat(bytes - 8) });
      await caller.submitCookReport(report({ plan: plan(64 * 1024) }));
      expect(storeCookReport).toHaveBeenCalledTimes(1);
      expect(await codeOf(caller.submitCookReport(report({ plan: plan(64 * 1024 + 1) })))).toBe(
        "BAD_REQUEST",
      );
    });

    it("refuses a whole input over 320 KB even when each field is under its cap", async () => {
      expect(REPORT_INPUT_MAX_BYTES).toBe(320 * 1024);
      // State lists are bounded per entry, not per field: the whole cap binds them.
      const ids = Array.from({ length: 1000 }, (_, i) => `step-${i}-${"k".repeat(100)}`);
      const state = { mode: "go", pos: 0, ticked: ids, passed: ids, kept: ids };
      expect(
        await codeOf(
          caller.submitCookReport(report({ dom: "a".repeat(DOM_MAX_BYTES - 1000), state })),
        ),
      ).toBe("BAD_REQUEST");
      expect(storeCookReport).not.toHaveBeenCalled();
    });
  });

  describe("the global cap: 100 a rolling day (decision 8, F7, F11)", () => {
    it("holds 100 a day", () => {
      expect(REPORTS_PER_DAY).toBe(100);
      expect(RATE_WINDOW_MS).toBe(DAY_MS);
    });

    it("refuses a report over the cap with TOO_MANY_REQUESTS", async () => {
      vi.mocked(storeCookReport).mockResolvedValue("capped");
      expect(await codeOf(caller.submitCookReport(report()))).toBe("TOO_MANY_REQUESTS");
    });

    it("refuses an oversized report before it reaches the DB", async () => {
      expect(
        await codeOf(caller.submitCookReport(report({ dom: "a".repeat(DOM_MAX_BYTES + 1) }))),
      ).toBe("BAD_REQUEST");
      expect(storeCookReport).not.toHaveBeenCalled();
    });
  });
});

describe("annotateCookReport", () => {
  it("sets the note on the stored report", async () => {
    await expect(
      caller.annotateCookReport({ id: REPORT_ID, note: "timer read 5 min, should be 8" }),
    ).resolves.toEqual({ id: REPORT_ID });
    expect(annotateCookReport).toHaveBeenCalledWith(HOME.id, REPORT_ID, "timer read 5 min, should be 8");
  });

  it("answers NOT_FOUND for an id the table doesn't hold (F9)", async () => {
    vi.mocked(annotateCookReport).mockResolvedValue(false);
    expect(await codeOf(caller.annotateCookReport({ id: REPORT_ID, note: "x" }))).toBe("NOT_FOUND");
  });

  it("takes a note of exactly 4 KB and refuses one byte more", async () => {
    await caller.annotateCookReport({ id: REPORT_ID, note: "n".repeat(NOTE_MAX_BYTES) });
    expect(
      await codeOf(caller.annotateCookReport({ id: REPORT_ID, note: "€".repeat(1366) })),
    ).toBe("BAD_REQUEST");
    expect(annotateCookReport).toHaveBeenCalledTimes(1);
  });

  it("refuses an id that is not a uuid", async () => {
    expect(await codeOf(caller.annotateCookReport({ id: "r001", note: "x" }))).toBe("BAD_REQUEST");
  });
});

describe("no public read (decision 7)", () => {
  it("the router has no procedure that returns reports", () => {
    const names = Object.keys(appRouter._def.procedures).filter((n) => /report/i.test(n));
    // `libraryPlanReport` (slice P) reports the library's cook plans, not cook reports.
    expect(names.sort()).toEqual(["annotateCookReport", "libraryPlanReport", "submitCookReport"]);
  });
});
