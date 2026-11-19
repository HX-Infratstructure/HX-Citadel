/// <reference types="vite/client" />
import { convexTest } from "convex-test";
import { ConvexError } from "convex/values";
import { afterEach, beforeEach, describe, expect, test } from "vitest";
import { api } from "./_generated/api";
import { Id } from "./_generated/dataModel";
import { LIST_LIMIT, PAGE_READ_ROWS } from "./issues";
import schema from "./schema";

const modules = import.meta.glob("./**/*.*s");

const ORG_CLAIM = "org_test";
const MEMBER_CLERK_ID = "user_member";
const OUTSIDER_CLERK_ID = "user_outsider";
const FIRST_NUMBER = 7;

type Setup = Awaited<ReturnType<typeof setup>>;

async function setup(transactionLimits?: { documentsRead: number }) {
  const t = convexTest({ schema, modules, transactionLimits });
  const { teamId, memberId } = await t.run(async (ctx) => {
    const memberId = await ctx.db.insert("users", {
      clerkId: MEMBER_CLERK_ID,
      name: "Member",
      email: "member@example.com",
    });
    await ctx.db.insert("users", {
      clerkId: OUTSIDER_CLERK_ID,
      name: "Outsider",
      email: "outsider@example.com",
    });
    const orgId = await ctx.db.insert("organizations", {
      clerkOrgId: ORG_CLAIM,
      name: "Test Org",
      slug: "test-org",
    });
    await ctx.db.insert("members", {
      orgId,
      userId: memberId,
      role: "member",
      clerkMembershipId: "mem_member",
    });
    const teamId = await ctx.db.insert("teams", {
      orgId,
      name: "Engineering",
      key: "ENG",
      nextIssueNumber: FIRST_NUMBER,
    });
    return { teamId, memberId };
  });
  return { t, teamId, memberId };
}

describe("issues.create", () => {
  test("numbers consecutive issues from the team counter and logs each creation", async () => {
    const { t, teamId, memberId } = await setup();
    const asMember = t.withIdentity({
      subject: MEMBER_CLERK_ID,
      org_id: ORG_CLAIM,
    });

    const firstId = await asMember.mutation(api.issues.create, {
      teamId,
      title: "First",
    });
    const secondId = await asMember.mutation(api.issues.create, {
      teamId,
      title: "Second",
    });

    const first = await asMember.query(api.issues.get, { issueId: firstId });
    const second = await asMember.query(api.issues.get, { issueId: secondId });
    expect(first?.number).toBe(FIRST_NUMBER);
    expect(second?.number).toBe(FIRST_NUMBER + 1);

    for (const issueId of [firstId, secondId]) {
      const activity = await asMember.query(api.activity.listByIssue, {
        issueId,
      });
      expect(activity).toHaveLength(1);
      expect(activity[0]).toMatchObject({ type: "created", actorId: memberId });
    }
  });

  test("refuses a caller who is not a member of the active organization", async () => {
    const { t, teamId } = await setup();
    const asOutsider = t.withIdentity({
      subject: OUTSIDER_CLERK_ID,
      org_id: ORG_CLAIM,
    });

    await expect(
      asOutsider.mutation(api.issues.create, { teamId, title: "Intrusion" })
    ).rejects.toMatchObject({ data: { code: "not_found", message: "Not a member of this organization" } });

    const team = await t.run((ctx) => ctx.db.get(teamId));
    expect(team?.nextIssueNumber).toBe(FIRST_NUMBER);
  });
});

describe("issues.create on a free organization", () => {
  test("creates the 101st issue", async () => {
    const { t, teamId, memberId } = await setup();
    await t.run(async (ctx) => {
      const team = await ctx.db.get(teamId);
      for (let i = 0; i < 100; i++) {
        await ctx.db.insert("issues", {
          orgId: team!.orgId,
          teamId,
          kind: "story",
          number: i + 1,
          title: `Seeded ${i + 1}`,
          status: "todo",
          priority: "none",
          creatorId: memberId,
          sortOrder: (i + 1) * 1000,
        });
      }
    });
    const asMember = t.withIdentity({
      subject: MEMBER_CLERK_ID,
      org_id: ORG_CLAIM,
    });

    const issueId = await asMember.mutation(api.issues.create, {
      teamId,
      title: "Hundred and first",
    });

    const issues = await t.run((ctx) =>
      ctx.db
        .query("issues")
        .withIndex("by_team", (q) => q.eq("teamId", teamId))
        .collect()
    );
    expect(issues.filter((issue) => issue.kind === "story")).toHaveLength(101);
    expect(issues.map((issue) => issue._id)).toContain(issueId);
  });
});

