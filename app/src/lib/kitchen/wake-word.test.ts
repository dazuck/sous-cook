import { describe, expect, it } from "vitest";
import {
  ARM_WINDOW_MS,
  WAKE_WORDS,
  hear,
  hearTapped,
  normalizeUtterance,
  parseCommand,
  howMuchHeard,
  timerRequestSeconds,
  type Hearing,
} from "./wake-word";

const T0 = 1_000_000;

/** Hears each utterance in turn from a fresh state, one second apart unless timed. */
function hearAll(...said: (string | [string, number])[]) {
  let state = { armedUntil: null as number | null };
  const outcomes: Hearing[] = [];
  let now = T0;
  for (const item of said) {
    const [text, at] = typeof item === "string" ? [item, (now += 1000)] : item;
    const result = hear(state, text, at);
    state = result.state;
    outcomes.push(result.outcome);
  }
  return outcomes;
}

describe("normalizeUtterance", () => {
  it("lowercases, strips punctuation, and collapses spaces", () => {
    expect(normalizeUtterance("  Sue, NEXT.  ")).toBe("sue next");
    expect(normalizeUtterance("Sous-chef: what's next?")).toBe("sous chef what's next");
  });

  it("keeps apostrophes inside words and drops quote marks around them", () => {
    expect(normalizeUtterance("“I’m done”")).toBe("i'm done");
  });

  it("keeps a decimal point or a fraction's slash between digits, and only there", () => {
    expect(normalizeUtterance("Sue, set a timer for 1.5 hours.")).toBe("sue set a timer for 1.5 hours");
    expect(normalizeUtterance("1 and 1/2 hours")).toBe("1 and 1/2 hours");
    expect(normalizeUtterance("step 3. Next/back")).toBe("step 3 next back");
    expect(normalizeUtterance("timer for .5 hours.")).toBe("timer for .5 hours");
    expect(normalizeUtterance("Sue. Next.")).toBe("sue next");
  });
});

describe("the wake list", () => {
  it("holds the ways Chrome writes “Sous”, never a common word", () => {
    expect(WAKE_WORDS).toEqual(expect.arrayContaining(["sous", "sue", "soo", "su", "sioux", "sou"]));
    for (const common of ["so", "zoo", "sew", "soup", "shoe", "see", "you"]) {
      expect(WAKE_WORDS).not.toContain(common);
    }
  });
});

describe("parseCommand", () => {
  it.each([
    ["next", "next"],
    ["next step", "next"],
    ["continue", "next"],
    ["what's next", "next-few"],
    ["next few", "next-few"],
    ["how much more", "how-much-more"],
    ["back", "back"],
    ["go back", "back"],
    ["previous", "back"],
    ["whole recipe", "whole-recipe"],
    ["the whole recipe", "whole-recipe"],
    ["show the whole recipe", "whole-recipe"],
    // N2-9: the chart's words open the chart, the column's words the column.
    ["whole cook", "how-much-more"],
    ["the whole cook", "how-much-more"],
    ["show the whole cook", "how-much-more"],
    ["show the plan", "how-much-more"],
    ["the plan", "how-much-more"],
    ["show the map", "how-much-more"],
    ["the map", "how-much-more"],
    ["ingredients", "whole-recipe"],
    ["what ingredients", "whole-recipe"],
    ["show ingredients", "whole-recipe"],
    ["show me ingredients", "whole-recipe"],
    ["what do i need", "whole-recipe"],
    ["what's in this", "whole-recipe"],
    ["shopping list", "whole-recipe"],
    ["all steps", "whole-recipe"],
    ["show all steps", "whole-recipe"],
    ["show all", "how-much-more"],
    ["overview", "how-much-more"],
    ["show overview", "how-much-more"],
    ["step list", "whole-recipe"],
    ["done", "done"],
    ["i'm done", "done"],
    ["finished", "done"],
    ["close", "close"],
    ["close that", "close"],
    ["back to cooking", "close"],
    ["never mind", "close"],
    ["flag", "flag"],
    ["flag this", "flag"],
    ["flag that", "flag"],
    ["flag it", "flag"],
  ])("“%s” is %s", (said, command) => {
    expect(parseCommand(said)).toBe(command);
  });

  it.each(["ok", "okay", "repeat", "again", "sorry", "say again", "all", "steps"])(
    "“%s” is no longer a command",
    (said) => {
      expect(parseCommand(said)).toBeNull();
    },
  );

  it("matches the whole phrase, never a command inside a sentence", () => {
    expect(parseCommand("next time use less salt")).toBeNull();
    expect(parseCommand("go back to the store")).toBeNull();
    expect(parseCommand("done")).toBe("done");
    expect(parseCommand("flag the timer is wrong")).toBeNull();
  });
});

