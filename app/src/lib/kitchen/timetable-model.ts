/**
 * The timetable model: the whole cook as the opening and the cook sheet draw
 * it, time running across (DECISIONS 2026-10-20, "Whole-cook overview: the
 * timetable"). The build contract is the repo's
 * `design/overview-arc/r3/SPEC.md`: this module is its §1–5 and §9 (grouping,
 * naming, chapters, long waits, done and now). The layout that turns this
 * into boxes (§6–8, measuring text) lives elsewhere and reads only this.
 *
 * It is a port of the round-3 mock's model (`design/overview-arc/r3/index.html`,
 * `buildModel` and `modelFor`), which proved the rules against real plans. Its
 * input there was `strip()`'s output, so here it reads the app's own `Strip`
 * for each prep mode: the step marks (start, end, strand, pot, cook, tasks)
 * and the Prep mark. Both modes come in so they share one axis: As I go
 * visibly ends sooner on the same scale. `timetable-model.test.ts` holds the
 * port to the mock on the six round-1 recipes; where it steps past the mock,
 * the code says so.
 *
 * Pure: no DOM, no measuring. Where a rule falls back on width (a lane name
 * too wide, a block too narrow for its name), both forms are here and the
 * layout picks.
 */

import type { CookPlan, CookTask, PrepMode } from "./cook-plan";
import { taskMinutes } from "./cook-schedule";
import type { Strip, StripMark } from "./cook-strip";

/** A long wait (a break) is drawn as this many minutes; everything else is to scale (SPEC §5). */
export const BREAK_DRAWN_MINUTES = 12;

/** A cook longer than this has its long waits compressed (SPEC §5). */
const BREAK_COOK_OVER = 75;
/** A free gap at least this long is a break (SPEC §5). */
const BREAK_MIN = 30;
/** The stove free at least this long is a stretch, and a wait chapter (SPEC §4). */
const STRETCH_MIN = 8;
/** Hands-on runs this close merge into one block (SPEC §2). */
const MERGE_GAP = 3;
/** At most this many runs of one kind on a lane (SPEC §2). */
const MAX_RUNS = 4;
/** A block with less hands-on work than this is a touch (SPEC §2). */
const TOUCH_UNDER = 3;
/** A chapter shorter than this joins a neighbour (SPEC §4). */
const CHAPTER_MIN = 4;
/** At most this many chapters (SPEC §4). */
const MAX_CHAPTERS = 4;

// ---------------------------------------------------------------------------
// Naming (SPEC §3)
// ---------------------------------------------------------------------------

/** Verbs that say little on their own; they count half on a cook block. */
const GENERIC = new Set([
  "cook", "make", "prep", "finish", "heat", "place", "set aside", "set", "transfer",
  "add", "put", "combine", "turn on", "turn", "position", "get", "start", "serve",
]);
const PREPOSITIONS = new Set([
  "on", "in", "into", "with", "for", "to", "until", "from", "over", "onto", "at", "by", "of", "before", "after",
]);
/** Words a name never carries ("initial sear" is a sear). */
export const NAME_QUALIFIERS: ReadonlySet<string> = new Set([
  "initial", "final", "again", "super", "ultra", "the", "a", "an", "some", "all", "more", "then", "up",
]);
/** Verbs that open a pot's clause. */
const POT_VERBS = new Set([
  "rest", "simmer", "roast", "bake", "boil", "soak", "marinate", "cool", "chill", "broil", "braise",
  "steam", "cook", "air fry", "heat", "preheat", "crisp", "poach", "proof", "rise", "drain", "temper",
  "brine", "dry-brine",
]);
const TWO_WORD_VERBS = new Set(["air fry", "set aside", "turn on"]);

function verbOf(words: string[]): [verb: string, length: number] {
  const two = words.slice(0, 2).join(" ");
  if (TWO_WORD_VERBS.has(two)) return [two, 2];
  return [words[0] ?? "", 1];
}

/** A lane's own words, with their plural and singular forms: a name never repeats them. */
export function laneWords(lane: string): Set<string> {
  const s = new Set<string>();
  for (const w of lane.toLowerCase().split(/\s+/)) {
    s.add(w);
    s.add(`${w}s`);
    s.add(`${w}es`);
    s.add(w.replace(/es$/, ""));
    s.add(w.replace(/s$/, ""));
  }
  return s;
}

