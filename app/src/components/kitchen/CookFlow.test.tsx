// @vitest-environment happy-dom
import { act, cleanup, fireEvent, render, screen, within } from "@testing-library/react";
import { createRef } from "react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { FINISH_ARM_MS } from "@/hooks/useFinishArm";
import { TAP_MS, TAP_SLOP } from "@/lib/kitchen/tap-zone";
import { identityPlan } from "@/lib/kitchen/cook-plan";
import {
  COOK_COPY,
  bindNumbers,
  cookView,
  initialCookState,
  next,
  prepEyebrow,
  prepPages,
  toggleTick,
  type CookState,
  type CookView,
  type PlanSource,
} from "@/lib/kitchen/cook-view";
import {
  storedIngredientLines,
  type StoredIngredientLines,
} from "@/lib/kitchen/ingredient-display";
import { legacyToPackRecipe } from "@/lib/pack-convert/convert";
import type { RecipeForPlan } from "@/lib/kitchen/cook-plan";
import { AMOUNT_RULE } from "./MeasurementPopover";
import { TIMER_COPY } from "./TimerLine";
import type { VoiceProps } from "./VoiceDot";
import { ZUCCHINI_PLAN, ZUCCHINI_RECIPE } from "@/lib/kitchen/__tests__/zucchini-wraps";
import {
  CookFlow,
  type CookFlowNav,
  type CookTimers,
  type FinishState,
} from "./CookFlow";

// happy-dom has no font loading; the flow listens for fonts arriving. The
// stand-in has the FontFaceSet's own `status` and `ready`, as a browser does.
const fonts = Object.assign(new EventTarget(), {
  status: "loaded" as "loading" | "loaded",
  ready: Promise.resolve(),
});
Object.defineProperty(document, "fonts", { value: fonts, configurable: true });

const FAILED: PlanSource = { kind: "as-written", reason: "failed" };
const ZUCCHINI = identityPlan(ZUCCHINI_RECIPE);

/**
 * A recipe's ingredients as the cook page reads them: converted (serving 4),
 * then each line by stored index, scaled to `servings` when given.
 */
function linesOf(name: string, recipe: RecipeForPlan, servings?: number): StoredIngredientLines {
  const converted = legacyToPackRecipe({ name, ...recipe, serves: 4 }, { id: name });
  if (!converted.ok) throw new Error(JSON.stringify(converted.issues));
  return storedIngredientLines(converted.recipe, recipe.ingredients?.length ?? 0, servings);
}

const ZUCCHINI_INGREDIENTS = linesOf("Sweet Zucchini Wraps", ZUCCHINI_RECIPE);

function zucchiniAt(presses: number): CookView {
  let state: CookState = initialCookState("first");
  for (let i = 0; i < presses; i++) state = next(ZUCCHINI, state);
  return cookView(ZUCCHINI, FAILED, state);
}

const SECOND = zucchiniAt(1);
const LAST = zucchiniAt(4);

// An ingredients-only capture: the sync keeps a tab of ingredients with no
// method as a recipe with no steps. One line of each kind the pairs show.
const HERB_SALT_RECIPE: RecipeForPlan = {
  ingredients: [
    { amount: "2", unit: "tbsp", item: "flaky salt" },
    { amount: "1", unit: "sprig", item: "rosemary" },
    { amount: "a pinch of", item: "chili flakes" },
    { item: "salt, to taste" },
    { item: "zest of 1 lemon" },
  ],
  steps: [],
};
const HERB_SALT = linesOf("Herb Salt", HERB_SALT_RECIPE);
const NO_STEPS = cookView(identityPlan(HERB_SALT_RECIPE), FAILED, initialCookState("first"));

let now = 1000;

beforeEach(() => {
  now = 1000;
  vi.spyOn(performance, "now").mockImplementation(() => now);
});

afterEach(() => {
  vi.restoreAllMocks();
  document.body.innerHTML = "";
});

function flow(
  view: CookView,
  {
    ingredients = ZUCCHINI_INGREDIENTS,
    finish = "ready",
    navEnabled = true,
    timers,
    notices,
    voice,
    askOpen,
    restInert,
    opening,
    away,
  }: {
    away?: string | null;
    ingredients?: StoredIngredientLines;
    finish?: FinishState;
    navEnabled?: boolean;
    timers?: CookTimers;
    notices?: string[];
    voice?: VoiceProps;
    askOpen?: boolean;
    restInert?: boolean;
    opening?: { onStart: () => void } | null;
  } = {},
) {
  const handlers = {
    onNext: vi.fn(),
    onBack: vi.fn(),
    onFinish: vi.fn(),
    onTick: vi.fn(),
  };
  const flowHandlers = handlers;
  const props = (finishState: FinishState, nav: boolean) => (
    <CookFlow
      view={view}
      mode="first"
      ingredients={ingredients}
      onMode={vi.fn()}
      onAskAhead={vi.fn()}
      finish={finishState}
      navEnabled={nav}
      voice={voice}
      askOpen={askOpen}
      timers={timers}
      notices={notices}
      restInert={restInert}
      opening={opening}
      away={away}
      {...flowHandlers}
    />
  );
  const result = render(props(finish, navEnabled));
  return {
    ...handlers,
    rerender: (finishState: FinishState, nav = navEnabled) =>
      result.rerender(props(finishState, nav)),
  };
}

/** Something outside the flow, as the Ask Claude box and the header are. */
function mount(html: string): HTMLElement {
  const host = document.createElement("div");
  host.innerHTML = html;
  document.body.appendChild(host);
  return host.firstElementChild as HTMLElement;
}

function press(target: Element, key: string, init: KeyboardEventInit = {}) {
  let prevented = false;
  act(() => {
    prevented = !fireEvent.keyDown(target, { key, ...init });
  });
  return prevented;
}

function finishButton(): HTMLElement {
  return screen.getByRole("button", { name: COOK_COPY.finish });
}

describe("CookFlow: keys", () => {
  it("turns the page with the arrows pressed on the page itself", () => {
    const { onNext, onBack } = flow(SECOND);
    press(document.body, "ArrowRight");
    press(document.body, "ArrowLeft");
    expect(onNext).toHaveBeenCalledTimes(1);
    expect(onBack).toHaveBeenCalledTimes(1);
  });

  it.each([
    ["a text field", "<input />"],
    ["a text area", "<textarea></textarea>"],
    ["editable text", '<div contenteditable="true">note</div>'],
    ["a video with controls", "<video controls></video>"],
    ["a slider", '<div role="slider" tabindex="0"></div>'],
    ["a tab list", '<div role="tablist" tabindex="0"></div>'],
    ["a menu", '<div role="menu" tabindex="0"></div>'],
  ])("leaves the arrows pressed in %s to it", (_label, html) => {
    const { onNext, onBack } = flow(SECOND);
    const target = mount(html);
    press(target, "ArrowRight");
    press(target, "ArrowLeft");
    expect(onNext).not.toHaveBeenCalled();
    expect(onBack).not.toHaveBeenCalled();
  });

  it("sees a field inside a shadow root, though the event reaches the window from its host", () => {
    const { onNext } = flow(SECOND);
    const host = mount("<div></div>");
    const shadow = host.attachShadow({ mode: "open" });
    const input = document.createElement("input");
    shadow.appendChild(input);
    // A browser retargets the window's e.target from the input to the host
    // and keeps the input first in the composed path; happy-dom doesn't
    // retarget, so the event is dispatched from the host with that path.
    const e = new KeyboardEvent("keydown", { key: "ArrowRight", bubbles: true });
    Object.defineProperty(e, "composedPath", {
      value: () => [input, shadow, host, document.body, document.documentElement, document, window],
    });
    act(() => {
      host.dispatchEvent(e);
    });
    expect(onNext).not.toHaveBeenCalled();
  });

  it("turns the page with the arrows on a button, which does nothing with them", () => {
    const { onNext } = flow(SECOND);
    press(mount("<button>Ingredients</button>"), "ArrowRight");
    expect(onNext).toHaveBeenCalledTimes(1);
  });

  it.each([
    ["the page", null],
    ["a button", "<button>Ingredients</button>"],
    ["a link", '<a href="/kitchen">Kitchen</a>'],
    ["a checkbox", '<div role="checkbox" tabindex="0"></div>'],
    ["a switch", '<div role="switch" tabindex="0"></div>'],
  ])("never moves or finishes on Enter pressed on %s", (_label, html) => {
    now = 1000;
    const second = flow(SECOND);
    const last = flow(LAST);
    now += FINISH_ARM_MS * 2;
    press(html ? mount(html) : document.body, "Enter");
    for (const { onNext, onBack, onFinish } of [second, last]) {
      expect(onNext).not.toHaveBeenCalled();
      expect(onBack).not.toHaveBeenCalled();
      expect(onFinish).not.toHaveBeenCalled();
    }
  });

  it("leaves the arrows alone while a modal or panel is open", () => {
    const { onNext, onBack, rerender } = flow(SECOND, { navEnabled: false });
    press(document.body, "ArrowRight");
    press(document.body, "ArrowLeft");
    expect(onNext).not.toHaveBeenCalled();
    expect(onBack).not.toHaveBeenCalled();
    rerender("ready", true);
    press(document.body, "ArrowRight");
    expect(onNext).toHaveBeenCalledTimes(1);
  });

  it("leaves the arrows alone while a popover holds them", () => {
    const { onNext } = flow(SECOND);
    mount("<div data-holds-keys></div>");
    press(document.body, "ArrowRight");
    expect(onNext).not.toHaveBeenCalled();
  });

  it("never finishes on the arrow on the last screen", () => {
    const { onNext, onFinish } = flow(LAST);
    now += FINISH_ARM_MS * 2;
    press(document.body, "ArrowRight");
    expect(onNext).not.toHaveBeenCalled();
    expect(onFinish).not.toHaveBeenCalled();
  });
});

