/**
 * Seeded random cook plans for the scheduler's property tests.
 *
 * Plans are acyclic and follow the kind rules validation enforces (mise needs
 * only mise or ahead work, ahead needs only ahead work), but are otherwise
 * unconstrained: steps out of order, several branches, steps with no need
 * between them, assumed tasks, missing estimates and hands-off prep. The same
 * seed always gives the same plans, so a failure names a plan to replay.
 */

import { COOK_PLAN_VERSION, type CookPlan, type CookTask } from "../cook-plan";

/** A deterministic generator of numbers in [0, 1). */
export function seeded(seed: number): () => number {
  let state = seed >>> 0;
  return () => {
    state = (Math.imul(state, 1103515245) + 12345) >>> 0;
    return (state >>> 1) / 0x80000000;
  };
}

export function randomCookPlan(rnd: () => number): CookPlan {
  const pick = <T>(xs: readonly T[]): T => xs[Math.floor(rnd() * xs.length)];
  const some = <T>(xs: readonly T[], p: number) => xs.filter(() => rnd() < p);
  const shuffle = <T>(xs: T[]) => {
    for (let i = xs.length - 1; i > 0; i--) {
      const j = Math.floor(rnd() * (i + 1));
      [xs[i], xs[j]] = [xs[j], xs[i]];
    }
  };
  const branches = ["Cook", "Sauce", "Side"].slice(0, 1 + Math.floor(rnd() * 3));
  const minutes = (): CookTask["minutes"] =>
    rnd() < 0.2
      ? undefined
      : { est: pick([0.1, 1, 1.2, 2, 2.5, 3, 5, 8, 10, 15, 20, 30]), handsOff: rnd() < 0.35 };

  const tasks: CookTask[] = [];
  const add = (
    id: string,
    kind: CookTask["kind"],
    sourceStep: number | null,
    needs: string[],
  ) => {
    const task: CookTask = {
      id,
      kind,
      text: id,
      label: id,
      ingredientIdx: [],
      sourceStep,
      implied: sourceStep === null,
      needs,
      branch: pick(branches),
    };
    const m = minutes();
    if (m) task.minutes = m;
    tasks.push(task);
    return task;
  };

  const aheads: CookTask[] = [];
  const nAhead = Math.floor(rnd() * 3);
  for (let i = 0; i < nAhead; i++) {
    aheads.push(add(`a${i}`, "ahead", null, some(aheads, 0.3).map((x) => x.id)));
  }

  const nCook = 2 + Math.floor(rnd() * 7);
  const steps = Array.from({ length: nCook }, (_, i) => i);
  if (rnd() < 0.5) shuffle(steps);

  const mises: CookTask[] = [];
  const nMise = Math.floor(rnd() * 6);
  for (let i = 0; i < nMise; i++) {
    const needs = [...some(mises, 0.25), ...some(aheads, 0.2)].map((x) => x.id);
    const step = rnd() < 0.5 ? null : Math.floor(rnd() * nCook);
    mises.push(add(`m${i}`, "mise", step, needs));
  }

  // Cook tasks in a topological order; each may need any earlier cook task.
  const cooks: CookTask[] = [];
  for (let i = 0; i < nCook; i++) {
    const needs = [...some(cooks, 0.3), ...some(mises, 0.3), ...some(aheads, 0.1)];
    if (i > 0 && rnd() < 0.5) needs.push(cooks[i - 1]);
    const step = rnd() < 0.08 ? null : steps[i];
    cooks.push(add(`c${i}`, "cook", step, [...new Set(needs.map((x) => x.id))]));
  }

  // Every mise and ahead task feeds something.
  const consumed = new Set(tasks.flatMap((x) => x.needs));
  for (const m of [...aheads, ...mises]) {
    if (!consumed.has(m.id)) pick(cooks).needs.push(m.id);
  }

  if (rnd() < 0.5) shuffle(tasks);
  return { version: COOK_PLAN_VERSION, tasks };
}
