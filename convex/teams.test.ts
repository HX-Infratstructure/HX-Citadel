/// <reference types="vite/client" />
import { convexTest } from "convex-test";
import { describe, expect, test } from "vitest";
import { api } from "./_generated/api";
import schema from "./schema";

const modules = import.meta.glob("./**/*.*s");

const ORG_CLAIM = "org_test";
const ADMIN_CLERK_ID = "user_admin";

async function asAdmin() {
  const t = convexTest(schema, modules);
  await t.run(async (ctx) => {
    const userId = await ctx.db.insert("users", {
      clerkId: ADMIN_CLERK_ID,
      name: "Admin",
      email: "admin@example.com",
    });
    const orgId = await ctx.db.insert("organizations", {
      clerkOrgId: ORG_CLAIM,
      name: "Test Org",
      slug: "test-org",
    });
    await ctx.db.insert("members", { orgId, userId, role: "admin", clerkMembershipId: "mem_admin" });
  });
  return { t, admin: t.withIdentity({ subject: ADMIN_CLERK_ID, org_id: ORG_CLAIM }) };
}

describe("teams.create", () => {
  test("refuses a key that starts with a digit", async () => {
    const { admin } = await asAdmin();
    await expect(admin.mutation(api.teams.create, { name: "Numbers", key: "1AB" })).rejects.toThrow(
      "Team key must be 1-5 characters, letters and digits, starting with a letter"
    );
  });

  test("stores a trimmed, upper-cased key", async () => {
    const { t, admin } = await asAdmin();
    const teamId = await admin.mutation(api.teams.create, { name: "Engineering", key: " eng2 " });
    const team = await t.run((ctx) => ctx.db.get(teamId));
    expect(team?.key).toBe("ENG2");
  });
});