export interface Phrase {
  verb: string;
  /** At most 2 words, cut at the first preposition, without the lane's words or qualifiers. */
  object: string[];
}

/**
 * The verb and object a task label reads as. A block reads its first clause;
 * a pot reads its last clause that opens with a cooking verb.
 */
export function phrase(label: string, lane: string | null, pot = false): Phrase {
  const clauses = label.toLowerCase().split(/\s*,\s*|\s+and\s+/).filter(Boolean);
  let clause = clauses[0] ?? "";
  if (pot) {
    for (const c of clauses) {
      const [v] = verbOf(c.split(/\s+/));
      if (POT_VERBS.has(v)) clause = c;
    }
  }
  const words = clause.split(/\s+/);
  const [verb, n] = verbOf(words);
  let rest = words.slice(n);
  const cut = rest.findIndex((w) => PREPOSITIONS.has(w));
  if (cut >= 0) rest = rest.slice(0, cut);
  const dish = lane ? laneWords(lane) : new Set<string>();
  return { verb, object: rest.filter((w) => !dish.has(w) && !NAME_QUALIFIERS.has(w)).slice(0, 2) };
}

/**
 * A task's minutes as the schedule gives them (`taskMinutes`): its estimate,
 * the nominal 2 min when it has none, and one tick for an estimate of 0. So a
 * mark's length is its tasks' minutes, and names and work score drawn time.
 */
const estOf = (t: CookTask): number => taskMinutes(t);

/**
 * A hands-on phase's name: its verb with the most minutes (a generic verb
 * counts half on a cook block; a tie goes to the earlier verb), with the
 * object when one task carries it ("wilt greens"), or the longest task's
 * object for a shared generic verb ("cook eggs"); otherwise the bare verb.
 */
export function blockName(tasks: readonly CookTask[], lane: string | null, sand: boolean): string {
  const score = new Map<string, number>();
  const firstAt = new Map<string, number>();
  tasks.forEach((t, i) => {
    const { verb } = phrase(t.label, lane);
    const w = estOf(t) * (!sand && GENERIC.has(verb) ? 0.5 : 1);
    score.set(verb, (score.get(verb) ?? 0) + w);
    if (!firstAt.has(verb)) firstAt.set(verb, i);
  });
  let best: string | null = null;
  for (const [v, s] of score) {
    if (best === null) {
      best = v;
      continue;
    }
    const bs = score.get(best) ?? 0;
    if (s > bs || (s === bs && (firstAt.get(v) ?? 0) < (firstAt.get(best) ?? 0))) best = v;
  }
  if (best === null) return "";
  const carriers = tasks.filter((t) => phrase(t.label, lane).verb === best);
  if (carriers.length === 1) {
    const p = phrase(carriers[0].label, lane);
    return [p.verb, ...p.object].join(" ");
  }
  if (!sand && GENERIC.has(best)) {
    const longest = carriers.reduce((a, b) => (estOf(b) > estOf(a) ? b : a));
    const p = phrase(longest.label, lane);
    if (p.object.length) return [p.verb, ...p.object].join(" ");
  }
  return best;
}

/** A name's short form: its verb, or its object when the verb is generic ("cook eggs" → "eggs"). */
export function shortName(name: string): string {
  const ws = name.split(" ");
  const [v, n] = verbOf(ws);
  const rest = ws.slice(n);
  if (GENERIC.has(v) && rest.length) return rest.join(" ");
  return v;
}

/** A verb in the third person ("simmers", "tosses", "fries", "air-fries"). */
export function verb3(v: string): string {
  if (v === "air fry") return "air-fries";
  if (/(s|sh|ch|x|z)$/.test(v)) return `${v}es`;
  if (/[^aeiou]y$/.test(v)) return `${v.slice(0, -1)}ies`;
  return `${v}s`;
}

const isPlural = (w: string): boolean => /s$/.test(w) && !/(ss|us)$/.test(w);
const verbBase = (v: string): string => (v === "air fry" ? "air-fry" : v);
/** A pot's verb: "preheat" reads "heat" (the oven heats). */
const potVerb = (task: CookTask): string => {
  const v = phrase(task.label, null, true).verb;
  return v === "preheat" ? "heat" : v;
};

