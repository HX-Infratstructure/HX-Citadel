/// <reference types="vite/client" />
import { convexTest } from "convex-test";
import { describe, expect, test } from "vitest";
import { api } from "./_generated/api";
import schema from "./schema";

const modules = import.meta.glob("./**/*.*s");

const ORG_CLAIM = "org_test";
const MEMBER_CLERK_ID = "user_member";
const OUTSIDER_CLERK_ID = "user_outsider";
const FIRST_NUMBER = 7;

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
    ).rejects.toThrow("Not a member of this organization");

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

    const backlog = await asMember.query(api.issues.listBacklog, { teamId });

    expect(backlog.map((issue) => issue._id)).toEqual([high, low]);
  });

  test("loads the backlog of a team whose closed stories exceed the read limit", async () => {
    const { t, teamId, memberId } = await setup({ documentsRead: 30 });
    const asMember = t.withIdentity({
      subject: MEMBER_CLERK_ID,
      org_id: ORG_CLAIM,
    });
    const openId = await t.run(async (ctx) => {
      const team = await ctx.db.get(teamId);
      const story = {
        orgId: team!.orgId,
        teamId,
        kind: "story",
        creatorId: memberId,
        priority: "none",
        sortOrder: 1000,
      } as const;
      for (let i = 0; i < 40; i++) {
        await ctx.db.insert("issues", { ...story, title: `Shipped ${i}`, status: "done" });
      }
      return await ctx.db.insert("issues", { ...story, title: "Open", status: "todo" });
    });

    const backlog = await asMember.query(api.issues.listBacklog, { teamId });

    expect(backlog.map((issue) => issue._id)).toEqual([openId]);
  });

  test("refuses a caller who is not a member of the active organization", async () => {
    const { t, teamId } = await setup();
    const asOutsider = t.withIdentity({
      subject: OUTSIDER_CLERK_ID,
      org_id: ORG_CLAIM,
    });
    await expect(
      asOutsider.query(api.issues.listBacklog, { teamId })
    ).rejects.toThrow();
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

    const backlog = await asMember.query(api.issues.listBacklog, { teamId });
    const ranks = backlog.map((issue) => issue.sortOrder);
    expect(new Set(ranks).size).toBe(3);
    expect(backlog.map((issue) => issue._id)).toEqual([above, moved, below]);
  });
});
