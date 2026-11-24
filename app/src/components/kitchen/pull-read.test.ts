/**
 * The pull between the peek and the whole cook, over every stored meal at
 * every step, both prep modes, every shape, and with the whole cook's lines
 * scrolled anywhere in their box (the blind read of 2026-11-24 found the
 * cases the four-stand tests missed): no jump at either end, no pop on the
 * way, no row over the sheet's edge, no two rows on one place.
 *
 * Each rule is read over a few million points, so a test keeps the worst
 * offender and asserts once (an `expect` per point takes minutes).
 */

import { describe, expect, it } from "vitest";
import { initialCookState, next, type CookState } from "@/lib/kitchen/cook-view";
import { mainAt } from "@/lib/kitchen/peek-layout";
import { MEALS, SCREENS, at, laid, measure, roast, screens, type Laid } from "./pull-harness";
import { PULL_LINE_FIRST, planPull, pullAt, type Mover, type PullFrame, type PullPlan } from "./pull-travel";

interface Case {
  name: string;
  v: Laid;
  /** Where the lines may stand scrolled: the top, where they open, half way and the foot. */
  scrolls: number[];
}

const MODES = ["first", "go"] as const;
const CASES: Case[] = [];
for (const m of MEALS) {
  for (const mode of MODES) {
    const n = screens(m.plan, mode);
    for (let pos = 0; pos < n; pos++) {
      for (const sc of SCREENS) {
        const v = laid(m.plan, at(m.plan, pos, mode), sc.W, sc.H);
        if (!v.L.peek) continue;
        const max = Math.max(0, v.lines.height - v.plan.box.h);
        const scrolls = v.plan.clips ? [...new Set([0, v.scroll, max / 2, max].map((x) => Math.round(x)))] : [0];
        CASES.push({ name: `${m.name} (${mode}) at ${pos}, ${sc.name}`, v, scrolls });
      }
    }
  }
}

/** The worst of a rule's readings: `over` how far past its bound (0 or less is within it), and where. */
class Worst {
  over = -Infinity;
  where = "none read";
  n = 0;
  /** `value` must not be over `bound`. */
  max(value: number, bound: number, where: () => string) {
    this.n++;
    if (value - bound > this.over) {
      this.over = value - bound;
      this.where = `${where()}: ${value.toFixed(3)} over ${bound.toFixed(3)}`;
    }
  }
  /** `value` must not be under `bound`. */
  min(value: number, bound: number, where: () => string) {
    this.max(-value, -bound, () => `${where()} (under)`);
  }
  ok() {
    expect(this.n).toBeGreaterThan(0);
    expect(this.over <= 1e-9 ? "within" : this.where).toBe("within");
  }
}

const moved = (m: { dx: number; dy: number }) => Math.abs(m.dx) + Math.abs(m.dy);
const rowParts = (f: PullFrame["rows"][number]): Mover[] =>
  f.kind === "step" ? [f.dot, f.label, f.dish, f.minutes] : f.kind === "ruled" ? [f.words, f.rule] : [{ dx: 0, dy: 0, s: 1, op: f.op }];
/** Every opacity the whole cook is drawn by at a frame. */
const wholeOps = (F: PullFrame) => [...F.stops.map((s) => s.op), ...F.stops.map((s) => s.dot.op), ...F.breaks.map((b) => b.op), ...F.bends, ...F.shares, F.finish, F.heads, F.done, F.ink];
const edgeOf = (plan: PullPlan, t: number) => (plan.Y1 - plan.Y2) * (1 - t);

