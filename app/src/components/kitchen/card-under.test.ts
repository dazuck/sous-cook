// @vitest-environment happy-dom
import { afterEach, describe, expect, it } from "vitest";
import { cardUnder } from "./card-under";

/** Places an element where the browser would report it (happy-dom lays nothing out). */
function at(el: HTMLElement, left: number, top: number, w: number, h: number) {
  el.getBoundingClientRect = () => ({ left, top, right: left + w, bottom: top + h, width: w, height: h, x: left, y: top, toJSON: () => ({}) }) as DOMRect;
  return el;
}

afterEach(() => {
  document.body.innerHTML = "";
});

describe("cardUnder: the card a tap on the timetable lands on", () => {
  it("never a stop scrolled out of the meal's lines' box, though its own box says it is under the finger (review: touch 4)", () => {
    // The whole cook's lines scroll in a box 300 px tall from y 200; the first stop has scrolled up
    // behind the header (y 120), the second shows (y 260).
    const root = document.createElement("div");
    const box = at(document.createElement("div"), 0, 200, 800, 300);
    box.setAttribute("data-lines-scroll", "");
    const gone = at(document.createElement("button"), 0, 120, 400, 48);
    gone.setAttribute("data-card", "s1");
    const shown = at(document.createElement("button"), 0, 260, 400, 48);
    shown.setAttribute("data-card", "s2");
    box.append(gone, shown);
    root.append(box);
    document.body.append(root);
    // A tap on the header's empty space, where the scrolled-off stop sits unseen: nothing.
    expect(cardUnder(root, 100, 140)).toBeNull();
    // A tap on the stop that shows reads it.
    expect(cardUnder(root, 100, 280)).toBe("s2");
  });

  it("the Prep block, and a card outside any scroll box, as drawn", () => {
    const root = document.createElement("div");
    const prep = at(document.createElement("div"), 0, 0, 200, 60);
    prep.setAttribute("data-prep-card", "");
    const card = at(document.createElement("div"), 300, 0, 200, 60);
    card.setAttribute("data-card", "s3");
    root.append(prep, card);
    document.body.append(root);
    expect(cardUnder(root, 10, 10)).toBe("prep");
    expect(cardUnder(root, 310, 10)).toBe("s3");
    expect(cardUnder(root, 250, 10)).toBeNull();
  });
});
