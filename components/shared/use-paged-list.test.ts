import { describe, expect, it } from "vitest";
import { LIST_LIMIT } from "@/convex/lib/paging";
import { emptyListText, loadedCount, PAGE_SIZE } from "./use-paged-list";

describe("PAGE_SIZE", () => {
  it("is at most the server page limit, which the listByTeam read bound assumes", () => {
    expect(PAGE_SIZE).toBeLessThanOrEqual(LIST_LIMIT);
  });
});

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
