import { describe, expect, it } from "vitest";
import {
  canonicalJson,
  estimateFileSchema,
  PROBLEMS,
  WARNINGS,
  planServesEstimates,
  sourceHash,
  statedInRecipeData,
  type EstimateEntry,
  type EstimateFile,
  type EstimateRow,
} from "./serves-estimate-plan";

const DOC_TEXT = "Tuna salad\ntuna\nmayo";
const QUEUE_DATA = { name: "Udon", ingredients: [{ item: "udon", amount: "2", unit: "packs" }], steps: ["Boil."] };

function docRow(over: Partial<EstimateRow> = {}): EstimateRow {
  return {
    table: "doc_recipes",
    key: "tuna-salad",
    name: "Tuna salad",
    source: DOC_TEXT,
    stated: null,
    estimate: null,
    basis: null,
    estimateSourceHash: null,
    ...over,
  };
}

function queueRow(over: Partial<EstimateRow> = {}): EstimateRow {
  return {
    table: "kitchen_queue",
    key: "00000000-0000-4000-8000-000000000035",
    name: "Udon",
    source: QUEUE_DATA,
    stated: null,
    estimate: null,
    basis: null,
    estimateSourceHash: null,
    ...over,
  };
}

function entryFor(row: EstimateRow, over: Partial<EstimateEntry> = {}): EstimateEntry {
  return {
    table: row.table,
    key: row.key,
    name: row.name,
    sourceHash: sourceHash(row.table, row.source),
    count: 2,
    basis: "From the dish alone: a tuna salad for two sandwiches.",
    hasAmounts: false,
    ...over,
  };
}

function file(...entries: EstimateEntry[]): EstimateFile {
  return { version: 1, proposedAt: "2026-10-06T22:00:00Z", model: "gemini-3.5-flash", entries };
}

const kinds = (rows: EstimateRow[], f: EstimateFile) =>
  planServesEstimates(rows, f).rows.map((r) => `${r.key}:${r.kind}`);