const FIRST_PAGE = { numItems: LIST_LIMIT, cursor: null };

type BacklogPage = { page: { _id: Id<"issues">; sortOrder: number }[]; isDone: boolean; continueCursor: string };

/** Every page of the backlog, following the cursor until the last page. */
async function backlogPages<Page extends BacklogPage>(pageAt: (cursor: string | null) => Promise<Page>) {
  const pages: Page["page"][] = [];
  let cursor: string | null = null;
  for (;;) {
    const result: Page = await pageAt(cursor);
    pages.push(result.page);
    if (result.isDone) {
      return pages;
    }
    cursor = result.continueCursor;
  }
}

/** `LIST_LIMIT + 1` open stories in one status, the oldest ranked top; their ids in rank order. */
async function seedOldestRankedTop(t: Setup["t"], teamId: Id<"teams">, memberId: Id<"users">) {
  return await t.run(async (ctx) => {
    const team = await ctx.db.get(teamId);
    const ids = [];
    for (let i = 0; i <= LIST_LIMIT; i++) {
      ids.push(
        await ctx.db.insert("issues", {
          orgId: team!.orgId,
          teamId,
          kind: "story",
          title: `Story ${i}`,
          status: "todo",
          priority: "none",
          creatorId: memberId,
          sortOrder: (LIST_LIMIT + 1 - i) * 1000,
        })
      );
    }
    return ids;
  });
}

