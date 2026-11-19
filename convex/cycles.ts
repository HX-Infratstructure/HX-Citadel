import { v } from "convex/values";
import { cycleName } from "../lib/sprint";
import { Doc, Id } from "./_generated/dataModel";
import { QueryCtx } from "./_generated/server";
import { issueShape, LIST_LIMIT } from "./issues";
import { logActivity } from "./lib/activity";
import { orgMutation, orgQuery } from "./lib/customFunctions";
import { CASCADE_BUDGET, groupDigits, inOrg, orgRow, requireOrgRow } from "./lib/orgRows";
import { patchIssue } from "./lib/issueVersion";
import { invalid, refuse } from "./lib/refusals";
import { countByStatus, progressShape } from "./projects";

export const cycleShape = {
  _id: v.id("cycles"),
  _creationTime: v.number(),
  orgId: v.id("organizations"),
  teamId: v.id("teams"),
  number: v.number(),
  name: v.optional(v.string()),
  startDate: v.number(),
  endDate: v.number(),
};

/** Every issue of a cycle in the workspace. */
function cycleIssueQuery(ctx: { db: QueryCtx["db"] }, orgId: Id<"organizations">, cycleId: Id<"cycles">) {
  return inOrg(
    ctx.db.query("issues").withIndex("by_cycle", (q) => q.eq("cycleId", cycleId)),
    orgId
  );
}

/** A team's cycles, newest first. Bounded by design: one team's cycles, about 52 a year, and no agent route creates one. */
async function teamCycles(ctx: { db: QueryCtx["db"] }, orgId: Id<"organizations">, teamId: Id<"teams">) {
  return await inOrg(
    ctx.db.query("cycles").withIndex("by_team_and_number", (q) => q.eq("teamId", teamId)).order("desc"),
    orgId
  ).collect();
}

function assertDatesInOrder(startDate: number, endDate: number): void {
  if (endDate <= startDate) {
    invalid("Cycle end date must be after its start date");
  }
}

/** Cycles for one team, newest first (lightweight — for pickers). */
export const listByTeam = orgQuery({
  args: { teamId: v.id("teams") },
  returns: v.array(v.object(cycleShape)),
  handler: async (ctx, args) => {
    await requireOrgRow(ctx, ctx.org._id, args.teamId, "Team");
    return await teamCycles(ctx, ctx.org._id, args.teamId);
  },
});

/**
 * Every cycle in the workspace, each team's newest first, with no issue reads.
 * Powers the cycles index, whose rows each load their own `progress`.
 */
export const list = orgQuery({
  args: {},
  returns: v.array(v.object(cycleShape)),
  handler: async (ctx) => {
    // Bounded by design: a workspace's teams, a handful, made by hand.
    const teams = await ctx.db
      .query("teams")
      .withIndex("by_org", (q) => q.eq("orgId", ctx.org._id))
      .collect();
    const cyclesByTeam = [];
    for (const team of teams) {
      cyclesByTeam.push(await teamCycles(ctx, ctx.org._id, team._id));
    }
    return cyclesByTeam.flat();
  },
});

export const get = orgQuery({
  args: { cycleId: v.id("cycles") },
  returns: v.union(v.object(cycleShape), v.null()),
  handler: async (ctx, args) => await orgRow(ctx, ctx.org._id, args.cycleId),
});

/**
 * The team's current cycle — the active cycle (startDate ≤ now ≤ endDate)
 * with the most recent start, or null when no cycle is running.
 */
export const currentForTeam = orgQuery({
  args: { teamId: v.id("teams") },
  returns: v.union(v.object(cycleShape), v.null()),
  handler: async (ctx, args) => {
    await requireOrgRow(ctx, ctx.org._id, args.teamId, "Team");
    const cycles = await teamCycles(ctx, ctx.org._id, args.teamId);
    const now = Date.now();
    const active = cycles
      .filter((cycle) => cycle.startDate <= now && now <= cycle.endDate)
      .sort((a, b) => b.startDate - a.startDate);
    return active[0] ?? null;
  },
});

/** A cycle's issues for the detail page list, at most `LIST_LIMIT`; `progress` counts them all. */
export const listIssues = orgQuery({
  args: { cycleId: v.id("cycles") },
  returns: v.array(v.object(issueShape)),
  handler: async (ctx, args) => {
    await requireOrgRow(ctx, ctx.org._id, args.cycleId, "Cycle");
    return await cycleIssueQuery(ctx, ctx.org._id, args.cycleId).take(LIST_LIMIT);
  },
});

