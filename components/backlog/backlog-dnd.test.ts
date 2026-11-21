import { CollisionDetection } from "@dnd-kit/core";
import { describe, expect, it } from "vitest";
import type { Id } from "@/convex/_generated/dataModel";
import { fakeLocalStore } from "@/components/fake-local-store";
import { seededRandom } from "@/lib/seeded-random.fixture";
import { byRank, NO_ROOM_TO_PLACE, SORT_GAP } from "@/lib/sort-order";
import { backlogAnchor, backlogDrop, rankAnnouncements, rankCollision, updateBacklog } from "./backlog-dnd";

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

  it("says the story stays put when it is moved into a run of 3 stories at one rank, and names the spot of a story dropped in place (CodeRabbit 4624154372)", () => {
    const run = stories.map((story, index) => ({ ...story, sortOrder: 20, _creationTime: 3 - index }));
    const announce = rankAnnouncements(run, false);
    expect(announce.onDragEnd({ active: { id: "id-a" }, over: { id: "id-b" } })).toBe(`Login page stays at position 1 of 3. ${NO_ROOM_TO_PLACE}`);
    expect(announce.onDragEnd({ active: { id: "id-b" }, over: { id: "id-b" } })).toBe("Export CSV dropped at position 2 of 3.");
  });

  it("announces a story dropped on its own place in a tie at the lowest loaded rank like any drop in place (amendment 1)", () => {
    const tied = [stories[0], { ...stories[1], sortOrder: 10, _creationTime: 1 }, stories[2]];
    expect(rankAnnouncements(tied, true).onDragEnd({ active: { id: "id-c" }, over: { id: "id-c" } })).toBe("Dark mode dropped at position 3 of 3.");
  });

  it("says the story stays put when it is dropped into a gap with no room, with every story loaded", () => {
    const crowded = [{ ...stories[0], sortOrder: 2000 }, { ...stories[1], sortOrder: 900 }, { ...stories[2], sortOrder: 899.9999999999999 }];
    expect(rankAnnouncements(crowded, false).onDragEnd({ active: { id: "id-a" }, over: { id: "id-b" } })).toBe(
      `Login page stays at position 1 of 3. ${NO_ROOM_TO_PLACE}`
    );
  });
});

describe("rankAnnouncements when the backlog changes during the drag", () => {
  it("names no position on pick-up of a story that left the backlog (T27 quality F2)", () => {
    expect(rankAnnouncements(stories, true).onDragStart({ active: { id: "id-gone" } })).toBe("Picked up Story.");
  });

  it("says the story is over a story that left the backlog, when the target left it (T27 quality F2)", () => {
    const announce = rankAnnouncements(stories, true);
    expect(announce.onDragOver({ active: { id: "id-a" }, over: { id: "id-gone" } })).toBe("Login page is over a story that left the backlog.");
    expect(announce.onDragOver({ active: { id: "id-gone" }, over: { id: "id-a" } })).toBe("Story is over position 1 of 3.");
  });

  it("says a cancelled story is no longer in the backlog when it left it during the drag (T27 quality F2)", () => {
    expect(rankAnnouncements(stories, true).onDragCancel({ active: { id: "id-gone" } })).toBe("Ranking cancelled. Story is no longer in the backlog.");
  });

  it("says the story was not moved when the dragged story left the backlog during the drag", () => {
    for (const moreToLoad of [true, false]) {
      expect(rankAnnouncements(stories, moreToLoad).onDragEnd({ active: { id: "id-gone" }, over: { id: "id-b" } })).toBe(
        "Story was not moved: the backlog changed during the drag."
      );
    }
  });

  it("says the story was not moved when the story it was dropped on left the backlog during the drag", () => {
    for (const moreToLoad of [true, false]) {
      expect(rankAnnouncements(stories, moreToLoad).onDragEnd({ active: { id: "id-a" }, over: { id: "id-gone" } })).toBe(
        "Login page was not moved: the backlog changed during the drag."
      );
    }
  });
});

