import { v } from "convex/values";
import { MAX_LABELS_PER_ISSUE, TOO_MANY_LABELS } from "../lib/api-contract";
import { Doc, Id } from "./_generated/dataModel";
import { MutationCtx } from "./_generated/server";
import { orgMutation, orgQuery } from "./lib/customFunctions";
import { ActivityActor, logActivity } from "./lib/activity";
import { getOrgIssue, orgRow, requireOrgRow } from "./lib/orgRows";
import { invalid, refuse } from "./lib/refusals";

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
    await attachLabel(ctx, entry, args.issueId, label);
    return true;
  },
});

export const createOnIssue = orgMutation({
  args: { issueId: v.id("issues"), name: v.string(), color: v.string() },
  returns: v.id("labels"),
  handler: async (ctx, args) => {
    await getOrgIssue(ctx, ctx.org._id, args.issueId);
    const name = args.name.trim();
    if (!name) {
      invalid("A label needs a name");
    }
    const links = await ctx.db
      .query("issueLabels")
      .withIndex("by_issue", (q) => q.eq("issueId", args.issueId))
      .collect();
    if (links.length >= MAX_LABELS_PER_ISSUE) {
      refuse(TOO_MANY_LABELS);
    }
    const labelId = await ctx.db.insert("labels", { orgId: ctx.org._id, name, color: args.color });
    const entry = { orgId: ctx.org._id, actorId: ctx.user._id, field: "label" };
    await attachLabel(ctx, entry, args.issueId, { _id: labelId, name });
    return labelId;
  },
});

// `issues.listByTeam` returns these label ids as stored, so for `listByTeam` the caller's workspace check is the
// only one: `toggleOnIssue` checks the issue and the label (`getOrgIssue`, `requireOrgRow`), and `createOnIssue`
// checks the issue and creates the label in `ctx.org`.
async function attachLabel(
  ctx: MutationCtx,
  entry: ActivityActor & { field: string },
  issueId: Id<"issues">,
  label: Pick<Doc<"labels">, "_id" | "name">
): Promise<void> {
  await ctx.db.insert("issueLabels", { issueId, labelId: label._id });
  await logActivity(ctx, { ...entry, issueId, type: "label_added", newValue: label.name });
}
