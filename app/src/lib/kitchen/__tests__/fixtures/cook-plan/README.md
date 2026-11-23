# Cook-plan eval corpus

Labelled recipes for the derived cook plan (`cook-plan.ts`,
`cook-plan-derive.ts`). The scorer (`cook-plan-scorer.ts`) measures a derived
plan against these labels, and the eval gate in
the repo's `design/cook-lookahead-brief.md` is computed from them, so the labels
define what "correct" means. Mixed conventions silently move the gate.

Each `*.json` is:

```jsonc
{
  "description": "what this recipe stresses",
  "prepStyles": ["front-loaded" | "inline" | "implied", ...],
  // Exactly one of:
  "recipe": { "ingredients": [{ "item": "onion", "amount": "1" }], "steps": ["..."] },
  "recipeFrom": "apple-sweet-potato-puree", // a step-ingredients fixture, reused verbatim
  "gold": {
    "ahead": [{ "what": "soak the chickpeas", "ingredients": [0], "steps": [0] }],
    "mise": [2, 3, 4],       // ingredient indices with mise work on the day
    "handsOffSteps": [3, 5]  // source steps that contain a hands-off stretch
  }
}
```

Two sets of the model's output sit beside the labels. Both are generated, not
labelled.

- `gate/` holds the eval script's snapshots under the shipped prompt, scored
  offline by `cook-plan-eval.test.ts`, which fails when the prompt, the
  thinking budget or a recipe changes without a re-run. A recipe borrowed from
  the step-ingredient corpus (`recipeFrom`) is derived and scored with that
  corpus's labelled mapping as its `stepIngredients`, the way an intake recipe
  reaches the derive (`gateRecipe`).
- `derived/` is the eval's set as of 2026-10-04, kept fixed: the layout tests
  (chapters, lanes, strip, timetable, cook view) cook these plans, read
  against the recipe without a mapping as they were made. A prompt change
  re-runs the eval into `gate/` and does not move these tables. Split when the cook-fidelity plan
  changed the prompt (DECISIONS 2026-10-26).

In `derived/`, one is hand-edited: in `derived/chewy-oat-cookies.json` the leads of
`soften-butter` ("1 hour before" → "at least 3 hours before") and
`room-temp-eggs` ("30 minutes before" → "at least 2½ hours before") were
rewritten to count back from the start of the cook, as the `lead-order` rule
now requires (DECISIONS 2026-10-04, make-ahead lead order): each is its own
wait added to the dough's "at least 2 hours", which is what Prep shows for the
plan as the model wrote it. Its hashes were left as they were: the model wrote
everything else under that prompt and recipe. The next live eval replaces it
(`app/KNOWN-ISSUES.md`, the deferred lead prompt).

**The snapshot as the model wrote it fails the eval gate.** `lead-order`
rejects it, so the corpus scores 14 of 15 plans valid and ahead recall 0.625
against a gate of 1. The hand-edit is what keeps the gate green. In the app a
rejected derivation gets one re-ask carrying the rule; whether that re-ask
recovers plans like this one is unmeasured until the live re-eval after slice V.

Every recipe here was written for the tests. No imported web text.

## Prep styles

The tag records how the recipe as written handles prep, so the corpus covers
each:

