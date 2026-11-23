"use client";

import { useCallback, useEffect, useLayoutEffect, useRef, useState, type RefObject } from "react";
import { useFlagMisses } from "@/hooks/useFlagMisses";
import { reportOutbox, useReportOutbox } from "@/hooks/useReportOutbox";
import { COOK_COPY } from "@/lib/kitchen/cook-view";
import { flagMisses, missCount, type FlagMisses, type MissLog } from "@/lib/kitchen/flag-misses";
import {
  NOTE_MAX_BYTES,
  insertToFit,
  type FlagStep,
  type ReportScreen,
} from "@/lib/kitchen/report-capture";
import { OUTBOX_CAP, type OutboxEntry, type ReportOutbox } from "@/lib/kitchen/report-outbox";
import { BACK_TO_KITCHEN, BorrowedScreen } from "./BorrowedScreen";
import { EDGE_X } from "./cook-edge";
import { MORE_COPY } from "./HeaderMore";
import { RING } from "./control-style";

/** How long an armed Clear waits for its second tap (as in the Player). */
export const CLEAR_ARM_MS = 4_000;

/** The panel's words (placeholder copy, DS §5 "The flag"). */
export const REPORTS_COPY = {
  kind: "Flagged",
  // Said once above the list (panel round 4): a sent flag opens to its note
  // on a tap, and one still to send has its note open in the margin.
  hint: "Tap a flag to say what read wrong.",
  placeholder: "What read wrong?",
  saved: "Saved",
  /** A note at the most it can keep, which the field takes no more past (LOW-2). */
  full: "No more room",
  waiting: "Waiting to send",
  /** The server refused the report as it was made: who, and that it won't go. */
  refused: "Refused by the server",
  /** What the cook can do about a refused flag: the server never takes it. */
  refusedNext: "It won't send. Flag that screen again if it still reads wrong, or dismiss this.",
  dismiss: "Dismiss",
  today: "Today",
  yesterday: "Yesterday",
  place: (step: FlagStep) => `Step ${String(step.n)} of ${String(step.of)}`,
  step: (step: FlagStep) => `Step ${String(step.n)} of ${String(step.of)}: ${step.name}`,
  over: (screen: string, under: string) => `${screen}, from ${under.charAt(0).toLowerCase()}${under.slice(1)}`,
  /** A row's moment: the time today, else its day too. */
  at: (day: string | null, time: string) => (day === null ? time : `${day}, ${time}`),
  sentCount: (n: number) => `${String(n)} sent`,
  /** Clear's name; it shows "Clear" beside the rule's count. */
  clear: (n: number) => (n === 0 ? "Clear sent" : `Clear ${String(n)} sent`),
  clearShort: "Clear",
  clearArmed: (n: number) => `Tap again to clear ${String(n)} sent`,
  entry: (n: number) => `${String(n)} flagged ${n === 1 ? "screen" : "screens"}`,
  /** Flags the tablet couldn't keep since the page loaded (panel round 4). */
  notKept: (n: number) => `${String(n)} not kept`,
  /** Why, said once at the panel's top. */
  missed: (misses: FlagMisses): string[] => [
    ...(misses.failed > 0
      ? [`${flagsOf(misses.failed)} not kept: the tablet couldn't store ${misses.failed === 1 ? "it" : "them"}.`]
      : []),
    ...(misses.full > 0
      ? [`${flagsOf(misses.full)} not kept: the tablet already held ${String(OUTBOX_CAP)} waiting to send.`]
      : []),
  ],
  empty: "Nothing flagged on this tablet.",
} as const;

function flagsOf(n: number): string {
  return `${String(n)} ${n === 1 ? "flag" : "flags"}`;
}

/** Each screen by the name the cook reads on it. */
const SCREEN_NAMES: Record<ReportScreen, string> = {
  prep: "Prep",
  step: "Step",
  "all-steps": "All steps",
  ingredients: "Ingredients",
  info: MORE_COPY.info,
  "whole-cook": COOK_COPY.wholeRecipe,
};

/**
 * The panel's reading width, the library's; in landscape the margin beside
 * the line widens it (panel round 4), and the library's rows take it too
 * (V fix round 1, item 6).
 */
export const WIDTH = "max-w-3xl lg:max-w-[76rem]";

/** The meta style the cook screen sets its meta in (DS §5): Figtree 500, ink-soft. */
const META = "text-[17px] md:text-[19px] leading-[1.3] font-medium text-ink-soft";

/**
 * The list's fade at an end with more past it. It dissolves into space: the
 * list starts 20 px under the intro, and its foot is lifted clear of words
 * (`footClip`; fix round 2, item 4).
 */
export const FADE = 24;

/** When the flag was taken; `precise` adds seconds, for the accessible name only. */
function timeOf(entry: OutboxEntry, precise = false): string {
  return new Date(entry.capturedAt).toLocaleTimeString(undefined, {
    hour: "numeric",
    minute: "2-digit",
    ...(precise ? { second: "2-digit" as const } : {}),
  });
}

/** The tablet's calendar day of a moment, as a key. */
const dayKey = (at: Date) => `${String(at.getFullYear())}-${String(at.getMonth())}-${String(at.getDate())}`;

/** The day of a cook as its head says it: today, yesterday, else the date. */
export function dayOf(capturedAt: string, now = new Date()): string {
  const at = new Date(capturedAt);
  if (dayKey(at) === dayKey(now)) return REPORTS_COPY.today;
  const yesterday = new Date(now.getFullYear(), now.getMonth(), now.getDate() - 1);
  if (dayKey(at) === dayKey(yesterday)) return REPORTS_COPY.yesterday;
  return at.toLocaleDateString(undefined, { weekday: "short", month: "short", day: "numeric" });
}