describe("backlogDrop", () => {
  it("refuses a move to the bottom while more of the backlog is to load", () => {
    expect(backlogDrop({ stories, activeId: stories[0]._id, overId: stories[2]._id, moreToLoad: true })).toEqual({ kind: "refused", reason: "loadMore" });
  });

  it("ranks a move between loaded stories while more is to load", () => {
    expect(backlogDrop({ stories, activeId: stories[2]._id, overId: stories[0]._id, moreToLoad: true })).toEqual({ kind: "ranked", sortOrder: 30 + SORT_GAP });
    expect(backlogDrop({ stories, activeId: stories[2]._id, overId: stories[1]._id, moreToLoad: true })).toEqual({ kind: "ranked", sortOrder: 25 });
  });

  it("refuses a move between two stories tied at the lowest loaded rank while more is to load", () => {
    const tied = [stories[0], { ...stories[1], sortOrder: 10, _creationTime: 1 }, stories[2]];
    expect(backlogDrop({ stories: tied, activeId: tied[0]._id, overId: tied[1]._id, moreToLoad: true })).toEqual({ kind: "refused", reason: "loadMore" });
  });

  it("ranks a move to the bottom below the last story once the whole backlog is loaded", () => {
    expect(backlogDrop({ stories, activeId: stories[0]._id, overId: stories[2]._id, moreToLoad: false })).toEqual({ kind: "ranked", sortOrder: 10 - SORT_GAP });
  });

  const lowest = { _id: "id-d", title: "Search", sortOrder: 5, _creationTime: 0 };

  it("ranks a move between two stories tied above the floor at their shared rank while more is to load", () => {
    const tied = [stories[0], { ...stories[1], _creationTime: 1 }, { ...stories[2], sortOrder: 20 }, lowest];
    expect(backlogDrop({ stories: tied, activeId: tied[0]._id, overId: tied[1]._id, moreToLoad: true })).toEqual({ kind: "ranked", sortOrder: 20 });
  });

  it("ranks the grid move of S290 between S300 and S298 at 299000, the rank of S299, which is outside the backlog", () => {
    const grid = [
      { _id: "id-300", title: "S300", sortOrder: 300000, _creationTime: 0 },
      { _id: "id-298", title: "S298", sortOrder: 298000, _creationTime: 0 },
      { _id: "id-290", title: "S290", sortOrder: 290000, _creationTime: 0 },
      { _id: "id-051", title: "S051", sortOrder: 51000, _creationTime: 0 },
    ];
    for (const moreToLoad of [true, false]) {
      expect(backlogDrop({ stories: grid, activeId: grid[2]._id, overId: grid[1]._id, moreToLoad })).toEqual({ kind: "ranked", sortOrder: 299000 });
    }
  });

  it("refuses a move into a run of 3 stories at one rank, which would keep its own rank, whether or not more is to load (CodeRabbit 4624154372)", () => {
    const run = [...stories.map((story, index) => ({ ...story, sortOrder: 20, _creationTime: 3 - index })), lowest];
    for (const moreToLoad of [true, false]) {
      expect(backlogDrop({ stories: run, activeId: run[0]._id, overId: run[1]._id, moreToLoad })).toEqual({ kind: "refused", reason: "noRoom" });
      expect(backlogDrop({ stories: run, activeId: run[2]._id, overId: run[1]._id, moreToLoad })).toEqual({ kind: "refused", reason: "noRoom" });
    }
  });

  it.each([
    ["the midpoint rounds to the upper story", 900, 899.9999999999999],
    ["the midpoint rounds to the lower story", 900.0000000000001, 900],
    ["CodeRabbit 4623425278", 1000, 999.9999999999999],
  ])("refuses a move into a gap with no room, whether or not more is to load: %s", (_, upper, lower) => {
    const crowded = [{ ...stories[0], sortOrder: 2000 }, { ...stories[1], sortOrder: upper }, { ...stories[2], sortOrder: lower }, lowest];
    for (const moreToLoad of [true, false]) {
      expect(backlogDrop({ stories: crowded, activeId: crowded[0]._id, overId: crowded[1]._id, moreToLoad })).toEqual({ kind: "refused", reason: "noRoom" });
    }
  });

  it("refuses a move between two loaded stories tied at the lowest loaded rank as no room, and asks to load more for a move to the very bottom (thermos P3-3)", () => {
    const tie = [stories[0], { ...stories[1], sortOrder: 10, _creationTime: 2 }, { ...stories[2], _creationTime: 1 }, { ...lowest, sortOrder: 10 }];
    expect(backlogDrop({ stories: tie, activeId: tie[1]._id, overId: tie[2]._id, moreToLoad: true })).toEqual({ kind: "refused", reason: "noRoom" });
    expect(backlogDrop({ stories: tie, activeId: tie[1]._id, overId: tie[3]._id, moreToLoad: true })).toEqual({ kind: "refused", reason: "loadMore" });
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

describe("backlogAnchor", () => {
  const [a, b, c] = stories.map((story) => story._id);

  it("is null for a story moved up to the top", () => {
    expect(backlogAnchor(stories, c, a)).toBeNull();
    expect(backlogAnchor(stories, b, a)).toBeNull();
  });

  it("is the story right above the slot in the middle: the target moving down, the story before it moving up", () => {
    expect(backlogAnchor(stories, a, b)).toBe(b);
    expect(backlogAnchor(stories, c, b)).toBe(a);
  });

  it("is the target for a story moved down to the bottom", () => {
    expect(backlogAnchor(stories, a, c)).toBe(c);
    expect(backlogAnchor(stories, b, c)).toBe(c);
  });

  it("is null when either story is not loaded", () => {
    expect(backlogAnchor(stories, "gone", a)).toBeNull();
    expect(backlogAnchor(stories, a, "gone")).toBeNull();
  });

  it("over random backlogs, is the story above the drop slot, at or above the rank backlogDrop gives, and null exactly when that rank tops every other story", () => {
    for (let seed = 1; seed <= 300; seed++) {
      const next = seededRandom(seed);
      const list = Array.from({ length: 2 + Math.floor(next() * 6) }, (_, i) => ({
        _id: `S${i}`,
        sortOrder: 10 * (1 + Math.floor(next() * 6)),
        _creationTime: i,
      })).sort(byRank);
      const from = Math.floor(next() * list.length);
      const to = Math.floor(next() * list.length);
      const active = list[from];
      const others = list.filter((story) => story !== active);
      const anchor = backlogAnchor(list, active._id, list[to]._id);
      const label = `seed ${seed}`;
      expect(anchor, label).toBe(to === 0 ? null : others[to - 1]._id);
      const drop = backlogDrop({ stories: list, activeId: active._id, overId: list[to]._id, moreToLoad: next() < 0.5 });
      if (drop.kind === "ranked") {
        const above = others.find((story) => story._id === anchor);
        expect(anchor === null, label).toBe(others.every((story) => story.sortOrder < drop.sortOrder));
        expect(above === undefined || drop.sortOrder <= above.sortOrder, label).toBe(true);
      }
    }
  });
});
