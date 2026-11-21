import { describe, expect, test } from "vitest";
import { seededRandom } from "./seeded-random.fixture";

const draws = (seed: number) => {
  const next = seededRandom(seed);
  return Array.from({ length: 50 }, () => next());
};

describe("seededRandom", () => {
  test("the same seed replays the same draws, so a failing trial can be rerun by its seed", () => {
    expect(draws(42)).toEqual(draws(42));
  });

  test("different seeds give different draws, so the seed is not ignored", () => {
    expect(draws(1)).not.toEqual(draws(2));
  });
});
