import { describe, expect, it } from "vitest";
import { CookReportInputSchema, type CookReportInput } from "./cook-reports";
import { PreNCookReportInputSchema } from "./cook-reports.pre-n";

function makeValidReport(overrides?: Partial<CookReportInput>): CookReportInput {
  return {
    id: "0f8fad5b-d9cb-469f-a165-70867728950e",
    capturedAt: "2026-10-09T10:00:00.000Z",
    build: "test-build-1",
    path: "/kitchen/queue/4b1d6f9e-8a51-4c43-9d7c-5a0c2f3e1b2a",
    screen: "step",
    queueId: "4b1d6f9e-8a51-4c43-9d7c-5a0c2f3e1b2a",
    recipeName: "Dal",
    stepKey: "s1",
    chapterId: "batch:s1",
    planVersion: 1,
    plan: { tasks: [{ id: "s1", text: "Rinse dal" }] },
    state: {
      mode: "first",
      pos: 1,
      ticked: [],
      passed: [],
      kept: [],
    },
    context: {
      viewport: { w: 1280, h: 800, dpr: 1 },
      ua: "Mozilla/5.0",
      online: true,
      voice: { mode: "always", status: "listening" },
      ask: { sessionId: "session-1", open: false },
      layers: {
        pane: false,
        card: null,
        more: false,
        level: 1,
        read: false,
      },
      part: null,
    },
    events: [
      {
        at: "2026-10-09T10:00:00.000Z",
        kind: "voice",
        detail: "next",
      },
    ],
    dom: "<div>step content</div>",
    domTruncated: false,
    note: "",
    ...overrides,
  };
}

describe("cook-reports schema compatibility (Step 15, N13)", () => {
  it("parses N-shape report at each level (0, 1, 2, 3) under both schemas", () => {
    const levels: (0 | 1 | 2 | 3)[] = [0, 1, 2, 3];

    for (const level of levels) {
      const report = makeValidReport({
        screen: level === 3 ? "whole-cook" : "step",
        context: {
          viewport: { w: 1280, h: 800, dpr: 1 },
          ua: "Mozilla/5.0",
          online: true,
          voice: { mode: "always", status: "listening" },
          ask: { sessionId: "session-1", open: false },
          layers: {
            pane: false,
            card: null,
            more: false,
            level,
            read: false,
          },
          part: null,
        },
      });

      // 1. Parses under pre-N schema (rollback safety): level is stripped by Zod
      const preNResult = PreNCookReportInputSchema.safeParse(report);
      expect(preNResult.success).toBe(true);
      if (preNResult.success) {
        expect(preNResult.data.context.layers).toEqual({
          pane: false,
          card: null,
          more: false,
        });
        // level was stripped
        expect("level" in preNResult.data.context.layers).toBe(false);
      }

      // 2. Parses under N schema: level is preserved
      const nResult = CookReportInputSchema.safeParse(report);
      expect(nResult.success).toBe(true);
      if (nResult.success) {
        expect(nResult.data.context.layers.level).toBe(level);
        expect(nResult.data.context.layers.read).toBe(false);
        expect(nResult.data.context.layers.pane).toBe(false);
        expect(nResult.data.context.layers.card).toBeNull();
      }
    }
  });

  it("parses N-shape report with read: true under both schemas", () => {
    const report = makeValidReport({
      context: {
        viewport: { w: 1280, h: 800, dpr: 1 },
        ua: "Mozilla/5.0",
        online: true,
        voice: { mode: "always", status: "listening" },
        ask: { sessionId: "session-1", open: false },
        layers: {
          pane: false,
          card: null,
          more: false,
          level: 2,
          read: true,
        },
        part: null,
      },
    });

    // Parses under pre-N schema
    const preNResult = PreNCookReportInputSchema.safeParse(report);
    expect(preNResult.success).toBe(true);

    // Parses under N schema with read preserved
    const nResult = CookReportInputSchema.safeParse(report);
    expect(nResult.success).toBe(true);
    if (nResult.success) {
      expect(nResult.data.context.layers.read).toBe(true);
      expect(nResult.data.context.layers.level).toBe(2);
    }
  });

  it("parses pre-N report (pane open, card on pane, no level or read) under N schema", () => {
    const preNReport = {
      id: "0f8fad5b-d9cb-469f-a165-70867728950e",
      capturedAt: "2026-10-09T10:00:00.000Z",
      build: "pre-n-build",
      path: "/kitchen/queue/4b1d6f9e-8a51-4c43-9d7c-5a0c2f3e1b2a",
      screen: "whole-cook" as const,
      queueId: "4b1d6f9e-8a51-4c43-9d7c-5a0c2f3e1b2a",
      recipeName: "Sunday Roast",
      stepKey: "cook-chicken",
      chapterId: "batch:roast",
      planVersion: 1,
      plan: { tasks: [{ id: "cook-chicken", text: "Roast chicken in oven" }] },
      state: {
        mode: "first",
        pos: 2,
        ticked: [],
        passed: [],
        kept: [],
      },
      context: {
        viewport: { w: 1280, h: 800, dpr: 1 },
        ua: "Mozilla/5.0",
        online: true,
        voice: { mode: "always" as const, status: "listening" },
        ask: { sessionId: "session-1", open: false },
        layers: {
          pane: true,
          card: "pane" as const,
          more: false,
        },
        part: null,
      },
      events: [
        {
          at: "2026-10-09T10:00:00.000Z",
          kind: "layer" as const,
          detail: "pane open",
        },
      ],
      dom: "<div>pane content</div>",
      domTruncated: false,
      note: "pre-n note",
    };

    // Pre-N schema parses it
    const preNResult = PreNCookReportInputSchema.safeParse(preNReport);
    expect(preNResult.success).toBe(true);

    // N schema parses it cleanly, with optional level and read undefined
    const nResult = CookReportInputSchema.safeParse(preNReport);
    expect(nResult.success).toBe(true);
    if (nResult.success) {
      expect(nResult.data.context.layers.pane).toBe(true);
      expect(nResult.data.context.layers.card).toBe("pane");
      expect(nResult.data.context.layers.level).toBeUndefined();
      expect(nResult.data.context.layers.read).toBeUndefined();
    }
  });
});

describe("the pre-N fixture is frozen (N13)", () => {
  it("copies prod's enums and caps rather than importing the live modules", async () => {
    const { readFileSync } = await import("node:fs");
    const src = readFileSync(new URL("./cook-reports.pre-n.ts", import.meta.url), "utf8");
    // Only zod comes in: a later change to report-capture or report-events can't move it.
    expect(src.match(/^import .* from "(.*)";$/gm)).toEqual(['import { z } from "zod";']);
    expect(src).toContain(
      'const REPORT_SCREENS = ["prep", "step", "all-steps", "ingredients", "info", "whole-cook"] as const;',
    );
  });

  it("refuses a screen prod doesn't know, so a new value would be lost on a rollback", () => {
    const report = makeValidReport({ screen: "step" });
    expect(PreNCookReportInputSchema.safeParse({ ...report, screen: "whole-recipe" }).success).toBe(false);
  });
});