/**
 * Where the cook stood, whole: the step by number and name, Prep, or a
 * borrowed screen over either. A flag stored before the outbox kept the step
 * (fix round 1b) names its screen alone. The field's accessible name.
 */
export function whereOf(entry: Pick<OutboxEntry, "screen" | "step">): string {
  const { screen, step } = entry;
  if (step === undefined) return SCREEN_NAMES[screen];
  const under = step === null ? SCREEN_NAMES.prep : REPORTS_COPY.step(step);
  return screen === "prep" || screen === "step"
    ? under
    : REPORTS_COPY.over(SCREEN_NAMES[screen], under);
}

/**
 * A row's subject, what the cook was reading (panel round 4): the step's line
 * as the screen drew it, quoted; a borrowed screen by its name; Prep. A flag
 * stored before the line was kept quotes the step's name, and one stored with
 * no step names its screen.
 */
function subjectOf({ screen, step }: OutboxEntry): string {
  if (step === undefined || (screen !== "prep" && screen !== "step")) return SCREEN_NAMES[screen];
  return step === null ? SCREEN_NAMES.prep : (step.line ?? step.name);
}

/** Where a row's subject stood: the step by number, or Prep under a borrowed screen. */
function placeOf({ screen, step }: OutboxEntry): string {
  if (step === undefined) return "";
  if (step !== null) return REPORTS_COPY.place(step);
  return screen === "prep" ? "" : SCREEN_NAMES.prep;
}

/** A row's moment: the time, and its day unless today. */
function momentOf(entry: OutboxEntry, now: Date): string {
  const day = dayOf(entry.capturedAt, now);
  return REPORTS_COPY.at(day === REPORTS_COPY.today ? null : day, timeOf(entry));
}

/** In the DB, note and all: what Clear may take from this tablet. */
const clearable = (entry: OutboxEntry): boolean =>
  entry.status === "sent" && entry.note === entry.sentNote;

/** One cook's flags: a recipe on one day, in the outbox's order. */
interface Cook {
  key: string;
  recipeName: string;
  day: string;
  entries: OutboxEntry[];
}

/** Rows grouped by cook, each group where its newest row falls. */
function cooksOf(entries: OutboxEntry[], now: Date): Cook[] {
  const cooks = new Map<string, Cook>();
  for (const entry of entries) {
    const key = `${entry.recipeName}\u0000${dayKey(new Date(entry.capturedAt))}`;
    const cook = cooks.get(key);
    if (cook) cook.entries.push(entry);
    else cooks.set(key, { key, recipeName: entry.recipeName, day: dayOf(entry.capturedAt, now), entries: [entry] });
  }
  return [...cooks.values()];
}

/**
 * Where the list's foot clips so its fade lies over no words (fix round 2,
 * item 4), given each line's top and bottom from the list's top and the
 * list's full height: the clip lifts to the top of any line the fade would
 * lie over, until none, but not above `floor`. Past the floor it tries the
 * `heads` alone, so at least no title is half erased; past that, it keeps
 * the full height.
 */
export function footClip(
  parts: readonly (readonly [number, number])[],
  full: number,
  fade: number,
  floor: number,
  heads: readonly (readonly [number, number])[] = [],
): number {
  if (full <= 0) return full;
  for (const over of [parts, heads]) {
    let clip = full;
    for (let moved = true; moved && clip >= floor; ) {
      moved = false;
      for (const [top, bottom] of over) {
        if (top < clip && bottom > clip - fade) {
          clip = top;
          moved = true;
        }
      }
    }
    if (clip >= floor) return clip;
  }
  return full;
}

/**
 * Where the list should come to rest so its top fade lies over space (fix
 * round 2, item 4), given its words' tops and bottoms and its rest points'
 * tops (`REST_POINTS`), from the list's top as it lies now: if a word lies
 * under the fade, the nearest rest point settles just under it; else, and
 * at either end, it stays (`null`). After a clear (`cleared`, fix round 3,
 * LOW-5) the end holds no more than the middle: the cook didn't leave the
 * list there, so it settles from the end too, to a rest point above.
 */
export function restAt(
  words: readonly (readonly [number, number])[],
  rests: readonly number[],
  scrollTop: number,
  max: number,
  fade: number,
  cleared = false,
): number | null {
  if (scrollTop <= 1 || (scrollTop >= max - 1 && !cleared)) return null;
  if (!words.some(([top, bottom]) => top < fade && bottom > 0)) return null;
  let best: number | null = null;
  for (const rest of rests) {
    const at = Math.min(max, Math.max(0, scrollTop + rest - fade));
    // From the end, a rest point below can't come up to the fade.
    if (cleared && Math.abs(at - scrollTop) < 1) continue;
    if (best === null || Math.abs(at - scrollTop) < Math.abs(best - scrollTop)) best = at;
  }
  return best === null || Math.abs(best - scrollTop) < 1 ? null : best;
}

/**
 * How much room past its last row the list keeps so that, scrolled to its
 * end, its top fade lies over space (panel round 4), given its words' tops
 * and bottoms from the top of what it holds and how far it scrolls without
 * that room: at its end the list stays where the cook took it (`restAt`), so
 * the end itself must be a place to rest, and the room lets it scroll on past
 * any word the fade would lie over. More than `cap` would show the cook a
 * gap for a line's sake: it keeps none, and a note taller than that runs
 * under the fade at the end (DS §5's one exception; verify round 5, LOW-5).
 * Keeping the cap instead would leave the fade over the same note, past the
 * gap.
 */
