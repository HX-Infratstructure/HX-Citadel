import { v } from "convex/values";
import { MAX_LABELS_PER_ISSUE, TOO_MANY_LABELS } from "../lib/api-contract";
import { orgMutation, orgQuery } from "./lib/customFunctions";
import { getOrgIssue } from "./lib/issues/shape";
import { logActivity } from "./lib/activity";
import { orgRow, requireOrgRow } from "./lib/orgRows";
import { refuse } from "./lib/refusals";

const labelShape = {
  _id: v.id("labels"),
  _creationTime: v.number(),
  orgId: v.id("organizations"),
  name: v.string(),
  color: v.string(),
};

export const list = orgQuery({
  args: {},
  returns: v.array(v.object(labelShape)),
  handler: async (ctx) => {
    return await ctx.db
      .query("labels")
      .withIndex("by_org", (q) => q.eq("orgId", ctx.org._id))
      .collect();
  },
});

export const create = orgMutation({
  args: { name: v.string(), color: v.string() },
  returns: v.id("labels"),
  handler: async (ctx, args) => {
    return await ctx.db.insert("labels", {
      orgId: ctx.org._id,
      name: args.name.trim(),
      color: args.color,
    });
  },
});

export const listForIssue = orgQuery({
  args: { issueId: v.id("issues") },
  returns: v.array(v.object(labelShape)),
  handler: async (ctx, args) => {
    await getOrgIssue(ctx, ctx.org._id, args.issueId);
    const links = await ctx.db
      .query("issueLabels")
      .withIndex("by_issue", (q) => q.eq("issueId", args.issueId))
      .collect();
    const labels = [];
    for (const link of links) {
      const label = await orgRow(ctx, ctx.org._id, link.labelId);
      if (label) {
        labels.push(label);
      }
    }
    return labels;
  },
});

export const toggleOnIssue = orgMutation({
  args: { issueId: v.id("issues"), labelId: v.id("labels") },
  returns: v.boolean(),
  handler: async (ctx, args) => {
    await getOrgIssue(ctx, ctx.org._id, args.issueId);
    const label = await requireOrgRow(ctx, ctx.org._id, args.labelId, "Label");

    const links = await ctx.db
      .query("issueLabels")
      .withIndex("by_issue", (q) => q.eq("issueId", args.issueId))
      .collect();
    const existing = links.find((l) => l.labelId === args.labelId);

    const entry = {
      orgId: ctx.org._id,
      issueId: args.issueId,
      actorId: ctx.user._id,
      field: "label",
    };
    if (existing) {
      await ctx.db.delete(existing._id);
      await logActivity(ctx, { ...entry, type: "label_removed", oldValue: label.name });
      return false;
    }
    if (links.length >= MAX_LABELS_PER_ISSUE) {
      refuse(TOO_MANY_LABELS);
    }
    // `issues.listByTeam` returns these label ids as stored, so for `listByTeam` this workspace check
    // (`getOrgIssue` and `requireOrgRow`, above) is the only one.
    await ctx.db.insert("issueLabels", {
      issueId: args.issueId,
      labelId: args.labelId,
    });
    await logActivity(ctx, { ...entry, type: "label_added", newValue: label.name });
    return true;
  },
});