describe("issues.listBacklog", () => {
  test("lists the team's open stories with no cycle, highest sortOrder first", async () => {
    const { t, teamId, memberId } = await setup();
    const asMember = t.withIdentity({
      subject: MEMBER_CLERK_ID,
      org_id: ORG_CLAIM,
    });
    const cycleId = await t.run(async (ctx) => {
      const team = await ctx.db.get(teamId);
      return await ctx.db.insert("cycles", {
        orgId: team!.orgId,
        teamId,
        number: 1,
        startDate: 0,
        endDate: 6 * 24 * 60 * 60 * 1000,
      });
    });
    const low = await asMember.mutation(api.issues.create, { teamId, title: "Low" });
    const high = await asMember.mutation(api.issues.create, { teamId, title: "High" });
    await asMember.mutation(api.issues.create, { teamId, title: "Planned", cycleId });
    await t.run(async (ctx) => {
      const team = await ctx.db.get(teamId);
      const rows = [
        { kind: "story", title: "Done", status: "done" },
        { kind: "story", title: "Dropped", status: "canceled" },
        { kind: "epic", title: "Epic", status: "todo" },
      ] as const;
      for (const row of rows) {
        await ctx.db.insert("issues", {
          ...row,
          orgId: team!.orgId,
          teamId,
          creatorId: memberId,
          priority: "none",
          sortOrder: 99999,
        });
      }
    });
    await asMember.mutation(api.issues.update, { issueId: low, sortOrder: -5 });

    const { page: backlog } = await asMember.query(api.issues.listBacklog, { teamId, paginationOpts: FIRST_PAGE });

    expect(backlog.map((issue) => issue._id)).toEqual([high, low]);
  });

  test("refuses a caller who is not a member of the active organization", async () => {
    const { t, teamId } = await setup();
    const asOutsider = t.withIdentity({
      subject: OUTSIDER_CLERK_ID,
      org_id: ORG_CLAIM,
    });
    await expect(
      asOutsider.query(api.issues.listBacklog, { teamId, paginationOpts: FIRST_PAGE })
    ).rejects.toThrow();
  });

  test("the first page starts at the top-ranked story, the oldest, when one open status holds more than LIST_LIMIT", async () => {
    const { t, teamId, memberId } = await setup();
    const asMember = t.withIdentity({ subject: MEMBER_CLERK_ID, org_id: ORG_CLAIM });
    const rankOrder = await seedOldestRankedTop(t, teamId, memberId);

    const first = await asMember.query(api.issues.listBacklog, {
      teamId,
      paginationOpts: { numItems: LIST_LIMIT + 100, cursor: null },
    });

    expect(first.page[0]._id).toBe(rankOrder[0]);
    expect(first.page).toHaveLength(LIST_LIMIT);
    expect(first.isDone).toBe(false);
  });

  test("following the cursor reaches every story once, in rank order across pages", async () => {
    const { t, teamId, memberId } = await setup();
    const asMember = t.withIdentity({ subject: MEMBER_CLERK_ID, org_id: ORG_CLAIM });
    const rankOrder = await seedOldestRankedTop(t, teamId, memberId);

    const pages = await backlogPages((cursor) =>
      asMember.query(api.issues.listBacklog, { teamId, paginationOpts: { numItems: 200, cursor } })
    );

    const stories = pages.flat();
    expect(pages.length).toBeGreaterThan(2);
    expect(stories.map((issue) => issue._id)).toEqual(rankOrder);
    expect(stories.every((issue, i) => i === 0 || stories[i - 1].sortOrder > issue.sortOrder)).toBe(true);
  });

  test("stories with a cycle, other kinds and closed stories appear on no page", async () => {
    const { t, teamId, memberId } = await setup();
    const asMember = t.withIdentity({ subject: MEMBER_CLERK_ID, org_id: ORG_CLAIM });
    const listed = await t.run(async (ctx) => {
      const team = await ctx.db.get(teamId);
      const orgId = team!.orgId;
      const cycleId = await ctx.db.insert("cycles", { orgId, teamId, number: 1, startDate: 0, endDate: 1 });
      const story = { orgId, teamId, kind: "story", status: "todo", priority: "none", creatorId: memberId } as const;
      const rows = [
        { ...story, title: "Top", sortOrder: 9000, listed: true },
        { ...story, title: "Planned", sortOrder: 8000, cycleId, listed: false },
        { ...story, title: "Epic", sortOrder: 7000, kind: "epic", listed: false },
        { ...story, title: "Sub-task", sortOrder: 6000, kind: "subtask", listed: false },
        { ...story, title: "In progress", sortOrder: 5000, status: "in_progress", listed: true },
        { ...story, title: "Done", sortOrder: 4000, status: "done", listed: false },
        { ...story, title: "Canceled", sortOrder: 3000, status: "canceled", listed: false },
        { ...story, title: "Backlog", sortOrder: 1000, status: "backlog", listed: true },
      ] as const;
      const ids = [];
      for (const { listed, ...row } of rows) {
        const id = await ctx.db.insert("issues", row);
        if (listed) {
          ids.push(id);
        }
      }
      return ids;
    });

    const pages = await backlogPages((cursor) =>
      asMember.query(api.issues.listBacklog, { teamId, paginationOpts: { numItems: 1, cursor } })
    );

    expect(pages.flat().map((issue) => issue._id)).toEqual(listed);
  });
  test("closed stories count toward a page's reads: a page stops after PAGE_READ_ROWS, and the cursor reaches an open story ranked below them", async () => {
    const { t, teamId, memberId } = await setup();
    const asMember = t.withIdentity({ subject: MEMBER_CLERK_ID, org_id: ORG_CLAIM });
    const openId = await t.run(async (ctx) => {
      const team = await ctx.db.get(teamId);
      const story = { orgId: team!.orgId, teamId, kind: "story", priority: "none", creatorId: memberId } as const;
      for (let i = 0; i < PAGE_READ_ROWS + 1_000; i++) {
        await ctx.db.insert("issues", { ...story, title: `Shipped ${i}`, status: "done", sortOrder: 10_000 + i });
      }
      return await ctx.db.insert("issues", { ...story, title: "Open", status: "todo", sortOrder: 0 });
    });

    const pages = await backlogPages((cursor) =>
      asMember.query(api.issues.listBacklog, { teamId, paginationOpts: { numItems: LIST_LIMIT, cursor } })
    );

    expect(pages[0]).toEqual([]);
    expect(pages.flat().map((issue) => issue._id)).toEqual([openId]);
  });
});