export function endRoom(
  words: readonly (readonly [number, number])[],
  max: number,
  fade: number,
  cap: number,
): number {
  if (max <= 1) return 0;
  let end = max;
  for (let moved = true; moved && end - max <= cap; ) {
    moved = false;
    for (const [top, bottom] of words) {
      if (top < end + fade && bottom > end) {
        end = bottom;
        moved = true;
      }
    }
  }
  return end - max <= cap ? end - max : 0;
}

/**
 * Where the list should stand for the control the keyboard is in to lie
 * whole and clear of the fades (fix round 3, M3), given the control's top and
 * bottom from the list's top as it lies now and the list's height: it moves
 * as little as brings the control clear, its top first if it can't be both;
 * else, or at an end where no fade is drawn, it stays (`null`).
 */
export function keepClear(
  top: number,
  bottom: number,
  scrollTop: number,
  max: number,
  height: number,
  fade: number,
): number | null {
  let at = scrollTop;
  if (bottom > height - (scrollTop < max - 1 ? fade : 0)) at += bottom - (height - fade);
  const raised = top - (at - scrollTop);
  if (raised < 0 || (raised < fade && at > 1)) at = scrollTop + top - fade;
  at = Math.min(max, Math.max(0, at));
  return Math.abs(at - scrollTop) < 1 ? null : at;
}

/** The control in the list the keyboard is in: a field, or a control reached by Tab. */
function focusIn(box: HTMLElement): HTMLElement | null {
  const el = document.activeElement;
  return el instanceof HTMLElement && el !== box && box.contains(el) && el.matches(":focus-visible") ? el : null;
}

/**
 * Where the list's words lie: each line of text, each solid control or rule
 * (`data-report-solid`), and the lines of each field holding a note (its box
 * less its padding). An empty field or the gap between rows is space a fade
 * may lie over.
 */
export function wordsIn(box: HTMLElement): DOMRect[] {
  const lines: DOMRect[] = [];
  const walk = document.createTreeWalker(box, NodeFilter.SHOW_TEXT);
  const range = document.createRange();
  for (let node = walk.nextNode(); node !== null; node = walk.nextNode()) {
    if ((node.textContent ?? "").trim() === "") continue;
    range.selectNodeContents(node);
    lines.push(...range.getClientRects());
  }
  // A solid control or rule is as much a thing a fade mustn't cut as a word
  // (panel round 4: Clear's pill above the ledge, the rule's hairline).
  for (const solid of box.querySelectorAll("[data-report-solid]")) lines.push(solid.getBoundingClientRect());
  for (const field of box.querySelectorAll("textarea")) {
    if (field.value === "") continue;
    const r = field.getBoundingClientRect();
    const pad = getComputedStyle(field);
    const top = r.top + parseFloat(pad.paddingTop);
    lines.push(new DOMRect(r.left, top, r.width, r.bottom - parseFloat(pad.paddingBottom) - top));
  }
  return lines;
}

/** Where the list may come to rest: a cook's head, the rule, a row after a cook's first. */
const REST_POINTS = "[data-report-rest], [data-report-card]:not(:first-child)";

/** The share of the list's height its foot may give up to clear the fade. */
export const MAX_LIFT = 0.4;

/**
 * Whether a scroller has more past its top and its foot, kept as it scrolls,
 * resizes, grows a row or gets its fonts (ChapterRow's `useOverflowEnds`,
 * on the other axis); and, at rest, where it settles so its top fade lies
 * over space (`restAt`) and how far its foot lifts so the foot's fade does
 * (`footClip`), and the room it keeps past its end so the end, where it
 * stays, is a place to rest too (`endRoom`). They are measured on opening,
 * on a resize and when a scroll ends, never mid-scroll; scrolled to the end
 * there is no foot fade, and no lift. The list never moves for a row that changes under it: it settles
 * only when a scroll ends, or after a clear (`afterClear`, which the clear
 * calls; fix round 3, LOW-5). While the keyboard is in the list, the
 * control it is in is the anchor (fix round 3, M3): on focus, a scroll's end
 * or a resize the list moves only as far as brings that control whole and
 * clear of the fades (`keepClear`), and the foot doesn't lift over it; when
 * the keyboard leaves the list, it settles as at a scroll's end.
 */
