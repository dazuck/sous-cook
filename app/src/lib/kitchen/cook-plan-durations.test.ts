import { describe, expect, it } from "vitest";
import { durationsIn, quantitiesIn, timedLength, type Duration } from "./cook-plan";

/** The minutes of each duration a step states, in order. */
function minutesIn(text: string): number[] {
  return durationsIn(text).map((d) => d.minutes);
}

// The durations a step states (slice B4: a pack step's timer_sec is the first
// one, DECISIONS 2026-10-02). A range is one duration at its lower bound, not
// the two numbers quantitiesIn reads it as.

describe("durationsIn", () => {
  it.each([
    ["Sauté until caramelized, about 15 minutes.", [15]],
    ["Roast 1 hour, then rest.", [60]],
    ["Simmer 1 1/2 hours.", [90]],
    ["Braise for an hour and a half.", [90]],
    ["Sear 30 seconds a side.", [0.5]],
    ["Chill 3 days.", [4320]],
  ])("reads one duration: %s", (text, expected) => {
    expect(minutesIn(text)).toEqual(expected);
  });

  it.each([
    ["Bake 35 to 40 minutes, until set.", [35]],
    ["Cook 11 to 13 minutes.", [11]],
    ["Fry 5-8 minutes.", [5]],
    ["Stir a minute or two.", [1]],
    ["Bake 40 to 35 minutes.", [35]],
  ])("reads a range as one duration at its lower bound: %s", (text, expected) => {
    expect(minutesIn(text)).toEqual(expected);
  });

  it("keeps every duration a step states, in order", () => {
    expect(minutesIn("Chill the dough at least 2 hours, or up to 3 days.")).toEqual([120, 4320]);
    expect(minutesIn("Cook 2 minutes, then flip and cook 1 minute more.")).toEqual([2, 1]);
    expect(minutesIn("Simmer 5 to 8 minutes, then rest 10 minutes.")).toEqual([5, 10]);
  });

  it("reads no duration where the step states none", () => {
    expect(minutesIn("Preheat the oven to 400°F.")).toEqual([]);
    expect(minutesIn("Add 2 cups stock and 1 tbsp salt.")).toEqual([]);
    expect(minutesIn("Cut the dough into 4 pieces, 2 inches thick.")).toEqual([]);
    expect(minutesIn("Soak overnight.")).toEqual([]);
    expect(minutesIn("")).toEqual([]);
  });

  it("does not read a list number as a quantity", () => {
    expect(minutesIn("2. Simmer 10 minutes.")).toEqual([10]);
    expect(minutesIn("Step 3) Rest 5 minutes.")).toEqual([5]);
  });

  // B4 step 0, call 8: the lamb stew's "1 hour 45 minutes" is one duration,
  // not an hour and then 45 minutes.
  it.each([
    ["Cook for 1 hour 45 minutes, until potatoes and lamb are very tender", [105]],
    ["Roast 1 hour and 15 minutes.", [75]],
    ["Roast 2 hrs 10 min.", [130]],
    ["Fry 1 minute 30 seconds a side.", [1.5]],
    ["Simmer gently for 1 hour to 1 hour 30 minutes", [60, 90]],
  ])("reads a larger unit followed straight by a smaller one as one duration: %s", (text, expected) => {
    expect(minutesIn(text)).toEqual(expected);
  });

  it.each([
    ["Rest 1 hour, then bake 30 minutes.", [60, 30]],
    ["Bake 30 minutes 1 hour ahead.", [30, 60]],
  ])("keeps durations apart when anything but a unit stands between them: %s", (text, expected) => {
    expect(minutesIn(text)).toEqual(expected);
  });

  // Call 8: a duration followed by "less than", "more than", "longer than" or
  // "shorter than" is an offset from another time, not a length to time.
  it("marks a duration relative to another time", () => {
    expect(
      durationsIn(
        "Cook pasta 1-2 minutes less than package directions (e.g., if box says 9 minutes, cook for 7-8 minutes).",
      ),
    ).toEqual([
      { minutes: 1, role: "relative" },
      { minutes: 9, role: "length" },
      { minutes: 7, role: "length" },
    ]);
    expect(durationsIn("Bake 5 minutes longer than the cake.")).toEqual([
      { minutes: 5, role: "relative" },
    ]);
    expect(durationsIn("Roast 1 hour 10 minutes more than a smaller bird.")).toEqual([
      { minutes: 70, role: "relative" },
    ]);
    expect(durationsIn("Steep 2 min shorter than black tea.")).toEqual([
      { minutes: 2, role: "relative" },
    ]);
    expect(durationsIn("Cook 2 minutes more, then flip.")).toEqual([
      { minutes: 2, role: "length" },
    ]);
    expect(durationsIn("Simmer 10 minutes, no more than that.")).toEqual([
      { minutes: 10, role: "length" },
    ]);
  });

  // Call 11: a duration straight after "at" ("at 12 min", "at the 10-minute
  // mark") is a point within the step, not the step's length.
  it("marks a duration straight after 'at' as a point in the step", () => {
    expect(
      durationsIn(
        "Roast in a single layer, flipping once at 12 min, until deep brown at the edges and fork-tender (about 25 min).",
      ),
    ).toEqual([
      { minutes: 12, role: "mark" },
      { minutes: 25, role: "length" },
    ]);
    expect(durationsIn("Stir at the 10-minute mark.")).toEqual([{ minutes: 10, role: "mark" }]);
    expect(durationsIn("Turn at 10 to 12 minutes, then roast 20 minutes.")).toEqual([
      { minutes: 10, role: "mark" },
      { minutes: 20, role: "length" },
    ]);
    expect(durationsIn("Baste at 1 hour 15 minutes.")).toEqual([{ minutes: 75, role: "mark" }]);
  });

  it.each([
    ["Bake at 350°F for 20 minutes.", 20],
    ["Marinate at least 45 min in advance.", 45],
    ["In the last 10 minutes, sauté the kale.", 10],
    ["Rest 10 minutes at room temperature.", 10],
  ])("leaves every other duration unmarked: %s", (text, minutes) => {
    expect(durationsIn(text)).toEqual([{ minutes, role: "length" }]);
  });

  it("leaves quantitiesIn reading a range as two numbers, as the plan checks need", () => {
    expect(quantitiesIn("Bake 35 to 40 minutes.", { wordsNeedUnit: true })).toEqual([
      { value: 35, unit: "min" },
      { value: 40, unit: "min" },
    ]);
  });
});

