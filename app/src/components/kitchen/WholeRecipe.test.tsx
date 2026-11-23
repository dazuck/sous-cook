// @vitest-environment happy-dom
import { cleanup, fireEvent, render, screen } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";
import { cookView, initialCookState, miseBefore, next, sourceStepStates, toggleTick, type CookState } from "@/lib/kitchen/cook-view";
import { identityPlan, parseCookPlan, type CookPlan } from "@/lib/kitchen/cook-plan";
import { loadCookPlanFixtures, loadCookPlanSnapshots } from "@/lib/kitchen/__tests__/load-cook-plan-fixtures";
import { WholeRecipe, groupStepsByChapter, type WholeRecipeProps } from "./WholeRecipe";

afterEach(cleanup);

function corpus(name: string): { plan: CookPlan; steps: string[] } {
  const fixture = loadCookPlanFixtures().find((f) => f.name === name)!;
  const raw = loadCookPlanSnapshots().get(name)!.raw;
  const parsed = parseCookPlan(raw, fixture.recipe);
  if (!parsed.ok) throw new Error(`${name} did not parse`);
  return { plan: parsed.plan, steps: fixture.recipe.steps };
}

function props(plan: CookPlan, steps: string[], state: CookState, over: Partial<WholeRecipeProps> = {}): WholeRecipeProps {
  const st = sourceStepStates(plan, state);
  return {
    steps,
    plan,
    state,
    chapters: cookView(plan, { kind: "derived" }, state).chapters,
    current: st.current,
    done: st.done,
    prepLine: null,
    ingredients: [],
    usedIngredientIndices: new Set(),
    ingredientOverrides: new Map(),
    onToggleIngredient: () => {},
    read: null,
    onRead: () => {},
    screenFor: () => 1,
    onGo: () => {},
    asWritten: false,
    ...over,
  };
}

