// @vitest-environment happy-dom
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { installPressIn, MOVE_SLOP } from "./press-in";

/** jsdom has no PointerEvent: a MouseEvent of the pointer's name carrying a pointerId. */
function pointer(
  type: string,
  target: Element,
  at = { x: 10, y: 10 },
  id = 1,
  opts: { button?: number; kind?: string; primary?: boolean } = {},
) {
  const e = new MouseEvent(type, { bubbles: true, cancelable: true, clientX: at.x, clientY: at.y, button: opts.button ?? 0 });
  Object.defineProperty(e, "pointerId", { value: id });
  Object.defineProperty(e, "pointerType", { value: opts.kind ?? "touch" });
  Object.defineProperty(e, "isPrimary", { value: opts.primary ?? true });
  target.dispatchEvent(e);
}

let stop: () => void;
let button: HTMLButtonElement;
let inner: HTMLSpanElement;

beforeEach(() => {
  vi.useFakeTimers({ toFake: ["requestAnimationFrame"] });
  document.body.innerHTML = `<button id="b"><span id="s">Start</span></button><div id="plain">x</div><button id="d" disabled>no</button><button id="ad" aria-disabled="true">no</button><a id="l" href="/x">go</a>`;
  button = document.getElementById("b") as HTMLButtonElement;
  inner = document.getElementById("s") as HTMLSpanElement;
  stop = installPressIn(document);
});
afterEach(() => {
  stop();
  vi.useRealTimers();
});

