/**
 * The legacy recipe the app stores (a `doc_recipes` row, a `kitchen_queue`
 * `recipe_data`) read into a Pack Format v0.5 recipe (slice B4, plan
 * `.claude/phase-b/B4.md`). Deterministic: no model call, no guess.
 *
 * - Positional ids: stored ingredient i is `ing-<i>`, stored step i is
 *   `step-<i>`, order and step text kept verbatim, so every stored CookPlan
 *   index still names the same line (decision 6). A blank stored line or step
 *   carries nothing and is skipped (B4 fix round 2); the rest keep their
 *   stored index as their id, so look a stored index up by id
 *   (`ingredientAt`, `stepAt`), never by position in the converted lists.
 * - A number the cook will see is one the source states (decision 3): a
 *   measured line keeps the source's number and unit as its one display hint;
 *   a compound keeps both stated values, never one recomputed from the other.
 *   Anything the shared reader (`@sous/pack/quantity`) can't read as a plain
 *   number in a known unit stays as written, and so does a line whose name
 *   keeps a number that wouldn't scale with its amount (B4 step 0, call 7).
 * - `ingredient_refs` come only from the stored `stepIngredients`, and only
 *   when the whole mapping fits (decision 1); otherwise no step has refs.
 * - The result is validated by `@sous/pack`'s own recipe schema and ref check:
 *   a recipe the format refuses comes back as issues, never half-converted.
 *
 * - Every recipe has a serving count (v0.5, slice B4b): the one the source
 *   states, else Sous's estimate, stored beside the source and passed in as
 *   `servesEstimate`, marked `serves_estimated: true`. A stated count always
 *   wins; an estimate beside one is ignored. With neither, the recipe is
 *   refused with one `serves_base` issue (`NO_SERVES_ISSUE`).
 *
 * The input is never changed. The report says what the conversion did, for
 * the dry run (`scripts/convert-report.ts`) and the webhook's response.
 */

import { z } from "zod";
import {
  parseRecipe,
  verifyRecipeRefs,
  type Ingredient,
  type ParseResult,
  type QtyCanonical,
  type Recipe,
  type SchemaIssue,
  type Step,
} from "@sous/pack";
import {
  classifyLine,
  countUnitFromNoun,
  getUnit,
  holdsAmount,
  isRateText,
  readLeadingAmount,
  type AsWrittenReason,
  type LineReading,
  type Measure,
} from "@sous/pack/quantity";
import type { ChatRecipeIngredient } from "../../../drizzle/schema";
import { durationsIn, timedLength } from "../kitchen/cook-plan";
import { ingredientId, stepId } from "./ids";
import { titleTags } from "./title-tags";

export { ingredientAt, ingredientId, stepAt, stepId } from "./ids";

/**
 * The fields of a legacy recipe the converter reads. Both stored shapes fit:
 * a `doc_recipes` row writes an absent field as null, `recipe_data` leaves it
 * out.
 */
export interface LegacyRecipe {
  name: string;
  ingredients?: ChatRecipeIngredient[] | null;
  steps?: string[] | null;
  estimatedTime?: {
    active?: number | null;
    passive?: number | null;
    total?: number | null;
  } | null;
  serves?: number | null;
  tags?: string[] | null;
  notes?: string | null;
  stepIngredients?: number[][] | ChatRecipeIngredient[][] | null;
}

const estimatedTimeSchema = z
  .strictObject({
    active: z.number().nullable().optional(),
    passive: z.number().nullable().optional(),
    total: z.number().nullable().optional(),
  })
  .nullable()
  .optional();

/**
 * A stored legacy recipe as its type describes it. The stored type leaves an
 * absent field out and a `doc_recipes` row writes it as null; both read the
 * same. Columns the converter doesn't read are dropped. An ingredient line is
 * strict: a key its type doesn't have is a row the type doesn't describe.
 * `stepIngredients` is the converter's to judge (a malformed mapping is a
 * status, not a refusal).
 */
export const legacyRecipeSchema = z.object({
  name: z.string(),
  ingredients: z
    .array(
      z.strictObject({
        item: z.string(),
        amount: z.string().optional(),
        unit: z.string().optional(),
      }),
    )
    .nullable()
    .optional(),
  steps: z.array(z.string()).nullable().optional(),
  estimatedTime: estimatedTimeSchema,
  serves: z.number().nullable().optional(),
  tags: z.array(z.string()).nullable().optional(),
  notes: z.string().nullable().optional(),
  stepIngredients: z.unknown().optional(),
});

