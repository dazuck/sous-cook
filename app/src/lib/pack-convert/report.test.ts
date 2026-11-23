import { describe, expect, it } from "vitest";
import { dryRun, formatDryRun } from "./report";

// The dry run over local rows shaped as the step-0 export queries select them.
// Never run against prod from here: the script reads exported files.

function libraryRow(over: Record<string, unknown> = {}) {
  return {
    doc_slug: "dal",
    name: "Dal",
    category: "indian",
    ingredients: [
      { item: "red lentils", amount: "1", unit: "cup" },
      { item: "garlic", amount: "3", unit: "cloves" },
      { item: "salt to taste" },
    ],
    steps: ["Rinse the lentils.", "Simmer 20 to 25 minutes, then rest 5 minutes."],
    step_ingredients: [[0], [0, 1, 2]],
    serves: 4,
    estimated_time: { active: 10, passive: 25, total: 35 },
    tags: ["weeknight"],
    notes: null,
    raw_doc_text: "Dal\n1 cup red lentils…",
    synced_at: "2026-10-01T12:00:00Z",
    ...over,
  };
}

function queueRow(over: Record<string, unknown> = {}, data: Record<string, unknown> = {}) {
  return {
    id: "q-1",
    recipe_data: {
      name: "Toast",
      ingredients: [
        { item: "bread", amount: "2", unit: "slices" },
        { item: "butter", amount: "1", unit: "tbsp" },
      ],
      steps: ["Toast the bread.", "Butter it."],
      serves: 2,
      source: "pasted",
      ...data,
    },
    cook_plan: {
      version: 4,
      tasks: [
        { id: "t1", sourceStep: 0, ingredientIdx: [0], kind: "cook" },
        { id: "t2", sourceStep: 1, ingredientIdx: [1], kind: "cook" },
        { id: "t3", sourceStep: null, ingredientIdx: [], kind: "mise" },
      ],
    },
    ...over,
  };
}

