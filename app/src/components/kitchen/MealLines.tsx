"use client";

/**
 * The whole meal as lines and stations (look-ahead slice 2, DS v1.63): draws a
 * `LinesDrawing` from `meal-lines-layout`, in the columns form (a line per
 * dish) or the list form (portrait, and any one-dish meal). Pure drawing: the
 * layout has placed every word, dot and line in px; this sets them down.
 *
 * Stops are buttons only where `onRead` is given (level 2): a tap reads the
 * step in the header's place, as touch-to-read always has. On the opening
 * they are not controls (DS §6 Starting: the opening's reading stays off).
 *
 * On the pull from the peek each part is moved by `pull-paint`, found
 * by its `data-line-*` name, in the drawing's order.
 */

import type { ColumnsDrawing, DrawnStop, LinesDrawing, ListDrawing } from "@/lib/kitchen/meal-lines-layout";
import { LINES_TYPE } from "@/lib/kitchen/meal-lines-layout";
import type { Measure } from "@/lib/kitchen/sheet-layout";

const FOCUS = "outline-none focus-visible:outline-3 focus-visible:outline-offset-2 focus-visible:outline-ink";
/** A dish waiting: ink at 27% into the paper (the drawing's pale line). */
const PALE = "color-mix(in oklab, var(--ink) 27%, var(--paper))";
const HAIR = "color-mix(in oklab, var(--ink) 11%, var(--paper))";

export interface MealLinesProps {
  drawing: LinesDrawing;
  /** One counter px, in px. */
  c: number;
  /** Level 2: a stop tapped reads it (the same key again puts the read away). Null on the opening. */
  onRead: ((key: string | null) => void) | null;
  readMark: string | null;
  tab: number;
  /** The surface under the drawing: the opening stands on the Ground, the whole cook on the Paper. */
  ground?: boolean;
}

let canvas: CanvasRenderingContext2D | null | undefined;
/**
 * Text widths on the page's own faces (Figtree, Caprasimo), for one layout pass: a fresh cache each
 * call, so a pass after the fonts load measures them and not the fallback.
 */
export function pageMeasure(): Measure {
  if (canvas === undefined) canvas = typeof document !== "undefined" ? document.createElement("canvas").getContext("2d") : null;
  const ctx = canvas;
  if (!ctx) throw new Error("no 2d canvas to measure the meal's lines");
  const cache = new Map<string, number>();
  return (text, px, weight, family = "text") => {
    const key = `${family}\0${weight}\0${px}\0${text}`;
    const hit = cache.get(key);
    if (hit !== undefined) return hit;
    ctx.font = `${weight} ${px}px ${family === "display" ? "Caprasimo" : "Figtree"}`;
    const w = ctx.measureText(text).width;
    cache.set(key, w);
    return w;
  };
}

export function MealLines(props: MealLinesProps) {
  return props.drawing.form === "columns" ? <Columns {...props} drawing={props.drawing} /> : <List {...props} drawing={props.drawing} />;
}

/** A stop's words as drawn: the step in hand ember 600; a job for the hands ink 500 (the list's rows, the peek's 600); a pot ink-soft 500. */
function stopColor(s: { state: DrawnStop["state"]; pot: boolean }, list = false) {
  if (s.state === "now") return "text-[color:var(--ember-700)] font-semibold";
  if (s.pot) return "text-ink-soft font-medium";
  return list ? "text-ink font-semibold" : "text-ink font-medium";
}

/** A stop's touch: a button at level 2, nothing on the opening. */
function Target({
  k,
  mark,
  state,
  pot,
  said,
  box,
  onRead,
  readMark,
  tab,
}: {
  k: string;
  /** The strip mark the stop reads (a prep card split across dishes reads as the one card). */
  mark: string;
  state: string;
  pot: boolean;
  said: string;
  box: { x: number; y: number; w: number; h: number } | null | undefined;
  onRead: MealLinesProps["onRead"];
  readMark: string | null;
  tab: number;
}) {
  if (!box || !onRead || state === "done") return null;
  const read = readMark === mark;
  return (
    <button
      type="button"
      data-card={mark}
      data-stop={k}
      data-card-state={state}
      data-card-kind={pot ? "pot" : "hands-on"}
      data-read-ring={read ? "" : undefined}
      tabIndex={tab}
      aria-label={`${said}. Read it`}
      aria-pressed={read}
      aria-current={state === "now" ? "step" : undefined}
      onClick={(e) => {
        e.stopPropagation();
        onRead(read ? null : mark);
      }}
      className={`pointer-events-auto absolute cursor-pointer rounded-[var(--radius-1)] bg-transparent ${read ? "ring-2 ring-ink" : ""} ${FOCUS}`}
      style={{ left: box.x, top: box.y, width: box.w, height: box.h }}
    />
  );
}

