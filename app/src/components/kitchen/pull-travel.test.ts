import { describe, expect, it } from "vitest";
import { strip } from "@/lib/kitchen/cook-strip";
import { initialCookState, next, type CookState } from "@/lib/kitchen/cook-view";
import type { ColumnsDrawing, ListDrawing } from "@/lib/kitchen/meal-lines-layout";
import { MEALS, SCREENS, at, laid, roast, screens, stands, type Laid } from "./pull-harness";
import { pullAt, pullInert, pullShare, PULL_COLUMNS, PULL_LIST, type Mover, type PullFrame } from "./pull-travel";

/** A part in its own place, whole. */
const still = (m: Mover) => Math.abs(m.dx) + Math.abs(m.dy) < 1e-9 && Math.abs(m.s - 1) < 1e-9 && m.op === 1;
/** The roast with the duck fat heating in hand (the pictures' frame): its key, found by walking. */
function roastAt(label: RegExp): CookState {
  let s = initialCookState("first");
  for (let i = 0; i < 60; i++) {
    const m = strip(roast, s, null).marks.find((x) => x.state === "in-hand");
    if (m && label.test(m.label)) return s;
    s = next(roast, s);
  }
  throw new Error(`the roast has no step ${label}`);
}

/** What is drawn at a frame, on screen: each travelling row's label and each of the whole cook's stops. */
function drawn(v: Laid, F: PullFrame, t: number) {
  const { plan } = v;
  const Y = plan.Y1 + (plan.Y2 - plan.Y1) * t;
  const oy = plan.Y2 + plan.box.y - v.scroll;
  const out: { what: string; x: number; y: number; op: number }[] = [];
  plan.rows.forEach((r, i) => {
    const f = F.rows[i];
    if (r.kind === "step" && f.kind === "step") out.push({ what: `row ${i}`, x: r.from.labelX + f.label.dx, y: Y + r.from.y + f.label.dy, op: f.label.op });
    if (r.kind === "ruled" && f.kind === "ruled") out.push({ what: `ruled ${i}`, x: r.from.x + f.words.dx, y: Y + r.from.y + f.words.dy, op: f.words.op });
  });
  F.stops.forEach((s, i) => {
    const y = oy + plan.stops[i].mid + s.dy;
    // A meal that scrolls: its box cuts what stands past it.
    if (plan.clips && (y < plan.Y2 + plan.box.y || y > plan.Y2 + plan.box.y + plan.box.h)) return;
    out.push({ what: `stop ${i}`, x: plan.box.x + s.dx, y, op: s.op });
  });
  return out;
}

