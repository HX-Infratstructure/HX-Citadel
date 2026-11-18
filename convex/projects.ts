import { v } from "convex/values";
import { Doc, Id } from "./_generated/dataModel";
import { MutationCtx, QueryCtx } from "./_generated/server";
import { issueShape, LIST_LIMIT } from "./issues";
import { logActivity } from "./lib/activity";
import { orgMutation, orgQuery } from "./lib/customFunctions";
import { findMembership } from "./lib/mirror";
import { inOrg, orgRow, requireOrgRow } from "./lib/orgRows";
import { patchIssue } from "./lib/issueVersion";
import { invalid, notFound } from "./lib/refusals";
import { assertNoEpics } from "./lib/rules/levels";
import { projectStatusValidator } from "./schema";

export const projectShape = {
  _id: v.id("projects"),
  _creationTime: v.number(),
  orgId: v.id("organizations"),
  name: v.string(),
  description: v.optional(v.string()),
  status: projectStatusValidator,
  leadId: v.optional(v.id("users")),
  targetDate: v.optional(v.number()),
  color: v.optional(v.string()),
};

/** Issue counts by status — the project progress primitive. */
export const progressShape = v.object({
  total: v.number(),
  backlog: v.number(),
  todo: v.number(),
  in_progress: v.number(),
  in_review: v.number(),
  done: v.number(),
  canceled: v.number(),
});

/** Issue counts by status, the one progress rule for projects and cycles. */
export function countByStatus(issues: Doc<"issues">[]) {
  const progress = {
    total: 0,
    backlog: 0,
    todo: 0,
    in_progress: 0,
    in_review: 0,
    done: 0,
    canceled: 0,
  };
  for (const issue of issues) {
    progress.total += 1;
    progress[issue.status] += 1;
  }
  return progress;
}

/** A project's issues, at most `LIST_LIMIT`. */
async function projectIssues(ctx: { db: QueryCtx["db"] }, orgId: Id<"organizations">, projectId: Id<"projects">) {
  return await inOrg(
    ctx.db.query("issues").withIndex("by_project", (q) => q.eq("projectId", projectId)),
    orgId
  ).take(LIST_LIMIT);
}

/** Bounded by design: people create projects by hand, a few dozen per workspace; no agent route creates one. */
async function orgProjects(ctx: { db: QueryCtx["db"] }, orgId: Id<"organizations">) {
  return await ctx.db
    .query("projects")
    .withIndex("by_org", (q) => q.eq("orgId", orgId))
    .collect();
}

function projectName(name: string): string {
  const trimmed = name.trim();
  if (!trimmed) {
    invalid("Project name is required");
  }
  return trimmed;
}

async function assertLead(ctx: MutationCtx, orgId: Id<"organizations">, leadId: Id<"users">): Promise<void> {
  if (!(await findMembership(ctx, orgId, leadId))) {
    notFound("Project lead must be a member of this organization");
  }
}

/** Lightweight project list for pickers (no progress computation). */
export const list = orgQuery({
  args: {},
  returns: v.array(v.object(projectShape)),
  handler: async (ctx) => await orgProjects(ctx, ctx.org._id),
});

/** Projects with issue counts by status — powers the projects index page. */
export const listWithProgress = orgQuery({
  args: {},
  returns: v.array(v.object({ ...projectShape, progress: progressShape })),
  handler: async (ctx) => {
    const projects = await orgProjects(ctx, ctx.org._id);
    return await Promise.all(
      projects.map(async (project) => ({
        ...project,
        progress: countByStatus(await projectIssues(ctx, ctx.org._id, project._id)),
      }))
    );
  },
});

export const get = orgQuery({
  args: { projectId: v.id("projects") },
  returns: v.union(v.object(projectShape), v.null()),
  handler: async (ctx, args) => await orgRow(ctx, ctx.org._id, args.projectId),
});

