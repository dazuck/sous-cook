# Pack Format v0

The data format for a recipe pack: one JSON file per pack, plus two shared library files (techniques and doneness states) that a pack's steps refer to.

**Format version: 0.7** (changelog at the end of this file).

The schema as code is the `@sous/pack` package in `pack/`. `pack/src/index.ts` holds the parsers (`parsePack`, `parseRecipe`, `parseCommonsFile`, `parseStatesFile`) and the reference checks (`verifyPackRefs`, `verifyRecipeRefs`); `pack/src/media-file.ts` holds the publisher's check that a media ref names a real file; `pack/src/quantity.ts` is the reader of ingredient amounts. This document and that package describe one format: a change to either lands with the matching change to the other, with a version bump and a changelog line here. The files in `packs/` follow it.

Labels such as P19 name the change that introduced a rule. The schema's comments and tests use the same labels, and the changelog below says what each one is.

```
Pack Format v0 — JSON, one file per pack. Three content layers: CREATOR (the dish,
incl. creator-filmed critical-moment video), COMMONS (shared technique library,
platform namespace), STATE (visual/sensory doneness references).

pack file = the pack object, flat: { id, title, version, creator: {name, bio, voice_notes},
  kind ("creator" | "household"; absent = "creator". A household pack holds the
  household's own recipes: no cover, no price, never published),
  cover_ref (null = no cover yet), description,
  price_usd (null = unpriced draft; 0 = deliberately free), recipes[],
  sections[] (optional; the pack's chapters in display order:
  { title (non-empty), recipe_ids[] (non-empty; each a recipes[].id of this
  pack, and a recipe in at most one section, once) }; absent = one flat list
  in recipes[] order; a recipe in no section shows after the last one) } —
  never wrapped as { pack: {…}, recipes }.
recipes[]: {
  id, title, story,
  serves_base (positive number, required: every recipe has a serving count),
  serves_estimated (optional; only ever true: the source states no count and
  serves_base is Sous's estimate, shown as Sous's, never as the source's;
  absent = the source states it. A count scaled from an estimated base is
  still an estimate),
  time_active_min, time_total_min, tags[],
  ingredients[] and steps[]: either may be empty, never both,
  ingredients[]: { id, name,
    qty_canonical: { mass_g (preferred) and/or volume_ml, count,
      count_unit (optional { one, other }; both visible text, valid only with
      count; absent = the name carries any noun),
      range_max (optional positive number, valid only with exactly one of
      mass_g, volume_ml, count, greater than that low end, in its unit; a
      renderer that doesn't know the key must refuse the line),
      salt_type etc. — mass_g, volume_ml, count (and range_max) are amounts;
      every other key (salt_type, etc.) is a qualifier that never scales }
    — or, when the source gives no number, exactly one of: to_taste: true (the
    source says "to taste"), as_written: "<the source's amount and unit verbatim>"
    (a non-empty string; shown verbatim with an "as written" mark, never
    converted or scaled), unstated: true (the source gives no amount; the name
    alone). Each stands alone, never beside mass_g, volume_ml or count;
    salt_type may sit beside any of them,
    display_equivalents (imperial/metric, weight/volume — resolved at RENDER time,
    never stored as a single unit): an object keyed by system,
    { imperial?: { unit, amount, amount_max? }, metric?: { unit, amount, amount_max? } }
    — unit a non-empty string (whitespace and invisible format characters alone
    count as empty), amount a positive number, amount_max a positive number
    greater than amount, required on a hint whose line has range_max and refused
    otherwise; a system with no hint is absent, never null.
    Hints are the stated amount. A reader shows a hint's amount (and amount_max)
    times the serving multiplier, in the hint's unit, and converts from it. It
    never recomputes the shown number from qty_canonical, which carries the
    dimension, what scales, and the amount for a line with no hint.
    Which unit words a reader understands is the reader's table. Unknown keys
    pass through at both levels.
    scaling: "linear"|"fixed", prep, optional },
  steps[]: {
    id, type: "action"|"checkpoint"|"interlude"|"wait", title, text,
    ingredient_refs[] (ids used in THIS step, rendered with scaled quantities),
    timer_sec (nullable), parallel_ok (bool),
    media_ref (creator-filmed; reserve for the 1–2 critical moments of THIS dish;
    null = no creator film, the same as absent),
    technique_refs[] (ids in the commons namespace, e.g. "commons:chiffonade"),
    recommended_technique_ref (optional; one of THIS step's technique_refs — the
    commons help the creator chose to show by default; absent = no pick),
    state_refs[] (ids of doneness references, e.g. "state:golden-brown-roux"),
    coach_hints[] (what goes wrong here — also feeds Coach) },
  variations[]: { name, description, patch }, creator_notes[]
}
commons[] (platform-level, separate file, a JSON array): { id, name, description, media_ref } —
filmed once, referenced everywhere; NEVER generated per-recipe. id is the namespaced
string a technique_ref carries ("commons:chiffonade"); media_ref null = not yet filmed
(the filming backlog IS the set of null media_refs).
states[] (platform-level, separate file, a JSON array): { id, name, visual_ref,
sensory_notes (look/sound/smell) } — doubles as Coach's grounding vocabulary. id is the
namespaced string a state_ref carries ("state:golden-brown-roux"); visual_ref null =
described but not yet shot.
Rules: quantities canonical + render-time units (tap-to-flip, voice conversion free);
interludes/checkpoints render ADAPTIVELY (collapse when the taste graph shows the
household knows the technique); media are refs, never embedded; schema must
round-trip cleanly (pack → render → edit → pack).
Null: on a ref or a price, null means "authored, asset or decision pending"; absent and
null read the same. Library merges never overwrite a non-null ref with null. A pack
whose price_usd is null is not published.
Media refs: every non-null media ref (cover_ref, steps[].media_ref, commons[].media_ref,
states[].visual_ref) is a platform-root file path under /packs/media/ and names a file
that exists. The schema checks the path: it starts /packs/media/, every segment after
that is a name (never empty, "." or "..", so no trailing /), and it carries no
whitespace, control character, %, \, ? or # — "control character" including the
invisible format characters (Unicode Cf: ZWSP, ZWJ, RLO…). The publisher checks, symlinks resolved,
that it is a regular file under packs/media/ before a pack ships. Remote URLs are not
refs.
Help precedence: the creator picks what a step shows by default (media_ref,
recommended_technique_ref); the cook's preferences win over the pick. Help the
creator didn't pick (the library's film for any other technique_ref, help the
platform finds) is offered quietly — there when wanted, like tap-to-flip units,
never inserted into the step. A recommended technique that isn't filmed yet
shows nothing extra until it is.
```