/**
 * Checks stored data (jsonb, typed by assertion only) before it reaches the
 * converter, which trusts its input's type. Every caller reading a stored row
 * reads it here first, so a row of the wrong shape is that recipe's issues,
 * never a thrown load. (The webhook's payload is checked by its own schema,
 * whose type the converter takes as is.)
 */
export function readLegacyRecipe(data: unknown): ParseResult<LegacyRecipe> {
  const parsed = legacyRecipeSchema.safeParse(data);
  if (!parsed.success) {
    return {
      ok: false,
      issues: parsed.error.issues.map((issue) => ({
        path: issue.path.map(String).join(".") || "(root)",
        message: issue.message,
      })),
    };
  }
  // The mapping's shape is judged by the converter (`mapping: "malformed"`).
  return { ok: true, value: parsed.data as LegacyRecipe };
}

export type LineKind = LineReading["kind"];

/** How one ingredient line was read. */
export interface LineReport {
  index: number;
  item: string;
  kind: LineKind;
  /** As written only: why, and the text kept. */
  reason?: AsWrittenReason;
  text?: string;
  /**
   * Read from the joined "amount unit item" text, not the stored fields: that
   * text. Absent when the fields were read.
   */
  readFromText?: string;
}

/**
 * What became of `stepIngredients`: used, or why no step got refs. Malformed
 * is an entry that is not a list of numbers (a row the type does not
 * describe).
 */
export type MappingStatus =
  | "used"
  | "absent"
  | "length-mismatch"
  | "index-out-of-range"
  | "malformed";

export interface ConversionReport {
  lines: LineReport[];
  counts: Record<LineKind, number>;
  /** Unit spellings read as outside the table, in line order, repeats kept. */
  unitsOutsideTable: string[];
  mapping: MappingStatus;
  /**
   * Stored ingredient lines skipped as blank (item, amount and unit all empty
   * or whitespace), by stored index. `lines` and `counts` leave them out.
   */
  blankIngredients: number[];
  /** Stored steps skipped as blank (empty or whitespace), by stored index. */
  blankSteps: number[];
  /** Steps stating more than one duration; the timer is the first. */
  multiDurationSteps: number[];
  /** Steps whose first duration is over 12 hours; kept as stated. */
  longTimerSteps: number[];
  /** The source carried a passive time, which has no pack field. */
  passiveDropped: boolean;
  /**
   * Where the serving count came from: the source, Sous's estimate, or
   * nowhere (the recipe is refused).
   */
  serves: ServesProvenance;
  /**
   * Whether any kept line gives an amount (measured, compound, count or as
   * written). False: an estimate rests on the dish alone (B4b).
   */
  hasAmounts: boolean;
}

export type ServesProvenance = "stated" | "estimated" | "no-estimate";

/** Sous's estimate of the serving count, as stored beside the source. */
export interface ServesEstimateInput {
  count: number;
  basis: string;
}

/** The one issue a recipe with no stated count and no estimate is refused with. */
export const NO_SERVES_ISSUE: SchemaIssue = {
  path: "serves_base",
  message: "no serving count: the recipe states none, and Sous hasn't estimated one yet",
};

/**
 * The stored estimate columns as the converter's option: both or neither (a
 * DB check pairs them), a null count reading as none.
 */
export function storedEstimate(row: {
  servesEstimate: number | null;
  servesEstimateBasis: string | null;
}): ServesEstimateInput | undefined {
  return row.servesEstimate == null || row.servesEstimateBasis == null
    ? undefined
    : { count: row.servesEstimate, basis: row.servesEstimateBasis };
}

export type ConversionResult =
  | { ok: true; recipe: Recipe; report: ConversionReport }
  | { ok: false; issues: SchemaIssue[]; report: ConversionReport };

const LONG_TIMER_MIN = 12 * 60;

function secondsOf(minutes: number | null): number | null {
  const seconds = minutes === null ? 0 : Math.round(minutes * 60);
  return seconds > 0 ? seconds : null;
}

