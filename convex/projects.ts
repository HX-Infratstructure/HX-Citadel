import { v } from "convex/values";
import { Doc, Id } from "./_generated/dataModel";
import { MutationCtx, QueryCtx } from "./_generated/server";
import { issueShape } from "./lib/issues/shape";
import { LIST_LIMIT } from "./lib/paging";
import { logActivity } from "./lib/activity";
import { orgMutation, orgQuery } from "./lib/customFunctions";
import { findMembership } from "./lib/mirror";
import { CASCADE_BUDGET, groupDigits, inOrg, orgRow, requireOrgRow } from "./lib/orgRows";
import { patchIssue } from "./lib/issueVersion";
import { invalid, notFound, refuse } from "./lib/refusals";
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

/**
 * Issue counts by status over every issue the query yields, the one progress rule for projects and cycles.
 * Bounded by design: it reads each issue, so a query that counts more issues than Convex lets one query
 * read fails whole with Convex's read-limit error, never a short count.
 */
export async function countByStatus(issues: AsyncIterable<Doc<"issues">>) {
  const progress = {
    total: 0,
    backlog: 0,
    todo: 0,
    in_progress: 0,
    in_review: 0,
    done: 0,
    canceled: 0,
  };
  for await (const issue of issues) {
    progress.total += 1;
    progress[issue.status] += 1;
  }
  return progress;
}

/** Every issue of a project in the workspace. */
function projectIssueQuery(ctx: { db: QueryCtx["db"] }, orgId: Id<"organizations">, projectId: Id<"projects">) {
  return inOrg(
    ctx.db.query("issues").withIndex("by_project", (q) => q.eq("projectId", projectId)),
    orgId
  );
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

/**
 * The workspace's projects, with no issue reads.
 * Powers the pickers and the projects index; each index row loads its own `progress`.
 */
export const list = orgQuery({
  args: {},
  returns: v.array(v.object(projectShape)),
  handler: async (ctx) => await orgProjects(ctx, ctx.org._id),
});

export const get = orgQuery({
  args: { projectId: v.id("projects") },
  returns: v.union(v.object(projectShape), v.null()),
  handler: async (ctx, args) => await orgRow(ctx, ctx.org._id, args.projectId),
});

/** A project's issues for the detail page list, at most `LIST_LIMIT`; `progress` counts them all. */
export const listIssues = orgQuery({
  args: { projectId: v.id("projects") },
  returns: v.array(v.object(issueShape)),
  handler: async (ctx, args) => {
    await requireOrgRow(ctx, ctx.org._id, args.projectId, "Project");
    return await projectIssueQuery(ctx, ctx.org._id, args.projectId).take(LIST_LIMIT);
  },
});

/** A project's issue counts by status, over every issue, for the detail page and each row of the projects index. */
export const progress = orgQuery({
  args: { projectId: v.id("projects") },
  returns: progressShape,
  handler: async (ctx, args) => {
    await requireOrgRow(ctx, ctx.org._id, args.projectId, "Project");
    return await countByStatus(projectIssueQuery(ctx, ctx.org._id, args.projectId));
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

    // Bounded by design: assertNoEpics must see every issue, so a project with more than CASCADE_BUDGET.rows issues is refused before any write.
    const issues = await projectIssueQuery(ctx, ctx.org._id, project._id).take(CASCADE_BUDGET.rows + 1);
    if (issues.length > CASCADE_BUDGET.rows) {
      refuse(`This project has more than ${groupDigits(CASCADE_BUDGET.rows)} issues. Move some to another project before deleting it.`);
    }
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