## Derived layers

A derived layer is data a component computes from a recipe and stores beside it. It is never authored, never part of the pack file, and never written back into the recipe; it is not part of the pack's round trip, and a pack is complete without it. Deleting one loses nothing but the work of deriving it again. A derived layer may *refer* to a recipe's steps and ingredients, so this document names the ones that exist and what they rely on.

**CookPlan, version 4** (`app/src/lib/kitchen/cook-plan.ts`, stored in the app's `cook_plan` column, `app/drizzle/schema.ts`). The cook view's task graph: the recipe broken into tasks of three kinds — `ahead` (hours or a day before), `mise` (an ingredient transformed before it is combined or heated) and `cook` — each with its prerequisites (`needs`), optional minutes and whether they are hands-off, a doneness cue, a lead time for ahead work, and the component (`branch`) it builds. A model derives it; a scheduler (`cook-schedule.ts`) orders it. What it relies on from the recipe:

- **References are by position, not id.** A task's `sourceStep` is an index into the recipe's steps (null for a task the recipe assumed, marked `implied`), and `ingredientIdx` lists indices into its ingredients. A plan is only valid against the step and ingredient order it was derived from.
- **Every step is covered.** Validation rejects a whole plan that leaves a step uncovered, has a cook task citing no step, or loses a quantity a step states (a time or temperature among them); a rejected or missing plan falls back to one cook task per step, the recipe as written (`identityPlan`). Out-of-range ingredient indices are dropped rather than rejected.
- **A cook task keeps to its step's ingredients.** When the recipe says which ingredients each step uses (the queue recipe's `stepIngredients`: intake's or an import's mapping, or a pack's `steps[].ingredient_refs` as projected), the derivation is shown them, and validation rejects a plan with a cook task listing an ingredient its source step doesn't (`ingredient-outside-step`). Mise and ahead tasks are free: one readies an ingredient for whichever step uses it. A mapping that doesn't fit the recipe (another length, an index out of range) bounds nothing.
- **A lead has one anchor: the start of the cook.** An ahead task's lead ("overnight", "at least 2 hours before") says how long before the cook starts it is done, never how long before the task that uses it. So what an ahead task needs has a lead at least as long, and validation rejects a plan where a need's lead is shorter, when both leads name a time (`lead-order`). A lead names a time when it states a duration or "overnight", "a day", "a week", and its time is the shortest it allows; work on the cook's own day ("the morning of", "on the day") and an upper bound alone ("up to 2 days ahead", "up to overnight") name none, since neither says how long before the start it is done. An upper bound is a bound word followed directly by its wait, so "bring up to room temperature 1 hour before" names an hour; a holding time ("keeps", "will keep") is a bound too, and may have up to three holding words (covered, chilled, refrigerated, well…) or a parenthetical before its wait ("keeps, covered, 3 days"), never other words ("keeps well, at least 4 hours ahead" names 4 hours), since it says how long the work keeps, not how far ahead to do it. A bound covers the whole of a wait said in parts ("within 1 hour, 30 minutes before" names none). A wait said in parts is one wait wherever a bare comma joins a smaller unit to a larger, whatever follows ("at least 1 hour, 30 minutes at room temperature before" names 90 minutes), so it reads as its text without the comma; the one exception is a smaller part that is a part of the larger ("3 hours, 20 minutes of it uncovered" is 3 hours). A repeat ("2 x 4 hours before") names the count times each, 8 hours, and a ranged count its fewest rounds ("2-3 x 5 minutes before" names 10); a bound covers a repeat whole ("up to 2 x 4 hours before" names none); a cadence ("every 20 minutes") names nothing. A lead offering alternatives ("8 hours or overnight") names the shortest; if one alternative names no time ("a day ahead or the same day", "the day before or the morning of"), the lead names none, since it may be done on the day. A lead with no time is not compared, but the check reads through it: a need reached only through work with no readable lead is still compared with the dependent that has one. The cook view lists make-ahead work so that no task is above what it needs, and readable leads never get longer down the list except where a need forces it (a group goes as early as the longest readable lead it holds up). A plan stored before the rule, with a need's lead counted from its dependent, is not re-derived: a need whose readable lead is shorter shows the two added ("1 hour before" a dependent "at least 2 hours before" shows "at least 3 hours before"), counting from its nearest dependents with a readable lead, through any without one, as the check reads. The sum reads in minutes under an hour, in days when it is whole days ("3 days before"), else in hours rounded up to the quarter hour; a chain adds exact waits and rounds once, at the end. A rounded sum says "about" ("about 1¼ hours before" for 70 minutes), since the cook may start a little later than shown; an exact one says "at least" if either lead does. A need with no lead, or the same wait said differently by its direct dependent, shows its dependent's; a need whose lead can't be read keeps its words, with nothing to add, and still comes above its dependent. A shown lead is the recipe's words; "before" is added to a lead that stops at a time unit ("at least 4 hours", "a few hours"), except one about the cook's own day ("the same day", "a day ahead or the same day"), which would then read as a day ahead. Its wait is always read from the recipe's lead, never from the words shown. One shown lead is one group, unless one group would sit both above and below other work (work under another lead between its tasks, or two chains crossing), or tasks whose lead can't be read would, as one group, hold a shorter readable lead above a longer one; then the lead shows again further down. The derivation prompt still words a lead the old way ("how far ahead"). Until it is reworded, the parser's rejection carries the definition into the re-ask; the anchor is not fully in place until the prompt says it.
- **Stale plans re-derive.** The plan carries its version; a plan older than the current version is derived again rather than migrated (`isCurrentCookPlan`).
- **Conversion keeps it valid.** The app's converter from its own recipe shape onto this format (`app/src/lib/pack-convert/`) keeps steps 1:1 and ingredients in order, so a stored plan's indices still point at the same step and ingredient. Any change that splits, merges or reorders steps or ingredients must re-derive the plans it touches.

**Time summary** (`app/src/lib/kitchen/recipe-times.ts`; computed from a current CookPlan on read, never stored). The recipe's realistic time as the app shows it: the total is the plan's scheduled span with all the mise done first, the hands-on minutes are the tasks that aren't hands-off, and the ahead work is each ahead task's lead in the plan's words, never parsed into a number. Both totals round up to the next 5 minutes and nothing is added. It relies on the plan alone. The recipe's stated `time_active_min` and `time_total_min` stay the creator's: they are never overwritten by the summary, and they are what a surface shows, marked as the recipe's, when there is no current plan or more than a quarter of the plan's hands-on minutes rest on the scheduler's 2-minute guess for an unestimated task.

## Changelog

- **0.1** (2026-08-11) — the initial format.
- **0.2** (2026-10-03, additive) — optional `steps[].recommended_technique_ref` and the help-precedence rule: the creator's picks lead, the cook's preferences win, everything else is quiet. Absent → no pick; every technique's help is quiet.
- **0.3** (2026-10-04, breaking) — one schema, `pack/`, which every reader parses through.
  - *Flat file (breaking).* The pack file is the pack object; `commons.json` and `states.json` are arrays. The pack file carries no `format_version` field.
  - *P3 null semantics (additive).* `cover_ref` and `price_usd` take null; the library nulls were already legal. P3's null extends to `steps[].media_ref`. Readers treat null as absent.
  - *Namespaced library ids (breaking for library files).* `commons[].id` / `states[].id` are the namespaced strings refs carry, and refs resolve by whole-id equality.
  - *P19 media refs (tightening).* Platform-root file paths under `/packs/media/`, the same rule for pack and library media, existence checked by the publisher, no remote URLs. The schema reads the path segment by segment, since a prefix check alone lets `/packs/media/../commons.json` and `/packs/media/%2e%2e/x` through, and the publisher resolves it (`pack/src/media-file.ts`). "Control character" includes the invisible format characters (Unicode Cf), and a hint unit of only those and whitespace counts as empty.
  - *`recommended_technique_ref` enforced.* v0.2 said it is one of the step's `technique_refs`; `verifyPackRefs` now flags one that isn't.
  - *P18 `display_equivalents` shape (breaking).* An object keyed `imperial` | `metric`, each `{unit, amount}`, unit non-empty, amount positive, unknown keys passing through at both levels; the field was untyped before, so a malformed hint used to show nothing at render without an error. A prose equivalent has no field in the format.
- **0.4** (2026-10-05, additive) — a recipe from a source that gives no number converts to a pack recipe with no invented number.
  - *P20 `to_taste` and P25 `as_written` / `unstated` (additive).* A quantity the source gives no number for is anchored by exactly one marker standing alone, instead of failing the "at least one of mass_g, volume_ml, count" rule or carrying a guessed amount. `as_written` holds the source's amount and unit only (the ingredient's name already carries the item), and is refused when empty or only whitespace and invisible format characters, the rule a hint unit has.
  - *P27 empty steps or ingredients (loosening).* A recipe may have no steps (an ingredients-only source) or no ingredients, never both.
  - *P28 nullable `serves_base` (loosening; reverted in 0.5).* The key stays required; null hides the serving count and turns scaling off for that recipe.
  - *P11 `pack.kind` (additive).* Absent reads as "creator".