/** A cycle's issue counts by status, over every issue, for the detail page and each row of the cycles index. */
export const progress = orgQuery({
  args: { cycleId: v.id("cycles") },
  returns: progressShape,
  handler: async (ctx, args) => {
    await requireOrgRow(ctx, ctx.org._id, args.cycleId, "Cycle");
    return await countByStatus(cycleIssueQuery(ctx, ctx.org._id, args.cycleId));
  },
});

/**
 * Team issues NOT already in the given cycle — candidates for the
 * "add issues to cycle" picker. Assignment itself goes through
 * `issues.update` (cycleId arg).
 */
export const candidateIssues = orgQuery({
  args: { cycleId: v.id("cycles") },
  returns: v.array(v.object(issueShape)),
  handler: async (ctx, args) => {
    const cycle = await requireOrgRow(ctx, ctx.org._id, args.cycleId, "Cycle");
    const issues = await inOrg(
      ctx.db.query("issues").withIndex("by_team", (q) => q.eq("teamId", cycle.teamId)).order("desc"),
      ctx.org._id
    ).take(LIST_LIMIT);
    return issues.filter((issue) => issue.cycleId !== args.cycleId).slice(0, 200);
  },
});

/** Create a cycle for a team. Cycles are auto-numbered per team (Cycle 1, 2, …). */
export const create = orgMutation({
  args: {
    teamId: v.id("teams"),
    name: v.optional(v.string()),
    startDate: v.number(),
    endDate: v.number(),
  },
  returns: v.id("cycles"),
  handler: async (ctx, args) => {
    await requireOrgRow(ctx, ctx.org._id, args.teamId, "Team");
    assertDatesInOrder(args.startDate, args.endDate);

    // Claim the next per-team cycle number.
    const latest = await inOrg(
      ctx.db.query("cycles").withIndex("by_team_and_number", (q) => q.eq("teamId", args.teamId)).order("desc"),
      ctx.org._id
    ).first();
    const number = (latest?.number ?? 0) + 1;

    const name = args.name?.trim();
    return await ctx.db.insert("cycles", {
      orgId: ctx.org._id,
      teamId: args.teamId,
      number,
      name: name ? name : undefined,
      startDate: args.startDate,
      endDate: args.endDate,
    });
  },
});

export const update = orgMutation({
  args: {
    cycleId: v.id("cycles"),
    name: v.optional(v.union(v.string(), v.null())),
    startDate: v.optional(v.number()),
    endDate: v.optional(v.number()),
  },
  returns: v.null(),
  handler: async (ctx, args) => {
    const cycle = await requireOrgRow(ctx, ctx.org._id, args.cycleId, "Cycle");

    assertDatesInOrder(args.startDate ?? cycle.startDate, args.endDate ?? cycle.endDate);

    const updates: Partial<Doc<"cycles">> = {};
    if (args.name !== undefined) {
      const name = args.name?.trim();
      updates.name = name ? name : undefined;
    }
    if (args.startDate !== undefined) {
      updates.startDate = args.startDate;
    }
    if (args.endDate !== undefined) {
      updates.endDate = args.endDate;
    }

    await ctx.db.patch(cycle._id, updates);
    return null;
  },
});

/** Delete a cycle and unschedule its issues (issues themselves are kept). */
export const remove = orgMutation({
  args: { cycleId: v.id("cycles") },
  returns: v.null(),
  handler: async (ctx, args) => {
    const cycle = await requireOrgRow(ctx, ctx.org._id, args.cycleId, "Cycle");

    // Bounded by design: one sprint's issues, and a cycle with more than CASCADE_BUDGET.rows issues is refused before any write.
    const issues = await cycleIssueQuery(ctx, ctx.org._id, cycle._id).take(CASCADE_BUDGET.rows + 1);
    if (issues.length > CASCADE_BUDGET.rows) {
      refuse(`This cycle has more than ${groupDigits(CASCADE_BUDGET.rows)} issues. Move some to another cycle before deleting it.`);
    }
    for (const issue of issues) {
      await patchIssue(ctx, issue, { cycleId: undefined });
      await logActivity(ctx, {
        orgId: ctx.org._id,
        issueId: issue._id,
        actorId: ctx.user._id,
        type: "cycle_changed",
        field: "cycle",
        oldValue: cycleName(cycle),
        newValue: undefined,
      });
    }

    await ctx.db.delete(cycle._id);
    return null;
  },
});