describe("CookFlow: finishing", () => {
  it("holds a held Enter on the forward control to one press", () => {
    flow(LAST);
    expect(press(finishButton(), "Enter", { repeat: true })).toBe(true);
    expect(press(finishButton(), "Enter")).toBe(false);
  });

  it("finishes once: the finish control waits out the arm, then ignores presses while saving", () => {
    const { onFinish, rerender } = flow(LAST);
    fireEvent.click(finishButton());
    expect(onFinish).not.toHaveBeenCalled();

    now += FINISH_ARM_MS;
    fireEvent.click(finishButton());
    expect(onFinish).toHaveBeenCalledTimes(1);

    rerender("saving");
    fireEvent.click(finishButton());
    expect(onFinish).toHaveBeenCalledTimes(1);
    expect(finishButton().getAttribute("aria-disabled")).toBe("true");
  });

  it("tries again after a failed save", () => {
    const { onFinish } = flow(LAST, { finish: "failed" });
    now += FINISH_ARM_MS;
    const retry = screen.getByRole("button", { name: COOK_COPY.finishFailed });
    fireEvent.click(retry);
    expect(onFinish).toHaveBeenCalledTimes(1);
  });
});

describe("CookFlow: a recipe with no steps", () => {
  it("says so, with every ingredient listed under it as words: an amount, then its name", () => {
    flow(NO_STEPS, { ingredients: HERB_SALT });
    const line = screen.getByText(COOK_COPY.noSteps, { selector: "p:not(.sr-only)" });
    const pairs = [...(line.parentElement?.querySelectorAll("[data-pairs] > li") ?? [])].map(
      (li) => li.textContent,
    );
    // The stated amount, a count with its noun in the name, the source's own
    // words marked, and the name alone for to taste and unstated (B4).
    expect(pairs).toEqual([
      "2 tbsp flaky salt",
      "1 sprig rosemary",
      `a pinch of chili flakes (${COOK_COPY.asWritten})`,
      "salt, to taste",
      "zest of 1 lemon",
    ]);
    expect(document.querySelector("[data-as-written]")?.textContent).toBe(
      `(${COOK_COPY.asWritten})`,
    );
  });

  it("makes a pair whose amount converts one button, named by the amount and its name (V8)", () => {
    flow(NO_STEPS, { ingredients: HERB_SALT });
    const salt = screen.getByRole("button", { name: "2 tbsp flaky salt" });
    expect(salt.getAttribute("aria-expanded")).toBe("false");
    fireEvent.click(salt);
    expect(salt.getAttribute("aria-expanded")).toBe("true");
    const panel = document.querySelector("[data-holds-keys]")?.textContent;
    expect(panel).toContain(COOK_COPY.statedHeading);
    expect(panel).toContain(COOK_COPY.conversionsHeading);
    // A count, the source's own words and a name alone have nothing to convert.
    expect(screen.queryAllByRole("button", { name: /rosemary|chili|salt, to taste|lemon/ })).toEqual(
      [],
    );
  });

  it("offers only the finish, which finishes it", () => {
    const { onNext, onBack, onFinish } = flow(NO_STEPS, { ingredients: HERB_SALT });
    expect(screen.getByRole("button", { name: COOK_COPY.back }).getAttribute("aria-disabled")).toBe(
      "true",
    );
    now += FINISH_ARM_MS;
    press(document.body, "ArrowRight");
    press(document.body, "ArrowLeft");
    expect(onNext).not.toHaveBeenCalled();
    expect(onBack).not.toHaveBeenCalled();
    fireEvent.click(finishButton());
    expect(onFinish).toHaveBeenCalledTimes(1);
  });

  it("says nothing about a prep plan above it, not even a blank line", () => {
    flow(NO_STEPS, { ingredients: HERB_SALT });
    expect(screen.queryByText(COOK_COPY.failed)).toBeNull();
    expect(screen.queryByText(COOK_COPY.pending)).toBeNull();
    const blank = [...document.querySelectorAll("p")].filter((p) => !p.textContent?.trim());
    expect(blank).toEqual([]);
  });
});

// B4 fix round 2: the converter skips a blank stored line, and a stored plan
// still names lines by stored index, so each pair is the line it names.
describe("CookFlow: a recipe with a blank stored ingredient line", () => {
  const GAPPED: RecipeForPlan = {
    ingredients: [
      { amount: "2", item: "eggs" },
      { item: "  " },
      { amount: "1", unit: "tsp", item: "salt" },
    ],
    steps: ["Beat the eggs.", "Season with the salt."],
    stepIngredients: [[0], [2]],
  };
  const lines = linesOf("Gapped", GAPPED);
  const plan = identityPlan(GAPPED);

  function pairsShown(): (string | null)[] {
    return [...document.querySelectorAll("[data-role='now'] [data-pairs] > li")].map(
      (li) => li.textContent,
    );
  }

  it("pairs a step with the line its stored index names, past the gap", () => {
    let state = initialCookState("first");
    state = next(plan, state);
    flow(cookView(plan, FAILED, state), { ingredients: lines });
    expect(pairsShown()).toEqual(["1 tsp salt"]);
  });

  it("lists every line but the blank one when there are no steps", () => {
    const noSteps = { ...GAPPED, steps: [], stepIngredients: undefined };
    flow(cookView(identityPlan(noSteps), FAILED, initialCookState("first")), {
      ingredients: linesOf("Gapped", noSteps),
    });
    const line = screen.getByText(COOK_COPY.noSteps, { selector: "p:not(.sr-only)" });
    const pairs = [...(line.parentElement?.querySelectorAll("[data-pairs] > li") ?? [])].map(
      (li) => li.textContent,
    );
    expect(pairs).toEqual(["2 eggs", "1 tsp salt"]);
  });
});

// B4 fix round 3: a line whose name is only its own amount ("3", "2 g", "a
// pinch", the item blank or the line imported whole) says the amount once.
describe("CookFlow: a line that is only an amount", () => {
  it("pairs it as its amount alone, a measure still opening its conversions", () => {
    const onlyAmounts: RecipeForPlan = {
      ingredients: [
        { amount: "3", item: "" },
        { item: "2 g" },
        { amount: "a pinch", item: "" },
      ],
      steps: [],
    };
    flow(cookView(identityPlan(onlyAmounts), FAILED, initialCookState("first")), {
      ingredients: linesOf("Only amounts", onlyAmounts),
    });
    const line = screen.getByText(COOK_COPY.noSteps, { selector: "p:not(.sr-only)" });
    const pairs = [...(line.parentElement?.querySelectorAll("[data-pairs] > li") ?? [])].map(
      (li) => li.textContent,
    );
    expect(pairs).toEqual(["3", "2 g", `a pinch (${COOK_COPY.asWritten})`]);
    // A string name matches the whole name here, so this is the 2 g pair alone.
    fireEvent.click(screen.getByRole("button", { name: "2 g" }));
    expect(document.querySelector("[data-holds-keys]")?.textContent).toContain(
      COOK_COPY.conversionsHeading,
    );
  });
});

// Unopenable amounts ("2 leeks" and unstructured "5 cups stock (or water + 1 tsp
// bouillon)") must not wear the dotted rule without a popover. The rule is drawn
// by the button the popover makes, so an amount wears it exactly when it opens
// (DECISIONS 2026-10-26, DS §5).
describe("CookFlow: the dotted rule marks only an amount that opens", () => {
  const LEEKS: RecipeForPlan = {
    ingredients: [
      { amount: "2", unit: "lb", item: "salmon" },
      { amount: "2", item: "leeks" },
      { amount: "3", item: "eggs" },
      { item: "5 cups stock (or water + 1 tsp bouillon)" },
    ],
    steps: [],
  };
  const view = cookView(identityPlan(LEEKS), FAILED, initialCookState("first"));

  /** Each amount shown, and whether it opens (sits in the pair's button). */
  function amounts() {
    return [...document.querySelectorAll("[data-pairs] [data-amount-words]")].map((amount) => ({
      amount: amount.textContent,
      opens: amount.closest("button") !== null,
    }));
  }

  /** Every pair's element outside a button that carries an underline of its own. */
  function ruledOutsideAButton(): string[] {
    return [...document.querySelectorAll("[data-pairs] *")]
      .filter((el) => el.closest("button") === null)
      .filter((el) => /(^|\s)(underline|decoration-dotted)(\s|$)/.test(el.getAttribute("class") ?? ""))
      .map((el) => el.textContent ?? "");
  }

  function expectEveryButtonRuled() {
    const buttons = [...document.querySelectorAll("[data-pairs] button")];
    expect(buttons.length).toBeGreaterThan(0);
    for (const button of buttons) {
      expect(button.querySelector("[data-amount-words]")).not.toBeNull();
      expect(button.className).toContain(AMOUNT_RULE);
    }
  }

  it("at the recipe's servings: a measure opens over the rule; a count and the source's words are plain", () => {
    flow(view, { ingredients: linesOf("Leeks", LEEKS) });
    expect(amounts()).toEqual([
      { amount: "2 lb", opens: true },
      { amount: "2", opens: false },
      { amount: "3", opens: false },
      { amount: "5 cups", opens: false },
    ]);
    expectEveryButtonRuled();
    expect(ruledOutsideAButton()).toEqual([]);
  });

  it("scaled: a count rounding moved opens its exact count over the rule; one it didn't stays plain", () => {
    flow(view, { ingredients: linesOf("Leeks", LEEKS, 3) });
    expect(amounts()).toEqual([
      { amount: "1½ lb", opens: true },
      { amount: "1½", opens: false },
      { amount: "about 2", opens: true },
      { amount: "5 cups", opens: false },
    ]);
    expectEveryButtonRuled();
    expect(ruledOutsideAButton()).toEqual([]);
    fireEvent.click(screen.getByRole("button", { name: "about 2 eggs" }));
    expect(document.querySelector("[data-exact]")?.textContent).toBe(COOK_COPY.exactCount("2¼"));
  });
});

