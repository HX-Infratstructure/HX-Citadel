/// <reference types="vite/client" />
import { convexTest } from "convex-test";
import { describe, expect, test } from "vitest";
import { api } from "./_generated/api";
import { LIST_LIMIT } from "./issues";
import schema from "./schema";

const modules = import.meta.glob("./**/*.*s");

const ORG_CLAIM = "org_test";
const MEMBER_CLERK_ID = "user_member";

describe("projects.create on a free organization", () => {
  test("creates a 3rd project", async () => {
    const t = convexTest(schema, modules);
    const orgId = await t.run(async (ctx) => {
      const userId = await ctx.db.insert("users", {
        clerkId: MEMBER_CLERK_ID,
        name: "Member",
        email: "member@example.com",
      });
      const orgId = await ctx.db.insert("organizations", {
        clerkOrgId: ORG_CLAIM,
        name: "Test Org",
        slug: "test-org",
      });
      await ctx.db.insert("members", {
        orgId,
        userId,
        role: "member",
        clerkMembershipId: "mem_member",
      });
      return orgId;
    });
    const asMember = t.withIdentity({
      subject: MEMBER_CLERK_ID,
      org_id: ORG_CLAIM,
    });
    await asMember.mutation(api.projects.create, { name: "One" });
    await asMember.mutation(api.projects.create, { name: "Two" });

    await asMember.mutation(api.projects.create, { name: "Three" });

    const projects = await t.run((ctx) =>
      ctx.db
        .query("projects")
        .withIndex("by_org", (q) => q.eq("orgId", orgId))
        .collect()
    );
    expect(projects.map((project) => project.name)).toEqual([
      "One",
      "Two",
      "Three",
    ]);
  });
});

describe("projects.remove", () => {
  test("deletes a project that another organization's epic points at", async () => {
    const t = convexTest(schema, modules);
    const projectId = await t.run(async (ctx) => {
      const userId = await ctx.db.insert("users", {
        clerkId: MEMBER_CLERK_ID,
        name: "Member",
        email: "member@example.com",
      });
      const orgId = await ctx.db.insert("organizations", {
        clerkOrgId: ORG_CLAIM,
        name: "Test Org",
        slug: "test-org",
      });
      await ctx.db.insert("members", {
        orgId,
        userId,
        role: "member",
        clerkMembershipId: "mem_member",
      });
      const projectId = await ctx.db.insert("projects", {
        orgId,
        name: "Phase 2",
        status: "planned",
      });
      const otherOrgId = await ctx.db.insert("organizations", {
        clerkOrgId: "org_other",
        name: "Other Org",
        slug: "other-org",
      });
      const otherTeamId = await ctx.db.insert("teams", {
        orgId: otherOrgId,
        name: "Other",
        key: "OTH",
        nextIssueNumber: 1,
      });
      await ctx.db.insert("issues", {
        orgId: otherOrgId,
        teamId: otherTeamId,
        kind: "epic",
        title: "Foreign epic",
        status: "todo",
        priority: "none",
        creatorId: userId,
        projectId,
        sortOrder: 0,
      });
      return projectId;
    });
    const asMember = t.withIdentity({
      subject: MEMBER_CLERK_ID,
      org_id: ORG_CLAIM,
    });

    await asMember.mutation(api.projects.remove, { projectId });

    expect(await t.run((ctx) => ctx.db.get(projectId))).toBeNull();
  });
});

/** A member, a project, and a user who is not in the workspace. */
async function setupProject() {
  const t = convexTest(schema, modules);
  const ids = await t.run(async (ctx) => {
    const orgId = await ctx.db.insert("organizations", { clerkOrgId: ORG_CLAIM, name: "Test Org", slug: "test-org" });
    const userId = await ctx.db.insert("users", { clerkId: MEMBER_CLERK_ID, name: "Member", email: "member@example.com" });
    await ctx.db.insert("members", { orgId, userId, role: "member", clerkMembershipId: "mem_member" });
    const outsiderId = await ctx.db.insert("users", { clerkId: "user_outsider", name: "Outsider", email: "out@example.com" });
    const teamId = await ctx.db.insert("teams", { orgId, name: "Engineering", key: "ENG", nextIssueNumber: 1 });
    const projectId = await ctx.db.insert("projects", { orgId, name: "Phase 2", status: "planned" });
    return { orgId, userId, outsiderId, teamId, projectId };
  });
  return { t, member: t.withIdentity({ subject: MEMBER_CLERK_ID, org_id: ORG_CLAIM }), ...ids };
}

type ProjectSetup = Awaited<ReturnType<typeof setupProject>>;

describe("project input is a typed refusal", () => {
  test.each([
    ["create", (s: ProjectSetup) => s.member.mutation(api.projects.create, { name: "  " })],
    ["update", (s: ProjectSetup) => s.member.mutation(api.projects.update, { projectId: s.projectId, name: "  " })],
  ])("%s with an empty name is validation", async (_name, write) => {
    await expect(write(await setupProject())).rejects.toMatchObject({
      data: { code: "validation", message: "Project name is required" },
    });
  });

  test.each([
    ["create", (s: ProjectSetup) => s.member.mutation(api.projects.create, { name: "Led", leadId: s.outsiderId })],
    ["update", (s: ProjectSetup) => s.member.mutation(api.projects.update, { projectId: s.projectId, leadId: s.outsiderId })],
  ])("%s with a lead outside the workspace is not_found", async (_name, write) => {
    await expect(write(await setupProject())).rejects.toMatchObject({
      data: { code: "not_found", message: "Project lead must be a member of this organization" },
    });
  });
});

describe("a project with more than LIST_LIMIT issues", () => {
  test("lists LIST_LIMIT of them and counts every one, on the list and the detail", async () => {
    const s = await setupProject();
    await s.t.run(async (ctx) => {
      for (let number = 1; number <= LIST_LIMIT + 1; number++) {
        await ctx.db.insert("issues", {
          orgId: s.orgId,
          teamId: s.teamId,
          kind: "story",
          number,
          title: `Story ${number}`,
          status: number <= LIST_LIMIT ? "done" : "todo",
          priority: "none",
          creatorId: s.userId,
          projectId: s.projectId,
          sortOrder: number,
        });
      }
    });

    const issues = await s.member.query(api.projects.listIssues, { projectId: s.projectId });
    const [project] = await s.member.query(api.projects.listWithProgress, {});
    const detail = await s.member.query(api.projects.progress, { projectId: s.projectId });

    const expected = { total: LIST_LIMIT + 1, done: LIST_LIMIT, todo: 1 };
    expect(issues).toHaveLength(LIST_LIMIT);
    expect(project.progress).toMatchObject(expected);
    expect(detail).toMatchObject(expected);
  });
});
