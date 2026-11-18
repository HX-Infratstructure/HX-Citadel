import { describe, expect, test } from "vitest";
import { cycleName, DAY_MS, sprintEnd } from "./sprint";

describe("sprintEnd", () => {
  test("ends six days after the start, a seven-day sprint counting both days", () => {
    const start = Date.UTC(2026, 10, 18);
    expect(sprintEnd(start) - start).toBe(6 * DAY_MS);
  });
});

describe("cycleName", () => {
  test("a named cycle keeps its name and an unnamed one is numbered", () => {
    expect(cycleName({ name: "Sprint A", number: 3 })).toBe("Sprint A");
    expect(cycleName({ number: 3 })).toBe("Cycle 3");
  });
});
