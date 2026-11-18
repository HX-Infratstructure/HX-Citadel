import { v } from "convex/values";
import { internal } from "./_generated/api";
import { Doc, Id } from "./_generated/dataModel";
import { internalMutation, internalQuery, MutationCtx, QueryCtx } from "./_generated/server";
import { countTables, deleteIssuesWithOwnedRows, deleteRows, ISSUE_OWNED_TABLES } from "./lib/issueCleanup";
import { patchIssue } from "./lib/issueVersion";
import { existedBeforeRead, getOrgByClerkIdOrThrow } from "./lib/mirror";
import { subCounter } from "./lib/rules/levels";
import { inOrg } from "./lib/orgRows";
import { findTeamByKey } from "./lib/teams";

/**
 * Operator-only cleanup, run with `npx convex run admin:<name>`. Never public:
 * Clerk stays the source of truth for the organization mirror, so removing it
 * is a separate step that refuses while workspace content would be orphaned.
 */

/** Rows of one table one admin run reads, so each run stays inside Convex's per-transaction limits. */
export const PAGE_SIZE = 100;

type OrgId = Id<"organizations">;

/**
 * The tables that hold a workspace's rows under its own index, `limit` rows at a time.
 * Issue-owned rows and cycles have no workspace index: they go with their issue or team.
 */
const ORG_ROWS = {
  activity: (ctx: QueryCtx, orgId: OrgId, limit: number) =>
    ctx.db.query("activity").withIndex("by_org", (q) => q.eq("orgId", orgId)).take(limit),
  decisions: (ctx: QueryCtx, orgId: OrgId, limit: number) =>
    ctx.db.query("decisions").withIndex("by_org_and_status", (q) => q.eq("orgId", orgId)).take(limit),
  issues: (ctx: QueryCtx, orgId: OrgId, limit: number) =>
    ctx.db.query("issues").withIndex("by_org", (q) => q.eq("orgId", orgId)).take(limit),
  labels: (ctx: QueryCtx, orgId: OrgId, limit: number) =>
    ctx.db.query("labels").withIndex("by_org", (q) => q.eq("orgId", orgId)).take(limit),
  views: (ctx: QueryCtx, orgId: OrgId, limit: number) =>
    ctx.db.query("views").withIndex("by_org", (q) => q.eq("orgId", orgId)).take(limit),
  projects: (ctx: QueryCtx, orgId: OrgId, limit: number) =>
    ctx.db.query("projects").withIndex("by_org", (q) => q.eq("orgId", orgId)).take(limit),
  teams: (ctx: QueryCtx, orgId: OrgId, limit: number) =>
    ctx.db.query("teams").withIndex("by_org", (q) => q.eq("orgId", orgId)).take(limit),
  idempotencyKeys: (ctx: QueryCtx, orgId: OrgId, limit: number) =>
    ctx.db.query("idempotencyKeys").withIndex("by_org_and_key", (q) => q.eq("orgId", orgId)).take(limit),
};

type OrgTable = keyof typeof ORG_ROWS;
const ORG_TABLES = Object.keys(ORG_ROWS) as OrgTable[];

/** Swept by the org clear once no issue is left: activity and decisions here have lost their issue. */
const ORG_ONLY_TABLES = ["activity", "decisions", "labels", "views", "projects", "idempotencyKeys"] as const;

/** Labels, projects and idempotency keys are org-scoped, so a team clear leaves them. */
const TEAM_TABLES = [...ISSUE_OWNED_TABLES, "issues", "cycles", "views", "teams"] as const;
const CONTENT_TABLES = [...TEAM_TABLES, "labels", "projects", "idempotencyKeys"] as const;

type TeamCounts = Record<(typeof TEAM_TABLES)[number], number>;
type ContentCounts = Record<(typeof CONTENT_TABLES)[number], number>;

/** What one run deleted, and whether rows are left for the next run. */
type ClearRun<Counts> = { counts: Counts; done: boolean };

function countFields<T extends string>(tables: readonly T[]) {
  return Object.fromEntries(tables.map((table) => [table, v.number()])) as Record<T, ReturnType<typeof v.number>>;
}

function sumCounts(parts: Partial<ContentCounts>[]): ContentCounts {
  return countTables(CONTENT_TABLES, (table) => parts.reduce((sum, part) => sum + (part[table] ?? 0), 0));
}

const clearedCountsValidator = v.object(countFields(CONTENT_TABLES));
const clearedTeamCountsValidator = v.object(countFields(TEAM_TABLES));

const deletedMirrorValidator = v.object({
  organizations: v.number(),
  members: v.number(),
});

function getOrgByClerkId(ctx: QueryCtx | MutationCtx, clerkOrgId: string) {
  return getOrgByClerkIdOrThrow(ctx, clerkOrgId, `Organization ${clerkOrgId} not found`);
}

/** One row of each workspace table is enough to know it still has content. */
async function tablesWithRows(ctx: QueryCtx, orgId: OrgId) {
  const found = await Promise.all(ORG_TABLES.map(async (table) => (await ORG_ROWS[table](ctx, orgId, 1)).length > 0));
  return ORG_TABLES.filter((_, index) => found[index]);
}

