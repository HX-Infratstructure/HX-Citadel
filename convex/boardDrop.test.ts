/**
 * The board's and the backlog's drop rules against the server's real re-ranking. `placeRank` re-spaces a tie upward,
 * never below the requested rank, so every rank the browser accepts above the floor keeps each loaded row loaded.
 */
import type { PaginationOptions } from "convex/server";
import { describe, expect, test } from "vitest";
import { backlogDrop } from "../components/backlog/backlog-dnd";
import { dropRank } from "../components/board/board-dnd";
import { byRank, rankInLoaded } from "../lib/sort-order";
import { api } from "./_generated/api";
import { Doc, Id } from "./_generated/dataModel";
import { ORG, workspaceTest } from "./workspace.fixture";

type Row = { title: string; sortOrder: number; status?: Doc<"issues">["status"] };

/** The workspace's ENG team holding `rows` as stories, inserted in order, so each is newer than the one before. */
async function teamWith(rows: Row[]) {
  const t = await workspaceTest({ members: [{ clerkId: "user_m", role: "member" }] });
  const { teamId, ids } = await t.run(async (ctx) => {
    const team = (await ctx.db.query("teams").first())!;
    const creatorId = (await ctx.db.query("users").first())!._id;
    const ids: Record<string, Id<"issues">> = {};
    for (const { title, sortOrder, status = "todo" } of rows) {
      const story = { orgId: team.orgId, teamId: team._id, kind: "story", priority: "none", creatorId } as const;
      ids[title] = await ctx.db.insert("issues", { ...story, title, status, sortOrder });
    }
    return { teamId: team._id, ids };
  });
  const asMember = t.withIdentity({ subject: "user_m", org_id: ORG });
  const ranks = async () => {
    const issues = await t.run((ctx) => ctx.db.query("issues").collect());
    return new Map(issues.map((issue) => [issue._id, issue.sortOrder]));
  };
  const move = (title: string, sortOrder: number) => asMember.mutation(api.issues.update, { issueId: ids[title], sortOrder });
  return { asMember, teamId, ids, ranks, move };
}

type Team = Awaited<ReturnType<typeof teamWith>>;
type Read = (paginationOpts: PaginationOptions) => Promise<{ page: Doc<"issues">[]; continueCursor: string; isDone: boolean }>;

const board = ({ asMember, teamId }: Team): Read => (paginationOpts) => asMember.query(api.issues.listByTeam, { teamId, paginationOpts });
const backlog = ({ asMember, teamId }: Team): Read => (paginationOpts) => asMember.query(api.issues.listBacklog, { teamId, paginationOpts });

/** Page 1 of `numItems` rows, and a reader for it as the browser keeps it: pinned to the end it first returned. */
async function pageOne(read: Read, numItems: number) {
  const first = await read({ numItems, cursor: null });
  const pinned = async () => (await read({ numItems, cursor: null, endCursor: first.continueCursor })).page.map((issue) => issue._id);
  return { first, held: first.page.map((issue) => issue._id), pinned };
}

const FLOOR_TIE: Row[] = [
  { title: "Moved", sortOrder: 50 },
  { title: "B", sortOrder: 40 },
  { title: "C", sortOrder: 30 },
  { title: "Tie older", sortOrder: 20 },
  { title: "Tie newer", sortOrder: 20 },
  { title: "D", sortOrder: 10 },
  { title: "E", sortOrder: 0 },
];

describe("a board drop onto the tie at the floor (thermos round 1)", () => {
  test("page 1 ends on the tie at the floor, with more to load", async () => {
    const team = await teamWith(FLOOR_TIE);
    const { first } = await pageOne(board(team), 5);
    expect(first.page.map((issue) => issue.title)).toEqual(["Moved", "B", "C", "Tie newer", "Tie older"]);
    expect(first.isDone).toBe(false);
  });

  test("the server's repair of that tie keeps every row of page 1 loaded", async () => {
    const team = await teamWith(FLOOR_TIE);
    const { held, pinned } = await pageOne(board(team), 5);
    await team.move("Moved", 20);
    expect(await pinned()).toEqual(expect.arrayContaining(held));
  });

  test("rankInLoaded still asks to load more for that drop, because its rank is the floor", () => {
    expect(rankInLoaded({ above: 20, below: 20, own: 50, floor: 20, moreToLoad: true })).toEqual({ kind: "refused", reason: "loadMore" });
  });

  test("every drop rankInLoaded accepts keeps all of page 1 loaded after the server ranks it", async () => {
    const drops = [
      { above: undefined, below: 40 },
      { above: 40, below: 30 },
      { above: 30, below: 20 },
      { above: 20, below: undefined },
    ];
    let accepted = 0;
    for (const drop of drops) {
      const team = await teamWith(FLOOR_TIE);
      const { held, pinned } = await pageOne(board(team), 5);
      const result = rankInLoaded({ ...drop, own: 50, floor: 20, moreToLoad: true });
      if (result.kind !== "ranked") {
        continue;
      }
      accepted += 1;
      await team.move("Moved", result.sortOrder);
      expect(await pinned(), `drop ${JSON.stringify(drop)} at ${result.sortOrder}`).toEqual(expect.arrayContaining(held));
    }
    expect(accepted).toBe(3);
  });
});

