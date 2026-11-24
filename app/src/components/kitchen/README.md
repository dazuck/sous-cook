# Kitchen Components

UI components optimized for cooking mode - large touch targets, high contrast, kitchen-friendly interactions.

## CookFlow

The cook view: a Prep screen, then the recipe's steps as a lookahead stack (the step you're on alone on the stage, with the bottom look-ahead sheet unfolding upcoming steps up to the whole cook). It renders the pure model from `src/lib/kitchen/cook-view.ts`; all state lives in the session reducer (`src/lib/kitchen/cook-session.ts`), so the component only draws and reports taps.

- **Prep screen** (`PrepScreen.tsx`): ahead work that should already have happened, grouped by lead time with one "Missed it? Ask Sous" per group (it opens the Ask panel with a question about the whole group in the box, for the cook to edit or send), the "Prep first | As I go" toggle, and the mise list with ticks. The toggle shows only here, and only until the cook moves on; Back from the first step, or the chart's Prep shade then Go, brings it back. It never scrolls: it folds to fit (the lookahead, "As you cook", ticked rows to "N done", rows past the edge to "N more"), measured through `CookFlow`'s `usePrepFit` (DS §5).
- **Top line** (`RecipeHeader.tsx`, slices V and N2): the eyebrow at the left, "**Name** · 4 steps, then about 50 min free", then More (`HeaderMore.tsx`) at the right, a ghost holding the flag, Recipe info, the other recipes in progress and the way out. The place is a ghost button that opens the whole cook's chart. Short of room it steps down a measured ladder (`placeRung`: its long form, then without "about", then the count alone) before the name truncates; the place itself never does, and More's cell keeps its width. No place as written, and none on the opening.
- **Stretches** (`lib/kitchen/cook-chapters.ts`): the cook's steps cut at breaks only, where the cook's hands come free for 10 idle minutes or more, with no cap on length. One derivation feeds the eyebrow, the chart, Whole recipe's dividers and the report's `chapterId` (`stretch:{key}`).
- **Opening** (`CookOpening.tsx`, N2-10): a cook of two or more step screens opens on the chart with the dish's name and its time line; Start (the one ember; Enter, Space or →) folds it to Now. A timer running from another recipe keeps its well beside Start; an alarm rings there and Start waits in sand.
- **Stack**: now alone on the stage at 40px (Figtree 600, from `md` up) with ingredient chips and measurement popovers under it. Its words hold the screen's one ember in ember-700 until something else claims it (`lib/kitchen/ember-holder.ts`: the Finish check on the last part, from B5 a live timer, which beats Finish), then fade to ink over 320 ms (instantly under reduced motion). Next and after have moved into the bottom look-ahead band; the stack displays the step in hand alone. The stack never scrolls. It fits by a fixed ladder (`lib/kitchen/fit-stack.ts`, measured in `CookFlow`'s `useFitStack`): stepping up to 1.2 or 1.1 when room allows, and down through 1.0, 0.9, 0.8 with reserve for the bottom look-ahead band; else the step pages at 0.8, cut at the last sentence that fits (else the last word). A part with more to come ends on "Continues ›" at a glance's size; a later part opens with the step's name, and a part of chips alone draws no empty band for its words. The part's place ("Part 1 of 2") is said to a screen reader only: the eyebrow's count is the one drawn counter. Forward reveals the rest in place, back turns back a part, and the meta stands under the last part.
- **Input**: Back/Next buttons, swipe, arrow keys and voice. Voice counts only what is said to Sous ("Sue, next", or "Sue" and then a bare command within 6s; grammar in `lib/kitchen/wake-word.ts`); the dot in the header shows it is listening and echoes what it heard, and a tap turns it off for this tablet. Spoken "next" or "back" over an open modal closes it instead of moving. Ask Sous is the capsule at the top line's right end (mic, words, camera; `AskCapsule.tsx`); its panel is beside the step on the tablet in landscape and a full sheet elsewhere (`useAskForm`, DS §5 Ask). Swipe and the arrows are off while a modal or Ask's sheet is open (beside the step they still move it), and also wait for a popover. On the last screen Next becomes a captioned "Done cooking" button, filled in ember, the screen's one, so it reads as the end rather than another step. No key or swipe finishes the cook: the button takes a tap, or a fresh Enter while focused, and voice takes "Sue, done" said on the last screen; either only 500ms after that screen appears (`useFinishArm`), so a double tap, a held Enter or a "done" meant for the step before can't end it. A finish that fails to save says so in the button's caption, and the button tries again. Back stays focusable on the first screen (`aria-disabled`, not `disabled`), so focus isn't dropped there.

