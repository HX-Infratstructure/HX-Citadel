import { describe, expect, it } from "vitest";
import type { Id } from "@/convex/_generated/dataModel";
import type { IssueStatus } from "@/components/shared/issue-meta";
import { fakeLocalStore } from "@/components/fake-local-store";
import { byRank, LOAD_MORE_TO_PLACE, NO_ROOM_TO_PLACE, REFUSAL_MESSAGE, SORT_GAP } from "@/lib/sort-order";
import { boardColumns, dropRank, updateBoard } from "./board-dnd";

const card = (id: string, status: IssueStatus, sortOrder: number, _creationTime = 0) => ({
  _id: id as Id<"issues">,
  status,
  sortOrder,
  _creationTime,
});

const A = card("A", "todo", 30);
const B = card("B", "todo", 20);
const C = card("C", "todo", 10);
const X = card("X", "in_progress", 5);

const more = (floor: number) => ({ floor, moreToLoad: true });
const allLoaded = (floor: number) => ({ floor, moreToLoad: false });

describe("dropRank", () => {
  it("ranks a drop between two cards at the mean of their ranks", () => {
    expect(dropRank({ column: [A, X, B], index: 1, loaded: more(5), fromOtherColumn: true })).toEqual({ sortOrder: 25 });
  });

  it("ranks a drop at the top above the top card", () => {
    expect(dropRank({ column: [X, A, B], index: 0, loaded: more(5), fromOtherColumn: true })).toEqual({ sortOrder: 30 + SORT_GAP });
  });

  it("ranks a drop at the bottom below the bottom card once every page is loaded", () => {
    expect(dropRank({ column: [A, B, X], index: 2, loaded: allLoaded(5), fromOtherColumn: true })).toEqual({ sortOrder: 20 - SORT_GAP });
  });

  it("keeps the card's rank in an empty column", () => {
    expect(dropRank({ column: [X], index: 0, loaded: allLoaded(5), fromOtherColumn: true })).toEqual({ sortOrder: 5 });
    expect(dropRank({ column: [X], index: 0, loaded: more(5), fromOtherColumn: true })).toEqual({ sortOrder: 5 });
  });

  it("lands a drop at the bottom of a column between the bottom card and the floor while more is to load", () => {
    expect(dropRank({ column: [A, B, X], index: 2, loaded: more(5), fromOtherColumn: true })).toEqual({ sortOrder: 12.5 });
    expect(dropRank({ column: [B, C, A], index: 2, loaded: more(5), fromOtherColumn: false })).toEqual({ sortOrder: 7.5 });
  });

  it("refuses a drop at the bottom of a column whose bottom card is the floor while more is to load", () => {
    expect(dropRank({ column: [B, C, A], index: 2, loaded: more(10), fromOtherColumn: false })).toEqual({ refused: "loadMore" });
  });

  it("refuses a move within a column between two cards tied at the floor while more is to load", () => {
    const column = [A, card("T2", "todo", 10, 2), card("M", "todo", 50), card("T1", "todo", 10, 1)];
    expect(dropRank({ column, index: 2, loaded: more(10), fromOtherColumn: false })).toEqual({ refused: "loadMore" });
  });

  it("keeps the rank of a card moved in from another column onto a spot that can't be ranked, so its status still changes", () => {
    const moved = card("M", "in_progress", 50);
    const column = [A, card("T2", "todo", 10, 2), moved, card("T1", "todo", 10, 1)];
    expect(dropRank({ column, index: 2, loaded: more(10), fromOtherColumn: true })).toEqual({ sortOrder: 50 });
    expect(dropRank({ column: [B, C, moved], index: 2, loaded: more(10), fromOtherColumn: true })).toEqual({ sortOrder: 50 });
  });

  it("places a move at a midpoint that a card in another column holds (CodeRabbit 4623501051)", () => {
    const x = card("X", "todo", 1000.0000000000001);
    const floor = 999.9999999999999;
    expect(dropRank({ column: [x, card("M", "todo", 2000)], index: 1, loaded: more(floor), fromOtherColumn: false })).toEqual({ sortOrder: 1000 });
    expect(dropRank({ column: [x, card("M", "done", 2000)], index: 1, loaded: more(floor), fromOtherColumn: true })).toEqual({ sortOrder: 1000 });
  });

  it("reorders within the card's own column between loaded cards while more is to load", () => {
    expect(dropRank({ column: [B, A, C], index: 1, loaded: more(10), fromOtherColumn: false })).toEqual({ sortOrder: 15 });
  });
});