describe("hear", () => {
  it("acts on a command said after the wake word", () => {
    expect(hearAll("Sue, next")).toEqual([{ kind: "command", command: "next", heard: "sue next" }]);
    expect(hearAll("Sous next step")[0]).toMatchObject({ kind: "command", command: "next" });
    expect(hearAll("Sioux back")[0]).toMatchObject({ kind: "command", command: "back" });
    expect(hearAll("hey Sue, ingredients")[0]).toMatchObject({
      kind: "command",
      command: "whole-recipe",
    });
    expect(hearAll("Sous chef, done")[0]).toMatchObject({ kind: "command", command: "done" });
    expect(hearAll("Sue, what's next")[0]).toMatchObject({ kind: "command", command: "next-few" });
    expect(hearAll("Sue, how much more")[0]).toMatchObject({ kind: "command", command: "how-much-more" });
    expect(hearAll("Sue, whole recipe")[0]).toMatchObject({ kind: "command", command: "whole-recipe" });
  });

  it("flags on “Sue, flag” and its variants, and treats a sentence about a flag as talk", () => {
    expect(hearAll("Sue, flag")).toEqual([{ kind: "command", command: "flag", heard: "sue flag" }]);
    for (const said of ["Sue flag this", "Sue, flag that", "hey Sue flag it"]) {
      expect(hearAll(said)[0]).toMatchObject({ kind: "command", command: "flag" });
    }
    expect(hearAll("Sue", "flag").map((o) => o.kind)).toEqual(["armed", "command"]);
    expect(hearAll("Sue, flag the timer is wrong")).toEqual([{ kind: "ignore" }]);
    expect(hearAll("flag")).toEqual([{ kind: "ignore" }]);
  });

  it("ignores a command said without the wake word", () => {
    expect(hearAll("next")).toEqual([{ kind: "ignore" }]);
    expect(hearAll("okay done")).toEqual([{ kind: "ignore" }]);
    expect(hearAll("alright next")).toEqual([{ kind: "ignore" }]);
  });

  it("acts only when the wake word opens the utterance, as Sue is also a name", () => {
    expect(hearAll("that looks good Sue next")).toEqual([{ kind: "ignore" }]);
    expect(hearAll("I'll ask Sue next")).toEqual([{ kind: "ignore" }]);
    expect(hearAll("we should call Sue next")).toEqual([{ kind: "ignore" }]);
    expect(hearAll("okay Sue, next")[0]).toMatchObject({ kind: "command", command: "next" });
  });

  it("ignores the name in conversation unless the whole rest is a command", () => {
    expect(hearAll("Sue said the dal needs more salt")).toEqual([{ kind: "ignore" }]);
    expect(hearAll("Sue, next time use less salt")).toEqual([{ kind: "ignore" }]);
  });

  it("says it didn't catch a short phrase after the wake word", () => {
    expect(hearAll("Sue, flip it")).toEqual([{ kind: "unknown", heard: "sue flip it" }]);
  });

  it("arms a window on the wake word alone, in which a bare command counts", () => {
    const [armed, acted] = hearAll("Sue", "next");
    expect(armed).toEqual({ kind: "armed" });
    expect(acted).toMatchObject({ kind: "command", command: "next", heard: "next" });
    expect(hearAll("hey Sue")).toEqual([{ kind: "armed" }]);
  });

  it("arms nothing on the name at the end of a sentence", () => {
    for (const said of ["I'll ask Sue", "that's for Sue", "thanks Sue"]) {
      expect(hearAll(said, "done").map((o) => o.kind)).toEqual(["ignore", "ignore"]);
    }
  });

  it("takes one command per window", () => {
    expect(hearAll("Sue", "next", "next").map((o) => o.kind)).toEqual([
      "armed",
      "command",
      "ignore",
    ]);
  });

  it("lets the window lapse", () => {
    const outcomes = hearAll(["Sue", T0], ["next", T0 + ARM_WINDOW_MS + 1]);
    expect(outcomes[1]).toEqual({ kind: "ignore" });
    const inTime = hearAll(["Sue", T0], ["next", T0 + ARM_WINDOW_MS]);
    expect(inTime[1]).toMatchObject({ kind: "command", command: "next" });
  });

  it("closes the window on a short phrase it can't use, and waits out chatter", () => {
    expect(hearAll("Sue", "flip it", "next").map((o) => o.kind)).toEqual([
      "armed",
      "unknown",
      "ignore",
    ]);
    expect(hearAll("Sue", "hang on I need to wash my hands", "next").map((o) => o.kind)).toEqual([
      "armed",
      "ignore",
      "command",
    ]);
  });

  it("shows a near miss: a command after a word Chrome may have written for “Sue”", () => {
    expect(hearAll("shoe next")).toEqual([{ kind: "near-miss", heard: "shoe next" }]);
    expect(hearAll("zoo done")).toEqual([{ kind: "near-miss", heard: "zoo done" }]);
  });

  it("stays quiet for kitchen talk that happens to hold a command", () => {
    for (const said of ["so go back", "sure, done", "so what's next", "see next", "zest done"]) {
      expect(hearAll(said)).toEqual([{ kind: "ignore" }]);
    }
  });

  it("ignores empty speech", () => {
    expect(hearAll("   ", "...")).toEqual([{ kind: "ignore" }, { kind: "ignore" }]);
  });
});