function useScrollEnds(ref: RefObject<HTMLElement | null>, content: string) {
  const [ends, setEnds] = useState({ above: false, below: false, lift: 0, room: 0 });
  // Set by a clear, and spent by the measure that follows its rows' change.
  const cleared = useRef(false);
  const afterClear = useCallback(() => {
    cleared.current = true;
  }, []);
  useEffect(() => {
    const box = ref.current;
    if (!box) return;
    const measure = (relift: boolean) => {
      const above = box.scrollTop > 1;
      const below = box.scrollTop + box.clientHeight < box.scrollHeight - 1;
      // A new lift and end room, or `null` to keep the ones set.
      let next: number | null = null;
      let room: number | null = null;
      if (relift) {
        // The list's height is short by the lift as drawn, and its scroll
        // long by the end room drawn; ones set but not yet drawn haven't
        // moved either.
        const full = box.clientHeight + (parseFloat(box.style.marginBottom) || 0);
        const top = box.getBoundingClientRect().top;
        const span = (r: DOMRect) => [r.top - top, r.bottom - top] as const;
        const words = wordsIn(box).map(span);
        const drawn = box.querySelector<HTMLElement>("[data-report-room]")?.offsetHeight ?? 0;
        room = endRoom(
          words.map(([a, b]) => [a + box.scrollTop, b + box.scrollTop] as const),
          box.scrollHeight - drawn - full,
          FADE,
          full * MAX_LIFT,
        );
        if (below && !focusIn(box)) {
          next =
            full -
            footClip(
              words,
              full,
              FADE,
              full * (1 - MAX_LIFT),
              [...box.querySelectorAll("[data-report-head]")].map((el) => span(el.getBoundingClientRect())),
            );
        }
      }
      if (!below || (relift && focusIn(box))) next = 0;
      setEnds((was) => {
        const lift = next ?? was.lift;
        const end = room ?? was.room;
        return was.above === above && was.below === below && was.lift === lift && was.room === end
          ? was
          : { above, below, lift, room: end };
      });
    };
    const settle = () => measure(true);
    const update = () => measure(false);
    // A scroll that ends with a word under the top fade glides on to the
    // nearest rest point; its own end then measures. With the keyboard in the
    // list, the control it is in decides instead, and the foot lets go of it
    // first.
    const rest = (fromClear = false) => {
      const top = box.getBoundingClientRect().top;
      const focused = focusIn(box);
      let at: number | null;
      if (focused) {
        settle();
        const full = box.clientHeight + (parseFloat(box.style.marginBottom) || 0);
        const r = focused.getBoundingClientRect();
        at = keepClear(r.top - top, r.bottom - top, box.scrollTop, box.scrollHeight - full, full, FADE);
        if (at === null) return;
      } else {
        at = restAt(
          wordsIn(box).map((r) => [r.top - top, r.bottom - top] as const),
          [...box.querySelectorAll(REST_POINTS)].map((el) => el.getBoundingClientRect().top - top),
          box.scrollTop,
          box.scrollHeight - box.clientHeight,
          FADE,
          fromClear,
        );
        if (at === null) {
          settle();
          return;
        }
      }
      // A focused control is brought clear at once, as the browser brings it
      // into view: a glide there races the caret's own reveal, which can
      // stop it partway with no scroll end to finish it.
      const still = focused !== null || matchMedia("(prefers-reduced-motion: reduce)").matches;
      box.scrollTo({ top: at, behavior: still ? "instant" : "smooth" });
    };
    const ended = () => rest();
    // Focus leaving the list lets go of its anchor: it settles as at a scroll's end.
    const left = (e: FocusEvent) => {
      if (!(e.relatedTarget instanceof Node && box.contains(e.relatedTarget))) rest();
    };
    const resized = () => (focusIn(box) ? rest() : settle());
    if (cleared.current) {
      cleared.current = false;
      rest(true);
    } else settle();
    const resize = new ResizeObserver(resized);
    resize.observe(box.parentElement ?? box);
    const grow = new ResizeObserver(update);
    for (const child of box.children) grow.observe(child);
    box.addEventListener("scroll", update, { passive: true });
    box.addEventListener("scrollend", ended);
    box.addEventListener("focusin", ended);
    box.addEventListener("focusout", left);
    document.fonts.addEventListener("loadingdone", settle);
    return () => {
      resize.disconnect();
      grow.disconnect();
      box.removeEventListener("scroll", update);
      box.removeEventListener("scrollend", ended);
      box.removeEventListener("focusin", ended);
      box.removeEventListener("focusout", left);
      document.fonts.removeEventListener("loadingdone", settle);
    };
  }, [ref, content]);
  return { ends, afterClear };
}

/**
 * The reports panel (B2 decision 10, ported from the Player's): this
 * tablet's flags as a borrowed screen on the kitchen. Panel round 4 sets it
 * as a marked proof: each flag still to send quotes the line the cook was
 * reading, in the step's own weight, with the cook's note beside it in the
 * margin (under it, indented, in portrait). Those lead, above a hairline;
 * the sent sit below it under one head per cook (the recipe and the day, in
 * the display face), one line each, and open to their note on a tap. "N
 * sent" and Clear sit on the rule, so an armed Clear steps back one block
 * just under the control that armed it. A note saves when its field loses
 * focus or the panel goes, and goes to the DB with the report or after it. A
 * refused flag says so, in ink, with what the cook can do. Flags the tablet
 * couldn't keep at all are said once at the top, and let go as the panel
 * closes. Clear wants a second tap and takes only the rows it marked when
 * armed, and of those only what the DB holds whole, as the DB keeps
 * everything and a row it doesn't hold yet is the only copy.
 */
