"use client";

import { useEffect, useLayoutEffect, useRef, useState, type ReactNode, type RefObject } from "react";
import Link from "next/link";
import { takeReturn } from "@/lib/kitchen/return-focus";
import { formatCircleDay } from "@/lib/kitchen/circle-format";
import type { CircleDishSummary } from "@/lib/circle-dishes";
import type { ShelfView } from "@/lib/shelf/view";
import {
  DISH_NAME_SIZES,
  footWord,
  subjectOf,
  thenLine,
} from "@/lib/kitchen/home-view";
import { FOCUS } from "./control-style";
import { COOKPACKS_HREF } from "./HomeFoot";
import { HomeRail } from "./HomeRail";
import { hrefOf, LABEL, type KitchenItem } from "./KitchenRows";
import { QueueScreen } from "./QueueScreen";
import { TimeLineWords } from "./TimeLineWords";
import { TimerNotices, useKitchenTimers, useNow } from "./KitchenTimers";
import { useHouseholdClock } from "./useHouseholdClock";
import { Clock, SoundOff } from "./TimerLine";

export type { KitchenItem } from "./KitchenRows";
export { LABEL, ROW_TAP, Row } from "./KitchenRows";
export { COOKPACKS_HREF };

/** The kitchen's words. */
export const KITCHEN_COPY = {
  name: "Kitchen",
  cookpacks: "Cookpacks",
  lead: "Pick up where you left off",
  also: "Also under way:",
  start: "Start",
  then: "Then",
  more: (n: number) => `${n} more`,
  timers: "Timers",
  idleEyebrow: "Nothing on the stove yet",
  idleHeading: "Find something for dinner",
  idleCta: "Explore Cookpacks & recipes",
  idleLine: "Nothing queued. Pick a book to start.",
  loading: { slow: "Still loading the kitchen…", offline: "Offline. Showing what was last kept." },
  empty: "No recipes queued. Import a recipe to see it here.",
  madeRecently: "Made recently:",
  addIngredients: "Add ingredients",
} as const;

interface KitchenHomeProps {
  /** Cooks under way, newest-queued first: the first is the lead. */
  cooking: KitchenItem[];
  /** What's queued, in queue order. */
  queue: KitchenItem[];
  /** Recently made, newest first. */
  recent: KitchenItem[];
  /** The shelf view when the kitchen is idle. */
  shelf?: ShelfView | null;
  /** Tapping the "Saved for later" note opens the ideas list. */
  onOpenSaved?: () => void;
  /** The flag's way to its panel, drawn on the rail while it has anything to say. */
  flagged?: ReactNode;
  /**
   * "How was it?" (`CookAskLine`, T2), while a cook finished today waits to
   * be rated. It is the subject while nothing is cooking.
   */
  ask?: ReactNode;
  /**
   * Whether the kitchen's reads have answered (D18). Until they have, the
   * rail draws and the body stays on the ground, so the idle state never
   * flashes before the queue arrives.
   */
  ready?: boolean;
  /**
   * Why the reads haven't all answered once the body draws: "slow" (online, still
   * waiting) or "offline" (shows what was last kept).
   */
  loading?: "slow" | "offline" | null;
  onStart: (item: KitchenItem) => void;
  onRemove: (id: string) => void;
  onMarkDone: (id: string) => void;
  onTogglePrivate?: (id: string, isPrivate: boolean) => void;
  onCopyShareLink?: (id: string) => Promise<boolean> | boolean;
  circleDishes?: CircleDishSummary[];
  inCircle?: boolean;
  firstRunPrompt?: ReactNode;
  onOpenFeedback?: () => void;
  onOpenImport: () => void;
  onOpenAddIngredients?: () => void;
  onOpenShoppingList?: () => void;
  onOpenAsk?: () => void;
}

/** Names joined as a sentence joins them: "A", "A and B", "A, B and C". */
export function alsoUnderWay<T>(names: T[]): Array<T | string> {
  return names.flatMap((name, i) =>
    i === 0 ? [name] : [i === names.length - 1 ? " and " : ", ", name],
  );
}

