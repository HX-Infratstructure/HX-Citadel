import { describe, expect, test } from "vitest";
import { createIssueOutcome, IssueDraft } from "./create-issue-outcome";

const submitted: IssueDraft = {
  title: "Fix login",
  description: "",
  status: "todo",
  priority: "none",
  level: { kind: "story", type: "story" },
};

describe("createIssueOutcome", () => {
  test("a success in the same session finishes, even over edits", () => {
    expect(
      createIssueOutcome(true, submitted, { ...submitted, title: "Typed while pending" })
    ).toBe("finish");
  });

  test("a stale success clears the form when it still holds the submitted draft", () => {
    expect(
      createIssueOutcome(false, submitted, { ...submitted, level: { kind: "story", type: "story" } })
    ).toBe("clear");
  });

  test("a stale success keeps a new title", () => {
    expect(createIssueOutcome(false, submitted, { ...submitted, title: "Another issue" })).toBe(
      "keep"
    );
  });

  test("a stale success keeps a new level", () => {
    expect(
      createIssueOutcome(false, submitted, { ...submitted, level: { kind: "epic", type: "story" } })
    ).toBe("keep");
  });
});