describe("a drop between neighbours too close for a distinct midpoint (CodeRabbit 4623425278)", () => {
  const D = 999.9999999999999;
  const rows: Row[] = [{ title: "A", sortOrder: 2000 }, { title: "B", sortOrder: 1000 }, { title: "D", sortOrder: D }, { title: "E", sortOrder: 0 }];

  test("the server's repair keeps every row of page 1 loaded, and rankInLoaded refuses it for room", async () => {
    const team = await teamWith(rows);
    const { held, pinned } = await pageOne(board(team), 3);
    expect((1000 + D) / 2).toBe(1000);
    expect(rankInLoaded({ above: 1000, below: D, own: 2000, floor: D, moreToLoad: true })).toEqual({ kind: "refused", reason: "noRoom" });
    await team.move("A", 1000);
    expect(await pinned()).toEqual(expect.arrayContaining(held));
  });
});

describe("a drop whose midpoint ties a loaded row in another column (CodeRabbit 4623501051)", () => {
  const X = 1000.0000000000001;
  const D = 999.9999999999999;
  const rows: Row[] = [
    { title: "M", sortOrder: 2000 },
    { title: "X", sortOrder: X },
    { title: "B", sortOrder: 1000, status: "in_progress" },
    { title: "D", sortOrder: D, status: "backlog" },
    { title: "E", sortOrder: 0, status: "backlog" },
  ];
  const loaded = { floor: D, moreToLoad: true };

  test("dropRank accepts the tied rank within the column, and the server's repair keeps every row of page 1", async () => {
    const team = await teamWith(rows);
    const { first, held, pinned } = await pageOne(board(team), 4);
    const card = (title: string) => first.page.find((issue) => issue.title === title)!;
    expect(first.isDone).toBe(false);
    expect(dropRank({ column: [card("X"), card("M")], index: 1, loaded, fromOtherColumn: false })).toEqual({ kind: "ranked", sortOrder: 1000 });
    await team.move("M", 1000);
    expect(await pinned()).toEqual(expect.arrayContaining(held));
  });

  test("a card moved in from another column onto a spot that can't be ranked keeps its rank, and page 1 keeps every row", async () => {
    const team = await teamWith(rows);
    const { first, held, pinned } = await pageOne(board(team), 4);
    const card = (title: string) => first.page.find((issue) => issue.title === title)!;
    expect(dropRank({ column: [card("D"), card("M")], index: 1, loaded, fromOtherColumn: true })).toEqual({ kind: "inPlace" });
    await team.asMember.mutation(api.issues.update, { issueId: team.ids.M, status: "backlog" });
    expect(await pinned()).toEqual(held);
  });
});

describe("a backlog drop whose midpoint ties a row outside the backlog (CodeRabbit 4623632695)", () => {
  test("backlogDrop accepts it, and the server's repair keeps every row of the pinned backlog page", async () => {
    const team = await teamWith([
      { title: "M", sortOrder: 2000 },
      { title: "X", sortOrder: 1000.0000000000001 },
      { title: "N", sortOrder: 1000, status: "done" },
      { title: "D", sortOrder: 999.9999999999999 },
      { title: "E", sortOrder: 0 },
    ]);
    const { first, held, pinned } = await pageOne(backlog(team), 3);
    expect(first.page.map((issue) => issue.title)).toEqual(["M", "X", "D"]);
    expect(backlogDrop({ stories: first.page, activeId: first.page[0]._id, overId: first.page[1]._id, moreToLoad: true })).toEqual({ kind: "ranked", sortOrder: 1000 });
    await team.move("M", 1000);
    expect(await pinned()).toEqual(expect.arrayContaining(held));
  });
});