describe("hearTapped: a command or a question after a tap on the dot", () => {
  it("takes a bare command, as the tap already said it's for Sous", () => {
    expect(hearTapped("Next")).toEqual({ kind: "command", command: "next", heard: "next" });
    expect(hearTapped("go back")).toEqual({ kind: "command", command: "back", heard: "go back" });
    expect(hearTapped("Flag this")).toEqual({ kind: "command", command: "flag", heard: "flag this" });
  });

  it("takes it with the wake word too, or a word Chrome may have written for it", () => {
    for (const said of ["Sue, next", "hey Sous chef next", "shoe next", "okay zoo next"]) {
      expect(hearTapped(said)).toMatchObject({ kind: "command", command: "next" });
    }
  });

  it("echoes a word too few to ask about, or the wake word alone", () => {
    expect(hearTapped("salt")).toEqual({ kind: "unknown", heard: "salt" });
    expect(hearTapped("Sue")).toEqual({ kind: "unknown", heard: "sue" });
    expect(hearTapped("hey Sue, oregano?")).toEqual({ kind: "unknown", heard: "hey sue oregano" });
    // "Timer" alone is the step's timer since B5a (A12): a command.
    expect(hearTapped("hey Sue, timer?")).toEqual({ kind: "command", command: "start-timer", heard: "hey sue timer" });
  });

  it("asks anything longer that isn't a command, as Chrome wrote it, less the address", () => {
    // "How much salt" is an amount question since B5d (D11), answered without Ask.
    expect(hearTapped("how much salt?")).toEqual({ kind: "command", command: "how-much", heard: "how much salt" });
    // A question about the recipe still goes to Ask (and, after a tap, so does an
    // amount of something the recipe doesn't hold: the cook screen's fallback).
    expect(hearTapped("how many people does this serve?")).toEqual({
      kind: "question",
      text: "How many people does this serve?",
      heard: "how many people does this serve",
    });
    expect(hearTapped("Sue, what can I use instead of cream?")).toMatchObject({
      kind: "question",
      text: "What can I use instead of cream?",
    });
    expect(hearTapped("Hey, Sous-chef: is the oil hot enough")).toMatchObject({
      kind: "question",
      text: "Is the oil hot enough",
    });
  });

  it("ignores empty speech", () => {
    expect(hearTapped("  ...  ")).toEqual({ kind: "ignore" });
  });

  // Where cook-time speech goes after a tap (DECISIONS 2026-10-02). The
  // two-word cutoff is a guess; this table is what it is held to, and where
  // what the tablet actually hears gets added.
  it.each<[string, "command" | "question" | "unknown"]>([
    // Commands, bare and addressed.
    ["next", "command"],
    ["Next step.", "command"],
    ["what's next", "command"],
    ["go back", "command"],
    ["Sue, ingredients", "command"],
    ["show all steps", "command"],
    ["the whole cook", "command"],
    ["I'm done", "command"],
    ["never mind", "command"],
    ["back to cooking", "command"],
    ["okay Sue close that", "command"],
    // Garbled commands: long enough to ask, so Ask gets them (echoed, "close" recovers).
    ["next one", "question"],
    ["next stp", "question"],
    ["go bak", "question"],
    // One word: echoed, nothing asked.
    ["timer", "command"], // B5a: the step's timer
    ["substitute?", "unknown"],
    ["nxt", "unknown"],
    ["Sue", "unknown"],
    ["shoe", "unknown"],
    ["Sue, salt", "unknown"],
    // Questions.
    ["how much salt", "command"], // B5d: an amount question, answered locally (D11)
    ["how many people does this serve", "question"], // about the recipe: Ask
    ["is it ready", "question"],
    ["how long do I rest it", "question"],
    ["Sue, can I use butter instead", "question"],
    ["what temperature for the oven", "question"],
    ["substitute for cream", "question"],
    ["how do I know when it's done", "question"],
    ["double the recipe", "question"],
    ["set a timer for ten minutes", "command"], // B5a: a kitchen timer
    // Talk after a tap still meant for Sous: the tap was the address.
    ["next time use less salt", "question"],
  ])("%j → %s", (said, route) => {
    expect(hearTapped(said).kind).toBe(route);
  });
});

