/**
 * The pull between the peek and the whole cook, set down: takes a
 * `PullPlan` and a `PullFrame` from `pull-travel` and writes them on the
 * page's own parts, the peek's rows (`PeekRows`) and the meal's lines
 * (`MealLines`).
 *
 * A pull costs no layout: the parts are found once per pull (`bind`), and a
 * frame writes only `transform` and `opacity`, and only where the value
 * changed. Away from the pull (`release`) every part is given back as its
 * component drew it, with no style of this file's left on it, no listener
 * and no node kept: the peek and the whole cook at rest are untouched.
 */

import type { Mover, Origin, PullFrame, PullPlan } from "./pull-travel";

type El = HTMLElement | SVGElement;

/** A part and what was last written on it. */
interface Part {
  el: El;
  transform: string;
  opacity: string;
}

const part = (el: El): Part => ({ el, transform: "", opacity: "" });
const all = (root: Element, sel: string) => [...root.querySelectorAll<El>(sel)].map(part);
const one = (root: Element, sel: string) => {
  const el = root.querySelector<El>(sel);
  return el ? part(el) : null;
};

const px = (n: number) => `${n.toFixed(1)}px`;
const moved = (dx: number, dy: number, s: number) =>
  Math.abs(s - 1) < 1e-4 ? (Math.abs(dx) < 0.05 && Math.abs(dy) < 0.05 ? "" : `translate(${px(dx)}, ${px(dy)})`) : `translate(${px(dx)}, ${px(dy)}) scale(${s.toFixed(4)})`;
const opacity = (op: number) => (op >= 0.999 ? "" : Math.max(0, op).toFixed(3));

function write(p: Part | null | undefined, transform: string, op: string) {
  if (!p) return;
  if (p.transform !== transform) {
    p.transform = transform;
    p.el.style.transform = transform;
  }
  if (p.opacity !== op) {
    p.opacity = op;
    p.el.style.opacity = op;
  }
}
const move = (p: Part | null | undefined, m: Mover) => write(p, moved(m.dx, m.dy, m.s), opacity(m.op));
const fade = (p: Part | null | undefined, op: number) => write(p, "", opacity(op));

function origin(p: Part | null | undefined, o: Origin) {
  if (p) p.el.style.transformOrigin = `${px(o.x)} ${px(o.y)}`;
}
/** An svg part scales about its own box: its middle (a dot), or its foot (a line drawn up from it). */
function boxOrigin(p: Part, at: "center" | "50% 100%") {
  p.el.style.transformBox = "fill-box";
  p.el.style.transformOrigin = at;
}

type PeekRow =
  | { kind: "step"; dot: Part | null; label: Part | null; dish: Part | null; minutes: Part | null }
  | { kind: "ruled"; rule: Part | null; words: Part | null; lead: Part | null; tail: Part | null }
  | { kind: "fade"; row: Part };

interface Bound {
  plan: PullPlan;
  peekRoot: HTMLElement;
  linesRoot: HTMLElement;
  rows: PeekRow[];
  rail: Part | null;
  stops: Part[];
  dots: Part[];
  breakRules: Part[];
  breakWords: Part[];
  rails: Part[];
  hot: Part[];
  bends: Part[];
  shares: Part[];
  finish: Part | null;
  heads: Part[];
  done: Part[];
  onScroll: () => void;
}

export class PullPaint {
  private b: Bound | null = null;
  private painted = false;
  private scrollTop = 0;
  /** The plan the page did not hold when its parts were last looked for. */
  private failed: PullPlan | null = null;

  /** The plan in hand, or null. */
  get plan(): PullPlan | null {
    return this.b?.plan ?? null;
  }

  /** How far the meal's lines stand scrolled in their box (heard from the box, never read in a frame). */
  get scroll(): number {
    return this.scrollTop;
  }