describe("CookFlow: the note above the steps", () => {
  it("keeps its row once it empties after the first screen, so the steps don't jump", () => {
    expect(zucchiniAt(0).note).toBe(COOK_COPY.failed);
    flow(SECOND);
    const blank = [...document.querySelectorAll("p")].filter((p) => !p.textContent?.trim());
    expect(blank).toHaveLength(1);
  });
});

// The Prep screen. It is As I go's since DS v1.59: Prep first walks prep pages
// (these tests drew Prep first's Prep screen before that slice).
const PREP = cookView(ZUCCHINI_PLAN, { kind: "derived" }, initialCookState("go"));
/** How many prep pages the zucchini has in Prep first: its cooking step `n` is `ZUCCHINI_PAGES + n - 1` presses in. */
const ZUCCHINI_PAGES = prepPages(ZUCCHINI_PLAN, "first").length;
// Prep first opens on the first of them: three small jobs, as tick rows.
const PREP_PAGE = cookView(ZUCCHINI_PLAN, { kind: "derived" }, initialCookState("first"));
// The second is one job (the onion greens): a step page under a Prep eyebrow.
const PREP_PAGE_2 = cookView(
  ZUCCHINI_PLAN,
  { kind: "derived" },
  next(ZUCCHINI_PLAN, initialCookState("first")),
);

/**
 * The stage, 900px wide from the left edge: the back third ends at x = 300,
 * and a 12px scrollbar takes the last of it.
 */
function stage(): HTMLElement {
  const el = document.querySelector<HTMLElement>("[data-stage]");
  if (!el) throw new Error("no stage");
  vi.spyOn(el, "getBoundingClientRect").mockReturnValue({
    left: 0,
    top: 0,
    right: 900,
    bottom: 700,
    width: 900,
    height: 700,
    x: 0,
    y: 0,
    toJSON: () => ({}),
  });
  vi.spyOn(el, "clientWidth", "get").mockReturnValue(888);
  return el;
}

/**
 * A press on `target` at `x`, lifted `dx` along and `ms` later, with the
 * click the browser sends after it.
 */
function tapAt(target: Element, x: number, { dx = 0, ms = 60 } = {}) {
  act(() => {
    fireEvent.pointerDown(target, { clientX: x, clientY: 200, isPrimary: true, button: 0 });
  });
  now += ms;
  act(() => {
    fireEvent.pointerUp(target, { clientX: x + dx, clientY: 200, isPrimary: true, button: 0 });
    fireEvent.click(target, { clientX: x + dx, clientY: 200, button: 0 });
  });
}

function stepText(): Element {
  const now = document.querySelector('[data-role="now"] p');
  if (!now) throw new Error("no current step");
  return now;
}

describe("CookFlow: tap zones", () => {
  it("goes back from the left third and on from the rest, one move per tap", () => {
    const { onNext, onBack } = flow(SECOND);
    stage();
    tapAt(stepText(), 100);
    expect(onBack).toHaveBeenCalledTimes(1);
    tapAt(stepText(), 600);
    expect(onNext).toHaveBeenCalledTimes(1);
    expect(onBack).toHaveBeenCalledTimes(1);
  });

  it("turns the page on the click, so the click never lands on the page it drew", () => {
    const { onNext } = flow(SECOND);
    stage();
    act(() => {
      fireEvent.pointerDown(stepText(), { clientX: 600, clientY: 200, isPrimary: true });
      fireEvent.pointerUp(stepText(), { clientX: 600, clientY: 200, isPrimary: true });
    });
    expect(onNext).not.toHaveBeenCalled();
    act(() => {
      fireEvent.click(stepText(), { clientX: 600, clientY: 200 });
    });
    expect(onNext).toHaveBeenCalledTimes(1);
    // A click with no press on the stage before it (a key on a focused control) is no tap.
    act(() => {
      fireEvent.click(stepText(), { clientX: 600, clientY: 200 });
    });
    expect(onNext).toHaveBeenCalledTimes(1);
  });

  it("leaves a press on the scrollbar to the scrollbar", () => {
    const { onNext } = flow(SECOND);
    const el = stage();
    tapAt(el, 895);
    expect(onNext).not.toHaveBeenCalled();
    tapAt(el, 880);
    expect(onNext).toHaveBeenCalledTimes(1);
  });

  it("takes a drag or a held press for something else", () => {
    const { onNext } = flow(SECOND);
    stage();
    tapAt(stepText(), 600, { dx: TAP_SLOP + 20 });
    tapAt(stepText(), 600, { ms: TAP_MS + 100 });
    expect(onNext).not.toHaveBeenCalled();
  });

  it("forgets a press the browser takes over for a scroll", () => {
    const { onNext } = flow(SECOND);
    const el = stage();
    act(() => {
      fireEvent.pointerDown(stepText(), { clientX: 600, clientY: 200, isPrimary: true });
      fireEvent.pointerCancel(el, { isPrimary: true });
      fireEvent.pointerUp(stepText(), { clientX: 600, clientY: 200, isPrimary: true });
      fireEvent.click(stepText(), { clientX: 600, clientY: 200 });
    });
    expect(onNext).not.toHaveBeenCalled();
  });

  it("never finishes on the last screen, however long it has been up", () => {
    const { onNext, onBack, onFinish } = flow(LAST);
    stage();
    now += FINISH_ARM_MS * 2;
    tapAt(stepText(), 600);
    expect(onNext).not.toHaveBeenCalled();
    expect(onFinish).not.toHaveBeenCalled();
    tapAt(stepText(), 100);
    expect(onBack).toHaveBeenCalledTimes(1);
  });

  it("does nothing on Prep, whose rows are the job", () => {
    const { onNext, onBack } = flow(PREP);
    stage();
    expect(PREP.onPrep).toBe(true);
    tapAt(document.querySelector('[data-role="now"]')!, 600);
    expect(onNext).not.toHaveBeenCalled();
    expect(onBack).not.toHaveBeenCalled();
  });

  it("turns the page from a prep page as from any step, and a tap on a tick row is its tick", () => {
    const { onNext, onTick } = flow(PREP_PAGE);
    stage();
    expect(PREP_PAGE.onPrep).toBe(false);
    const rows = [...document.querySelectorAll<HTMLElement>("[data-prep-rows] > [data-row]")];
    expect(rows.map((r) => r.dataset.row)).toEqual(["onion", "scape", "zuc"]);
    // A tap on a row's words ticks it and turns nothing.
    tapAt(rows[1]!.querySelector("p")!, 600);
    expect(onTick).toHaveBeenCalledTimes(1);
    expect(onTick).toHaveBeenLastCalledWith("scape");
    expect(onNext).not.toHaveBeenCalled();
    // Its tile ticks it too, once.
    tapAt(within(rows[0]!).getByRole("checkbox"), 600);
    expect(onTick).toHaveBeenCalledTimes(2);
    expect(onTick).toHaveBeenLastCalledWith("onion");
    expect(onNext).not.toHaveBeenCalled();
    // Off the rows, the stage turns the page.
    tapAt(document.querySelector("[data-prep-eyebrow]")!, 600);
    expect(onNext).toHaveBeenCalledTimes(1);
    expect(onTick).toHaveBeenCalledTimes(2);
  });

  it("turns the page from a prep page of one job by a tap on its words", () => {
    const { onNext, onBack } = flow(PREP_PAGE_2);
    stage();
    tapAt(stepText(), 600);
    expect(onNext).toHaveBeenCalledTimes(1);
    tapAt(stepText(), 100);
    expect(onBack).toHaveBeenCalledTimes(1);
  });

  it("waits while a modal or panel is open", () => {
    const { onNext } = flow(SECOND, { navEnabled: false });
    stage();
    tapAt(stepText(), 600);
    expect(onNext).not.toHaveBeenCalled();
  });

  it("drops a press when a panel opens before the finger lifts", () => {
    const { onNext, rerender } = flow(SECOND);
    stage();
    act(() => {
      fireEvent.pointerDown(stepText(), { clientX: 600, clientY: 200, isPrimary: true });
    });
    rerender("ready", false);
    act(() => {
      fireEvent.pointerUp(stepText(), { clientX: 600, clientY: 200, isPrimary: true });
      fireEvent.click(stepText(), { clientX: 600, clientY: 200 });
    });
    expect(onNext).not.toHaveBeenCalled();
  });

  it("leaves a press that closes a popover to the popover", () => {
    const { onNext } = flow(SECOND);
    stage();
    const popover = mount(`<div data-holds-keys>2 tbsp is 30 ml</div>`);
    tapAt(stepText(), 600);
    expect(onNext).not.toHaveBeenCalled();
    popover.remove();
    tapAt(stepText(), 600);
    expect(onNext).toHaveBeenCalledTimes(1);
  });

  it("leaves the amount pairs and the row above the steps to themselves", () => {
    const { onNext } = flow(SECOND);
    stage();
    const pair = document.querySelector('[data-role="now"] li');
    expect(pair).not.toBeNull();
    tapAt(pair!, 600);
    const above = document.querySelector("[data-stage] > [data-no-tap] p");
    expect(above).not.toBeNull();
    tapAt(above!, 600);
    expect(onNext).not.toHaveBeenCalled();
  });
});

