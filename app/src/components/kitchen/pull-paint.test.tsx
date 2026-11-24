// @vitest-environment happy-dom
import { cleanup, render } from "@testing-library/react";
import { afterEach, describe, expect, it } from "vitest";
import { MealLines } from "./MealLines";
import { PeekRows } from "./PeekRows";
import { MEALS, SCREENS, at, laid, roast, screens, type Laid } from "./pull-harness";
import { PullPaint } from "./pull-paint";
import { PULL_COLUMNS, pullAt } from "./pull-travel";

afterEach(cleanup);

/** The peek and the whole cook's lines on a page, as the sheet holds them. */
function page(v: Laid) {
  const { container } = render(
    <div>
      <div data-peek>
        <PeekRows d={v.L.peek!} c={v.L.geo.c} />
      </div>
      <div data-whole-lines>
        <MealLines drawing={v.lines} c={v.L.geo.c} onRead={() => {}} readMark={null} tab={0} />
      </div>
    </div>,
  );
  return { peek: container.querySelector<HTMLElement>("[data-peek]")!, lines: container.querySelector<HTMLElement>("[data-whole-lines]")! };
}

/** Every part under a root that carries a transform or an opacity written on it. */
const written = (root: HTMLElement) => [...root.querySelectorAll<HTMLElement>("*")].filter((el) => el.style.transform !== "" || el.style.opacity !== "");

