/**
 * One flagged moment, self-contained (B2 decisions 4 and 5; ported from
 * Player's `captureReport`): when, which build, the cook's committed state and
 * plan, which layers were open, what just happened, and the DOM as drawn.
 * State and markup, never pixels (DECISIONS 2026-08-12): the cook screen is
 * a function of its state, and class-level truth never shows in a screenshot.
 *
 * Pure over its inputs. The cook screen hands over a snapshot through a ref
 * (`useCookFlag`), so capture is synchronous at the flag and needs no stores.
 */

import type { VoiceMode } from "./voice-mode";
import type { VoiceStatus } from "@/hooks/useKitchenVoiceCommands";
import type { ReportEvent } from "./report-events";

/** The DOM a report carries is cut here (decision 4), in UTF-8 bytes. */
export const DOM_MAX_BYTES = 200 * 1024;

/** A note's cap (decision 8), in UTF-8 bytes. */
export const NOTE_MAX_BYTES = 4 * 1024;

/** A plan's cap as JSON (decision 8): a bigger one is left out of the report. */
export const PLAN_MAX_BYTES = 64 * 1024;

/** A whole report's cap as JSON (decision 8), note included. */
export const REPORT_INPUT_MAX_BYTES = 320 * 1024;

export const REPORT_SCREENS = [
  "prep",
  "step",
  "all-steps",
  "ingredients",
  "info",
  "whole-cook",
  "kitchen",
  "queue",
  "cookpacks",
  "import",
  "saved",
  "recipes",
  "cook-log",
  "shopping-list",
  "pantry",
  "circle",
  "settings",
  "other",
] as const;

/** Maps a `/kitchen/...` pathname to a `ReportScreen`. */
export function screenFromPath(pathname: string): ReportScreen {
  const path = pathname.replace(/\/+$/, "") || "/";
  if (path === "/kitchen") return "kitchen";
  if (path === "/kitchen/cookpacks/household-book") return "recipes";
  if (path.startsWith("/kitchen/cookpacks")) return "cookpacks";
  if (path.startsWith("/kitchen/cook-log")) return "cook-log";
  if (path.startsWith("/kitchen/circle") || path.startsWith("/kitchen/shared")) return "circle";
  if (path.startsWith("/kitchen/settings")) return "settings";
  return "other";
}

/** Where the cook was: the screen in hand, or what borrowed it. */
export type ReportScreen = (typeof REPORT_SCREENS)[number];

/** The cook session's committed state, as plain data. */
export interface ReportState {
  mode: string;
  pos: number;
  ticked: string[];
  passed: string[];
  kept: string[];
}

/** What the cook screen knows at the flag. */
/**
 * The step in hand at a flag, as the reports panel names its row: its place
 * among the steps (Prep not counted) and its name, as a glance says it with
 * no lead (fix round 1b, C3), and the line the screen drew for it, which the
 * row quotes (panel round 4). Null on Prep. A flag stored before round 4 has
 * no line, and its row quotes the name.
 */
export interface FlagStep {
  n: number;
  of: number;
  name: string;
  line?: string;
}

export interface CookSnapshot {
  queueId: string | null;
  recipeName: string;
  /** The plan as cooked: the queue row can be deleted, and recipes have no version. */
  plan: unknown;
  planVersion: number | null;
  state: ReportState;
  screen: ReportScreen;
  /** The step in hand's key ("prep" on Prep), and its chapter's id. */
  stepKey: string | null;
  chapterId: string | null;
  /** The part on show of a step that pages, counted from 1; null when it doesn't. */
  part: { at: number; of: number } | null;
  /** The whole cook's pane, a bar's card (and on which surface), More's menu, and look-ahead level/read (N13). */
  layers: {
    pane: boolean;
    card: "pane" | "screen" | null;
    more: boolean;
    level?: 0 | 1 | 2 | 3;
    read?: boolean;
  };
  voice: { mode: VoiceMode | null; status: VoiceStatus };
  /**
   * Ask's session id joins `conversation_logs`, where the conversation is
   * kept. This state holds none of its words. The captured DOM does, when the
   * flag is made with Ask open: the conversation as drawn, with a question
   * typed and not sent emptied and each photo's data left out (`serializeDom`;
   * DECISIONS 2026-11-22 "Ask Sous is a side panel", call 27).
   */
  ask: { sessionId: string; open: boolean };
  /** For the panel's row only: not part of the report, which holds the plan and state it comes from. */
  step: FlagStep | null;
}

export interface CaptureInputs {
  id: string;
  now: number;
  build: string;
  href: string;
  online: boolean;
  ua: string;
  viewport: { w: number; h: number; dpr: number };
  /** The cook root, serialized from a clone. */
  root: Element;
  cook: CookSnapshot;
  events: readonly ReportEvent[];
}

export interface ReportContext {
  viewport: { w: number; h: number; dpr: number };
  ua: string;
  online: boolean;
  voice: CookSnapshot["voice"];
  ask: CookSnapshot["ask"];
  layers: CookSnapshot["layers"];
  part: CookSnapshot["part"];
}