/**
 * A pot's words: object plus verb in the third person ("oven heats",
 * "chickpeas simmer"), the subject given when the object was the dish, or
 * the bare verb ("roasts").
 */
export function potWords(task: CookTask, lane: string | null, subject: string | null): string {
  const p = phrase(task.label, lane, true);
  const verb = p.verb === "preheat" ? "heat" : p.verb;
  const subj = p.object.length ? p.object.join(" ") : subject;
  if (!subj) return verb3(verb);
  return `${subj} ${isPlural(subj.split(" ").pop() ?? "") ? verbBase(verb) : verb3(verb)}`;
}

const isEquipment = (t: CookTask): boolean => /\b(oven|broiler|grill)\b/.test(t.label.toLowerCase());
const cap = (s: string): string => s.charAt(0).toUpperCase() + s.slice(1);

// ---------------------------------------------------------------------------
// The model
// ---------------------------------------------------------------------------

export interface TimetableLane {
  /** The branch, or Board / Stove for a one-branch plan. */
  name: string;
  /**
   * For a two-word name, its last word, used when the name is too wide for the margin
   * ("Cucumber Pickles" → "Pickles"); any other name is its own short form.
   */
  short: string;
}

/** One step on its lane: hands-on work or a pot minding itself. */
export interface TimetableSegment {
  /** The step mark's key (`stepKey`). */
  key: string;
  lane: string;
  start: number;
  end: number;
  pot: boolean;
  /** Moved prep: a step with no cook task (As I go puts mise in the cook's gaps). */
  sand: boolean;
  tasks: string[];
}

/** A hands-on phase: runs of hands-on steps on one lane, of one kind. */
export interface TimetableBlock {
  /** Stable across modes and levels: kind, lane and first task. */
  key: string;
  lane: string;
  start: number;
  end: number;
  /** Moved prep (drawn Ink-soft) rather than cooking (Ink). */
  sand: boolean;
  /** Its full name ("wilt greens"); the layout tries this first. */
  name: string;
  /** The short form ("wilt"), tried when the full name doesn't fit. */
  short: string;
  /** Hands-on minutes: its tasks' estimates, hands-off tasks left out. */
  work: number;
  /** Under 3 min of work: drawn low and never named. */
  touch: boolean;
  tasks: string[];
  /** Ended by now. */
  done: boolean;
}

/** A hands-off wait on one lane: touching food pots merge; an oven heating stays its own. */
export interface TimetablePot {
  key: string;
  lane: string;
  start: number;
  end: number;
  /** An oven, broiler or grill heating, rather than food. */
  equipment: boolean;
  /** Its longest hands-off task: what it reads as. */
  lead: string;
  /** "chickpeas simmer": the caption is these words and its minutes. */
  words: string;
  /** "simmers": the verb alone, for a short line. */
  short: string;
  minutes: number;
  /** It names a chapter, so it doesn't caption its own line unless the head shortens (SPEC §4.7). */
  namesChapter: boolean;
  tasks: string[];
  done: boolean;
}

/** The shared prep block: Prep's mise, from 0, down every lane. */
export interface TimetablePrep {
  start: 0;
  end: number;
  tasks: string[];
  done: boolean;
}

export type TimetableChapterKind = "prep" | "wait" | "finish";

/**
 * A chapter of the timetable: a band of the axis with a numbered head. Cut
 * where the stove is free for 8+ min (a wait) after Prep, at most 4, named
 * ("Prep", "Chicken roasts", "Finish and plate").
 *
 * Not `cook-chapters.ts`'s stretches, which cut the cook's screens at 10+ idle
 * minutes and drive the cook view's chapter menu, eyebrow and Whole recipe's
 * dividers. These are drawn bands on a minute axis; the two can differ for
 * the same cook, and both stand.
 */
export interface TimetableChapter {
  /** 1-based, the numeral on its head. */
  n: number;
  kind: TimetableChapterKind;
  name: string;
  /** The head's last fallback before the numeral alone: a finish chapter's first word ("Finish"). */
  headShort: string | null;
  start: number;
  end: number;
  minutes: number;
  /** The pot a wait chapter is named for (its key), else null. */
  pot: string | null;
}

/** A long free wait drawn short behind a break mark, carrying its real minutes. */
export interface TimetableBreak {
  start: number;
  end: number;
  minutes: number;
}

