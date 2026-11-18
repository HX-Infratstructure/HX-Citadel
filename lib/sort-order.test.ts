import { describe, expect, test } from "vitest";
import { SORT_GAP, sortOrderBetween } from "./sort-order";

describe("sortOrderBetween", () => {
  test("takes the midpoint between two neighbors", () => {
    expect(sortOrderBetween(3000, 1000)).toBe(2000);
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
