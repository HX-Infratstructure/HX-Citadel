import { v } from "convex/values";
import { Doc, Id, TableNames } from "./_generated/dataModel";
import { internalMutation, MutationCtx } from "./_generated/server";
import { getOrgByClerkIdOrThrow } from "./lib/mirror";

/**
 * Operator-only cleanup, run with `npx convex run admin:<name>`. Never public:
 * Clerk stays the source of truth for the organization mirror, so removing it
 * is a separate step that refuses while workspace content would be orphaned.
 */

const contentCountFields = {
  issueLabels: v.number(),
  issueRelations: v.number(),
  comments: v.number(),
  activity: v.number(),
  attachments: v.number(),
  issues: v.number(),
  cycles: v.number(),
  labels: v.number(),
  views: v.number(),
  projects: v.number(),
  teams: v.number(),
};

type ContentTable = keyof typeof contentCountFields;
type OrgContent = { [T in ContentTable]: Doc<T>[] };

const CONTENT_TABLES = Object.keys(contentCountFields) as ContentTable[];
const clearedCountsValidator = v.object(contentCountFields);

const deletedMirrorValidator = v.object({
  organizations: v.number(),
  members: v.number(),
});

function getOrgByClerkId(ctx: MutationCtx, clerkOrgId: string) {
  return getOrgByClerkIdOrThrow(ctx, clerkOrgId, `Organization ${clerkOrgId} not found`);
}

async function collectEach<P, T>(parents: P[], load: (parent: P) => Promise<T[]>) {
  const perParent = await Promise.all(parents.map(load));
  return perParent.flat();
}

async function deleteRows(ctx: MutationCtx, rows: { _id: Id<TableNames> }[]) {
  for (const row of rows) {
    await ctx.db.delete(row._id);
  }
}

async function deleteAttachmentFiles(ctx: MutationCtx, attachments: Doc<"attachments">[]) {
  for (const attachment of attachments) {
    await ctx.storage.delete(attachment.storageId);
  }
}

function countRows(content: OrgContent) {
  const counts = CONTENT_TABLES.map((table) => [table, content[table].length]);
  return Object.fromEntries(counts) as Record<ContentTable, number>;
}

function tablesWithRows(content: OrgContent) {
  return CONTENT_TABLES.filter((table) => content[table].length > 0);
}

async function loadOrgContent(ctx: MutationCtx, orgId: Id<"organizations">): Promise<OrgContent> {
  const issues = await ctx.db
    .query("issues")
    .withIndex("by_org", (q) => q.eq("orgId", orgId))
    .collect();
  const teams = await ctx.db
    .query("teams")
    .withIndex("by_org", (q) => q.eq("orgId", orgId))
    .collect();
  const issueIds = issues.map((issue) => issue._id);
  return {
    issueLabels: await collectEach(issueIds, (issueId) =>
      ctx.db.query("issueLabels").withIndex("by_issue", (q) => q.eq("issueId", issueId)).collect()
    ),
    issueRelations: await collectEach(issueIds, (issueId) =>
      ctx.db.query("issueRelations").withIndex("by_issue", (q) => q.eq("issueId", issueId)).collect()
    ),
    comments: await collectEach(issueIds, (issueId) =>
      ctx.db.query("comments").withIndex("by_issue", (q) => q.eq("issueId", issueId)).collect()
    ),
    activity: await ctx.db
      .query("activity")
      .withIndex("by_org", (q) => q.eq("orgId", orgId))
      .collect(),
    attachments: await collectEach(issueIds, (issueId) =>
      ctx.db.query("attachments").withIndex("by_issue", (q) => q.eq("issueId", issueId)).collect()
    ),
    issues,
    cycles: await collectEach(teams, (team) =>
      ctx.db.query("cycles").withIndex("by_team", (q) => q.eq("teamId", team._id)).collect()
    ),
    labels: await ctx.db
      .query("labels")
      .withIndex("by_org", (q) => q.eq("orgId", orgId))
      .collect(),
    views: await ctx.db
      .query("views")
      .withIndex("by_org", (q) => q.eq("orgId", orgId))
      .collect(),
    projects: await ctx.db
      .query("projects")
      .withIndex("by_org", (q) => q.eq("orgId", orgId))
      .collect(),
    teams,
  };
}

async function assertNoContent(ctx: MutationCtx, org: Doc<"organizations">) {
  const remaining = tablesWithRows(await loadOrgContent(ctx, org._id));
  if (remaining.length > 0) {
    throw new Error(
      `Organization ${org.clerkOrgId} still has rows in ${remaining.join(", ")}. Run admin:clearOrgContent first.`
    );
  }
}

export const clearOrgContent = internalMutation({
  args: { clerkOrgId: v.string() },
  returns: clearedCountsValidator,
  handler: async (ctx, args) => {
    const org = await getOrgByClerkId(ctx, args.clerkOrgId);
    const content = await loadOrgContent(ctx, org._id);
    await deleteAttachmentFiles(ctx, content.attachments);
    for (const table of CONTENT_TABLES) {
      await deleteRows(ctx, content[table]);
    }
    return countRows(content);
  },
});

export const deleteOrgMirror = internalMutation({
  args: { clerkOrgId: v.string() },
  returns: deletedMirrorValidator,
  handler: async (ctx, args) => {
    const org = await getOrgByClerkId(ctx, args.clerkOrgId);
    await assertNoContent(ctx, org);
    const members = await ctx.db
      .query("members")
      .withIndex("by_org", (q) => q.eq("orgId", org._id))
      .collect();
    await deleteRows(ctx, members);
    await ctx.db.delete(org._id);
    return { organizations: 1, members: members.length };
  },
});
