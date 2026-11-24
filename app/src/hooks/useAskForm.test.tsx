// @vitest-environment happy-dom
import { act, cleanup, renderHook } from "@testing-library/react";
import { afterEach, describe, expect, it } from "vitest";
import { askFormFor, useAskForm } from "./useAskForm";

const was = { width: window.innerWidth, height: window.innerHeight };

/** The window at this size, told as a browser tells it. */
function size(width: number, height: number) {
  Object.defineProperty(window, "innerWidth", { value: width, configurable: true, writable: true });
  Object.defineProperty(window, "innerHeight", { value: height, configurable: true, writable: true });
  window.dispatchEvent(new Event("resize"));
}

afterEach(() => {
  cleanup();
  size(was.width, was.height);
});

describe("askFormFor: which shape Ask takes on a screen (DECISIONS 2026-11-22, call 1)", () => {
  it("is the side panel on the tablet in landscape", () => {
    expect(askFormFor(1280, 800)).toBe("side");
    expect(askFormFor(1024, 768)).toBe("side");
  });

  it("is the full sheet in portrait, on the tablet and on a phone", () => {
    expect(askFormFor(800, 1280)).toBe("sheet");
    expect(askFormFor(390, 844)).toBe("sheet");
  });

  it("is the full sheet on a phone on its side: too short for a conversation above the foot", () => {
    expect(askFormFor(844, 390)).toBe("sheet");
  });

  it("holds the side panel down to 560 px tall and no lower, and a square screen is not landscape", () => {
    expect(askFormFor(1000, 560)).toBe("side");
    expect(askFormFor(1000, 559)).toBe("sheet");
    expect(askFormFor(800, 800)).toBe("sheet");
  });
});

describe("useAskForm: the form follows the screen, and never the keyboard", () => {
  it("reads the window's size, and changes when the screen turns", () => {
    size(1280, 800);
    const { result, unmount } = renderHook(({ open }) => useAskForm(open), { initialProps: { open: false } });
    expect(result.current).toBe("side");
    act(() => size(800, 1280));
    expect(result.current).toBe("sheet");
    act(() => size(1280, 800));
    expect(result.current).toBe("side");
    unmount();
    // Nothing is left listening.
    expect(() => size(800, 1280)).not.toThrow();
  });

  it("holds its shape while Ask is open and only the height changes: the tablet's keyboard shrinks the page (review round 1)", () => {
    // `interactiveWidget: resizes-content` (app/layout.tsx): with the keyboard
    // up the tablet's 1280×800 page is about 1280×380, under the side panel's
    // 560 px. The panel was opened beside the step and stays there.
    size(1280, 800);
    const { result, rerender } = renderHook(({ open }) => useAskForm(open), { initialProps: { open: false } });
    rerender({ open: true });
    expect(result.current).toBe("side");
    act(() => size(1280, 380));
    expect(result.current).toBe("side");
    act(() => size(1280, 800));
    expect(result.current).toBe("side");
    // The sheet holds too: a tall keyboard never makes a portrait screen "landscape".
    act(() => size(800, 1280));
    expect(result.current).toBe("sheet");
    act(() => size(800, 700));
    expect(result.current).toBe("sheet");
  });

  it("decides again when the width changes with Ask open: the screen turned", () => {
    size(1280, 800);
    const { result } = renderHook(() => useAskForm(true));
    expect(result.current).toBe("side");
    act(() => size(800, 1280));
    expect(result.current).toBe("sheet");
    act(() => size(1280, 800));
    expect(result.current).toBe("side");
  });

  it("with Ask closed it follows the height too, and is right again once Ask opens", () => {
    size(1280, 800);
    const { result, rerender } = renderHook(({ open }) => useAskForm(open), { initialProps: { open: false } });
    act(() => size(1280, 500));
    expect(result.current).toBe("sheet");
    act(() => size(1280, 800));
    expect(result.current).toBe("side");
    rerender({ open: true });
    expect(result.current).toBe("side");
  });

  it("decides afresh from the window as Ask closes: a height it held through is not kept for the next opening (review round 2)", () => {
    size(1280, 800);
    const { result, rerender } = renderHook(({ open }) => useAskForm(open), { initialProps: { open: true } });
    expect(result.current).toBe("side");
    // A window dragged shorter with Ask open reads as the keyboard, and is held through.
    act(() => size(1280, 400));
    expect(result.current).toBe("side");
    // Closed, nothing is held: the window is 400 tall, and no resize comes to say so.
    rerender({ open: false });
    expect(result.current).toBe("sheet");
    rerender({ open: true });
    expect(result.current).toBe("sheet");
  });

  it("opened while a keyboard was still going down, it takes the screen's shape once the page is whole again", () => {
    size(1280, 380);
    const { result } = renderHook(() => useAskForm(true));
    expect(result.current).toBe("sheet");
    act(() => size(1280, 800));
    expect(result.current).toBe("side");
    // And from there the keyboard no longer moves it.
    act(() => size(1280, 380));
    expect(result.current).toBe("side");
  });
});
