import { describe, expect, it } from "vitest";
import { GAP_MIN, WORK_MIN, gapRows, lineFills, lineParts, linePartsOf, type LinePart } from "./strip-line";
import { initialCookState, next, type CookState } from "./cook-view";
import { identityPlan, parseCookPlan, type CookPlan } from "./cook-plan";
import { strip } from "./cook-strip";
import { loadCookPlanFixtures, loadCookPlanSnapshots } from "./__tests__/load-cook-plan-fixtures";

function corpusPlan(name: string): CookPlan {
  const fixture = loadCookPlanFixtures().find((f) => f.name === name);
  const raw = loadCookPlanSnapshots().get(name)?.raw;
  if (!fixture || !raw) throw new Error(`no corpus plan ${name}`);
  const parsed = parseCookPlan(raw, fixture.recipe);
  if (!parsed.ok) throw new Error(`${name} did not parse`);
  return parsed.plan;
}

const work = (ps: LinePart[]) => ps.filter((p) => p.kind === "work");
const gaps = (ps: LinePart[]) => ps.filter((p) => p.kind === "gap");
const width = (p: LinePart) => p.x1 - p.x0;

describe("gapRows: the compressed scale confirmed for the lanes (DECISIONS 2026-11-22)", () => {
  it("steps at 5, 15 and 30 minutes", () => {
    expect([1, 5, 6, 15, 16, 30, 31, 240].map(gapRows)).toEqual([1, 1, 1.25, 1.25, 1.6, 1.6, 1.9, 1.9]);
  });
});

describe("lineParts: work at true minutes, a gap at each break", () => {
  it("with no break the line is one segment from end to end", () => {
    const ps = lineParts(60, [], 500);
    expect(ps).toEqual([{ kind: "work", from: 0, to: 60, x0: 0, x1: 500 }]);
  });

  it("puts each break as a gap between two segments, in time order, filling the width exactly", () => {
    // Two breaks given out of order.
    const ps = lineParts(100, [{ from: 70, to: 90 }, { from: 20, to: 30 }], 800);
    expect(ps.map((p) => `${p.kind}:${p.from}-${p.to}`)).toEqual(["work:0-20", "gap:20-30", "work:30-70", "gap:70-90", "work:90-100"]);
    expect(ps[0].x0).toBe(0);
    expect(ps[ps.length - 1].x1).toBeCloseTo(800, 6);
    for (let i = 1; i < ps.length; i++) expect(ps[i].x0).toBeCloseTo(ps[i - 1].x1, 6);
  });

  it("draws work at true minutes: a segment twice as long in minutes is twice as wide", () => {
    const ps = work(lineParts(100, [{ from: 20, to: 30 }, { from: 70, to: 90 }], 800));
    expect(width(ps[1]) / width(ps[0])).toBeCloseTo(40 / 20, 6);
    expect(width(ps[2]) / width(ps[0])).toBeCloseTo(10 / 20, 6);
  });

  it("draws a break on the compressed scale, never at its minutes: 50 minutes is under twice 10", () => {
    const ps = gaps(lineParts(200, [{ from: 20, to: 30 }, { from: 80, to: 130 }], 1200));
    expect(width(ps[1]) / width(ps[0])).toBeCloseTo(1.9 / 1.25, 6);
    // and far narrower than its minutes would make it
    expect(width(ps[1])).toBeLessThan((50 / 200) * 1200 * 0.25);
  });

  it("keeps a four-hour break quiet: it is no wider than a 31-minute one", () => {
    const a = gaps(lineParts(300, [{ from: 20, to: 260 }], 1000))[0];
    const b = gaps(lineParts(300, [{ from: 20, to: 51 }], 1000))[0];
    // The work around them differs, so compare each gap's share of the work it sits in.
    const wa = width(a) / work(lineParts(300, [{ from: 20, to: 260 }], 1000)).reduce((s, p) => s + width(p), 0);
    const wb = width(b) / work(lineParts(300, [{ from: 20, to: 51 }], 1000)).reduce((s, p) => s + width(p), 0);
    expect(wa).toBeCloseTo(wb, 6);
  });

  it("gives every gap and every segment a floor, however many short breaks crowd a short line", () => {
    const frees = Array.from({ length: 8 }, (_, i) => ({ from: 10 + i * 12, to: 20 + i * 12 }));
    const ps = lineParts(110, frees, 150);
    for (const g of gaps(ps)) expect(width(g)).toBeGreaterThanOrEqual(GAP_MIN - 1e-9);
    for (const w of work(ps)) expect(width(w)).toBeGreaterThanOrEqual(WORK_MIN - 1e-9);
    expect(ps[ps.length - 1].x1).toBeCloseTo(150, 6);
  });

  it("drops a break that touches either end of the cook, so no gap ever opens the line or closes it", () => {
    const ps = lineParts(60, [{ from: 0, to: 10 }, { from: 50, to: 60 }], 300);
    expect(gaps(ps)).toHaveLength(0);
    expect(ps).toHaveLength(1);
  });

  it("is empty with no width or no minutes, rather than drawing a sliver", () => {
    expect(lineParts(60, [], 0)).toEqual([]);
    expect(lineParts(0, [], 300)).toEqual([]);
  });
});