describe("the foot", () => {
  // The first cooking step, past the prep pages.
  let onStep = initialCookState("first");
  for (let i = 0; i < ZUCCHINI_PAGES; i++) onStep = next(ZUCCHINI_PLAN, onStep);
  const ON_STEP = cookView(ZUCCHINI_PLAN, { kind: "derived" }, onStep);

  function band(): HTMLElement {
    return screen.getByRole("button", { name: COOK_COPY.back }).closest<HTMLElement>("[data-foot]")!;
  }

  it("puts the foot in one row below the stage (V4)", () => {
    flow(ON_STEP);
    expect(band().hasAttribute("data-foot")).toBe(true);
    expect(band().closest("[data-stage]")).toBeNull();
    // The ends share what's left, the middle centred; never under their controls.
    expect(band().className).toContain("grid-cols-[minmax(max-content,1fr)_auto_minmax(max-content,1fr)]");
    expect(band().className).not.toContain("absolute");
  });

  it("keeps Back, the well and Forward, and nothing of Ask Sous: its capsule is in the top line (v1.60)", () => {
    flow(ON_STEP, { voice: { mode: "tap", status: "ready", echo: null, onTap: vi.fn() } });
    expect(screen.queryByRole("button", { name: "Ask Sous" })).toBeNull();
    expect(band().querySelector("[data-voice]")).toBeNull();
    expect(band().querySelector("[data-ask-bar], [data-ask-capsule]")).toBeNull();
    expect([...band().querySelectorAll("button")].map((b) => b.getAttribute("aria-label"))).toEqual([
      COOK_COPY.back,
      COOK_COPY.forward,
    ]);
    // The middle's cell stays, empty, so the forward keeps its own track.
    const middle = band().querySelector("[data-foot-middle]")!;
    expect(middle.childElementCount).toBe(0);
    expect(middle.getAttribute("aria-hidden")).toBe("true");
    const back = screen.getByRole("button", { name: COOK_COPY.back });
    const forward = screen.getByRole("button", { name: COOK_COPY.forward });
    expect(back.compareDocumentPosition(middle) & Node.DOCUMENT_POSITION_FOLLOWING).toBeTruthy();
    expect(middle.compareDocumentPosition(forward) & Node.DOCUMENT_POSITION_FOLLOWING).toBeTruthy();
  });

  it("gives the stage's right side to Ask's side panel, and the foot's with it (v1.60)", () => {
    flow(ON_STEP);
    const stage = document.querySelector<HTMLElement>("[data-stage]")!;
    expect(stage.parentElement!.className.split(/\s+/)).toContain("mr-[var(--ask-room,0px)]");
    // Back and Forward stand under the step: the panel runs to the screen's bottom beside them.
    expect(band().className.split(/\s+/)).toContain("mr-[var(--ask-room,0px)]");
  });

  describe("what the voice heard floats over the foot's middle (P63 (a))", () => {
    const heard = (echo: VoiceProps["echo"], status: VoiceProps["status"] = "listening"): VoiceProps => ({
      mode: "always",
      status,
      echo,
      onTap: vi.fn(),
    });

    it("lifts the phrase over the row on Paper with its hairline", () => {
      flow(ON_STEP, { voice: heard({ kind: "unknown", heard: "sue flip it" }) });
      const line = band().querySelector<HTMLElement>("[data-heard]");
      expect(line?.textContent).toBe("Didn't catch “sue flip it”");
      // Out of the row's tracks, so the row never refits for it.
      expect(line?.parentElement).toBe(band());
      // DS §1's lifted surface: Paper, a hairline of ink at 11%, no shadow.
      expect(line?.className).toContain("bg-paper");
      expect(line?.className).toContain("border-ink/[.11]");
      expect(line?.className).not.toMatch(/shadow/);
      // Never in the way of a tap, and said once, by the voice's own live region.
      expect(line?.className).toContain("pointer-events-none");
      expect(line?.getAttribute("aria-hidden")).toBe("true");
    });

    it("lifts nothing at rest: listening with nothing heard", () => {
      flow(ON_STEP, { voice: heard(null) });
      expect(band().querySelector("[data-heard]")).toBeNull();
    });

    it("lifts nothing while Ask is open: Ask's own line says what was heard", () => {
      flow(ON_STEP, { voice: heard({ kind: "unknown", heard: "sue flip it" }), askOpen: true });
      expect(band().querySelector("[data-heard]")).toBeNull();
    });

    it("lifts nothing while Whole recipe holds the screen: its ledge says what was heard", () => {
      flow(ON_STEP, { voice: heard({ kind: "unknown", heard: "sue flip it" }), restInert: true });
      expect(band().querySelector("[data-heard]")).toBeNull();
    });

    it("lifts nothing while the opening shows, where the foot steps aside", () => {
      flow(ON_STEP, { voice: heard({ kind: "unknown", heard: "sue flip it" }), opening: { onStart: vi.fn() } });
      expect(band().querySelector("[data-heard]")).toBeNull();
    });

    it("lifts nothing where the browser can't listen", () => {
      flow(ON_STEP, { voice: heard({ kind: "unknown", heard: "sue flip it" }, "unsupported") });
      expect(band().querySelector("[data-heard]")).toBeNull();
    });
  });
});

describe("CookFlow: the lookahead and the chapter marker", () => {
  const DERIVED: PlanSource = { kind: "derived" };
  // A 30-minute sauté leaves the cook's hands free before the parathas.
  const LONG_SAUTE = {
    ...ZUCCHINI_PLAN,
    tasks: ZUCCHINI_PLAN.tasks.map((t) =>
      t.id === "saute" ? { ...t, minutes: { est: 30, handsOff: true } } : t,
    ),
  };

  function at(plan: typeof ZUCCHINI_PLAN, mode: "first" | "go", presses: number): CookView {
    let state: CookState = initialCookState(mode);
    for (let i = 0; i < presses; i++) state = next(plan, state);
    return cookView(plan, DERIVED, state);
  }

  const line = (role: string) =>
    document.querySelector<HTMLElement>(`[data-line][data-role="${role}"]`)!;
  it("draws now alone on the stage, keeping its full text", () => {
    const view = at(ZUCCHINI_PLAN, "first", 1);
    flow(view);
    expect(line("now").querySelector("p")!.textContent).toBe(bindNumbers(view.stack[0].text));
    expect(document.querySelector('[data-role="next"]')).toBeNull();
    expect(document.querySelector('[data-role="after"]')).toBeNull();
  });

  it("draws no peek under Prep", () => {
    const view = at(LONG_SAUTE, "go", 0);
    expect(view.onPrep).toBe(true);
    flow(view);
    expect(document.querySelector("[data-prep]")).not.toBeNull();
    expect(document.querySelector('[data-role="next"]')).toBeNull();
  });

  it("draws no peek under a prep page, and no Prep screen", () => {
    const view = at(LONG_SAUTE, "first", 0);
    expect(view.onPrep).toBe(false);
    flow(view);
    expect(document.querySelector("[data-prep]")).toBeNull();
    expect(document.querySelector("[data-prep-rows]")).not.toBeNull();
    expect(document.querySelector('[data-role="next"]')).toBeNull();
  });
});