/** A report as it is stored on the tablet and sent: `cook_reports`' row, in camel case. */
export interface CookReport {
  id: string;
  capturedAt: string;
  build: string;
  path: string;
  screen: ReportScreen;
  queueId: string | null;
  recipeName: string;
  stepKey: string | null;
  chapterId: string | null;
  planVersion: number | null;
  plan: unknown;
  state: ReportState;
  context: ReportContext;
  events: ReportEvent[];
  dom: string;
  domTruncated: boolean;
  /** What the cook said was wrong, typed later on the hub (2026-08-12). */
  note: string;
}

const encoder = new TextEncoder();

export function byteLength(text: string): number {
  return encoder.encode(text).length;
}

/**
 * A value's size as the server measures it: UTF-8 bytes of its JSON, where a
 * quote or a backslash costs two bytes and a control character six.
 */
export function jsonBytes(value: unknown): number {
  return byteLength(JSON.stringify(value ?? null));
}

/** Bytes the text takes inside a JSON string, its own quotes left out. */
function escapedBytes(text: string): number {
  return jsonBytes(text) - 2;
}

/** A prefix length moved off the middle of a surrogate pair. */
function whole(text: string, n: number): number {
  const last = text.charCodeAt(n - 1);
  return last >= 0xd800 && last <= 0xdbff ? n - 1 : n;
}

/**
 * The text cut so its JSON-escaped form is at most `max` UTF-8 bytes, on a
 * whole character (fix round 1, LOW-8): what the client cuts is measured as
 * the server measures it. Cuts the longest prefix that fits, found by halving.
 */
export function cutToJsonBytes(text: string, max: number): { text: string; cut: boolean } {
  if (escapedBytes(text) <= max) return { text, cut: false };
  let fits = 0;
  let over = text.length;
  while (over - fits > 1) {
    const mid = Math.floor((fits + over) / 2);
    if (escapedBytes(text.slice(0, whole(text, mid))) <= max) fits = mid;
    else over = mid;
  }
  return { text: text.slice(0, whole(text, fits)), cut: true };
}

/**
 * A field's edit kept to `max` JSON bytes (fix round 3, M1): `was` is what the
 * field held, `now` what the edit made of it and `caret` where the edit left
 * the caret. What the field held stays whole; of what the edit put in at the
 * caret, only the part that fits goes in, on a whole character, and the caret
 * comes to rest after that part. An edit that doesn't grow the text is kept
 * as made, so an over-full note can still be cut down.
 */
export function insertToFit(
  was: string,
  now: string,
  caret: number,
  max: number,
): { text: string; caret: number; cut: boolean } {
  if (escapedBytes(now) <= max || escapedBytes(now) <= escapedBytes(was)) return { text: now, caret, cut: false };
  // What follows the caret is what followed the edit in `was`; failing
  // that, the longest end the two share.
  let tail = now.length - caret;
  if (tail < 0 || tail > was.length || now.slice(caret) !== was.slice(was.length - tail)) {
    tail = 0;
    while (tail < Math.min(was.length, now.length) && was[was.length - 1 - tail] === now[now.length - 1 - tail]) tail++;
  }
  let head = 0;
  while (head < Math.min(was.length, now.length) - tail && was[head] === now[head]) head++;
  const before = now.slice(0, head);
  const put = now.slice(head, now.length - tail);
  const after = now.slice(now.length - tail);
  const fits = (n: number) => escapedBytes(before + put.slice(0, n) + after) <= max;
  if (!fits(0)) return { text: was, caret: was.length - tail, cut: true };
  let kept = 0;
  let over = put.length;
  while (over - kept > 1) {
    const mid = Math.floor((kept + over) / 2);
    if (fits(whole(put, mid))) kept = mid;
    else over = mid;
  }
  kept = whole(put, kept);
  return { text: before + put.slice(0, kept) + after, caret: head + kept, cut: true };
}

/** Inputs whose value is the author's label, not something typed. */
const LABEL_INPUTS = new Set(["button", "submit", "reset", "image"]);

/**
 * Empties every place the cook types into (F12, fix round 1 M5): React writes
 * a controlled input's value to its attribute and a textarea's to its text, so
 * an unsent Ask question would otherwise ride in the markup. A field that held
 * words keeps a bare `data-capture-redacted`, so the reader knows it wasn't empty.
 */
function redactTyped(clone: Element): void {
  for (const input of clone.querySelectorAll("input")) {
    if (LABEL_INPUTS.has(input.type) || !input.getAttribute("value")) continue;
    input.removeAttribute("value");
    input.setAttribute("data-capture-redacted", "");
  }
  const editable = clone.querySelectorAll('textarea, [contenteditable]:not([contenteditable="false"])');
  for (const el of editable) {
    if (!el.textContent) continue;
    el.replaceChildren();
    el.setAttribute("data-capture-redacted", "");
  }
}

/**
 * Leaves out every picture carried in the markup itself (a `data:` address):
 * a photo the cook took for Ask Sous is a turn in the conversation (v1.60),
 * and it is the cook's kitchen, not the screen's state. It would also spend
 * the capture's bytes: one photo is larger than the whole cap. The picture's
 * element stays, with its `alt`, marked `data-capture-redacted`, so the
 * reader knows a photo stood there; the words around it stay.
 */
