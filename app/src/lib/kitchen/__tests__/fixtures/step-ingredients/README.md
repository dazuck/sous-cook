# Step-ingredient eval corpus

Labeled fixtures for the per-step "You'll need" mapping. Each `*.json` is:

```jsonc
{
  "description": "what failure mode this fixture stresses",
  "ingredients": [{ "amount": "1", "unit": "cup", "item": "flour" }, ...],
  "steps": ["Step 1 text", "Step 2 text", ...],
  "golden": [[0], [], [1, 2], ...] // parallel to steps; 0-based indices into ingredients
}
```

`golden[i]` is the set of ingredient indices that truly belong to step `i`. It is
the ground truth the scorer (`step-ingredient-scorer.ts`) measures both the regex
fallback and the LLM-assigned output against, so its consistency directly defines
what "correct" means. Mixed labeling conventions silently corrupt the F1 number.

## Labeling rule (Rule A)

The "You'll need" panel answers **"what does the cook physically reach for at this
step?"** — not "what ingredients does this step's text mention." Label accordingly:

1. **First incorporation.** List an ingredient at the step where it is first added
   or measured into the dish.
2. **Never re-list a combined component.** Once ingredients are combined into a
   sub-component ("the sauce", "the tempering", "the wet/dry", "the paste"), a later
   step that uses that whole thing ("pour in the sauce", "fold the wet into the dry")
   lists ONLY ingredients newly introduced there — the constituents were already
   counted at their combine step. They're in a bowl now; the cook doesn't re-grab them.
3. **Resolve a group at its combine step.** "Whisk the dry ingredients" lists each
   member (flour/soda/salt) — that IS their first incorporation.
4. **Pervasive seasonings (salt/pepper/oil) on first real use only** — not on every
   step that mentions heat or fat.
5. **Garnishes / finishing ingredients on the plating step only.**
6. **`[]` for ingredient-free steps** — technique or timing with nothing added:
   "Preheat the oven", "Let rest 10 minutes", "Remove the chicken and reserve",
   "Pour the wet into the dry and stir".

## Accepted sub-patterns (the only sanctioned re-listing)

These are the _only_ cases where an already-seen ingredient legitimately reappears:

- **Base re-listed when returned/combined.** The dish's primary item (the protein,
  the main produce) is re-listed at each major _active_ handling step: prep → cook →
  return-to-pan. Examples: salmon at `score` (step 0) and `lay skin-side down` (step
  3); chicken at `add and brown` and `return to the sauce`; dal (the base) at
  `pour the tempering into the cooked dal`. The cook physically works the base each time.
- This does **not** extend to secondary or combined ingredients. A made sauce,
  tempering, or paste is listed once at its combine step and never re-expanded.
- **Removal ≠ handling.** Taking an ingredient _out_ ("Remove the chicken and reserve
  the poaching liquid") adds nothing → `[]`. Only _adding_ or _returning_ re-lists.
- **Same ingredient, second portion.** If an ingredient is split across steps
  ("some chicken broth" then "remaining chicken broth"), attribute it to the FIRST
  step only — the word "remaining" is the tell.

When a new fixture's step is genuinely ambiguous under these rules, that ambiguity is
itself the product question — resolve it the way the kitchen panel should behave, then
add the case here so the convention stays single-valued.
