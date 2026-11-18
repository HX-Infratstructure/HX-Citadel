import { describe, expect, test } from "vitest";
import {
  formatIssueKey,
  formatParsedKey,
  hasDisplayKey,
  isValidTeamKey,
  parentChoices,
  parseIssueKey,
  suggestTeamKey,
} from "./issue-key";

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

describe("parseIssueKey", () => {
  test("a story key gives the team key and number", () => {
    expect(parseIssueKey("HXT-12")).toEqual({ teamKey: "HXT", number: 12 });
  });

  test("a subtask key adds the sub-number", () => {
    expect(parseIssueKey("HXT-12.3")).toEqual({ teamKey: "HXT", number: 12, subNumber: 3 });
  });

  test("anything else is null", () => {
    expect(parseIssueKey("HXT")).toBeNull();
    expect(parseIssueKey("HXT-x")).toBeNull();
    expect(parseIssueKey("HXT-1.2.3")).toBeNull();
  });

  test("a team key starts with a letter, so a date is not a key", () => {
    expect(parseIssueKey("2026-11")).toBeNull();
    expect(parseIssueKey("1AB-3")).toBeNull();
    expect(parseIssueKey("HX-1")).toEqual({ teamKey: "HX", number: 1 });
    expect(parseIssueKey("HX-1.2")).toEqual({ teamKey: "HX", number: 1, subNumber: 2 });
    expect(parseIssueKey("A1-3")).toEqual({ teamKey: "A1", number: 3 });
  });
});

describe("formatParsedKey", () => {
  test.each([
    ["story", { teamKey: "CIT", number: 12 }, { kind: "story", number: 12 }, undefined, "CIT-12"],
    ["subtask", { teamKey: "CIT", number: 12, subNumber: 3 }, { kind: "subtask", subNumber: 3 }, 12, "CIT-12.3"],
  ] as const)("a parsed %s key is the key formatIssueKey gives the same issue", (_kind, parsed, issue, parentNumber, expected) => {
    expect(formatParsedKey(parsed)).toBe(expected);
    expect(formatParsedKey(parsed)).toBe(formatIssueKey(parsed.teamKey, issue, parentNumber));
  });
});

describe("isValidTeamKey", () => {
  test("accepts 1-5 upper-case letters and digits that start with a letter", () => {
    for (const key of ["A", "HX", "A1", "ENG2", "ABCDE"]) {
      expect(isValidTeamKey(key)).toBe(true);
    }
  });

  test("rejects a leading digit, a wrong length, lower case or other characters", () => {
    for (const key of ["", "1AB", "2026", "ABCDEF", "hx", "H-X", " HX"]) {
      expect(isValidTeamKey(key)).toBe(false);
    }
  });
});

describe("suggestTeamKey", () => {
  test("takes each word's initial, as before", () => {
    expect(suggestTeamKey("Engineering")).toBe("E");
    expect(suggestTeamKey("Platform Engineering Team")).toBe("PET");
  });

  test("skips leading digits, so the suggestion starts with a letter", () => {
    expect(suggestTeamKey("2026 Ops")).toBe("O");
    expect(isValidTeamKey(suggestTeamKey("2026 Ops"))).toBe(true);
  });

  test("suggests nothing when no letter is left", () => {
    expect(suggestTeamKey("!!! ---")).toBe("");
    expect(suggestTeamKey("2026")).toBe("");
  });
});
