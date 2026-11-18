import { v } from "convex/values";
import { internal } from "./_generated/api";
import { Doc, Id } from "./_generated/dataModel";
import { internalMutation, internalQuery, MutationCtx, QueryCtx } from "./_generated/server";
import { deleteAttachmentFiles, deleteIssuesWithOwnedRows, deleteRows } from "./lib/issueCleanup";
import { patchIssue } from "./lib/issueVersion";
import { existedBeforeRead, getOrgByClerkIdOrThrow } from "./lib/mirror";
import { subCounter } from "./lib/rules/levels";
import { findTeamByKey } from "./lib/teams";

/**
 * Operator-only cleanup, run with `npx convex run admin:<name>`. Never public:
 * Clerk stays the source of truth for the organization mirror, so removing it
 * is a separate step that refuses while workspace content would be orphaned.
 */

const issueContentCountFields = {
  issueLabels: v.number(),
  issueRelations: v.number(),
  comments: v.number(),
  activity: v.number(),
  attachments: v.number(),
  decisions: v.number(),
  issues: v.number(),
};

const contentCountFields = {
  ...issueContentCountFields,
  cycles: v.number(),
  labels: v.number(),
  views: v.number(),
  projects: v.number(),
  teams: v.number(),
  idempotencyKeys: v.number(),
};

/** Labels, views, projects and idempotency keys are org-scoped, so a team clear leaves them. */
const clearedTeamCountsValidator = v.object({
  ...issueContentCountFields,
  cycles: v.number(),
  teams: v.number(),
});

type ContentTable = keyof typeof contentCountFields;
type OrgContent = { [T in ContentTable]: Doc<T>[] };

const CONTENT_TABLES = Object.keys(contentCountFields) as ContentTable[];
const clearedCountsValidator = v.object(contentCountFields);

const deletedMirrorValidator = v.object({
  organizations: v.number(),
  members: v.number(),
});

function getOrgByClerkId(ctx: QueryCtx | MutationCtx, clerkOrgId: string) {
  return getOrgByClerkIdOrThrow(ctx, clerkOrgId, `Organization ${clerkOrgId} not found`);
}

async function collectEach<P, T>(parents: P[], load: (parent: P) => Promise<T[]>) {
  const perParent = await Promise.all(parents.map(load));
  return perParent.flat();
}

function countRows(content: OrgContent) {
  const counts = CONTENT_TABLES.map((table) => [table, content[table].length]);
  return Object.fromEntries(counts) as Record<ContentTable, number>;
}

function tablesWithRows(content: OrgContent) {
  return CONTENT_TABLES.filter((table) => content[table].length > 0);
}

async function loadOrgContent(ctx: QueryCtx | MutationCtx, orgId: Id<"organizations">): Promise<OrgContent> {
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
    decisions: await ctx.db
      .query("decisions")
      .withIndex("by_org_and_status", (q) => q.eq("orgId", orgId))
      .collect(),
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
    idempotencyKeys: await ctx.db
      .query("idempotencyKeys")
      .withIndex("by_org_and_key", (q) => q.eq("orgId", orgId))
      .collect(),
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

export const orgHasContent = internalQuery({
  args: { clerkOrgId: v.string() },
  returns: v.boolean(),
  handler: async (ctx, args) => {
    const org = await getOrgByClerkId(ctx, args.clerkOrgId);
    return tablesWithRows(await loadOrgContent(ctx, org._id)).length > 0;
  },
});

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

export const clearTeamContent = internalMutation({
  args: { clerkOrgId: v.string(), teamKey: v.string() },
  returns: clearedTeamCountsValidator,
  handler: async (ctx, args) => {
    const org = await getOrgByClerkId(ctx, args.clerkOrgId);
    const team = await findTeamByKey(ctx, org._id, args.teamKey);
    const issues = await ctx.db
      .query("issues")
      .withIndex("by_team", (q) => q.eq("teamId", team._id))
      .collect();
    const cycles = await ctx.db
      .query("cycles")
      .withIndex("by_team", (q) => q.eq("teamId", team._id))
      .collect();
    const issueCounts = await deleteIssuesWithOwnedRows(ctx, issues);
    await deleteRows(ctx, cycles);
    await ctx.db.delete(team._id);
    return { ...issueCounts, cycles: cycles.length, teams: 1 };
  },
});

export const deleteOrgMirror = internalMutation({
  args: { clerkOrgId: v.string(), readStartedAt: v.optional(v.number()) },
  returns: deletedMirrorValidator,
  handler: async (ctx, args) => {
    const org = await getOrgByClerkId(ctx, args.clerkOrgId);
    if (!existedBeforeRead(org, args.readStartedAt)) {
      return { organizations: 0, members: 0 };
    }
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

/** Issues one backfill run reads, so each run stays inside Convex's per-transaction limits. */
export const BACKFILL_PAGE_SIZE = 100;

/**
 * One-time: give every story written before the subtask counter its counter, so a subtask that
 * leaves it later cannot free its key for reuse. Each run reads one page of issues and schedules
 * the next page. Returns how many stories this run set; a rerun sets none.
 */
export const backfillSubCounters = internalMutation({
  args: { after: v.optional(v.string()) },
  returns: v.number(),
  handler: async (ctx, args): Promise<number> => {
    const { page, isDone, continueCursor } = await ctx.db
      .query("issues")
      .paginate({ cursor: args.after ?? null, numItems: BACKFILL_PAGE_SIZE });
    const stories = page.filter((issue) => issue.kind === "story" && issue.nextSubNumber === undefined);
    for (const story of stories) {
      await patchIssue(ctx, story, { nextSubNumber: await subCounter(ctx, story) });
    }
    if (!isDone) {
      await ctx.scheduler.runAfter(0, internal.admin.backfillSubCounters, { after: continueCursor });
    }
    return stories.length;
  },
});
