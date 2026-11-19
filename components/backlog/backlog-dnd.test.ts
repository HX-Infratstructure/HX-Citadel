import { CollisionDetection } from "@dnd-kit/core";
import { describe, expect, it } from "vitest";
import type { Id } from "@/convex/_generated/dataModel";
import { fakeLocalStore } from "@/components/fake-local-store";
import { NO_ROOM_TO_PLACE, SORT_GAP } from "@/lib/sort-order";
import { moveRank, rankAnnouncements, rankCollision, updateBacklog } from "./backlog-dnd";

const stories = [
  { _id: "id-a", title: "Login page", sortOrder: 30, _creationTime: 0 },
  { _id: "id-b", title: "Export CSV", sortOrder: 20, _creationTime: 0 },
  { _id: "id-c", title: "Dark mode", sortOrder: 10, _creationTime: 0 },
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
      "Login page stays at position 1 of 3. Load more to place it here."
    );
    expect(partial.onDragEnd({ active: { id: "id-a" }, over: { id: "id-b" } })).toBe(
      "Login page dropped at position 2 of 3."
    );
  });

  it("says the story stays put when it is dropped between two stories tied at the lowest loaded rank", () => {
    const tied = [stories[0], { ...stories[1], sortOrder: 10, _creationTime: 1 }, stories[2]];
    expect(rankAnnouncements(tied, true).onDragEnd({ active: { id: "id-a" }, over: { id: "id-b" } })).toBe(
      "Login page stays at position 1 of 3. Load more to place it here."
    );
  });

  it("says the story stays put when it is dropped into a gap with no room, with every story loaded", () => {
    const crowded = [{ ...stories[0], sortOrder: 2000 }, { ...stories[1], sortOrder: 900 }, { ...stories[2], sortOrder: 899.9999999999999 }];
    expect(rankAnnouncements(crowded, false).onDragEnd({ active: { id: "id-a" }, over: { id: "id-b" } })).toBe(
      `Login page stays at position 1 of 3. ${NO_ROOM_TO_PLACE}`
    );
  });
});