export function ReportsPanel({
  outbox = reportOutbox,
  misses = flagMisses,
  onClose,
}: {
  outbox?: () => ReportOutbox;
  misses?: MissLog;
  onClose: () => void;
}) {
  const entries = useReportOutbox(outbox);
  const missed = REPORTS_COPY.missed(useFlagMisses(misses));
  // The cook has read the misses once the panel goes, by the ledge or any
  // other way out (verify round 5, LOW-3): a route change unmounts it with
  // no close. The unmount's clear waits a microtask, as a development
  // remount (StrictMode) runs its cleanup with the panel still up.
  const close = () => {
    misses.clear();
    onClose();
  };
  const up = useRef(false);
  useEffect(() => {
    up.current = true;
    return () => {
      up.current = false;
      queueMicrotask(() => {
        if (!up.current) misses.clear();
      });
    };
  }, [misses]);

  // Text typed since the row's last save, keyed by id. A save clears it
  // (fix round 2, LOW-1), so a field shows what the outbox holds, a note
  // saved in another tab included, and a later save writes only new typing.
  const [drafts, setDrafts] = useState<Record<string, string>>({});
  const draftFor = (entry: OutboxEntry): string => drafts[entry.id] ?? entry.note;

  // What a row's field says at its edge: its note was saved since it was
  // last typed in (C6), or it is at the most a note keeps (LOW-2).
  const [notice, setNotice] = useState<Record<string, "saved" | "full">>({});

  // Saves every draft that differs from its row's note. Typing writes the
  // ref as well as the state, so a way out that outlives a render (unmount,
  // pagehide) saves the text as it is at that keystroke.
  const latest = useRef(drafts);
  const saveDrafts = useCallback((): void => {
    const typed = latest.current;
    if (Object.keys(typed).length === 0) return;
    const held = outbox().list();
    const kept: string[] = [];
    for (const [id, value] of Object.entries(typed)) {
      if (held.find((e) => e.id === id)?.note === value) continue;
      outbox().annotate(id, value);
      kept.push(id);
    }
    latest.current = {};
    setDrafts({});
    if (kept.length > 0) {
      setNotice((was) => ({ ...was, ...Object.fromEntries(kept.map((id) => [id, "saved" as const])) }));
    }
  }, [outbox]);

  // Every way out saves what is mid-edit (fix round 1, M2): a field taken off
  // the page never blurs, so Escape, the ledge and leaving the route would
  // otherwise drop it; pagehide covers the tab going away with the panel up.
  useEffect(() => {
    window.addEventListener("pagehide", saveDrafts);
    return () => {
      window.removeEventListener("pagehide", saveDrafts);
      saveDrafts();
    };
  }, [saveDrafts]);

  // An armed Clear holds the rows it marked when armed (fix round 2,
  // LOW-3): a row sent since isn't swept in. A marked row typed in leaves the
  // set for good (fix round 3, M2): its note is no longer the DB's, and once
  // it is again the cook still meant to keep it.
  const [armed, setArmed] = useState<ReadonlySet<string> | null>(null);
  const marked = (entry: OutboxEntry): boolean => armed !== null && armed.has(entry.id) && clearable(entry);

  // The sent row open to its note (panel round 4), one at a time. Opening
  // one puts the keyboard in its field.
  const [opened, setOpened] = useState<string | null>(null);
  const list = useRef<HTMLDivElement>(null);
  useEffect(() => {
    if (opened === null) return;
    const fields = list.current?.querySelectorAll<HTMLTextAreaElement>("textarea[data-report-field]") ?? [];
    [...fields].find((f) => f.dataset.reportField === opened)?.focus();
  }, [opened]);

  // Where a refused edit leaves the caret: a controlled field set to other
  // text than the edit made puts its caret at the end.
  const caret = useRef<{ field: HTMLTextAreaElement; at: number } | null>(null);
  useLayoutEffect(() => {
    if (caret.current === null) return;
    const { field, at } = caret.current;
    caret.current = null;
    field.setSelectionRange(at, at);
  });

  const type = (entry: OutboxEntry, field: HTMLTextAreaElement) => {
    // Past the room a note has, the field takes no more and says so, so what
    // it shows is what is kept (fix round 2, LOW-2): what it held stays
    // whole, and of an edit, only what fits goes in, at the caret (fix
    // round 3, M1).
    const { text, caret: at, cut } = insertToFit(
      latest.current[entry.id] ?? entry.note,
      field.value,
      field.selectionEnd,
      NOTE_MAX_BYTES,
    );
    if (text !== field.value) caret.current = { field, at };
    latest.current = { ...latest.current, [entry.id]: text };
    setDrafts(latest.current);
    setNotice((was) => {
      const rest = Object.fromEntries(Object.entries(was).filter(([id]) => id !== entry.id));
      return cut ? { ...rest, [entry.id]: "full" as const } : rest;
    });
    setArmed((was) => {
      if (was === null || !was.has(entry.id)) return was;
      const left = new Set(was);
      left.delete(entry.id);
      return left.size > 0 ? left : null;
    });
  };
  const toMark = entries.filter(marked);
  const toClear = entries.filter(clearable).length;

  // Armed with nothing left to take, it disarms, there and then, rather than
  // offer to clear none (set in render, so no frame shows it armed).
  const markedCount = toMark.length;
  if (armed !== null && markedCount === 0) setArmed(null);

  // An armed clear disarms itself: a destructive control must not lie in
  // wait through a kitchen's stray taps.
  useEffect(() => {
    if (armed === null) return;
    const timeout = setTimeout(() => setArmed(null), CLEAR_ARM_MS);
    return () => clearTimeout(timeout);
  }, [armed]);

  const onClear = () => {
    saveDrafts();
    if (armed === null) {
      const ids = outbox().list().filter(clearable).map((e) => e.id);
      if (ids.length > 0) setArmed(new Set(ids));
      return;
    }
    const ids = new Set(toMark.map((e) => e.id));
    setArmed(null);
    afterClear();
    outbox().clearSent(ids);
    if (outbox().list().length === 0) close();
  };

  const unsent = entries.filter((e) => e.status !== "sent");
  const sent = entries.filter((e) => e.status === "sent");
  const now = new Date();

  // The list opens at its top; past it, its clipped edge fades into space
  // rather than cutting a row against the intro or the foot (C4, item 4).
  // At rest its top settles on a head, the rule or a row, just under the
  // fade, and its foot lifts clear of words (`useScrollEnds`).
  const { ends, afterClear } = useScrollEnds(
    list,
    `${entries.map((e) => `${e.id}:${e.status}`).join()}|${opened ?? ""}|${missed.join()}`,
  );
  const mask =
    ends.above || ends.below
      ? `linear-gradient(to bottom, ${ends.above ? "transparent" : "#000"} 0, #000 ${String(FADE)}px, #000 calc(100% - ${String(FADE)}px), ${ends.below ? "transparent" : "#000"} 100%)`
      : undefined;

  // A row's note field, in the margin, in its row's ink. What it says sits at
  // the column's edge, in room the field keeps for it, so nothing moves when
  // it shows (item 8). The field stops short of that edge by its ring's reach
  // (6 px out, 1 px wide), so the ring closes on the edge, not past it, and
  // while the ring shows, what it says steps inside it (verify, craft round,
  // LOW-2).
  const field = (entry: OutboxEntry, ink = "text-ink") => {
    const shown = notice[entry.id];
    const said = `pointer-events-none absolute -right-[7px] bottom-0 animate-dot-in peer-focus-visible:right-0 ${META}`;
    return (
      <div className="relative mr-[7px]">
        <textarea
          data-report-field={entry.id}
          aria-label={`Note for ${[entry.recipeName.trim(), whereOf(entry), timeOf(entry, true)].filter((s) => s !== "").join(", ")}`}
          placeholder={REPORTS_COPY.placeholder}
          value={draftFor(entry)}
          onChange={(e) => type(entry, e.target)}
          onBlur={saveDrafts}
          // Unboxed, in the margin: the question in ink-soft until the cook
          // writes, and the note grows with what was typed so it reads
          // whole, in the list's own scroll. Its focus ring is a hairline's
          // weight, in ink (C6, P47), clear of the words. A hair of inset,
          // given back by the margin, keeps a first letter's overhang from
          // the field's clip where its column falls between pixels.
          className={`peer -ml-1 block min-h-16 w-[calc(100%+0.25rem)] resize-none field-sizing-content rounded-[var(--radius-2)] bg-transparent p-0 pb-8 pl-1 text-[17px] md:text-[19px] leading-[1.3] font-medium ${ink} transition-colors duration-[320ms] ease-[var(--ease)] placeholder:text-ink-soft focus-visible:outline-1 focus-visible:outline-offset-[6px] focus-visible:outline-ink`}
        />
        {shown === "saved" && (
          <span data-report-saved className={said}>
            {REPORTS_COPY.saved}
          </span>
        )}
        {shown === "full" && (
          <span data-report-full className={said}>
            {REPORTS_COPY.full}
          </span>
        )}
      </div>
    );
  };

  // A flag still to send, as a proof's marked line: who and when above, the
  // line quoted, and the note (or what a refusal means) in the margin.
  const proof = (entry: OutboxEntry) => {
    const refused = entry.status === "refused";
    const said = [placeOf(entry), momentOf(entry, now)].filter((s) => s !== "");
    // A flag with no recipe name opens on where it was: the dot only ever
    // stands between two things said.
    const named = entry.recipeName.trim() !== "";
    return (
      <li key={entry.id} data-report-card data-report-unsent className={`${ROW} gap-y-2`}>
        {/* Across both columns in landscape, as the margin is empty beside
            it: a status never wraps alone beside empty room. One line
            always: a name too long for it is cut after a word, and where,
            when and the status stay whole (verify, craft round). */}
        <p data-report-meta className={`flex min-w-0 items-baseline lg:col-span-full ${META}`}>
          {named && (
            <span data-report-name className="min-w-0 truncate">
              <Words text={entry.recipeName} />
            </span>
          )}
          <span className="shrink-0 whitespace-pre">
            {[...(named ? [""] : []), ...said, ""].join(" · ")}
            <span data-report-status className={refused ? REFUSED : ""}>
              {refused ? REPORTS_COPY.refused : REPORTS_COPY.waiting}
            </span>
          </span>
        </p>
        <p
          data-report-subject
          className="min-w-0 line-clamp-3 text-xl leading-snug font-semibold text-ink md:text-[22px] lg:col-start-1 lg:row-start-2"
        >
          {subjectOf(entry)}
        </p>
        <div data-report-margin className={`${MARGIN} mt-1 lg:mt-0 lg:row-start-2`}>
          {refused ? (
            // The server never takes a refused flag, so there is no note to
            // send: what the cook can do instead, and the way to let it go.
            <>
              {entry.note !== "" && <p className={`${NOTE} text-ink`}>{entry.note}</p>}
              <p className={`${entry.note === "" ? "" : "mt-2"} ${META}`}>{REPORTS_COPY.refusedNext}</p>
              <button type="button" onClick={() => outbox().dismiss(entry.id)} className={`mt-1 ${GHOST} ${AT_REST} -ml-5 px-5`}>
                {REPORTS_COPY.dismiss}
              </button>
            </>
          ) : (
            field(entry)
          )}
        </div>
      </li>
    );
  };

  // A sent flag, one line: the line it quotes, its time and its note if it
  // has one, each cut after a word, not inside one. A tap opens the note's field
  // in the margin, its first line where the note sat; the line closes it.
  // Marked by an armed Clear, it steps back to ink-soft, its field too.
  const ledger = (entry: OutboxEntry) => {
    const goes = marked(entry);
    const open = opened === entry.id;
    const note = draftFor(entry);
    const ink = goes ? "text-ink-soft" : "text-ink";
    const line = (
      <span className="flex min-w-0 items-baseline gap-4">
        <span data-report-subject className={`min-w-0 flex-1 truncate text-lg font-semibold md:text-xl ${ink}`}>
          <Words text={subjectOf(entry)} />
        </span>
        <span data-report-time className={`shrink-0 ${META}`}>
          {timeOf(entry)}
        </span>
      </span>
    );
    return (
      <li
        key={entry.id}
        data-report-card
        data-report-sent
        data-clears={goes ? "" : undefined}
        className={`${ROW} transition-colors duration-[320ms] ease-[var(--ease)]`}
      >
        <button
          type="button"
          aria-expanded={open}
          onClick={() => setOpened(open ? null : entry.id)}
          className={`${SENT_LINE} grid ${open ? "self-start lg:self-baseline" : "col-span-full lg:grid-cols-subgrid"}`}
        >
          {line}
          {!open && note !== "" && (
            <span data-report-note className={`${MARGIN} mt-1 truncate lg:mt-0 ${NOTE} ${ink}`}>
              <Words text={note} />
            </span>
          )}
        </button>
        {/* In landscape the note's first line keeps the line's baseline, as
            it did closed: the two share the row's first baseline, so no
            font's metrics are counted here (verify, craft round, LOW-4). */}
        {open && <div className={`${MARGIN} mt-1 lg:mt-0 lg:self-baseline`}>{field(entry, ink)}</div>}
      </li>
    );
  };

  const cooks = (rows: OutboxEntry[]) =>
    cooksOf(rows, now).map((cook) => (
      <section key={cook.key} data-report-cook className="mt-8 first:mt-0">
        <div data-report-rest className="flex items-baseline justify-between gap-4">
          <h3
            data-report-head
            className={`min-w-0 truncate font-[family-name:var(--font-display)] text-2xl font-normal [font-synthesis:none] md:text-[28px] transition-colors duration-[320ms] ease-[var(--ease)] ${cook.entries.every(marked) ? "text-ink-soft" : "text-ink"}`}
          >
            {cook.recipeName}
          </h3>
          <span className={`shrink-0 ${META}`}>{cook.day}</span>
        </div>
        <ul className="mt-2 space-y-1">{cook.entries.map(ledger)}</ul>
      </section>
    ));

  return (
    <BorrowedScreen kind={REPORTS_COPY.kind} back={BACK_TO_KITCHEN} onClose={close}>
      <div className={`shrink-0 ${EDGE_X}`}>
        <p className={`${META} ${WIDTH}`}>{REPORTS_COPY.hint}</p>
        {missed.map((line) => (
          <p key={line} data-report-missed className={`mt-1 ${NOTE} text-ink ${WIDTH}`}>
            {line}
          </p>
        ))}
      </div>

      <div
        ref={list}
        data-reports-list
        className={`mt-5 min-h-0 flex-1 overflow-y-auto pb-6 ${EDGE_X}`}
        style={{ maskImage: mask, WebkitMaskImage: mask, marginBottom: ends.lift || undefined }}
      >
        {entries.length === 0 ? (
          missed.length === 0 && <p className={`py-12 text-lg font-medium text-ink-soft ${WIDTH}`}>{REPORTS_COPY.empty}</p>
        ) : (
          <div className={WIDTH}>
            {unsent.length > 0 && <ul className="space-y-8">{unsent.map(proof)}</ul>}
            {sent.length > 0 && (
              // The rule is solid to the fades, as a word is: Clear's pill
              // and the hairline are never cut (panel round 4).
              <div data-report-rule data-report-rest data-report-solid className="mt-10 mb-6 flex items-center gap-4 first:mt-0">
                <span className={`shrink-0 ${META}`}>{REPORTS_COPY.sentCount(sent.length)}</span>
                <span aria-hidden className="h-px min-w-6 flex-1 bg-ink/[.11]" />
                <button
                  type="button"
                  onClick={onClear}
                  disabled={armed === null && toClear === 0}
                  aria-label={armed === null ? REPORTS_COPY.clear(toClear) : undefined}
                  data-armed={armed === null ? undefined : ""}
                  className={`${GHOST} justify-center ${armed === null ? `${AT_REST} -mr-6 px-6 disabled:cursor-not-allowed disabled:text-ink-soft` : "bg-ember px-6 text-paper active:bg-ember-700"}`}
                >
                  {armed === null ? REPORTS_COPY.clearShort : REPORTS_COPY.clearArmed(markedCount)}
                </button>
              </div>
            )}
            {cooks(sent)}
          </div>
        )}
        {ends.room > 0 && <div aria-hidden data-report-room style={{ height: ends.room }} />}
      </div>
    </BorrowedScreen>
  );
}

