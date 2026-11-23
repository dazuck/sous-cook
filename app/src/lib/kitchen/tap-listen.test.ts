import { describe, expect, it } from "vitest";
import {
  COMMAND_QUIET_MS,
  QUIET_MS,
  heardSoFar,
  quietToEnd,
  type HeardResult,
} from "./tap-listen";

const final = (transcript: string): HeardResult => ({ transcript, isFinal: true });
const interim = (transcript: string): HeardResult => ({ transcript, isFinal: false });

describe("heardSoFar", () => {
  it("is nothing, and final, before any words", () => {
    expect(heardSoFar([])).toEqual({ text: "", final: true });
    expect(heardSoFar([interim("  "), final("…")])).toEqual({ text: "", final: true });
  });

  it("joins the session's results in order, as one question across a pause", () => {
    expect(
      heardSoFar([final("The butter is still a little bit cold"), final(" should I melt it first")]),
    ).toEqual({ text: "The butter is still a little bit cold should I melt it first", final: true });
  });

  it("counts the words still being heard, and is not final while any are", () => {
    expect(heardSoFar([final("The butter is still cold"), interim(" should I")])).toEqual({
      text: "The butter is still cold should I",
      final: false,
    });
  });

  it("keeps the longer of two results where one carries the other (Chrome on Android repeats)", () => {
    expect(heardSoFar([final("is the oil"), final("is the oil hot enough")])).toEqual({
      text: "is the oil hot enough",
      final: true,
    });
    expect(heardSoFar([final("next"), final("Next.")])).toEqual({ text: "Next.", final: true });
  });

  it("keeps a word that only starts like the last result's", () => {
    expect(heardSoFar([final("salt"), final("salty enough")]).text).toBe("salt salty enough");
  });
});

describe("quietToEnd", () => {
  it("ends at once on a whole command Chrome has settled, as a tap always has", () => {
    expect(quietToEnd({ text: "next", final: true })).toBe(0);
    expect(quietToEnd({ text: "Sue, back", final: true })).toBe(0);
  });

  it("gives a command still being heard a short quiet, so “next few” isn't taken as “next”", () => {
    expect(quietToEnd({ text: "next", final: false })).toBe(COMMAND_QUIET_MS);
  });

  it("waits through a pause after anything else", () => {
    expect(quietToEnd({ text: "The butter is still a little bit cold", final: true })).toBe(QUIET_MS);
    expect(quietToEnd({ text: "salt", final: true })).toBe(QUIET_MS);
  });

  it("waits longer than a command's quiet, which stays under Chrome's own pause", () => {
    expect(COMMAND_QUIET_MS).toBeLessThan(1000);
    expect(QUIET_MS).toBeGreaterThan(COMMAND_QUIET_MS);
  });
});
