import { v } from "convex/values";
import { MAX_LABELS_PER_ISSUE, TOO_MANY_LABELS } from "../lib/api-contract";
import { Doc, Id } from "./_generated/dataModel";
import { MutationCtx, QueryCtx } from "./_generated/server";
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
    const links = await issueLinks(ctx, args.issueId);
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

    const links = await issueLinks(ctx, args.issueId);
    const existing = links.find((l) => l.labelId === args.labelId);

    const actor = { orgId: ctx.org._id, actorId: ctx.user._id };
    if (existing) {
      await ctx.db.delete(existing._id);
      await logActivity(ctx, { ...actor, issueId: args.issueId, type: "label_removed", field: "label", oldValue: label.name });
      return false;
    }
    requireLabelRoom(links);
    await attachLabel(ctx, actor, args.issueId, label);
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
    requireLabelRoom(await issueLinks(ctx, args.issueId));
    const labelId = await ctx.db.insert("labels", { orgId: ctx.org._id, name, color: args.color });
    await attachLabel(ctx, { orgId: ctx.org._id, actorId: ctx.user._id }, args.issueId, { _id: labelId, name });
    return labelId;
  },
});

async function issueLinks(ctx: { db: QueryCtx["db"] }, issueId: Id<"issues">): Promise<Doc<"issueLabels">[]> {
  return await ctx.db.query("issueLabels").withIndex("by_issue", (q) => q.eq("issueId", issueId)).collect();
}

function requireLabelRoom(links: Doc<"issueLabels">[]): void {
  if (links.length >= MAX_LABELS_PER_ISSUE) {
    refuse(TOO_MANY_LABELS);
  }
}

/**
 * Links the label to the issue and logs `label_added`. The caller checks first that the issue is in its workspace
 * and that the label belongs to that workspace; `issueLabelIds` in `convex/lib/issues/queries.ts` says why.
 */
async function attachLabel(
  ctx: MutationCtx,
  actor: ActivityActor,
  issueId: Id<"issues">,
  label: Pick<Doc<"labels">, "_id" | "name">
): Promise<void> {
  await ctx.db.insert("issueLabels", { issueId, labelId: label._id });
  await logActivity(ctx, { ...actor, issueId, type: "label_added", field: "label", newValue: label.name });
}