/**
 * A row's two columns (panel round 4): the line, and beside it, in
 * landscape, the margin its note sits in. In portrait the margin falls under
 * the line.
 */
const ROW = "grid gap-x-10 lg:grid-cols-[minmax(0,1fr)_24rem]";

/**
 * The margin: beside the line in landscape, indented under it in portrait,
 * behind a hairline. While its field shows its ring, the ring is the margin's
 * one edge, and the hairline steps out.
 */
const MARGIN =
  "ml-6 min-w-0 border-l border-ink/[.11] pl-5 has-[textarea:focus-visible]:border-transparent lg:col-start-2 lg:ml-0";

/**
 * Text for a one-line row whose ellipsis falls after a whole word, not inside
 * one (craft round): each word after the first is an atomic box, which an
 * ellipsis hides whole, carrying the space before it (kept, not collapsed at
 * the box's start) so none is left before the ellipsis. The first stays text,
 * so a word too long for the line alone is still cut, not dropped.
 */
function Words({ text }: { text: string }) {
  const [first, ...rest] = text.trim().split(/\s+/);
  return (
    <>
      {first}
      {rest.map((word, i) => (
        <span key={i} className="inline-block whitespace-pre">{` ${word}`}</span>
      ))}
    </>
  );
}

/** A note as written, at the meta's size; its ink is the row's. */
const NOTE = "text-[17px] md:text-[19px] leading-[1.3] font-medium";