/**
 * The timer a step's text gives it, in seconds, as the converter reads it
 * (slice B5a, A1): the first length, else none. B5d's parity test holds a
 * pack's own `timer_sec` to this reading (B5.md §B5d D4).
 */
export function textTimerSec(text: string): number | null {
  return secondsOf(timedLength(durationsIn(text)));
}

const NO_LIBRARIES = { commons: [], states: [] };

type Hints = NonNullable<Ingredient["display_equivalents"]>;

/** A stated measure as its canonical amount: grams for mass, ml for volume. */
function canonicalOf(measure: Measure): QtyCanonical {
  const unit = getUnit(measure.unit);
  const base = measure.value * unit.toBase;
  const rangeMax = measure.max !== undefined ? { range_max: measure.max * unit.toBase } : {};
  return unit.dimension === "mass" ? { mass_g: base, ...rangeMax } : { volume_ml: base, ...rangeMax };
}

/** A stated measure as the display hint for its own system. */
function hintOf(measure: Measure): Hints {
  return {
    [getUnit(measure.unit).system]: {
      unit: measure.unit,
      amount: measure.value,
      ...(measure.max !== undefined && { amount_max: measure.max }),
    },
  };
}

/**
 * How one stored line is read: its reading, the name it shows, and the text
 * it was read from when that was the joined line rather than its fields.
 */
interface LineRead {
  reading: LineReading;
  name: string;
  readFromText?: string;
}

const DIGITS_RE = /^\d+$/;
/** An item that starts with a word and goes on: the split took a whole word as the unit. */
const WORD_THEN_MORE_RE = /^\w+\s+\S/;

/**
 * The line as main showed it: "amount unit item" joined. The JSON-LD import's
 * old split (`^([\d./½…]+)\s*(\w+)\s+(.+)$`) backtracked into the number when
 * the line had no "unit word" after it, storing "10 eggs" as amount "1", unit
 * "0". Such a row is joined back without the space it never had. A digit unit
 * before an item that is itself "word more" is a second number the source
 * wrote ("1 15 oz can beans"), joined with its space.
 */
function joinedText(line: ChatRecipeIngredient): { text: string; numberUnit: boolean } {
  const amount = line.amount?.trim() ?? "";
  const unit = line.unit?.trim() ?? "";
  const item = line.item.trim();
  const numberUnit = amount !== "" && DIGITS_RE.test(unit);
  if (numberUnit && !WORD_THEN_MORE_RE.test(item)) {
    return { text: `${amount}${unit} ${item}`, numberUnit };
  }
  return { text: [amount, unit, item].filter((part) => part !== "").join(" "), numberUnit };
}

function hasNumber(reading: LineReading): boolean {
  return reading.kind === "measured" || reading.kind === "compound";
}

/** A length the text puts after a bare count ("3" + "inches water"; call 10). */
function isLength(reading: LineReading): boolean {
  return reading.kind === "as_written" && reading.reason === "length-not-an-amount";
}

/** A reading the cook's scale multiplies. */
function scales(reading: LineReading): boolean {
  return hasNumber(reading) || reading.kind === "count";
}

/**
 * A scaled amount only when everything after it scales with it (B4 step 0,
 * call 7). A number left in the name (`holdsAmount`: "+ 1 tsp cumin",
 * "(1 stick) butter", "1 bay leaf") would stand unscaled beside the scaled
 * one, so the line goes as written instead, in the first of these forms that
 * holds:
 * - the joined line's reading, when it takes that number in as a stated
 *   equivalent ("1" "cup" "(225 g) butter" is 1 cup (225 g), named "butter");
 * - the fields' own as-written reading, which keeps the amount slot's words
 *   and the stored item as the name ("1 tbsp + 1 tsp", "cumin");
 * - the stated amount and unit as written, the name as it was.
 */
function scaledAlone(
  read: LineRead,
  stated: string,
  fieldsWritten: LineRead | null,
  fromText: LineRead | null,
): LineRead {
  if (!scales(read.reading) || !holdsAmount(read.name)) return read;
  if (fromText !== null && scales(fromText.reading) && !holdsAmount(fromText.name)) return fromText;
  if (fieldsWritten !== null) return fieldsWritten;
  return {
    ...read,
    reading: { kind: "as_written", text: stated, reason: "number-after-amount" },
  };
}