describe("issues.listParentCandidates", () => {
  test("offers an older open feature to a story when the team has more than 500 newer issues", async () => {
    const { t, teamId, memberId } = await setup();
    const asMember = t.withIdentity({
      subject: MEMBER_CLERK_ID,
      org_id: ORG_CLAIM,
    });
    const { openFeature } = await t.run(async (ctx) => {
      const team = await ctx.db.get(teamId);
      const base = {
        orgId: team!.orgId,
        teamId,
        creatorId: memberId,
        priority: "none",
        sortOrder: 1000,
      } as const;
      const openFeature = await ctx.db.insert("issues", {
        ...base,
        kind: "feature",
        title: "Old open feature",
        status: "todo",
      });
      await ctx.db.insert("issues", { ...base, kind: "feature", title: "Shipped feature", status: "done" });
      await ctx.db.insert("issues", { ...base, kind: "epic", title: "Open epic", status: "todo" });
      for (let i = 0; i < 501; i++) {
        await ctx.db.insert("issues", { ...base, kind: "story", title: `Newer ${i}`, status: "todo" });
      }
      return { openFeature };
    });

    const candidates = await asMember.query(api.issues.listParentCandidates, {
      teamId,
      kind: "story",
    });

    expect(candidates.map((issue) => issue._id)).toEqual([openFeature]);
  });

  test("offers no parent to an epic", async () => {
    const { t, teamId, memberId } = await setup();
    const asMember = t.withIdentity({
      subject: MEMBER_CLERK_ID,
      org_id: ORG_CLAIM,
    });
    await t.run(async (ctx) => {
      const team = await ctx.db.get(teamId);
      await ctx.db.insert("issues", {
        orgId: team!.orgId,
        teamId,
        kind: "epic",
        title: "Open epic",
        status: "todo",
        creatorId: memberId,
        priority: "none",
        sortOrder: 1000,
      });
    });

    const candidates = await asMember.query(api.issues.listParentCandidates, {
      teamId,
      kind: "epic",
    });

    expect(candidates).toEqual([]);
  });

  test("refuses a caller who is not a member of the active organization", async () => {
    const { t, teamId } = await setup();
    const asOutsider = t.withIdentity({
      subject: OUTSIDER_CLERK_ID,
      org_id: ORG_CLAIM,
    });
    await expect(
      asOutsider.query(api.issues.listParentCandidates, { teamId, kind: "story" })
    ).rejects.toThrow();
  });

  test("offers at most LIST_LIMIT parents, newest first", async () => {
    const { t, teamId, memberId } = await setup();
    const asMember = t.withIdentity({ subject: MEMBER_CLERK_ID, org_id: ORG_CLAIM });
    const oldestFirst = await t.run(async (ctx) => {
      const team = await ctx.db.get(teamId);
      const ids = [];
      for (let i = 0; i <= LIST_LIMIT; i++) {
        ids.push(
          await ctx.db.insert("issues", {
            orgId: team!.orgId,
            teamId,
            kind: "feature",
            title: `Feature ${i}`,
            status: i % 2 === 0 ? "todo" : "in_progress",
            priority: "none",
            creatorId: memberId,
            sortOrder: 1000,
          })
        );
      }
      return ids;
    });

    const candidates = await asMember.query(api.issues.listParentCandidates, { teamId, kind: "story" });

    expect(candidates.map((issue) => issue._id)).toEqual(oldestFirst.slice(1).reverse());
  });
});

