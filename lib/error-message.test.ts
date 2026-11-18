import { describe, expect, test } from "vitest";
import { errorMessage } from "./error-message";

describe("errorMessage", () => {
  test.each([
    [
      "a Convex server error, trimmed to the thrown line",
      new Error(
        "[CONVEX M(issues:update)] [Request ID: 1a2b] Server Error\nUncaught Error: Can't move ENG-1 to Done: open — ENG-1.2 Write API\n    at assertDoneGate (../convex/lib/rules/doneGate.ts:70:10)\n\n  Called by client"
      ),
      "Can't move ENG-1 to Done: open — ENG-1.2 Write API",
    ],
    ["a plain error, as is", new Error("Team not found"), "Team not found"],
    ["a multi-line plain error, its first line", new Error("First line\n    at x"), "First line"],
    ["an empty error, the fallback", new Error(""), "Failed to move issue"],
    ["a non-error, the fallback", "boom", "Failed to move issue"],
  ])("%s", (_label, error, expected) => {
    expect(errorMessage(error, "Failed to move issue")).toBe(expected);
  });
});
