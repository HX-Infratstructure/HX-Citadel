import { v } from "convex/values";
import { internal } from "./_generated/api";
import { Doc, Id } from "./_generated/dataModel";
import { internalMutation, internalQuery, MutationCtx, QueryCtx } from "./_generated/server";
import { countTables, deleteIssuesWithOwnedRows, deleteRows, ISSUE_OWNED_TABLES } from "./lib/issueCleanup";
import { existedBeforeRead, getOrgByClerkIdOrThrow } from "./lib/mirror";
import { inOrg, orgRow } from "./lib/orgRows";
import { refuse } from "./lib/refusals";
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
    refuse(`Organization ${org.clerkOrgId} still has rows in ${remaining.join(", ")}. Run admin:clearOrgContent first.`);
  }
}

/** Deletes up to `limit` of a team's cycles. Returns how many went. */
async function deleteCycles(ctx: MutationCtx, team: Doc<"teams">, limit: number) {
  const cycles = await inOrg(
    ctx.db.query("cycles").withIndex("by_team", (q) => q.eq("teamId", team._id)),
    team.orgId
  ).take(limit);
  await deleteRows(ctx, cycles);
  return cycles.length;
}

/**
 * Deletes teams whose issues are gone, each with its cycles, up to one page of cycles in all.
 * The team whose cycles fill the page, and those after it, wait for the next run.
 */
async function deleteTeams(ctx: MutationCtx, teams: Doc<"teams">[]) {
  let cycles = 0;
  let deleted = 0;
  for (const team of teams) {
    const room = PAGE_SIZE - cycles;
    const removed = await deleteCycles(ctx, team, room);
    cycles += removed;
    if (removed === room) {
      break;
    }
    await ctx.db.delete(team._id);
    deleted += 1;
  }
  return { cycles, teams: deleted };
}

/**
 * One page of the workspace's saved views from `cursor`, and those on it whose filters open this
 * team's board (`SavedViewPayload` in components/views/filters.ts). `views.create` and
 * `views.update` store only valid JSON.
 */
async function viewsOpeningTeam(ctx: MutationCtx, team: Doc<"teams">, cursor: string | null) {
  const { page, isDone, continueCursor } = await ctx.db
    .query("views")
    .withIndex("by_org", (q) => q.eq("orgId", team.orgId))
    .paginate({ cursor, numItems: PAGE_SIZE });
  const views = page.filter((view) => (JSON.parse(view.filters) as { teamId?: unknown } | null)?.teamId === team._id);
  return { views, isDone, continueCursor };
}

/** The next run of a team clear, bound to the team's id so a team created again with its key is never touched. */
async function scheduleTeamPage(ctx: MutationCtx, team: Doc<"teams">, viewsCursor: string | null) {
  await ctx.scheduler.runAfter(0, internal.admin.continueTeamClear, {
    orgId: team.orgId,
    teamId: team._id,
    viewsCursor,
  });
}

/**
 * One run of a team clear: a page of the team's issues; once they are gone, a page of its cycles; once
 * those are gone, a page of the workspace's saved views from `viewsCursor`; once every view is read, the
 * team. Every run starts with the issues and the cycles, so the run that deletes the team has seen it hold none.
 */
async function clearTeamPage(ctx: MutationCtx, team: Doc<"teams">, viewsCursor: string | null): Promise<TeamCounts> {
  const issues = await inOrg(
    ctx.db.query("issues").withIndex("by_team", (q) => q.eq("teamId", team._id)),
    team.orgId
  ).take(PAGE_SIZE);
  const issueCounts = await deleteIssuesWithOwnedRows(ctx, issues);
  if (issues.length === PAGE_SIZE) {
    await scheduleTeamPage(ctx, team, viewsCursor);
    return { ...issueCounts, cycles: 0, views: 0, teams: 0 };
  }
  const cycles = await deleteCycles(ctx, team, PAGE_SIZE);
  if (cycles === PAGE_SIZE) {
    await scheduleTeamPage(ctx, team, viewsCursor);
    return { ...issueCounts, cycles, views: 0, teams: 0 };
  }
  const scan = await viewsOpeningTeam(ctx, team, viewsCursor);
  await deleteRows(ctx, scan.views);
  if (!scan.isDone) {
    await scheduleTeamPage(ctx, team, scan.continueCursor);
    return { ...issueCounts, cycles, views: scan.views.length, teams: 0 };
  }
  await ctx.db.delete(team._id);
  return { ...issueCounts, cycles, views: scan.views.length, teams: 1 };
}

