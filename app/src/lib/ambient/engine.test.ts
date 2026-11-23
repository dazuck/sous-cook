import { runInNewContext } from "node:vm";
import { describe, expect, it } from "vitest";
import { ambientEngine } from "./engine";
import { ambientHeadScript } from "./head-script";
import { ambientForceFrom, kitchenPlaceFrom } from "./location";

const PLACE = { lat: 40.7, lng: -74, tz: "America/New_York" };

/** Runs the layout's <head> script in a bare context, as a browser would at `now`. */
function runHeadScript(now: Date, search: string, force: string | null = null): string | undefined {
  const written: Record<string, string> = {};
  const FakeDate = class extends Date {
    constructor(...args: ConstructorParameters<typeof Date>) {
      super(...(args.length ? args : [now.getTime()]) as [number]);
    }
  };
  runInNewContext(ambientHeadScript(PLACE, force), {
    Date: FakeDate,
    Intl,
    URLSearchParams,
    location: { search },
    document: { documentElement: { style: { setProperty: (k: string, v: string) => (written[k] = v) } } },
  });
  return written["--ambient-t"];
}

describe("the <head> script that sets --ambient-t before the first paint", () => {
  const engine = ambientEngine();
  const instants = [
    "2026-09-20T16:00:00Z", // noon
    "2026-09-20T22:40:00Z", // in the ramp
    "2026-09-20T23:30:00Z",
    "2026-09-21T03:00:00Z", // 11 pm
    "2026-09-21T10:20:00Z", // 6:20 am, the morning ease
    "2026-12-21T21:45:00Z",
  ];

  for (const iso of instants) {
    it(`sets the same value as the module at ${iso}`, () => {
      const now = new Date(iso);
      expect(runHeadScript(now, "")).toBe(engine.cssValue(now, "", null, PLACE));
    });
  }

  it("is the night stop at 11 pm and day at noon", () => {
    expect(runHeadScript(new Date("2026-09-21T03:00:00Z"), "")).toBe("100.00%");
    expect(runHeadScript(new Date("2026-09-20T16:00:00Z"), "")).toBe("0.00%");
  });

  it("honours ?ambient= and an allowed force", () => {
    expect(runHeadScript(new Date("2026-09-20T16:00:00Z"), "?ambient=dusk")).toBe("100.00%");
    expect(runHeadScript(new Date("2026-09-21T03:00:00Z"), "?ambient=day")).toBe("0.00%");
    expect(runHeadScript(new Date("2026-09-20T16:00:00Z"), "", "dusk")).toBe("100.00%");
  });
});

describe("configuration", () => {
  it("falls back to the placeholder place, one variable at a time", () => {
    expect(kitchenPlaceFrom({})).toEqual({ lat: 51.48, lng: 0, tz: "Europe/London" });
    expect(kitchenPlaceFrom({ tz: "Europe/Lisbon" }).tz).toBe("Europe/Lisbon");
    expect(kitchenPlaceFrom({ lat: "38.72", lng: "-9.14" })).toEqual({ lat: 38.72, lng: -9.14, tz: "Europe/London" });
    expect(kitchenPlaceFrom({ lat: "north", lng: "0" })).toEqual({ lat: 51.48, lng: 0, tz: "Europe/London" });
  });

  it("NEXT_PUBLIC_AMBIENT_FORCE cannot stick in a production build", () => {
    expect(ambientForceFrom({ nodeEnv: "production", force: "dusk" })).toBeNull();
    expect(ambientForceFrom({ nodeEnv: "production", force: "day" })).toBeNull();
  });

  it("is honoured outside production, and in the e2e build", () => {
    expect(ambientForceFrom({ nodeEnv: "development", force: "dusk" })).toBe("dusk");
    expect(ambientForceFrom({ nodeEnv: "production", e2e: "1", force: "day" })).toBe("day");
    expect(ambientForceFrom({ nodeEnv: "development", force: "banana" })).toBeNull();
  });
});