  /**
   * Whether this plan's parts are worth looking for now: not bound (or bound to parts since drawn
   * anew), and not the plan the page just failed to hold. A plan the page does not hold is tried
   * once, and again only after `redrawn`: never frame after frame.
   */
  wants(plan: PullPlan): boolean {
    return plan !== this.failed && (this.b?.plan !== plan || this.stale);
  }

  /** The page was drawn anew (a render, new lines): a plan it did not hold may be tried once more. */
  redrawn() {
    this.failed = null;
  }

  /** The page's parts were drawn again since they were found (a new box, new rows): the plan needs binding again. */
  get stale(): boolean {
    return this.b !== null && !(this.b.peekRoot.isConnected && this.b.linesRoot.isConnected && (this.b.stops[0]?.el.isConnected ?? true) && rowEl(this.b.rows[0])?.isConnected !== false);
  }

  /**
   * Takes a plan and finds its parts: the peek's rows under `peekRoot`, the meal's lines under
   * `linesRoot` (its box). False, with nothing bound, where the page does not hold the plan's parts
   * (it is tried again only after `redrawn`, or as another plan). `heard`: the lines were scrolled in their box while
   * bound (their own start in view, a second finger), so the frame in hand wants painting again.
   */
  bind(plan: PullPlan | null, peekRoot: HTMLElement | null, linesRoot: HTMLElement | null, heard?: () => void): boolean {
    this.release();
    if (!plan || !peekRoot || !linesRoot) return false;
    if (plan === this.failed) return false;
    const lis = [...peekRoot.querySelectorAll<HTMLElement>("li[data-peek-row]")];
    const stops = all(linesRoot, "[data-line-stop]");
    const dots = all(linesRoot, "[data-line-dot]");
    const breakRules = all(linesRoot, "[data-line-break]");
    const breakWords = all(linesRoot, "[data-line-free]");
    const rails = all(linesRoot, "[data-line-rail]");
    const hot = all(linesRoot, "[data-line-hot]");
    const bends = all(linesRoot, "[data-line-join]");
    const shares = all(linesRoot, "[data-line-share]");
    const fits =
      lis.length === plan.rows.length &&
      stops.length === plan.stops.length &&
      dots.length === plan.stops.length &&
      breakRules.length === plan.breaks.length &&
      breakWords.length === plan.breaks.length &&
      rails.length === plan.rails.length &&
      hot.length === plan.hot.length &&
      bends.length === plan.bends.length &&
      shares.length === plan.shares.length &&
      lis.every((li, i) => (plan.rows[i].kind === "step") === (li.dataset.peekRow === "step"));
    if (!fits) {
      this.failed = plan;
      return false;
    }
    this.failed = null;

    const rows = lis.map((li, i): PeekRow => {
      const r = plan.rows[i];
      if (r.kind === "step") {
        const label = one(li, "[data-peek-label]");
        origin(label, r.from.origin);
        return { kind: "step", dot: one(li, "[data-peek-dot]"), label, dish: one(li, "[data-peek-dish]"), minutes: one(li, "[data-peek-minutes]") };
      }
      if (r.kind === "ruled") {
        const words = one(li, "[data-peek-words]");
        origin(words, r.from.origin);
        return { kind: "ruled", rule: one(li, "[data-peek-rule]"), words, lead: one(li, "[data-peek-lead]"), tail: one(li, "[data-peek-tail]") };
      }
      return { kind: "fade", row: part(li) };
    });
    for (const r of plan.rows) {
      if (r.kind === "step" && r.to?.lead) origin(stops[r.to.stop], r.to.origin);
      if (r.kind === "ruled" && r.to) origin(breakWords[r.to.brk], r.to.origin);
    }
    for (const d of dots) boxOrigin(d, "center");
    for (const l of [...rails, ...hot]) boxOrigin(l, "50% 100%");

    const onScroll = () => {
      const top = linesRoot.scrollTop;
      if (top === this.scrollTop) return;
      this.scrollTop = top;
      heard?.();
    };
    // Once, as the plan is taken: a frame never reads it.
    this.scrollTop = linesRoot.scrollTop;
    linesRoot.addEventListener("scroll", onScroll, { passive: true });
    this.b = {
      plan,
      peekRoot,
      linesRoot,
      rows,
      rail: one(peekRoot, "[data-peek-rail]"),
      stops,
      dots,
      breakRules,
      breakWords,
      rails,
      hot,
      bends,
      shares,
      finish: one(linesRoot, "[data-line-finish]"),
      heads: all(linesRoot, "[data-line-head]"),
      done: all(linesRoot, "[data-line-done], [data-line-done-list]"),
      onScroll,
    };
    return true;
  }