export { ACTION, ACTION_AT_REST, FOCUS } from "./control-style";

/**
 * A word in a line of text that goes somewhere (the "Then" line, Also under
 * way): the name over a hairline of ink at 30% (v1.16), sand while pressed,
 * on an 80 cpx box that reaches up and down past the words for a finger.
 */
const WORD = `relative inline-flex min-h-[var(--target)] min-w-[var(--target)] justify-center cursor-pointer items-center rounded-[var(--radius-1)] px-[calc(6*var(--cpx))] align-middle transition-colors duration-[320ms] ease-[var(--ease)] active:bg-sand ${FOCUS}`;
const WORD_TEXT =
  "underline decoration-ink/[.3] decoration-1 underline-offset-[calc(6*var(--cpx))]";

/** What the body gives up, in order, while the subject doesn't fit (F6, F7). */
const GIVES = ["then", "also", "name-title", "name-chip"] as const;

function useBodyGives(frame: RefObject<HTMLDivElement | null>, gives: readonly string[], signature: string) {
  useLayoutEffect(() => {
    const root = frame.current;
    if (!root) return;
    const body = root.querySelector<HTMLElement>("[data-home-body]");
    if (!body) return;
    const over = () => body.scrollHeight > body.clientHeight + 0.5;
    const fit = () => {
      for (const give of gives) root.removeAttribute(`data-give-${give}`);
      for (const give of gives) {
        if (!over()) return;
        root.setAttribute(`data-give-${give}`, "");
      }
    };
    fit();
    const measure = () => {
      const subject = body.querySelector("[data-subject]");
      return `${body.clientWidth}x${body.clientHeight}|${subject?.clientHeight ?? 0}`;
    };
    let size = measure();
    const resize =
      typeof ResizeObserver === "undefined"
        ? null
        : new ResizeObserver(() => {
            const now = measure();
            if (now === size) return;
            fit();
            size = measure();
          });
    resize?.observe(body);
    const subject = body.querySelector("[data-subject]");
    if (subject) resize?.observe(subject);
    void document.fonts?.ready.then(fit);
    return () => resize?.disconnect();
  }, [frame, gives, signature]);
}

/** The most lines a dish's name takes before it steps down the scale (F5). */
const NAME_LINES = 2;

function useDishFit(ref: RefObject<HTMLHeadingElement | null>, text: string): number {
  const [size, setSize] = useState(0);
  useLayoutEffect(() => {
    const el = ref.current;
    if (!el) return;
    const measure = () => {
      const keep = { size: el.style.fontSize, display: el.style.display, clamp: el.style.getPropertyValue("-webkit-line-clamp") };
      el.style.display = "block";
      el.style.setProperty("-webkit-line-clamp", "none");
      let pick = DISH_NAME_SIZES.length - 1;
      for (let i = 0; i < DISH_NAME_SIZES.length; i++) {
        el.style.fontSize = DISH_NAME_SIZES[i]!;
        const line = parseFloat(getComputedStyle(el).lineHeight);
        if (el.scrollWidth <= el.clientWidth + 0.5 && Math.round(el.scrollHeight / line) <= NAME_LINES) {
          pick = i;
          break;
        }
      }
      el.style.fontSize = keep.size;
      el.style.display = keep.display;
      if (keep.clamp) el.style.setProperty("-webkit-line-clamp", keep.clamp);
      else el.style.removeProperty("-webkit-line-clamp");
      setSize(pick);
    };
    measure();
    let live = true;
    void document.fonts?.ready.then(() => live && measure());
    const observer = typeof ResizeObserver === "undefined" ? null : new ResizeObserver(measure);
    observer?.observe(el);
    return () => {
      live = false;
      observer?.disconnect();
    };
  }, [ref, text]);
  return size;
}