/** The next run of a workspace clear, bound to the workspace's id rather than its Clerk id. */
async function scheduleOrgPage(ctx: MutationCtx, orgId: OrgId) {
  await ctx.scheduler.runAfter(0, internal.admin.continueOrgClear, { orgId });
}

/** A page of the workspace's issues; when it is the last, a page of its teams' cycles and of each org-only table. */
async function clearOrgPage(ctx: MutationCtx, orgId: OrgId): Promise<ContentCounts> {
  const issues = await ORG_ROWS.issues(ctx, orgId, PAGE_SIZE);
  const issueCounts = await deleteIssuesWithOwnedRows(ctx, issues);
  if (issues.length === PAGE_SIZE) {
    await scheduleOrgPage(ctx, orgId);
    return sumCounts([issueCounts]);
  }
  const teams = await ORG_ROWS.teams(ctx, orgId, PAGE_SIZE);
  const teamCounts = await deleteTeams(ctx, teams);
  const pages = await Promise.all(ORG_ONLY_TABLES.map((table) => ORG_ROWS[table](ctx, orgId, PAGE_SIZE)));
  for (const rows of pages) {
    await deleteRows(ctx, rows);
  }
  const orgOnlyCounts = countTables(ORG_ONLY_TABLES, (table) => pages[ORG_ONLY_TABLES.indexOf(table)].length);
  if (teamCounts.cycles === PAGE_SIZE || [teams, ...pages].some((rows) => rows.length === PAGE_SIZE)) {
    await scheduleOrgPage(ctx, orgId);
  }
  return sumCounts([issueCounts, teamCounts, orgOnlyCounts]);
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
 * Each run deletes one page and schedules the next until nothing is left. Returns what this run
 * deleted. A rerun starts from the rows that are left. A page of `PAGE_SIZE` issues takes every row
 * they own, read whole (`ISSUE_OWNED_ROWS`), so a page whose issues own more than one mutation can
 * delete fails and changes nothing, and a rerun reads the same issues and fails again.
 */
export const clearOrgContent = internalMutation({
  args: { clerkOrgId: v.string() },
  returns: clearedCountsValidator,
  handler: async (ctx, args): Promise<ContentCounts> => {
    const org = await getOrgByClerkId(ctx, args.clerkOrgId);
    return await clearOrgPage(ctx, org._id);
  },
});

/** A scheduled run of `clearOrgContent`. It stops once the workspace's mirror is gone. */
export const continueOrgClear = internalMutation({
  args: { orgId: v.id("organizations") },
  returns: clearedCountsValidator,
  handler: async (ctx, args): Promise<ContentCounts> => {
    if ((await ctx.db.get(args.orgId)) === null) {
      return sumCounts([]);
    }
    return await clearOrgPage(ctx, args.orgId);
  },
});

/**
 * Pages like `clearOrgContent`; the last runs delete the team's cycles, its saved views and the team.
 * A rerun starts from the rows that are left and reads the saved views from the start.
 */
export const clearTeamContent = internalMutation({
  args: { clerkOrgId: v.string(), teamKey: v.string() },
  returns: clearedTeamCountsValidator,
  handler: async (ctx, args): Promise<TeamCounts> => {
    const org = await getOrgByClerkId(ctx, args.clerkOrgId);
    const team = await findTeamByKey(ctx, org._id, args.teamKey);
    return await clearTeamPage(ctx, team, null);
  },
});

/** A scheduled run of `clearTeamContent`. It stops once the team it started on is gone. */
export const continueTeamClear = internalMutation({
  args: { orgId: v.id("organizations"), teamId: v.id("teams"), viewsCursor: v.union(v.string(), v.null()) },
  returns: clearedTeamCountsValidator,
  handler: async (ctx, args): Promise<TeamCounts> => {
    const team = await orgRow(ctx, args.orgId, args.teamId);
    if (team === null) {
      return countTables(TEAM_TABLES, () => 0);
    }
    return await clearTeamPage(ctx, team, args.viewsCursor);
  },
});

/** An organization's members are read in one go, as `organizations.listMembers` and `deleteOrganization` (webhooks.ts) read them. */
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
