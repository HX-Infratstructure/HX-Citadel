import { describe, expect, test } from "vitest";
import { formatIssueKey } from "./issue-key";

describe("formatIssueKey", () => {
  test("a story is KEY-number", () => {
    expect(formatIssueKey("HXT", { kind: "story", number: 12 })).toBe("HXT-12");
  });

  test("a subtask is KEY-storyNumber.subNumber", () => {
    expect(formatIssueKey("HXT", { kind: "subtask", subNumber: 3 }, 12)).toBe(
      "HXT-12.3"
    );
  });

  test.each([
    ["a subtask without its story number", { kind: "subtask", subNumber: 1 }, undefined],
    ["a subtask without its subNumber", { kind: "subtask" }, 12],
    ["a story without a number", { kind: "story" }, undefined],
  ] as const)("%s has no key", (_label, issue, parentNumber) => {
    expect(formatIssueKey("HXT", issue, parentNumber)).toBeNull();
  });

  test.each(["epic", "feature"] as const)("a %s has no key", (kind) => {
    expect(formatIssueKey("HXT", { kind })).toBeNull();
  });
});