describe("dryRun", () => {
  it("converts a clean library row and counts its lines", () => {
    const run = dryRun({ library: [libraryRow()], queue: [] });
    expect(run.rows).toBe(1);
    expect(run.converted).toBe(1);
    expect(run.counts).toEqual({
      measured: 1,
      compound: 0,
      count: 1,
      to_taste: 1,
      unstated: 0,
      as_written: 0,
    });
    expect(run.noNumberLines).toEqual([]);
    expect(run.unusableMappings).toEqual([]);
    expect(run.multiDurationSteps).toEqual([
      {
        source: "library",
        key: "dal",
        name: "Dal",
        step: 1,
        text: "Simmer 20 to 25 minutes, then rest 5 minutes.",
      },
    ]);
    expect(run.passiveDropped).toBe(1);
    expect(run.failedValidation).toEqual([]);
  });

  it("lists every no-number line, unit outside the table and as-written reason", () => {
    const run = dryRun({
      library: [
        libraryRow({
          ingredients: [
            { item: "stock", amount: "1", unit: "qt" },
            { item: "milk", amount: "1", unit: "qt" },
            { item: "butter", amount: "1", unit: "stick" },
            { item: "herbs", amount: "a handful" },
            { item: "bread" },
          ],
          step_ingredients: null,
        }),
      ],
      queue: [],
    });
    expect(run.counts.as_written).toBe(4);
    expect(run.counts.unstated).toBe(1);
    expect(run.unitsOutsideTable).toEqual({ qt: 2, stick: 1 });
    expect(run.asWrittenReasons).toEqual({ "unit-not-in-table": 3, "amount-not-a-number": 1 });
    expect(run.noNumberLines.map((l) => [l.index, l.kind, l.reason ?? null])).toEqual([
      [0, "as_written", "unit-not-in-table"],
      [1, "as_written", "unit-not-in-table"],
      [2, "as_written", "unit-not-in-table"],
      [3, "as_written", "amount-not-a-number"],
      [4, "unstated", null],
    ]);
    expect(run.unusableMappings.map((m) => m.status)).toEqual(["absent"]);
  });

  it("lists every line whose amount was read from its text, with the text and its class", () => {
    const run = dryRun({
      library: [
        libraryRow({
          ingredients: [
            { item: "1 1/2 cups flour" },
            { item: "eggs", amount: "1", unit: "0" },
            { item: "milk", amount: "1", unit: "cup" },
          ],
          step_ingredients: null,
        }),
      ],
      queue: [],
    });
    expect(run.readFromText).toEqual([
      { source: "library", key: "dal", name: "Dal", index: 0, text: "1 1/2 cups flour", kind: "measured" },
      { source: "library", key: "dal", name: "Dal", index: 1, text: "10 eggs", kind: "count" },
    ]);
    expect(formatDryRun(run)).toContain(
      'Amounts read from the line\'s text: 2\n  library dal (Dal) #0 measured: "1 1/2 cups flour"\n  library dal (Dal) #1 count: "10 eggs"',
    );
  });

  it("lists serving counts by where they came from (B4b): an estimate, or none and refused", () => {
    const run = dryRun({
      library: [
        libraryRow({ doc_slug: "a", serves: null }),
        libraryRow({ doc_slug: "b", serves: null }),
        libraryRow({ doc_slug: "c", serves: 4 }),
      ],
      queue: [],
      estimates: new Map([
        ["library:b", { count: 3, basis: "1 cup lentils: 3 bowls." }],
        ["library:c", { count: 9, basis: "never read: c states 4" }],
      ]),
    });
    expect(run.converted).toBe(2);
    expect(run.noServes.map((r) => r.key)).toEqual(["a"]);
    expect(run.estimatedServes.map((r) => [r.key, r.count])).toEqual([["b", 3]]);
    expect(run.failedValidation.map((f) => [f.key, f.issues[0]!.path])).toEqual([["a", "serves_base"]]);
  });

  it("lists empty-steps and empty-ingredients rows, and mapping statuses", () => {
    const run = dryRun({
      library: [
        libraryRow({ doc_slug: "a" }),
        libraryRow({ doc_slug: "b", steps: [], step_ingredients: null }),
        libraryRow({ doc_slug: "c", ingredients: null, step_ingredients: [[], []] }),
        libraryRow({ doc_slug: "d", step_ingredients: [[0]] }),
        libraryRow({ doc_slug: "e", step_ingredients: [[0], [9]] }),
        libraryRow({ doc_slug: "f", step_ingredients: "[[0]]" }),
      ],
      queue: [],
    });
    expect(run.converted).toBe(6);
    expect(run.emptySteps.map((r) => r.key)).toEqual(["b"]);
    expect(run.emptyIngredients.map((r) => r.key)).toEqual(["c"]);
    expect(run.unusableMappings.map((r) => [r.key, r.status])).toEqual([
      ["b", "absent"],
      ["d", "length-mismatch"],
      ["e", "index-out-of-range"],
      ["f", "malformed"],
    ]);
  });

  it("reports a recipe the format refuses, and a row the stored types don't describe", () => {
    const run = dryRun({
      library: [
        libraryRow({ doc_slug: "empty", ingredients: [], steps: [], step_ingredients: null }),
        libraryRow({
          doc_slug: "numeric",
          ingredients: [{ item: "flour", amount: 2, unit: "cup" }],
        }),
      ],
      queue: [{ id: "q-x", recipe_data: { steps: [] }, cook_plan: null }],
    });
    expect(run.rows).toBe(1);
    expect(run.converted).toBe(0);
    expect(run.failedValidation).toHaveLength(1);
    expect(run.failedValidation[0]!.key).toBe("empty");
    expect(run.failedValidation[0]!.issues.length).toBeGreaterThan(0);
    expect(run.unreadableRows).toEqual([
      { source: "library", at: 1, issues: [expect.stringMatching(/^ingredients\.0\.amount: /)] },
      { source: "queue", at: 0, issues: [expect.stringMatching(/^recipe_data\.name: /)] },
    ]);
  });

  it("checks every stored plan index against the converted queue recipe", () => {
    const run = dryRun({ library: [], queue: [queueRow()] });
    expect(run.converted).toBe(1);
    expect(run.plansChecked).toBe(1);
    expect(run.indicesChecked).toBe(4);
    expect(run.indicesOutOfRange).toEqual([]);
  });

  it("finds a stored index that names no line", () => {
    const plan = {
      version: 3,
      tasks: [
        { id: "t1", sourceStep: 2, ingredientIdx: [0] },
        { id: "t2", sourceStep: 1, ingredientIdx: [1, 5] },
      ],
    };
    const run = dryRun({ library: [], queue: [queueRow({ cook_plan: plan })] });
    expect(run.indicesOutOfRange.map((o) => [o.task, o.field, o.index])).toEqual([
      ["t1", "sourceStep", 2],
      ["t2", "ingredientIdx", 5],
    ]);
  });

  // B4 fix round 2: the converter skips a blank stored line and keeps the
  // rest at their stored index, so a stored index is checked by id.
  describe("blank stored lines", () => {
    const gapped = {
      ingredients: [
        { item: "bread", amount: "2", unit: "slices" },
        { item: " " },
        { item: "butter", amount: "1", unit: "tbsp" },
      ],
      steps: ["Toast the bread.", "", "Butter it."],
    };

    it("lists each blank line, and checks a plan's indices past them by id", () => {
      const plan = {
        version: 4,
        tasks: [
          { id: "t1", sourceStep: 0, ingredientIdx: [0] },
          { id: "t2", sourceStep: 2, ingredientIdx: [2] },
        ],
      };
      const run = dryRun({ library: [], queue: [queueRow({ cook_plan: plan }, gapped)] });
      expect(run.converted).toBe(1);
      expect(run.blankLines.map((b) => [b.key, b.field, b.index])).toEqual([
        ["q-1", "ingredients", 1],
        ["q-1", "steps", 1],
      ]);
      expect(run.indicesChecked).toBe(4);
      expect(run.indicesOutOfRange).toEqual([]);
      expect(run.indicesAtBlankLines).toEqual([]);
      expect(run.counts.measured + run.counts.count + run.counts.as_written).toBe(2);
    });

    it("lists a stored index that names a blank line apart from one out of range", () => {
      const plan = {
        version: 4,
        tasks: [
          { id: "t1", sourceStep: 1, ingredientIdx: [1] },
          { id: "t2", sourceStep: 3, ingredientIdx: [3] },
        ],
      };
      const run = dryRun({ library: [], queue: [queueRow({ cook_plan: plan }, gapped)] });
      expect(run.indicesAtBlankLines.map((o) => [o.task, o.field, o.index])).toEqual([
        ["t1", "sourceStep", 1],
        ["t1", "ingredientIdx", 1],
      ]);
      expect(run.indicesOutOfRange.map((o) => [o.task, o.field, o.index])).toEqual([
        ["t2", "sourceStep", 3],
        ["t2", "ingredientIdx", 3],
      ]);
      const text = formatDryRun(run);
      expect(text).toContain("Blank lines skipped: 2\n  queue q-1 (Toast) ingredients #1\n  queue q-1 (Toast) steps #1");
      expect(text).toContain("Stored plan indices at a blank line (pair nothing): 2");
    });

    it("counts a row whose steps are all blank as empty steps", () => {
      const run = dryRun({
        library: [libraryRow({ steps: ["  "], step_ingredients: null })],
        queue: [],
      });
      expect(run.converted).toBe(1);
      expect(run.emptySteps.map((r) => r.key)).toEqual(["dal"]);
    });
  });

  it("skips a row with no plan, and lists a plan it can't read", () => {
    const run = dryRun({
      library: [],
      queue: [
        queueRow({ id: "none", cook_plan: null }),
        queueRow({ id: "odd", cook_plan: { steps: [] } }),
      ],
    });
    expect(run.converted).toBe(2);
    expect(run.plansChecked).toBe(0);
    expect(run.unreadablePlans.map((r) => r.key)).toEqual(["odd"]);
  });

  it("reads a queue payload that sent null for an absent field", () => {
    const run = dryRun({
      library: [],
      queue: [queueRow({}, { serves: null, notes: null, tags: null, estimatedTime: null })],
    });
    expect(run.unreadableRows).toEqual([]);
    expect(run.noServes.map((r) => r.key)).toEqual(["q-1"]);
  });

  it("flags a step over 12 hours", () => {
    const run = dryRun({
      library: [libraryRow({ steps: ["Cure 3 days.", "Slice."], step_ingredients: null })],
      queue: [],
    });
    expect(run.longTimerSteps.map((s) => s.step)).toEqual([0]);
  });
});

