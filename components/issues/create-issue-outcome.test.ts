import { describe, expect, test } from "vitest";
import type { Id } from "@/convex/_generated/dataModel";
import { createIssueOutcome, IssueDraft } from "./create-issue-outcome";

const submitted: IssueDraft = {
  title: "Fix login",
  description: "",
  status: "todo",
  priority: "none",
  level: { kind: "story", type: "story", parentIssueId: undefined, projectId: undefined },
};

describe("createIssueOutcome", () => {
  test("a success in the same session finishes, even over edits", () => {
    expect(
      createIssueOutcome(true, submitted, { ...submitted, title: "Typed while pending" })
    ).toBe("finish");
  });

  test("a stale success clears the form when it still holds the submitted draft", () => {
    expect(
      createIssueOutcome(false, submitted, { ...submitted, level: { ...submitted.level } })
    ).toBe("clear");
  });

  test("a stale success keeps a new title", () => {
    expect(createIssueOutcome(false, submitted, { ...submitted, title: "Another issue" })).toBe(
      "keep"
    );
  });

  test.each([
    ["level", { kind: "epic" }],
    ["story type", { type: "bug" }],
    ["parent", { parentIssueId: "issue1" as Id<"issues"> }],
    ["project", { projectId: "project1" as Id<"projects"> }],
  ] as const)("a stale success keeps a new %s", (_, change) => {
    expect(
      createIssueOutcome(false, submitted, { ...submitted, level: { ...submitted.level, ...change } })
    ).toBe("keep");
  });
});