/** A dish's name integrated into the illustration clearing, stepping down the closed scale (F5). */
function DishName({
  name,
  tone,
  href,
  align = "left",
}: {
  name: string;
  tone: string;
  href?: string;
  align?: "left" | "center";
}) {
  const ref = useRef<HTMLHeadingElement>(null);
  const size = useDishFit(ref, name);
  const style = { fontSize: `min(${DISH_NAME_SIZES[size]}, var(--give-name-size, 1000px))` };
  const floor = size === DISH_NAME_SIZES.length - 1;
  return (
    <h2
      ref={ref}
      style={style}
      className={`${floor ? "line-clamp-2" : ""} max-w-full ${align === "center" ? "text-center" : "text-left"} font-[family-name:var(--font-display)] leading-[1.06] font-normal tracking-[-0.01em] [font-synthesis:none] [text-wrap:balance] ${tone}`}
    >
      {href ? (
        <a
          href={href}
          className={`inline-flex min-h-[var(--target)] min-w-[var(--target)] items-center rounded-[var(--radius-1)] py-[calc(4*var(--cpx))] transition-colors duration-[320ms] ease-[var(--ease)] active:bg-sand ${FOCUS}`}
        >
          {name}
        </a>
      ) : (
        name
      )}
    </h2>
  );
}

/**
 * Hand-drawn double-brush underline and right arrow in terracotta, built into
 * the illustration rather than a pill button.
 */
function HandInkedCallout({ label, compact = false }: { label: string; compact?: boolean }) {
  return (
    <span className="inline-flex flex-col items-start">
      <span
        className={`inline-flex items-center gap-[calc(10*var(--cpx))] whitespace-nowrap font-[family-name:var(--font-display)] ${
          compact
            ? "landscape:text-[length:calc(24*var(--cpx))] portrait:text-[length:calc(18*var(--cpx))]"
            : "text-[length:var(--type-chip)]"
        } leading-none font-normal tracking-[-0.01em] text-ember-700 [font-synthesis:none]`}
      >
        <span>{label}</span>
        <svg
          aria-hidden="true"
          viewBox="0 0 36 18"
          fill="none"
          stroke="currentColor"
          strokeWidth="2.2"
          strokeLinecap="round"
          strokeLinejoin="round"
          className="h-[0.65em] w-[1.3em] shrink-0 transition-transform duration-[320ms] ease-[var(--ease)] group-hover/cta:translate-x-1"
        >
          <path d="M2 9.5C11 8.8 21 9.2 32 9M25 3.5C28 6 31.5 8 33.5 9C31 10.5 27.8 12.8 25.2 15" />
        </svg>
      </span>
      <svg
        aria-hidden="true"
        viewBox="0 0 180 10"
        fill="none"
        stroke="currentColor"
        className="mt-[calc(3*var(--cpx))] h-[calc(7*var(--cpx))] w-full text-ember-700"
        preserveAspectRatio="none"
      >
        <path
          d="M2 4.5C45 2.2 118 3.8 178 3.2"
          strokeWidth="2.2"
          strokeLinecap="round"
        />
        <path
          d="M8 8.2C62 6.8 128 7.5 172 6.9"
          strokeWidth="1.2"
          strokeLinecap="round"
          opacity="0.7"
        />
      </svg>
    </span>
  );
}

/**
 * The kitchen home: a calm counter appliance surface with zero 4-corner text
 * clutter. The centerpiece is a botanical/culinary
 * risograph & ink illustration with the dish title, cook time, and hand-inked
 * Start action integrated directly into the illustration clearing, paired with
 * a right-edge appliance icon rail (`HomeRail`) that pulls out into a labeled
 * paper tab on long-press, drag, or tap.
 */
