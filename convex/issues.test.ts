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

async function setup() {
  const t = convexTest(schema, modules);
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