describe("press-in (F10, F11)", () => {
  it("marks the pressable at pointer-down, whichever of its children took the touch", () => {
    pointer("pointerdown", inner);
    expect(button.hasAttribute("data-pressed")).toBe(true);
  });

  it("lets go on release, and a release is the fade (no snap)", () => {
    pointer("pointerdown", button);
    pointer("pointerup", button);
    expect(button.hasAttribute("data-pressed")).toBe(false);
    expect(button.hasAttribute("data-press-snap")).toBe(false);
  });

  it("ignores what isn't pressable, and what is disabled", () => {
    pointer("pointerdown", document.getElementById("plain")!);
    pointer("pointerdown", document.getElementById("d")!);
    expect(document.querySelector("[data-pressed]")).toBeNull();
  });

  it("small movement is still a press", () => {
    pointer("pointerdown", button, { x: 10, y: 10 });
    pointer("pointermove", button, { x: 10 + MOVE_SLOP, y: 10 });
    expect(button.hasAttribute("data-pressed")).toBe(true);
  });

  it("clears with no fade once the pointer moves past the slop, then lets the control's own fade back in", () => {
    pointer("pointerdown", button, { x: 10, y: 10 });
    pointer("pointermove", button, { x: 10 + MOVE_SLOP + 1, y: 10 });
    expect(button.hasAttribute("data-pressed")).toBe(false);
    expect(button.hasAttribute("data-press-snap")).toBe(true);
    vi.advanceTimersByTime(100);
    expect(button.hasAttribute("data-press-snap")).toBe(false);
  });

  it("clears with no fade when the browser cancels the pointer (a scroll took it)", () => {
    pointer("pointerdown", button);
    pointer("pointercancel", button);
    expect(button.hasAttribute("data-pressed")).toBe(false);
    expect(button.hasAttribute("data-press-snap")).toBe(true);
  });

  it("clears with no fade when something scrolls", () => {
    pointer("pointerdown", button);
    document.dispatchEvent(new Event("scroll"));
    expect(button.hasAttribute("data-pressed")).toBe(false);
    expect(button.hasAttribute("data-press-snap")).toBe(true);
  });

  it("clears when the page loses focus", () => {
    pointer("pointerdown", button);
    window.dispatchEvent(new Event("blur"));
    expect(button.hasAttribute("data-pressed")).toBe(false);
  });

  it("a stale press (no pointer-up) is cleared by the next pointer-down", () => {
    pointer("pointerdown", button);
    const other = document.getElementById("plain")!;
    pointer("pointerdown", other);
    expect(button.hasAttribute("data-pressed")).toBe(false);
  });

  it("a key press on a control is a press: sand while Enter or Space is down, faded out on keyup", () => {
    const key = (type: string, k: string, target: Element) =>
      target.dispatchEvent(new KeyboardEvent(type, { key: k, bubbles: true, cancelable: true }));
    key("keydown", " ", button);
    expect(button.hasAttribute("data-pressed")).toBe(true);
    key("keyup", " ", button);
    expect(button.hasAttribute("data-pressed")).toBe(false);
    expect(button.hasAttribute("data-press-snap")).toBe(false);
    // Other keys, and a link on Space (which a link doesn't act on), are not presses.
    key("keydown", "a", button);
    expect(button.hasAttribute("data-pressed")).toBe(false);
  });

  it("leaves another pointer's release alone", () => {
    pointer("pointerdown", button, { x: 1, y: 1 }, 1);
    pointer("pointerup", button, { x: 1, y: 1 }, 2);
    expect(button.hasAttribute("data-pressed")).toBe(true);
  });

  it("the slop is 6 px: a pointer 6 px away is still pressing, 7 px is a scroll", () => {
    expect(MOVE_SLOP).toBe(6);
    pointer("pointerdown", button, { x: 10, y: 10 });
    pointer("pointermove", button, { x: 16, y: 10 });
    expect(button.hasAttribute("data-pressed")).toBe(true);
    pointer("pointermove", button, { x: 17, y: 10 });
    expect(button.hasAttribute("data-pressed")).toBe(false);
  });

  it("another pointer's movement is not this press's scroll (move checks the pointer id)", () => {
    pointer("pointerdown", button, { x: 10, y: 10 }, 1);
    pointer("pointermove", button, { x: 200, y: 200 }, 2);
    expect(button.hasAttribute("data-pressed")).toBe(true);
  });

  it("losing visibility clears the press with no fade", () => {
    pointer("pointerdown", button);
    document.dispatchEvent(new Event("visibilitychange"));
    expect(button.hasAttribute("data-pressed")).toBe(false);
    expect(button.hasAttribute("data-press-snap")).toBe(true);
  });

  it("a mouse's right button is not a press, its left button is", () => {
    pointer("pointerdown", button, { x: 1, y: 1 }, 1, { kind: "mouse", button: 2 });
    expect(button.hasAttribute("data-pressed")).toBe(false);
    pointer("pointerdown", button, { x: 1, y: 1 }, 1, { kind: "mouse", button: 0 });
    expect(button.hasAttribute("data-pressed")).toBe(true);
  });

  it("an aria-disabled control is not pressed", () => {
    pointer("pointerdown", document.getElementById("ad")!);
    expect(document.querySelector("[data-pressed]")).toBeNull();
  });

  it("a link is pressed by Enter, not by Space (a link doesn't act on it)", () => {
    const link = document.getElementById("l")!;
    const key = (type: string, k: string) => link.dispatchEvent(new KeyboardEvent(type, { key: k, bubbles: true, cancelable: true }));
    key("keydown", " ");
    expect(link.hasAttribute("data-pressed")).toBe(false);
    key("keydown", "Enter");
    expect(link.hasAttribute("data-pressed")).toBe(true);
  });

  it("a held key's repeats are not new presses", () => {
    button.dispatchEvent(new KeyboardEvent("keydown", { key: "Enter", repeat: true, bubbles: true, cancelable: true }));
    expect(button.hasAttribute("data-pressed")).toBe(false);
  });

  it("a second finger doesn't clear the first finger's held press, and its release leaves it too", () => {
    const other = document.getElementById("l")!;
    pointer("pointerdown", button, { x: 10, y: 10 }, 1);
    pointer("pointerdown", other, { x: 90, y: 90 }, 2, { primary: false });
    expect(button.hasAttribute("data-pressed")).toBe(true);
    expect(other.hasAttribute("data-pressed")).toBe(false);
    pointer("pointerup", other, { x: 90, y: 90 }, 2, { primary: false });
    expect(button.hasAttribute("data-pressed")).toBe(true);
    pointer("pointerup", button, { x: 10, y: 10 }, 1);
    expect(button.hasAttribute("data-pressed")).toBe(false);
  });
});