/**
 * Reads one stored line. Its fields come first; the joined line is read
 * through the same reader (`readLeadingAmount`) when the fields hold no amount
 * the cook can use and the text does: no amount at all ("1 1/2 cups flour"
 * stored as the item, from a JSON-LD split that failed or a model's string
 * entry), a unit the text supplies ("2" + "cups flour"), a number in the unit
 * slot (the split above), or an amount phrase whose unit sits inside it
 * ("1 1/2 cups"), or a length after a bare count ("3" + "inches water"). A
 * number with a word outside the unit table ("2" "large",
 * "1" "qt") stays as written, the fields' own reading (step-1 call 5): the
 * same words main showed, marked, and the report lists the spelling.
 */
function readLine(line: ChatRecipeIngredient): LineRead {
  const fields = classifyLine(line);
  const joined = joinedText(line);
  const fieldsStated = [line.amount?.trim() ?? "", line.unit?.trim() ?? ""]
    .filter((part) => part !== "")
    .join(" ");
  const lead = readLeadingAmount(joined.text);
  const leadRead = (): LineRead | null =>
    lead === null ? null : { reading: lead.reading, name: lead.rest, readFromText: joined.text };
  const leadStated = lead === null ? "" : [lead.amount, lead.unit].filter((part) => part !== "").join(" ");
  const containerLead =
    lead !== null &&
    lead.reading.kind === "count" &&
    lead.reading.noun !== null &&
    countUnitFromNoun(lead.reading.noun) !== null &&
    fields.kind !== "count";
  const first = ((): { read: LineRead; stated: string } => {
    const asFields = { read: { reading: fields, name: line.item }, stated: fieldsStated };
    if (!joined.numberUnit && hasNumber(fields) && !containerLead) return asFields;
    const takeLead =
      lead !== null &&
      (joined.numberUnit ||
        containerLead ||
        fields.kind === "unstated" ||
        fields.kind === "to_taste" ||
        (hasNumber(lead.reading) && !hasNumber(fields)) ||
        (fields.kind === "count" && isLength(lead.reading)));
    const fromLead = leadRead();
    if (!takeLead || fromLead === null) return asFields;
    return { read: fromLead, stated: leadStated };
  })();
  const fieldsWritten =
    !joined.numberUnit && fields.kind === "as_written" ? { reading: fields, name: line.item } : null;
  const read = scaledAlone(first.read, first.stated, fieldsWritten, leadRead());
  // A line that is only an amount ("3 cloves", "2 g", or an amount with a
  // blank item) has no name left after its amount (B4 fix round 2). A count
  // noun is then the whole name (`ingredientFrom`); otherwise the name is the
  // line itself, so nothing it says is lost and nothing is made up.
  if (read.name.trim() !== "") return read;
  const hasNoun = read.reading.kind === "count" && read.reading.noun !== null;
  return { ...read, name: hasNoun ? "" : joined.text };
}

/** A stored line with nothing in it: item, amount and unit all empty or whitespace. */
export function isBlankLine(line: ChatRecipeIngredient): boolean {
  return [line.item, line.amount ?? "", line.unit ?? ""].every((part) => part.trim() === "");
}

/** A stored step with nothing in it: empty or whitespace. */
export function isBlankStep(text: string): boolean {
  return text.trim() === "";
}

function ingredientFrom(name: string, reading: LineReading, index: number, fixed = false): Ingredient {
  const id = ingredientId(index);
  const scaleMark = fixed ? { scaling: "fixed" as const } : {};
  switch (reading.kind) {
    case "measured":
      return {
        id,
        name,
        qty_canonical: canonicalOf(reading.amount),
        display_equivalents: hintOf(reading.amount),
        ...scaleMark,
      };
    case "compound": {
      const sameDimension =
        getUnit(reading.head.unit).dimension === getUnit(reading.also.unit).dimension;
      return {
        id,
        name,
        qty_canonical: sameDimension
          ? canonicalOf(reading.head)
          : { ...canonicalOf(reading.head), ...canonicalOf(reading.also) },
        display_equivalents: { ...hintOf(reading.head), ...hintOf(reading.also) },
        ...scaleMark,
      };
    }
    case "count": {
      const countUnit = countUnitFromNoun(reading.noun);
      const itemName =
        reading.noun === null
          ? name
          : countUnit !== null
            ? name === ""
              ? reading.noun
              : name
            : name === ""
              ? reading.noun
              : `${reading.noun} ${name}`;
      return {
        id,
        name: itemName,
        qty_canonical: {
          count: reading.value,
          ...(reading.max !== undefined && { range_max: reading.max }),
          ...(countUnit !== null && { count_unit: { ...countUnit } }),
        },
        ...scaleMark,
      };
    }
    case "to_taste":
      return { id, name, qty_canonical: { to_taste: true } };
    case "unstated":
      return { id, name, qty_canonical: { unstated: true } };
    case "as_written":
      return { id, name, qty_canonical: { as_written: reading.text } };
  }
}