describe("the pull from the peek to the whole cook: the roast with the duck fat heating, wide", () => {
  const v = laid(roast, roastAt(/duck fat|heat.*fat/i), 1280, 800);
  const d = v.lines as ColumnsDrawing;

  it("is the wide form, and every step row of the peek has its stop", () => {
    expect(d.form).toBe("columns");
    const steps = v.plan.rows.filter((r) => r.kind === "step");
    expect(steps.length).toBeGreaterThan(1);
    for (const r of steps) expect(r.kind === "step" && r.to, "a stop").toBeTruthy();
    // The step in hand's row lands on the one ember stop.
    const first = v.plan.rows[0];
    expect(first.kind === "step" && first.to && d.stops[first.to.stop].state).toBe("now");
  });

  it("the break's ruled row goes to that break's ruled gap", () => {
    const row = v.L.peek!.rows.find((r) => r.kind === "break");
    const ruled = v.plan.rows.find((r) => r.kind === "ruled");
    expect(row && row.kind === "break" && row.stretch).not.toBeNull();
    expect(ruled && ruled.kind === "ruled" && ruled.to).toBeTruthy();
    if (row?.kind === "break" && ruled?.kind === "ruled" && ruled.to) expect(d.breaks[ruled.to.brk].stretch).toBe(row.stretch);
  });

  it("at the peek the picture is the peek's own: every row in its place, whole", () => {
    const F = pullAt(v.plan, 0, v.scroll);
    for (const f of F.rows) {
      if (f.kind === "step") for (const m of [f.dot, f.label, f.dish, f.minutes]) expect(still(m)).toBe(true);
      else if (f.kind === "ruled") for (const m of [f.words, f.rule]) expect(still(m)).toBe(true);
      else expect(f.op).toBe(1);
    }
    expect(F.rail).toBe(1);
  });

  it("at the whole cook the picture is the lines' own: every part in its place, whole, and the peek's rows gone", () => {
    const F = pullAt(v.plan, 1, v.scroll);
    for (const s of F.stops) {
      expect(s.dx).toBeCloseTo(0, 9);
      expect(s.dy).toBeCloseTo(0, 9);
      expect(s.s).toBeCloseTo(1, 9);
      expect(s.op).toBe(1);
      expect(Math.abs(s.dot.dx) + Math.abs(s.dot.dy)).toBeCloseTo(0, 9);
      expect(s.dot.s).toBeCloseTo(1, 9);
    }
    for (const b of F.breaks) expect([Math.abs(b.dx) + Math.abs(b.dy) < 1e-9, b.op]).toEqual([true, 1]);
    for (const g of [...F.rails, ...F.hot, ...F.bends, ...F.shares, F.finish, F.heads, F.done]) expect(g).toBe(1);
    for (const f of F.rows) {
      if (f.kind === "step") expect(Math.max(f.dot.op, f.label.op, f.dish.op, f.minutes.op)).toBe(0);
      else if (f.kind === "ruled") expect(Math.max(f.words.op, f.rule.op)).toBe(0);
      else expect(f.op).toBe(0);
    }
  });

  it("a row and its stop are one thing on the way: the same place and size at every point, one giving way to the other", () => {
    for (const t of [0.5, 0.6, 0.7, 0.8, 0.9]) {
      const F = pullAt(v.plan, t, v.scroll);
      v.plan.rows.forEach((r, i) => {
        const f = F.rows[i];
        if (r.kind !== "step" || f.kind !== "step" || !r.to?.lead) return;
        const s = F.stops[r.to.stop];
        const Y = v.plan.Y1 + (v.plan.Y2 - v.plan.Y1) * t;
        // The row's words, from the sheet's edge; the stop's, from the lines' corner.
        const rowAt = { x: r.from.labelX + f.label.dx, y: Y + r.from.y + f.label.dy, size: r.from.size * f.label.s };
        const stopAt = { x: v.plan.box.x + r.to.x + s.dx, y: v.plan.Y2 + v.plan.box.y - v.scroll + r.to.y + s.dy, size: r.to.size * s.s };
        expect(rowAt.x, `x at ${t}`).toBeCloseTo(stopAt.x, 6);
        expect(rowAt.y, `y at ${t}`).toBeCloseTo(stopAt.y, 6);
        expect(rowAt.size, `size at ${t}`).toBeCloseTo(stopAt.size, 6);
        // One dot throughout; the words over each other where they say the same, one after the other where they differ.
        expect(f.dot.op + s.dot.op, `one dot at ${t}`).toBeCloseTo(1, 6);
        if (r.to.same) expect(f.label.op + s.op, `one gives way to the other at ${t}`).toBeCloseTo(1, 6);
        else expect(Math.min(f.label.op, s.op), `the row's words go before the stop's come at ${t}`).toBeLessThan(0.02);
      });
    }
  });

  it("each row rides the sheet's edge up to its stop and stays: never past it, never over the sheet's edge, the rows in their order", () => {
    const Y = (t: number) => v.plan.Y1 + (v.plan.Y2 - v.plan.Y1) * t;
    let before: number[] | null = null;
    for (let t = 0; t <= 1.0001; t += 0.02) {
      const F = pullAt(v.plan, Math.min(1, t), v.scroll);
      const at: number[] = [];
      v.plan.rows.forEach((r, i) => {
        const f = F.rows[i];
        if (r.kind !== "step" || f.kind !== "step" || !r.to) return;
        const y = Y(Math.min(1, t)) + r.from.y + f.label.dy;
        const stop = v.plan.Y2 + v.plan.box.y - v.scroll + r.to.y;
        expect(y, `row ${i} at ${t.toFixed(2)}: not past its stop`).toBeGreaterThanOrEqual(stop - 1e-6);
        expect(y, `row ${i} at ${t.toFixed(2)}: under the sheet's edge`).toBeGreaterThan(Y(Math.min(1, t)));
        at.push(y);
      });
      // Each goes one way only, up; and the rows keep their order.
      if (before) at.forEach((y, k) => expect(y, `row ${k} at ${t.toFixed(2)} goes up only`).toBeLessThanOrEqual(before![k] + 1e-6));
      for (let k = 1; k < at.length; k++) expect(at[k], `rows ${k - 1} and ${k} at ${t.toFixed(2)}`).toBeGreaterThan(at[k - 1]);
      before = at;
    }
  });

  it("a row sheds its dish and minutes, then narrows into its column, then gives way to its stop, in that order", () => {
    const T = PULL_COLUMNS;
    expect(T.meta[1]).toBeLessThanOrEqual(T.x[0]);
    expect(T.x[1]).toBeLessThanOrEqual(T.swap[0]);
    // The list's rows too stand in their columns before they give way: each word over its own.
    expect(PULL_LIST.x[1]).toBeLessThanOrEqual(PULL_LIST.swap[0]);
    expect(PULL_LIST.x[1]).toBeLessThanOrEqual(PULL_LIST.brk[0]);
    const mid = pullAt(v.plan, (T.x[0] + T.x[1]) / 2, v.scroll);
    const first = mid.rows[0];
    if (first.kind !== "step") throw new Error("the peek's first row is no step");
    expect(first.dish.op).toBe(0);
    expect(first.label.op).toBe(1);
    expect(Math.abs(first.label.dx)).toBeGreaterThan(1);
    // The break's "then" and "while it roasts" have gone before "50 min free" travels.
    const ruled = mid.rows.find((f) => f.kind === "ruled");
    expect(ruled && ruled.kind === "ruled" && ruled.shed).toBe(0);
  });

  it("the rest of the whole cook shows under the riding rows' foot, each line rising from its foot, and to the top once the rows have stopped", () => {
    // A quarter of the way a line has begun, and no stop shows yet: a stop waits for a stretch of its line.
    const early = pullAt(v.plan, 0.25, v.scroll);
    expect(Math.max(...early.rails)).toBeGreaterThan(0);
    expect(Math.max(...v.plan.stops.map((p, i) => (p.twin ? 0 : early.stops[i].op)))).toBeLessThan(0.05);
    const F = pullAt(v.plan, 0.6, v.scroll);
    const rest = v.plan.stops.map((p, i) => ({ p, op: F.stops[i].op })).filter((x) => !x.p.twin);
    expect(rest.length).toBeGreaterThan(0);
    // The lowest of them is in by 60% of the way; the heads and the work done wait.
    expect(Math.max(...rest.map((x) => x.op))).toBe(1);
    expect(Math.min(...rest.map((x) => x.op))).toBe(0);
    expect(F.heads).toBe(0);
    expect(Math.max(...F.rails)).toBeGreaterThan(0);
    expect(Math.min(...F.rails)).toBeLessThan(1);
    // Nine tenths of the way every row has stopped: the rest stands down to the header's row.
    const late = pullAt(v.plan, 0.9, v.scroll);
    for (const x of v.plan.stops.map((p, i) => ({ p, op: late.stops[i].op }))) if (!x.p.twin) expect(x.op).toBeGreaterThan(0);
    expect(Math.min(...late.rails)).toBeGreaterThan(0.5);
  });

  it("a straight pass between rest and the whole cook shows no travel: the lines' parts in their places", () => {
    const F = pullAt(v.plan, 0.7, v.scroll, 1);
    for (const s of F.stops) expect(still(s)).toBe(true);
    for (const g of [...F.rails, ...F.bends, F.heads]) expect(g).toBe(1);
  });
});

