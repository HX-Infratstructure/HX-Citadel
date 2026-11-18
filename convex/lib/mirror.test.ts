/// <reference types="vite/client" />
import { convexTest } from "convex-test";
import { describe, expect, test } from "vitest";
import schema from "../schema";
import {
  findMembership,
  findOrgByClerkId,
  findUserByClerkId,
  getMembershipOrThrow,
  getOrgByClerkIdOrThrow,
  getUserByClerkIdOrThrow,
} from "./mirror";

const modules = import.meta.glob("../**/*.*s");

async function setup() {
  const t = convexTest(schema, modules);
  const ids = await t.run(async (ctx) => {
    const userId = await ctx.db.insert("users", {
      clerkId: "user_a",
      name: "A",
      email: "a@example.com",
    });
    const strangerId = await ctx.db.insert("users", {
      clerkId: "user_b",
      name: "B",
      email: "b@example.com",
    });
    const orgId = await ctx.db.insert("organizations", {
      clerkOrgId: "org_a",
      name: "Org A",
    });
    const memberId = await ctx.db.insert("members", {
      orgId,
      userId,
      role: "admin",
      clerkMembershipId: "orgmem_a",
    });
    return { userId, strangerId, orgId, memberId };
  });
  return { t, ...ids };
}

describe("mirror lookups", () => {
  test("findUserByClerkId finds the user and returns null for a missing one", async () => {
    const { t, userId } = await setup();
    await t.run(async (ctx) => {
      expect((await findUserByClerkId(ctx, "user_a"))?._id).toEqual(userId);
      expect(await findUserByClerkId(ctx, "user_missing")).toBeNull();
    });
  });

  test("findOrgByClerkId finds the organization and returns null for a missing one", async () => {
    const { t, orgId } = await setup();
    await t.run(async (ctx) => {
      expect((await findOrgByClerkId(ctx, "org_a"))?._id).toEqual(orgId);
      expect(await findOrgByClerkId(ctx, "org_missing")).toBeNull();
    });
  });

  test("findMembership finds the membership and returns null for a non-member", async () => {
    const { t, orgId, userId, strangerId, memberId } = await setup();
    await t.run(async (ctx) => {
      expect((await findMembership(ctx, orgId, userId))?._id).toEqual(memberId);
      expect(await findMembership(ctx, orgId, strangerId)).toBeNull();
    });
  });

  test("throwing variants return the row when it exists", async () => {
    const { t, orgId, userId, memberId } = await setup();
    await t.run(async (ctx) => {
      expect((await getUserByClerkIdOrThrow(ctx, "user_a", "no user"))._id).toEqual(userId);
      expect((await getOrgByClerkIdOrThrow(ctx, "org_a", "no org"))._id).toEqual(orgId);
      expect((await getMembershipOrThrow(ctx, orgId, userId, "no member"))._id).toEqual(memberId);
    });
  });

  test("throwing variants throw the message they are given", async () => {
    const { t, orgId, strangerId } = await setup();
    await t.run(async (ctx) => {
      await expect(getUserByClerkIdOrThrow(ctx, "user_missing", "User not synced yet")).rejects.toThrow(
        "User not synced yet"
      );
      await expect(getOrgByClerkIdOrThrow(ctx, "org_missing", "Organization org_missing not found")).rejects.toThrow(
        "Organization org_missing not found"
      );
      await expect(
        getMembershipOrThrow(ctx, orgId, strangerId, "Not a member of this organization")
      ).rejects.toThrow("Not a member of this organization");
    });
  });
});