/** The duration a step's timer reads: the first length, one round of a repeat. */
function timerMinutes(text: string): number | null {
  return timedLength(durationsIn(text));
}

// Slice B5a, decision A1: a duration has a role, and only a length times a
// step. Each row is a PLAN B5 must-do from B4's verify (2026-10-06).
describe("durationsIn roles (B5a, A1)", () => {
  it.each<[string, Duration[], number | null]>([
    [
      "Baste every 20 minutes for 2 hours.",
      [
        { minutes: 20, role: "cadence" },
        { minutes: 120, role: "length" },
      ],
      120,
    ],
    ["Check every 20 minutes,", [{ minutes: 20, role: "cadence" }], null],
    ["Check every 20 minutes, stirring.", [{ minutes: 20, role: "cadence" }], null],
    ["Turn every 5 to 10 minutes until golden.", [{ minutes: 5, role: "cadence" }], null],
    ["Cook until 5 minutes shy of done.", [{ minutes: 5, role: "relative" }], null],
    ["Pull it 10 minutes short of the time given.", [{ minutes: 10, role: "relative" }], null],
    ["Add the peas 5 minutes before the end.", [{ minutes: 5, role: "mark" }], null],
    ["Add the herbs 2 minutes before the end of cooking.", [{ minutes: 2, role: "mark" }], null],
    ["Add the peas 5 minutes before serving.", [{ minutes: 5, role: "mark" }], null],
    [
      "Stir in the cream 5 minutes before serving, then simmer 3 minutes.",
      [
        { minutes: 5, role: "mark" },
        { minutes: 3, role: "length" },
      ],
      3,
    ],
    // A rest before serving is the step's length: "before serving" is when it ends.
    ["Let rest 10 minutes before serving.", [{ minutes: 10, role: "length" }], 10],
    ["Let it stand for 15 minutes before slicing.", [{ minutes: 15, role: "length" }], 15],
    ["Serve within 10 minutes of slicing.", [{ minutes: 10, role: "bound" }], null],
    ["Fry in 2 x 5 minutes.", [{ minutes: 5, role: "length", repeat: { count: 2 } }], 5],
    ["Sear 3 × 2 minutes, turning.", [{ minutes: 2, role: "length", repeat: { count: 3 } }], 2],
    [
      "Ready in 45 minutes total; simmer 20 minutes.",
      [
        { minutes: 45, role: "summary" },
        { minutes: 20, role: "length" },
      ],
      20,
    ],
    // Only the words before it make a summary: "in all" and "total" after a
    // duration are as often the step's own length ("bake 30 minutes in all").
    [
      "Simmer 20 minutes (45 minutes in all).",
      [
        { minutes: 20, role: "length" },
        { minutes: 45, role: "length" },
      ],
      20,
    ],
    ["Bake 30 minutes total, turning once.", [{ minutes: 30, role: "length" }], 30],
    ["The whole recipe takes about 1 hour.", [{ minutes: 60, role: "summary" }], null],
    ["The sauce keeps up to 3 days.", [{ minutes: 4320, role: "bound" }], null],
    ["It will keep for 2 weeks in the fridge.", [{ minutes: 20160, role: "bound" }], null],
    ["Keeps, covered, 3 days.", [{ minutes: 4320, role: "bound" }], null],
  ])("%s", (text, durations, timer) => {
    expect(durationsIn(text)).toEqual(durations);
    expect(timerMinutes(text)).toBe(timer);
  });

  it("keeps a plain length a length", () => {
    expect(durationsIn("Then add total of 4-5 tablespoons of spices, and cook for 1-2 minutes")).toEqual([
      { minutes: 1, role: "length" },
    ]);
    expect(durationsIn("Bake 2 x 9 inch pans for 25 minutes.")).toEqual([{ minutes: 25, role: "length" }]);
    expect(durationsIn("Roast at least 2 hours.")).toEqual([{ minutes: 120, role: "length" }]);
  });
});