- **front-loaded**: explicit prep steps before the cooking ("Dice the onion").
- **inline**: prep written into the middle of the cooking ("Meanwhile, slice
  the radish").
- **implied**: prep only named in the ingredient lines ("2 cloves garlic,
  minced") or assumed by a step ("add the chopped onion"), never stated.

## Labelling rules

### Ahead

A task is **ahead** when it needs an unattended stretch of **30 minutes or
more that must be finished before cooking starts**, or when the recipe says to
do it the day before. Soaking, marinating, dry-brining, chilling dough,
cooking and chilling rice, softening butter, bringing eggs or meat to room
temperature, and thawing all qualify.

- **Long waits mid-cook are not ahead.** Simmer 1 hour, roast 50 minutes and a
  chile soak that follows toasting all happen during the cook, and the
  scheduler fits other work inside them.
- **Waits under 30 minutes are not ahead.** A 15-minute marinade or a
  20-minute quick pickle is mise with a hands-off stretch.
- **Everything upstream of ahead work is ahead.** The marinade mixed for an
  overnight marinade, and the dough made to be chilled, are ahead too.
- **Ingredient lines imply ahead work.** "Butter, softened", "eggs, at room
  temperature", "rice, cooked and chilled overnight" and "shrimp, thawed" each
  imply an ahead task with no source step.

Gold ahead is a list of **items**, one per piece of ahead work the cook must
not miss. Each item has anchor `ingredients` and the source `steps` that state
it (`[]` when the item is implied). Anchors are disjoint across a recipe's
items, and so are steps.

A derived ahead task **finds** an item when:

- it cites a source step, and that step is one of the item's `steps`; or
- it is implied, and it touches one of the item's anchor `ingredients`.

So a stated item is found by the task that cites it, and an implied item only
by an implied task. A task that cites a step for work the recipe never states
("soften the butter" citing the creaming step) misses the implied item: the UI
would then link to a step that never says it, with no "assumed" mark.

### Mise

An ingredient is **mise** when, on the day, it gets work before it is combined
or heated:

- **cut**: slice, dice, chop, mince, julienne, score, trim, halve, shred,
  quarter, tear;
- **other single-ingredient work**: peel, core, seed, grate, zest, juice into
  a measure, crush, beat (eggs), rinse, drain, pat dry, break up (cold rice),
  brew (coffee);
- **a separate mix**: whisked or stirred in its own bowl and later added to
  the main pan or bowl, or served alongside the dish, as a unit (a sauce,
  dressing, raita, slurry, pickle brine, dry mix, wet mix, or a marinade of
  under 30 minutes). Every ingredient in the mix is mise. When two mixes are
  combined (wet into dry), both are mise and the combining step is cook.

Not mise:

- **Heat is cook.** Toasting, charring, blanching, and anything in a pan or
  oven.
- **The main build is cook.** The step that brings mixes together, and each
  step in the main pan or bowl, are cook even with no heat.
- **Seasoning a protein just before it cooks is cook.** Salt that rests
  30 minutes or more is a dry brine (ahead); under 30 minutes it is a
  marinade (mise).
- **Work at the moment of use is cook.** Squeezing a lemon over the plate
  happens when the ingredient is added. An ingredient line that names the
  work still wins (below).
- **Measuring alone is not mise.** Otherwise every ingredient would be.
- **Ahead work is not also mise.** Garlic grated into an overnight marinade is
  ahead. It is listed in `mise` only when it also gets separate work on the
  day.

An ingredient line that names the work ("garlic, minced", "chopped parsley",
"grated Parmesan", "shredded cabbage") counts as mise, stated or not. The
derived set is the union of every mise task's `ingredientIdx`.

### Hands-off steps

A source step is **hands-off** when it contains a stretch of **5 minutes or
more** where the cook's hands are free: the food needs at most occasional
stirring or a single turn.

- Simmer, roast, bake, steam, pressure-cook, rest, chill, soak and marinate
  all qualify, and so do preheating an oven and bringing water to a boil.
- "Sauté 10 minutes, stirring now and then" qualifies. "Stir-fry 3 minutes"
  does not.
- "4 minutes per side" is 8 minutes with a single turn, so it qualifies.
- A "meanwhile" or "while it cooks" in the next step is a strong tell that
  the step before it is hands-off.

Ahead steps count too: soaking overnight is hands-off. The derived set is the
source steps cited by tasks with `minutes.handsOff`. Implied hands-off tasks
cite no step and are not scored.

### Step ingredients

No label of their own: a recipe with a mapping (the 8 `recipeFrom` recipes)
is scored against it. Per step, the derived set is every ingredient the tasks
citing that step list, whatever their kind; the gold set is the step's mapping.
A step whose work moved to Prep is cited by its mise task, which shows its
ingredients there. Implied tasks cite no step and are not scored.

## Scoring an invalid plan

A plan that fails `parseCookPlan` is scored as `identityPlan(recipe)`, which is
what the cook would get: no ahead, no mise, no hands-off. Its gold counts as
missed. Excluding invalid plans would inflate every other metric.

## When a label is ambiguous

Resolve it the way the Prep screen should behave, then add the case here, so
the convention stays single-valued.
