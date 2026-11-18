import { ConvexError, type Value } from "convex/values";
import { describe, expect, test } from "vitest";
import { errorMessage } from "./error-message";

/** What the Convex client throws for a failed mutation: its header, the server's message, then "Called by client". */
function convexServerError(serverMessage: string): Error {
  return new Error(`[CONVEX M(issues:update)] ${serverMessage}\n  Called by client`);
}

describe("errorMessage", () => {
  test.each([
    [
      "a Convex server error, trimmed to the thrown line",
      convexServerError(
        "[Request ID: 1a2b] Server Error\nUncaught Error: Can't move ENG-1 to Done: open — ENG-1.2 Write API\n    at assertDoneGate (../convex/lib/rules/doneGate.ts:70:10)\n"
      ),
      "Can't move ENG-1 to Done: open — ENG-1.2 Write API",
    ],
    [
      "a Convex server error with an empty thrown message, the fallback",
      convexServerError("[Request ID: 1a2b] Server Error\nUncaught Error: \n    at handler (../convex/issues.ts:1:1)\n"),
      "Failed to move issue",
    ],
    [
      "a Convex server error with a blank thrown message, the fallback",
      convexServerError("[Request ID: 1a2b] Server Error\nUncaught Error:    \n    at handler (../convex/issues.ts:1:1)\n"),
      "Failed to move issue",
    ],
    [
      "a Convex server error without its thrown line, the fallback",
      convexServerError("[Request ID: 1a2b] Server Error"),
      "Failed to move issue",
    ],
    [
      "a thrown line raised inside an HTTP action, without its prefix and stack",
      new Error(
        "Uncaught Error: Can't move LCK-7 to Done: open — LCK-7.1 Complete testing (no proof link)\n    at assertDoneGate (../convex/lib/rules/doneGate.ts:70:10)\n"
      ),
      "Can't move LCK-7 to Done: open — LCK-7.1 Complete testing (no proof link)",
    ],
    [
      "a bare thrown line raised inside an HTTP action, without its prefix",
      new Error("Uncaught Error: live-check already has LCK-7 In Progress; move it to In Review or Done first"),
      "live-check already has LCK-7 In Progress; move it to In Review or Done first",
    ],
    [
      "a thrown line raised inside an HTTP action with an empty message, the fallback",
      new Error("Uncaught Error: \n    at handler (../convex/issues.ts:1:1)\n"),
      "Failed to move issue",
    ],
    ["a plain error, as is", new Error("Team not found"), "Team not found"],
    [
      "a plain error that quotes a thrown line, as is",
      new Error("Failed to upload report Uncaught Error: draft.txt"),
      "Failed to upload report Uncaught Error: draft.txt",
    ],
    ["a multi-line plain error, its first line", new Error("First line\n    at x"), "First line"],
    ["an empty error, the fallback", new Error(""), "Failed to move issue"],
    ["a non-error, the fallback", "boom", "Failed to move issue"],
  ])("%s", (_label, error, expected) => {
    expect(errorMessage(error, "Failed to move issue")).toBe(expected);
  });

  test("a ConvexError forwarded with its data, the thrown line", () => {
    const error = new ConvexError(
      "[CONVEX M(teams:create)] [Request ID: 9f3c] Server Error\nUncaught ConvexError: Team key ENG is taken\n    at handler (../convex/teams.ts:12:11)\n\n  Called by client"
    );
    (error as ConvexError<Value>).data = { code: "TEAM_KEY_TAKEN" };
    expect(errorMessage(error, "Failed to create team")).toBe("Team key ENG is taken");
  });

  /** What the Convex client throws for a `ConvexError`: its header and the data as JSON, with the data forwarded. */
  function forwardedConvexError(data: Value): ConvexError<Value> {
    const error = new ConvexError(
      `[CONVEX M(issues:update)] [Request ID: 9f3c] Server Error\nUncaught ConvexError: ${JSON.stringify(data)}\n\n  Called by client`
    );
    (error as ConvexError<Value>).data = data;
    return error as ConvexError<Value>;
  }

  test.each([
    [
      "a rule refusal, the rule's own words",
      { code: "rule_refused", message: 'Team key "ENG" is already in use' },
      'Team key "ENG" is already in use',
    ],
    ["a string, as is", "Team key ENG is taken", "Team key ENG is taken"],
    ["a blank message, the fallback", { code: "rule_refused", message: "  " }, "Failed to move issue"],
  ])("a ConvexError whose data holds %s", (_label, data, expected) => {
    expect(errorMessage(forwardedConvexError(data), "Failed to move issue")).toBe(expected);
  });
});