// Slice B5a, A12 (B1 timer reading 6): timers by voice.
describe("timer commands", () => {
  it.each([
    ["timer", "start-timer"],
    ["start the timer", "start-timer"],
    ["start a timer", "start-timer"],
    ["start timer", "start-timer"],
    ["set a timer for 5 minutes", "set-timer"],
    ["timer for ten minutes", "set-timer"],
    ["set timer for an hour and a half", "set-timer"],
    ["start a 90 second timer", "set-timer"],
    ["twenty minute timer", "set-timer"],
    ["stop", "dismiss-timer"],
    ["stop the timer", "dismiss-timer"],
    ["stop the alarm", "dismiss-timer"],
    ["dismiss", "dismiss-timer"],
    ["dismiss it", "dismiss-timer"],
    ["timer off", "dismiss-timer"],
  ])("%j is %s", (phrase, command) => {
    expect(parseCommand(phrase)).toBe(command);
  });

  it("acts only after the wake word, like every command", () => {
    expect(hearAll("set a timer for 5 minutes")[0]).toEqual({ kind: "ignore" });
    expect(hearAll("sue set a timer for 5 minutes")[0]).toEqual({
      kind: "command",
      command: "set-timer",
      heard: "sue set a timer for 5 minutes",
    });
    expect(hearAll("we need to stop")[0]).toEqual({ kind: "ignore" });
  });

  it.each([
    ["sue set a timer for 5 minutes", 300],
    ["timer for ten minutes", 600],
    ["set timer for an hour and a half", 5400],
    ["start a 90 second timer", 90],
    ["twenty minute timer", 1200],
    ["sue timer for 1 hour 15 minutes", 4500],
    ["set a timer for 2 hours", 7200],
  ])("reads the seconds a timer asks for: %j is %i", (heard, seconds) => {
    expect(timerRequestSeconds(heard)).toBe(seconds);
  });

  // Chrome writes "1.5" and "1/2" as numerals: what `hear` passes on keeps
  // them, so a timer never starts hours off (B5a verify round 1, H1).
  it.each([
    ["Sue, set a timer for 1.5 hours", 5400],
    ["Sue, set a timer for 0.5 hours", 1800],
    ["Sue, 2.5 minute timer", 150],
    ["Sue, set a timer for 1 and 1/2 hours", 5400],
    ["Sue, set a timer for 2 and 1/2 minutes", 150],
    ["Sue, set a timer for 1 1/2 hours", 5400],
    ["Sue, set a timer for .5 hours", 1800],
    // An ellipsis is never a decimal point (verify of 11790c5, item 6).
    ["Sue, set a timer for...5 minutes", 300],
    ["Sue, set a timer for… 5 minutes", 300],
  ])("reads a said decimal or fraction whole, from what was heard: %j is %i", (said, seconds) => {
    const outcome = hear({ armedUntil: null }, said, T0).outcome;
    expect(outcome.kind).toBe("command");
    expect(timerRequestSeconds((outcome as { heard: string }).heard)).toBe(seconds);
    const tapped = hearTapped(said);
    expect(timerRequestSeconds((tapped as { heard: string }).heard)).toBe(seconds);
  });

  // Re-verify of 4bbf470: "1..5" is neither 1.5 nor 5; a garbled number
  // sets nothing, so the cook hears "Couldn't set that timer" and says it again.
  it.each(["Sue, set a timer for 1..5 minutes", "Sue, set a timer for 1…5 minutes"])(
    "reads no seconds from a number broken by a doubled point: %j",
    (said) => {
      const outcome = hear({ armedUntil: null }, said, T0).outcome;
      expect(timerRequestSeconds((outcome as { heard: string }).heard)).toBeNull();
    },
  );

  it("reads no seconds where the phrase names no time", () => {
    expect(timerRequestSeconds("set a timer for the rice")).toBeNull();
    expect(timerRequestSeconds("timer for later")).toBeNull();
  });
});