// B5a verify round 1 (Q1–Q4, LOWs): roles that reached past the rows. Each
// row is the verifier's, read as the old reader did, except where a must-do
// row decided otherwise.
describe("durationsIn roles stay narrow (B5a verify round 1)", () => {
  it.each<[string, number | null]>([
    // Q1: "keeps" bounds only a holding time; any other "keeps" is a verb.
    ["Stirring keeps it smooth for 5 minutes.", 5],
    ["Cover; the lid keeps steam in for 10 minutes.", 10],
    // Q2: a wait before serving is the wait's length.
    ["Refrigerate 2 hours before serving.", 120],
    ["Steam the broccoli for 5 minutes before serving.", 5],
    ["Leave for 10 minutes before serving.", 10],
    // Q3, as amended by the independent verify of 11790c5: a bare comma
    // joins a descending compound whatever follows, except a smaller part
    // that is a part of the larger ("of it") or set against it ("less").
    ["Roast 1 hour, 30 minutes for a smaller bird.", 90],
    ["Braise 3 hours, 20 minutes of it uncovered.", 180],
    ["Bake 1 hour, 10 minutes less for muffins.", 70],
    ["Roast 1 hour, 15 minutes.", 75],
    ["Proof 1 hour, 15 minutes; then shape.", 75],
    // Q4: "takes" and "a total of" are a step's own length; "up to" and "no
    // more than" in a step are its longest, which a timer runs to.
    ["Fry until golden, which takes about 4 minutes.", 4],
    ["Stir in the rice; it takes 45 minutes.", 45],
    ["Simmer for a total of 1 hour.", 60],
    ["Steep no more than 4 minutes.", 4],
    ["Knead for up to 10 minutes.", 10],
    ["Chill up to 2 hours.", 120],
    // LOW: "a day" joins only an hour or minute count straight after "and".
    ["Brine a day and 2 cups of water will cover it, then simmer 10 minutes.", 10],
  ])("%s", (text, timer) => {
    expect(timerMinutes(text)).toBe(timer);
  });

  // B5a verify round 2.
  it.each<[string, number | null]>([
    // H1, as amended by the re-verify of 4bbf470: a bare comma reads as the
    // comma-free text does ("for" makes a length of the whole; without it,
    // "before the end" makes a point, which times nothing).
    ["Bake for 1 hour, 15 minutes before the end brush with the glaze.", 75],
    ["Roast for 2 hours, 30 minutes before the end add the potatoes.", 150],
    ["Simmer for 1 hour, 15 minutes before the end add salt.", 75],
    ["Simmer 1 hour, 15 minutes before the end add salt.", null],
    // M2: a wait before serving times its length, whatever came earlier in the step.
    ["Remove from the oven and let rest 10 minutes before serving.", 10],
    ["Top with foil and let stand 10 minutes before serving.", 10],
    ["Season the roast and let it rest 15 minutes before serving.", 15],
    ["Turn off the heat and let stand, covered, 5 minutes before serving.", 5],
    ["Take out of the oven and allow to cool 20 minutes before serving.", 20],
    ["Pull the pan off the heat and let cool 15 minutes before serving.", 15],
    ["Add the pasta to the sauce and let sit 2 minutes before serving.", 2],
    ["Add the peas 5 minutes before serving.", null],
    ["Stir in the cream 5 minutes before serving, then simmer 3 minutes.", 3],
  ])("round 2: %s", (text, timer) => {
    expect(timerMinutes(text)).toBe(timer);
  });

  // Independent verify of 11790c5, item 2 (the PLAN's compound must-do):
  // a descending bare-comma compound joins whatever follows it.
  it.each<[string, number | null]>([
    ["Bake for 1 hour, 15 minutes until golden.", 75],
    ["Roast 1 hour, 15 minutes at 400°F.", 75],
    ["Braise 2 hours, 30 minutes covered, then uncover.", 150],
    ["Simmer 1 hour, 10 minutes with the lid ajar.", 70],
    // A bound covers the whole compound.
    ["Serve within 1 hour, 30 minutes of slicing.", null],
    ["Eat within 1 hour, 30 minutes.", null],
    // Still apart: only a part of the larger.
    ["Braise 3 hours, 20 minutes of it uncovered.", 180],
    // Re-verify of 4bbf470: what follows reads the whole compound, as it
    // does without the comma. An offset or a point times nothing.
    ["Cook 1 hour, 15 minutes shy of done.", null],
    ["Boil 1 hour, 15 minutes less than the package says.", null],
    ["Add the glaze 1 hour, 15 minutes before the end.", null],
    ["Cover and bake 1 hour, 15 minutes more.", 75],
    ["Bake 1 hour, 10 minutes less for muffins.", 70],
    // A rate is no length (re-verify of 4bbf470, item 3).
    ["Bake 1 hour, 10 minutes per pound.", null],
    ["Roast 20 minutes per pound, plus 20 minutes.", 20],
    ["Cook for 4 minutes per side.", 4],
  ])("verify of 11790c5: %s", (text, timer) => {
    expect(timerMinutes(text)).toBe(timer);
  });

  // The rule itself: a bare comma between a larger unit and a smaller reads
  // as the text without it, whatever follows, except a part ("of it").
  it.each([
    "Bake for 1 hour, 15 minutes until golden.",
    "Cook 1 hour, 15 minutes shy of done.",
    "Boil 1 hour, 15 minutes less than the package says.",
    "Add the glaze 1 hour, 15 minutes before the end.",
    "Simmer 1 hour, 15 minutes before the end add salt.",
    "Cover and bake 1 hour, 15 minutes more.",
    "Bake 1 hour, 10 minutes per pound.",
    "Serve within 1 hour, 30 minutes of slicing.",
    "Roast 1 hour, 30 minutes for a smaller bird.",
  ])("reads %j as its comma-free text reads", (text) => {
    expect(timerMinutes(text)).toBe(timerMinutes(text.replace(/(hours?), /, "$1 ")));
  });

  // Item 4: a ranged count times one round; a lead waits the fewest rounds.
  it("times one round of a ranged repeat, its count the fewest", () => {
    expect(durationsIn("Fry 2-3 x 5 minutes, turning.")).toEqual([
      { minutes: 5, role: "length", repeat: { count: 2 } },
    ]);
    expect(timerMinutes("Fry 2-3 x 5 minutes, turning.")).toBe(5);
    expect(timerMinutes("Fry 2 to 3 x 4 minutes.")).toBe(4);
  });

  it("still reads the must-do rows as decided", () => {
    expect(timerMinutes("Add the peas 5 minutes before serving.")).toBeNull();
    expect(timerMinutes("Ready in 45 minutes total; simmer 20 minutes.")).toBe(20);
    expect(timerMinutes("The whole recipe takes about 1 hour.")).toBeNull();
    expect(timerMinutes("The sauce keeps up to 3 days.")).toBeNull();
    expect(timerMinutes("Keeps, covered, 3 days.")).toBeNull();
    expect(timerMinutes("Serve within 10 minutes of slicing.")).toBeNull();
  });
});