describe("formatDryRun", () => {
  it("prints every section the plan asks for, with its rows", () => {
    const text = formatDryRun(
      dryRun({
        library: [
          libraryRow({
            serves: null,
            ingredients: [{ item: "stock", amount: "1", unit: "qt" }],
            step_ingredients: null,
          }),
        ],
        queue: [
          queueRow({
            cook_plan: { version: 4, tasks: [{ id: "t9", sourceStep: 7, ingredientIdx: [] }] },
          }),
        ],
        estimates: new Map([["library:dal", { count: 4, basis: "b" }]]),
      }),
    );
    expect(text).toContain(
      "2 recipe(s) read, 2 converted, 0 refused by the format, 0 unreadable row(s).",
    );
    expect(text).toContain('library dal (Dal) #0 as written [unit-not-in-table]: "1 qt"');
    expect(text).toContain('"qt" ×1');
    expect(text).toContain("Serves: Sous's estimate: 1\n  library dal (Dal): 4");
    expect(text).toContain("Without a usable mapping: 2");
    expect(text).toContain("Multi-duration steps (timer is the first): 1");
    expect(text).toContain("Stored plan indices out of range (expected 0): 1");
    expect(text).toContain("queue q-1 (Toast) task t9 sourceStep 7");
    for (const heading of [
      "Serves: none, refused",
      "Empty steps",
      "Empty ingredients",
      "Refused by the format",
      "Unreadable rows",
      "Unreadable stored plans",
      "Blank lines skipped",
      "Stored plan indices at a blank line (pair nothing)",
    ]) {
      expect(text).toContain(`${heading}: 0`);
    }
  });
});