describe("every stored meal, every step, both prep modes, every shape, the lines scrolled anywhere", () => {
  it("covers the corpus: both modes, the scrolling meals", () => {
    expect(CASES.length).toBeGreaterThan(600);
    expect(CASES.some((c) => c.scrolls.length > 2)).toBe(true);
    expect(CASES.some((c) => c.name.includes("(go)"))).toBe(true);
  });

  it("no jump at 0%: at the peek every row stands as laid, a hair into the pull it has not moved, and nothing of the whole cook is drawn yet", () => {
    const w = new Worst();
    for (const { name, v, scrolls } of CASES) {
      for (const sc of scrolls) {
        const at0 = () => `${name}, scrolled ${sc}`;
        const A = pullAt(v.plan, 0, sc);
        for (const f of A.rows) {
          for (const m of rowParts(f)) {
            w.max(moved(m) + Math.abs(m.s - 1), 1e-9, () => `${at0()}: a row out of place at 0`);
            w.min(m.op, 1, () => `${at0()}: a row's opacity at 0`);
          }
        }
        w.min(A.rail, 1, () => `${at0()}: the rail at 0`);
        const a = pullAt(v.plan, 0.002, sc);
        for (const f of a.rows) {
          for (const m of rowParts(f)) {
            w.max(moved(m), 1.5, () => `${at0()}: a row moved at 0.2%`);
            w.max(Math.abs(m.s - 1), 0.01, () => `${at0()}: a row's size at 0.2%`);
            w.min(m.op, 0.97, () => `${at0()}: a row's opacity at 0.2%`);
          }
        }
        // Every part of the whole cook is drawn through the lines' ink, and there is none yet.
        w.max(a.ink, 0.05, () => `${at0()}: the lines' ink at 0.2%`);
        for (const op of [...a.stops.map((s) => s.op), ...a.breaks.map((b) => b.op), a.heads, a.done]) w.max(op, 0.05, () => `${at0()}: the whole cook at 0.2%`);
      }
    }
    w.ok();
  });

  it("no jump at 100%: at the whole cook every part stands as drawn and the peek's rows are gone, and a hair before it nothing is out of place", () => {
    const w = new Worst();
    for (const { name, v, scrolls } of CASES) {
      // A stop with a row on it is still that row riding the sheet's edge: the edge's own last 0.2%.
      const hair = (v.plan.Y1 - v.plan.Y2) * 0.002 + 0.5;
      for (const sc of scrolls) {
        const at1 = () => `${name}, scrolled ${sc}`;
        const B = pullAt(v.plan, 1, sc);
        for (const s of B.stops) {
          w.max(moved(s) + moved(s.dot) + Math.abs(s.s - 1) + Math.abs(s.dot.s - 1), 1e-9, () => `${at1()}: a stop out of place at 1`);
          w.min(Math.min(s.op, s.dot.op), 1, () => `${at1()}: a stop's opacity at 1`);
        }
        for (const b of B.breaks) {
          w.max(moved(b), 1e-9, () => `${at1()}: a break out of place at 1`);
          w.min(b.op, 1, () => `${at1()}: a break's opacity at 1`);
        }
        for (const g of [...B.rails, ...B.hot, ...B.bends, ...B.shares, B.finish, B.heads, B.done, B.ink]) w.min(g, 1, () => `${at1()}: a part at 1`);
        for (const f of B.rows) w.max(Math.max(...rowParts(f).map((m) => m.op)), 0, () => `${at1()}: a row at 1`);
        const b = pullAt(v.plan, 0.998, sc);
        for (const s of b.stops) {
          w.max(Math.max(moved(s), moved(s.dot)), hair, () => `${at1()}: a stop moved at 99.8%`);
          w.min(Math.min(s.op, s.dot.op), 0.97, () => `${at1()}: a stop's opacity at 99.8%`);
        }
        for (const g of [...b.rails, ...b.hot, b.heads, b.done, b.ink]) w.min(g, 0.97, () => `${at1()}: a part at 99.8%`);
        for (const f of b.rows) w.max(Math.max(...rowParts(f).map((m) => m.op)), 0.03, () => `${at1()}: a row at 99.8%`);
      }
    }
    w.ok();
  });

  it("no pop on the way: from one hundredth of the pull to the next no part's opacity changes by more than half, and no drawn row jumps", () => {
    const w = new Worst();
    for (const { name, v, scrolls } of CASES) {
      const span = v.plan.Y1 - v.plan.Y2;
      // On screen a row moves with the sheet's edge, or closes on its stop on the clock: never by a jump.
      const step = Math.max(8, span * 0.06);
      for (const sc of scrolls) {
        let was: PullFrame | null = null;
        let wasOps: number[] = [];
        for (let k = 0; k <= 100; k++) {
          const t = k / 100;
          const F = pullAt(v.plan, t, sc);
          const ops = wholeOps(F);
          if (was) {
            for (let i = 0; i < ops.length; i++) w.max(Math.abs(ops[i] - wasOps[i]), 0.5, () => `${name}, scrolled ${sc}: the whole cook's part ${i} at ${t}`);
            for (let i = 0; i < F.rows.length; i++) {
              const now = rowParts(F.rows[i]);
              const then = rowParts(was.rows[i]);
              for (let j = 0; j < now.length; j++) {
                w.max(Math.abs(now[j].op - then[j].op), 0.5, () => `${name}, scrolled ${sc}: row ${i} part ${j} opacity at ${t}`);
                if (Math.max(now[j].op, then[j].op) > 0.05) w.max(Math.abs(now[j].dy - then[j].dy), step, () => `${name}, scrolled ${sc}: row ${i} part ${j} height at ${t}`);
              }
            }
          }
          was = F;
          wasOps = ops;
        }
      }
    }
    w.ok();
  });

  it("no drawn row stands over the sheet's edge, at any point, however the lines are scrolled", () => {
    const w = new Worst();
    for (const { name, v, scrolls } of CASES) {
      for (const sc of scrolls) {
        for (let k = 0; k <= 20; k++) {
          const t = k / 20;
          const F = pullAt(v.plan, t, sc);
          v.plan.rows.forEach((r, i) => {
            const f = F.rows[i];
            // Its place under the sheet's edge, px: over 0.
            if (r.kind === "step" && f.kind === "step" && f.label.op > 0.05) w.min(r.from.y + f.label.dy, 1, () => `${name}, scrolled ${sc}: row ${i} at ${t}`);
            if (r.kind === "ruled" && f.kind === "ruled" && f.words.op > 0.05) w.min(r.from.y + f.words.dy, 1, () => `${name}, scrolled ${sc}: ruled row ${i} at ${t}`);
          });
        }
      }
    }
    w.ok();
    void edgeOf;
  });

  it("no two rows of the peek are drawn on one place: a second row of a folded run gives way as it closes on the first, and two steps at one height stay apart until they stand in their columns", () => {
    const w = new Worst();
    let runs = 0;
    // Two rows of one folded run with another stop's row between them in the peek (the second blind
    // read's case: the later row is not held under the row before it, so it could ride through it).
    let split = 0;
    for (const { name, v, scrolls } of CASES) {
      const steps = v.plan.rows.map((r, i) => ({ r, i })).filter((x) => x.r.kind === "step");
      if (steps.some((x) => x.r.kind === "step" && x.r.to && !x.r.to.lead)) runs++;
      const to = steps.map((x, k) => (x.r.kind === "step" && x.r.to ? x.r.to.stop : -1 - k));
      if (to.some((s, a) => s >= 0 && to.some((q, b) => b > a + 1 && q === s && to.slice(a + 1, b).some((m) => m !== s)))) split++;
      for (const sc of scrolls) {
        for (let k = 0; k <= 50; k++) {
          const t = k / 50;
          const F = pullAt(v.plan, t, sc);
          const at = steps.map(({ r, i }) => {
            const f = F.rows[i];
            if (r.kind !== "step" || f.kind !== "step") throw new Error("a step row");
            return { i, y: r.from.y + f.label.dy, x: r.from.labelX + f.label.dx, op: f.label.op, size: r.from.size * f.label.s };
          });
          for (let p = 0; p < at.length; p++) {
            for (let q = p + 1; q < at.length; q++) {
              const close = Math.abs(at[p].y - at[q].y) < 0.6 * Math.min(at[p].size, at[q].size) && Math.abs(at[p].x - at[q].x) < 40;
              if (close) w.max(Math.min(at[p].op, at[q].op), 0.25, () => `${name}, scrolled ${sc}: rows ${at[p].i} and ${at[q].i} on one place at ${t}`);
              else w.max(0, 0.25, () => "");
            }
          }
        }
      }
    }
    w.ok();
    expect(runs, "a stored meal has two peek rows in one folded run").toBeGreaterThan(0);
    // No stored meal draws it (0 of about 2,100 peeks, 2026-11-24): the rule above would catch the
    // overlap if one did, and this says when the travel's `mate` rule first meets the case.
    expect(split, "a folded run's rows with another stop's row between them").toBe(0);
  });

  it("a row with no stop of its own (the table's row, a break the lines draw no gap for, a step they draw no stop for) is never nearer the row before it than the peek has it, while it is drawn", () => {
    // Upright, a row ahead of it can stop low in the lines' box while the sheet's edge still rises: a
    // row with nowhere to go rode that edge up into it ("then on the table" over "Carve and serve" a
    // quarter of the way, the roast upright).
    const w = new Worst();
    const check = (name: string, plan: PullPlan, scrolls: number[]) => {
      const rows = plan.rows;
      const lonely = rows.map((r, i) => ((r.kind === "step" || r.kind === "ruled") && !r.to && i > 0 && rows[i - 1].kind !== "fade" ? i : -1)).filter((i) => i >= 0);
      if (lonely.length === 0) return false;
      for (const sc of scrolls) {
        for (let k = 0; k <= 40; k++) {
          const t = k / 40;
          const F = pullAt(plan, t, sc);
          /** A row's words: their place under the sheet's edge as the frame has them, and how much is drawn. */
          const words = (i: number) => {
            const r = rows[i];
            const f = F.rows[i];
            if (r.kind === "step" && f.kind === "step") return { y: r.from.y + f.label.dy, from: r.from.y, op: f.label.op };
            if (r.kind === "ruled" && f.kind === "ruled") return { y: r.from.y + f.words.dy, from: r.from.y, op: f.words.op };
            throw new Error("a row with words");
          };
          for (const i of lonely) {
            const a = words(i - 1);
            const b = words(i);
            if (b.op <= 0.05) continue;
            w.min(b.y - a.y - (b.from - a.from), -0.5, () => `${name}, scrolled ${sc}: row ${i} closes on row ${i - 1} at ${t}`);
          }
        }
      }
      return true;
    };
    let lone = 0;
    for (const { name, v, scrolls } of CASES) if (check(name, v.plan, scrolls)) lone++;
    expect(lone, "stored meals with a row that has no stop").toBeGreaterThan(20);
    // A step the lines draw no stop for (As I go's Prep screen, a step changed mid-pull) holds the same
    // way. No stored meal has one under a row that stops, so one is made: the roast upright, where
    // "Carve and serve" stops low, its stop taken from the row after it.
    const v = laid(roast, at(roast, 19), 800, 1280);
    const second = v.plan.rows[1];
    if (second.kind !== "step" || !second.to) throw new Error("the roast upright: its second row travels");
    const gone = second.to.stop;
    const made: PullPlan = {
      ...v.plan,
      rows: v.plan.rows.map((r, i) => (i === 1 && r.kind === "step" ? { ...r, to: null } : r)),
      stops: v.plan.stops.map((p, i) => (i === gone ? { ...p, twin: false } : p)),
    };
    const first = made.rows[0];
    expect(first.kind === "step" && first.to !== null, "the row before it travels").toBe(true);
    expect(check("the roast upright, its second row's stop taken away", made, [v.scroll])).toBe(true);
    w.ok();
  });

  it("where no row of the peek has a stop, the rows hold and the lines come in under them: nothing pops", () => {
    const v = laid(roast, at(roast, 10), 1280, 800);
    const bare: PullPlan = { ...v.plan, rows: v.plan.rows.map((r) => (r.kind === "step" ? { ...r, to: null } : r.kind === "ruled" ? { ...r, to: null } : r)), stops: v.plan.stops.map((s) => ({ ...s, twin: false })), breaks: v.plan.breaks.map((b) => ({ ...b, twin: false })) };
    const a = pullAt(bare, 0.002, 0);
    for (const s of a.stops) expect(Math.min(s.op, a.ink), "a stop at 0.2% of a pull where no row travels").toBeLessThan(0.05);
    const f = a.rows[0];
    expect(f.kind === "step" && f.label.op).toBeGreaterThan(0.97);
    // On the way the row has not gone before a stop of the lines can be read.
    for (let k = 1; k < 100; k++) {
      const F = pullAt(bare, k / 100, 0);
      const row = F.rows[0];
      const lines = Math.max(...F.stops.map((s) => Math.min(s.op, F.ink)));
      expect(Math.max(row.kind === "step" ? row.label.op : 0, lines), `something to read at ${k}%`).toBeGreaterThan(0.45);
    }
    expect(pullAt(bare, 1, 0).stops.every((s) => s.op === 1)).toBe(true);
  });
});

