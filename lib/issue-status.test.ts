import { describe, expect, test } from "vitest";
import { GATED_STATUSES, isGatedStatus, statusesFor } from "./issue-status";

const ALL = (["backlog", "todo", "in_progress", "in_review", "done", "canceled"] as const).map(
  (value) => ({ value })
);

describe("GATED_STATUSES", () => {
  test("holds exactly In Review and Done", () => {
    expect([...GATED_STATUSES].sort()).toEqual(["done", "in_review"]);
  });

  test("isGatedStatus accepts only the gated statuses", () => {
    expect(isGatedStatus("in_review")).toBe(true);
    expect(isGatedStatus("done")).toBe(true);
    expect(isGatedStatus("backlog")).toBe(false);
    expect(isGatedStatus("todo")).toBe(false);
    expect(isGatedStatus("in_progress")).toBe(false);
    expect(isGatedStatus("canceled")).toBe(false);
  });
});

describe("statusesFor", () => {
  test("a new story is offered no gated status", () => {
    expect(statusesFor(ALL, "story").map((s) => s.value)).toEqual([
      "backlog",
      "todo",
      "in_progress",
      "canceled",
    ]);
  });

  test("a new epic or feature is offered every status", () => {
    expect(statusesFor(ALL, "epic")).toEqual(ALL);
    expect(statusesFor(ALL, "feature")).toEqual(ALL);
  });
});
