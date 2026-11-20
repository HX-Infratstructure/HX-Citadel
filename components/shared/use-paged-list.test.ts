import { describe, expect, it } from "vitest";
import { emptyListText, loadedCount } from "./use-paged-list";

describe("emptyListText", () => {
  it("says only the loaded issues were searched while more is to load", () => {
    expect(emptyListText(true, true)).toBe("No matches in the loaded issues.");
  });

  it("says no issue matches once every page is loaded", () => {
    expect(emptyListText(true, false)).toBe("No issues match the current filters.");
  });

  it("invites a first issue when the team has none", () => {
    expect(emptyListText(false, false)).toBe("No issues yet. Press C to create one.");
  });
});

describe("loadedCount", () => {
  it("marks a count as a lower bound while more is to load", () => {
    expect(loadedCount(3, true)).toBe("3+");
    expect(loadedCount(3, false)).toBe("3");
  });
});
