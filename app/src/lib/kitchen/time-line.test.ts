import { describe, it, expect } from "vitest";
import { COOK_PLAN_VERSION, type CookPlan, type CookTask } from "./cook-plan";
import type { AheadWork, ShownTimes } from "./recipe-times";
import { durationText, handsOnWords, recipeTimeLine, timeLine, timeLineText } from "./time-line";

const NBSP = " ";
/** A line's text with its no-break spaces as plain ones, to read as written. */
const plain = (parts: string[] | null) => parts?.map((p) => p.replaceAll(NBSP, " ")) ?? null;

const NO_AHEAD: AheadWork = { leads: [], unled: 0 };
const plan = (total: number, handsOn: number, ahead = NO_AHEAD): ShownTimes => ({
  source: "plan",
  total,
  handsOn,
  ahead,
});
const recipe = (total: number | null, handsOn: number | null, ahead = NO_AHEAD): ShownTimes => ({
  source: "recipe",
  reason: "no-plan",
  total,
  handsOn,
  ahead,
});

describe("durationText", () => {
  it("says minutes under an hour", () => {
    expect(durationText(25).replaceAll(NBSP, " ")).toBe("25 min");
    expect(durationText(5).replaceAll(NBSP, " ")).toBe("5 min");
  });

  it("says whole hours alone, and hours with their minutes as a cook reads a clock's", () => {
    expect(durationText(60).replaceAll(NBSP, " ")).toBe("1 h");
    expect(durationText(70).replaceAll(NBSP, " ")).toBe("1 h 10");
    expect(durationText(125).replaceAll(NBSP, " ")).toBe("2 h 05");
    expect(durationText(480).replaceAll(NBSP, " ")).toBe("8 h");
  });

  it("rounds a stated time to the whole minute, and never says 0", () => {
    expect(durationText(29.6).replaceAll(NBSP, " ")).toBe("30 min");
    expect(durationText(0.2).replaceAll(NBSP, " ")).toBe("1 min");
  });

  it("never breaks inside a duration", () => {
    expect(durationText(70)).toBe(`1${NBSP}h${NBSP}10`);
    expect(durationText(25)).toBe(`25${NBSP}min`);
  });

  it("refuses a duration that isn't a positive count of minutes", () => {
    expect(() => durationText(0)).toThrow();
    expect(() => durationText(-5)).toThrow();
    expect(() => durationText(Number.NaN)).toThrow();
  });
});

