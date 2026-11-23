/**
 * The pre-N report schema, frozen as prod runs it: `app/src/lib/cook-reports.ts`
 * at f1738dcd (R27, live, and the build a rollback from N returns to), with
 * every enum and cap it imported copied in at that commit's values, so a later
 * change to `report-capture.ts` or `report-events.ts` can't move it (N13).
 * A test fixture only. NEVER EDIT THIS FILE: a schema change in prod gets a new
 * fixture beside it.
 */

import { z } from "zod";

// report-capture.ts at f1738dcd
const DOM_MAX_BYTES = 200 * 1024;
const NOTE_MAX_BYTES = 4 * 1024;
const PLAN_MAX_BYTES = 64 * 1024;
const REPORT_INPUT_MAX_BYTES = 320 * 1024;
const REPORT_SCREENS = ["prep", "step", "all-steps", "ingredients", "info", "whole-cook"] as const;
const encoder = new TextEncoder();
function byteLength(text: string): number {
  return encoder.encode(text).length;
}
function jsonBytes(value: unknown): number {
  return byteLength(JSON.stringify(value ?? null));
}

// report-events.ts at f1738dcd
const REPORT_EVENT_KINDS = ["cook", "step", "layer", "voice", "ask", "error", "flag"] as const;
const EVENT_CAPACITY = 50;
const EVENT_MAX_BYTES = 1024;

// cook-reports.ts at f1738dcd
const DEPLOY_CHECK_SCREEN = "deploy-check";

const withinBytes = (max: number) => (text: string) => byteLength(text) <= max;

const IdList = z.array(z.string().max(128)).max(1000);

const EventSchema = z
  .object({
    at: z.string().max(40),
    kind: z.enum(REPORT_EVENT_KINDS),
    detail: z.string(),
  })
  .refine((event) => jsonBytes(event) <= EVENT_MAX_BYTES, {
    message: `an event is at most ${EVENT_MAX_BYTES} bytes`,
  });

export const PreNNoteSchema = z
  .string()
  .refine(withinBytes(NOTE_MAX_BYTES), { message: `a note is at most ${NOTE_MAX_BYTES} bytes` });

export const PreNCookReportInputSchema = z
  .object({
    id: z.uuid(),
    capturedAt: z.iso.datetime(),
    build: z.string().min(1).max(128),
    path: z.string().max(2048),
    screen: z.enum([...REPORT_SCREENS, DEPLOY_CHECK_SCREEN]),
    queueId: z.uuid().nullable(),
    recipeName: z.string().max(500),
    stepKey: z.string().max(256).nullable(),
    chapterId: z.string().max(256).nullable(),
    planVersion: z.number().int().nullable(),
    plan: z
      .unknown()
      .transform((plan) => plan ?? null)
      .refine((plan) => jsonBytes(plan) <= PLAN_MAX_BYTES, {
        message: `a plan is at most ${PLAN_MAX_BYTES} bytes`,
      }),
    state: z.object({
      mode: z.string().max(16),
      pos: z.number().int(),
      ticked: IdList,
      passed: IdList,
      kept: IdList,
    }),
    context: z.object({
      viewport: z.object({ w: z.number(), h: z.number(), dpr: z.number() }),
      ua: z.string().max(512),
      online: z.boolean(),
      voice: z.object({
        mode: z.enum(["always", "tap"]).nullable(),
        status: z.string().max(32),
      }),
      ask: z.object({ sessionId: z.string().max(200), open: z.boolean() }),
      layers: z.object({
        pane: z.boolean(),
        card: z.enum(["pane", "screen"]).nullable(),
        more: z.boolean(),
      }),
      part: z.object({ at: z.number().int(), of: z.number().int() }).nullable(),
    }),
    events: z.array(EventSchema).max(EVENT_CAPACITY),
    dom: z
      .string()
      .refine(withinBytes(DOM_MAX_BYTES), { message: `the DOM is at most ${DOM_MAX_BYTES} bytes` }),
    domTruncated: z.boolean(),
    note: PreNNoteSchema,
  })
  .refine((report) => jsonBytes(report) <= REPORT_INPUT_MAX_BYTES, {
    message: `a report is at most ${REPORT_INPUT_MAX_BYTES} bytes`,
  });

export type PreNCookReportInput = z.infer<typeof PreNCookReportInputSchema>;