describe("dropRank at a tie or a gap with no room", () => {
  it("places the grid drop at 299000 between S300 and S298, the rank of S299 and its testing sub-task in other columns", () => {
    const top = card("S300", "in_progress", 300000);
    const bottom = card("S298", "in_progress", 298000);
    const loaded = more(51000);
    expect(dropRank({ column: [top, card("S290", "in_progress", 290000), bottom], index: 1, loaded, fromOtherColumn: false })).toEqual({ sortOrder: 299000 });
    expect(dropRank({ column: [top, card("S297", "done", 297000), bottom], index: 1, loaded, fromOtherColumn: true })).toEqual({ sortOrder: 299000 });
  });

  it("places a drop between two cards tied above the floor at their shared rank", () => {
    const column = [card("T", "todo", 20, 2), card("M", "todo", 50), card("S", "todo", 20, 1), C];
    expect(dropRank({ column, index: 1, loaded: more(10), fromOtherColumn: false })).toEqual({ sortOrder: 20 });
  });

  it.each([
    ["the midpoint rounds to the upper card", 900, 899.9999999999999],
    ["the midpoint rounds to the lower card", 900.0000000000001, 900],
    ["CodeRabbit 4623425278", 1000, 999.9999999999999],
  ])("refuses a drop into a gap with no room, loaded or not, and keeps a card from another column at its rank: %s", (_, upper, lower) => {
    const column = [card("U", "todo", upper), card("M", "todo", 2000), card("L", "todo", lower)];
    for (const loaded of [more(10), allLoaded(10)]) {
      expect(dropRank({ column, index: 1, loaded, fromOtherColumn: false })).toEqual({ refused: "noRoom" });
      expect(dropRank({ column, index: 1, loaded, fromOtherColumn: true })).toEqual({ sortOrder: 2000 });
    }
  });

  it("tells the user to load more, or that the gap has no room, by the refusal's reason", () => {
    const message = (drop: ReturnType<typeof dropRank>) => ("refused" in drop ? REFUSAL_MESSAGE[drop.refused] : undefined);
    const noRoom = [card("U", "todo", 900), card("M", "todo", 2000), card("L", "todo", 899.9999999999999)];
    expect(message(dropRank({ column: [B, C, A], index: 2, loaded: more(10), fromOtherColumn: false }))).toBe("Load more to place it here.");
    expect(message(dropRank({ column: noRoom, index: 1, loaded: allLoaded(10), fromOtherColumn: false }))).toBe(NO_ROOM_TO_PLACE);
    expect(NO_ROOM_TO_PLACE).not.toBe(LOAD_MORE_TO_PLACE);
  });
});

