import { describe, expect, test } from "vitest";
import { rankInLoaded, respaceTie, SORT_GAP, sortOrderBetween } from "./sort-order";

describe("sortOrderBetween", () => {
  test("takes the midpoint between two neighbors", () => {
    expect(sortOrderBetween(5000, 1000)).toBe(3000);
  });

  test("ranks above the first row when dropped at the top", () => {
    expect(sortOrderBetween(undefined, 1000)).toBe(1000 + SORT_GAP);
  });

  test("ranks below the last row when dropped at the bottom", () => {
    expect(sortOrderBetween(1000, undefined)).toBe(1000 - SORT_GAP);
  });

  test("has no rank to give in an empty list", () => {
    expect(sortOrderBetween(undefined, undefined)).toBeUndefined();
  });
});

describe("respaceTie", () => {
  test("puts a row moved between two tied rows strictly between them", () => {
    const { tied, moved } = respaceTie(5000, 2, 2000)!;
    expect(tied).toEqual([5000, 3000]);
    expect(moved).toBe(4000);
  });

  test("keeps every re-spaced rank above the next lower rank", () => {
    const { tied, moved } = respaceTie(5000, 3, 4999)!;
    const ranks = [tied[0], tied[1], moved, tied[2]];
    expect(ranks).toEqual([...ranks].sort((a, b) => b - a));
    expect(new Set(ranks).size).toBe(4);
    expect(Math.min(...ranks)).toBeGreaterThan(4999);
  });

  test("steps a full gap apart at the bottom of the list", () => {
    const { tied, moved } = respaceTie(1000, 2)!;
    expect(tied).toEqual([1000, 1000 - 2 * SORT_GAP]);
    expect(moved).toBe(1000 - SORT_GAP);
  });

  test("has no ranks to give when the gap to the next lower rank holds no new number", () => {
    expect(respaceTie(1000, 1, 999.9999999999999)).toBeUndefined();
  });

  test("re-spaces the rows below the tie into the run, above the next lower rank", () => {
    const { tied, moved, below } = respaceTie(1000, 1, 0, 1)!;
    const ranks = [tied[0], moved, below[0]];
    expect(ranks).toEqual([...ranks].sort((a, b) => b - a));
    expect(new Set(ranks).size).toBe(3);
    expect(Math.min(...ranks)).toBeGreaterThan(0);
    expect(tied[0]).toBe(1000);
  });
});

describe("rankInLoaded", () => {
  test("refuses a drop between two rows tied at the floor while more is to load", () => {
    expect(rankInLoaded({ above: 1000, below: 1000, floor: 1000, moreToLoad: true })).toEqual({ refused: true });
  });

  test("lands a bottom drop between its upper neighbour and the floor while more is to load", () => {
    expect(rankInLoaded({ above: 3000, floor: 1000, moreToLoad: true })).toEqual({ sortOrder: 2000 });
  });

  test("refuses a bottom drop when the row above it is the floor", () => {
    expect(rankInLoaded({ above: 1000, floor: 1000, moreToLoad: true })).toEqual({ refused: true });
  });

  test("ranks below the bottom row once everything is loaded", () => {
    expect(rankInLoaded({ above: 1000, floor: 1000, moreToLoad: false })).toEqual({ sortOrder: 1000 - SORT_GAP });
    expect(rankInLoaded({ above: 1000, below: 1000, floor: 1000, moreToLoad: false })).toEqual({ sortOrder: 1000 });
  });

  test("ranks top and middle drops against their loaded neighbours", () => {
    expect(rankInLoaded({ below: 3000, floor: 1000, moreToLoad: true })).toEqual({ sortOrder: 3000 + SORT_GAP });
    expect(rankInLoaded({ above: 5000, below: 3000, floor: 1000, moreToLoad: true })).toEqual({ sortOrder: 4000 });
  });

  test("refuses when there is nothing to rank against", () => {
    expect(rankInLoaded({ floor: 1000, moreToLoad: false })).toEqual({ refused: true });
    expect(rankInLoaded({ above: 3000, moreToLoad: true })).toEqual({ refused: true });
  });
});
