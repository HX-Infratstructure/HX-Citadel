import { describe, expect, test } from "vitest";
import { cycleName, sprintEnd, sprintEndDate } from "./sprint";

describe("sprintEnd", () => {
  test("ends six days after the start, a seven-day sprint counting both days", () => {
    const start = Date.UTC(2026, 10, 18);
    expect(sprintEnd(start)).toBe(Date.UTC(2026, 10, 24));
  });
});

describe("sprintEndDate", () => {
  test("ends six calendar days after the start, a seven-day sprint counting both days", () => {
    expect(sprintEndDate("2026-11-18")).toBe("2026-11-24");
  });

  test("keeps seven days across the autumn clock change", () => {
    expect(sprintEndDate("2026-10-31")).toBe("2026-11-06");
  });

  test("keeps seven days across the spring clock change", () => {
    expect(sprintEndDate("2026-03-07")).toBe("2026-03-13");
  });

  test("rolls over the month and the year", () => {
    expect(sprintEndDate("2026-12-28")).toBe("2027-01-03");
  });
});

describe("cycleName", () => {
  test("a named cycle keeps its name and an unnamed one is numbered", () => {
    expect(cycleName({ name: "Sprint A", number: 3 })).toBe("Sprint A");
    expect(cycleName({ number: 3 })).toBe("Cycle 3");
  });
});
