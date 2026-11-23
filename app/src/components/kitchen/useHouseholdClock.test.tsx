// @vitest-environment happy-dom
import { renderHook } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";
import { useHouseholdClock } from "./useHouseholdClock";

afterEach(() => {
  vi.useRealTimers();
  vi.unstubAllEnvs();
});

// One instant, 2026-09-20 22:12 UTC: 18:12 in New York, 10:12 the next morning in Auckland.
const INSTANT = new Date("2026-09-20T22:12:00Z");

describe("the household clock (D7)", () => {
  it("reads the household's zone from the kitchen's configuration, never the device's", () => {
    vi.useFakeTimers({ now: INSTANT, toFake: ["Date", "setInterval", "clearInterval"] });
    vi.stubEnv("NEXT_PUBLIC_KITCHEN_TZ", "America/New_York");
    expect(renderHook(() => useHouseholdClock()).result.current).toEqual({ time: "6:12 pm", eyebrow: "Tonight" });
    vi.stubEnv("NEXT_PUBLIC_KITCHEN_TZ", "Pacific/Auckland");
    expect(renderHook(() => useHouseholdClock()).result.current).toEqual({ time: "10:12 am", eyebrow: "Up next" });
  });
});