describe("nothing of the whole cook shows before its line does", () => {
  it("no stop that no row travels to shows before the longest line has half of PULL_LINE_FIRST (24 of 48 cpx) drawn, or all of it where it is shorter (asked 2026-11-24: 'Carve and serve' stood alone at 25% of the pull)", () => {
    const w = new Worst();
    for (const { name, v, scrolls } of CASES) {
      if (!v.plan.rails.length) continue;
      const longest = Math.max(...v.plan.rails.map((r) => r.y1 - r.y0));
      const need = Math.min((PULL_LINE_FIRST / 2) * v.plan.c, longest - 1);
      for (const sc of scrolls) {
        for (let k = 1; k < 50; k++) {
          const t = k / 50;
          const F = pullAt(v.plan, t, sc);
          if (!F.stops.some((s) => !s.twin && Math.min(s.op, F.ink) > 0.1)) continue;
          const drawn = Math.max(...v.plan.rails.map((r, i) => (r.y1 - r.y0) * F.rails[i]));
          w.min(drawn, need, () => `${name}, scrolled ${sc}: a stop shows at ${t} with this much line, px`);
        }
      }
    }
    w.ok();
  });
});

describe("a row and its stop hand over cleanly", () => {
  it("where the two are the same lines of the same words they cross at one place; where the words or their line breaks differ the row's go before the stop's come, and the dot crosses", () => {
    const w = new Worst();
    let same = 0;
    let differ = 0;
    // The same words broken otherwise: a row on one line in the wide peek whose stop wraps in its dish's column.
    let rewrapped = 0;
    for (const { name, v, scrolls } of CASES) {
      const sc = scrolls[0];
      const theirs = v.lines.form === "columns" ? v.lines.stops.map((q) => (q.more ? null : q.lines)) : v.lines.rows.filter((q) => q.kind === "step").map((q) => q.lines);
      for (let k = 0; k <= 50; k++) {
        const t = k / 50;
        const F = pullAt(v.plan, t, sc);
        v.plan.rows.forEach((r, i) => {
          const f = F.rows[i];
          if (r.kind !== "step" || f.kind !== "step" || !r.to?.lead || !F.stops[r.to.stop].twin) return;
          const s = F.stops[r.to.stop];
          const row = v.L.peek!.rows[i];
          const stop = theirs[r.to.stop];
          if (row.kind !== "step") throw new Error("a step row");
          const alike = stop !== null && stop.length === row.lines.length && stop.every((l, n) => l === row.lines[n]);
          if (k === 0 && !alike && stop !== null && stop.join(" ") === row.lines.join(" ")) rewrapped++;
          expect(r.to.same, `${name}: row ${i} (${row.lines.join(" / ")}) and its stop (${stop?.join(" / ")})`).toBe(alike);
          if (alike) {
            if (k === 0) same++;
            w.max(Math.abs(f.label.op + s.op - 1), 1e-6, () => `${name}: row ${i}, the same words, at ${t}`);
          } else {
            if (k === 0) differ++;
            w.max(Math.min(f.label.op, s.op), 0.02, () => `${name}: row ${i}, other words, both drawn at ${t}`);
          }
          // The dot is one dot throughout.
          w.max(Math.abs(f.dot.op + s.dot.op - 1), 1e-6, () => `${name}: row ${i}'s dot at ${t}`);
        });
      }
    }
    w.ok();
    expect(same).toBeGreaterThan(50);
    expect(differ).toBeGreaterThan(50);
    expect(rewrapped, "a stored meal has a row whose stop says the same words on other lines").toBeGreaterThan(0);
  });
});