describe("issues.update projectId: null", () => {
  async function setupProject() {
    const { t, teamId } = await setup();
    const asMember = t.withIdentity({
      subject: MEMBER_CLERK_ID,
      org_id: ORG_CLAIM,
    });
    const projectId = await t.run(async (ctx) => {
      const team = await ctx.db.get(teamId);
      return await ctx.db.insert("projects", {
        orgId: team!.orgId,
        name: "Phase 2",
        status: "planned",
      });
    });
    return { t, teamId, asMember, projectId };
  }

  test("refuses to clear the project a story inherits from its feature", async () => {
    const { teamId, asMember, projectId } = await setupProject();
    const epic = await asMember.mutation(api.issues.create, {
      teamId,
      kind: "epic",
      title: "Epic",
      projectId,
    });
    const feature = await asMember.mutation(api.issues.create, {
      teamId,
      kind: "feature",
      title: "Feature",
      parentIssueId: epic,
    });
    const story = await asMember.mutation(api.issues.create, {
      teamId,
      title: "Story",
      parentIssueId: feature,
    });

    await expect(
      asMember.mutation(api.issues.update, { issueId: story, projectId: null })
    ).rejects.toThrow("project comes from its feature");

    const after = await asMember.query(api.issues.get, { issueId: story });
    expect(after!.projectId).toBe(projectId);
  });

  test("clears the project of a standalone story", async () => {
    const { teamId, asMember, projectId } = await setupProject();
    const story = await asMember.mutation(api.issues.create, {
      teamId,
      title: "Story",
      projectId,
    });

    await asMember.mutation(api.issues.update, { issueId: story, projectId: null });

    const after = await asMember.query(api.issues.get, { issueId: story });
    expect(after!.projectId).toBeUndefined();
  });
});

describe("issues.update with an unchanged project", () => {
  test("saves an epic with many features without walking its tree", async () => {
    const { t, teamId, memberId } = await setup({ documentsRead: 30 });
    const asMember = t.withIdentity({
      subject: MEMBER_CLERK_ID,
      org_id: ORG_CLAIM,
    });
    const { epic, projectId } = await t.run(async (ctx) => {
      const team = await ctx.db.get(teamId);
      const projectId = await ctx.db.insert("projects", {
        orgId: team!.orgId,
        name: "Phase 2",
        status: "planned",
      });
      const fields = {
        orgId: team!.orgId,
        teamId,
        status: "todo",
        priority: "none",
        creatorId: memberId,
        projectId,
        sortOrder: 0,
      } as const;
      const epic = await ctx.db.insert("issues", { ...fields, kind: "epic", title: "Epic" });
      for (let i = 0; i < 40; i++) {
        await ctx.db.insert("issues", {
          ...fields,
          kind: "feature",
          title: `Feature ${i}`,
          parentIssueId: epic,
        });
      }
      return { epic, projectId };
    });

    await asMember.mutation(api.issues.update, { issueId: epic, projectId, title: "Renamed" });

    const after = await asMember.query(api.issues.get, { issueId: epic });
    expect(after).toMatchObject({ title: "Renamed", projectId });
  });
});

