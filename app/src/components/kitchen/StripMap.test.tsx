// @vitest-environment happy-dom
import { cleanup, render } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";
import { strip } from "@/lib/kitchen/cook-strip";
import { initialCookState, next, prepPages } from "@/lib/kitchen/cook-view";
import { SIDE } from "@/lib/kitchen/overview-place";
import { layoutStripMap, stationName, type StripMapDrawing } from "@/lib/kitchen/strip-map";
import { advanceMeasure as measure } from "@/lib/kitchen/__tests__/advance-measure";
import { timetableCorpus } from "@/lib/kitchen/__tests__/timetable-corpus";
import { StripMap } from "./StripMap";

afterEach(cleanup);

/**
 * A corpus cook `name` at its cooking step `pos` (past its prep pages, which
 * come before step 1 since DS v1.59), `dt` minutes on, mapped at level 1 in
 * portrait (or landscape).
 */
function mapAt(name: string, pos: number, dt: number, portrait = true): StripMapDrawing {
  const c = timetableCorpus().find((x) => x.name === name)!;
  const byId = new Map(c.plan.tasks.map((t) => [t.id, t]));
  let s = initialCookState("first");
  const pages = prepPages(c.plan, "first").length;
  for (let i = 0; i < pages + pos - 1; i++) s = next(c.plan, s);
  const st = strip(c.plan, s, null, 0);
  const side = portrait ? { x0: SIDE, x1: 600 - SIDE, portrait: { ttRight: 600 - SIDE - 72 } } : { x0: SIDE, x1: 960 - SIDE };
  return layoutStripMap({ marks: st.marks, now: st.now + dt, total: st.totalMinutes, name: (m) => stationName(m, byId), toTable: st.timeToTable, measure, ...side });
}

/** Draws maps in turn on one StripMap, as the cook sheet hands them over. */
function drawn(first: StripMapDrawing) {
  const props = { c: 1, lineTop: 300, now: 0, rootRef: null };
  const r = render(<StripMap map={first} glide={0} {...props} />);
  const root = () => r.container.querySelector<HTMLElement>("[data-strip-map]")!;
  return {
    root,
    to: (map: StripMapDrawing, glide: number) => r.rerender(<StripMap map={map} glide={glide} {...props} />),
  };
}