describe("the step changes while the finger holds the sheet between the levels", () => {
  /** The peek as it was laid for one step, and the lines as they are drawn for the next. */
  function mixed(state: CookState, W: number, H: number) {
    const was = laid(roast, state, W, H);
    const now = laid(roast, next(roast, state), W, H);
    return { was, now, plan: planPull({ peek: was.L.peek!, lines: now.lines, c: was.L.geo.c, Y1: was.L.detents[1], Y2: was.L.detents[2], box: now.plan.box }) };
  }
  it("the old step's row takes no stop that another row is: it holds and fades, and no two rows share a stop that is not their folded run", () => {
    let checked = 0;
    for (const sc of SCREENS) {
      let s = initialCookState("first");
      for (let pos = 0; pos < screens(roast) - 1; pos++, s = next(roast, s)) {
        const { was, now, plan } = mixed(s, sc.W, sc.H);
        const marks = now.lines.form === "columns" ? now.lines.stops.map((q) => [q.mark, ...q.foldedMarks]) : now.lines.rows.filter((r) => r.kind === "step").map((r) => [r.mark!]);
        const peek = was.L.peek!;
        const taken = new Map<number, number>();
        plan.rows.forEach((r, i) => {
          const row = peek.rows[i];
          if (r.kind !== "step" || row.kind !== "step" || !r.to) return;
          const other = taken.get(r.to.stop);
          if (other !== undefined) {
            const a = peek.rows[other];
            // Two rows on one stop only where both are of that stop's own run.
            expect(a.kind === "step" && marks[r.to.stop].includes(a.key) && marks[r.to.stop].includes(row.key), `${sc.name} at ${pos}: rows ${other} and ${i} on stop ${r.to.stop}`).toBe(true);
          }
          taken.set(r.to.stop, i);
          // A row takes a stop only where it is that stop's step (its mark, its folded run, a task of
          // its card), or the Prep screen a prep card: never the step in hand for being the row in hand.
          const tasks = (key: string) => key.split("#")[0].split("+");
          const prep = now.lines.form === "columns" ? now.lines.stops.map((q) => q.prep) : now.lines.rows.filter((q) => q.kind === "step").map((q) => q.prep === true);
          const own = marks[r.to.stop].some((m) => m === row.key || tasks(m).some((t) => tasks(row.key).includes(t)));
          expect(own || (row.key === "prep" && prep[r.to.stop]), `${sc.name} at ${pos}: the row of ${row.key} on the stop of ${marks[r.to.stop].join(", ")}`).toBe(true);
          checked++;
        });
      }
    }
    expect(checked).toBeGreaterThan(20);
  });
});