describe("issue ranking", () => {
  test("ranks each new issue above the highest rank, even one re-ranked after it was created", async () => {
    const { t, teamId } = await setup();
    const asMember = t.withIdentity({ subject: MEMBER_CLERK_ID, org_id: ORG_CLAIM });
    const older = await asMember.mutation(api.issues.create, { teamId, title: "Older" });
    const newer = await asMember.mutation(api.issues.create, { teamId, title: "Newer" });
    const newerRank = (await asMember.query(api.issues.get, { issueId: newer }))!.sortOrder;
    await asMember.mutation(api.issues.update, { issueId: older, sortOrder: newerRank + 1000 });

    const first = await asMember.mutation(api.issues.create, { teamId, title: "First" });
    const second = await asMember.mutation(api.issues.create, { teamId, title: "Second" });

    const rank = async (issueId: typeof older) =>
      (await asMember.query(api.issues.get, { issueId }))!.sortOrder;
    expect(await rank(first)).toBeGreaterThan(await rank(older));
    expect(await rank(second)).toBeGreaterThan(await rank(first));
  });

  test("moving a story between two tied neighbours lands strictly between them", async () => {
    const { t, teamId, memberId } = await setup();
    const asMember = t.withIdentity({ subject: MEMBER_CLERK_ID, org_id: ORG_CLAIM });
    const { above, below, moved } = await t.run(async (ctx) => {
      const team = await ctx.db.get(teamId);
      const story = {
        orgId: team!.orgId,
        teamId,
        kind: "story",
        status: "todo",
        priority: "none",
        creatorId: memberId,
      } as const;
      return {
        above: await ctx.db.insert("issues", { ...story, title: "Above", sortOrder: 5000 }),
        below: await ctx.db.insert("issues", { ...story, title: "Below", sortOrder: 5000 }),
        moved: await ctx.db.insert("issues", { ...story, title: "Moved", sortOrder: 1000 }),
      };
    });

    await asMember.mutation(api.issues.update, { issueId: moved, sortOrder: 5000 });

    const { page: backlog } = await asMember.query(api.issues.listBacklog, { teamId, paginationOpts: FIRST_PAGE });
    const ranks = backlog.map((issue) => issue.sortOrder);
    expect(new Set(ranks).size).toBe(3);
    expect(backlog.map((issue) => issue._id)).toEqual([above, moved, below]);
  });

  test("moving a story into a tie whose gap to the next rank holds no new number re-spaces the rows below", async () => {
    const { t, teamId, memberId } = await setup();
    const asMember = t.withIdentity({ subject: MEMBER_CLERK_ID, org_id: ORG_CLAIM });
    const { above, lower, bottom, moved } = await t.run(async (ctx) => {
      const team = await ctx.db.get(teamId);
      const story = {
        orgId: team!.orgId,
        teamId,
        kind: "story",
        status: "todo",
        priority: "none",
        creatorId: memberId,
      } as const;
      return {
        above: await ctx.db.insert("issues", { ...story, title: "Above", sortOrder: 1000 }),
        lower: await ctx.db.insert("issues", { ...story, title: "Lower", sortOrder: 999.9999999999999 }),
        bottom: await ctx.db.insert("issues", { ...story, title: "Bottom", sortOrder: 0 }),
        moved: await ctx.db.insert("issues", { ...story, title: "Moved", sortOrder: -5000 }),
      };
    });

    await asMember.mutation(api.issues.update, { issueId: moved, sortOrder: 1000 });

    const { page: backlog } = await asMember.query(api.issues.listBacklog, { teamId, paginationOpts: FIRST_PAGE });
    const ranks = backlog.map((issue) => issue.sortOrder);
    expect(new Set(ranks).size).toBe(4);
    expect(backlog.map((issue) => issue._id)).toEqual([above, moved, lower, bottom]);
    expect(ranks.at(-1)).toBe(0);
  });
});

describe("the assignee is a member of the workspace", () => {
  const refused = { code: "not_found", message: "Assignee not found" };

  /** The outsider is a member of another workspace, so its id is one a caller could learn. */
  async function setupWithOutsider() {
    const s = await setup();
    const outsiderId = await s.t.run(async (ctx) => {
      const outsider = await ctx.db
        .query("users")
        .withIndex("by_clerk_id", (q) => q.eq("clerkId", OUTSIDER_CLERK_ID))
        .unique();
      const otherOrgId = await ctx.db.insert("organizations", {
        clerkOrgId: "org_other",
        name: "Other Org",
        slug: "other-org",
      });
      await ctx.db.insert("members", {
        orgId: otherOrgId,
        userId: outsider!._id,
        role: "member",
        clerkMembershipId: "mem_outsider",
      });
      return outsider!._id;
    });
    return { ...s, outsiderId, asMember: s.t.withIdentity({ subject: MEMBER_CLERK_ID, org_id: ORG_CLAIM }) };
  }

  const refusalOf = (error: unknown) => (error instanceof ConvexError ? error.data : error);

  test("create refuses another workspace's user without naming them and writes nothing", async () => {
    const { t, teamId, outsiderId, asMember } = await setupWithOutsider();
    const error = await asMember
      .mutation(api.issues.create, { teamId, title: "Story", assigneeId: outsiderId })
      .catch((thrown: unknown) => thrown);

    expect(refusalOf(error)).toEqual(refused);
    expect(String(error)).not.toContain("Outsider");
    expect(await t.run((ctx) => ctx.db.query("issues").collect())).toEqual([]);
  });

  test("update refuses another workspace's user without naming them; the member stays and can be unassigned", async () => {
    const { t, teamId, memberId, outsiderId, asMember } = await setupWithOutsider();
    const issueId = await asMember.mutation(api.issues.create, { teamId, title: "Story", assigneeId: memberId });
    const assignee = async () => (await t.run((ctx) => ctx.db.get(issueId)))?.assigneeId;
    expect(await assignee()).toBe(memberId);

    const error = await asMember
      .mutation(api.issues.update, { issueId, assigneeId: outsiderId })
      .catch((thrown: unknown) => thrown);
    expect(refusalOf(error)).toEqual(refused);
    expect(String(error)).not.toContain("Outsider");
    expect(await assignee()).toBe(memberId);

    await asMember.mutation(api.issues.update, { issueId, assigneeId: null });
    expect(await assignee()).toBeUndefined();
  });
});