describe("lineFills: Ink to the end of the step, never inside a gap", () => {
  const ps = lineParts(100, [{ from: 20, to: 30 }, { from: 70, to: 90 }], 800);

  it("fills the segments before the step whole, the one it is in in part, and none after", () => {
    expect(lineFills(ps, 50)).toEqual([1, 0.5, 0]);
  });

  it("a fill that ends inside a break leaves the segment before it full and the gap empty", () => {
    expect(lineFills(ps, 25)).toEqual([1, 0, 0]);
    expect(lineFills(ps, 80)).toEqual([1, 1, 0]);
  });

  it("is empty at 0 and full at the end", () => {
    expect(lineFills(ps, 0)).toEqual([0, 0, 0]);
    expect(lineFills(ps, 100)).toEqual([1, 1, 1]);
    expect(lineFills(ps, 140)).toEqual([1, 1, 1]);
  });
});

describe("linePartsOf: the strip's own breaks", () => {
  const roast = corpusPlan("sunday-roast-dinner");

  it("cuts the Sunday roast at its three breaks (10, 10 and 50 minutes free)", () => {
    const s = strip(roast, initialCookState("first"));
    const ps = linePartsOf(s, 1000);
    expect(gaps(ps).map((g) => `${g.from}-${g.to}`)).toEqual(["21-31", "36-49", "56-106"]);
    expect(work(ps)).toHaveLength(4);
  });

  it("fills to the end of the step in hand on every screen, and never steps back as the cook steps on", () => {
    for (const mode of ["first", "go"] as const) {
      let st: CookState = initialCookState(mode);
      let last = -1;
      for (let i = 0; i < 40; i++) {
        const s = strip(roast, st);
        const ps = linePartsOf(s, 1000);
        const fills = lineFills(ps, s.progress);
        const drawn = work(ps).reduce((sum, p, k) => sum + width(p) * fills[k], 0);
        expect(drawn).toBeGreaterThanOrEqual(last - 1e-6);
        last = drawn;
        const n = next(roast, st);
        if (n === st || n.pos === st.pos) break;
        st = n;
      }
      // the last screen is the whole line
      const s = strip(roast, st);
      expect(lineFills(linePartsOf(s, 1000), s.progress).every((f) => f === 1)).toBe(true);
    }
  });

  it("as written: one segment, filled by the count of screens", () => {
    const plan = identityPlan({ steps: ["One.", "Two.", "Three.", "Four."] });
    let st = initialCookState("go");
    st = next(plan, st);
    const s = strip(plan, st);
    const ps = linePartsOf(s, 400);
    expect(ps).toHaveLength(1);
    expect(lineFills(ps, s.progress)[0]).toBeCloseTo((st.pos + 1) / 4, 6);
  });
});
