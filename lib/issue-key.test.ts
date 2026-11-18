import { describe, expect, test } from "vitest";
import { formatIssueKey, hasDisplayKey, parentChoices } from "./issue-key";

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

describe("hasDisplayKey", () => {
  test.each([
    ["epic", false],
    ["feature", false],
    ["story", true],
    ["subtask", true],
  ] as const)("a %s has a display key: %s", (kind, expected) => {
    expect(hasDisplayKey(kind)).toBe(expected);
  });
});

describe("parentChoices", () => {
  const issues = [
    { id: "e1", kind: "epic", status: "todo" },
    { id: "f1", kind: "feature", status: "in_progress" },
    { id: "s1", kind: "story", status: "todo" },
    { id: "t1", kind: "subtask", status: "todo" },
  ] as const;

  test("a story may move under a feature or stand alone", () => {
    expect(parentChoices([...issues], "story")).toEqual({
      parents: [issues[1]],
      allowsNone: true,
    });
  });

  test("an In Review or Done parent is not offered, a canceled one is", () => {
    const features = [
      { id: "f-open", kind: "feature", status: "todo" },
      { id: "f-review", kind: "feature", status: "in_review" },
      { id: "f-done", kind: "feature", status: "done" },
      { id: "f-canceled", kind: "feature", status: "canceled" },
    ] as const;
    expect(parentChoices([...features], "story")).toEqual({
      parents: [features[0], features[3]],
      allowsNone: true,
    });
  });

  test.each([
    ["feature", issues[0]],
    ["subtask", issues[2]],
  ] as const)("a %s may only move under its parent level", (kind, parent) => {
    expect(parentChoices([...issues], kind)).toEqual({
      parents: [parent],
      allowsNone: false,
    });
  });

  test("an epic has no parent to choose", () => {
    expect(parentChoices([...issues], "epic")).toBeNull();
  });
});