describe("at a level, and a hair off it", () => {
  it("a depth one float step off a level is that level: no pull (a glide can land there and rest)", () => {
    expect(pullShare(1)).toBe(0);
    expect(pullShare(1 + 2 ** -52)).toBe(0);
    expect(pullShare(1 - 2 ** -52)).toBe(0);
    expect(pullShare(2 - 2 ** -52)).toBe(1);
    expect(pullShare(2)).toBe(1);
    expect(pullShare(0.4)).toBe(0);
    // Off the level by more than a hair it is the pull.
    expect(pullShare(1.001)).toBeCloseTo(0.001, 9);
    expect(pullShare(1.5)).toBe(0.5);
    expect(pullShare(1.999)).toBeCloseTo(0.999, 9);
  });

  it("between the levels the set that is drawn is the one a cook can reach, the other is inert; at a level neither is", () => {
    // At rest: neither.
    expect(pullInert(false, 1, 0)).toEqual({ peek: false, whole: false });
    expect(pullInert(false, 0, 1)).toEqual({ peek: false, whole: false });
    // The peek drawn, the whole cook not yet (its header's way back is invisible): the whole cook is inert.
    expect(pullInert(true, 1, 0)).toEqual({ peek: false, whole: true });
    expect(pullInert(true, 0.6, 0.3)).toEqual({ peek: false, whole: true });
    // The whole cook drawn over the peek's last: it is live, the peek inert.
    expect(pullInert(true, 0.1, 0.4)).toEqual({ peek: true, whole: false });
    expect(pullInert(true, 0, 1)).toEqual({ peek: true, whole: false });
    // Neither drawn (a glide straight from rest, before the lines show): nothing invisible can be touched.
    expect(pullInert(true, 0, 0)).toEqual({ peek: false, whole: true });
  });
});