/** All issues assigned to a project (project detail page computes progress from this). */
export const listIssues = orgQuery({
  args: { projectId: v.id("projects") },
  returns: v.array(v.object(issueShape)),
  handler: async (ctx, args) => {
    await requireOrgRow(ctx, ctx.org._id, args.projectId, "Project");
    return await projectIssues(ctx, ctx.org._id, args.projectId);
  },
});

/**
 * Recent org issues NOT already in the given project — candidates for the
 * "add issues to project" picker. Assignment itself goes through
 * `issues.update` (projectId arg).
 */
export const candidateIssues = orgQuery({
  args: { projectId: v.id("projects") },
  returns: v.array(v.object(issueShape)),
  handler: async (ctx, args) => {
    await requireOrgRow(ctx, ctx.org._id, args.projectId, "Project");
    const issues = await ctx.db
      .query("issues")
      .withIndex("by_org", (q) => q.eq("orgId", ctx.org._id))
      .order("desc")
      .take(LIST_LIMIT);
    return issues
      .filter((issue) => issue.projectId !== args.projectId)
      .slice(0, 200);
  },
});

export const create = orgMutation({
  args: {
    name: v.string(),
    description: v.optional(v.string()),
    status: v.optional(projectStatusValidator),
    leadId: v.optional(v.id("users")),
    targetDate: v.optional(v.number()),
    color: v.optional(v.string()),
  },
  returns: v.id("projects"),
  handler: async (ctx, args) => {
    const name = projectName(args.name);
    if (args.leadId) {
      await assertLead(ctx, ctx.org._id, args.leadId);
    }

    return await ctx.db.insert("projects", {
      orgId: ctx.org._id,
      name,
      description: args.description,
      status: args.status ?? "planned",
      leadId: args.leadId,
      targetDate: args.targetDate,
      color: args.color,
    });
  },
});

export const update = orgMutation({
  args: {
    projectId: v.id("projects"),
    name: v.optional(v.string()),
    description: v.optional(v.union(v.string(), v.null())),
    status: v.optional(projectStatusValidator),
    leadId: v.optional(v.union(v.id("users"), v.null())),
    targetDate: v.optional(v.union(v.number(), v.null())),
    color: v.optional(v.union(v.string(), v.null())),
  },
  returns: v.null(),
  handler: async (ctx, args) => {
    const project = await requireOrgRow(ctx, ctx.org._id, args.projectId, "Project");

    const updates: Partial<Doc<"projects">> = {};
    if (args.name !== undefined) {
      updates.name = projectName(args.name);
    }
    if (args.description !== undefined) {
      updates.description = args.description ?? undefined;
    }
    if (args.status !== undefined) {
      updates.status = args.status;
    }
    if (args.leadId !== undefined) {
      if (args.leadId !== null) {
        await assertLead(ctx, ctx.org._id, args.leadId);
      }
      updates.leadId = args.leadId ?? undefined;
    }
    if (args.targetDate !== undefined) {
      updates.targetDate = args.targetDate ?? undefined;
    }
    if (args.color !== undefined) {
      updates.color = args.color ?? undefined;
    }

    await ctx.db.patch(project._id, updates);
    return null;
  },
});

/** Delete a project with no epics and detach its issues (issues themselves are kept). */
export const remove = orgMutation({
  args: { projectId: v.id("projects") },
  returns: v.null(),
  handler: async (ctx, args) => {
    const project = await requireOrgRow(ctx, ctx.org._id, args.projectId, "Project");

    // Bounded by design: assertNoEpics must see every issue, and the mutation is atomic, so a project too big to read fails whole and detaches nothing.
    const issues = await inOrg(
      ctx.db.query("issues").withIndex("by_project", (q) => q.eq("projectId", project._id)),
      ctx.org._id
    ).collect();
    assertNoEpics(issues);
    for (const issue of issues) {
      await patchIssue(ctx, issue, { projectId: undefined });
      await logActivity(ctx, {
        orgId: ctx.org._id,
        issueId: issue._id,
        actorId: ctx.user._id,
        type: "project_changed",
        field: "project",
        oldValue: project.name,
        newValue: undefined,
      });
    }

    await ctx.db.delete(project._id);
    return null;
  },
});
