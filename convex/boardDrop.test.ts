/**
 * The board's drop rule against the server's real re-ranking. `placeRank` re-spaces a tie toward the next lower rank,
 * so a drop onto a rank tied at the lowest loaded rank (the floor) moved rows below the loaded page's pinned end and
 * hid them until Load more. `rankInLoaded` refuses that drop; a drop it accepts keeps every loaded row loaded.
 */
import { convexTest } from "convex-test";
import { describe, expect, test } from "vitest";
import { dropRank } from "../components/board/board-dnd";
import { rankInLoaded } from "../lib/sort-order";
import { api } from "./_generated/api";
import { Id } from "./_generated/dataModel";
import schema from "./schema";

const modules = import.meta.glob("./**/*.*s");
const PAGE = 5;

/** A team whose first page of 5 ends on two rows tied at rank 20, with two more rows below it. */
async function boardWithTieAtFloor() {
  const t = convexTest({ schema, modules });
  const ids = await t.run(async (ctx) => {
    const userId = await ctx.db.insert("users", { clerkId: "user_m", name: "M", email: "m@example.com" });
    const orgId = await ctx.db.insert("organizations", { clerkOrgId: "org_t", name: "T", slug: "t" });
    await ctx.db.insert("members", { orgId, userId, role: "member", clerkMembershipId: "mem" });
    const teamId = await ctx.db.insert("teams", { orgId, name: "E", key: "ENG", nextIssueNumber: 1 });
    const story = { orgId, teamId, kind: "story", status: "todo", priority: "none", creatorId: userId } as const;
    const row = (title: string, sortOrder: number) => ctx.db.insert("issues", { ...story, title, sortOrder });
    return {
      teamId,
      moved: await row("Moved", 50),
      b: await row("B", 40),
      c: await row("C", 30),
      tieOlder: await row("Tie older", 20),
      tieNewer: await row("Tie newer", 20),
      d: await row("D", 10),
      e: await row("E", 0),
    };
  });
  const asMember = t.withIdentity({ subject: "user_m", org_id: "org_t" });
  const first = await asMember.query(api.issues.listByTeam, {
    teamId: ids.teamId,
    paginationOpts: { numItems: PAGE, cursor: null },
  });
  /** Page 1 as the browser keeps it: pinned to the end it first returned. */
  const pageOne = async () =>
    (
      await asMember.query(api.issues.listByTeam, {
        teamId: ids.teamId,
        paginationOpts: { numItems: PAGE, cursor: null, endCursor: first.continueCursor },
      })
    ).page.map((issue) => issue._id as Id<"issues">);
  const rankOf = async (id: Id<"issues">) => (await t.run((ctx) => ctx.db.get(id)))!.sortOrder;
  return { t, asMember, ids, first, pageOne, rankOf };
}

describe("a board drop against the server's re-ranking", () => {
  test("page 1 ends on the tie at the floor, with more to load", async () => {
    const { ids, first } = await boardWithTieAtFloor();
    expect(first.page.map((issue) => issue._id)).toEqual([ids.moved, ids.b, ids.c, ids.tieNewer, ids.tieOlder]);
    expect(first.isDone).toBe(false);
  });

  test("the old rule's tied rank hides loaded rows once the server re-spaces the tie", async () => {
    const { asMember, ids, pageOne } = await boardWithTieAtFloor();
    await asMember.mutation(api.issues.update, { issueId: ids.moved, sortOrder: 20 });
    const loaded = await pageOne();
    expect([ids.moved, ids.tieNewer, ids.tieOlder].some((id) => !loaded.includes(id))).toBe(true);
  });

  test("rankInLoaded refuses that drop", () => {
    expect(rankInLoaded({ above: 20, below: 20, floor: 20, taken: new Set([40, 30, 20]), moreToLoad: true })).toEqual({ refused: true });
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
      const { asMember, ids, first, pageOne, rankOf } = await boardWithTieAtFloor();
      const taken = new Set(first.page.filter((issue) => issue._id !== ids.moved).map((issue) => issue.sortOrder));
      const result = rankInLoaded({ ...drop, floor: 20, taken, moreToLoad: true });
      if ("refused" in result) {
        continue;
      }
      accepted += 1;
      await asMember.mutation(api.issues.update, { issueId: ids.moved, sortOrder: result.sortOrder });
      const loaded = await pageOne();
      for (const id of [ids.moved, ids.b, ids.c, ids.tieNewer, ids.tieOlder]) {
        expect(loaded, `drop ${JSON.stringify(drop)} at ${result.sortOrder}: ${id} rank ${await rankOf(id)}`).toContain(id);
      }
    }
    expect(accepted).toBe(3);
  });
});