function lineReport(line: ChatRecipeIngredient, read: LineRead, index: number): LineReport {
  const { reading } = read;
  const report: LineReport = { index, item: line.item, kind: reading.kind };
  if (reading.kind === "as_written") {
    report.reason = reading.reason;
    report.text = reading.text;
  }
  if (read.readFromText !== undefined) report.readFromText = read.readFromText;
  return report;
}

function indicesWhere<T>(list: T[], test: (entry: T) => boolean): number[] {
  return list.flatMap((entry, index) => (test(entry) ? [index] : []));
}

/**
 * Resolves `stepIngredients` when entries are given as ingredient objects
 * (`ChatRecipeIngredient[][]`) to their 0-based indices into `lines`; leaves
 * numeric or malformed inputs unchanged for `mappingStatus` to judge.
 */
export function resolveStepIngredients(
  mapping: unknown,
  lines: readonly ChatRecipeIngredient[],
): unknown {
  if (!Array.isArray(mapping)) return mapping;
  let hasObject = false;
  for (const stepEntry of mapping) {
    if (!Array.isArray(stepEntry)) return mapping;
    for (const item of stepEntry) {
      if (typeof item === "object" && item !== null && typeof (item as { item?: unknown }).item === "string") {
        hasObject = true;
      } else if (typeof item !== "number") {
        return mapping;
      }
    }
  }
  if (!hasObject) return mapping;
  return (mapping as Array<Array<number | ChatRecipeIngredient>>).map((stepEntry) =>
    stepEntry.flatMap((entry) => {
      if (typeof entry === "number") return [entry];
      const target = entry.item.trim().toLowerCase();
      const idx = lines.findIndex((line) => line.item.trim().toLowerCase() === target);
      return idx >= 0 ? [idx] : [-1];
    }),
  );
}

/** The mapping's status against these steps and ingredients. */
function mappingStatus(
  mapping: unknown,
  stepCount: number,
  ingredientCount: number,
): MappingStatus {
  if (mapping === undefined || mapping === null) return "absent";
  if (!Array.isArray(mapping)) return "malformed";
  if (mapping.length !== stepCount) return "length-mismatch";
  let status: MappingStatus = "used";
  for (const entry of mapping as unknown[]) {
    if (!Array.isArray(entry)) return "malformed";
    for (const index of entry as unknown[]) {
      if (typeof index !== "number") return "malformed";
      if (!Number.isInteger(index) || index < 0 || index >= ingredientCount) {
        status = "index-out-of-range";
      }
    }
  }
  return status;
}

