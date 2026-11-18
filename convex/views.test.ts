/// <reference types="vite/client" />
import { convexTest } from "convex-test";
import { describe, expect, test } from "vitest";
import { api } from "./_generated/api";
import schema from "./schema";

const modules = import.meta.glob("./**/*.*s");

const ORG = "org_hx";
const CREATOR = "user_creator";
const OTHER = "user_other";

/** A shared view made by CREATOR; OTHER is a plain member. */
async function setup() {
  const t = convexTest(schema, modules);
  const viewId = await t.run(async (ctx) => {
    const orgId = await ctx.db.insert("organizations", { clerkOrgId: ORG, name: "HX", slug: "hx" });
    const creatorId = await ctx.db.insert("users", { clerkId: CREATOR, name: "Creator", email: "creator@example.com" });
    const otherId = await ctx.db.insert("users", { clerkId: OTHER, name: "Other", email: "other@example.com" });
    await ctx.db.insert("members", { orgId, userId: creatorId, role: "member", clerkMembershipId: "mem_creator" });
    await ctx.db.insert("members", { orgId, userId: otherId, role: "member", clerkMembershipId: "mem_other" });
    return await ctx.db.insert("views", { orgId, creatorId, name: "Mine", filters: "{}", shared: true });
  });
  return {
    t,
    viewId,
    creator: t.withIdentity({ subject: CREATOR, org_id: ORG }),
    other: t.withIdentity({ subject: OTHER, org_id: ORG }),
  };
}

describe("view input is a typed validation refusal", () => {
  test.each([
    ["an empty name", { name: "  ", filters: "{}" }, "View name is required"],
    ["filters over the size limit", { name: "Big", filters: `"${"x".repeat(4096)}"` }, "View filters are too large"],
    ["filters that are not JSON", { name: "Bad", filters: "{" }, "View filters must be valid JSON"],
  ])("create with %s", async (_case, input, message) => {
    const s = await setup();
    await expect(s.creator.mutation(api.views.create, { ...input, shared: false })).rejects.toMatchObject({
      data: { code: "validation", message },
    });
  });

  test("update with an empty name", async () => {
    const s = await setup();
    await expect(s.creator.mutation(api.views.update, { viewId: s.viewId, name: "  " })).rejects.toMatchObject({
      data: { code: "validation", message: "View name is required" },
    });
  });
});

describe("view permissions are typed rule refusals", () => {
  test("another member editing is refused", async () => {
    const s = await setup();
    await expect(s.other.mutation(api.views.update, { viewId: s.viewId, name: "Theirs" })).rejects.toMatchObject({
      data: { code: "rule_refused", message: "Only the view's creator or an admin can edit it" },
    });
  });

  test("another member deleting is refused and the view stays", async () => {
    const s = await setup();
    await expect(s.other.mutation(api.views.remove, { viewId: s.viewId })).rejects.toMatchObject({
      data: { code: "rule_refused", message: "Only the view's creator or an admin can delete it" },
    });
    expect(await s.t.run(async (ctx) => await ctx.db.get(s.viewId))).not.toBeNull();
  });
});
