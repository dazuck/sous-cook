// @vitest-environment happy-dom
import { act, renderHook } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { setSueReplies, useSueReplies } from "./useSueReplies";

beforeEach(() => {
  const kept = new Map<string, string>();
  vi.stubGlobal("localStorage", {
    getItem: (k: string) => kept.get(k) ?? null,
    setItem: (k: string, v: string) => void kept.set(k, v),
    removeItem: (k: string) => void kept.delete(k),
  });
});

afterEach(() => {
  vi.unstubAllGlobals();
  vi.unstubAllEnvs();
});

describe("useSueReplies", () => {
  it("reads sounds until a choice, and follows each choice made on the page (a build with the clips)", () => {
    vi.stubEnv("SOUS_SUE_CLIPS", "1");
    const { result } = renderHook(() => useSueReplies());
    expect(result.current).toBe("sounds");
    act(() => setSueReplies("voice"));
    expect(result.current).toBe("voice");
    act(() => setSueReplies("off"));
    expect(result.current).toBe("off");
  });

  it("follows another tab's change (a build with the clips)", () => {
    vi.stubEnv("SOUS_SUE_CLIPS", "1");
    const { result } = renderHook(() => useSueReplies());
    localStorage.setItem("sous-sue-replies", "voice");
    act(() => {
      window.dispatchEvent(new Event("storage"));
    });
    expect(result.current).toBe("voice");
  });

  it("in a build without the clips, reads a stored or newly set voice as sounds", () => {
    const { result } = renderHook(() => useSueReplies());
    act(() => setSueReplies("voice"));
    expect(result.current).toBe("sounds");
    act(() => setSueReplies("off"));
    expect(result.current).toBe("off");
  });
});
