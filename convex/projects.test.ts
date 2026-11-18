/// <reference types="vite/client" />
import { convexTest } from "convex-test";
import { describe, expect, test } from "vitest";
import { api } from "./_generated/api";
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
