import { describe, expect, test } from "vitest";
import { EMPTY_PROGRESS, type IssueProgress } from "./project-meta";
import { activeIssueLabel } from "./row-progress";

describe("activeIssueLabel", () => {
  test.each<[string, IssueProgress | undefined, string]>([
    ["still loading shows the placeholder", undefined, "—"],
    ["canceled issues are not counted", { ...EMPTY_PROGRESS, total: 3, canceled: 1 }, "2 issues"],
    ["one active issue after canceled ones is singular", { ...EMPTY_PROGRESS, total: 2, canceled: 1 }, "1 issue"],
    ["one issue is singular", { ...EMPTY_PROGRESS, total: 1 }, "1 issue"],
    ["a loaded row with no issues shows 0 issues", EMPTY_PROGRESS, "0 issues"],
  ])("%s", (_title, progress, expected) => {
    expect(activeIssueLabel(progress)).toBe(expected);
  });
});