export function KitchenHome({
  cooking,
  queue,
  recent,
  shelf,
  onOpenSaved,
  flagged,
  ask,
  ready = true,
  loading = null,
  onStart,
  onRemove,
  onMarkDone,
  onTogglePrivate,
  onCopyShareLink,
  circleDishes,
  inCircle = false,
  firstRunPrompt,
  onOpenFeedback,
  onOpenImport,
  onOpenAddIngredients,
  onOpenShoppingList,
  onOpenAsk,
}: KitchenHomeProps) {
  const [queueOpen, setQueueOpen] = useState(false);
  const [lead, ...others] = cooking;
  const subject = subjectOf({ cooking: cooking.length, queued: queue.length, asking: Boolean(ask) });
  const isHomeAtRest = subject === "idle" || subject === "queue";
  const showCircleDishes =
    isHomeAtRest && Boolean(circleDishes && circleDishes.length > 0);
  const showFirstRunPrompt = isHomeAtRest && Boolean(firstRunPrompt);
  const hasSecondaryBand = showCircleDishes || showFirstRunPrompt;
  const clock = useHouseholdClock();
  const { timers, expired, dismiss, soundLocked, allowSound } = useKitchenTimers();
  const now = useNow(timers.length > 0);
  const clocks = [...timers].sort((a, b) => a.endsAtEpochMs - b.endsAtEpochMs);
  const soonest = clocks.find((t) => !expired.has(t.id))?.id ?? null;
  const titleTone = timers.length > 0 ? "text-ink" : "text-ember-700";
  const word = footWord({ queued: queue.length, cooking: cooking.length, recent: recent.length });
  const [top, ...rest] = queue;
  const then = thenLine(queue);

  // Back from the shelf or queue, focus lands on the rail icon that opened it.
  useEffect(() => {
    takeReturn();
  }, []);

  const frameRef = useRef<HTMLDivElement>(null);
  useBodyGives(
    frameRef,
    GIVES,
    [subject, queue.length, cooking.length, recent.length, clocks.length, top?.name ?? "", lead?.name ?? "", ready, loading ?? ""].join("|"),
  );

  const eyebrow = clock?.eyebrow ?? "Tonight";
  const queueCount = cooking.length > 0 && queue.length === 0 ? cooking.length : queue.length;

  return (
    <div
      ref={frameRef}
      data-kitchen-home
      className="group/home relative flex h-dvh [&[data-give-name-title]]:[--give-name-size:var(--type-title)] [&[data-give-name-chip]]:[--give-name-size:var(--type-chip)] flex-col overflow-hidden bg-ground font-[family-name:var(--font-text)] text-ink"
    >
      {/* Screen-reader landmark for the kitchen appliance home */}
      <h1 className="sr-only">{KITCHEN_COPY.name}</h1>

      <div className="relative min-h-0 flex-1 [container-type:size]">
        <div
          data-home-body
          className={`absolute inset-0 overflow-y-auto pr-[calc(96*var(--cpx))] pl-[var(--edge)]`}
        >
          {ready && (
            <div className={`flex ${hasSecondaryBand ? "min-h-full py-[var(--space-5)]" : "h-full"} flex-col items-center justify-center`}>
              <div
                data-subject
                className={`${subject === "ask" ? "mt-[var(--space-6)] mb-auto" : "my-auto"} flex w-full max-w-[calc(880*var(--cpx))] shrink-0 flex-col items-center gap-y-[var(--space-3)]`}
              >
                <TimerNotices />
                {clocks.length > 0 && (
                  <section
                    data-kitchen-timers
                    aria-label={KITCHEN_COPY.timers}
                    className="flex flex-wrap items-center justify-center gap-x-[var(--space-6)] gap-y-[var(--space-2)]"
                  >
                    {clocks.map((t) => (
                      <Clock
                        key={t.id}
                        timer={t}
                        now={now}
                        ember={expired.size === 0 && t.id === soonest}
                        size="title"
                        onDismiss={dismiss}
                      />
                    ))}
                    {soundLocked && <SoundOff onAllow={allowSound} />}
                  </section>
                )}

                {loading && (
                  <p data-home-status className={LABEL}>
                    {KITCHEN_COPY.loading[loading]}
                  </p>
                )}

                {/* 1. Cook under way: integrated into the meal illustration */}
                {subject === "cooking" && lead && (
                  <section
                    data-cooking-subject
                    aria-label={KITCHEN_COPY.lead}
                    className="relative flex w-full flex-col items-center"
                  >
                    <div
                      data-home-illustration="meal"
                      className="relative grid w-full max-w-[calc(760*var(--cpx))] place-items-center"
                    >
                      <img
                        src="/kitchen/home-meal.webp"
                        alt=""
                        aria-hidden="true"
                        className="pointer-events-none col-start-1 row-start-1 h-auto max-h-[min(72dvh,calc(520*var(--cpx)))] w-full object-contain mix-blend-multiply select-none"
                      />
                      {/* Integrated editorial overlay nestled in the illustration's clearing */}
                      <div className="z-10 col-start-1 row-start-1 flex w-full flex-col items-start justify-start self-start pr-[2%] landscape:pt-[19%] landscape:pl-[36%] portrait:pt-[22%] portrait:pl-[35%]">
                        <div className="w-full max-w-[calc(520*var(--cpx))]">
                          <DishName name={lead.name} tone={titleTone} href={hrefOf(lead)} />
                        </div>
                        {lead.times && (
                          <p className={`mt-[calc(2*var(--cpx))] ${LABEL}`}>
                            <TimeLineWords parts={lead.times} />
                          </p>
                        )}
                      </div>
                    </div>

                    {others.length > 0 && (
                      <p data-also className={`-mt-[calc(8*var(--cpx))] group-data-[give-also]/home:hidden ${LABEL}`}>
                        {KITCHEN_COPY.also}{" "}
                        {alsoUnderWay(
                          others.map((item) => (
                            <a key={item.id} href={hrefOf(item)} className={`${WORD} font-semibold text-ink`}>
                              <span className={WORD_TEXT}>{item.name}</span>
                            </a>
                          )),
                        )}
                      </p>
                    )}
                  </section>
                )}

                {/* 2. Post-cook "How was it?" prompt */}
                {subject === "ask" && <div className="w-full max-w-[calc(720*var(--cpx))] text-left">{ask}</div>}

                {/* 3. Queued dish: integrated into the meal illustration */}
                {subject === "queue" && top && (
                  <section data-queue-subject className="relative flex w-full flex-col items-center">
                    <div
                      data-home-illustration="meal"
                      className="relative grid w-full max-w-[calc(760*var(--cpx))] place-items-center"
                    >
                      <img
                        src="/kitchen/home-meal.webp"
                        alt=""
                        aria-hidden="true"
                        className="pointer-events-none col-start-1 row-start-1 h-auto max-h-[min(72dvh,calc(520*var(--cpx)))] w-full object-contain mix-blend-multiply select-none"
                      />
                      {/* Integrated editorial typography + non-pill hand-inked Start callout in the clearing */}
                      <div className="z-10 col-start-1 row-start-1 flex w-full flex-col items-start justify-start self-start pr-[2%] landscape:pt-[8%] landscape:pl-[36%] portrait:pt-[4%] portrait:pl-[35%]">
                        <p
                          data-eyebrow
                          className="min-h-[1lh] text-[length:calc(18*var(--cpx))] leading-tight font-semibold tracking-[0.06em] uppercase text-ink-soft"
                        >
                          {eyebrow}
                        </p>
                        <div className="mt-[calc(2*var(--cpx))] w-full max-w-[calc(520*var(--cpx))]">
                          <DishName name={top.name} tone="text-ink" />
                        </div>
                        {top.times && (
                          <p className={`mt-[calc(4*var(--cpx))] text-left ${LABEL}`}>
                            <TimeLineWords parts={top.times} />
                          </p>
                        )}
                        <button
                          type="button"
                          data-start
                          onClick={() => onStart(top)}
                          className={`group/cta mt-0 inline-flex min-h-[var(--target)] min-w-[var(--target)] cursor-pointer items-start rounded-[var(--radius-1)] bg-transparent px-[calc(4*var(--cpx))] pt-[calc(6*var(--cpx))] text-left transition-colors duration-[320ms] ease-[var(--ease)] active:bg-sand ${FOCUS}`}
                        >
                          <HandInkedCallout label={KITCHEN_COPY.start} />
                        </button>
                      </div>
                    </div>

                    {rest.length > 0 && (
                      <p
                        data-then
                        className={`-mt-[calc(12*var(--cpx))] flex flex-wrap items-center justify-center gap-x-[var(--space-3)] group-data-[give-then]/home:hidden ${LABEL}`}
                      >
                        <span>{KITCHEN_COPY.then}</span>
                        {then.next.map((item, i) => (
                          <button
                            key={item.id}
                            type="button"
                            data-then-start
                            onClick={() => onStart(item)}
                            className={`${WORD} text-ink ${i > 0 ? "portrait:hidden" : ""}`}
                          >
                            <span className={WORD_TEXT}>{item.name}</span>
                          </button>
                        ))}
                        {rest.length > 1 && (
                          <button type="button" data-then-more onClick={() => setQueueOpen(true)} className={`${WORD} landscape:hidden`}>
                            <span className={WORD_TEXT}>{KITCHEN_COPY.more(rest.length - 1)}</span>
                          </button>
                        )}
                        {then.more > 0 && (
                          <button type="button" data-then-more onClick={() => setQueueOpen(true)} className={`${WORD} portrait:hidden`}>
                            <span className={WORD_TEXT}>{KITCHEN_COPY.more(then.more)}</span>
                          </button>
                        )}
                      </p>
                    )}
                  </section>
                )}

                {/* 4. Idle kitchen: open cookbooks & ingredients illustration */}
                {subject === "idle" && !loading && (
                  <section
                    data-idle-subject
                    aria-label="Explore Cookpacks and recipes"
                    className="relative flex w-full flex-col items-center"
                  >
                    <div
                      data-home-illustration="idle"
                      className="relative grid w-full max-w-[calc(760*var(--cpx))] place-items-center"
                    >
                      <img
                        src="/kitchen/home-idle-cookbooks.webp"
                        alt=""
                        aria-hidden="true"
                        className="pointer-events-none col-start-1 row-start-1 h-auto max-h-[min(74dvh,calc(540*var(--cpx)))] w-full object-contain mix-blend-multiply select-none"
                      />
                      {/* Integrated callout nestled in the clearing of the open cookbooks & ingredients */}
                      <div className="z-10 col-start-1 row-start-1 flex w-full flex-col items-start justify-start self-start pr-[2%] text-left landscape:pt-[16%] landscape:pl-[38%] portrait:pt-[12%] portrait:pl-[37%]">
                        <p className="text-[length:calc(18*var(--cpx))] leading-tight font-semibold tracking-[0.06em] uppercase text-ink-soft">
                          {KITCHEN_COPY.idleEyebrow}
                        </p>
                        <h2 className="mt-[calc(4*var(--cpx))] font-[family-name:var(--font-display)] landscape:text-[length:var(--type-title)] portrait:text-[length:calc(34*var(--cpx))] leading-[1.08] font-normal text-ink [font-synthesis:none] [text-wrap:balance]">
                          {KITCHEN_COPY.idleHeading}
                        </h2>
                        <Link
                          href={COOKPACKS_HREF}
                          data-explore-cookpacks
                          className={`group/cta mt-[calc(4*var(--cpx))] inline-flex min-h-[var(--target)] min-w-[var(--target)] cursor-pointer items-start rounded-[var(--radius-1)] px-[calc(4*var(--cpx))] pt-[calc(10*var(--cpx))] text-left transition-colors duration-[320ms] ease-[var(--ease)] active:bg-sand ${FOCUS}`}
                        >
                          <HandInkedCallout label={KITCHEN_COPY.idleCta} compact />
                        </Link>
                      </div>
                    </div>

                    {shelf && shelf.ideas !== null && shelf.ideas > 0 && onOpenSaved && (
                      <button
                        type="button"
                        data-saved-for-later
                        onClick={onOpenSaved}
                        className={`-mt-[calc(10*var(--cpx))] ${WORD} ${LABEL} text-ink-soft hover:text-ink`}
                      >
                        <span className={WORD_TEXT}>Saved for later · {shelf.ideas}</span>
                      </button>
                    )}
                  </section>
                )}

                {showFirstRunPrompt && firstRunPrompt}

                {showCircleDishes && circleDishes && (
                  <section
                    data-circle-dishes
                    aria-label="Friends' kitchens"
                    className="mt-[var(--space-4)] w-full max-w-[calc(760*var(--cpx))] border-t border-ink/[.11] pt-[var(--space-3)]"
                  >
                    <div className="mb-[var(--space-2)] flex items-baseline justify-between gap-[var(--space-3)]">
                      <Link
                        href="/kitchen/circle"
                        className={`text-[length:var(--type-meta)] font-medium text-ink-soft hover:text-ink ${FOCUS}`}
                      >
                        Friends&apos; kitchens
                      </Link>
                      {circleDishes.length > 3 && (
                        <Link
                          href="/kitchen/circle"
                          className={`text-[length:var(--type-meta)] font-medium text-ink-soft ${WORD_TEXT} hover:text-ink ${FOCUS}`}
                        >
                          See all ({circleDishes.length})
                        </Link>
                      )}
                    </div>
                    <ul className="flex flex-col gap-y-[calc(4*var(--cpx))]">
                      {circleDishes.slice(0, 3).map((dish) => (
                        <li
                          key={dish.logId}
                          data-circle-dish={dish.logId}
                          className="flex flex-wrap items-baseline gap-x-[calc(10*var(--cpx))] gap-y-[calc(2*var(--cpx))] py-[calc(4*var(--cpx))] text-[length:var(--type-meta)] leading-snug text-ink-soft"
                        >
                          {dish.canOpenRecipe ? (
                            <Link
                              href={`/kitchen/circle/dish/${dish.logId}`}
                              className={`inline-flex min-h-[var(--target)] items-center rounded-[var(--radius-1)] font-medium text-ink ${WORD_TEXT} active:bg-sand ${FOCUS}`}
                            >
                              {dish.recipeTitle}
                            </Link>
                          ) : (
                            <span className="font-medium text-ink">{dish.recipeTitle}</span>
                          )}
                          <span>{dish.kitchenName}</span>
                          <span>{formatCircleDay(dish.cookedDay)}</span>
                          {dish.note && (
                            <span className="max-w-[calc(340*var(--cpx))] truncate">{dish.note}</span>
                          )}
                        </li>
                      ))}
                    </ul>
                  </section>
                )}
              </div>
            </div>
          )}
        </div>
      </div>

      {/* Right-edge appliance icon rail + pull-out labeled paper tab */}
      <HomeRail
        cookpacks={KITCHEN_COPY.cookpacks}
        word={word}
        queueCount={queueCount}
        ready={ready}
        onOpenQueue={() => setQueueOpen(true)}
        onOpenImport={onOpenImport}
        onOpenAddIngredients={onOpenAddIngredients}
        onOpenShoppingList={onOpenShoppingList}
        onOpenSaved={onOpenSaved}
        onOpenAsk={onOpenAsk}
        inCircle={inCircle}
        onOpenFeedback={onOpenFeedback}
        addIngredientsLabel={KITCHEN_COPY.addIngredients}
        flagged={flagged}
      />

      {queueOpen && (
        <QueueScreen
          cooking={cooking}
          queue={queue}
          recent={recent}
          onStart={onStart}
          onRemove={onRemove}
          onMarkDone={onMarkDone}
          onTogglePrivate={onTogglePrivate}
          onCopyShareLink={onCopyShareLink}
          onClose={() => setQueueOpen(false)}
        />
      )}
    </div>
  );
}