describe("CookFlow: fitting the stage", () => {
  const DERIVED: PlanSource = { kind: "derived" };
  // 75 words, with no number to bind: sentences end after the 25th, the
  // 60th and the last.
  const word = (i: number) => `w${String.fromCharCode(97 + Math.floor(i / 26))}${String.fromCharCode(97 + (i % 26))}`;
  const LONG = Array.from({ length: 75 }, (_, i) =>
    i === 24 || i === 59 || i === 74 ? `${word(i)}.` : word(i),
  ).join(" ");
  // Sauté takes 30 minutes hands free, so it has meta and the fry under it
  // opens a chapter (a marker).
  const SAUTE = ZUCCHINI_PLAN.tasks.map((t) =>
    t.id === "saute" ? { ...t, minutes: { est: 30, handsOff: true } } : t,
  );

  /**
   * The screen `presses` in, as I go or first, with its current step made
   * long. In Prep first `presses` counts from the last prep page (DS v1.59),
   * as it counted from the Prep screen: 1 is the first cooking step.
   */
  function longAt(mode: "first" | "go", presses: number): CookView {
    const view = (tasks: typeof SAUTE) => {
      const plan = { ...ZUCCHINI_PLAN, tasks };
      let state: CookState = initialCookState(mode);
      const skip = mode === "first" && presses > 0 ? prepPages(plan, "first").length - 1 : 0;
      for (let i = 0; i < presses + skip; i++) state = next(plan, state);
      return cookView(plan, DERIVED, state);
    };
    const key = view(SAUTE).stack[0].key;
    return view(SAUTE.map((t) => (t.id === key ? { ...t, text: LONG } : t)));
  }

  // A stand-in for layout. The stack sits 60 px down the stage; its lines
  // stack 20 px apart. Now's text at 40 px sets 10 words to a 50 px line,
  // scaled with its size (0.9: 11 words, 45 px; 0.8: 12 words, 40 px); the
  // cue adds 30 px, a later part's head 35 at full size, and the meta 40 when shown, or, when a test sets
  // `pairHeight`, the minutes line 20 and each amount pair shown that tall
  // (a pair to a line, as on a narrow column). A glance
  // is 35 px, a marker 20.
  let stage = { height: 380, width: 800 };
  let pairHeight = 0;
  function metaHeight(el: HTMLElement): number {
    const meta = el.querySelector("[data-meta]");
    if (!shown(meta)) return 0;
    if (pairHeight === 0) return 40;
    const pairs = [...meta.querySelectorAll("[data-pairs] > li")].filter(shown).length;
    return (shown(meta.querySelector("[data-time]")) ? 20 : 0) + pairs * pairHeight;
  }
  // happy-dom's elements inherit their layout getters from its own
  // HTMLElement, not the window's: find the prototype that holds each one.
  const own = new Map<string, [object, PropertyDescriptor]>();
  const define = (name: string, get: (el: HTMLElement) => number) => {
    let proto: object | null = Object.getPrototypeOf(document.createElement("div"));
    while (proto && !Object.prototype.hasOwnProperty.call(proto, name)) {
      proto = Object.getPrototypeOf(proto);
    }
    if (!proto) throw new Error(`no ${name} to stand in for`);
    own.set(name, [proto, Object.getOwnPropertyDescriptor(proto, name)!]);
    Object.defineProperty(proto, name, {
      configurable: true,
      get(this: HTMLElement) {
        return get(this);
      },
    });
  };
  const shown = (el: Element | null): el is HTMLElement =>
    el instanceof HTMLElement && !el.hidden;
  const fontSize = (el: HTMLElement) => parseFloat(el.style.fontSize) || 40;
  // Prep's blocks stack with no gap: a mise row (a tick) is 60 px, any other
  // row, a heading or a fold line 40, each times the size Prep is set at; the
  // time line 30 at any size (the meta's, which the fit never steps down);
  // the toggle takes no room, and a note `noteHeight` (none, unless a test
  // says).
  let noteHeight = 0;
  function prepBlock(el: Element): number {
    if (el.closest("[hidden]")) return 0;
    const scale = Number(el.closest<HTMLElement>("[data-prep]")?.dataset.fit ?? 1);
    if (el.matches("[data-times]")) return 30;
    if (el.matches("li")) return (el.querySelector('[role="checkbox"]') ? 60 : 40) * scale;
    if (el.matches("[data-notes] > p, [data-prep-scale-note]")) return noteHeight;
    return el.matches("h3, [data-fold]") ? 40 * scale : 0;
  }
  function heightOf(el: HTMLElement): number {
    if (el.dataset.role === "marker") return 20;
    const prep = el.querySelector("[data-prep]");
    if (prep) {
      return [
        ...prep.querySelectorAll(
          "[data-times], [data-prep-scale-note], li, h3, [data-fold], [data-notes] > p",
        ),
      ].reduce((h, b) => h + prepBlock(b), 0);
    }
    const face = el.querySelector<HTMLElement>("[data-face]");
    if (!face) return 0;
    if (face.dataset.face === "glance") return 35;
    const scale = fontSize(el) / 40;
    const text = face.textContent ?? "";
    const words = text === "" ? 0 : text.split(" ").length;
    const lines = Math.ceil(words / Math.floor(10 / scale));
    const head = shown(el.querySelector("[data-head]")) ? 35 * scale : 0;
    return head + lines * 50 * scale + (shown(el.querySelector("[data-cue]")) ? 30 : 0) + metaHeight(el);
  }
  const isLine = (el: Element) =>
    el instanceof HTMLElement && el.matches("[data-line]") && el.style.display !== "none";
  // The tokens the fit reads in px (`lengthPx`), as this stand-in resolves
  // them: a step's foot (`--space-5`) 40 px and the closed gap above next
  // (`--space-4`) 24, the numbers the fits below are worked in.
  const TOKEN_PX: Record<string, number> = { "var(--space-5)": 40, "var(--space-4)": 24 };

  type Observed = () => void;
  let observers: Observed[] = [];

  beforeEach(() => {
    stage = { height: 380, width: 800 };
    pairHeight = 0;
    noteHeight = 0;
    observers = [];
    fonts.status = "loaded";
    vi.stubGlobal(
      "ResizeObserver",
      class {
        constructor(private readonly cb: Observed) {
          observers.push(cb);
        }
        observe() {}
        disconnect() {
          observers = observers.filter((o) => o !== this.cb);
        }
      },
    );
    define("clientHeight", (el) => (el.matches("[data-stage]") ? stage.height : 0));
    define("clientWidth", (el) => (el.matches("[data-stage]") ? stage.width : 0));
    define("offsetHeight", (el) =>
      el.matches("[data-line]") || el.style.visibility === "hidden" ? heightOf(el) : 0,
    );
    define("offsetTop", (el) => {
      if (el.matches("[data-mise] > li")) {
        let top = 0;
        for (let prev = el.previousElementSibling; prev; prev = prev.previousElementSibling) {
          top += prepBlock(prev);
        }
        return top;
      }
      if (el.querySelector(":scope > [data-line]")) return 60;
      if (!el.matches("[data-line]")) return 0;
      let top = 0;
      for (let prev = el.previousElementSibling; prev; prev = prev.previousElementSibling) {
        if (isLine(prev)) top += (prev as HTMLElement).offsetHeight + 20;
      }
      return top;
    });
    const computed = window.getComputedStyle.bind(window);
    vi.spyOn(window, "getComputedStyle").mockImplementation((el, pseudo) => {
      const style = computed(el, pseudo);
      const token = TOKEN_PX[(el as HTMLElement).style.width];
      return new Proxy(style, {
        get(target, key) {
          if (key === "fontSize") return `${fontSize(el as HTMLElement)}px`;
          if (key === "width" && token !== undefined) return `${token}px`;
          if (key === "fontWeight") return "500";
          const value: unknown = Reflect.get(target, key);
          return typeof value === "function" ? value.bind(target) : value;
        },
      });
    });
  });

  afterEach(() => {
    // Unmount while the stand-in still answers, then put layout back.
    cleanup();
    for (const [name, [proto, descriptor]] of own) Object.defineProperty(proto, name, descriptor);
    own.clear();
    vi.unstubAllGlobals();
  });

  function fitted(
    view: CookView,
    {
      times,
      resumePart,
      resumeWidth,
      onPart,
      recipe,
      servings,
      onServings,
    }: {
      times?: string[];
      resumePart?: number;
      resumeWidth?: number;
      onPart?: (part: number, width: number) => void;
      recipe?: { serves_base: number; serves_estimated?: true };
      servings?: number;
      onServings?: (n: number) => void;
    } = {},
  ) {
    const handlers = { onNext: vi.fn(), onBack: vi.fn(), onFinish: vi.fn(), onTick: vi.fn() };
    const nav = createRef<CookFlowNav>();
    const el = (v: CookView) => (
      <CookFlow
        view={v}
        mode="first"
        times={times}
        ingredients={ZUCCHINI_INGREDIENTS}
        recipe={recipe}
        servings={servings}
        onServingsChange={onServings}
        onMode={vi.fn()}
        onAskAhead={vi.fn()}
        finish="ready"
        navEnabled
        navRef={nav}
        resumePart={resumePart}
        resumeWidth={resumeWidth}
        onPart={onPart}
        {...handlers}
      />
    );
    const result = render(el(view));
    return { ...handlers, nav, rerender: (v: CookView) => result.rerender(el(v)) };
  }

  const line = (role: string) =>
    document.querySelector<HTMLElement>(`[data-line][data-role="${role}"]`)!;
  const nowText = () => line("now").querySelector("[data-face]")!.textContent;
  const meta = () => line("now").querySelector<HTMLElement>("[data-meta]")!;
  const hiddenLines = () =>
    [...document.querySelectorAll<HTMLElement>("[data-line]")]
      .filter((el) => el.style.display === "none")
      .map((el) => el.dataset.role);

  it("keeps a step that fits whole at full size", () => {
    stage.height = 600;
    fitted(longAt("first", 1));
    expect(nowText()).toBe(LONG);
    expect(line("now").style.fontSize).toBe("");
    expect(line("now").querySelector("[data-cue]")).toBeNull();
    expect(line("now").querySelector("[data-head]")).toBeNull();
    expect(meta().hidden).toBe(false);
    expect(hiddenLines()).toEqual([]);
  });

  it("steps now up on a tall stage", () => {
    stage.height = 700;
    const { rerender } = fitted(longAt("first", 1));
    expect(line("now").style.fontSize).toBe("44px");
    expect(hiddenLines()).toEqual([]);
    stage.height = 800;
    rerender(longAt("first", 1));
    act(() => observers.forEach((o) => o()));
    expect(line("now").style.fontSize).toBe("48px");
    expect(hiddenLines()).toEqual([]);
    expect(line("now").parentElement!.style.paddingBottom).toBe("var(--space-5)");
  });

  it("steps now down through STEP_FIT_SCALES (0.9 → 0.5) and tightens vertical chrome below 0.8 without paging", () => {
    stage.height = 500;
    const { rerender, onNext, nav } = fitted(longAt("first", 1));
    const stack = line("now").parentElement!;
    const stageTop = () => document.querySelector<HTMLElement>("[data-stage-top]")!;
    expect(line("now").style.fontSize).toBe("36px");
    expect(stageTop().style.display).toBe("");
    expect(stack.style.paddingBottom).toBe("var(--space-5)");

    stage.height = 430;
    rerender(longAt("first", 1));
    act(() => observers.forEach((o) => o()));
    expect(line("now").style.fontSize).toBe("32px");
    expect(stageTop().style.display).toBe("");
    expect(stack.style.paddingBottom).toBe("var(--space-5)");

    // Below 0.8, [data-stage-top] closes, paddingBottom drops to TIGHT_FOOT (8px),
    // and meta spacing tightens while keeping the entire step text and all pairs on one screen.
    stage.height = 380;
    rerender(longAt("first", 1));
    act(() => observers.forEach((o) => o()));
    expect(line("now").style.fontSize).toBe("28px");
    expect(stageTop().style.display).toBe("none");
    expect(stack.style.paddingBottom).toBe("8px");
    expect(meta().style.paddingTop).toBe("4px");
    expect(meta().querySelector<HTMLElement>("[data-time]")?.style.marginBottom).toBe("2px");
    expect(nowText()).toBe(LONG);
    expect(meta().hidden).toBe(false);
    expect(meta().querySelectorAll("[data-pairs] > li")).toHaveLength(4);
    expect(screen.queryByRole("button", { name: COOK_COPY.forwardMore })).toBeNull();
    expect(screen.getByRole("button", { name: COOK_COPY.forward })).toBeTruthy();

    stage.height = 230;
    rerender(longAt("first", 1));
    act(() => observers.forEach((o) => o()));
    expect(line("now").style.fontSize).toBe("24px");
    expect(nowText()).toBe(LONG);

    stage.height = 170;
    rerender(longAt("first", 1));
    act(() => observers.forEach((o) => o()));
    expect(line("now").style.fontSize).toBe("20px");
    expect(nowText()).toBe(LONG);

    // Even below the 0.5 floor, the step stays whole at 20px (0.5×) and advances in one press.
    stage.height = 120;
    rerender(longAt("first", 1));
    act(() => observers.forEach((o) => o()));
    expect(line("now").style.fontSize).toBe("20px");
    expect(nowText()).toBe(LONG);
    expect(nav.current!.part()).toBeNull();
    expect(nav.current!.forward()).toBe(false);
    expect(nav.current!.back()).toBe(false);

    press(document.body, "ArrowRight");
    expect(onNext).toHaveBeenCalledTimes(1);
  });

  it("labels an inline mise step with the Prep eyebrow and omits it on cooking steps", () => {
    stage.height = 600;
    // In "go" mode, press 1 is saute ("cook") and press 2 is greens ("mise").
    const cookStep = cookView(ZUCCHINI_PLAN, DERIVED, next(ZUCCHINI_PLAN, initialCookState("go")));
    expect(cookStep.stack[0]!.kind).toBe("cook");
    const { rerender } = fitted(cookStep);
    expect(line("now").querySelector("[data-mise-eyebrow]")).toBeNull();

    const miseStep = cookView(
      ZUCCHINI_PLAN,
      DERIVED,
      next(ZUCCHINI_PLAN, next(ZUCCHINI_PLAN, initialCookState("go"))),
    );
    expect(miseStep.stack[0]!.kind).toBe("mise");
    rerender(miseStep);
    const eyebrow = line("now").querySelector<HTMLElement>("[data-mise-eyebrow]");
    expect(eyebrow).not.toBeNull();
    expect(eyebrow!.textContent).toBe(COOK_COPY.prepChapter);
    // As I go's eyebrow is the word alone: no place, no dish (those are Prep first's prep pages').
    expect(eyebrow!.hasAttribute("data-prep-eyebrow")).toBe(false);
    expect(line("now").querySelector("[data-prep-rows]")).toBeNull();
  });

  describe("a prep page (Prep first, DS v1.59)", () => {
    const eyebrow = () => line("now").querySelector<HTMLElement>("[data-prep-eyebrow]")!;
    const rows = () => [...line("now").querySelectorAll<HTMLElement>("[data-prep-rows] > [data-row]")];

    it("heads a page of one job with Prep, its place and its dish, over the job as the step's words, its time and its amounts", () => {
      stage.height = 600;
      fitted(PREP_PAGE_2);
      expect(PREP_PAGE_2.now!.rows).toBeUndefined();
      expect(eyebrow().textContent).toBe(`${COOK_COPY.prepChapter} · ${bindNumbers("2 of 2")} · Filling`);
      // "Prep" in ink 600, the rest in the eyebrow's ink-soft 500, at the chip's size.
      const word = eyebrow().firstElementChild!;
      expect(word.textContent).toBe(COOK_COPY.prepChapter);
      expect(word.className.split(/\s+/)).toEqual(expect.arrayContaining(["font-semibold", "text-ink"]));
      expect(eyebrow().className.split(/\s+/)).toEqual(
        expect.arrayContaining(["text-[length:var(--type-chip)]", "font-medium", "text-ink-soft"]),
      );
      expect(nowText()).toBe("Chop the onion greens");
      expect(rows()).toEqual([]);
      const meta = line("now").querySelector<HTMLElement>("[data-meta]")!;
      // Its time, and "assumed" (the recipe doesn't list the job), as on any step.
      expect(meta.querySelector("[data-time]")!.textContent).toBe(
        `${bindNumbers(PREP_PAGE_2.now!.minutes!)}${COOK_COPY.assumed}`,
      );
      expect([...meta.querySelectorAll("[data-pairs] > li")].map((li) => li.textContent)).toEqual([
        `a handful of onion greens (${COOK_COPY.asWritten})`,
      ]);
    });

    it("sets a page of several small jobs as tick rows, each with its minutes and its amounts, its time in the eyebrow", () => {
      stage.height = 600;
      fitted(PREP_PAGE);
      const view = PREP_PAGE.now!;
      expect(eyebrow().textContent).toBe(
        [COOK_COPY.prepChapter, ...prepEyebrow(view).map(bindNumbers)].join(" · "),
      );
      // The recipe lists none of these jobs: "assumed" once, for the page, and on no row.
      expect(eyebrow().textContent).toMatch(/^Prep · 1.of.2 · Filling · about.5.minutes · assumed$/);
      expect(line("now").querySelector("[data-row-assumed]")).toBeNull();
      // Rows where a step has its words: no step text, no meta of its own.
      expect(line("now").querySelector("p[data-face]")).toBeNull();
      expect(line("now").querySelector("[data-meta]")).toBeNull();
      expect(line("now").querySelector("[data-prep-rows]")!.getAttribute("data-face")).toBe("rows");
      expect(rows().map((r) => r.querySelector("p")!.textContent)).toEqual([
        "Slice the onion bulb",
        "Mince the garlic scape",
        "Cut the zucchini into thin matchsticks",
      ]);
      expect(rows().map((r) => r.querySelector("[data-row-minutes]")!.textContent)).toEqual(
        ["2 min", "1 min", "2 min"].map(bindNumbers),
      );
      expect(rows().map((r) => [...r.querySelectorAll("[data-row-pairs] > li")].map((li) => li.textContent))).toEqual([
        ["1 onion bulb"],
        ["1 garlic scape"],
        ["2 zucchini"],
      ]);
      // Each tick is named by its row's words.
      const boxes = screen.getAllByRole("checkbox");
      expect(boxes).toHaveLength(3);
      expect(screen.getByRole("checkbox", { name: "Mince the garlic scape" })).toBe(boxes[1]);
      expect(boxes.map((b) => b.getAttribute("aria-checked"))).toEqual(["false", "false", "false"]);
    });

    it("draws a ticked row done, its words in ink-soft, and the tick on the tile", () => {
      stage.height = 600;
      const ticked = toggleTick(ZUCCHINI_PLAN, initialCookState("first"), "scape");
      const { onTick } = fitted(cookView(ZUCCHINI_PLAN, DERIVED, ticked));
      const [onion, scape] = rows();
      expect(within(scape!).getByRole("checkbox").getAttribute("aria-checked")).toBe("true");
      expect(within(scape!).getByRole("checkbox").className.split(/\s+/)).toEqual(
        expect.arrayContaining(["bg-ink", "text-paper"]),
      );
      expect(scape!.hasAttribute("data-done")).toBe(true);
      expect(scape!.querySelector("p")!.className.split(/\s+/)).toContain("text-ink-soft");
      expect(onion!.hasAttribute("data-done")).toBe(false);
      expect(onion!.querySelector("p")!.className.split(/\s+/)).toContain("text-ink");
      fireEvent.click(scape!.querySelector("p")!);
      expect(onTick).toHaveBeenCalledWith("scape");
    });

    it("opens a row's amount on its conversions, and the tap is not the row's tick", () => {
      stage.height = 600;
      const grams: RecipeForPlan = {
        ...ZUCCHINI_RECIPE,
        ingredients: ZUCCHINI_RECIPE.ingredients!.map((line, i) =>
          i === 1 ? { amount: "200", unit: "g", item: "onion" } : line,
        ),
      };
      const handlers = { onNext: vi.fn(), onBack: vi.fn(), onFinish: vi.fn(), onTick: vi.fn() };
      render(
        <CookFlow
          view={PREP_PAGE}
          mode="first"
          ingredients={linesOf("Zucchini in grams", grams)}
          onMode={vi.fn()}
          onAskAhead={vi.fn()}
          finish="ready"
          navEnabled
          {...handlers}
        />,
      );
      const amount = within(rows()[0]!).getByRole("button", { name: "200 g onion" });
      expect(amount.className).toContain(AMOUNT_RULE);
      expect(amount.getAttribute("aria-expanded")).toBe("false");
      fireEvent.click(amount);
      expect(amount.getAttribute("aria-expanded")).toBe("true");
      expect(document.querySelector("[data-holds-keys]")?.textContent).toContain(COOK_COPY.conversionsHeading);
      expect(handlers.onTick).not.toHaveBeenCalled();
      expect(handlers.onNext).not.toHaveBeenCalled();
    });

    it("fits a page of rows by the step's ladder, the rows' words sized against the step's", () => {
      stage.height = 600;
      fitted(PREP_PAGE);
      const words = rows()[0]!.querySelector("p")!;
      // The words hold the chip's size down to the ladder's 0.7 (0.67 of the
      // step's size there), between the meta floor and the chip's size.
      expect(words.className.split(/\s+/)).toContain(
        "text-[length:clamp(var(--type-meta),0.67em,var(--type-chip))]",
      );
      // A row steps down with the step, and is never taller than a target for want of words.
      expect(rows()[0]!.className.split(/\s+/)).toContain("min-h-[min(1.25em,var(--target))]");
      expect(document.querySelector<HTMLElement>("[data-stage]")!.className.split(/\s+/)).toContain("overflow-y-auto");
    });

    it("lets a row's amounts go with the step's meta under the look-ahead's sheet, their line with them", () => {
      fitted(PREP_PAGE);
      const amounts = rows()[0]!.querySelector<HTMLElement>("[data-row-pairs]")!;
      // They fade with the meta (`--look-meta`, 1 at rest to 0 as the sheet rises)...
      expect(amounts.style.opacity).toBe("var(--look-meta, 1)");
      // ...and a line of them dropped under the words gives its 36 px back, half each way.
      expect(amounts.style.marginBlock).toBe("calc((var(--look-meta, 1) - 1) * 18px)");
    });
  });

  it("arms Finish on the last step as soon as FINISH_ARM_MS has elapsed", () => {
    stage.height = 380;
    let presses = 0;
    while (!longAt("first", presses).isLast) presses++;
    const { nav } = fitted(longAt("first", presses));
    expect(nav.current!.finishable()).toBe(false);
    now += FINISH_ARM_MS;
    expect(nav.current!.finishable()).toBe(true);
  });

  describe("Prep renders in full and scrolls the stage when tall", () => {
    function prepAt(
      mode: "first" | "go",
      ticked: string[] = [],
      plan: typeof ZUCCHINI_PLAN = ZUCCHINI_PLAN,
    ): CookView {
      const view = cookView(plan, DERIVED, { ...initialCookState(mode), ticked: new Set(ticked) });
      expect(view.onPrep).toBe(true);
      return view;
    }
    const peek = () => {
      const ahead = document.querySelectorAll('[data-line]:not([data-role="now"])');
      return ahead.length === 0 ? null : ahead;
    };
    const boxes = () => screen.queryAllByRole("checkbox");
    const rowsShown = () =>
      [...document.querySelectorAll<HTMLElement>("[data-mise] > [data-row]")].map(
        (li) => li.querySelector("p")!.textContent,
      );
    const rotate = (height: number) => {
      stage.height = height;
      act(() => observers.forEach((o) => o()));
    };

    it("keeps a foot of 16 under Prep, where a step keeps the space-5 token", () => {
      stage.height = 491;
      const { rerender } = fitted(prepAt("go"));
      const stack = line("now").parentElement!;
      expect(stack.style.paddingBottom).toBe("16px");
      expect(peek()).toBeNull();
      rerender(cookView(ZUCCHINI_PLAN, DERIVED, { ...initialCookState("go"), pos: 1 }));
      expect(stack.style.paddingBottom).toBe("var(--space-5)");
      // A prep page is a step: it keeps a step's foot.
      rerender(PREP_PAGE);
      expect(stack.style.paddingBottom).toBe("var(--space-5)");
    });

    it("renders all rows in full without [data-fold] even on a tight stage, keeping data-stage scrollable", () => {
      stage.height = 146;
      fitted(prepAt("go"));
      expect(peek()).toBeNull();
      expect(boxes()).toHaveLength(3);
      expect(document.querySelector("[data-fold]")).toBeNull();
      expect(document.querySelector<HTMLElement>("[data-prep]")!.dataset.fit).toBe("1");
      expect(line("now").style.fontSize).toBe("");
      const stageEl = document.querySelector<HTMLElement>("[data-stage]")!;
      expect(stageEl.className.split(/\s+/)).toContain("overflow-y-auto");
    });

    it("has no Prep screen in Prep first for a plan with prep to do: its jobs are prep pages (DS v1.59)", () => {
      // Before that slice this screen listed all four jobs here, the movable
      // one under an "or while…" pill; they are the two prep pages now.
      stage.height = 600;
      const view = cookView(ZUCCHINI_PLAN, DERIVED, initialCookState("first"));
      expect(view.onPrep).toBe(false);
      expect(view.prep).toBeNull();
      fitted(view);
      expect(document.querySelector("[data-prep]")).toBeNull();
      expect(document.querySelector("[data-mise]")).toBeNull();
      expect(rowsShown()).toEqual([]);
      expect(boxes()).toHaveLength(3);
    });

    it("sets the ticks as hairline tiles, sand only while pressed, and heads the list with Before you start in As I go (V9)", () => {
      const tokens = (el: Element) => el.className.split(/\s+/);
      const atRest = (el: Element) => tokens(el).filter((t) => !t.startsWith("active:"));
      stage.height = 600;
      const tickedView = prepAt("go", ["onion"]);
      const { rerender } = fitted(tickedView);
      expect(screen.queryByRole("group", { name: COOK_COPY.modeGroup })).toBeNull();

      const [ticked, ...open] = boxes();
      expect(ticked.getAttribute("aria-checked")).toBe("true");
      expect(atRest(ticked)).toEqual(expect.arrayContaining(["bg-ink", "text-paper"]));
      for (const b of open) {
        expect(tokens(b)).toEqual(expect.arrayContaining(["border", "border-ink-soft", "active:bg-sand"]));
        expect(atRest(b).filter((t) => t.startsWith("bg-"))).toEqual([]);
      }

      const goView = prepAt("go");
      rerender(goView);
      const goHead = document.querySelector<HTMLElement>("[data-before-head]");
      expect(goHead).not.toBeNull();
      expect(goHead!.textContent).toContain(COOK_COPY.beforeYouStart);
      expect(goHead!.textContent).toContain(bindNumbers(goView.stack[0]!.minutes!));
      // Mandatory upfront items in As I go have no "or while…" pill.
      expect(rowsShown()).toEqual([
        "Slice the onion bulb",
        "Mince the garlic scape",
        "Cut the zucchini into thin matchsticks",
      ]);
    });

    it("says the recipe's time line at its head and keeps it on tight stages (T2)", () => {
      stage.height = 180;
      fitted(prepAt("go"), { times: ["1 h 10 ·", "25 min hands-on"] });
      const times = document.querySelector<HTMLElement>("[data-times]")!;
      expect(times.closest("[data-prep]")!.firstElementChild).toBe(times);
      expect(times.textContent).toBe("1 h 10 · 25 min hands-on");
      expect(times.className.split(/\s+/)).toEqual(
        expect.arrayContaining(["text-[length:var(--type-meta)]", "text-ink-soft"]),
      );
    });

    it("draws no time line when there is nothing to say", () => {
      stage.height = 600;
      fitted(prepAt("go"));
      expect(document.querySelector("[data-times]")).toBeNull();
    });

    it("keeps the serving stepper, scaled Prep note, and bottom notes visible at all stage heights (B5c-3, B5c-4)", () => {
      noteHeight = 40;
      stage.height = 160;
      fitted(prepAt("go"), {
        recipe: { serves_base: 4 },
        servings: 8,
        onServings: vi.fn(),
      });
      expect(document.querySelector("[data-serving-stepper]")).not.toBeNull();
      expect(document.querySelector("[data-prep-scale-note]")).not.toBeNull();
      expect(document.querySelector("[data-notes]")).not.toBeNull();
      expect(screen.getByText(COOK_COPY.allAssumed)).toBeTruthy();
      expect(screen.getByText(COOK_COPY.nothingAhead)).toBeTruthy();

      rotate(120);
      expect(document.querySelector("[data-serving-stepper]")).not.toBeNull();
      expect(document.querySelector("[data-prep-scale-note]")).not.toBeNull();
      expect(document.querySelector("[data-notes]")).not.toBeNull();
    });

    it("renders all 'As you cook' rows in full without paging or folding", () => {
      const view = prepAt("go");
      const greens = view.prep!.mise.find((m) => m.id === "greens")!;
      const extra = ["a", "b", "c"].map((s) => ({ ...greens, id: `greens-${s}`, text: `${greens.text} ${s}` }));
      const longer = { ...view, prep: { ...view.prep!, mise: [...view.prep!.mise, ...extra] } };
      stage.height = 200;
      fitted(longer);
      const laterRegion = screen.getByRole("region", { name: COOK_COPY.laterHeading });
      const items = [...laterRegion.querySelectorAll("li")].map((li) => li.textContent);
      expect(items).toEqual([
        `Chop the onion greens\u2002${bindNumbers("while you sauté")}`,
        `Chop the onion greens a\u2002${bindNumbers("while you sauté")}`,
        `Chop the onion greens b\u2002${bindNumbers("while you sauté")}`,
        `Chop the onion greens c\u2002${bindNumbers("while you sauté")}`,
      ]);
      expect(boxes()).toHaveLength(3);
      expect(document.querySelector("[data-fold]")).toBeNull();
    });

    it("opens one make-ahead group at a time with all its work items and keeps the other groups and mise visible", () => {
      const ahead = (id: string, label: string, lead: string) => ({
        ...ZUCCHINI_PLAN.tasks[0],
        id,
        kind: "ahead" as const,
        text: `${label} ahead`,
        label,
        lead,
      });
      const plan = {
        ...ZUCCHINI_PLAN,
        tasks: [
          ahead("soak", "soak chickpeas", "the night before"),
          ahead("rinse", "rinse beans", "the night before"),
          ahead("brine", "brine chicken", "overnight"),
          ahead("chill", "chill dough", "an hour before"),
          ...ZUCCHINI_PLAN.tasks,
        ],
      };
      const ask = () =>
        within(document.querySelector<HTMLElement>("[data-stage]")!).queryAllByRole("button", {
          name: /Ask Sous$/,
        });
      stage.height = 196;
      fitted(prepAt("go", [], plan));
      const soak = screen.getByRole("button", { name: /^the night before/ });
      expect(soak.textContent).toBe("the night before: soak chickpeas; rinse beans");
      expect(ask()).toHaveLength(0);
      expect(boxes()).toHaveLength(3);

      fireEvent.click(soak);
      expect(soak.getAttribute("aria-expanded")).toBe("true");
      expect(soak.querySelector("[data-labels]")!.className).toBe("sr-only");
      expect(screen.getByText("soak chickpeas ahead")).toBeTruthy();
      expect(screen.getByText("rinse beans ahead")).toBeTruthy();
      expect(ask()).toHaveLength(1);
      // Other ahead groups and all mise checkboxes stay visible when a group opens.
      expect(screen.getByRole("button", { name: /^overnight: brine chicken/ })).toBeTruthy();
      expect(screen.getByRole("button", { name: /^an hour before: chill dough/ })).toBeTruthy();
      expect(boxes()).toHaveLength(3);
      expect(document.querySelector("[data-fold]")).toBeNull();

      const heading = soak.closest("h3")!;
      expect(heading.nextElementSibling).toBe(ask()[0]);
      expect(heading.className.split(/\s+/)).not.toContain("flex-1");
      expect(heading.parentElement!.className.split(/\s+/)).not.toContain("justify-between");

      const brine = screen.getByRole("button", { name: /^overnight/ });
      fireEvent.click(brine);
      expect(soak.getAttribute("aria-expanded")).toBe("false");
      expect(brine.getAttribute("aria-expanded")).toBe("true");
      expect(screen.queryByText("soak chickpeas ahead")).toBeNull();
      expect(screen.getByText("brine chicken ahead")).toBeTruthy();
      expect(ask()).toHaveLength(1);
    });
  });
});