describe("a row whose step is inside a folded run", () => {
  it("travels to the run's stop: with another row of the run it gives way as it arrives, and the run's stop comes with the first", () => {
    // The pita on the tablet folds its runs (five dishes): find a cook position whose peek has a row inside one.
    let found = 0;
    for (const m of MEALS) {
      for (const pos of [...Array(screens(m.plan)).keys()]) {
        const v = laid(m.plan, at(m.plan, pos), 1280, 800);
        if (v.lines.form !== "columns") continue;
        const d = v.lines;
        v.plan.rows.forEach((r, i) => {
          const row = v.L.peek!.rows[i];
          if (r.kind !== "step" || row.kind !== "step" || !r.to) return;
          const stop = d.stops[r.to.stop];
          if (stop.foldedMarks.length < 2 || stop.mark === row.key) return;
          found++;
          expect(stop.foldedMarks, `${m.name} at ${pos}: ${row.key}`).toContain(row.key);
          // On landing it has given way to the run's stop.
          const F = pullAt(v.plan, 0.95, v.scroll);
          const f = F.rows[i];
          expect(f.kind === "step" && f.label.op).toBe(0);
          expect(F.stops[r.to.stop].op).toBe(1);
          // On the way a second row of the run is never whole within half its peek's gap of the first.
          if (r.to.lead) return;
          const lead = v.plan.rows.findIndex((q) => q.kind === "step" && q.to?.stop === r.to!.stop && q.to.lead);
          const head = v.plan.rows[lead];
          if (head.kind !== "step") throw new Error("the run's first row");
          for (let k = 1; k < 50; k++) {
            const G = pullAt(v.plan, k / 50, v.scroll);
            const a = G.rows[lead];
            const b = G.rows[i];
            if (a.kind !== "step" || b.kind !== "step") continue;
            const gap = r.from.y + b.label.dy - (head.from.y + a.label.dy);
            if (gap < r.to.gap / 2) expect(b.label.op, `${m.name} at ${pos}: ${row.key} ${gap.toFixed(0)} px under the run's first row at ${k / 50}`).toBeLessThan(0.2);
          }
        });
      }
    }
    expect(found, "a stored meal has a peek row inside a folded run").toBeGreaterThan(0);
  });
});