function Columns({ drawing: d, c, onRead, readMark, tab, ground }: MealLinesProps & { drawing: ColumnsDrawing }) {
  const T = LINES_TYPE;
  const fs = d.type.size;
  const lh = d.type.line;
  const ring = T.ring * c;
  return (
    <div
      data-meal-lines="columns"
      data-scroll={d.scroll ? "true" : "false"}
      data-merged={d.merged.length || undefined}
      data-folded={d.folded || undefined}
      data-fit-level={d.level}
      className="relative"
      style={{ width: d.width, height: d.height }}
    >
      <svg aria-hidden className="absolute top-0 left-0 overflow-visible" width={d.width} height={d.height}>
        {d.breaks.map((b) => (
          <g key={`b${b.stretch}`} data-line-break={b.stretch}>
            <line x1={b.x} x2={b.x + b.w} y1={b.y + 0.5} y2={b.y + 0.5} stroke={HAIR} strokeWidth={1} />
            <line x1={b.x} x2={b.x + b.w} y1={b.y + b.h - 0.5} y2={b.y + b.h - 0.5} stroke={HAIR} strokeWidth={1} />
          </g>
        ))}
        {d.rails.map((r) => (
          <line key={`r${r.col}`} data-line-rail={r.col} x1={r.x} x2={r.x} y1={r.y0} y2={r.y1} stroke={PALE} strokeWidth={T.pale * c} strokeLinecap="round" />
        ))}
        {d.hot.map((h) => (
          <line key={h.key} data-line-hot={h.key} x1={h.x} x2={h.x} y1={h.y0} y2={h.y1} stroke="var(--ink)" strokeWidth={T.hot * c} strokeLinecap="round" />
        ))}
        {d.bends.map((b) => {
          const s = b.x > b.toX ? -1 : 1;
          return (
            <path
              key={`j${b.col}`}
              data-line-join={b.col}
              d={`M ${b.x} ${b.y - b.r} Q ${b.x} ${b.y} ${b.x + s * b.r} ${b.y} L ${b.toX} ${b.y}`}
              fill="none"
              stroke={b.hot ? "var(--ink)" : PALE}
              strokeWidth={(b.hot ? T.hot : T.pale) * c}
              strokeLinecap="round"
            />
          );
        })}
        {d.shares.map((s) => (
          <g key={`s${s.key}`} data-line-share={s.key}>
            <line x1={s.x0} x2={s.x1} y1={s.y} y2={s.y} stroke="var(--ink)" strokeWidth={T.hot * c} />
            {s.dots.map((p, i) =>
              // The step in hand is Ember on every line it stands on, at its own size.
              s.now ? (
                <circle key={i} data-line-share-now="" cx={p.x} cy={s.y} r={(T.nowDot * c) / 2} fill="var(--ember)" />
              ) : p.pot ? (
                <circle key={i} cx={p.x} cy={s.y} r={(T.dot * c) / 2 - ring / 2} fill="var(--paper)" stroke="var(--ink)" strokeWidth={ring} />
              ) : (
                <circle key={i} cx={p.x} cy={s.y} r={(T.dot * c) / 2} fill="var(--ink)" />
              ),
            )}
          </g>
        ))}
        {d.done.map((x) => (
          <circle key={`d${x.col}`} data-line-done={x.col} cx={x.x} cy={x.y} r={(T.doneDot * c) / 2} fill={PALE} />
        ))}
        {d.stops.map((s) =>
          s.state === "now" ? (
            <circle key={s.key} data-line-dot={s.key} cx={s.dotX} cy={s.dotY} r={s.dotR} fill="var(--ember)" />
          ) : s.pot ? (
            <circle key={s.key} data-line-dot={s.key} cx={s.dotX} cy={s.dotY} r={s.dotR - ring / 2} fill="var(--paper)" stroke="var(--ink)" strokeWidth={ring} />
          ) : (
            <circle key={s.key} data-line-dot={s.key} cx={s.dotX} cy={s.dotY} r={s.dotR} fill="var(--ink)" />
          ),
        )}
      </svg>

      {d.heads.map((h) => (
        <p
          key={h.col}
          data-line-head={h.col}
          className="absolute m-0 font-semibold text-ink"
          style={{ left: h.x, top: h.y, width: h.w, fontSize: fs, lineHeight: `${lh}px` }}
        >
          {h.lines.map((ln, i) => (
            <span key={i} className="block whitespace-nowrap">
              {i > 0 ? ` ${ln}` : ln}
            </span>
          ))}
        </p>
      ))}

      {d.breaks.map((b) => (
        <p
          key={`bw${b.stretch}`}
          data-line-free={b.stretch}
          className="absolute m-0 font-medium whitespace-nowrap text-ink-soft"
          style={{ left: b.x + T.pad * c, top: b.y + (b.h - lh) / 2, fontSize: fs, lineHeight: `${lh}px` }}
        >
          {b.words}
        </p>
      ))}
      {d.finish && (
        <p
          data-line-finish
          // On the surface under it, so the lines it crosses pass behind its words, as drawn.
          className={`absolute m-0 ${ground ? "bg-ground" : "bg-paper"} text-right font-medium whitespace-nowrap text-ink-soft`}
          style={{ left: d.finish.x, top: d.finish.y, width: d.finish.w, fontSize: fs, lineHeight: `${lh}px`, paddingInline: 10 * c }}
        >
          {d.finish.text}
        </p>
      )}

      {d.stops.map((s) => (
        <div
          key={s.key}
          data-line-stop={s.key}
          data-stop-state={s.state}
          data-stop-kind={s.pot ? "pot" : "hands"}
          data-stop-prep={s.prep ? "" : undefined}
          data-stop-term={s.term ? "" : undefined}
          // Its button says it (Target): the drawn words aren't read a second time.
          aria-hidden={onRead && s.target && s.state !== "done" ? true : undefined}
          className={`absolute ${stopColor(s)}`}
          style={{ left: s.x, top: s.y, width: s.w, fontSize: fs, lineHeight: `${lh}px` }}
        >
          {s.lines.map((ln, i) => (
            <span key={i} className="block whitespace-nowrap">
              {i > 0 ? ` ${ln}` : ln}
            </span>
          ))}
          {s.more?.map((ln, i) => (
            <span key={`m${i}`} data-line-more className="block font-medium whitespace-nowrap text-ink-soft">
              {ln}
            </span>
          ))}
        </div>
      ))}
      {d.stops.map((s) => (
        <Target key={`t${s.key}`} k={s.key} mark={s.mark} state={s.state} pot={s.pot} said={s.said} box={s.target} onRead={onRead} readMark={readMark} tab={tab} />
      ))}
    </div>
  );
}