/** Now inside a break: how much of it is left ("35 min free"). */
export interface TimetableNowBreak extends TimetableBreak {
  left: number;
}

/** Ahead work, one note per lead time ("marinate", "2–6 hours before"). */
export interface TimetableAhead {
  lead: string;
  name: string;
  tasks: string[];
}

/** Minute 0 to the total, always (SPEC §6, §9). */
export interface TimetableAxis {
  /** Drawn minutes (breaks compressed) to the total. */
  drawnEnd: number;
  /**
   * The scale's denominator, shared by both prep modes: the longer of the two
   * modes' drawn spans, so As I go visibly ends sooner.
   */
  span: number;
}

export interface Timetable {
  mode: PrepMode;
  /** One branch: lanes are Board and Stove. */
  onePan: boolean;
  lanes: TimetableLane[];
  total: number;
  /** The cook's now, in plan minutes, held between 0 and the total. */
  now: number;
  /** Minutes to the table (never below 0). */
  toTable: number;
  prep: TimetablePrep | null;
  segments: TimetableSegment[];
  blocks: TimetableBlock[];
  pots: TimetablePot[];
  chapters: TimetableChapter[];
  breaks: TimetableBreak[];
  nowBreak: TimetableNowBreak | null;
  ahead: TimetableAhead[];
  axis: TimetableAxis;
}

type Interval = [number, number];

function unionOf(iv: Interval[]): Interval[] {
  const sorted = iv.map(([a, b]): Interval => [a, b]).sort((p, q) => p[0] - q[0]);
  const out: Interval[] = [];
  for (const [a, b] of sorted) {
    const last = out[out.length - 1];
    if (last && a <= last[1]) last[1] = Math.max(last[1], b);
    else out.push([a, b]);
  }
  return out;
}

function gapsOf(union: Interval[], from: number, to: number): Interval[] {
  const g: Interval[] = [];
  let t = from;
  for (const [a, b] of union) {
    if (b <= from) continue;
    if (a > t) g.push([t, Math.min(a, to)]);
    t = Math.max(t, b);
  }
  if (t < to) g.push([t, to]);
  return g.filter(([a, b]) => b > a);
}

const stepMarks = (s: Strip): StripMark[] => s.marks.filter((m) => m.key !== "prep");
const prepEndOf = (s: Strip): number => s.marks.find((m) => m.key === "prep")?.end ?? 0;

/**
 * The branches with work on the day, in the order the plan first names them.
 * A branch that is only ahead work gets no lane (its ahead notes still show).
 */
function branchesOf(plan: CookPlan): string[] {
  const out: string[] = [];
  for (const t of plan.tasks) if (t.kind !== "ahead" && !out.includes(t.branch)) out.push(t.branch);
  return out;
}

/**
 * One lane per branch, by the minute of its first stove step in Prep first
 * (decided: one lane per branch, however many, never `lanes()`' packing);
 * Board and Stove when one branch has work on the day.
 */
function laneOrder(plan: CookPlan, stripFirst: Strip): string[] {
  const branches = branchesOf(plan);
  if (branches.length === 1) return ["Board", "Stove"];
  const first = new Map<string, number>();
  for (const m of stepMarks(stripFirst)) {
    if (m.cook) first.set(m.strand, Math.min(first.get(m.strand) ?? Infinity, m.start));
  }
  const at = (b: string) => first.get(b) ?? 1e8;
  return [...branches].sort((a, b) => at(a) - at(b) || branches.indexOf(a) - branches.indexOf(b));
}

interface Run {
  start: number;
  end: number;
  segs: Seg[];
}

interface Seg extends TimetableSegment {
  taskList: CookTask[];
}

/** The mode's model before the shared axis and now. */
interface Core {
  onePan: boolean;
  lanes: string[];
  total: number;
  prepEnd: number;
  prepTasks: string[];
  segs: Seg[];
  blocks: Omit<TimetableBlock, "done">[];
  pots: Omit<TimetablePot, "done">[];
  chapters: TimetableChapter[];
  breaks: TimetableBreak[];
  ahead: TimetableAhead[];
}