  /** A frame of the pull, written on the parts. */
  paint(F: PullFrame) {
    const b = this.b;
    if (!b) return;
    this.painted = true;
    F.rows.forEach((f, i) => {
      const r = b.rows[i];
      if (f.kind === "step" && r.kind === "step") {
        move(r.dot, f.dot);
        move(r.label, f.label);
        move(r.dish, f.dish);
        move(r.minutes, f.minutes);
      } else if (f.kind === "ruled" && r.kind === "ruled") {
        move(r.words, f.words);
        move(r.rule, f.rule);
        fade(r.lead, f.shed);
        fade(r.tail, f.shed);
      } else if (f.kind === "fade" && r.kind === "fade") fade(r.row, f.op);
    });
    fade(b.rail, F.rail);
    F.stops.forEach((s, i) => {
      move(b.stops[i], s);
      move(b.dots[i], s.dot);
    });
    F.breaks.forEach((m, i) => {
      move(b.breakWords[i], m);
      write(b.breakRules[i], moved(0, m.dy, 1), opacity(m.op));
    });
    // A line is drawn up from its foot, in the lines' ink (none at the peek).
    const ink = opacity(F.ink);
    const grow = (p: Part, g: number) => write(p, g >= 0.9999 ? "" : `scaleY(${Math.max(0, g).toFixed(4)})`, ink);
    F.rails.forEach((g, i) => grow(b.rails[i], g));
    F.hot.forEach((g, i) => grow(b.hot[i], g));
    F.bends.forEach((op, i) => fade(b.bends[i], op));
    F.shares.forEach((op, i) => fade(b.shares[i], op));
    fade(b.finish, F.finish);
    for (const h of b.heads) fade(h, F.heads);
    for (const d of b.done) fade(d, F.done);
  }

  /** Every part as its component drew it, the plan kept. */
  clear() {
    const b = this.b;
    if (!b || !this.painted) return;
    this.painted = false;
    const still = (p: Part | null | undefined) => write(p, "", "");
    for (const r of b.rows) {
      if (r.kind === "step") [r.dot, r.label, r.dish, r.minutes].forEach(still);
      else if (r.kind === "ruled") [r.rule, r.words, r.lead, r.tail].forEach(still);
      else still(r.row);
    }
    still(b.rail);
    still(b.finish);
    for (const list of [b.stops, b.dots, b.breakRules, b.breakWords, b.rails, b.hot, b.bends, b.shares, b.heads, b.done]) list.forEach(still);
  }

  /** Away from the pull: lets the parts go, as their components drew them, and stops listening. */
  release() {
    const b = this.b;
    if (!b) return;
    this.clear();
    const plain = (p: Part | null | undefined) => {
      if (!p) return;
      p.el.style.transformOrigin = "";
      p.el.style.transformBox = "";
    };
    for (const r of b.rows) {
      if (r.kind === "step") plain(r.label);
      else if (r.kind === "ruled") plain(r.words);
    }
    for (const list of [b.stops, b.dots, b.breakWords, b.rails, b.hot]) list.forEach(plain);
    b.linesRoot.removeEventListener("scroll", b.onScroll);
    this.b = null;
    this.scrollTop = 0;
  }
}

function rowEl(r: PeekRow | undefined): El | null | undefined {
  if (!r) return undefined;
  return r.kind === "step" ? r.label?.el : r.kind === "ruled" ? r.words?.el : r.row.el;
}