function List({ drawing: d, c, onRead, readMark, tab }: MealLinesProps & { drawing: ListDrawing }) {
  const lh = d.type.lh;
  return (
    <div data-meal-lines="list" data-scroll={d.scroll ? "true" : "false"} className="relative" style={{ width: d.width, height: d.height }}>
      <svg aria-hidden className="absolute top-0 left-0 overflow-visible" width={d.width} height={d.height}>
        {d.rail && <line data-line-rail="list" x1={d.rail.x} x2={d.rail.x} y1={d.rail.y0} y2={d.rail.y1} stroke={PALE} strokeWidth={LINES_TYPE.pale * c} />}
        {d.rows.map((r) =>
          r.kind === "break" ? (
            <g key={`b${r.y}`} data-line-break={r.stretch}>
              <line x1={0} x2={d.width} y1={r.y + 0.5} y2={r.y + 0.5} stroke={HAIR} />
              <line x1={0} x2={d.width} y1={r.y + r.h - 0.5} y2={r.y + r.h - 0.5} stroke={HAIR} />
            </g>
          ) : r.kind === "step" ? (
            r.state === "now" ? (
              <circle key={r.key} data-line-dot={r.key} cx={d.cols.dot} cy={r.dotY} r={d.dotR * 1.25} fill="var(--ember)" />
            ) : r.pot ? (
              <circle key={r.key} data-line-dot={r.key} cx={d.cols.dot} cy={r.dotY} r={d.dotR - LINES_TYPE.ring * c} fill="var(--paper)" stroke="var(--ink)" strokeWidth={LINES_TYPE.ring * c} />
            ) : (
              <circle key={r.key} data-line-dot={r.key} cx={d.cols.dot} cy={r.dotY} r={d.dotR} fill="var(--ink)" />
            )
          ) : null,
        )}
      </svg>
      {d.rows.map((r) => {
        if (r.kind === "done") {
          return (
            <p
              key="done"
              data-line-done-list
              className="absolute m-0 font-medium whitespace-nowrap text-ink-soft"
              style={{ left: 0, top: r.y + (r.h - lh * d.type.meta) / 2, fontSize: d.type.meta, lineHeight: lh }}
            >
              {r.lines[0]}
            </p>
          );
        }
        if (r.kind === "break") {
          return (
            <p
              key={`bw${r.y}`}
              data-line-free=""
              aria-label={r.said}
              className="absolute m-0 text-ink-soft"
              style={{ left: d.cols.label, top: r.y + (r.h - r.lines.length * lh * d.type.ruled) / 2, fontSize: d.type.ruled, lineHeight: lh }}
            >
              {r.lines.map((ln, i) => (
                <span key={i} className="block font-medium whitespace-nowrap">
                  {i > 0 ? ` ${ln}` : ln}
                </span>
              ))}
            </p>
          );
        }
        const color = stopColor({ state: r.state!, pot: false }, true);
        const pad = (r.h - Math.max(r.lines.length, r.dish?.length ?? 0) * lh * d.type.label) / 2;
        // Its button says its words and minutes (Target): the drawn ones aren't read a second time.
        const said = !!onRead && !!r.target && r.state !== "done";
        return (
          <div key={r.key} data-line-stop={r.key} data-stop-state={r.state} data-stop-kind={r.pot ? "pot" : "hands"} data-stop-prep={r.prep ? "" : undefined} className="absolute inset-x-0" style={{ top: r.y, height: r.h }}>
            {d.cols.dish && r.dish && r.dish.length > 0 && (
              <p
                data-line-dish
                className="absolute m-0 font-medium text-ink-soft"
                style={{ left: d.cols.dish.x, top: pad, width: d.cols.dish.w, fontSize: d.type.meta, lineHeight: `${lh * d.type.label}px` }}
              >
                {r.dish.map((n) => (
                  <span key={n} className="block truncate">
                    {n}
                  </span>
                ))}
              </p>
            )}
            <p aria-hidden={said || undefined} className={`absolute m-0 ${color}`} style={{ left: d.cols.label, top: pad, fontSize: d.type.label, lineHeight: lh }}>
              {r.lines.map((ln, i) => (
                <span key={i} className="block whitespace-nowrap">
                  {i > 0 ? ` ${ln}` : ln}
                </span>
              ))}
            </p>
            {r.minutes && (
              <p aria-hidden={said || undefined} className="absolute right-0 m-0 font-medium whitespace-nowrap text-ink-soft tabular-nums" style={{ top: pad, fontSize: d.type.meta, lineHeight: `${lh * d.type.label}px` }}>
                {r.minutes}
              </p>
            )}
          </div>
        );
      })}
      {d.rows.map((r) =>
        r.kind === "step" ? <Target key={`t${r.key}`} k={r.key!} mark={r.mark!} state={r.state!} pot={r.pot ?? false} said={r.said} box={r.target} onRead={onRead} readMark={readMark} tab={tab} /> : null,
      )}
    </div>
  );
}