describe("timeLine", () => {
  it("gives the plan's total, then its hands-on minutes", () => {
    expect(plain(timeLine(plan(70, 25), null))).toEqual(["1 h 10 ·", "25 min hands-on"]);
  });

  it("says once when every minute is hands-on, or none is", () => {
    expect(plain(timeLine(plan(40, 40), null))).toEqual(["40 min, all hands-on"]);
    expect(plain(timeLine(plan(480, 0), null))).toEqual(["8 h, hands-free"]);
  });

  it("names the ahead work Prep opens with, its lead read as ahead of the cook", () => {
    const ahead = { leads: ["at least 4 hours"], unled: 0 };
    expect(
      plain(timeLine(plan(70, 25, ahead), { label: "marinate chicken", lead: "at least 4 hours before" })),
    ).toEqual(["1 h 10 ·", "25 min hands-on", "+ marinate chicken at least 4 hours ahead"]);
  });

  it("never breaks between the ahead work's number and its unit", () => {
    const ahead = { leads: ["at least 2½ hours"], unled: 0 };
    expect(
      timeLine(plan(70, 25, ahead), { label: "warm 2 eggs", lead: "at least 2½ hours before" })?.[2],
    ).toBe(`+${NBSP}warm 2${NBSP}eggs at least 2½${NBSP}hours ahead`);
  });

  it("reads a lead in abbreviated units as ahead too (T follow-up, item 3)", () => {
    const ahead = { leads: ["30 min"], unled: 0 };
    expect(
      plain(timeLine(plan(70, 25, ahead), { label: "rest dough", lead: "30 min before" }))?.[2],
    ).toBe("+ rest dough 30 min ahead");
    expect(
      plain(timeLine(plan(70, 25, ahead), { label: "brine pork", lead: "at least 2 hr before" }))?.[2],
    ).toBe("+ brine pork at least 2 hr ahead");
    expect(
      plain(timeLine(plan(70, 25, ahead), { label: "chill", lead: "2 hrs before" }))?.[2],
    ).toBe("+ chill 2 hrs ahead");
    expect(
      plain(timeLine(plan(70, 25, ahead), { label: "thaw", lead: "15 mins before" }))?.[2],
    ).toBe("+ thaw 15 mins ahead");
  });

  it("keeps a lead that already says when as written", () => {
    const ahead = { leads: ["overnight"], unled: 0 };
    expect(plain(timeLine(plan(70, 25, ahead), { label: "soak beans", lead: "overnight" }))).toEqual([
      "1 h 10 ·",
      "25 min hands-on",
      "+ soak beans overnight",
    ]);
    expect(
      plain(timeLine(plan(70, 25, ahead), { label: "soak chickpeas", lead: "the night before" }))?.[2],
    ).toBe("+ soak chickpeas the night before");
  });

  it("says ahead work with no lead is ahead", () => {
    const ahead = { leads: [], unled: 1 };
    expect(plain(timeLine(plan(70, 25, ahead), { label: "chill rice", lead: null }))?.[2]).toBe(
      "+ chill rice ahead",
    );
  });

  it("reads the recipe's own time as the recipe's, unrounded", () => {
    expect(plain(timeLine(recipe(30, null), null))).toEqual(["Recipe says 30 min"]);
    expect(plain(timeLine(recipe(37, 12), null))).toEqual(["Recipe says 37 min ·", "12 min hands-on"]);
    expect(plain(timeLine(recipe(null, 15), null))).toEqual(["Recipe says 15 min hands-on"]);
    expect(plain(timeLine(recipe(20, 20), null))).toEqual(["Recipe says 20 min, all hands-on"]);
  });

  it("still names ahead work when the minutes are the recipe's", () => {
    const ahead = { leads: ["overnight"], unled: 0 };
    const nominal: ShownTimes = { source: "recipe", reason: "nominal", total: 45, handsOn: null, ahead };
    expect(plain(timeLine(nominal, { label: "soak beans", lead: "overnight" }))).toEqual([
      "Recipe says 45 min",
      "+ soak beans overnight",
    ]);
  });

  it("with no minutes to show, says the ahead work alone, as a sentence", () => {
    const ahead = { leads: ["overnight"], unled: 0 };
    const none: ShownTimes = { source: "none", reason: "nominal", ahead };
    expect(plain(timeLine(none, { label: "soak beans", lead: "overnight" }))).toEqual(["Soak beans overnight"]);
  });

  it("shows nothing, never 0 min, when there is nothing to show", () => {
    expect(timeLine({ source: "none", reason: "no-plan", ahead: NO_AHEAD }, null)).toBeNull();
  });

  it("leaves the ahead part off when asked to (Prep shows its own)", () => {
    const ahead = { leads: ["overnight"], unled: 0 };
    expect(
      plain(timeLine(plan(70, 25, ahead), { label: "soak beans", lead: "overnight" }, { ahead: false })),
    ).toEqual(["1 h 10 ·", "25 min hands-on"]);
    const none: ShownTimes = { source: "none", reason: "nominal", ahead };
    expect(timeLine(none, { label: "soak beans", lead: "overnight" }, { ahead: false })).toBeNull();
  });
});