// Slice B5a, decision A2: a compound is one duration wherever it is read.
describe("durationsIn compounds (B5a, A2)", () => {
  it.each([
    ["Roast 1 hour, 15 minutes.", [75]],
    ["Bake 2h 30m.", [150]],
    ["Bake 2h30m.", [150]],
    ["Proof 1 h 15 min.", [75]],
    ["Cure a day and 8 hours.", [1920]],
    ["Cure a day and a half.", [2160]],
    ["Rest 1 hour, then bake 30 minutes.", [60, 30]],
    ["Cook 10 minutes, 5 minutes more if needed.", [10, 5]],
  ])("%s", (text, expected) => {
    expect(minutesIn(text)).toEqual(expected);
  });

  it("does not read a bare m as minutes outside an hour compound", () => {
    expect(minutesIn("Roll to 30 m of string.")).toEqual([]);
    expect(minutesIn("Cut 2 m lengths, then rest 5 minutes.")).toEqual([5]);
  });

  it("bounds a whole compound", () => {
    expect(durationsIn("Serve within 1 hour, 30 minutes.")).toEqual([{ minutes: 90, role: "bound" }]);
    // "Up to" in a step is its longest, which a timer runs to (B5a verify round 1, Q4).
    expect(durationsIn("Chill up to 1 hour, 30 minutes.")).toEqual([{ minutes: 90, role: "length" }]);
  });
});
