/**
 * The Cook Log's rules over a grid: a real grid kept in memory (rows of
 * text, counted from 1), in a kitchen set to New York so a day's edge and an
 * hour's offset both show.
 */

import { beforeEach, describe, expect, it, vi } from "vitest";

vi.mock("../kitchen/zone", () => ({ KITCHEN_TIME_ZONE: "America/New_York" }));

import type { CookLogRef } from "../../../drizzle/schema";
import {
  CookLogRowMoved,
  adoptableRow,
  appendCookLog,
  cookLogRating,
  cookLogTimestamp,
  cookRow,
  fetchRecentCookLog,
  normalizeRecipeName,
  rateCookLog,
  recentCooks,
  retimeCookLog,
} from "./cook-log";
import { COOK_LOG_COLUMNS, type CookLogGrid } from "./types";

const HEADER = [...COOK_LOG_COLUMNS];

/** A grid in memory, and every write made to it. */
function memoryGrid(initial: string[][] = [HEADER]) {
  const rows = initial.map((row) => [...row]);
  const writes: Array<{ row: number; col: number; values: string[] }> = [];
  const grid: CookLogGrid = {
    read: async () => rows.map((row) => [...row]),
    append: async (row) => rows.push([...row]),
    write: async (row, col, values) => {
      writes.push({ row, col, values });
      const cells = (rows[row - 1] ??= []);
      values.forEach((value, i) => {
        cells[col - 1 + i] = value;
      });
    },
  };
  return { grid, rows, writes };
}

/** 2026-10-04 19:02 in New York. */
const DONE = new Date("2026-10-04T23:02:00Z");
const DAL: CookLogRef = { row: 2, timestamp: "2026-10-04 19:02", recipeName: "Dal", adopted: false };

describe("cookLogTimestamp", () => {
  it("writes the kitchen's wall clock, to the minute, in 24 hours", () => {
    expect(cookLogTimestamp(DONE)).toBe("2026-10-04 19:02");
    expect(cookLogTimestamp(new Date("2026-10-05T04:00:00Z"))).toBe("2026-10-05 00:00");
  });

  it("dates a late cook by the kitchen's day, not UTC's", () => {
    // 03:30 UTC on the 5th is still the evening of the 4th in New York.
    expect(cookLogTimestamp(new Date("2026-10-05T03:30:00Z"))).toBe("2026-10-04 23:30");
  });
});

describe("normalizeRecipeName", () => {
  it("ignores case, outer space and runs of space", () => {
    expect(normalizeRecipeName("  Dal   and  Rice ")).toBe("dal and rice");
  });
});

describe("appendCookLog", () => {
  it("appends the cook as text and answers with the row it landed on", async () => {
    const { grid, rows } = memoryGrid();
    expect(await appendCookLog(grid, { name: " Dal ", at: DONE })).toEqual(DAL);
    expect(rows).toEqual([HEADER, ["2026-10-04 19:02", "Dal", "Dal", "", ""]]);
  });

  it("adopts a row another writer logged that day, the latest of several, and appends nothing", async () => {
    const { grid, rows } = memoryGrid([
      HEADER,
      ["2026-10-04 12:10", "dal", "dal", "", ""],
      ["2026-10-04 18:30", "DAL ", "dal", "4", ""],
      ["2026-10-04 18:45", "Rice", "rice", "", ""],
    ]);
    expect(await appendCookLog(grid, { name: "Dal", at: DONE })).toEqual({
      row: 3,
      timestamp: "2026-10-04 18:30",
      recipeName: "DAL ",
      adopted: true,
    });
    expect(rows).toHaveLength(4);
  });

  it("logs the same dish again on another day", async () => {
    const { grid, rows } = memoryGrid([HEADER, ["2026-10-03 19:00", "Dal", "Dal", "5", ""]]);
    expect(await appendCookLog(grid, { name: "Dal", at: DONE })).toEqual({ ...DAL, row: 3 });
    expect(rows).toHaveLength(3);
  });

  it("refuses a cook with no name before it reads anything", async () => {
    const read = vi.fn();
    await expect(
      appendCookLog({ read, append: vi.fn(), write: vi.fn() }, { name: "   ", at: DONE }),
    ).rejects.toThrow("no recipe name");
    expect(read).not.toHaveBeenCalled();
  });

  it("fails when the grid doesn't say which row it appended", async () => {
    const { grid } = memoryGrid();
    grid.append = async () => Number.NaN;
    await expect(appendCookLog(grid, { name: "Dal", at: DONE })).rejects.toThrow(
      "Cook Log append returned no row number",
    );
  });

  it("passes on a grid's failure", async () => {
    const { grid } = memoryGrid();
    grid.read = async () => {
      throw new Error("503 unavailable");
    };
    await expect(appendCookLog(grid, { name: "Dal", at: DONE })).rejects.toThrow("503 unavailable");
  });
});

describe("adoptableRow", () => {
  it("is null when the day holds no such cook", () => {
    expect(adoptableRow([HEADER], "Dal", "2026-10-04 19:02")).toBeNull();
    expect(adoptableRow([], "Dal", "2026-10-04 19:02")).toBeNull();
  });
});