function redactPhotos(clone: Element): void {
  for (const img of clone.querySelectorAll("img")) {
    if (!img.getAttribute("src")?.trimStart().toLowerCase().startsWith("data:")) continue;
    img.removeAttribute("src");
    img.removeAttribute("srcset");
    img.setAttribute("data-capture-redacted", "");
  }
}

/**
 * The root's markup from a clone, with every `data-capture-omit` element left
 * out (the open More menu, so the report shows what was under it), every
 * typed word emptied and every photo's data left out, cut to `DOM_MAX_BYTES`
 * as JSON on a whole character. A
 * cut DOM still carries the state and events that rebuild the screen, so
 * cutting beats refusing.
 */
export function serializeDom(root: Element): { dom: string; truncated: boolean } {
  const clone = root.cloneNode(true) as Element;
  for (const el of clone.querySelectorAll("[data-capture-omit]")) el.remove();
  redactTyped(clone);
  redactPhotos(clone);
  const { text, cut } = cutToJsonBytes(clone.outerHTML, DOM_MAX_BYTES);
  return { dom: text, truncated: cut };
}

/** Data only: a snapshot handed over by reference is copied, not shared. */
function dataOnly<T>(value: T): T {
  return value === undefined ? value : (JSON.parse(JSON.stringify(value)) as T);
}

/**
 * The report as the server will take it (fix round 1, LOW-8): a plan over
 * `PLAN_MAX_BYTES` is left out (its version stays, and the queue row has the
 * rest), and the DOM is cut further while the whole, with room kept for the
 * longest note, would run past `REPORT_INPUT_MAX_BYTES`.
 */
export function buildReport(inputs: CaptureInputs): CookReport {
  const report = assemble(inputs);
  if (jsonBytes(report.plan) > PLAN_MAX_BYTES) report.plan = null;
  const over = jsonBytes(report) + NOTE_MAX_BYTES - REPORT_INPUT_MAX_BYTES;
  if (over > 0) {
    report.dom = cutToJsonBytes(report.dom, Math.max(0, escapedBytes(report.dom) - over)).text;
    report.domTruncated = true;
  }
  return report;
}

export interface PageCaptureInputs {
  id: string;
  now: number;
  build: string;
  href: string;
  screen: ReportScreen;
  note?: string;
  viewport: { w: number; h: number; dpr: number };
  ua: string;
  online: boolean;
  events: readonly ReportEvent[];
  root: Element;
}

/**
 * Builds a self-contained feedback report for any non-cook screen (`/kitchen`,
 * settings, cookpacks, circles, or modal overlays) within the server's caps.
 */
export function buildPageReport(inputs: PageCaptureInputs): CookReport {
  const { dom, truncated } = serializeDom(inputs.root);
  const note = cutToJsonBytes(inputs.note ?? "", NOTE_MAX_BYTES).text;
  const report: CookReport = {
    id: inputs.id,
    capturedAt: new Date(inputs.now).toISOString(),
    build: inputs.build,
    path: new URL(inputs.href).pathname,
    screen: inputs.screen,
    queueId: null,
    recipeName: "",
    stepKey: null,
    chapterId: null,
    planVersion: null,
    plan: null,
    state: { mode: "page", pos: 0, ticked: [], passed: [], kept: [] },
    context: {
      viewport: { ...inputs.viewport },
      ua: inputs.ua,
      online: inputs.online,
      voice: { mode: null, status: "unsupported" },
      ask: { sessionId: "", open: false },
      layers: { pane: false, card: null, more: false },
      part: null,
    },
    events: inputs.events.map((e) => ({ ...e })),
    dom,
    domTruncated: truncated,
    note,
  };
  const over = jsonBytes(report) + NOTE_MAX_BYTES - REPORT_INPUT_MAX_BYTES;
  if (over > 0) {
    report.dom = cutToJsonBytes(report.dom, Math.max(0, escapedBytes(report.dom) - over)).text;
    report.domTruncated = true;
  }
  return report;
}

function assemble(inputs: CaptureInputs): CookReport {
  const { cook } = inputs;
  const { dom, truncated } = serializeDom(inputs.root);
  return {
    id: inputs.id,
    capturedAt: new Date(inputs.now).toISOString(),
    build: inputs.build,
    path: new URL(inputs.href).pathname,
    screen: cook.screen,
    queueId: cook.queueId,
    recipeName: cook.recipeName,
    stepKey: cook.stepKey,
    chapterId: cook.chapterId,
    planVersion: cook.planVersion,
    plan: dataOnly(cook.plan),
    state: dataOnly(cook.state),
    context: {
      viewport: { ...inputs.viewport },
      ua: inputs.ua,
      online: inputs.online,
      voice: { ...cook.voice },
      ask: { ...cook.ask },
      layers: { ...cook.layers },
      part: cook.part ? { ...cook.part } : null,
    },
    events: inputs.events.map((e) => ({ ...e })),
    dom,
    domTruncated: truncated,
    note: "",
  };
}