- **0.5** (2026-10-06) — every recipe has a serving count.
  - *P28 reverted (tightening).* `serves_base` is a required positive number again; null is refused.
  - *P30 `serves_estimated` (additive).* `true` marks a count the source doesn't state as Sous's estimate; it is only ever `true`, and absent means the source states the count. A reader shows the mark beside the count, scaled or not. Absent-behavior: a reader that doesn't know the key shows the count unmarked, which is what every v0.4 reader of a stated count already does.
- **0.6** (2026-10-06, additive) — P21, `pack.sections[]`: the chapters inside a pack, `{ title, recipe_ids[] }` in display order. A title must have visible text and a section at least one id (schema); every id must be a recipe of the pack and a recipe sits in at most one section, once (`verifyPackRefs`). Absent-behavior: one flat list in `recipes[]` order, which every v0.5 reader already shows; a recipe in no section shows after the last section, with no head.
- **0.7** (2026-10-17, additive) — P26 (`qty_canonical.count_unit`), P29 (`qty_canonical.range_max` and `display_equivalents.<system>.amount_max`), and P6's rule on which keys are amounts (`mass_g`, `volume_ml`, `count`, and `range_max` are amounts; every other key is a qualifier that never scales). It also reverses v0.3's hint reading: hints are the stated amount (`hint × m`), never recomputed from `qty_canonical`.
  - *P26 `count_unit: { one, other }` (additive).* Both visible text, valid only with `count`; absent means the ingredient's `name` carries any noun, as in v0.6.
  - *P29 `range_max` and `amount_max` (additive with reader refusal).* `range_max` is an optional positive number, valid only with *exactly one* of `mass_g`, `volume_ml`, `count`, greater than that low end, in its unit; every present `display_equivalents` hint on a ranged line carries `amount_max > amount`, and `amount_max` is refused without `range_max`. A renderer that doesn't know `range_max` must refuse the line rather than show the low end alone (`scaledCanonical` throws on a ranged line).
  - *P6 amount keys vs qualifiers (clarification).* `mass_g`, `volume_ml`, `count` (and `range_max`) are amounts; every other key (`salt_type`, etc.) is a qualifier that never scales.
  - *Stated-hint reading (reverses v0.3's reading).* Hints are the stated amount: a reader shows a hint's `amount` (and `amount_max`) times the serving multiplier, in the hint's unit, and converts from it; it never recomputes the shown number from `qty_canonical`, which carries the dimension, what scales, and the amount for a line with no hint. When a line carries hints in both systems (`"1⅔ cups (213g)"`), each system shows its stated hint (`× m`) rather than cross-converting.
- *(2026-10-02, additive clarification, version unchanged)* — "Derived layers" section added, describing CookPlan v4, the app's derived task graph: outside the pack file, refers to steps and ingredients by index. No schema change.
- *(2026-10-04, additive clarification, version unchanged)* — "Derived layers" gains the time summary, computed from CookPlan on read; the stated `time_active_min` and `time_total_min` stay the creator's and are shown, marked as the recipe's, when there is no usable plan. No schema change.
- *(2026-10-04, clarification, version unchanged)* — CookPlan's lead gets one anchor, the start of the cook, with the `lead-order` validation rule and the cook view's reading of plans stored before it. CookPlan stays version 4. No schema change.
- *(2026-10-06, clarification, version unchanged)* — the lead rule names three shapes it left to the reader: a holding time ("keeps, covered, 3 days") is a bound and names no time, with only holding words before its wait; a bound covers the whole of a wait said in parts, a bare comma included ("within 1 hour, 30 minutes"); a repeat ("2 x 4 hours") names count times each, where it named none before. Also: a bare-comma compound joins whatever follows it, a ranged count names its fewest rounds, and a bound covers a repeat. No schema change.
- *(2026-10-26, clarification, version unchanged)* — CookPlan gains the `ingredient-outside-step` rule: with a step-ingredient mapping, a cook task lists only its step's ingredients; mise and ahead tasks stay free. CookPlan stays version 4. No schema change, though a pack's `ingredient_refs` now bound its plans' cook tasks.