function buildCore(plan: CookPlan, s: Strip, stripFirst: Strip): Core {
  const byId = new Map(plan.tasks.map((t) => [t.id, t]));
  const taskOf = (id: string): CookTask => {
    const t = byId.get(id);
    if (!t) throw new Error(`timetable: the strip names task ${id}, which the plan doesn't have`);
    return t;
  };
  const onePan = branchesOf(plan).length === 1;
  const lanes = laneOrder(plan, stripFirst);
  const total = s.totalMinutes;
  const prepMark = s.marks.find((m) => m.key === "prep");
  const prepEnd = prepEndOf(s);

  const segs: Seg[] = stepMarks(s).map((m) => {
    const sand = !m.cook;
    return {
      key: m.key,
      lane: onePan ? (sand ? "Board" : "Stove") : m.strand,
      start: m.start,
      end: m.end,
      pot: m.pot,
      sand,
      tasks: [...m.tasks],
      taskList: m.tasks.map(taskOf),
    };
  });
  const tasksOf = (ss: Seg[]): CookTask[] => ss.flatMap((x) => x.taskList);

  // Hands-on blocks: runs on a lane merge at gaps of 3 min or less, kept per kind
  // (cooking, moved prep); at most 4 runs on a lane across both kinds; a long one-pan
  // stove run splits where its halves read differently.
  const blocks: Omit<TimetableBlock, "done">[] = [];
  for (const lane of lanes) {
    const byKind = new Map<boolean, Run[]>();
    for (const sand of [false, true]) {
      const hs = segs.filter((x) => x.lane === lane && !x.pot && x.sand === sand).sort((a, b) => a.start - b.start);
      const runs: Run[] = [];
      for (const x of hs) {
        const last = runs[runs.length - 1];
        if (last && x.start - last.end <= MERGE_GAP) {
          last.end = Math.max(last.end, x.end);
          last.segs.push(x);
        } else runs.push({ start: x.start, end: x.end, segs: [x] });
      }
      byKind.set(sand, runs);
    }
    // Past the mock, which capped each kind at 4 (so a lane could hold 8): the cap is the lane's.
    // The closest two runs of one kind merge (the earliest pair on a tie, cooking first) until 4 remain.
    const count = () => (byKind.get(false)?.length ?? 0) + (byKind.get(true)?.length ?? 0);
    while (count() > MAX_RUNS) {
      let best: { runs: Run[]; i: number; gap: number } | null = null;
      for (const runs of byKind.values()) {
        for (let i = 0; i < runs.length - 1; i++) {
          const gap = runs[i + 1].start - runs[i].end;
          if (!best || gap < best.gap) best = { runs, i, gap };
        }
      }
      if (!best) throw new Error(`timetable: lane ${lane} has more than ${MAX_RUNS} runs and none to merge`);
      const a = best.runs[best.i];
      const b = best.runs[best.i + 1];
      best.runs.splice(best.i, 2, { start: a.start, end: Math.max(a.end, b.end), segs: [...a.segs, ...b.segs] });
    }
    // Past the mock, for the binding "at most 4 named blocks per lane" (the corpus test): a split
    // never takes the lane past 4 runs, in time order. The mock split after capping, which gave
    // Parker House rolls 5 named blocks on its stove.
    let room = MAX_RUNS - count();
    for (const sand of [false, true]) {
      const runs = byKind.get(sand) ?? [];
      const named: (Run & { name: string })[] = [];
      for (const r of runs) {
        if (room > 0 && onePan && !sand && r.end - r.start >= 8 && tasksOf(r.segs).length >= 3 && r.segs.length >= 2) {
          const mid = (r.start + r.end) / 2;
          let bi = 1;
          let bd = Infinity;
          for (let i = 1; i < r.segs.length; i++) {
            const d = Math.abs(r.segs[i].start - mid);
            if (d < bd) {
              bd = d;
              bi = i;
            }
          }
          const A = r.segs.slice(0, bi);
          const B = r.segs.slice(bi);
          const nA = blockName(tasksOf(A), lane, sand);
          const nB = blockName(tasksOf(B), lane, sand);
          if (nA !== nB) {
            named.push({ start: A[0].start, end: B[0].start, segs: A, name: nA });
            named.push({ start: B[0].start, end: r.end, segs: B, name: nB });
            room--;
            continue;
          }
        }
        named.push({ ...r, name: blockName(tasksOf(r.segs), lane, sand) });
      }
      for (const r of named) {
        const list = tasksOf(r.segs);
        const work = list.reduce((sum, t) => sum + (t.minutes?.handsOff ? 0 : estOf(t)), 0);
        blocks.push({
          key: `${sand ? "s" : "k"}:${lane}:${r.segs[0].tasks[0]}`,
          lane,
          start: r.start,
          end: r.end,
          sand,
          name: r.name,
          short: shortName(r.name),
          work,
          touch: work < TOUCH_UNDER,
          tasks: list.map((t) => t.id),
        });
      }
    }
  }

  // Pots: a lane's pots merge when they touch and are both food or both equipment.
  const pots: Omit<TimetablePot, "done">[] = [];
  for (const lane of lanes) {
    const ps = segs.filter((x) => x.lane === lane && x.pot).sort((a, b) => a.start - b.start);
    const runs: (Run & { eq: boolean })[] = [];
    for (const x of ps) {
      const eq = x.taskList.some(isEquipment);
      const last = runs[runs.length - 1];
      if (last && last.eq === eq && x.start <= last.end + 1) {
        last.end = Math.max(last.end, x.end);
        last.segs.push(x);
      } else runs.push({ start: x.start, end: x.end, segs: [x], eq });
    }
    for (const r of runs) {
      const all = tasksOf(r.segs);
      const off = all.filter((t) => t.minutes?.handsOff);
      const lead = off.length ? off.reduce((a, b) => (estOf(b) > estOf(a) ? b : a)) : all[0];
      pots.push({
        key: `p:${lane}:${r.segs[0].tasks[0]}`,
        lane,
        start: r.start,
        end: r.end,
        equipment: r.eq,
        lead: lead.id,
        words: potWords(lead, onePan ? null : lane, null),
        short: verb3(potVerb(lead)),
        minutes: r.end - r.start,
        namesChapter: false,
        tasks: all.map((t) => t.id),
      });
    }
  }

  const chapters = chaptersOf({ onePan, total, prepEnd, blocks, pots, taskOf });
  const named = new Set(chapters.map((c) => c.pot).filter((k): k is string => k !== null));
  for (const p of pots) p.namesChapter = named.has(p.key);

  // Long waits: in a cook over 75 min, a gap of 30+ min in everything hands-on, after Prep.
  const allUnion = unionOf([
    ...blocks.map((b): Interval => [b.start, b.end]),
    ...(prepEnd ? [[0, prepEnd] as Interval] : []),
  ]);
  const breaks: TimetableBreak[] =
    total > BREAK_COOK_OVER
      ? gapsOf(allUnion, prepEnd, total)
          .filter(([a, b]) => b - a >= BREAK_MIN)
          .map(([a, b]) => ({ start: a, end: b, minutes: b - a }))
      : [];

  // Ahead: one note per lead time, named like a block.
  const byLead = new Map<string, CookTask[]>();
  for (const t of plan.tasks) {
    if (t.kind !== "ahead") continue;
    const k = t.lead ?? "ahead";
    const list = byLead.get(k) ?? [];
    list.push(t);
    byLead.set(k, list);
  }
  const ahead = [...byLead].map(([lead, ts]) => ({
    lead: lead.replace(/(\d)-(\d)/, "$1–$2"),
    name: blockName(ts, onePan ? null : ts[0].branch, true),
    tasks: ts.map((t) => t.id),
  }));

  return {
    onePan,
    lanes,
    total,
    prepEnd,
    prepTasks: prepMark ? [...prepMark.tasks] : [],
    segs,
    blocks,
    pots,
    chapters,
    breaks,
    ahead,
  };
}