describe("planServesEstimates", () => {
  it("writes an entry whose row states no count, has none, and is unchanged", () => {
    const rows = [docRow(), queueRow()];
    const plan = planServesEstimates(rows, file(entryFor(rows[0]!), entryFor(rows[1]!, { count: 2 })));
    expect(plan.ok).toBe(true);
    expect(plan.counts.write).toBe(2);
    expect(plan.rows.map((r) => r.kind)).toEqual(["write", "write"]);
  });

  it("reads an applied row as applied (idempotent), and leaves stated rows out", () => {
    const entry = entryFor(docRow());
    const applied = docRow({ estimate: entry.count, basis: entry.basis, estimateSourceHash: entry.sourceHash });
    const stated = docRow({ key: "dal", stated: 4 });
    const plan = planServesEstimates([applied, stated], file(entry));
    expect(plan.rows.map((r) => r.kind)).toEqual(["applied"]);
    expect(plan.ok).toBe(true);
  });

  it("an applied file never blocks a later release: superseded and missing rows exit clean", () => {
    // After the apply: one row now states a count, one was re-estimated by
    // the sync for edited text, one recipe arrived with no count since.
    const statedNow = docRow({ key: "a", stated: 4 });
    const resynced = docRow({
      key: "b",
      source: `${DOC_TEXT}\n(edited)`,
      estimate: 3,
      basis: "the sync's",
      estimateSourceHash: sourceHash("doc_recipes", `${DOC_TEXT}\n(edited)`),
    });
    const sameTextOtherNumber = docRow({ key: "c", estimate: 5, basis: "x", estimateSourceHash: sourceHash("doc_recipes", DOC_TEXT) });
    const arrived = docRow({ key: "new" });
    const plan = planServesEstimates(
      [statedNow, resynced, sameTextOtherNumber, arrived],
      file(entryFor(docRow({ key: "a" })), entryFor(docRow({ key: "b" })), entryFor(docRow({ key: "c" }))),
    );
    expect(plan.rows.map((r) => `${r.key}:${r.kind}`)).toEqual([
      "a:superseded",
      "b:superseded",
      "c:superseded",
      "new:missing",
    ]);
    expect(plan.ok).toBe(true);
    expect(WARNINGS.has("missing")).toBe(true);
  });

  it("stops only on a file row that still needs its write and can't have it: stale or gone", () => {
    const stale = docRow({ key: "b", source: `${DOC_TEXT}\n(edited)` });
    const elsewhere = docRow({ key: "f", estimate: 5, basis: "made by the sync", estimateSourceHash: "x".repeat(64) });
    const f = file(entryFor(docRow({ key: "b" })), entryFor(docRow({ key: "d" })));
    const plan = planServesEstimates([stale, elsewhere], f);
    expect(plan.rows.map((r) => `${r.key}:${r.kind}`)).toEqual(["b:stale", "d:gone", "f:estimated-elsewhere"]);
    expect(plan.ok).toBe(false);
    expect([...PROBLEMS].sort()).toEqual(["gone", "stale"]);
  });

  it("a row removed after the apply (the family's Remove) is listed, not a stop; before the apply it is", () => {
    const kept = docRow({ key: "kept" });
    const keptEntry = entryFor(kept);
    const goneEntry = entryFor(queueRow({ key: "deleted" }));
    const applied = docRow({
      key: "kept",
      estimate: keptEntry.count,
      basis: keptEntry.basis,
      estimateSourceHash: keptEntry.sourceHash,
    });
    const after = planServesEstimates([applied], file(keptEntry, goneEntry));
    expect(after.rows.map((r) => `${r.key}:${r.kind}`)).toEqual(["kept:applied", "deleted:removed"]);
    expect(after.ok).toBe(true);
    const before = planServesEstimates([kept], file(keptEntry, goneEntry));
    expect(before.rows.map((r) => `${r.key}:${r.kind}`)).toEqual(["kept:write", "deleted:gone"]);
    expect(before.ok).toBe(false);
  });

  it("case C: every library row superseded by the sync's estimate, the queue row deleted: still applied, exit clean", () => {
    const entryA = entryFor(docRow({ key: "a" }));
    const entryQ = entryFor(queueRow({ key: "q" }));
    const resynced = docRow({
      key: "a",
      source: `${DOC_TEXT}\n(edited)`,
      estimate: 3,
      basis: "the sync's",
      estimateSourceHash: sourceHash("doc_recipes", `${DOC_TEXT}\n(edited)`),
    });
    const plan = planServesEstimates([resynced], file(entryA, entryQ));
    expect(plan.rows.map((r) => `${r.key}:${r.kind}`)).toEqual(["a:superseded", "q:removed"]);
    expect(plan.ok).toBe(true);
    // A row superseded only by a stated count holds no estimate: no evidence
    // of the apply, so the deleted row still stops it.
    const statedOnly = planServesEstimates([docRow({ key: "a", stated: 4 })], file(entryA, entryQ));
    expect(statedOnly.rows.map((r) => `${r.key}:${r.kind}`)).toEqual(["a:superseded", "q:gone"]);
    expect(statedOnly.ok).toBe(false);
  });

  it("matches a queue row by its stored recipe, whatever its key order", () => {
    const row = queueRow();
    const reordered = queueRow({ source: { steps: ["Boil."], ingredients: QUEUE_DATA.ingredients, name: "Udon" } });
    expect(kinds([reordered], file(entryFor(row)))).toEqual([`${row.key}:write`]);
    const changed = queueRow({ source: { ...QUEUE_DATA, steps: ["Boil 4 minutes."] } });
    expect(kinds([changed], file(entryFor(row)))).toEqual([`${row.key}:stale`]);
  });

  it("never mixes tables: a slug in doc_recipes isn't a queue key", () => {
    const row = docRow({ key: "same" });
    const entry = entryFor(queueRow({ key: "same" }));
    expect(kinds([row], file(entry))).toEqual(["same:gone", "same:missing"]);
  });
});

describe("the file", () => {
  it("refuses an entry twice, a count out of range, a bad hash", () => {
    const e = entryFor(docRow());
    expect(estimateFileSchema.safeParse(file(e, e)).success).toBe(false);
    expect(estimateFileSchema.safeParse(file({ ...e, count: 0 })).success).toBe(false);
    expect(estimateFileSchema.safeParse(file({ ...e, count: 2.5 })).success).toBe(false);
    expect(estimateFileSchema.safeParse(file({ ...e, sourceHash: "abc" })).success).toBe(false);
    expect(estimateFileSchema.safeParse(file(e)).success).toBe(true);
  });
});

describe("helpers", () => {
  it("canonicalJson sorts keys at every level and drops undefined", () => {
    expect(canonicalJson({ b: 1, a: { d: [{ z: 1, y: 2 }], c: undefined } })).toBe(
      '{"a":{"d":[{"y":2,"z":1}]},"b":1}',
    );
  });

  it("a library row's hash is sha256 of its raw text", () => {
    expect(sourceHash("doc_recipes", "abc")).toBe(
      "ba7816bf8f01cfea414140de5dae2223b00361a396177a9cb410ff61f20015ad",
    );
  });

  it("a queue row states a count only as a number", () => {
    expect(statedInRecipeData({ serves: 4 })).toBe(4);
    expect(statedInRecipeData({ serves: null })).toBeNull();
    expect(statedInRecipeData({})).toBeNull();
    expect(statedInRecipeData(null)).toBeNull();
  });
});