// Slice B5a (A7, A8, A10): the timer on the cook screen, and who has the ember.
describe("CookFlow: timers", () => {
  const T0 = Date.now();
  const offer = {
    id: "q1:step-1",
    queueId: "q1",
    recipeName: "Sweet Zucchini Wraps",
    stepId: "step-1",
    label: "Saute zucchini",
    durationMs: 300_000,
    durationSec: 300,
  };
  const running = { ...offer, endsAtEpochMs: T0 + 300_000 };
  const other = { ...offer, id: "q1:step-0", stepId: "step-0", label: "Soak rice", endsAtEpochMs: T0 + 60_000 };

  function timers(over: Partial<CookTimers> = {}): CookTimers {
    return {
      offer,
      stepTimer: null,
      ledge: [],
      expired: [],
      soonestRunning: null,
      soundLocked: false,
      onStart: vi.fn(),
      onDismiss: vi.fn(),
      onAllowSound: vi.fn(),
      ...over,
    };
  }

  it("offers the step's timer where its time was, and the step keeps the ember", () => {
    const t = timers();
    flow(SECOND, { timers: t });
    const start = screen.getByRole("button", { name: "Start 5 min timer" });
    // A ghost: no ring, no fill at rest (the cook screen keeps its ghosts).
    expect(start.className).toContain("text-ink-soft");
    expect(start.className).not.toContain("before:border");
    expect(stepText().className).toContain("ember-700");
    fireEvent.click(start);
    expect(t.onStart).toHaveBeenCalledOnce();
  });

  it("gives a running clock the ember: the step's words go ink", () => {
    flow(SECOND, { timers: timers({ stepTimer: running, soonestRunning: running.id }) });
    expect(stepText().className).toContain("text-ink");
    expect(stepText().className).not.toContain("text-ember-700");
    const digits = screen.getByRole("timer").querySelector("[aria-hidden]")!;
    expect(digits.className).toContain("text-ember");
  });

  it("says sound off at the stage's top, not in the foot, while the clocks are in the well", () => {
    flow(SECOND, { timers: timers({ ledge: [other], soonestRunning: other.id, soundLocked: true }) });
    const line = document.querySelector("[data-sound-line]")!;
    expect(line.textContent).toBe(TIMER_COPY.soundOff);
    expect(document.querySelector("[data-foot]")!.textContent).not.toContain(TIMER_COPY.soundOff);
  });

  it("puts a timer whose step isn't on screen in the foot's well, named, ember when it is the soonest", () => {
    flow(SECOND, { timers: timers({ ledge: [other], soonestRunning: other.id }) });
    const ledge = document.querySelector("[data-foot] [data-ledge]")!;
    expect(ledge.textContent).toContain("Soak rice");
    expect(ledge.querySelector("[aria-hidden]")!.className).toContain("text-ember");
    expect(stepText().className).toContain("text-ink");
    // The well sits with back, so the middle's ghosts never move for it.
    expect(ledge.parentElement!.querySelector(`[aria-label="${COOK_COPY.back}"]`)).not.toBeNull();
  });

  it("shows a second timer in the well with its own digits, never a count badge", () => {
    const third = { ...other, id: "q1:step-3", label: "Rest dough", endsAtEpochMs: T0 + 90_000 };
    flow(SECOND, { timers: timers({ ledge: [other, third], soonestRunning: other.id }) });
    const well = document.querySelector("[data-ledge]")!;
    expect(well.querySelectorAll('[role="timer"]')).toHaveLength(2);
    expect(well.textContent).toContain("Soak rice");
    expect(well.textContent).toContain("Rest dough");
    expect(well.textContent).not.toContain("+1");
  });

  it("on the last step, gives the ember to the unstarted offer and leaves Finish ink (2026-10-03)", () => {
    flow(LAST, { timers: timers({ offer }) });
    expect(screen.getByRole("button", { name: "Start 5 min timer" }).className).toContain("bg-ember");
    expect(finishButton().className).not.toContain("bg-ember");
    expect(finishButton().className).toContain("bg-sand");
  });

  it("on the last step with the timer running, gives Finish the ember back and the clock goes ink", () => {
    flow(LAST, { timers: timers({ offer, stepTimer: running, soonestRunning: running.id }) });
    expect(finishButton().className).toContain("bg-ember");
    expect(screen.getByRole("timer").querySelector("[aria-hidden]")!.className).toContain("text-ink");
  });

  it.each([
    ["the Prep screen", PREP],
    ["a prep page's tick row", PREP_PAGE],
  ])("stops a ringing timer with a tap on a control, and the control does nothing: %s (B5a verify, M1)", (_name, view) => {
    const done = { ...other, endsAtEpochMs: T0 - 1000 };
    const t = timers({ offer: null, expired: [done] });
    const onTick = vi.fn();
    render(
      <CookFlow
        view={view}
        mode="first"
        ingredients={ZUCCHINI_INGREDIENTS}
        onMode={vi.fn()}
        onTick={onTick}
        onAskAhead={vi.fn()}
        finish="ready"
        navEnabled
        timers={t}
        onNext={vi.fn()}
        onBack={vi.fn()}
        onFinish={vi.fn()}
      />,
    );
    const tick = screen.getAllByRole("checkbox")[0]!;
    fireEvent.click(tick);
    expect(t.onDismiss).toHaveBeenCalledTimes(1);
    expect(t.onDismiss).toHaveBeenCalledWith(done.id);
    expect(onTick).not.toHaveBeenCalled();
  });

  it("on the last step once its timer has rung and been stopped, gives Finish the ember (B5a verify, H2)", () => {
    flow(LAST, { timers: timers({ offer, done: true }) });
    expect(screen.getByText(/timer done/)).toBeTruthy();
    expect(finishButton().className).toContain("bg-ember");
    expect(finishButton().className).not.toContain("bg-sand");
  });

  it("makes a ringing timer the stage's subject: the step steps back, Finish waits", () => {
    const done = { ...other, endsAtEpochMs: T0 - 1000 };
    const t = timers({ offer: null, expired: [done] });
    flow(LAST, { timers: t });
    expect(finishButton().className).not.toContain("bg-ember");
    expect(stepText().className).toContain("text-ink-soft");
    const band = screen.getByRole("button", { name: /Soak rice timer/ });
    expect(band.hasAttribute("data-alarm-band")).toBe(true);
    expect(band.textContent).toContain("Done");
    fireEvent.click(band);
    expect(t.onDismiss).toHaveBeenCalledWith(done.id);
  });

  it("stops a ringing timer with a tap anywhere on the stage, and turns no page", () => {
    const done = { ...other, endsAtEpochMs: T0 - 1000 };
    const t = timers({ offer: null, expired: [done] });
    const { onNext } = flow(SECOND, { timers: t });
    tapAt(stepText(), 900);
    expect(t.onDismiss).toHaveBeenCalledWith(done.id);
    expect(onNext).not.toHaveBeenCalled();
  });

  it("says a step's timer is done once stopped, and offers it again", () => {
    const t = timers({ done: true });
    flow(SECOND, { timers: t });
    expect(screen.getByText("5 min timer done")).toBeTruthy();
    fireEvent.click(screen.getByRole("button", { name: "Start the 5 min timer again" }));
    expect(t.onStart).toHaveBeenCalledOnce();
  });

  it("says nothing of a timer on Prep's stack line, and keeps the step's minutes where it offers none", () => {
    flow(SECOND, { timers: timers({ offer: null }) });
    expect(screen.queryByRole("button", { name: /timer/ })).toBeNull();
  });

  it("says the stage's quiet lines above the step, once", () => {
    flow(SECOND, { notices: ["Saved timers couldn't be read and were reset."] });
    const lines = document.querySelector("[data-notices]")!;
    expect(lines.getAttribute("role")).toBe("status");
    expect(lines.textContent).toBe("Saved timers couldn't be read and were reset.");
  });

  it("renders quiet household marginalia when present on the step", () => {
    const withNote = {
      ...SECOND,
      stack: [
        {
          ...SECOND.stack[0]!,
          marginalia: "Oct 2026: less lemon next time",
        },
        ...SECOND.stack.slice(1),
      ],
    };
    flow(withNote);
    const note = document.querySelector("[data-marginalia]");
    expect(note).not.toBeNull();
    expect(note!.textContent).toContain("Oct 2026: less lemon next time");
  });
});