describe("a harmless tie on the 1000-step grid (thermos round 3)", () => {
  test("is accepted, lands between its neighbours, writes nothing below its rank and keeps page 1 whole", async () => {
    const team = await teamWith([
      { title: "S300", sortOrder: 300000 },
      { title: "S299", sortOrder: 299000, status: "in_progress" },
      { title: "T299", sortOrder: 299000, status: "in_progress" },
      { title: "S298", sortOrder: 298000 },
      { title: "S290", sortOrder: 290000 },
      { title: "S51", sortOrder: 51000 },
      { title: "E", sortOrder: 0 },
    ]);
    const { first, held, pinned } = await pageOne(board(team), 6);
    const card = (title: string) => first.page.find((issue) => issue.title === title)!;
    const column = [card("S300"), card("S290"), card("S298"), card("S51")];
    const drop = dropRank({ column, index: 1, loaded: { floor: 51000, moreToLoad: true }, fromOtherColumn: false });
    expect(drop).toEqual({ kind: "ranked", sortOrder: 299000 });
    const before = await team.ranks();
    await team.move("S290", 299000);
    const after = await team.ranks();
    const written = [...after].filter(([id, rank]) => before.get(id) !== rank).map(([, rank]) => rank);
    expect(Math.min(...written)).toBeGreaterThanOrEqual(299000);
    expect(after.get(team.ids.S300)! > after.get(team.ids.S290)! && after.get(team.ids.S290)! > after.get(team.ids.S298)!).toBe(true);
    expect(await pinned()).toEqual(expect.arrayContaining(held));
  });
});

/** A small deterministic generator (mulberry32), so a failing trial can be replayed by its seed. */
function random(seed: number) {
  let state = seed;
  return () => {
    state = (state + 0x6d2b79f5) | 0;
    let mixed = Math.imul(state ^ (state >>> 15), 1 | state);
    mixed = (mixed + Math.imul(mixed ^ (mixed >>> 7), 61 | mixed)) ^ mixed;
    return ((mixed ^ (mixed >>> 14)) >>> 0) / 4294967296;
  };
}

/** 6 to 10 rows on a coarse grid, with heavy ties and clusters one ulp apart that leave a gap no room. */
function randomRanks(next: () => number) {
  const pick = <T,>(items: T[]) => items[Math.floor(next() * items.length)];
  const ranks: number[] = [];
  for (let i = 6 + Math.floor(next() * 5); i > 0; i--) {
    const grid = 1000 * (1 + Math.floor(next() * 5));
    ranks.push(pick([grid, grid, pick(ranks.length ? ranks : [grid]), grid + Number.EPSILON * grid * pick([1, 2, 3])]));
  }
  return ranks;
}

/** Where the server puts the moved row among the others, listed by rank: the middle of a tie at `rank`, below a single tied row. */
function expectedIndex(others: Doc<"issues">[], rank: number) {
  const above = others.filter((issue) => issue.sortOrder > rank).length;
  const tied = others.filter((issue) => issue.sortOrder === rank).length;
  return above + Math.ceil(tied / 2);
}

describe("the upward tie repair over random teams (T2)", () => {
  test("writes nothing below the requested rank, keeps the others' order, places the moved row at its slot and keeps page 1 whole", async () => {
    for (let seed = 1; seed <= 40; seed++) {
      const next = random(seed);
      const ranks = randomRanks(next);
      const team = await teamWith(ranks.map((sortOrder, index) => ({ title: `R${index}`, sortOrder })));
      const { held, pinned } = await pageOne(board(team), Math.ceil(ranks.length / 2));
      const mover = `R${Math.floor(next() * ranks.length)}`;
      const rank = ranks[Math.floor(next() * ranks.length)];
      const all = async () => (await board(team)({ numItems: 50, cursor: null })).page;
      const before = (await all()).filter((issue) => issue._id !== team.ids[mover]);
      const ranksBefore = await team.ranks();
      if (ranksBefore.get(team.ids[mover]) === rank) {
        continue;
      }
      await team.move(mover, rank);
      const after = await all();
      const ranksAfter = await team.ranks();
      const label = `seed ${seed}: ${mover} to ${rank} over ${ranks.join(", ")}`;
      const written = [...ranksAfter].filter(([id, r]) => ranksBefore.get(id) !== r || id === team.ids[mover]).map(([, r]) => r);
      expect(Math.min(...written), label).toBeGreaterThanOrEqual(rank);
      expect(after.filter((issue) => issue._id !== team.ids[mover]).map((issue) => issue._id), label).toEqual(before.map((issue) => issue._id));
      expect(after.findIndex((issue) => issue._id === team.ids[mover]), label).toBe(expectedIndex(before, rank));
      expect([...after].sort(byRank).map((issue) => issue._id), label).toEqual(after.map((issue) => issue._id));
      const kept = held.filter((id) => id !== team.ids[mover]);
      expect(await pinned(), label).toEqual(expect.arrayContaining(kept));
    }
  });
});