describe("a title is never blank", () => {
  const blank = { code: "validation", message: "Title cannot be empty" };
  const refusalOf = (error: unknown) => (error instanceof ConvexError ? error.data : error);

  let keyCount = 0;
  const rest = (t: Awaited<ReturnType<typeof setup>>["t"], method: string, path: string, body: unknown) =>
    t.fetch(`/api/v1/issues${path}`, {
      method,
      headers: { "X-Agent-Id": "cc1", "Idempotency-Key": `blank-title-${++keyCount}` },
      body: JSON.stringify(body),
    });

  beforeEach(() => {
    process.env.HX_WORKSPACE_ORG_ID = ORG_CLAIM;
  });

  afterEach(() => {
    delete process.env.HX_WORKSPACE_ORG_ID;
  });

  async function written(t: Awaited<ReturnType<typeof setup>>["t"]) {
    return await t.run(async (ctx) => ({
      issues: await ctx.db.query("issues").collect(),
      activity: await ctx.db.query("activity").collect(),
    }));
  }

  test("a create with an all-blank title is refused as validation and writes nothing", async () => {
    const { t, teamId } = await setup();
    const asMember = t.withIdentity({ subject: MEMBER_CLERK_ID, org_id: ORG_CLAIM });

    const error = await asMember.mutation(api.issues.create, { teamId, title: "  " }).catch(refusalOf);

    expect(error).toEqual(blank);
    expect(await written(t)).toEqual({ issues: [], activity: [] });
    expect((await t.run((ctx) => ctx.db.get(teamId)))?.nextIssueNumber).toBe(FIRST_NUMBER);
  });

  test("an update to an all-blank title is refused as validation and changes nothing", async () => {
    const { t, teamId } = await setup();
    const asMember = t.withIdentity({ subject: MEMBER_CLERK_ID, org_id: ORG_CLAIM });
    const issueId = await asMember.mutation(api.issues.create, { teamId, title: "  Story  " });
    const before = await written(t);
    expect(before.issues.find((issue) => issue._id === issueId)?.title).toBe("Story");

    const error = await asMember.mutation(api.issues.update, { issueId, title: " \t " }).catch(refusalOf);

    expect(error).toEqual(blank);
    expect(await written(t)).toEqual(before);
  });

  test("REST POST with an all-blank title is 400 validation and creates nothing", async () => {
    const { t } = await setup();

    const response = await rest(t, "POST", "", { teamKey: "ENG", title: "  " });

    expect(response.status).toBe(400);
    expect(await response.json()).toEqual(blank);
    expect(await written(t)).toEqual({ issues: [], activity: [] });
  });

  test("REST PATCH with an empty title is 400 validation and changes nothing", async () => {
    const { t } = await setup();
    expect((await rest(t, "POST", "", { teamKey: "ENG", title: "Story" })).status).toBe(201);
    const before = await written(t);

    const response = await rest(t, "PATCH", `/ENG-${FIRST_NUMBER}`, { title: "" });

    expect(response.status).toBe(400);
    expect(await response.json()).toEqual(blank);
    expect(await written(t)).toEqual(before);
  });
});
