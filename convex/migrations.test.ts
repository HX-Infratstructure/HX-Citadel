/// <reference types="vite/client" />
import { convexTest } from "convex-test";
import { describe, expect, test } from "vitest";
import { internal } from "./_generated/api";
import schema from "./schema";

const modules = import.meta.glob("./**/*.*s");

async function seedLegacyFields() {
  const t = convexTest(schema, modules);
  const ids = await t.run(async (ctx) => {
    const userId = await ctx.db.insert("users", {
      clerkId: "user_legacy",
      name: "Legacy",
      email: "legacy@example.com",
    });
    const orgId = await ctx.db.insert("organizations", {
      clerkOrgId: "org_legacy",
      name: "Legacy Org",
      plan: "free",
      subscriptionStatus: "active",
    });
    const teamId = await ctx.db.insert("teams", {
      orgId,
      name: "Engineering",
      key: "ENG",
      nextIssueNumber: 2,
    });
    const issueId = await ctx.db.insert("issues", {
      orgId,
      teamId,
      number: 1,
      title: "Embedded",
      status: "todo",
      priority: "none",
      creatorId: userId,
      sortOrder: 1,
      embedding: [0.1, 0.2],
    });
    return { orgId, issueId };
  });
  return { t, ...ids };
}

describe("migrations.clearLegacyFields", () => {
  test("unsets plan, subscriptionStatus and embedding", async () => {
    const { t, orgId, issueId } = await seedLegacyFields();

    const counts = await t.mutation(internal.migrations.clearLegacyFields, {});

    expect(counts).toEqual({ organizations: 1, issues: 1 });
    const { org, issue } = await t.run(async (ctx) => ({
      org: await ctx.db.get(orgId),
      issue: await ctx.db.get(issueId),
    }));
    expect(org).not.toHaveProperty("plan");
    expect(org).not.toHaveProperty("subscriptionStatus");
    expect(org?.name).toBe("Legacy Org");
    expect(issue).not.toHaveProperty("embedding");
    expect(issue?.title).toBe("Embedded");
  });

  test("a second run changes nothing", async () => {
    const { t } = await seedLegacyFields();
    await t.mutation(internal.migrations.clearLegacyFields, {});

    const counts = await t.mutation(internal.migrations.clearLegacyFields, {});

    expect(counts).toEqual({ organizations: 0, issues: 0 });
  });
});

describe("webhooks.handleClerkEvent", () => {
  test("organization.created inserts an organization without a plan", async () => {
    const t = convexTest(schema, modules);

    await t.mutation(internal.webhooks.handleClerkEvent, {
      eventType: "organization.created",
      data: { id: "org_new", name: "New Org", slug: "new-org" },
    });

    const org = await t.run((ctx) =>
      ctx.db
        .query("organizations")
        .withIndex("by_clerk_org_id", (q) => q.eq("clerkOrgId", "org_new"))
        .unique()
    );
    expect(org?.name).toBe("New Org");
    expect(org).not.toHaveProperty("plan");
  });
});