describe("the pull set down on the page", () => {
  it("every stored meal at every shape: the page holds the plan's parts, each in the plan's order", () => {
    let n = 0;
    for (const m of MEALS) {
      for (const sc of SCREENS) {
        const v = laid(m.plan, at(m.plan, Math.floor(screens(m.plan) / 3)), sc.W, sc.H);
        const p = page(v);
        const paint = new PullPaint();
        expect(paint.bind(v.plan, p.peek, p.lines), `${m.name}, ${sc.name}`).toBe(true);
        // A stop's words and its dot are found by the same stop, in the plan's order.
        const stops = [...p.lines.querySelectorAll("[data-line-stop]")].map((el) => el.getAttribute("data-line-stop"));
        const dots = [...p.lines.querySelectorAll("[data-line-dot]")].map((el) => el.getAttribute("data-line-dot"));
        expect(dots, `${m.name}, ${sc.name}`).toEqual(stops);
        paint.release();
        cleanup();
        n++;
      }
    }
    expect(n).toBeGreaterThan(20);
  });

  it("a frame moves the step in hand's row and its stop to one place, and away from the pull every part is as drawn", () => {
    const v = laid(roast, at(roast, 10), 1280, 800);
    const p = page(v);
    const paint = new PullPaint();
    expect(paint.bind(v.plan, p.peek, p.lines)).toBe(true);
    expect(written(p.peek).length + written(p.lines).length).toBe(0);

    // Part-way into its column: the row and its stop both carry the shift and the scale, the stop not yet seen.
    const narrowing = (PULL_COLUMNS.x[0] + PULL_COLUMNS.x[1]) / 2;
    paint.paint(pullAt(v.plan, narrowing, 0));
    const label = p.peek.querySelector<HTMLElement>("li[data-peek-now] [data-peek-label]")!;
    const first = v.plan.rows[0];
    if (first.kind !== "step" || !first.to) throw new Error("the step in hand has no stop");
    const stop = p.lines.querySelectorAll<HTMLElement>("[data-line-stop]")[first.to.stop];
    expect(label.style.transform).toMatch(/^translate\(.+\) scale\(/);
    expect(stop.style.transform).toMatch(/^translate\(.+\) scale\(/);
    expect(label.style.opacity).toBe("");
    expect(stop.style.opacity).toBe("0.000");
    // In the wide form the row has shed its dish and its minutes on the way: only its words travel.
    const nowRow = label.closest("li")!;
    expect(nowRow.querySelector<HTMLElement>("[data-peek-dish]")!.style.opacity).toBe("0.000");
    expect(nowRow.querySelector<HTMLElement>("[data-peek-minutes]")!.style.opacity).toBe("0.000");
    // The break's "then" and "while it roasts" have gone; "50 min free" is still there.
    expect(p.peek.querySelector<HTMLElement>("[data-peek-lead]")!.style.opacity).toBe("0.000");
    expect(p.peek.querySelector<HTMLElement>("[data-peek-words]")!.style.opacity).not.toBe("0.000");

    // Half-way through giving way: one for the other.
    const giving = (PULL_COLUMNS.swap[0] + PULL_COLUMNS.swap[1]) / 2;
    paint.paint(pullAt(v.plan, giving, 0));
    expect(Number(label.style.opacity) + Number(stop.style.opacity)).toBeCloseTo(1, 2);
    expect(Number(stop.style.opacity)).toBeGreaterThan(0.2);
    expect(Number(stop.style.opacity)).toBeLessThan(0.8);
    // The row scales about its words' left on the first line's middle, so the place said is the place drawn.
    expect(label.style.transformOrigin).toBe(`0.0px ${first.from.origin.y.toFixed(1)}px`);

    // The same frame again writes nothing: a part is written only where its value changed.
    let writes = 0;
    const style = stop.style;
    const spy = new Proxy(style, {
      set(target, key, value) {
        writes++;
        return Reflect.set(target, key, value);
      },
    });
    Object.defineProperty(stop, "style", { value: spy, configurable: true });
    paint.paint(pullAt(v.plan, giving, 0));
    expect(writes).toBe(0);
    Object.defineProperty(stop, "style", { value: style, configurable: true });

    paint.clear();
    expect(written(p.peek).map((el) => el.outerHTML.slice(0, 80))).toEqual([]);
    expect(written(p.lines).map((el) => el.outerHTML.slice(0, 80))).toEqual([]);
    paint.release();
    expect(label.style.transformOrigin).toBe("");
  });

  it("a page that does not hold the plan's parts takes no plan, and takes it once it does (a render between the two is no lock-out)", () => {
    const v = laid(roast, at(roast, 10), 1280, 800);
    const p = page(v);
    const paint = new PullPaint();
    // The page a row short of the plan (the peek not yet drawn for this layout): nothing is bound.
    const li = p.peek.querySelector("li[data-peek-row]")!;
    const home = li.parentElement!;
    const after = li.nextSibling;
    li.remove();
    expect(paint.bind(v.plan, p.peek, p.lines)).toBe(false);
    expect(paint.plan).toBeNull();
    // Painting with nothing bound writes nothing.
    paint.paint(pullAt(v.plan, 0.5, 0));
    expect(written(p.lines).length).toBe(0);
    // The same plan against the same page is not looked for again, frame after frame: no query.
    let queries = 0;
    for (const root of [p.peek, p.lines]) {
      const all = root.querySelectorAll.bind(root);
      const one = root.querySelector.bind(root);
      root.querySelectorAll = ((sel: string) => (queries++, all(sel))) as typeof root.querySelectorAll;
      root.querySelector = ((sel: string) => (queries++, one(sel))) as typeof root.querySelector;
    }
    expect(paint.wants(v.plan)).toBe(false);
    for (let frame = 0; frame < 5; frame++) expect(paint.bind(v.plan, p.peek, p.lines)).toBe(false);
    expect(queries, "queries over five more frames of a plan the page does not hold").toBe(0);
    // The page drawn anew: the same plan is tried once more, and binds.
    home.insertBefore(li, after);
    paint.redrawn();
    expect(paint.wants(v.plan)).toBe(true);
    expect(paint.bind(v.plan, p.peek, p.lines)).toBe(true);
    expect(queries).toBeGreaterThan(0);
    expect(paint.plan).toBe(v.plan);
    // Bound and still on the page: nothing to look for.
    expect(paint.wants(v.plan)).toBe(false);
    expect(paint.bind(null, p.peek, p.lines)).toBe(false);
    expect(paint.plan).toBeNull();
  });

  it("away from the pull nothing of it is left: no style on any node, no listener on the lines' box", () => {
    for (const sc of SCREENS) {
      const v = laid(roast, at(roast, 10), sc.W, sc.H);
      const p = page(v);
      const nodes = [...p.peek.querySelectorAll("*"), ...p.lines.querySelectorAll("*"), p.peek, p.lines];
      const before = nodes.map((el) => el.getAttribute("style"));
      const paint = new PullPaint();
      let heard = 0;
      expect(paint.bind(v.plan, p.peek, p.lines, () => heard++)).toBe(true);
      for (const t of [0.05, 0.3, 0.6, 0.8, 0.95]) paint.paint(pullAt(v.plan, t, 0));
      expect(nodes.filter((el, i) => el.getAttribute("style") !== before[i]).length, sc.name).toBeGreaterThan(4);
      paint.release();
      // An emptied style attribute and none are the same to the page.
      const left = nodes.filter((el, i) => (el.getAttribute("style") || null) !== (before[i] || null));
      expect(left.map((el) => `${el.outerHTML.slice(0, 90)}`), sc.name).toEqual([]);
      expect(paint.plan).toBeNull();
      p.lines.scrollTop = 40;
      p.lines.dispatchEvent(new Event("scroll"));
      expect(heard, `${sc.name}: heard after letting go`).toBe(0);
      cleanup();
    }
  });

  it("the lines scrolled in their box while bound: the new offset is heard, and the frame in hand asked for again", () => {
    const v = laid(roast, at(roast, 10), 800, 1280);
    const p = page(v);
    const paint = new PullPaint();
    let heard = 0;
    p.lines.scrollTop = 12;
    expect(paint.bind(v.plan, p.peek, p.lines, () => heard++)).toBe(true);
    // Read once as the plan is taken.
    expect(paint.scroll).toBe(12);
    p.lines.scrollTop = 96;
    p.lines.dispatchEvent(new Event("scroll"));
    expect([paint.scroll, heard]).toEqual([96, 1]);
    // The same offset again asks for nothing.
    p.lines.dispatchEvent(new Event("scroll"));
    expect(heard).toBe(1);
    paint.release();
  });

  it("the whole cook's ink: its lines carry none at the peek's end of the pull, and a stop's dot crosses with its row's", () => {
    const v = laid(roast, at(roast, 10), 1280, 800);
    const p = page(v);
    const paint = new PullPaint();
    expect(paint.bind(v.plan, p.peek, p.lines)).toBe(true);
    paint.paint(pullAt(v.plan, 0.002, 0));
    const rails = [...p.lines.querySelectorAll<SVGElement>("[data-line-rail]")];
    expect(rails.length).toBeGreaterThan(0);
    for (const r of rails) expect(Number(r.style.opacity)).toBeLessThan(0.05);
    const first = v.plan.rows[0];
    if (first.kind !== "step" || !first.to) throw new Error("the step in hand has no stop");
    const giving = (PULL_COLUMNS.swap[0] + PULL_COLUMNS.swap[1]) / 2;
    paint.paint(pullAt(v.plan, giving, 0));
    const rowDot = p.peek.querySelector<HTMLElement>("li[data-peek-now] [data-peek-dot]")!;
    const stopDot = p.lines.querySelectorAll<SVGElement>("[data-line-dot]")[first.to.stop];
    expect(Number(rowDot.style.opacity) + Number(stopDot.style.opacity)).toBeCloseTo(1, 2);
    for (const r of rails) expect(r.style.opacity).toBe("");
    paint.release();
  });
});