describe("StripMap: the stations move by key (T3 follow-up)", () => {
  it("runs a move on when the map is laid out again as it was, and ends it when the map changes (Codex)", () => {
    // The wait ends on the roast's simmer potatoes: its stations move.
    const a = mapAt("sunday-roast-dinner", 4, 12, false);
    const b = mapAt("sunday-roast-dinner", 4, 13, false);
    expect(a.stations.map((s) => s.key)).toContain("wait");
    expect(b.stations.map((s) => s.key)).not.toContain("wait");
    const m = drawn(a);
    m.to(b, 1);
    expect(m.root().dataset.moving, "the stations move").toBe("");
    const dot = m.root().querySelector<HTMLElement>('[data-station="heat-fat"] [data-sm-mark]')!;
    expect(dot.style.transition).toContain("left 420ms");
    // A pull's first move lays the sheet out under the finger: the same map, a new object.
    m.to(structuredClone(b), 1);
    expect(m.root().dataset.moving, "still moving").toBe("");
    expect(m.root().querySelector('[data-station="heat-fat"] [data-sm-mark]'), "the same dot").toBe(dot);
    expect(dot.style.transition, "still on its way").toContain("left 420ms");
    // A map that does change, unasked to move, stands at once (the glide lands in the new layout).
    m.to(mapAt("sunday-roast-dinner", 4, 20, false), 1);
    expect(m.root().dataset.moving).toBeUndefined();
    expect(dot.style.transition).toBe("");
  });

  it('counts "N more" down in a move: the old count leaves as the new one comes, its dot moves as itself', () => {
    const errors = vi.spyOn(console, "error").mockImplementation(() => {});
    const a = mapAt("sunday-roast-dinner", 1, 9);
    const b = mapAt("sunday-roast-dinner", 1, 10);
    const n = (d: StripMapDrawing) => d.stations.find((s) => s.kind === "more")!.n;
    expect([n(a), n(b)]).toEqual([15, 14]);
    const m = drawn(a);
    const dot = m.root().querySelector<HTMLElement>('[data-station="more"] [data-sm-mark]')!;
    m.to(b, 1);
    const more = b.words.find((w) => w.role === "more")!;
    const was = a.words.find((w) => w.role === "more")!;
    const arriving = [...m.root().querySelectorAll<HTMLElement>('[data-sm-word="more"]')];
    expect(arriving.map((e) => e.textContent), "one N more, the new count").toEqual([more.lines.join("")]);
    expect(arriving[0].dataset.smIn, "it comes in").toBe("word");
    const leaving = [...m.root().querySelectorAll<HTMLElement>("[data-sm-out]")].map((e) => e.textContent);
    expect(leaving, "the old count leaves").toContain(was.lines.join(""));
    expect(m.root().querySelector('[data-station="more"] [data-sm-mark]'), "the dot moves as itself").toBe(dot);
    expect(dot.style.transition).toContain("left 420ms");
    expect(errors, "no two parts on one key").not.toHaveBeenCalled();
    errors.mockRestore();
  });

  it("moves through a portrait rung change: the stations stand alike, their words set anew where their size changed", () => {
    const errors = vi.spyOn(console, "error").mockImplementation(() => {});
    // The roast after "Heat the fat" is due: the same stations, one rung down the chain (call 6).
    const a = mapAt("sunday-roast-dinner", 4, 3);
    const b = mapAt("sunday-roast-dinner", 4, 4);
    expect([a.rung, b.rung]).toEqual([3, 2]);
    expect(b.stations.map((s) => s.key)).toEqual(a.stations.map((s) => s.key));
    const m = drawn(a);
    // Each mark's element: a station draws its marks in the map's order.
    const els = (d: StripMapDrawing) =>
      new Map(
        d.marks.map((k) => {
          const i = d.marks.filter((x) => x.station === k.station && x.role === k.role).indexOf(k);
          return [k.k, m.root().querySelectorAll<HTMLElement>(`[data-station="${k.station}"] [data-sm-mark="${k.role}"]`)[i]];
        }),
      );
    const before = els(a);
    m.to(b, 1);
    expect(m.root().dataset.rung).toBe("2");
    const after = els(b);
    for (const k of b.marks) {
      const el = after.get(k.k)!;
      expect(el, `${k.k} moves as itself`).toBe(before.get(k.k));
      expect(el.style.transition, `${k.k} moves`).toContain("left 420ms");
      expect(parseFloat(el.style.left), `${k.k} goes to its new place`).toBeCloseTo(k.x, 3);
    }
    const old = new Map(a.words.map((w) => [w.k, w]));
    const seen = { anew: [] as string[], kept: [] as string[] };
    for (const w of b.words.filter((x) => x.role !== "tt-num" && x.role !== "tt-words")) {
      const o = old.get(w.k);
      const els = [...m.root().querySelectorAll<HTMLElement>(`[data-station="${w.station}"] [data-sm-word="${w.role}"]`)];
      expect(els, `${w.k}: drawn once`).toHaveLength(1);
      // A counting word counts in its box; any other moves as itself only with the same words at the same size.
      const resized = !o || o.size !== w.size || o.weight !== w.weight || (w.live ? !o.live : o.lines.join("\n") !== w.lines.join("\n"));
      expect(els[0].dataset.smIn, `${w.k}: ${resized ? "set anew" : "moves as itself"}`).toBe(resized ? "word" : undefined);
      (resized ? seen.anew : seen.kept).push(w.k);
    }
    // The rung changed a word's size, and others moved as themselves; what was set anew leaves as it was.
    expect(seen.anew.length, `set anew: ${seen.anew.join(", ")}`).toBeGreaterThan(0);
    expect(seen.kept.length, `kept: ${seen.kept.join(", ")}`).toBeGreaterThan(0);
    const leaving = [...m.root().querySelectorAll<HTMLElement>("[data-sm-out]")].map((e) => e.textContent);
    for (const k of seen.anew.filter((k) => old.has(k))) expect(leaving, `${k} leaves`).toContain(old.get(k)!.lines.join(""));
    expect(errors, "no two parts on one key").not.toHaveBeenCalled();
    errors.mockRestore();
  });
});

describe("StripMap: minimal Level 1 3-row upcoming steps drawer (Slice 2B)", () => {
  it("renders up to 3 borderless single-line upcoming steps with Meanwhile pill and minutes", () => {
    const a = mapAt("sunday-roast-dinner", 1, 0, false);
    const onStepTap = vi.fn();
    const peekSteps = [
      { key: "slice-onion", text: "Slice the onion", minutes: 4, isMeanwhile: true, taskId: "slice-onion" },
      { key: "heat-fat", text: "Heat the fat in the roasting tin", minutes: 5, isMeanwhile: false, taskId: "heat-fat" },
      { key: "roast-potatoes", text: "Turn potatoes in the hot fat and roast", minutes: 40, isMeanwhile: false, taskId: "roast-potatoes" },
    ];
    const r = render(
      <StripMap
        map={a}
        c={1}
        lineTop={300}
        now={10}
        glide={0}
        rootRef={null}
        peekSteps={peekSteps}
        portrait={false}
        onStepTap={onStepTap}
      />,
    );
    const list = r.container.querySelector<HTMLElement>("[data-peek-list]")!;
    expect(list).not.toBeNull();
    const rows = [...list.querySelectorAll<HTMLElement>("[data-peek-step]")];
    expect(rows).toHaveLength(3);
    expect(rows[0].querySelector("[data-peek-meanwhile]")?.textContent).toBe("Meanwhile");
    expect(rows[0].querySelector("[data-peek-text]")?.textContent).toBe("Slice the onion");
    expect(rows[0].querySelector("[data-peek-minutes]")?.textContent).toBe("4 min");
    expect(rows[1].querySelector("[data-peek-meanwhile]")).toBeNull();
    expect(rows[1].querySelector("[data-peek-text]")?.textContent).toBe("Heat the fat in the roasting tin");
    expect(rows[1].querySelector("[data-peek-minutes]")?.textContent).toBe("5 min");
    rows[1].click();
    expect(onStepTap).toHaveBeenCalledWith(peekSteps[1]);
  });
});

