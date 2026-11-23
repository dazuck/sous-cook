import { describe, expect, it } from "vitest";
import { footWord, SHELF_FITS, subjectOf, thenLine } from "./home-view";

const dishes = (n: number) => Array.from({ length: n }, (_, i) => ({ id: `d${i}`, name: `Dish ${i}` }));

describe("subjectOf (P65: the first that applies)", () => {
  it("a cook under way leads over everything", () => {
    expect(subjectOf({ cooking: 1, queued: 3, asking: true })).toBe("cooking");
  });
  it("then How was it?", () => {
    expect(subjectOf({ cooking: 0, queued: 3, asking: true })).toBe("ask");
  });
  it("then the queue, then the idle shelf", () => {
    expect(subjectOf({ cooking: 0, queued: 1, asking: false })).toBe("queue");
    expect(subjectOf({ cooking: 0, queued: 0, asking: false })).toBe("idle");
  });
});

describe("thenLine", () => {
  it("names nothing for a queue of one", () => {
    expect(thenLine(dishes(1))).toEqual({ next: [], more: 0 });
  });
  it("names the next two and no 'more' while two or fewer follow", () => {
    expect(thenLine(dishes(2)).next.map((d) => d.id)).toEqual(["d1"]);
    expect(thenLine(dishes(3))).toMatchObject({ more: 0 });
    expect(thenLine(dishes(3)).next.map((d) => d.id)).toEqual(["d1", "d2"]);
  });
  it("counts the rest as N more", () => {
    expect(thenLine(dishes(5))).toMatchObject({ more: 2 });
    expect(thenLine(dishes(5)).next.map((d) => d.id)).toEqual(["d1", "d2"]);
  });
});

describe("footWord (D9)", () => {
  it("Up next with a queue, whatever else", () => {
    expect(footWord({ queued: 5, cooking: 1, recent: 2 })).toEqual({ kind: "up-next", label: "Up next · 5" });
  });
  it("Under way with only cooks", () => {
    expect(footWord({ queued: 0, cooking: 2, recent: 2 })).toEqual({ kind: "under-way", label: "Under way · 2" });
  });
  it("Made recently in the idle kitchen, and nothing with nothing", () => {
    expect(footWord({ queued: 0, cooking: 0, recent: 1 })).toEqual({ kind: "made-recently", label: "Made recently" });
    expect(footWord({ queued: 0, cooking: 0, recent: 0 })).toBeNull();
  });
});

describe("SHELF_FITS (D14)", () => {
  it("steps the covers down to a floor of 0.85, never below", () => {
    expect([...SHELF_FITS]).toEqual([...SHELF_FITS].sort((a, b) => b - a));
    expect(Math.min(...SHELF_FITS)).toBe(0.85);
  });
});