interface DraftChapter {
  start: number;
  end: number;
  kind: TimetableChapterKind;
  name: string;
  /** A wait's stretches (the stove free). */
  gs: Interval[];
  pot: string | null;
}

/** SPEC §4. */
function chaptersOf(m: {
  onePan: boolean;
  total: number;
  prepEnd: number;
  blocks: Omit<TimetableBlock, "done">[];
  pots: Omit<TimetablePot, "done">[];
  taskOf: (id: string) => CookTask;
}): TimetableChapter[] {
  const { onePan, total, prepEnd, blocks, pots, taskOf } = m;
  const stoveUnion = unionOf([
    ...blocks.filter((b) => !b.sand).map((b): Interval => [b.start, b.end]),
    ...(prepEnd ? [[0, prepEnd] as Interval] : []),
  ]);
  const stretches = gapsOf(stoveUnion, prepEnd, total).filter(([a, b]) => b - a >= STRETCH_MIN);
  const cuts = [...new Set([0, ...(prepEnd ? [prepEnd] : []), ...stretches.map((g) => g[1]), total])].sort((a, b) => a - b);

  let ch: DraftChapter[] = [];
  for (let i = 0; i < cuts.length - 1; i++) {
    const a = cuts[i];
    const b = cuts[i + 1];
    const g = stretches.find((x) => x[1] === b);
    // The chapter that ends at the total is always the finish, even when the cook ends in a
    // hands-off stretch (past the mock, which made that a wait): its pot names no chapter.
    if (b === total) ch.push({ start: a, end: b, kind: "finish", name: "", gs: [], pot: null });
    else if (i === 0 && prepEnd && b === prepEnd) ch.push({ start: a, end: b, kind: "prep", name: "Prep", gs: [], pot: null });
    else if (g) ch.push({ start: a, end: b, kind: "wait", name: "", gs: [g], pot: null });
    else throw new Error(`timetable: a chapter cut at ${b} is neither the end of Prep, of a stretch, nor the total`);
  }

  // A wait folds into the next wait when under 8 min of work separates their stretches.
  for (let i = 0; i < ch.length - 1; i++) {
    const A = ch[i];
    const B = ch[i + 1];
    if (A.kind === "wait" && B.kind === "wait" && B.gs[0][0] - A.gs[A.gs.length - 1][1] < STRETCH_MIN) {
      A.end = B.end;
      A.gs = [...A.gs, ...B.gs];
      ch.splice(i + 1, 1);
      i--;
    }
  }

  // A wait is named for the pot it waits on most: food over equipment, then the longer pot.
  for (const c of ch) {
    if (c.kind !== "wait") continue;
    const ov = (p: { start: number; end: number }) =>
      c.gs.reduce((s, g) => s + Math.max(0, Math.min(p.end, g[1]) - Math.max(p.start, g[0])), 0);
    const pot = pots
      .filter((p) => ov(p) > 0)
      .sort((p, q) => ov(q) - ov(p) || Number(p.equipment) - Number(q.equipment) || q.end - q.start - (p.end - p.start))[0];
    // A stretch is the stove free while something minds itself, so a pot overlaps it; the mock's
    // "Wait" stands only for a stretch nothing minds (none in the corpus, which asserts it).
    c.name = pot ? cap(potWords(taskOf(pot.lead), onePan ? null : pot.lane, onePan ? null : pot.lane)) : "Wait";
    c.pot = pot ? pot.key : null;
  }

  const mergeSameNamed = () => {
    for (let i = 0; i < ch.length - 1; i++) {
      if (ch[i].kind === "wait" && ch[i + 1].kind === "wait" && ch[i].name === ch[i + 1].name) {
        ch[i].end = ch[i + 1].end;
        ch[i].gs = [...ch[i].gs, ...ch[i + 1].gs];
        ch.splice(i + 1, 1);
        i--;
      }
    }
  };
  mergeSameNamed();

  // Two chapters become one spanning both, keeping the longer one's kind and name, except that
  // a merge with the finish is the finish (it always ends the cook).
  const absorb = (i: number, j: number) => {
    const A = ch[i];
    const B = ch[j];
    const finish = [A, B].find((c) => c.kind === "finish");
    const keep = finish ?? (A.end - A.start >= B.end - B.start ? A : B);
    const merged: DraftChapter = { ...keep, start: Math.min(A.start, B.start), end: Math.max(A.end, B.end) };
    ch.splice(Math.min(i, j), 2, merged);
  };
  // A chapter merges into the one after it, unless that is the finish: then into the one before,
  // so the finish keeps its own span. Only a first chapter (a short Prep) with nothing but the
  // finish after it joins the finish.
  const partner = (i: number): number => (ch[i + 1]?.kind === "finish" && i > 0 ? i - 1 : i + 1);
  // A chapter under 4 min joins a neighbour; a short finish stays its own chapter (past the mock,
  // which folded it into the wait before it and so lost "Finish and plate").
  for (let i = 0; i < ch.length; i++) {
    if (ch.length > 1 && ch[i].kind !== "finish" && ch[i].end - ch[i].start < CHAPTER_MIN) {
      absorb(i, partner(i));
      i = -1;
    }
  }
  while (ch.length > MAX_CHAPTERS) {
    let bi = 1;
    let bl = Infinity;
    for (let i = 1; i < ch.length - 1; i++) {
      if (ch[i].end - ch[i].start < bl) {
        bl = ch[i].end - ch[i].start;
        bi = i;
      }
    }
    absorb(bi, partner(bi));
  }
  // Past the mock: the cap can leave two same-named waits side by side; they merge as SPEC §4.5 says.
  mergeSameNamed();

  const hadWait = ch.some((c) => c.kind === "wait");
  ch = ch.map((c) => (c.kind === "finish" ? { ...c, name: hadWait ? "Finish and plate" : "Cook and plate" } : c));
  return ch.map((c, i) => ({
    n: i + 1,
    kind: c.kind,
    name: c.name,
    headShort: c.kind === "finish" ? c.name.split(" ")[0] : null,
    start: c.start,
    end: c.end,
    minutes: c.end - c.start,
    pot: c.pot,
  }));
}

