import { CollisionDetection } from "@dnd-kit/core";
import { describe, expect, it } from "vitest";
import { backlogAfterUpdate, canDropAt, rankAnnouncements, rankCollision } from "./backlog-dnd";

const stories = [
  { _id: "id-a", title: "Login page" },
  { _id: "id-b", title: "Export CSV" },
  { _id: "id-c", title: "Dark mode" },
];

describe("rankAnnouncements", () => {
  const announce = rankAnnouncements(stories, false);

  it("names the story and its position on pick-up, never its internal id", () => {
    const text = announce.onDragStart({ active: { id: "id-b" } });
    expect(text).toBe("Picked up Export CSV at position 2 of 3.");
  });

  it("names the destination position while moving and on drop", () => {
    expect(announce.onDragOver({ active: { id: "id-c" }, over: { id: "id-a" } })).toBe(
      "Dark mode is over position 1 of 3."
    );
    expect(announce.onDragEnd({ active: { id: "id-c" }, over: { id: "id-a" } })).toBe(
      "Dark mode dropped at position 1 of 3."
    );
  });

  it("says the rank is unchanged when the story is dropped outside the backlog", () => {
    expect(announce.onDragEnd({ active: { id: "id-a" }, over: null })).toBe(
      "Login page dropped outside the backlog. Its rank is unchanged."
    );
  });

  it("says where the story stays when ranking is cancelled", () => {
    expect(announce.onDragCancel({ active: { id: "id-a" } })).toBe(
      "Ranking cancelled. Login page stays at position 1 of 3."
    );
  });

  it("says the story stays put when it is dropped after the last loaded story with more to load", () => {
    const partial = rankAnnouncements(stories, true);
    expect(partial.onDragEnd({ active: { id: "id-a" }, over: { id: "id-c" } })).toBe(
      "Login page stays at position 1 of 3. Load more to place a story here."
    );
    expect(partial.onDragEnd({ active: { id: "id-a" }, over: { id: "id-b" } })).toBe(
      "Login page dropped at position 2 of 3."
    );
  });
});

describe("canDropAt", () => {
  it("refuses a drop after the last loaded story while more are still to load", () => {
    expect(canDropAt(2, 3, true)).toBe(false);
  });

  it("allows an interior drop while more are still to load", () => {
    expect(canDropAt(0, 3, true)).toBe(true);
    expect(canDropAt(1, 3, true)).toBe(true);
  });

  it("allows a drop at the end once the whole backlog is loaded", () => {
    expect(canDropAt(2, 3, false)).toBe(true);
  });
});

const row = (top: number) => ({ top, bottom: top + 40, left: 0, right: 400, width: 400, height: 40 });

function collisionArgs(pointer: { x: number; y: number } | null) {
  return {
    active: { id: "id-c" },
    collisionRect: row(-60),
    droppableRects: new Map([
      ["id-a", row(0)],
      ["id-b", row(40)],
      ["id-c", row(80)],
    ]),
    droppableContainers: stories.map((story) => ({ id: story._id })),
    pointerCoordinates: pointer,
  } as unknown as Parameters<CollisionDetection>[0];
}

describe("rankCollision", () => {
  it("finds no row when the pointer is released outside the list", () => {
    expect(rankCollision(collisionArgs({ x: 200, y: -50 }))).toEqual([]);
  });

  it("finds the nearest row when the pointer is over the list", () => {
    expect(rankCollision(collisionArgs({ x: 200, y: 20 }))[0]?.id).toBe("id-a");
  });

  it("finds the nearest row for a keyboard move, which has no pointer", () => {
    expect(rankCollision(collisionArgs(null))[0]?.id).toBe("id-a");
  });
});

const issue = (_id: string, sortOrder: number) => ({ _id, sortOrder });
const ids = (pages: { _id: string }[][]) => pages.map((page) => page.map((story) => story._id));
const twoPages = () => [
  [issue("A", 30), issue("B", 20)],
  [issue("C", 10), issue("D", 0)],
];

describe("backlogAfterUpdate", () => {
  it("shows a story ranked above the first loaded page at the top, not below that page", () => {
    const pages = backlogAfterUpdate(twoPages(), { issueId: "C", sortOrder: 40 });
    expect(pages.flat().map((story) => story._id)).toEqual(["C", "A", "B", "D"]);
    expect(ids(pages)).toEqual([["C", "A", "B"], ["D"]]);
  });

  it("reranks a story within its own page as before", () => {
    expect(ids(backlogAfterUpdate(twoPages(), { issueId: "B", sortOrder: 40 }))).toEqual([
      ["B", "A"],
      ["C", "D"],
    ]);
    expect(ids(backlogAfterUpdate(twoPages(), { issueId: "D", sortOrder: 15 }))).toEqual([
      ["A", "B"],
      ["D", "C"],
    ]);
  });

  it("moves a story into the last loaded page when its rank falls there", () => {
    const pages = backlogAfterUpdate(twoPages(), { issueId: "A", sortOrder: 5 });
    expect(ids(pages)).toEqual([["B"], ["C", "A", "D"]]);
    expect(pages[1][1]).toEqual({ _id: "A", sortOrder: 5 });
  });

  it("reranks within a single loaded page", () => {
    const single = [[issue("A", 30), issue("B", 20), issue("C", 10)]];
    expect(ids(backlogAfterUpdate(single, { issueId: "C", sortOrder: 40 }))).toEqual([["C", "A", "B"]]);
  });

  it("removes a planned story from the backlog", () => {
    expect(ids(backlogAfterUpdate(twoPages(), { issueId: "C", cycleId: "cycle-1" }))).toEqual([
      ["A", "B"],
      ["D"],
    ]);
  });
});
