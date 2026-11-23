// @vitest-environment happy-dom
import { renderHook } from "@testing-library/react";
import { describe, expect, it, vi } from "vitest";
import { useSwipeGesture } from "./useSwipeGesture";

function createTouch(x: number, y: number): Touch {
  return {
    clientX: x,
    clientY: y,
    identifier: 1,
    pageX: x,
    pageY: y,
    screenX: x,
    screenY: y,
    target: document.body,
    force: 1,
    radiusX: 1,
    radiusY: 1,
    rotationAngle: 0,
  } as Touch;
}

function dispatchTouchEvent(
  element: HTMLElement,
  type: "touchstart" | "touchmove" | "touchend" | "touchcancel",
  touches: Touch[],
  target?: Element,
) {
  const event = new UIEvent(type, { bubbles: true, cancelable: true }) as UIEvent & {
    touches: Touch[];
    targetTouches: Touch[];
    changedTouches: Touch[];
  };
  event.touches = type === "touchend" || type === "touchcancel" ? [] : touches;
  event.targetTouches = event.touches;
  event.changedTouches = touches;
  if (target) {
    Object.defineProperty(event, "target", { value: target, enumerable: true });
  }
  element.dispatchEvent(event);
  return event;
}

describe("useSwipeGesture", () => {
  it("fires onSwipeLeft when swiped horizontally left past threshold", () => {
    const onSwipeLeft = vi.fn();
    const onSwipeRight = vi.fn();
    const div = document.createElement("div");

    const { result } = renderHook(() =>
      useSwipeGesture({ onSwipeLeft, onSwipeRight, threshold: 50 }),
    );
    result.current(div);

    dispatchTouchEvent(div, "touchstart", [createTouch(100, 100)]);
    dispatchTouchEvent(div, "touchend", [createTouch(40, 100)]); // dx = -60

    expect(onSwipeLeft).toHaveBeenCalledTimes(1);
    expect(onSwipeRight).not.toHaveBeenCalled();
  });

  it("fires onSwipeRight when swiped horizontally right past threshold", () => {
    const onSwipeLeft = vi.fn();
    const onSwipeRight = vi.fn();
    const div = document.createElement("div");

    const { result } = renderHook(() =>
      useSwipeGesture({ onSwipeLeft, onSwipeRight, threshold: 50 }),
    );
    result.current(div);

    dispatchTouchEvent(div, "touchstart", [createTouch(100, 100)]);
    dispatchTouchEvent(div, "touchend", [createTouch(160, 100)]); // dx = +60

    expect(onSwipeRight).toHaveBeenCalledTimes(1);
    expect(onSwipeLeft).not.toHaveBeenCalled();
  });

  it("does NOT swipe when claimed() returns true (N3a axis lock)", () => {
    const onSwipeLeft = vi.fn();
    const onSwipeRight = vi.fn();
    const div = document.createElement("div");

    const { result } = renderHook(() =>
      useSwipeGesture({
        onSwipeLeft,
        onSwipeRight,
        threshold: 50,
        claimed: () => true,
      }),
    );
    result.current(div);

    // Would normally be a significant swipe left
    dispatchTouchEvent(div, "touchstart", [createTouch(100, 100)]);
    dispatchTouchEvent(div, "touchend", [createTouch(40, 100)]);

    expect(onSwipeLeft).not.toHaveBeenCalled();
    expect(onSwipeRight).not.toHaveBeenCalled();

    // Would normally be a significant swipe right
    dispatchTouchEvent(div, "touchstart", [createTouch(100, 100)]);
    dispatchTouchEvent(div, "touchend", [createTouch(160, 100)]);

    expect(onSwipeRight).not.toHaveBeenCalled();
  });

  it("swipes normally when claimed() returns false", () => {
    const onSwipeLeft = vi.fn();
    const div = document.createElement("div");

    const { result } = renderHook(() =>
      useSwipeGesture({
        onSwipeLeft,
        threshold: 50,
        claimed: () => false,
      }),
    );
    result.current(div);

    dispatchTouchEvent(div, "touchstart", [createTouch(100, 100)]);
    dispatchTouchEvent(div, "touchend", [createTouch(40, 100)]);

    expect(onSwipeLeft).toHaveBeenCalledTimes(1);
  });

  it("ignores touches starting inside [data-no-swipe]", () => {
    const onSwipeLeft = vi.fn();
    const div = document.createElement("div");
    const child = document.createElement("div");
    child.setAttribute("data-no-swipe", "");
    div.appendChild(child);

    const { result } = renderHook(() =>
      useSwipeGesture({ onSwipeLeft, threshold: 50 }),
    );
    result.current(div);

    dispatchTouchEvent(div, "touchstart", [createTouch(100, 100)], child);
    dispatchTouchEvent(div, "touchend", [createTouch(40, 100)], child);

    expect(onSwipeLeft).not.toHaveBeenCalled();
  });

  it("does NOT swipe when vertical movement dominates horizontal", () => {
    const onSwipeLeft = vi.fn();
    const div = document.createElement("div");

    const { result } = renderHook(() =>
      useSwipeGesture({ onSwipeLeft, threshold: 50 }),
    );
    result.current(div);

    // dx = -55, dy = 70 -> vertical dominant
    dispatchTouchEvent(div, "touchstart", [createTouch(100, 100)]);
    dispatchTouchEvent(div, "touchend", [createTouch(45, 170)]);

    expect(onSwipeLeft).not.toHaveBeenCalled();
  });

  it("does NOT swipe when distance is below threshold", () => {
    const onSwipeLeft = vi.fn();
    const div = document.createElement("div");

    const { result } = renderHook(() =>
      useSwipeGesture({ onSwipeLeft, threshold: 50 }),
    );
    result.current(div);

    // dx = -30 (< 50)
    dispatchTouchEvent(div, "touchstart", [createTouch(100, 100)]);
    dispatchTouchEvent(div, "touchend", [createTouch(70, 100)]);

    expect(onSwipeLeft).not.toHaveBeenCalled();
  });

  it("aborts swipe on touchcancel", () => {
    const onSwipeLeft = vi.fn();
    const div = document.createElement("div");

    const { result } = renderHook(() =>
      useSwipeGesture({ onSwipeLeft, threshold: 50 }),
    );
    result.current(div);

    dispatchTouchEvent(div, "touchstart", [createTouch(100, 100)]);
    dispatchTouchEvent(div, "touchcancel", [createTouch(50, 100)]);
    dispatchTouchEvent(div, "touchend", [createTouch(40, 100)]);

    expect(onSwipeLeft).not.toHaveBeenCalled();
  });
});