function random(seed: number) {
  return () => {
    seed = (seed + 0x6d2b79f5) | 0;
    let t = Math.imul(seed ^ (seed >>> 15), 1 | seed);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

const STATUSES: IssueStatus[] = ["backlog", "todo", "in_progress", "done"];

describe("dropRank over a partly loaded board", () => {
  it("places every accepted drop above the floor and between its neighbours, over 200 random drops", () => {
    const next = random(42);
    const pick = <T,>(items: T[]) => items[Math.floor(next() * items.length)];
    const outcomes = { refused: 0, kept: 0, placed: 0 };
    for (let trial = 0; trial < 200; trial++) {
      const size = 4 + Math.floor(next() * 12);
      const team = Array.from({ length: size }, (_, i) => card(`I${i}`, pick(STATUSES), 1000 * Math.floor(next() * 5), i)).sort(byRank);
      const loaded = team.slice(0, 1 + Math.floor(next() * (size - 1)));
      const end = loaded[loaded.length - 1];
      const moved = pick(loaded);
      const status = pick(STATUSES);
      const column = loaded.filter((issue) => issue.status === status && issue._id !== moved._id);
      const index = Math.floor(next() * (column.length + 1));
      column.splice(index, 0, moved);

      const drop = dropRank({ column, index, loaded: more(end.sortOrder), fromOtherColumn: moved.status !== status });
      if ("refused" in drop) {
        outcomes.refused++;
        continue;
      }
      if (drop.sortOrder === moved.sortOrder) {
        outcomes.kept++;
        continue;
      }
      outcomes.placed++;
      const upper = column[index - 1]?.sortOrder ?? Infinity;
      const lower = column[index + 1]?.sortOrder ?? end.sortOrder;
      const between = upper === lower ? drop.sortOrder === upper : lower < drop.sortOrder && drop.sortOrder < upper;
      expect(drop.sortOrder, `trial ${trial}: ${moved._id} ranks above the floor`).toBeGreaterThan(end.sortOrder);
      expect(between, `trial ${trial}: ${moved._id} ranks between its neighbours ${upper} and ${lower}`).toBe(true);
    }
    expect(outcomes.refused).toBeGreaterThan(0);
    expect(outcomes.kept).toBeGreaterThan(0);
    expect(outcomes.placed).toBeGreaterThan(0);
  });
});

type Row = ReturnType<typeof card> & { labelIds: string[] };
type Query = {
  args: { teamId: string; paginationOpts: { id: number; numItems: number; cursor: string | null } };
  value: { page: Row[]; isDone: boolean; continueCursor: string };
};

const TEAM = "team-1" as Id<"teams">;
const row = (id: string, status: IssueStatus, sortOrder: number): Row => ({ ...card(id, status, sortOrder), labelIds: [] });
const query = (teamId: string, cursor: string | null, page: Row[], isDone: boolean): Query => ({
  args: { teamId, paginationOpts: { id: 0, numItems: 500, cursor } },
  value: { page, isDone, continueCursor: `after-${cursor}` },
});

/** A local store holding the loaded `listByTeam` pages: two of this team's, top page first, and one of another team's. */
function loadedBoard() {
  const queries = [
    query(TEAM, null, [row("A", "todo", 30), row("P", "in_progress", 26), row("B", "todo", 20)], false),
    query(TEAM, "page-2", [row("C", "todo", 10), row("Y", "backlog", 5)], true),
    query("team-2", null, [row("Y", "backlog", 5)], true),
  ];
  const localStore = fakeLocalStore(queries);
  const teamRows = () => queries.slice(0, 2).flatMap(({ value }) => value.page);
  return { queries, localStore, teamRows };
}

describe("updateBoard", () => {
  it("moves a page-2 card into another column between two page-1 cards, in place on its own page", () => {
    const { queries, localStore, teamRows } = loadedBoard();
    const otherTeam = queries[2].value;
    const before = boardColumns(teamRows());
    const todo = [...before.todo];
    todo.splice(1, 0, "Y" as Id<"issues">);
    const column = todo.map((id) => teamRows().find((issue) => issue._id === id)!);

    const drop = dropRank({ column, index: 1, loaded: allLoaded(5), fromOtherColumn: true });
    expect(drop).toEqual({ sortOrder: 25 });
    updateBoard(localStore, TEAM, { issueId: "Y" as Id<"issues">, status: "todo", sortOrder: 25 });

    expect(queries[1].value.page).toEqual([row("C", "todo", 10), row("Y", "todo", 25)]);
    expect(boardColumns(teamRows()).todo).toEqual(["A", "Y", "B", "C"]);
    expect(boardColumns(teamRows()).backlog).toEqual([]);
    const ids = teamRows().map((issue) => issue._id);
    expect(new Set(ids).size).toBe(ids.length);
    expect(queries[2].value).toBe(otherTeam);
  });

  it("keeps the status when only the rank changes", () => {
    const { queries, localStore } = loadedBoard();
    updateBoard(localStore, TEAM, { issueId: "B" as Id<"issues">, sortOrder: 40 });
    expect(queries[0].value.page[2]).toEqual(row("B", "todo", 40));
  });
});