Recipes without a derived plan run through `identityPlan(recipe)`, one card per recipe step, with a line saying why there is no prep plan. A recipe with no steps (an ingredients-only capture) has nothing to plan: it opens on "This recipe has no steps." with every ingredient under it, and the finish.

## CookSheet

The cook view's look-ahead (P58, slice N2; DS §5 "The look-ahead"): one sheet pulled up from the progress strip under the step, at three depths, Now, "Until you can step away" (the stretch in hand, to its break) and the whole cook's chart (stretches over their spans, breaks hatched, a touched bar read in a band at the top), with Whole recipe a borrowed screen under the chart.

- **Drawing** — `lib/kitchen/sheet-layout.ts`. `buildLayout` measures nothing itself: it takes the strip, the page's geometry and the step block's metrics (measured by `CookSheet`) and a text `measure` (canvas in the browser, a fixed-width fake in the units), and returns where every mark, name, lane name, the now line, the table's wall and the time to the table stand at each level, plus the four detents (the sheet's edge at each level). `frameAt` interpolates every element between the two levels around any depth, gating names so none ever crosses another word. The chart's head words and their give-way order, the read band's size ladder and the "every level on screen" rule live here.
- **Motion** — `lib/kitchen/sheet-motion.ts` (`SheetMotion`): the finger (pointer classify, rubber band, the last 8 samples' velocity), the release (`releaseLevel`, critically damped spring), glides (400/520 ms on the DS easing, the axis unfitting first on the way to Now), reduced motion (no finger-following, a 200 ms cross-fade) and the touch's claim for the swipe hook (held until the next touch, N3a). Framework-free and unit-tested with a fake clock.
- **CookSheet.tsx** — mounts the sheet's layer (`BorrowedChrome` framing it; its kind line and ledge fade in as the top line and foot leave, from depth 2.35), measures the page into a layout, and paints each frame onto element refs, so a pull costs no React render. It also draws the band (a named button), the nudge, the read band, the opening's words, and Whole recipe as a borrowed screen that cross-fades in over 200 ms. The step block itself stays in `CookFlow`'s stage; the sheet scales and fades it through its ref and the `--look-tone`/`--look-meta` variables.
- **Wiring** — `CookScreen` owns the level (never persisted), the reads, voice (N11's layer order) and the flag's `layers.level`/`read`; `CookFlow` passes the stage, stack, foot and the band's slot, the fit's scale and the nudge's room (`useFitStack`'s reserve).

## WholeRecipe

Whole recipe's method column (`WholeRecipe.tsx`), a borrowed screen under the chart: the ingredients (`IngredientRows` at 24 cpx), Prep, and every step as written grouped by stretch (`groupStepsByChapter`) with a break divider between two ("about 50 min free"; none as written), the step in hand its "You're here" row. A touched row reads in place with "Go to this step" (none for a step no screen cites). Modal while open: the rest of the cook is inert.

## IngredientRows

Reusable ingredients checklist component (`IngredientRows.tsx`):

- Renders amounts, units, and ingredient descriptions with custom fraction rendering.
- Supports tap-to-check scratchpad functionality (persisting across opens during a cook session).
- Supports interactive unit conversion popovers for volume and weight.

## BorrowedChrome

The standard layout shell (`BorrowedChrome.tsx`) for screens borrowed from the cook flow (such as `WholeRecipe`):

- **Kind header**: Distinctive sand header at the top naming the screen kind (e.g. "Whole recipe").
- **Content region**: Main scrollable body maintaining kitchen contrast and typography tokens.
- **Bottom ledge**: Full-width "Back to cooking" touch target at the bottom (minimum 48px height) for quick return to the active step.
- **Focus & keyboard**: Traps focus appropriately, handles Escape to return, and restores focus to the invoking trigger upon closing.

## Design System

These components follow the Sous design system:

- **Colors**: the DS tokens from `src/styles/tokens.css` as Tailwind utilities (`bg-paper`, `text-ink`, `text-ink-soft`, `bg-sand`, `bg-ember`); ember is spent once a screen
- **Touch targets**: Minimum 48px for interactive elements
- **Typography**: Figtree for everything actionable, Caprasimo for display (titles, big digits), both vendored in `src/styles/fonts.css`
- **Ground**: ink on paper, with no dark mode and no grey (DS §1); sand, not a shadow, separates content from the ground