/** A sent row's line: the whole row is its control, at a hand's height. */
const SENT_LINE =
  "min-h-12 min-w-0 cursor-pointer items-baseline rounded-[var(--radius-2)] py-2 text-left focus-visible:outline-3 focus-visible:outline-offset-3 focus-visible:outline-ink";

/**
 * "Refused by the server": said in ink, at weight, not ember (panel round
 * 4): a flag the server won't take is the cook's to read, not a hazard.
 */
const REFUSED = "font-semibold text-ink";

/**
 * The panel's controls, Clear on the rule and Dismiss under a refused flag:
 * one form (B2 review gap 7), the ledge's own type, 22 px, at a hand's height
 * (C5). At rest each is a ghost, words in ink with no fill, sand only while
 * pressed (V11). Its words sit on their column's edge, the press's room past
 * them: Dismiss's to its left, up to the margin's hairline and not over it;
 * Clear's to its right, so its words end in line with the rows' times. Armed, Clear alone is filled, ember at full
 * strength: a destructive tap's second press is the danger the palette keeps
 * ember for, and the borrowed screen's one ember.
 */
const GHOST =
  "inline-flex min-h-16 shrink-0 cursor-pointer items-center rounded-full text-[22px] leading-tight font-medium transition-colors duration-[320ms] ease-[var(--ease)] focus-visible:outline-3 focus-visible:outline-offset-3 focus-visible:outline-ink";
