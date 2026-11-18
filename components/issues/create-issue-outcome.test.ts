import { describe, expect, test } from "vitest";
import type { Id } from "@/convex/_generated/dataModel";
import { createIssueOutcome, fallbackTeamId, IssueDraft } from "./create-issue-outcome";

const submitted: IssueDraft = {
  teamId: "team1" as Id<"teams">,
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

  test("a stale success keeps a new team", () => {
    expect(
      createIssueOutcome(false, submitted, { ...submitted, teamId: "team2" as Id<"teams"> })
    ).toBe("keep");
  });

  test("a stale success keeps a field the submitted draft did not carry", () => {
    const noPlacement = { kind: "story", type: "story" } as IssueDraft["level"];
    expect(
      createIssueOutcome(
        false,
        { ...submitted, level: noPlacement },
        { ...submitted, level: { ...noPlacement, parentIssueId: "issue1" as Id<"issues"> } }
      )
    ).toBe("keep");
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

describe("fallbackTeamId", () => {
  const team1 = "team1" as Id<"teams">;
  const team2 = "team2" as Id<"teams">;

  test("a loaded list falls back to its first team", () => {
    expect(fallbackTeamId([{ _id: team2 }], team1)).toBe(team2);
  });

  test("a skipped query keeps the remembered team", () => {
    expect(fallbackTeamId(undefined, team1)).toBe(team1);
  });

  test("an empty loaded list has no fallback", () => {
    expect(fallbackTeamId([], team1)).toBeUndefined();
  });

  test("a stale success clears a fallback-team draft after the closed dialog skips the query", () => {
    const submittedTeam = fallbackTeamId([{ _id: team1 }], undefined);
    const afterClose = fallbackTeamId(undefined, submittedTeam);
    expect(
      createIssueOutcome(false, { ...submitted, teamId: submittedTeam }, { ...submitted, teamId: afterClose })
    ).toBe("clear");
  });
});