describe("moveRank", () => {
  it("refuses a move to the bottom while more of the backlog is to load", () => {
    expect(moveRank({ stories, from: 0, to: 2, moreToLoad: true })).toEqual({ refused: "loadMore" });
  });

  it("ranks a move between loaded stories while more is to load", () => {
    expect(moveRank({ stories, from: 2, to: 0, moreToLoad: true })).toEqual({ sortOrder: 30 + SORT_GAP });
    expect(moveRank({ stories, from: 2, to: 1, moreToLoad: true })).toEqual({ sortOrder: 25 });
  });

  it("refuses a move between two stories tied at the lowest loaded rank while more is to load", () => {
    const tied = [stories[0], { ...stories[1], sortOrder: 10, _creationTime: 1 }, stories[2]];
    expect(moveRank({ stories: tied, from: 0, to: 1, moreToLoad: true })).toEqual({ refused: "loadMore" });
  });

  it("ranks a move to the bottom below the last story once the whole backlog is loaded", () => {
    expect(moveRank({ stories, from: 0, to: 2, moreToLoad: false })).toEqual({ sortOrder: 10 - SORT_GAP });
  });

  const lowest = { _id: "id-d", title: "Search", sortOrder: 5, _creationTime: 0 };

  it("ranks a move between two stories tied above the floor at their shared rank while more is to load", () => {
    const tied = [stories[0], { ...stories[1], _creationTime: 1 }, { ...stories[2], sortOrder: 20 }, lowest];
    expect(moveRank({ stories: tied, from: 0, to: 1, moreToLoad: true })).toEqual({ sortOrder: 20 });
  });

  it.each([
    ["the midpoint rounds to the upper story", 900, 899.9999999999999],
    ["the midpoint rounds to the lower story", 900.0000000000001, 900],
    ["CodeRabbit 4623425278", 1000, 999.9999999999999],
  ])("refuses a move into a gap with no room, whether or not more is to load: %s", (_, upper, lower) => {
    const crowded = [{ ...stories[0], sortOrder: 2000 }, { ...stories[1], sortOrder: upper }, { ...stories[2], sortOrder: lower }, lowest];
    for (const moreToLoad of [true, false]) {
      expect(moveRank({ stories: crowded, from: 0, to: 1, moreToLoad })).toEqual({ refused: "noRoom" });
    }
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

type Story = { _id: string; sortOrder: number; _creationTime: number };
type Page = { args: { teamId: string; paginationOpts: { id: number; cursor: string | null } }; value: { page: Story[]; isDone: boolean } };

const TEAM = "team-1" as Id<"teams">;
const story = (_id: string, sortOrder: number, _creationTime = 0): Story => ({ _id, sortOrder, _creationTime });

/** A local store holding the loaded `listBacklog` pages of one `usePaginatedQuery` per list, top page first. */
function backlog(...lists: Story[][][]) {
  const queries: Page[] = lists.flatMap((pages, id) =>
    pages.map((page, index) => ({
      args: { teamId: TEAM, paginationOpts: { id, cursor: index === 0 ? null : `cursor-${index}` } },
      value: { page, isDone: index === pages.length - 1 },
    }))
  );
  const localStore = fakeLocalStore(queries);
  const move = (issueId: string, update: { sortOrder?: number; cycleId?: string }) =>
    updateBacklog(localStore, TEAM, { issueId, ...update } as Parameters<typeof updateBacklog>[2]);
  const shown = (id = 0) => queries.filter(({ args }) => args.paginationOpts.id === id).flatMap(({ value }) => value.page);
  return { move, shown, ids: (id = 0) => shown(id).map((issue) => issue._id) };
}

const twoPages = () => backlog([
  [story("A", 30), story("B", 20)],
  [story("C", 10), story("D", 0)],
]);

describe("updateBacklog", () => {
  it("shows a story ranked above the first loaded page at the top, not below that page", () => {
    const list = twoPages();
    list.move("C", { sortOrder: 40 });
    expect(list.ids()).toEqual(["C", "A", "B", "D"]);
  });

  it("reranks a story within its own page", () => {
    const top = twoPages();
    top.move("B", { sortOrder: 40 });
    expect(top.ids()).toEqual(["B", "A", "C", "D"]);
    const bottom = twoPages();
    bottom.move("D", { sortOrder: 15 });
    expect(bottom.ids()).toEqual(["A", "B", "D", "C"]);
  });

  it("moves a story into the last loaded page when its rank falls there", () => {
    const list = twoPages();
    list.move("A", { sortOrder: 5 });
    expect(list.ids()).toEqual(["B", "C", "A", "D"]);
    expect(list.shown()[2]).toEqual(story("A", 5));
  });

  it("reranks within a single loaded page", () => {
    const list = backlog([[story("A", 30), story("B", 20), story("C", 10)]]);
    list.move("C", { sortOrder: 40 });
    expect(list.ids()).toEqual(["C", "A", "B"]);
  });

  it("orders a story that ties another's rank by creation time, newest first, as the server does", () => {
    const list = backlog([[story("A", 30, 1), story("B", 20, 5), story("C", 10, 2)]]);
    list.move("C", { sortOrder: 20 });
    expect(list.ids()).toEqual(["A", "B", "C"]);
    const newer = backlog([[story("A", 30, 1), story("B", 20, 5), story("C", 10, 9)]]);
    newer.move("C", { sortOrder: 20 });
    expect(newer.ids()).toEqual(["A", "C", "B"]);
  });

  it("keeps a story moved to the top or bottom when the server returned empty pages there", () => {
    const top = backlog([[], [story("A", 30), story("B", 20)], [story("C", 10)]]);
    top.move("B", { sortOrder: 40 });
    expect(top.ids()).toEqual(["B", "A", "C"]);
    const bottom = backlog([[story("A", 30), story("B", 20)], [story("C", 10)], []]);
    bottom.move("A", { sortOrder: 5 });
    expect(bottom.ids()).toEqual(["B", "C", "A"]);
  });

  it("updates each paginated list of the team on its own", () => {
    const lists = backlog(
      [[story("A", 30), story("B", 20)], [story("C", 10)]],
      [[story("A", 30)], [story("B", 20), story("C", 10)]]
    );
    lists.move("C", { sortOrder: 25 });
    expect(lists.ids(0)).toEqual(["A", "C", "B"]);
    expect(lists.ids(1)).toEqual(["A", "C", "B"]);
  });

  it("removes a planned story from the backlog", () => {
    const list = twoPages();
    list.move("C", { cycleId: "cycle-1" });
    expect(list.ids()).toEqual(["A", "B", "D"]);
  });
});