describe("CookFlow: the walk-away line on the step's meta (look-ahead slice 1, DS v1.62)", () => {
  it("says 'After this step: about 50 min free.' under the step's minutes, at the meta's size in ink-soft, and goes with the meta as the sheet rises", () => {
    // A cooking step that has both its minutes and its amounts, so the order below is checked, never skipped.
    const metaNow = () => document.querySelector<HTMLElement>('[data-role="now"] [data-meta]');
    let state = initialCookState("first");
    for (let i = 0; i < 40; i++) {
      cleanup();
      flow(cookView(ZUCCHINI_PLAN, { kind: "derived" }, state), { away: COOK_COPY.stepAwayMeta(50) });
      const m = metaNow();
      if (m?.querySelector("[data-time]") && m.querySelector("[data-pairs]")) break;
      state = next(ZUCCHINI_PLAN, state);
    }
    const meta = metaNow()!;
    const away = meta.querySelector<HTMLElement>("[data-step-away]")!;
    expect(away.textContent).toBe("After this step: about 50 min free.");
    expect(away.className.split(/\s+/)).toEqual(expect.arrayContaining(["text-[length:var(--type-meta)]", "text-ink-soft"]));
    expect(away.style.opacity).toBe("var(--look-meta, 1)");
    // Under the minutes, before the step's amounts.
    const time = meta.querySelector("[data-time]");
    const pairs = meta.querySelector("[data-pairs]");
    expect(time, "a step with minutes").not.toBeNull();
    expect(pairs, "a step with amounts").not.toBeNull();
    expect(time!.compareDocumentPosition(away) & Node.DOCUMENT_POSITION_FOLLOWING).toBeTruthy();
    expect(away.compareDocumentPosition(pairs!) & Node.DOCUMENT_POSITION_FOLLOWING).toBeTruthy();
  });

  it("is absent where it doesn't apply", () => {
    flow(SECOND);
    expect(document.querySelector("[data-step-away]")).toBeNull();
  });
});
