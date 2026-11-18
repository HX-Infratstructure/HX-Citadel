import { describe, expect, test } from "vitest";
import { DAY_MS, sprintEnd } from "./sprint";

describe("sprintEnd", () => {
  test("ends six days after the start, a seven-day sprint counting both days", () => {
    const start = Date.UTC(2026, 10, 18);
    expect(sprintEnd(start) - start).toBe(6 * DAY_MS);
  });
});