export function legacyToPackRecipe(
  legacy: LegacyRecipe,
  { id, servesEstimate }: { id: string; servesEstimate?: ServesEstimateInput },
): ConversionResult {
  const lines = legacy.ingredients ?? [];
  const stepTexts = legacy.steps ?? [];

  // A blank stored line or step carries nothing, so it is skipped; every
  // other keeps the id of its stored index (B4 fix round 2).
  const blankIngredients = indicesWhere(lines, isBlankLine);
  const blankSteps = indicesWhere(stepTexts, isBlankStep);
  const kept = lines.flatMap((line, index) => (isBlankLine(line) ? [] : [{ line, index }]));

  const reads = kept.map(({ line }) => readLine(line));
  const readings = reads.map((read) => read.reading);
  const ingredients = reads.map((read, i) =>
    ingredientFrom(
      read.name,
      read.reading,
      kept[i]!.index,
      isRateText(joinedText(kept[i]!.line).text),
    ),
  );

  const counts: Record<LineKind, number> = {
    measured: 0,
    compound: 0,
    count: 0,
    to_taste: 0,
    unstated: 0,
    as_written: 0,
  };
  for (const reading of readings) counts[reading.kind] += 1;

  const unitsOutsideTable = readings.flatMap((reading, i) =>
    reading.kind === "as_written" && reading.reason === "unit-not-in-table"
      ? [kept[i]!.line.unit?.trim() ?? ""]
      : [],
  );

  // The mapping is judged against the stored lists, whose indices it holds.
  const resolvedMapping = resolveStepIngredients(legacy.stepIngredients, lines);
  const mapping = mappingStatus(resolvedMapping, stepTexts.length, lines.length);
  const blankIngredient = new Set(blankIngredients);
  const multiDurationSteps: number[] = [];
  const longTimerSteps: number[] = [];

  const steps: Step[] = stepTexts.flatMap((text, i) => {
    if (isBlankStep(text)) return [];
    const durations = durationsIn(text);
    if (durations.length > 1) multiDurationSteps.push(i);
    // The step's first length times it (slice B5a, A1): a mark, a cadence, a
    // bound or a summary is passed over (call 11 for marks), one round of a
    // repeat is timed, and a first duration relative to another time ("2
    // minutes less than the package says") leaves no length to time (call 8).
    const timed = timedLength(durations) ?? undefined;
    if (timed !== undefined && timed > LONG_TIMER_MIN) longTimerSteps.push(i);
    const step: Step = {
      id: stepId(i),
      type: "action",
      text,
      timer_sec: secondsOf(timed ?? null),
    };
    if (mapping === "used") {
      const indices = (resolvedMapping as number[][])[i]!.filter((index) => !blankIngredient.has(index));
      step.ingredient_refs = [...new Set(indices)].map(ingredientId);
    }
    return [step];
  });

  const time = legacy.estimatedTime ?? {};
  const notes = legacy.notes ?? "";
  // The Doc's title suffixes (a season, an occasion) are tags, not
  // the dish's name (slice S, S-D11); the stored name keeps them.
  const named = titleTags(legacy.name);
  const tags = [...(legacy.tags ?? [])];
  for (const tag of named.tags) {
    if (!tags.some((t) => t.trim().toLowerCase() === tag)) tags.push(tag);
  }
  const stated = legacy.serves ?? null;
  const serves: ServesProvenance =
    stated !== null ? "stated" : servesEstimate !== undefined ? "estimated" : "no-estimate";
  const candidate: Record<string, unknown> = {
    id,
    title: named.title,
    // With no count at all, a placeholder lets the schema list the recipe's
    // other issues beside NO_SERVES_ISSUE; it never leaves the converter.
    serves_base: stated ?? servesEstimate?.count ?? 1,
    ...(serves === "estimated" && { serves_estimated: true }),
    ...(time.active != null && { time_active_min: time.active }),
    ...(time.total != null && { time_total_min: time.total }),
    ...((legacy.tags != null || tags.length > 0) && { tags }),
    ingredients,
    steps,
    ...(notes.trim() !== "" && { creator_notes: [notes] }),
  };

  const report: ConversionReport = {
    lines: kept.map(({ line, index }, i) => lineReport(line, reads[i]!, index)),
    counts,
    unitsOutsideTable,
    mapping,
    blankIngredients,
    blankSteps,
    multiDurationSteps,
    longTimerSteps,
    passiveDropped: time.passive != null,
    serves,
    hasAmounts: counts.measured + counts.compound + counts.count + counts.as_written > 0,
  };

  // structuredClone: the pack recipe shares no array with the legacy input.
  const parsed = parseRecipe(structuredClone(candidate));
  if (serves === "no-estimate") {
    return { ok: false, issues: [NO_SERVES_ISSUE, ...(parsed.ok ? [] : parsed.issues)], report };
  }
  if (!parsed.ok) return { ok: false, issues: parsed.issues, report };
  const refIssues = verifyRecipeRefs(parsed.value, NO_LIBRARIES);
  if (refIssues.length > 0) return { ok: false, issues: refIssues, report };
  return { ok: true, recipe: parsed.value, report };
}