describe("every stored meal, at every shape, from four places in the cook", () => {
  const cases: { name: string; v: Laid; sc: (typeof SCREENS)[number] }[] = [];
  for (const m of MEALS) {
    for (const sc of SCREENS) {
      for (const pos of stands(m.plan)) cases.push({ name: `${m.name} at ${pos}, ${sc.name}`, v: laid(m.plan, at(m.plan, pos), sc.W, sc.H), sc });
    }
  }

  it("every step row of the peek maps to a stop the whole cook draws", () => {
    expect(cases.length).toBeGreaterThan(60);
    for (const { name, v } of cases) {
      const n = v.lines.form === "columns" ? v.lines.stops.length : (v.lines as ListDrawing).rows.filter((r) => r.kind === "step").length;
      v.plan.rows.forEach((r, i) => {
        if (r.kind !== "step") return;
        const row = v.L.peek!.rows[i];
        // The one row with no stop: As I go's Prep screen, in a cook whose lines draw no prep card.
        if (!r.to && row.kind === "step" && row.key === "prep") {
          expect(v.lines.form === "columns" ? v.lines.stops.some((q) => q.prep) : (v.lines as ListDrawing).rows.some((q) => q.prep), `${name}: no prep stop`).toBe(false);
          return;
        }
        expect(r.to, `${name}: row ${i} (${row.said})`).not.toBeNull();
        expect(r.to!.stop).toBeGreaterThanOrEqual(0);
        expect(r.to!.stop).toBeLessThan(n);
      });
      // The step in hand's row leads its stop: the stop comes with it.
      const first = v.plan.rows[0];
      if (first.kind === "step" && first.to) expect(first.to.lead, `${name}: the step in hand leads`).toBe(true);
    }
  });

  it("the break's row has that break's gap wherever the whole cook draws it", () => {
    for (const { name, v } of cases) {
      const row = v.L.peek!.rows.find((r) => r.kind === "break");
      if (!row || row.kind !== "break") continue;
      const ruled = v.plan.rows.find((r) => r.kind === "ruled");
      expect(ruled && ruled.kind === "ruled" && ruled.to, `${name}: ${row.said}`).toBeTruthy();
    }
  });

  it("at 0 the peek stands as laid and at 1 the whole cook does", () => {
    for (const { name, v } of cases) {
      const A = pullAt(v.plan, 0, v.scroll);
      for (const f of A.rows) {
        const parts = f.kind === "step" ? [f.dot, f.label, f.dish, f.minutes] : f.kind === "ruled" ? [f.words, f.rule] : [{ dx: 0, dy: 0, s: 1, op: f.op }];
        for (const m of parts) expect(still(m), name).toBe(true);
      }
      const B = pullAt(v.plan, 1, v.scroll);
      for (const s of B.stops) expect([Math.abs(s.dx) + Math.abs(s.dy) + Math.abs(s.dot.dx) + Math.abs(s.dot.dy) < 1e-9, Math.abs(s.s - 1) < 1e-9, s.op], name).toEqual([true, true, 1]);
      for (const b of B.breaks) expect([Math.abs(b.dx) + Math.abs(b.dy) < 1e-9, b.op], name).toEqual([true, 1]);
      for (const g of [...B.rails, ...B.hot, ...B.bends, ...B.shares, B.finish, B.heads, B.done]) expect(g, name).toBe(1);
      for (const f of B.rows) expect(f.kind === "step" ? Math.max(f.dot.op, f.label.op, f.dish.op, f.minutes.op) : f.kind === "ruled" ? Math.max(f.words.op, f.rule.op) : f.op, name).toBe(0);
    }
  });

  it("on the way the step in hand is always drawn to read, and nothing drawn leaves the sheet", () => {
    for (const { name, v, sc } of cases) {
      const g = v.L.geo;
      for (const t of [0.2, 0.4, 0.6, 0.8]) {
        const F = pullAt(v.plan, t, v.scroll);
        const first = v.plan.rows[0];
        const f = F.rows[0];
        if (first.kind !== "step" || f.kind !== "step") throw new Error(`${name}: the peek's first row is no step`);
        if (first.to) {
          // Its dot is one dot throughout: the row's, the stop's, or the two giving way at one place.
          const s = F.stops[first.to.stop];
          expect(1 - (1 - f.dot.op) * (1 - s.dot.op), `${name} at ${t}: the step in hand's dot`).toBeGreaterThanOrEqual(0.75);
          // Its words too, but for the middle of a hand-over between words that differ (one goes, then the other comes).
          const T = v.plan.T;
          const handing = !first.to.same && t > T.swap[0] && t < T.swap[1];
          if (!handing) expect(1 - (1 - f.label.op) * (1 - s.op), `${name} at ${t}: the step in hand`).toBeGreaterThanOrEqual(0.75);
        } else {
          // The Prep screen with no stop: its row, or a stop of the lines, is drawn whole.
          expect(Math.max(f.label.op, ...F.stops.map((s) => s.op)), `${name} at ${t}: something to read`).toBeGreaterThanOrEqual(0.75);
        }
        const Y = v.plan.Y1 + (v.plan.Y2 - v.plan.Y1) * t;
        for (const p of drawn(v, F, t)) {
          if (p.op <= 0.05) continue;
          expect(p.x, `${name} at ${t}: ${p.what} left of the sheet`).toBeGreaterThanOrEqual(0);
          expect(p.x, `${name} at ${t}: ${p.what} right of the sheet`).toBeLessThanOrEqual(sc.W);
          expect(p.y, `${name} at ${t}: ${p.what} over the sheet's edge`).toBeGreaterThanOrEqual(Y);
          expect(p.y, `${name} at ${t}: ${p.what} under the foot`).toBeLessThanOrEqual(g.footTop);
        }
      }
    }
  });

  it("the list form (upright, a phone, a one-dish meal): each row goes to the list's row of the same step, the list growing under it", () => {
    let lists = 0;
    for (const { name, v } of cases) {
      if (v.lines.form !== "list") continue;
      lists++;
      const steps = v.lines.rows.filter((r) => r.kind === "step");
      v.plan.rows.forEach((r, i) => {
        const row = v.L.peek!.rows[i];
        if (r.kind !== "step" || row.kind !== "step" || !r.to) return;
        const mine = new Set(row.key.split("+"));
        const theirs = steps[r.to.stop].mark!.split("+");
        expect(row.key === "prep" || theirs.some((k) => mine.has(k)), `${name}: ${row.key} to ${steps[r.to.stop].mark}`).toBe(true);
      });
      // Half way: every row still to land or its list row is drawn, so the sheet is never empty.
      const F = pullAt(v.plan, 0.5, v.scroll);
      const f = F.rows[0];
      const first = v.plan.rows[0];
      if (first.kind === "step" && first.to && f.kind === "step") {
        expect(f.dot.op + F.stops[first.to.stop].dot.op, name).toBeCloseTo(1, 6);
        if (first.to.same) expect(f.label.op + F.stops[first.to.stop].op, name).toBeCloseTo(1, 6);
      }
    }
    expect(lists).toBeGreaterThan(40);
  });
});