describe("a drop between neighbours too close for a distinct midpoint (CodeRabbit 4623425278)", () => {
  test("the server's widened tie repair drops loaded rows below the floor, so rankInLoaded refuses that drop", async () => {
    const t = convexTest({ schema, modules });
    const ids = await t.run(async (ctx) => {
      const userId = await ctx.db.insert("users", { clerkId: "user_m", name: "M", email: "m@example.com" });
      const orgId = await ctx.db.insert("organizations", { clerkOrgId: "org_t", name: "T", slug: "t" });
      await ctx.db.insert("members", { orgId, userId, role: "member", clerkMembershipId: "mem" });
      const teamId = await ctx.db.insert("teams", { orgId, name: "E", key: "ENG", nextIssueNumber: 1 });
      const story = { orgId, teamId, kind: "story", status: "todo", priority: "none", creatorId: userId } as const;
      const row = (title: string, sortOrder: number) => ctx.db.insert("issues", { ...story, title, sortOrder });
      return { teamId, a: await row("A", 2000), b: await row("B", 1000), d: await row("D", 999.9999999999999), e: await row("E", 0) };
    });
    const asMember = t.withIdentity({ subject: "user_m", org_id: "org_t" });
    const first = await asMember.query(api.issues.listByTeam, { teamId: ids.teamId, paginationOpts: { numItems: 3, cursor: null } });
    expect(first.page.map((issue) => issue._id)).toEqual([ids.a, ids.b, ids.d]);
    const floor = 999.9999999999999;
    const proposed = (1000 + floor) / 2;
    expect(proposed).toBe(1000);
    expect(rankInLoaded({ above: 1000, below: floor, floor, taken: new Set([1000, floor]), moreToLoad: true })).toEqual({ refused: true });

    await asMember.mutation(api.issues.update, { issueId: ids.a, sortOrder: proposed });
    const pageOne = await asMember.query(api.issues.listByTeam, {
      teamId: ids.teamId,
      paginationOpts: { numItems: 3, cursor: null, endCursor: first.continueCursor },
    });
    expect([ids.a, ids.b, ids.d].some((id) => !pageOne.page.some((issue) => issue._id === id))).toBe(true);
  });
});

describe("a drop whose midpoint ties a loaded row in another column (CodeRabbit 4623501051)", () => {
  const X = 1000.0000000000001;
  const B = 1000;
  const D = 999.9999999999999;

  /** Page 1 of 4 holds M, X (todo), B (in progress) and D (backlog), the floor; E is not loaded. */
  async function boardAcrossColumns(movedStatus: "todo" | "backlog") {
    const t = convexTest({ schema, modules });
    const ids = await t.run(async (ctx) => {
      const userId = await ctx.db.insert("users", { clerkId: "user_m", name: "M", email: "m@example.com" });
      const orgId = await ctx.db.insert("organizations", { clerkOrgId: "org_t", name: "T", slug: "t" });
      await ctx.db.insert("members", { orgId, userId, role: "member", clerkMembershipId: "mem" });
      const teamId = await ctx.db.insert("teams", { orgId, name: "E", key: "ENG", nextIssueNumber: 1 });
      const story = { orgId, teamId, kind: "story", priority: "none", creatorId: userId } as const;
      const row = (title: string, status: "todo" | "in_progress" | "backlog", sortOrder: number) =>
        ctx.db.insert("issues", { ...story, title, status, sortOrder });
      return {
        teamId,
        m: await row("M", movedStatus, 2000),
        x: await row("X", "todo", X),
        b: await row("B", "in_progress", B),
        d: await row("D", "backlog", D),
        e: await row("E", "backlog", 0),
      };
    });
    const asMember = t.withIdentity({ subject: "user_m", org_id: "org_t" });
    const first = await asMember.query(api.issues.listByTeam, { teamId: ids.teamId, paginationOpts: { numItems: 4, cursor: null } });
    const pageOne = async () =>
      (
        await asMember.query(api.issues.listByTeam, {
          teamId: ids.teamId,
          paginationOpts: { numItems: 4, cursor: null, endCursor: first.continueCursor },
        })
      ).page.map((issue) => issue._id as Id<"issues">);
    const loadedRanks = new Map(first.page.map((issue) => [issue._id, issue.sortOrder]));
    const card = (id: Id<"issues">) => first.page.find((issue) => issue._id === id)!;
    return { asMember, ids, first, pageOne, loadedRanks, card };
  }

  test("the old rule's rank, the midpoint of X and the floor, ties B and moves D off page 1", async () => {
    const { asMember, ids, first, pageOne } = await boardAcrossColumns("todo");
    expect(first.page.map((issue) => issue._id)).toEqual([ids.m, ids.x, ids.b, ids.d]);
    expect(first.isDone).toBe(false);
    expect((X + D) / 2).toBe(B);
    await asMember.mutation(api.issues.update, { issueId: ids.m, sortOrder: (X + D) / 2 });
    expect(await pageOne()).not.toContain(ids.d);
  });

  test("dropRank refuses that move within the column", async () => {
    const { ids, first, loadedRanks, card } = await boardAcrossColumns("todo");
    expect(dropRank([card(ids.x), card(ids.m)], 1, true, D, loadedRanks, false)).toEqual({ refused: true });
    expect(first.page.at(-1)?.sortOrder).toBe(D);
  });

  test("a card moved in from another column keeps its rank, and page 1 keeps every row", async () => {
    const { asMember, ids, pageOne, loadedRanks, card } = await boardAcrossColumns("backlog");
    const drop = dropRank([card(ids.x), card(ids.m)], 1, true, D, loadedRanks, true);
    expect(drop).toEqual({ sortOrder: 2000 });
    await asMember.mutation(api.issues.update, { issueId: ids.m, status: "todo" });
    expect(await pageOne()).toEqual([ids.m, ids.x, ids.b, ids.d]);
  });
});