describe("a break's row that wraps", () => {
  it("its main words' place is where they are drawn: the line they stand on, and their left on that line", () => {
    let seen = 0;
    let wrapped = 0;
    for (const { name, v } of CASES) {
      const d = v.L.peek!;
      for (const row of d.rows) {
        if (row.kind !== "break" && row.kind !== "table") continue;
        // The main words begin on the line that holds their first word after the lead's.
        const lead = row.words.lead.split(" ").filter(Boolean).length;
        let left = lead;
        let line = 0;
        while (line < row.lines.length && left >= row.lines[line].split(" ").length) left -= row.lines[line++].split(" ").length;
        if (line >= row.lines.length) continue;
        seen++;
        if (line > 0) wrapped++;
        const before = row.lines[line].split(" ").slice(0, left).join(" ");
        expect(row.lines[line].split(" ")[left], `${name}: ${row.lines.join(" / ")}`).toBe(row.words.main.split(" ")[0]);
        expect(row.mainLine, `${name}: ${row.lines.join(" / ")}`).toBe(line);
        expect(row.mainX, `${name}: ${row.lines.join(" / ")}`).toBeCloseTo(before ? measure(`${before} `, d.type.ruled, 500) : 0, 3);
      }
    }
    expect(seen).toBeGreaterThan(100);
    // No stored meal wraps its main words to a later line today (0 of about 2,100 rows, 2026-11-24): the made rows below do.
    // This says when a stored meal first does, so the rule above is then read on a real one too.
    expect(wrapped, "a stored meal's break row with its main words on a later line").toBe(0);
  });

  it("a row narrow enough that the lead fills its first line: the main words are on the second, at its left", () => {
    expect(mainAt(["2 more steps, then", "50 min free while", "it roasts"], "2 more steps, then", 20, 500, measure)).toEqual({ line: 1, x: 0 });
    expect(mainAt(["2 more steps,", "then 50 min free"], "2 more steps, then", 20, 500, measure)).toEqual({ line: 1, x: measure("then ", 20, 500) });
    expect(mainAt(["then 50 min free"], "then", 20, 500, measure)).toEqual({ line: 0, x: measure("then ", 20, 500) });
    expect(mainAt(["50 min free"], "", 20, 500, measure)).toEqual({ line: 0, x: 0 });
  });
});
