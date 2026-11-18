/// <reference types="vite/client" />
import { convexTest } from "convex-test";
import { describe, expect, test } from "vitest";
import { internal } from "./_generated/api";
import schema from "./schema";

const modules = import.meta.glob("./**/*.*s");

const SEEDED_ORG = "org_seeded";
const OTHER_ORG = "org_other";
const ADMIN_CLERK_ID = "user_admin";
const OUTSIDER_CLERK_ID = "user_outsider";

const EXPECTED_COUNTS = {
  teams: 3,
  labels: 8,
  projects: 2,
  cycles: 4,
  issues: 43,
  comments: 5,
};

async function setup() {
  const t = convexTest(schema, modules);
  const { seededOrgId, adminId } = await t.run(async (ctx) => {
    const adminId = await ctx.db.insert("users", {
      clerkId: ADMIN_CLERK_ID,
      name: "Admin",
      email: "admin@example.com",
    });
    const outsiderId = await ctx.db.insert("users", {
      clerkId: OUTSIDER_CLERK_ID,
      name: "Outsider",
      email: "outsider@example.com",
    });
    const seededOrgId = await ctx.db.insert("organizations", {
      clerkOrgId: SEEDED_ORG,
      name: "Seeded Org",
      slug: "seeded-org",
    });
    const otherOrgId = await ctx.db.insert("organizations", {
      clerkOrgId: OTHER_ORG,
      name: "Other Org",
      slug: "other-org",
    });
    await ctx.db.insert("members", {
      orgId: seededOrgId,
      userId: adminId,
      role: "admin",
      clerkMembershipId: "mem_admin",
    });
    await ctx.db.insert("members", {
      orgId: otherOrgId,
      userId: outsiderId,
      role: "admin",
      clerkMembershipId: "mem_outsider",
    });
    return { seededOrgId, adminId };
  });
  return { t, seededOrgId, adminId };
}

describe("seed.demoData", () => {
  test("seeds the named organization for the named member and reports per-table counts", async () => {
    const { t, seededOrgId, adminId } = await setup();

    const result = await t.mutation(internal.seed.demoData, {
      clerkOrgId: SEEDED_ORG,
      clerkUserId: ADMIN_CLERK_ID,
    });

    expect(result).toEqual(EXPECTED_COUNTS);

    const rows = await t.run(async (ctx) => {
      const issues = await ctx.db.query("issues").collect();
      const comments = await ctx.db.query("comments").collect();
      return {
        orgIdsByTable: {
          teams: (await ctx.db.query("teams").collect()).map((row) => row.orgId),
          labels: (await ctx.db.query("labels").collect()).map((row) => row.orgId),
          projects: (await ctx.db.query("projects").collect()).map((row) => row.orgId),
          cycles: (await ctx.db.query("cycles").collect()).map((row) => row.orgId),
          issues: issues.map((row) => row.orgId),
          comments: comments.map((row) => row.orgId),
        },
        issueCreators: issues.map((row) => row.creatorId),
        commentAuthors: comments.map((row) => row.authorId),
      };
    });

    for (const [table, expected] of Object.entries(EXPECTED_COUNTS)) {
      const orgIds = rows.orgIdsByTable[table as keyof typeof EXPECTED_COUNTS];
      expect(orgIds, `${table} rows`).toHaveLength(expected);
      expect(new Set(orgIds), `${table} rows belong to the seeded organization only`).toEqual(
        new Set([seededOrgId])
      );
    }
    expect(new Set(rows.issueCreators)).toEqual(new Set([adminId]));
    expect(new Set(rows.commentAuthors)).toEqual(new Set([adminId]));
  });

  test("refuses an organization that is not synced", async () => {
    const { t } = await setup();

    await expect(
      t.mutation(internal.seed.demoData, {
        clerkOrgId: "org_unknown",
        clerkUserId: ADMIN_CLERK_ID,
      })
    ).rejects.toThrow(/organization/i);

    const teams = await t.run((ctx) => ctx.db.query("teams").collect());
    expect(teams).toHaveLength(0);
  });

  test("refuses a user who is not a member of the organization", async () => {
    const { t } = await setup();

    await expect(
      t.mutation(internal.seed.demoData, {
        clerkOrgId: SEEDED_ORG,
        clerkUserId: OUTSIDER_CLERK_ID,
      })
    ).rejects.toThrow(/not a member/i);

    const teams = await t.run((ctx) => ctx.db.query("teams").collect());
    expect(teams).toHaveLength(0);
  });
});