describe("recipeTimeLine", () => {
  const task = (partial: Pick<CookTask, "id" | "kind"> & Partial<CookTask>): CookTask => ({
    text: partial.id,
    label: partial.id,
    ingredientIdx: [],
    sourceStep: partial.kind === "cook" ? 0 : null,
    implied: false,
    needs: [],
    branch: "Main",
    ...partial,
  });
  const beans: CookPlan = {
    version: COOK_PLAN_VERSION,
    tasks: [
      task({ id: "soak beans", kind: "ahead", lead: "overnight" }),
      task({ id: "simmer", kind: "cook", minutes: { est: 40, handsOff: true } }),
      task({ id: "season", kind: "cook", minutes: { est: 10, handsOff: false }, needs: ["simmer"] }),
    ],
  };

  it("reads a current plan's minutes and names its ahead work", () => {
    expect(plain(recipeTimeLine(beans, { total: 90 }))).toEqual([
      "50 min ·",
      "10 min hands-on",
      "+ soak beans overnight",
    ]);
  });

  it("reads the recipe's own time when the plan isn't current", () => {
    expect(plain(recipeTimeLine({ ...beans, version: -1 }, { total: 90 }))).toEqual(["Recipe says 1 h 30"]);
    expect(plain(recipeTimeLine(null, { active: 20, passive: 15 }))).toEqual([
      "Recipe says 35 min ·",
      "20 min hands-on",
    ]);
  });

  it("says only the hands-on time when that is all the recipe states (T follow-up, item 4)", () => {
    expect(plain(recipeTimeLine(null, { active: 30 }))).toEqual(["Recipe says 30 min hands-on"]);
    expect(plain(recipeTimeLine(null, { active: 30, passive: 0 }))).toEqual(["Recipe says 30 min, all hands-on"]);
    expect(recipeTimeLine(null, { passive: 40 })).toBeNull();
  });

  it("leaves the ahead part off for Prep, and says nothing with nothing to say", () => {
    expect(plain(recipeTimeLine(beans, undefined, { ahead: false }))).toEqual(["50 min ·", "10 min hands-on"]);
    expect(recipeTimeLine(null, undefined)).toBeNull();
  });
});

describe("timeLineText", () => {
  it("joins the parts with spaces, for a screen reader or a test", () => {
    expect(timeLineText(["1 h 10 ·", "25 min hands-on"])).toBe("1 h 10 · 25 min hands-on");
  });
});

describe("handsOnWords (the opening's hands-on line)", () => {
  const said = (shown: ShownTimes) => handsOnWords(shown)?.replaceAll(NBSP, " ") ?? null;

  it("says the row's hands-on words, its own line's capital first, the recipe's as the recipe's", () => {
    expect(said(plan(75, 15))).toBe("15 min hands-on");
    expect(said(plan(50, 50))).toBe("All hands-on");
    expect(said(plan(50, 0))).toBe("Hands-free");
    expect(said(recipe(45, 20))).toBe("Recipe says 20 min hands-on");
    expect(said(recipe(30, 30))).toBe("Recipe says all hands-on");
    expect(said(recipe(null, 20))).toBe("Recipe says 20 min hands-on");
    expect(said(recipe(90, null))).toBeNull();
    expect(said({ source: "none", reason: "no-plan", ahead: NO_AHEAD })).toBeNull();
  });

  it("whenever the kitchen row says hands-on, all hands-on or hands-free, the opening says the same, and never otherwise", () => {
    const cases: ShownTimes[] = [];
    for (const total of [null, 5, 30, 75, 135]) {
      for (const handsOn of [null, 0, 5, 30, 75, 140]) {
        if (total !== null) cases.push({ source: "plan", total, handsOn: handsOn ?? 0, ahead: NO_AHEAD });
        // the recipe's hands-on is a positive count when stated (`shownTimes`)
        if (handsOn !== 0 && (total !== null || handsOn !== null)) cases.push({ source: "recipe", reason: "nominal", total, handsOn, ahead: NO_AHEAD });
      }
    }
    for (const shown of cases) {
      const row = timeLineText(plain(timeLine(shown, null)) ?? []);
      const words = said(shown);
      const at = JSON.stringify(shown);
      const rowSays = /hands-on|hands-free/.test(row);
      expect(words !== null, `${at}: row "${row}"`).toBe(rowSays);
      if (!words) continue;
      const phrase = words.replace(/^Recipe says /, "").replace(/^./, (c) => c.toLowerCase());
      expect(row.endsWith(phrase), `${at}: row "${row}" ends in "${phrase}"`).toBe(true);
      expect(words.startsWith("Recipe says "), at).toBe(row.startsWith("Recipe says "));
    }
  });
});
