// @vitest-environment happy-dom
import { cleanup, render } from "@testing-library/react";
import { afterEach, describe, expect, it } from "vitest";
import type { AheadWork, ShownTimes } from "@/lib/kitchen/recipe-times";
import { timeLine } from "@/lib/kitchen/time-line";
import { TimeLineWords } from "./TimeLineWords";

// The time line's words as every surface draws them (T2 fix round 1, critic
// gap 7): where the line must break, it breaks at "+", so the ahead job
// reads whole on a line of its own.

afterEach(cleanup);

const NO_AHEAD: AheadWork = { leads: [], unled: 0 };
const plan: ShownTimes = { source: "plan", total: 75, handsOn: 15, ahead: NO_AHEAD };
const none: ShownTimes = { source: "none", reason: "no-plan", ahead: NO_AHEAD };
const marinate = { label: "marinate chicken", lead: "at least 4 hours before" };
/** Text with its no-break spaces as plain ones, to read as written. */
const plain = (text: string | null | undefined) => text?.replaceAll(" ", " ");

function drawn(parts: string[]) {
  const { container } = render(
    <p>
      <TimeLineWords parts={parts} />
    </p>,
  );
  return container.firstElementChild as HTMLElement;
}

describe("TimeLineWords", () => {
  it("says the line as its text joins it", () => {
    const parts = timeLine(plan, marinate)!;
    expect(drawn(parts).textContent).toBe(parts.join(" "));
    expect(plain(drawn(parts).textContent)).toBe(
      "1 h 15 · 15 min hands-on + marinate chicken at least 4 hours ahead",
    );
  });

  it("holds the ahead job as one piece, so a wrap falls at its +", () => {
    const line = drawn(timeLine(plan, marinate)!);
    const pieces = line.querySelectorAll("span");
    expect(pieces).toHaveLength(1);
    expect(plain(pieces[0]!.textContent)).toBe("+ marinate chicken at least 4 hours ahead");
    expect(pieces[0]!.className.split(/\s+/)).toContain("inline-block");
    // The minutes before it stay plain words, the row's measure reading them.
    expect(line.firstChild).toBeInstanceOf(Text);
  });

  it("draws plain words where there is no + to break at", () => {
    expect(drawn(timeLine(plan, null)!).querySelector("span")).toBeNull();
    const aheadOnly = drawn(timeLine(none, marinate)!);
    expect(plain(aheadOnly.textContent)).toBe("Marinate chicken at least 4 hours ahead");
    expect(aheadOnly.querySelector("span")).toBeNull();
  });
});