/** Minutes to drawn minutes for a mode's breaks: each break is drawn as `BREAK_DRAWN_MINUTES`. */
function drawnOf(breaks: readonly TimetableBreak[], t: number): number {
  let x = 0;
  let prev = 0;
  for (const b of breaks) {
    if (t <= b.start) return x + (t - prev);
    x += b.start - prev;
    if (t <= b.end) return x + ((t - b.start) * BREAK_DRAWN_MINUTES) / b.minutes;
    x += BREAK_DRAWN_MINUTES;
    prev = b.end;
  }
  return x + (t - prev);
}

/** A minute on the plan as drawn minutes on the timetable's axis (breaks compressed). */
export function drawnMinutes(t: Pick<Timetable, "breaks">, minutes: number): number {
  return drawnOf(t.breaks, minutes);
}

/**
 * The timetable for one prep mode. Takes the app's strips for both modes
 * (`strip()`), so both share one axis; `mode` picks which one this is. `now`
 * is the mode's strip's unless the caller passes its own clock; past the total
 * it holds at the end. An as-written plan, or one with no steps on the day
 * (all ahead work), has no timetable: null.
 */
export function buildTimetable(
  plan: CookPlan,
  stripFirst: Strip,
  stripGo: Strip,
  mode: PrepMode,
  options: { now?: number } = {},
): Timetable | null {
  if (stripFirst.asWritten || stripGo.asWritten) return null;
  // Nothing on the day to draw in either mode (an all-ahead plan): no timetable. Prep alone is
  // day-of work: a prep-only plan gets its prep block and a finish.
  if (!stripFirst.marks.length && !stripGo.marks.length) return null;
  const own = mode === "go" ? stripGo : stripFirst;
  const other = mode === "go" ? stripFirst : stripGo;
  const core = buildCore(plan, own, stripFirst);
  const otherCore = buildCore(plan, other, stripFirst);

  // The axis is 0 to the total (SPEC §6, §9): a cook run past the plan holds now at the end,
  // everything done, a pot whose timer carried it past the total too.
  const now = Math.min(core.total, Math.max(0, options.now ?? own.now));
  const done = (end: number) => end <= now || now >= core.total;
  const drawnEnd = drawnOf(core.breaks, core.total);
  const span = Math.max(drawnEnd, drawnOf(otherCore.breaks, otherCore.total));
  const inBreak = core.breaks.find((b) => now >= b.start && now < b.end);

  return {
    mode,
    onePan: core.onePan,
    lanes: core.lanes.map((name) => {
      const words = name.split(" ");
      return { name, short: words.length === 2 ? cap(words[1]) : name };
    }),
    total: core.total,
    now,
    toTable: Math.max(0, core.total - now),
    prep: core.prepEnd ? { start: 0, end: core.prepEnd, tasks: core.prepTasks, done: done(core.prepEnd) } : null,
    segments: core.segs.map(({ taskList: _list, ...seg }) => seg),
    blocks: core.blocks.map((b) => ({ ...b, done: done(b.end) })),
    pots: core.pots.map((p) => ({ ...p, done: done(p.end) })),
    chapters: core.chapters,
    breaks: core.breaks,
    nowBreak: inBreak ? { ...inBreak, left: inBreak.end - now } : null,
    ahead: core.ahead,
    axis: { drawnEnd, span },
  };
}