describe("WholeRecipe", () => {
  const roast = corpus("sunday-roast-dinner");

  it("groups the roast's steps by its stretches, in order, with a break divider between two (N2-5)", () => {
    const state = next(roast.plan, initialCookState("first"));
    const chapters = cookView(roast.plan, { kind: "derived" }, state).chapters!;
    expect(chapters.length).toBeGreaterThanOrEqual(3);
    const groups = groupStepsByChapter(roast.steps, roast.plan, state, chapters)!;
    expect(groups.length).toBeGreaterThanOrEqual(2);
    expect(groups.map((g) => g.chapter.id)).toEqual(chapters.filter((c) => c.id !== "prep" && groups.some((g) => g.chapter.id === c.id)).map((c) => c.id));
    // every step as written appears exactly once
    const all = groups.flatMap((g) => g.steps.map((s) => s.index)).sort((a, b) => a - b);
    expect(all).toEqual(roast.steps.map((_, i) => i));
    render(<WholeRecipe {...props(roast.plan, roast.steps, state)} />);
    expect(document.querySelectorAll("[data-chapter-head]")).toHaveLength(0);
    // A divider opens every group after the first, saying the break above it.
    const dividers = [...document.querySelectorAll("[data-free-divider]")];
    expect(dividers).toHaveLength(groups.length - 1);
    groups.slice(1).forEach((g, i) => {
      const group = document.querySelector(`[data-chapter-group="${g.chapter.id}"]`)!;
      expect(group.firstElementChild).toBe(dividers[i]);
      const free = groups[i].chapter.free!;
      expect(free.minutes % 5).toBe(0);
      expect(dividers[i].textContent).toBe(`about ${free.minutes} min free`);
      expect(dividers[i].className).toContain("text-ink-soft");
      expect(dividers[i].className).toContain("text-[length:var(--type-meta)]");
    });
  });

  it("on Prep, groups the steps as the cook will step through them: the grouping Next leaves (N2 verify round 2)", () => {
    // The chapters count the screens as the cook stands on leaving Prep
    // (`rowState`); in As I go leaving ticks the mise done before cooking and
    // recuts the steps, so the grouping must read those screens too, or a
    // divider sits a step early on Prep and moves on Next.
    const shape = (plan: CookPlan, steps: string[], s: CookState) => {
      const chapters = cookView(plan, { kind: "derived" }, s).chapters;
      return groupStepsByChapter(steps, plan, s, chapters)?.map((g) => ({
        free: g.chapter.free?.minutes ?? null,
        steps: g.steps.map((x) => x.index),
      })) ?? null;
    };
    let checked = 0;
    let grouped = 0;
    for (const fixture of loadCookPlanFixtures()) {
      const parsed = parseCookPlan(loadCookPlanSnapshots().get(fixture.name)!.raw, fixture.recipe);
      if (!parsed.ok) continue;
      const { plan } = parsed;
      const steps = fixture.recipe.steps;
      for (const mode of ["first", "go"] as const) {
        const open = initialCookState(mode);
        if (!cookView(plan, { kind: "derived" }, open).onPrep) continue;
        const states = [open];
        const early = [...miseBefore(plan, mode)][0];
        if (early !== undefined) {
          const ticked = toggleTick(plan, open, early);
          states.push(ticked, toggleTick(plan, ticked, early));
        }
        for (const s of states) {
          const onPrep = shape(plan, steps, s);
          expect(onPrep, `${fixture.name} ${mode}`).toEqual(shape(plan, steps, next(plan, s)));
          checked += 1;
          if (onPrep !== null) grouped += 1;
        }
      }
    }
    expect(checked).toBeGreaterThan(0);
    expect(grouped).toBeGreaterThan(0);
  });

  it("draws no divider with a single stretch: no break, nothing to say", () => {
    const plan = identityPlan({ steps: ["One.", "Two.", "Three."] });
    const state = initialCookState("first");
    const chapters = cookView(plan, { kind: "derived" }, state).chapters;
    render(<WholeRecipe {...props(plan, ["One.", "Two.", "Three."], state, { chapters })} />);
    expect(document.querySelectorAll("[data-free-divider]")).toHaveLength(0);
    expect([...document.querySelectorAll("[data-step-text]")].map((e) => e.textContent)).toEqual(["One.", "Two.", "Three."]);
  });

  it("marks the step in hand You're here, in ember, and the ones behind done", () => {
    let state = initialCookState("first");
    for (let i = 0; i < 5; i++) state = next(roast.plan, state);
    render(<WholeRecipe {...props(roast.plan, roast.steps, state)} />);
    const here = document.querySelector('[data-state="current"]')!;
    expect(here.querySelector("[data-you-are-here]")!.textContent).toBe("You're here");
    expect(here.querySelector("[data-step-text]")!.className).toContain("text-ember-700");
    expect(document.querySelectorAll('[data-state="done"]').length).toBeGreaterThan(0);
  });

  it("a touched row opens Go to this step; Go goes to the screen that cites it", () => {
    const onGo = vi.fn();
    const onRead = vi.fn();
    const state = next(roast.plan, initialCookState("first"));
    const { rerender } = render(<WholeRecipe {...props(roast.plan, roast.steps, state, { onRead })} />);
    fireEvent.click(screen.getAllByRole("button", { name: /Carve the chicken/ })[0]);
    expect(onRead).toHaveBeenCalledWith(roast.steps.length - 1);
    rerender(<WholeRecipe {...props(roast.plan, roast.steps, state, { read: roast.steps.length - 1, screenFor: () => 7, onGo })} />);
    fireEvent.click(screen.getByRole("button", { name: "Go to this step" }));
    expect(onGo).toHaveBeenCalledWith(7);
  });

  it("a step no screen cites gets no Go pill: never a jump to another screen", () => {
    const state = next(roast.plan, initialCookState("first"));
    render(<WholeRecipe {...props(roast.plan, roast.steps, state, { read: 3, screenFor: () => null })} />);
    expect(screen.queryByRole("button", { name: "Go to this step" })).toBeNull();
  });

  it("as written there are no dividers, and every step stands in order", () => {
    const plan = identityPlan({ steps: ["One.", "Two.", "Three."] });
    const state = initialCookState("first");
    render(<WholeRecipe {...props(plan, ["One.", "Two.", "Three."], state, { asWritten: true, chapters: null })} />);
    expect(document.querySelectorAll("[data-free-divider]").length).toBe(0);
    expect([...document.querySelectorAll("[data-step-text]")].map((e) => e.textContent)).toEqual(["One.", "Two.", "Three."]);
  });

  it("sets every word at or above the meta's 22 cpx: no px sizes under it, no text-sm or text-xs", () => {
    const state = next(roast.plan, initialCookState("first"));
    const { container } = render(<WholeRecipe {...props(roast.plan, roast.steps, state, { read: 2 })} />);
    const classes = [...container.querySelectorAll("*")].map((e) => e.getAttribute("class") ?? "").join(" ");
    expect(classes).not.toMatch(/\btext-(xs|sm|base|lg)\b/);
    expect(classes).not.toMatch(/text-\[(1\d|2[01])px\]/);
  });
});
