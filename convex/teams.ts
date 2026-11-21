import { v } from "convex/values";
import { refuse } from "./lib/refusals";
import { isValidTeamKey, normalizeTeamKey, TEAM_KEY_RULE } from "../lib/issue-key";
import { orgAdminMutation, orgQuery } from "./lib/customFunctions";
import { FIRST_ISSUE_NUMBER } from "./lib/rules/numbering";

const teamShape = {
  _id: v.id("teams"),
  _creationTime: v.number(),
  orgId: v.id("organizations"),
  name: v.string(),
  key: v.string(),
  description: v.optional(v.string()),
  nextIssueNumber: v.number(),
};

export const list = orgQuery({
  args: {},
  returns: v.array(v.object(teamShape)),
  handler: async (ctx) => {
    return await ctx.db
      .query("teams")
      .withIndex("by_org", (q) => q.eq("orgId", ctx.org._id))
      .collect();
  },
});

export const get = orgQuery({
  args: { teamId: v.id("teams") },
  returns: v.union(v.object(teamShape), v.null()),
  handler: async (ctx, args) => {
    const team = await ctx.db.get(args.teamId);
    if (!team || team.orgId !== ctx.org._id) {
      return null;
    }
    return team;
  },
});

export const create = orgAdminMutation({
  args: {
    name: v.string(),
    key: v.string(),
    description: v.optional(v.string()),
  },
  returns: v.id("teams"),
  handler: async (ctx, args) => {
    const key = normalizeTeamKey(args.key);
    if (!isValidTeamKey(key)) {
      refuse(TEAM_KEY_RULE);
    }
    const existing = await ctx.db
      .query("teams")
      .withIndex("by_org_and_key", (q) =>
        q.eq("orgId", ctx.org._id).eq("key", key)
      )
      .unique();
    if (existing) {
      refuse(`Team key "${key}" is already in use`);
    }
    return await ctx.db.insert("teams", {
      orgId: ctx.org._id,
      name: args.name.trim(),
      key,
      description: args.description,
      nextIssueNumber: FIRST_ISSUE_NUMBER,
    });
  },
});
