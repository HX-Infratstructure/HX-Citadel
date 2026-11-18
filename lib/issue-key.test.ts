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

  test.each(["epic", "feature"] as const)("a %s has no key", (kind) => {
    expect(formatIssueKey("HXT", { kind })).toBeNull();
  });
});
