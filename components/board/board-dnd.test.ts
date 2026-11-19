import { describe, expect, it } from "vitest";
import type { Id } from "@/convex/_generated/dataModel";
import type { IssueStatus } from "@/components/shared/issue-meta";
import { fakeLocalStore } from "@/components/fake-local-store";
import { byRank, respaceTie, SORT_GAP } from "@/lib/sort-order";
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

describe("dropRank", () => {
  it("ranks a drop between two cards at the mean of their ranks", () => {
    expect(dropRank([A, X, B], 1, true, 5, true)).toEqual({ sortOrder: 25 });
  });

  it("ranks a drop at the top above the top card", () => {
    expect(dropRank([X, A, B], 0, true, 5, true)).toEqual({ sortOrder: 30 + SORT_GAP });
  });

  it("ranks a drop at the bottom below the bottom card once every page is loaded", () => {
    expect(dropRank([A, B, X], 2, false, 5, true)).toEqual({ sortOrder: 20 - SORT_GAP });
  });

  it("keeps the card's rank in an empty column", () => {
    expect(dropRank([X], 0, false, 5, true)).toEqual({ sortOrder: 5 });
    expect(dropRank([X], 0, true, 5, true)).toEqual({ sortOrder: 5 });
  });

  it("lands a drop at the bottom of a column between the bottom card and the floor while more is to load", () => {
    expect(dropRank([A, B, X], 2, true, 5, true)).toEqual({ sortOrder: 12.5 });
    expect(dropRank([B, C, A], 2, true, 5, false)).toEqual({ sortOrder: 7.5 });
  });

  it("refuses a drop at the bottom of a column whose bottom card is the floor while more is to load", () => {
    expect(dropRank([B, C, A], 2, true, 10, false)).toEqual({ refused: true });
  });

  it("refuses a move within a column between two cards tied at the floor while more is to load", () => {
    const subtask = card("T2", "todo", 10, 2);
    const story = card("T1", "todo", 10, 1);
    const moved = card("M", "todo", 50);
    expect(dropRank([A, subtask, moved, story], 2, true, 10, false)).toEqual({ refused: true });
  });

  it("keeps the rank of a card moved in from another column onto a spot that can't be ranked, so its status still changes", () => {
    const subtask = card("T2", "todo", 10, 2);
    const story = card("T1", "todo", 10, 1);
    const moved = card("M", "in_progress", 50);
    expect(dropRank([A, subtask, moved, story], 2, true, 10, true)).toEqual({ sortOrder: 50 });
    expect(dropRank([B, C, moved], 2, true, 10, true)).toEqual({ sortOrder: 50 });
  });

  it("reorders within the card's own column between loaded cards while more is to load", () => {
    expect(dropRank([B, A, C], 1, true, 10, false)).toEqual({ sortOrder: 15 });
  });
});

type Issue = ReturnType<typeof card>;

/** `placeRank` (convex/issues.ts): the team's other rows at the new rank re-space downward toward the next lower rank. */
function placeRank(team: Issue[], moved: Issue, rank: number): Issue[] | undefined {
  const atRank = (sortOrder: number) =>
    team.filter((issue) => issue._id !== moved._id && issue.sortOrder === sortOrder).sort((a, b) => a._creationTime - b._creationTime);
  const nextLower = (sortOrder: number) => {
    const lower = team.filter((issue) => issue.sortOrder < sortOrder).map((issue) => issue.sortOrder);
    return lower.length > 0 ? Math.max(...lower) : undefined;
  };
  const tied = atRank(rank);
  const placed = new Map([[moved._id, rank]]);
  if (tied.length > 0) {
    const below: Issue[] = [];
    let lower = nextLower(rank);
    let ranks = respaceTie(rank, tied.length, lower, below.length);
    while (ranks === undefined && lower !== undefined) {
      below.push(...atRank(lower));
      lower = nextLower(lower);
      ranks = respaceTie(rank, tied.length, lower, below.length);
    }
    if (ranks === undefined) {
      return undefined;
    }
    placed.set(moved._id, ranks.moved);
    tied.forEach((issue, index) => placed.set(issue._id, ranks.tied[index]));
    below.forEach((issue, index) => placed.set(issue._id, ranks.below[index]));
  }
  return team.map((issue) => ({ ...issue, sortOrder: placed.get(issue._id) ?? issue.sortOrder }));
}

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
  it("never moves a loaded card off the loaded pages once the server re-spaces ties, over 200 random drops", () => {
    const next = random(42);
    const pick = <T,>(items: T[]) => items[Math.floor(next() * items.length)];
    const outcomes = { refused: 0, placed: 0, respaced: 0 };
    for (let trial = 0; trial < 200; trial++) {
      const size = 4 + Math.floor(next() * 12);
      const team = Array.from({ length: size }, (_, i) => card(`I${i}`, pick(STATUSES), 1000 * Math.floor(next() * 5), i)).sort(byRank);
      const loaded = team.slice(0, 1 + Math.floor(next() * (size - 1)));
      const end = loaded[loaded.length - 1];
      const onLoadedPages = (issue: Issue) => byRank(issue, end) <= 0;
      const moved = pick(loaded);
      const status = pick(STATUSES);
      const column = loaded.filter((issue) => issue.status === status && issue._id !== moved._id);
      const index = Math.floor(next() * (column.length + 1));
      column.splice(index, 0, moved);

      const drop = dropRank(column, index, true, end.sortOrder, moved.status !== status);
      if ("refused" in drop) {
        outcomes.refused++;
        continue;
      }
      const after = drop.sortOrder === moved.sortOrder ? team : placeRank(team, moved, drop.sortOrder);
      expect(after, `trial ${trial}: the server has room`).toBeDefined();
      outcomes.placed++;
      const changed = after!.filter((issue, i) => issue.sortOrder !== team[i].sortOrder);
      outcomes.respaced += changed.length > 1 ? 1 : 0;
      for (const issue of changed) {
        expect(issue.sortOrder, `trial ${trial}: ${issue._id} ranks above the floor`).toBeGreaterThan(end.sortOrder);
      }
      const ids = new Set(loaded.map((issue) => issue._id));
      for (const issue of after!.filter((row) => ids.has(row._id))) {
        expect(onLoadedPages(issue), `trial ${trial}: ${issue._id} stays on the loaded pages`).toBe(true);
      }
    }
    expect(outcomes.refused).toBeGreaterThan(0);
    expect(outcomes.respaced).toBeGreaterThan(0);
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

    const drop = dropRank(column, 1, false, 5, true);
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