describe("cookRow", () => {
  const rows = [HEADER, ["2026-10-04 19:02", "Dal"], ["2026-10-04 20:15", "Rice"]];

  it("is the stored row while it still holds the cook", () => {
    expect(cookRow(rows, DAL)).toBe(2);
  });

  it("finds the one row that holds the cook after the log was sorted or grew above it", () => {
    expect(cookRow([HEADER, ["2026-10-01 18:00", "Soup"], ...rows.slice(1)], DAL)).toBe(3);
  });

  it("gives up when no row, or more than one, holds the cook", () => {
    expect(() => cookRow([HEADER], DAL)).toThrow(CookLogRowMoved);
    const twice = [HEADER, ["2026-10-01 18:00", "Soup"], rows[1], rows[1]];
    expect(() => cookRow(twice, DAL)).toThrow("Cook Log row 2 no longer holds \"Dal\" at 2026-10-04 19:02, and 2 rows do");
  });

  it("reads a stored row past the log's end as moved, not as a failure to read", () => {
    expect(() => cookRow([HEADER], { ...DAL, row: 40 })).toThrow("and no other row does");
  });
});

describe("rateCookLog", () => {
  let log: ReturnType<typeof memoryGrid>;
  beforeEach(() => {
    log = memoryGrid([HEADER, ["2026-10-04 19:02", "Dal", "Dal", "", "keep me"]]);
  });

  it("writes the rating as text into the rating column, leaving a note that is there", async () => {
    expect(await rateCookLog(log.grid, DAL, 4)).toEqual(DAL);
    expect(log.writes).toEqual([{ row: 2, col: 4, values: ["4"] }]);
    expect(log.rows[1]).toEqual(["2026-10-04 19:02", "Dal", "Dal", "4", "keep me"]);
  });

  it("writes a note beside the rating, trimmed", async () => {
    await rateCookLog(log.grid, DAL, 5, "  less leek  ");
    expect(log.writes).toEqual([{ row: 2, col: 4, values: ["5", "less leek"] }]);
  });

  it("writes into the row the cook moved to, and says where that is", async () => {
    log = memoryGrid([HEADER, ["2026-10-01 18:00", "Soup"], ["2026-10-04 19:02", "Dal"]]);
    expect(await rateCookLog(log.grid, DAL, 3)).toEqual({ ...DAL, row: 3 });
    expect(log.writes).toEqual([{ row: 3, col: 4, values: ["3"] }]);
  });

  it("refuses a rating that isn't a whole number from 1 to 5, and one for a row that is gone, writing nothing", async () => {
    for (const rating of [0, 6, 2.5]) {
      await expect(rateCookLog(log.grid, DAL, rating)).rejects.toThrow(`Invalid rating: ${rating}`);
    }
    await expect(rateCookLog(memoryGrid().grid, DAL, 4)).rejects.toBeInstanceOf(CookLogRowMoved);
    expect(log.writes).toEqual([]);
  });
});

describe("cookLogRating", () => {
  it("reads the rating as written, and null for none", async () => {
    const rated = memoryGrid([HEADER, ["2026-10-04 19:02", "Dal", "Dal", " 4 "]]);
    expect(await cookLogRating(rated.grid, DAL)).toEqual({ log: DAL, rating: "4" });
    const unrated = memoryGrid([HEADER, ["2026-10-04 19:02", "Dal"]]);
    expect(await cookLogRating(unrated.grid, DAL)).toEqual({ log: DAL, rating: null });
  });
});

describe("retimeCookLog", () => {
  it("rewrites the timestamp alone, so the rating and the note stay", async () => {
    const log = memoryGrid([HEADER, ["2026-10-04 19:02", "Dal", "Dal", "4", "less leek"]]);
    const later = new Date("2026-10-04T23:40:00Z");
    expect(await retimeCookLog(log.grid, DAL, later)).toEqual({ ...DAL, timestamp: "2026-10-04 19:40" });
    expect(log.writes).toEqual([{ row: 2, col: 1, values: ["2026-10-04 19:40"] }]);
    expect(log.rows[1]).toEqual(["2026-10-04 19:40", "Dal", "Dal", "4", "less leek"]);
  });
});

describe("recentCooks", () => {
  const rows = [
    HEADER,
    ["2026-10-01 18:00", "Soup", "Soup", "4", ""],
    ["2026-10-02 18:00", "", "", "", "a row with no dish"],
    ["2026-10-03 18:00", " Dal ", "Dal", "", "  less leek "],
    ["not a date", "Rice"],
  ];

  it("reads the newest first, skipping the header and rows with no dish", () => {
    expect(recentCooks(rows).map((cook) => cook.name)).toEqual(["Rice", "Dal", "Soup"]);
  });

  it("reads a rating as a number and a note trimmed, and leaves out what isn't there", () => {
    const [rice, dal, soup] = recentCooks(rows);
    expect(rice).toEqual({ name: "Rice", date: null, rating: null, notes: null });
    expect(dal).toMatchObject({ name: "Dal", rating: null, notes: "less leek" });
    expect(soup).toMatchObject({ name: "Soup", rating: 4, notes: null });
    expect(soup.date).toBeInstanceOf(Date);
  });

  it("keeps the last `limit` cooks, and none of an empty log", async () => {
    expect(recentCooks(rows, 2).map((cook) => cook.name)).toEqual(["Rice", "Dal"]);
    expect(recentCooks([HEADER])).toEqual([]);
    expect(recentCooks([])).toEqual([]);
    expect(await fetchRecentCookLog(memoryGrid(rows).grid, 1)).toHaveLength(1);
  });
});
