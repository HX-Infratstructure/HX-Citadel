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

const row = (sortOrder: number, _creationTime: number) => ({ sortOrder, _creationTime });
const rankOf = (ranks: ReturnType<typeof respaceTie<ReturnType<typeof row>>>, r: ReturnType<typeof row>) =>
  ranks!.others.find((other) => other.row === r)!.sortOrder;

describe("respaceTie", () => {
  test("puts a row moved between two tied rows strictly between them, the pair in its listed order", () => {
    const older = row(5000, 1);
    const newer = row(5000, 2);
    const ranks = respaceTie(5000, [older, newer], 8000);
    expect([rankOf(ranks, newer), ranks!.moved, rankOf(ranks, older)]).toEqual([7000, 6000, 5000]);
  });

  test("keeps every re-spaced rank at or above the tie and below the next higher rank", () => {
    const tied = [row(5000, 1), row(5000, 2), row(5000, 3)];
    const ranks = respaceTie(5000, tied, 5001)!;
    const all = [...ranks.others.map((other) => other.sortOrder), ranks.moved];
    expect(new Set(all).size).toBe(4);
    expect(Math.min(...all)).toBe(5000);
    expect(Math.max(...all)).toBeLessThan(5001);
  });

  test("steps a full gap apart at the top of the list", () => {
    const older = row(1000, 1);
    const newer = row(1000, 2);
    const ranks = respaceTie(1000, [older, newer]);
    expect([rankOf(ranks, newer), ranks!.moved, rankOf(ranks, older)]).toEqual([1000 + 2 * SORT_GAP, 1000 + SORT_GAP, 1000]);
  });

  test("has no ranks to give when the gap to the next higher rank holds no new number", () => {
    expect(respaceTie(1000, [row(1000, 1)], 1000.0000000000001)).toBeUndefined();
  });

  test("re-spaces the rows above the tie into the run, below the next higher rank, and keeps the tie at the bottom", () => {
    const tied = row(1000, 1);
    const up = row(1000.0000000000001, 2);
    const ranks = respaceTie(1000, [tied, up], 2000);
    expect(rankOf(ranks, up)).toBeGreaterThan(rankOf(ranks, tied));
    expect(rankOf(ranks, tied)).toBeGreaterThan(ranks!.moved);
    expect(ranks!.moved).toBe(1000);
    expect(rankOf(ranks, up)).toBeLessThan(2000);
  });

  test("lands a row moved into a tie of three inside the run, at its middle slot", () => {
    const [first, second, third] = [row(5000, 1), row(5000, 2), row(5000, 3)];
    const ranks = respaceTie(5000, [first, second, third], 9000);
    expect([rankOf(ranks, third), rankOf(ranks, second), ranks!.moved, rankOf(ranks, first)]).toEqual([8000, 7000, 6000, 5000]);
  });

  test("fits a two-row tie with nothing ranked higher at 2^62 and at -2^62, and has no ranks to give at 2^63", () => {
    const tieAt = (tie: number) => respaceTie(tie, [row(tie, 1), row(tie, 2)]);
    expect(tieAt(2 ** 62)).toBeDefined();
    expect(tieAt(-(2 ** 62))).toBeDefined();
    expect(tieAt(2 ** 63)).toBeUndefined();
  });
});

const X = 1000.0000000000001;
const B = 1000;
const D = 999.9999999999999;

describe("rankInLoaded", () => {
  test("accepts a drop whose midpoint ties a row that is not a neighbour, which the server re-spaces upward (CodeRabbit 4623501051)", () => {
    expect((X + D) / 2).toBe(B);
    expect(rankInLoaded({ above: X, floor: D, moreToLoad: true })).toEqual({ sortOrder: B });
    expect(rankInLoaded({ above: X, floor: D, moreToLoad: false })).toEqual({ sortOrder: X - SORT_GAP });
  });

  test("accepts a harmless tie on the 1000-step grid (thermos round 3)", () => {
    expect(rankInLoaded({ above: 300000, below: 298000, floor: 51000, moreToLoad: true })).toEqual({ sortOrder: 299000 });
  });

  test("refuses a drop between two loaded neighbours too close for a distinct midpoint, loaded or not (CodeRabbit 4623425278)", () => {
    for (const moreToLoad of [true, false]) {
      expect(rankInLoaded({ above: 1000, below: D, floor: D, moreToLoad })).toEqual({ refused: "noRoom" });
      expect(rankInLoaded({ above: 1000, below: D, floor: 0, moreToLoad })).toEqual({ refused: "noRoom" });
    }
  });

  test("refuses for room when the midpoint equals the upper or the lower neighbour, loaded or not", () => {
    expect((900 + 899.9999999999999) / 2).toBe(900);
    expect((900.0000000000001 + 900) / 2).toBe(900);
    for (const moreToLoad of [true, false]) {
      expect(rankInLoaded({ above: 900, below: 899.9999999999999, floor: 0, moreToLoad })).toEqual({ refused: "noRoom" });
      expect(rankInLoaded({ above: 900.0000000000001, below: 900, floor: 0, moreToLoad })).toEqual({ refused: "noRoom" });
    }
  });

  test("asks to load more when the floor stands in for a lower neighbour too close to place against", () => {
    expect(rankInLoaded({ above: 1000, floor: D, moreToLoad: true })).toEqual({ refused: "loadMore" });
    expect(rankInLoaded({ above: X, floor: 1000, moreToLoad: true })).toEqual({ refused: "loadMore" });
  });

  test("places a drop between two cards tied above the floor, loaded or not", () => {
    expect(rankInLoaded({ above: 30, below: 30, floor: 10, moreToLoad: true })).toEqual({ sortOrder: 30 });
    expect(rankInLoaded({ above: 30, below: 30, floor: 10, moreToLoad: false })).toEqual({ sortOrder: 30 });
  });

  test("refuses a drop between two rows tied at the floor while more is to load", () => {
    expect(rankInLoaded({ above: 1000, below: 1000, floor: 1000, moreToLoad: true })).toEqual({ refused: "loadMore" });
  });

  test("lands a bottom drop between its upper neighbour and the floor while more is to load", () => {
    expect(rankInLoaded({ above: 3000, floor: 1000, moreToLoad: true })).toEqual({ sortOrder: 2000 });
  });

  test("refuses a bottom drop when the row above it is the floor", () => {
    expect(rankInLoaded({ above: 1000, floor: 1000, moreToLoad: true })).toEqual({ refused: "loadMore" });
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
    expect(rankInLoaded({ floor: 1000, moreToLoad: false })).toEqual({ refused: "noRoom" });
    expect(rankInLoaded({ above: 3000, moreToLoad: true })).toEqual({ refused: "loadMore" });
  });
});