const AT_REST = "text-ink active:bg-sand";

/**
 * The kitchen's way to the panel: what it holds, drawn only while this
 * tablet holds flags or missed one, so the kitchen without them is as it
 * was. It names what it counts, flagged screens and any flag not kept (panel
 * round 4). It is one of the header's action words (V11, v1.16): ink-soft in
 * a hairline ring like its siblings, no fill at rest and no chevron. Stacked,
 * its ring rounds at the container radius around both lines. It sits in a
 * room of its own, the width the header's words leave, so they never move
 * for it (C7).
 */
export function FlaggedEntry({
  outbox = reportOutbox,
  misses = flagMisses,
}: {
  outbox?: () => ReportOutbox;
  misses?: MissLog;
}) {
  const entries = useReportOutbox(outbox);
  const lost = missCount(useFlagMisses(misses));
  const [open, setOpen] = useState(false);
  const parts = [
    ...(entries.length > 0 ? [REPORTS_COPY.entry(entries.length)] : []),
    ...(lost > 0 ? [REPORTS_COPY.notKept(lost)] : []),
  ];
  // Where the header is short of room, the label breaks between what it
  // counts, never inside one. Broken, it stacks what it counts, as a box
  // that wraps keeps the width it was offered, and the press's fill and the
  // ring would run on past its words (verify, craft round, LOW-1). Its room
  // is its parent, whose width the header sets and its words don't (V10).
  const label = useRef<HTMLButtonElement>(null);
  const [stacked, setStacked] = useState(false);
  const said = parts.join(" · ");
  useLayoutEffect(() => {
    const el = label.current;
    const room = el?.parentElement;
    if (!el || !room) return;
    const fit = () => {
      const style = getComputedStyle(el);
      const counts = [...el.children].map((c) => c.getBoundingClientRect().width);
      const pads = parseFloat(style.paddingLeft) + parseFloat(style.paddingRight);
      const width = counts.reduce((sum, w) => sum + w, 0) + parseFloat(style.columnGap) * (counts.length - 1) + pads;
      // In landscape the room is what the name and the words leave between
      // them on the name's line. Where even its widest count doesn't fit
      // there, the room takes a line of its own under them, as in portrait,
      // rather than its words running under theirs (R23's fourth word left
      // 1280×800 about 180 px). Read from the name and the words, which
      // don't move for it, so moving the room doesn't change the answer.
      const header = room.parentElement;
      const name = header?.querySelector("h1");
      const words = header?.querySelector("nav");
      let short = false;
      if (header && name && words && !matchMedia("(orientation: portrait)").matches) {
        const gap = parseFloat(getComputedStyle(header).columnGap) || 0;
        const inline = words.getBoundingClientRect().left - name.getBoundingClientRect().right - 2 * gap;
        short = Math.max(...counts) + pads > inline + 0.5;
      }
      room.toggleAttribute("data-room-short", short);
      setStacked(width > room.getBoundingClientRect().width);
    };
    fit();
    const resize = new ResizeObserver(fit);
    resize.observe(room);
    // The words' width sets the room too (Edit comes and goes with the queue).
    const words = room.parentElement?.querySelector("nav");
    if (words) resize.observe(words);
    document.fonts.addEventListener("loadingdone", fit);
    return () => {
      resize.disconnect();
      document.fonts.removeEventListener("loadingdone", fit);
      room.removeAttribute("data-room-short");
    };
  }, [said]);
  return (
    <>
      {parts.length > 0 && (
        <button
          ref={label}
          type="button"
          aria-label={said}
          onClick={() => setOpen(true)}
          className={`relative isolate inline-flex min-h-[var(--target)] min-w-0 cursor-pointer gap-x-[0.25em] px-[calc(24*var(--cpx))] text-left text-[length:var(--type-meta)] leading-tight font-medium text-ink-soft ${RING} before:inset-x-0 before:border-ink/[.2] ${
            stacked
              ? "flex-col items-start justify-center py-[calc(16*var(--cpx))] before:inset-y-[calc(6*var(--cpx))] before:rounded-[var(--radius-3)]"
              : "items-center before:inset-y-[calc(14*var(--cpx))] before:rounded-full"
          }`}
        >
          {parts.map((part, i) => (
            <span key={part} className="whitespace-nowrap">
              {i < parts.length - 1 ? `${part} ·` : part}
            </span>
          ))}
        </button>
      )}
      {open && <ReportsPanel outbox={outbox} misses={misses} onClose={() => setOpen(false)} />}
    </>
  );
}