async function assertNoContent(ctx: MutationCtx, org: Doc<"organizations">) {
  const remaining = await tablesWithRows(ctx, org._id);
  if (remaining.length > 0) {
    throw new Error(
      `Organization ${org.clerkOrgId} still has rows in ${remaining.join(", ")}. Run admin:clearOrgContent first.`
    );
  }
}

/** Deletes a team whose issues are gone: its cycles, then the team. Returns how many cycles went. */
async function deleteTeam(ctx: MutationCtx, orgId: OrgId, team: Doc<"teams">) {
  const cycles = await inOrg(ctx.db.query("cycles").withIndex("by_team", (q) => q.eq("teamId", team._id)), orgId).collect();
  await deleteRows(ctx, cycles);
  await ctx.db.delete(team._id);
  return cycles.length;
}

/**
 * Saved views whose filters open this team's board (`SavedViewPayload` in
 * components/views/filters.ts). `views.create` and `views.update` store only valid JSON.
 */
async function viewsOpeningTeam(ctx: MutationCtx, orgId: OrgId, teamId: Id<"teams">) {
  const views = await ctx.db
    .query("views")
    .withIndex("by_org", (q) => q.eq("orgId", orgId))
    .collect();
  return views.filter((view) => (JSON.parse(view.filters) as { teamId?: unknown } | null)?.teamId === teamId);
}

/** A page of the team's issues; when it is the last, the team's views and the team go too. */
async function clearTeamPage(ctx: MutationCtx, orgId: OrgId, team: Doc<"teams">): Promise<ClearRun<TeamCounts>> {
  const issues = await inOrg(
    ctx.db.query("issues").withIndex("by_team", (q) => q.eq("teamId", team._id)),
    orgId
  ).take(PAGE_SIZE);
  const issueCounts = await deleteIssuesWithOwnedRows(ctx, issues);
  if (issues.length === PAGE_SIZE) {
    return { counts: { ...issueCounts, cycles: 0, views: 0, teams: 0 }, done: false };
  }
  const views = await viewsOpeningTeam(ctx, orgId, team._id);
  await deleteRows(ctx, views);
  const cycles = await deleteTeam(ctx, orgId, team);
  return { counts: { ...issueCounts, cycles, views: views.length, teams: 1 }, done: true };
}

/** A page of the workspace's issues; when it is the last, a page of its teams and of each org-only table. */
async function clearOrgPage(ctx: MutationCtx, orgId: OrgId): Promise<ClearRun<ContentCounts>> {
  const issues = await ORG_ROWS.issues(ctx, orgId, PAGE_SIZE);
  const issueCounts = await deleteIssuesWithOwnedRows(ctx, issues);
  if (issues.length === PAGE_SIZE) {
    return { counts: sumCounts([issueCounts]), done: false };
  }
  const teams = await ORG_ROWS.teams(ctx, orgId, PAGE_SIZE);
  let cycles = 0;
  for (const team of teams) {
    cycles += await deleteTeam(ctx, orgId, team);
  }
  const pages = await Promise.all(ORG_ONLY_TABLES.map((table) => ORG_ROWS[table](ctx, orgId, PAGE_SIZE)));
  for (const rows of pages) {
    await deleteRows(ctx, rows);
  }
  const orgOnlyCounts = countTables(ORG_ONLY_TABLES, (table) => pages[ORG_ONLY_TABLES.indexOf(table)].length);
  return {
    counts: sumCounts([issueCounts, { cycles, teams: teams.length }, orgOnlyCounts]),
    done: [teams, ...pages].every((rows) => rows.length < PAGE_SIZE),
  };
}

export const orgHasContent = internalQuery({
  args: { clerkOrgId: v.string() },
  returns: v.boolean(),
  handler: async (ctx, args) => {
    const org = await getOrgByClerkId(ctx, args.clerkOrgId);
    return (await tablesWithRows(ctx, org._id)).length > 0;
  },
});

/**
 * Each run deletes one page and schedules the next until nothing is left, so a workspace of
 * any size clears. Returns what this run deleted. A rerun starts from the rows that are left.
 */
export const clearOrgContent = internalMutation({
  args: { clerkOrgId: v.string() },
  returns: clearedCountsValidator,
  handler: async (ctx, args): Promise<ContentCounts> => {
    const org = await getOrgByClerkId(ctx, args.clerkOrgId);
    const run = await clearOrgPage(ctx, org._id);
    if (!run.done) {
      await ctx.scheduler.runAfter(0, internal.admin.clearOrgContent, args);
    }
    return run.counts;
  },
});

/** Pages like `clearOrgContent`; the last run deletes the team's cycles, its saved views and the team. */
export const clearTeamContent = internalMutation({
  args: { clerkOrgId: v.string(), teamKey: v.string() },
  returns: clearedTeamCountsValidator,
  handler: async (ctx, args): Promise<TeamCounts> => {
    const org = await getOrgByClerkId(ctx, args.clerkOrgId);
    const team = await findTeamByKey(ctx, org._id, args.teamKey);
    const run = await clearTeamPage(ctx, org._id, team);
    if (!run.done) {
      await ctx.scheduler.runAfter(0, internal.admin.clearTeamContent, args);
    }
    return run.counts;
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
      .paginate({ cursor: args.after ?? null, numItems: PAGE_SIZE });
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
