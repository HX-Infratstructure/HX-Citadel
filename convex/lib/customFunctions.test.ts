/// <reference types="vite/client" />
import { convexTest } from "convex-test";
import { describe, expect, test } from "vitest";
import { api } from "../_generated/api";
import schema from "../schema";

const modules = import.meta.glob("../**/*.*s");

const ORG = "org_test";

async function setup() {
  const t = convexTest(schema, modules);
  await t.run(async (ctx) => {
    const orgId = await ctx.db.insert("organizations", { clerkOrgId: ORG, name: "Test Org", slug: "test-org" });
    for (const role of ["admin", "member"] as const) {
      const userId = await ctx.db.insert("users", { clerkId: `user_${role}`, name: role, email: `${role}@example.com` });
      await ctx.db.insert("members", { orgId, userId, role, clerkMembershipId: `mem_${role}` });
    }
  });
  const as = (role: "admin" | "member") => t.withIdentity({ subject: `user_${role}`, org_id: ORG });
  return { admin: as("admin"), member: as("member") };
}

describe("orgAdminMutation", () => {
  test("refuses a member who is not an admin with a typed rule refusal", async () => {
    const { member } = await setup();
    await expect(member.mutation(api.teams.create, { name: "Engineering", key: "ENG" })).rejects.toMatchObject({
      data: { code: "rule_refused", message: "Admin access required" },
    });
  });

  test("lets an admin through", async () => {
    const { admin } = await setup();
    await expect(admin.mutation(api.teams.create, { name: "Engineering", key: "ENG" })).resolves.toBeTruthy();
  });
});
