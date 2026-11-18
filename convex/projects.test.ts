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