describe("amount questions and the checkpoint's not yet (B5d D8, D11)", () => {
  it.each<[string, { asked: string; unit: string | null }]>([
    ["how much flour", { asked: "flour", unit: null }],
    ["how many eggs", { asked: "eggs", unit: null }],
    ["how much flour in grams", { asked: "flour", unit: "g" }],
    ["how much milk in cups", { asked: "milk", unit: "cup" }],
    ["how much butter in tablespoons", { asked: "butter", unit: "tbsp" }],
    ["how much flour do i need", { asked: "flour", unit: null }],
    ["how much sugar goes in", { asked: "sugar", unit: null }],
    ["how much of the bread flour again", { asked: "of the bread flour", unit: null }],
    ["how much all purpose flour in ounces", { asked: "all purpose flour", unit: "oz" }],
    ["how much milk in total", { asked: "milk", unit: null }],
    ["how much flour altogether", { asked: "flour", unit: null }],
    ["how much milk is there", { asked: "milk", unit: null }],
    // Common phrasings around the ingredient (b5d-followup item 2).
    ["how much flour should i use", { asked: "flour", unit: null }],
    ["how much oil do i put in", { asked: "oil", unit: null }],
    ["how much is the flour", { asked: "the flour", unit: null }],
    ["how much sugar goes in the dough", { asked: "sugar", unit: null }],
    ["how much butter to use", { asked: "butter", unit: null }],
    ["how many eggs do i need for this", { asked: "eggs", unit: null }],
    ["how much flour should i use in grams", { asked: "flour", unit: "g" }],
    // Its ingredient is "water"; a recipe without water sends it to Ask after a tap.
    ["how much water should i add to thin it", { asked: "water", unit: null }],
  ])("“%s” asks for %j", (said, request) => {
    expect(parseCommand(said)).toBe("how-much");
    expect(howMuchHeard(said)).toEqual(request);
  });

  it("keeps N's “how much more” the level's, never an amount of “more”", () => {
    expect(parseCommand("how much more")).toBe("how-much-more");
    expect(howMuchHeard("Sue, how much more")).toBeNull();
  });

  it.each([
    "how much longer",
    "how much time is left",
    "how much time",
    "how long",
    "how much",
    "how many cookies does this make",
    "how much is left in the pot",
    // Questions about the recipe, not an amount of one of its lines (verify round 1): Ask's after a tap.
    "how many people does this serve",
    "how much does this make",
    "how many cookies does this make",
    "how many tablespoons in a cup",
    "how many servings",
    "how many calories",
    "how many degrees",
    "how much heat",
    "how much is a cup",
    "how much do i need",
  ])(
    "“%s” is not an amount question",
    (said) => {
      expect(parseCommand(said)).toBeNull();
    },
  );

  it("hears an amount question after the wake word, and reads it from what was heard", () => {
    const [outcome] = hearAll("Sue, how much flour?");
    expect(outcome).toEqual({ kind: "command", command: "how-much", heard: "sue how much flour" });
    expect(howMuchHeard("sue how much flour")).toEqual({ asked: "flour", unit: null });
    expect(hearAll("Sue, how much flour do I need in grams")[0]).toMatchObject({ kind: "command", command: "how-much" });
  });

  it("“not yet” and “not quite” are the checkpoint's", () => {
    expect(parseCommand("not yet")).toBe("not-yet");
    expect(parseCommand("not quite")).toBe("not-yet");
    expect(hearAll("Sue, not yet")[0]).toMatchObject({ kind: "command", command: "not-yet" });
    expect(parseCommand("not yet done")).toBeNull();
  });
});
