// @vitest-environment happy-dom
import { afterEach, describe, expect, it } from "vitest";
import {
  TAP_MS,
  TAP_SLOP,
  tapFenced,
  tapZone,
  type TapFlow,
  type TapPoint,
} from "./tap-zone";

// A 900px stage starting 100px in: the back third ends at x = 400.
const BOX = { left: 100, width: 900 };
const MID: TapFlow = { atStart: false, isLast: false };

function tap(x: number, { dx = 0, dy = 0, ms = 80 } = {}): [TapPoint, TapPoint] {
  return [
    { x, y: 300, t: 1000 },
    { x: x + dx, y: 300 + dy, t: 1000 + ms },
  ];
}

describe("tapZone", () => {
  it("goes back from the left third and on from the right two thirds", () => {
    expect(tapZone(...tap(101), BOX, MID)).toBe("back");
    expect(tapZone(...tap(399), BOX, MID)).toBe("back");
    expect(tapZone(...tap(400), BOX, MID)).toBe("next");
    expect(tapZone(...tap(999), BOX, MID)).toBe("next");
  });

  it("counts only a tap: a drag past the slop or a press held too long is nothing", () => {
    expect(tapZone(...tap(700, { dx: TAP_SLOP }), BOX, MID)).toBe("next");
    expect(tapZone(...tap(700, { dx: TAP_SLOP + 1 }), BOX, MID)).toBeNull();
    expect(tapZone(...tap(700, { dy: -(TAP_SLOP + 1) }), BOX, MID)).toBeNull();
    // A diagonal that stays within the slop on each axis but not in distance.
    expect(tapZone(...tap(700, { dx: 8, dy: 8 }), BOX, MID)).toBeNull();
    expect(tapZone(...tap(700, { ms: TAP_MS }), BOX, MID)).toBe("next");
    expect(tapZone(...tap(700, { ms: TAP_MS + 1 }), BOX, MID)).toBeNull();
  });

  it("never finishes: next does nothing on the last screen, back still works", () => {
    const last: TapFlow = { atStart: false, isLast: true };
    expect(tapZone(...tap(700), BOX, last)).toBeNull();
    expect(tapZone(...tap(200), BOX, last)).toBe("back");
  });

  it("has nothing to go back to on the first screen", () => {
    const first: TapFlow = { atStart: true, isLast: false };
    expect(tapZone(...tap(200), BOX, first)).toBeNull();
    expect(tapZone(...tap(700), BOX, first)).toBe("next");
  });

  it("reads the zone from where the finger went down, so a stage with no width is nothing", () => {
    // Down in the back third, lifted just across the line: still back.
    expect(tapZone(...tap(395, { dx: 8 }), BOX, MID)).toBe("back");
    expect(tapZone(...tap(300), { left: 0, width: 0 }, MID)).toBeNull();
  });
});

function mount(html: string): HTMLElement {
  const host = document.createElement("div");
  host.innerHTML = html;
  document.body.appendChild(host);
  return host;
}

afterEach(() => {
  document.body.innerHTML = "";
});

describe("tapFenced", () => {
  it("leaves a tap on the step text to the zones", () => {
    const host = mount(`<div><p><strong id="t">Salt</strong> the water</p></div>`);
    expect(tapFenced(host.querySelector("#t"))).toBe(false);
  });

  it("fences anything that answers a tap itself, and whatever is inside it", () => {
    const host = mount(`
      <button id="b"><svg><path id="icon"/></svg></button>
      <a href="#" id="a">link</a>
      <label id="l">Salt<input type="checkbox"></label>
      <input id="i"><textarea id="ta"></textarea><select id="s"></select>
      <span role="button" id="rb">x</span>
      <div data-no-tap><span id="chip">2 tbsp</span></div>
      <div contenteditable="true" id="ce">x</div>
    `);
    for (const id of ["b", "icon", "a", "l", "i", "ta", "s", "rb", "chip", "ce"]) {
      expect(tapFenced(host.querySelector(`#${id}`)), id).toBe(true);
    }
  });

  it("fences a tap with no element to read", () => {
    expect(tapFenced(null)).toBe(true);
  });
});
