import { v } from "convex/values";
import { internalMutation } from "./_generated/server";

export const clearLegacyFields = internalMutation({
  args: {},
  returns: v.object({ organizations: v.number(), issues: v.number() }),
  handler: async (ctx) => {
    const orgs = (await ctx.db.query("organizations").collect()).filter(
      (org) => org.plan !== undefined || org.subscriptionStatus !== undefined
    );
    for (const org of orgs) {
      await ctx.db.patch(org._id, {
        plan: undefined,
        subscriptionStatus: undefined,
      });
    }
    const issues = (await ctx.db.query("issues").collect()).filter(
      (issue) => issue.embedding !== undefined
    );
    for (const issue of issues) {
      await ctx.db.patch(issue._id, { embedding: undefined });
    }
    return { organizations: orgs.length, issues: issues.length };
  },
});
