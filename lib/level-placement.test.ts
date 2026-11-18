import { describe, expect, test } from "vitest";
import { missingPlacement } from "./level-placement";

describe("missingPlacement", () => {
  test("an epic without a project lacks its project", () => {
    expect(missingPlacement({ kind: "epic" })).toBe("project");
  });

  test("an epic with a project is placed", () => {
    expect(missingPlacement({ kind: "epic", projectId: "p1" })).toBeNull();
  });

  test("a feature without an epic lacks its parent", () => {
    expect(missingPlacement({ kind: "feature" })).toBe("parent");
  });

  test("a feature under an epic is placed", () => {
    expect(missingPlacement({ kind: "feature", parentIssueId: "e1" })).toBeNull();
  });

  test("a story may stand without a feature", () => {
    expect(missingPlacement({ kind: "story" })).toBeNull();
  });
});
